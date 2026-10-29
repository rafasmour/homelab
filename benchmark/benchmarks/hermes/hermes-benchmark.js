'use strict';
// Hermes benchmark: runs the real Hermes profiles (container hermes-api) on a
// given llama.cpp model with `hermes chat --query-file ... --quiet` and scores
// correctness, rule-following and speed. A `chat` run never posts to the real
// Talk rooms: see "Talk isolation" below.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { docker, dockerExec } = require('../../lib/docker');
const { McpClient } = require('../../lib/mcp');
const router = require('../../lib/router');
const { TASKS, cronExpectation, check, runSnapshot, runCleanup } = require('./cases');
const hooks = require('./hooks');
const content = require('./content');

const CONTAINER = 'hermes-api';
const HERMES_HOME = '/home/hermes/.hermes';
const PY = '/opt/hermes/.venv/bin/python3';
const QUERY_FILE = '/tmp/bench_q.txt';
const CASE_TIMEOUT_S = 900;
const MAX_TURNS = 25;

// Exact wrapper Hermes prepends to every cron prompt (cron/scheduler.py, _build_job_prompt).
const CRON_HINT =
  '[IMPORTANT: You are running as a scheduled cron job. ' +
  'DELIVERY: Your final response will be automatically delivered ' +
  'to the user — do NOT use send_message or try to deliver ' +
  'the output yourself. Just produce your report/output as your ' +
  'final response and the system handles the rest. ' +
  'SILENT: If there is genuinely nothing new to report, respond ' +
  'with exactly "[SILENT]" (nothing else) to suppress delivery. ' +
  'Never combine [SILENT] with content — either report your ' +
  'findings normally, or say [SILENT] and nothing more.]\n\n';

const CHAT_DROP_TOOLSETS = ['kanban', 'clarify', 'talk'];
const ALWAYS_FORBIDDEN = /^(talk_send|send_message|kanban_.*|clarify|delegate.*|cronjob.*)$/;
const WRITE_TOOL = /(^|__)(store_|update_|delete_|destroy_|create_|log_ingredient|nc_calendar_(create|update|delete|complete|bulk|manage))/;
// ------------------------------------------------------------------ Talk isolation
// Every case runs with HERMES_BENCHMARK=1, so the talk_send plugin posts only to
// the mock user's room (BENCHMARK_TALK_ROOM) and is unavailable without it. The
// real room variables are blanked in the exec as a second layer. Cases whose
// tools could still reach a real room are refused before Hermes starts.
const TALK_ROOM = (process.env.BENCHMARK_TALK_ROOM || '').trim();
// Hermes' own send_message posts through the gateway platforms (the real rooms).
const REFUSED_TOOLSETS = ['messaging'];
// Nextcloud MCP tools that write to Talk as the real Nextcloud user (no redirect possible).
const MCP_TALK_WRITE_TOOLS = ['talk_send_message', 'talk_react', 'talk_remove_reaction', 'talk_create_conversation', 'talk_add_participant', 'talk_mark_as_read'];
const PLUGIN_BENCH_MARKER = 'HERMES_BENCHMARK_TALK_ROOM';

function benchmarkEnv() {
  const env = {
    HERMES_BENCHMARK: '1',
    HERMES_BENCHMARK_TALK_ROOM: TALK_ROOM,
    NEXTCLOUD_TALK_HOME_ROOM: TALK_ROOM,
    NEXTCLOUD_TALK_PROFILE_ROOMS: '',
  };
  if (!TALK_ROOM) env.NEXTCLOUD_TALK_DELIVER_URL = '';
  return env;
}

/** Throws when a case's toolsets could post to a real Talk room. */
function talkGuard(profile, toolsets, ts) {
  const refused = toolsets.filter((t) => REFUSED_TOOLSETS.includes(t));
  if (refused.length) throw new Error(`refused: toolset ${refused.join(',')} posts to the real Talk rooms`);
  const viaMcp = toolsets.filter((t) => (ts.talk_mcp || {})[t] && ts.talk_mcp[t].length);
  if (viaMcp.length) throw new Error(`refused: MCP ${viaMcp.map((t) => `${t} (${ts.talk_mcp[t].join(',')})`).join('; ')} would post to Talk as the real Nextcloud user; drop those tools from the profile's include list`);
  if (toolsets.includes('talk')) {
    if (!TALK_ROOM) throw new Error('refused: toolset talk needs BENCHMARK_TALK_ROOM (the mock room) in benchmark/.env');
    if (!ts.talk_plugin) throw new Error(`refused: profile ${profile}'s talk_send plugin has no benchmark mode yet; restart hermes-api to install it`);
  }
}

const LEAK_PATTERNS = [
  [/^\s*(okay|ok|alright|so)[,.]?\s+(let'?s|let me|i|we|the user)\b/i, 'starts with planning'],
  [/\bwe need to\b/i, '"we need to"'],
  [/\blet'?s (call|use|check|start|fetch|search|look|see|try)\b/i, '"let\'s <act>"'],
  [/\blet me (call|use|check|fetch|search|look)\b/i, '"let me <act>"'],
  [/^\s*the user\b/i, 'starts with "The user"'],
  [/\bthe user (wants|asked|asks|is asking|said)\b/i, 'talks about "the user"'],
  [/\bI should\b/i, '"I should"'],
  [/\bmcp__\w+/i, 'mentions mcp__ tool name'],
  [/\btool (call|calls|result|results|name|output)\b/i, 'mentions tool calls/results'],
  [/\b(fetch_url|web_search|hub_repo_search|list_bill|nutrition_summary|clock_now|nc_calendar_\w+|log_ingredient|list_log_items)\b/, 'mentions a tool name'],
  [/<\/?think>|<\|channel\|>|<tool_call>/i, 'raw reasoning/tool markup'],
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const profileHome = (p) => (p === 'default' ? HERMES_HOME : `${HERMES_HOME}/profiles/${p}`);

// ------------------------------------------------------------------ live toolsets from hermes-api
// Only the profiles' toolsets are read live; cron prompts come from tasks/*.md (see cases.js).
const CONFIG_PY = `
import json, glob, yaml, fnmatch, os
home = ${JSON.stringify(HERMES_HOME)}
talk_tools = ${JSON.stringify(MCP_TALK_WRITE_TOOLS)}
marker = ${JSON.stringify(PLUGIN_BENCH_MARKER)}
out = {"toolsets": {}}
cfgs = {"default": home + "/config.yaml"}
for f in glob.glob(home + "/profiles/*/config.yaml"):
    cfgs[f.split("/")[-2]] = f
for p, f in cfgs.items():
    try:
        c = yaml.safe_load(open(f)) or {}
        pt = c.get("platform_toolsets") or {}
        out["toolsets"][p] = {"cli": pt.get("cli") or c.get("toolsets") or [], "cron": pt.get("cron") or []}
        # Talk write tools reachable through a Nextcloud MCP server (by toolset name).
        talk_mcp = {}
        for name, srv in (c.get("mcp_servers") or {}).items():
            srv = srv or {}
            if "nextcloud" not in name and "nextcloud" not in str(srv.get("url") or ""):
                continue
            tools = srv.get("tools") or {}
            inc = tools.get("include")
            exc = tools.get("exclude") or []
            hit = [t for t in talk_tools if (inc is None or any(fnmatch.fnmatchcase(t, pat) for pat in inc)) and not any(fnmatch.fnmatchcase(t, pat) for pat in exc)]
            if hit:
                talk_mcp[name] = hit
        out["toolsets"][p]["talk_mcp"] = talk_mcp
        plug = os.path.join(os.path.dirname(f), "plugins", "talk_send", "__init__.py")
        out["toolsets"][p]["talk_plugin"] = os.path.isfile(plug) and marker in open(plug).read()
    except Exception as e:
        out["toolsets"][p] = {"error": str(e)}
print(json.dumps(out))
`;

let liveConfig = null;
async function loadLiveConfig() {
  if (liveConfig) return liveConfig;
  const r = await dockerExec(CONTAINER, [PY, '-'], { user: 'hermes', input: CONFIG_PY, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`cannot read Hermes profile config: ${r.stderr.slice(0, 300)}`);
  liveConfig = JSON.parse(r.stdout);
  return liveConfig;
}

// ------------------------------------------------------------------ session data (read-only sqlite)
const SESSION_PY = `
import json, sqlite3, sys
db, sid = sys.argv[1], sys.argv[2]
c = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=30)
c.row_factory = sqlite3.Row
ids, frontier = [sid], [sid]
while frontier:
    nxt = [r["id"] for r in c.execute("select id from sessions where parent_session_id in (%s)" % ",".join("?" * len(frontier)), frontier)]
    nxt = [x for x in nxt if x not in ids]
    ids += nxt
    frontier = nxt
cols = ["id", "model", "input_tokens", "output_tokens", "reasoning_tokens", "api_call_count", "tool_call_count", "message_count", "end_reason", "started_at", "ended_at"]
sessions = []
for i in ids:
    r = c.execute("select * from sessions where id = ?", (i,)).fetchone()
    if r:
        sessions.append({k: r[k] for k in cols if k in r.keys()})
msgs = []
for r in c.execute("select session_id, role, content, tool_calls, tool_name, finish_reason, timestamp from messages where session_id in (%s) order by id" % ",".join("?" * len(ids)), ids):
    content = r["content"] or ""
    msgs.append({"session_id": r["session_id"], "role": r["role"], "content": content[:60000], "tool_calls": r["tool_calls"], "tool_name": r["tool_name"], "finish_reason": r["finish_reason"]})
print(json.dumps({"sessions": sessions, "messages": msgs}))
`;

async function sessionData(profile, sid) {
  const r = await dockerExec(CONTAINER, [PY, '-', `${profileHome(profile)}/state.db`, sid], { user: 'hermes', input: SESSION_PY, timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
  if (r.code !== 0) return { error: r.stderr.slice(0, 300), sessions: [], messages: [] };
  try { return JSON.parse(r.stdout); } catch (e) { return { error: `bad session JSON: ${e.message}`, sessions: [], messages: [] }; }
}

async function logLines(profile, sids, sinceStamp) {
  if (!sids.length) return [];
  const dir = `${profileHome(profile)}/logs`;
  const pats = sids.map((s) => `-e ${shq(`[${s}]`)}`).join(' ');
  const r = await dockerExec(CONTAINER, ['sh', '-c', `grep -a -h -F ${pats} ${dir}/agent.log ${dir}/agent.log.1 ${dir}/agent.log.2 ${dir}/agent.log.3 2>/dev/null`], { user: 'hermes', timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 });
  const lines = r.stdout.split('\n').filter(Boolean).map((l) => l.replace(/[^\x09\x20-\x7e -￿]/g, ''));
  // Time window: lines at/after the session start (the id starts with YYYYMMDD_HHMMSS).
  return [...new Set(lines)].filter((l) => !sinceStamp || l.slice(0, 19) >= sinceStamp).sort();
}

function parseLogs(lines, model) {
  const m = { api_calls: 0, tokens_in: 0, tokens_out: 0, tools_completed: 0, tools_failed: [], parse_errors: 0, truncated: 0, errors: [], turn_end: null, models: new Set(), latency_s: 0 };
  for (const l of lines) {
    let x;
    if ((x = l.match(/API call #\d+: model=(\S+) .*?\bin=(\d+) out=(\d+).*?latency=([\d.]+)s/))) {
      m.api_calls += 1; m.tokens_in += Number(x[2]); m.tokens_out += Number(x[3]); m.latency_s += Number(x[4]); m.models.add(x[1]);
    } else if ((x = l.match(/tool (\S+) (completed|failed)/))) {
      if (x[2] === 'completed') m.tools_completed += 1; else m.tools_failed.push(x[1]);
    }
    if (/Failed to parse tool call arguments/i.test(l)) m.parse_errors += 1;
    if (/truncat/i.test(l)) m.truncated += 1;
    if ((x = l.match(/Turn ended: reason=(\S+)/))) m.turn_end = x[1];
    if (/ ERROR /.test(l)) m.errors.push(l.slice(0, 300));
  }
  m.models = [...m.models];
  m.wrong_model = m.models.filter((x) => x !== model);
  return m;
}

function toolCallsFrom(messages) {
  const calls = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue;
    let arr;
    try { arr = JSON.parse(msg.tool_calls); } catch { continue; }
    for (const c of Array.isArray(arr) ? arr : []) {
      const fn = c.function || c;
      let args = fn.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep raw */ } }
      calls.push({ name: fn.name, args });
    }
  }
  return calls;
}

/**
 * Tool usage for the SQLite store: tool_used_pct = share of model calls (API calls) whose reply
 * contained at least one tool call; per-call list with ok from the Hermes log ("tool X failed"
 * lines, assigned to that tool's calls in order) and a hash of the canonical arguments.
 */
function toolStats(messages, logs, apiCalls) {
  const withTools = (messages || []).filter((m) => {
    if (m.role !== 'assistant' || !m.tool_calls) return false;
    try { const a = JSON.parse(m.tool_calls); return Array.isArray(a) && a.length > 0; } catch { return false; }
  }).length;
  const assistant = (messages || []).filter((m) => m.role === 'assistant').length;
  const calls = toolCallsFrom(messages || []);
  const failLeft = {};
  for (const n of (logs && logs.tools_failed) || []) failLeft[n] = (failLeft[n] || 0) + 1;
  const list = calls.map((c, i) => {
    let ok = true;
    if (failLeft[c.name] > 0) { ok = false; failLeft[c.name] -= 1; }
    const hash = crypto.createHash('sha1').update(JSON.stringify(canon(c.args ?? null))).digest('hex').slice(0, 16);
    return { seq: i + 1, tool: c.name || null, ok, duration_s: null, args_hash: hash };
  });
  const denom = apiCalls || assistant;
  return {
    metrics: {
      tool_used_pct: denom ? Math.round((1000 * Math.min(withTools, denom)) / denom) / 10 : null,
      model_calls_with_tools: (messages || []).length ? withTools : null,
    },
    list: (messages || []).length ? list : null,
  };
}

/** Import hook (main.js import): fill answer_text, metrics and tool calls from a saved transcript. */
function enrichFromTranscript(row, t) {
  if (!t) return row;
  if (row.answer_text == null && typeof t.answer === 'string') row.answer_text = t.answer;
  if (!row.metrics || row.metrics.tool_used_pct === undefined) {
    const ts = toolStats(t.messages, t.log_metrics, row.api_calls);
    row.metrics = { ...ts.metrics, ...(row.metrics || {}) };
    if (!row.tool_call_list && ts.list) row.tool_call_list = ts.list;
  }
  return row;
}

const canon = (v) => (v && typeof v === 'object' ? (Array.isArray(v) ? v.map(canon) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))) : v);

// ------------------------------------------------------------------ llama.cpp timings
/** Decode/prompt speed from llama-server `print_timing` lines between two instants. */
async function llamaTimings(sinceIso, untilIso) {
  const out = await docker(['logs', '--since', sinceIso, '--until', untilIso, 'llama-server'], { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
  const text = `${out.stdout}\n${out.stderr}`;
  const t = { decode_tokens: 0, decode_ms: 0, prompt_tokens: 0, prompt_ms: 0, calls: 0 };
  for (const l of text.split('\n')) {
    const m = l.match(/\|\s+(prompt eval|eval) time =\s+([\d.]+) ms \/\s+(\d+) tokens/);
    if (!m) continue;
    if (m[1] === 'eval') { t.decode_ms += Number(m[2]); t.decode_tokens += Number(m[3]); t.calls += 1; } else { t.prompt_ms += Number(m[2]); t.prompt_tokens += Number(m[3]); }
  }
  t.decode_tps = t.decode_ms > 0 ? Math.round((t.decode_tokens / t.decode_ms) * 10000) / 10 : null;
  t.prompt_tps = t.prompt_ms > 0 ? Math.round((t.prompt_tokens / t.prompt_ms) * 10000) / 10 : null;
  return t;
}

// ------------------------------------------------------------------ cases
function listCases(opts = {}) {
  const cases = [];
  for (const t of TASKS) {
    if (t.kind === 'cron') cases.push({ id: t.id, kind: 'cron', profile: t.profile, job: t.job, heading: t.heading, research: t.research, prompt: t.prompt });
    else cases.push({ id: t.id, kind: t.kind, profile: t.profile, chat: t, research: t.research });
  }
  return cases.filter((c) => (!opts.cases || opts.cases.includes(c.id)) && (!opts.profiles || opts.profiles.includes(c.profile)));
}

async function resolveCase(c) {
  const cfg = await loadLiveConfig();
  const ts = cfg.toolsets[c.profile];
  if (!ts) throw new Error(`profile ${c.profile} not found in hermes-api`);
  if (ts.error) throw new Error(`profile ${c.profile} config unreadable: ${ts.error}`);
  if (c.kind === 'cron') {
    if (!ts.cron.length) throw new Error(`profile ${c.profile} has no platform_toolsets.cron`);
    talkGuard(c.profile, ts.cron, ts);
    return { prompt: CRON_HINT + c.prompt, jobPrompt: c.prompt, toolsets: ts.cron };
  }
  // toolsets: cli (default: the profile's CLI toolsets without kanban/clarify/talk), cron, or an explicit list "a,b".
  const spec = c.chat.toolsets || 'cli';
  let toolsets;
  if (spec === 'cli') toolsets = (ts.cli || []).filter((t) => !CHAT_DROP_TOOLSETS.includes(t));
  else if (spec === 'cron') toolsets = ts.cron || [];
  else toolsets = spec.split(',').map((x) => x.trim()).filter(Boolean);
  if (!toolsets.length) throw new Error(`profile ${c.profile} resolves to no toolsets (${spec})`);
  talkGuard(c.profile, toolsets, ts);
  return { prompt: c.chat.prompt, toolsets };
}

function mcpClients() {
  return {
    wger: new McpClient(process.env.WGER_MCP_URL || 'http://wger-mcp:8765/mcp', { token: process.env.MCP_STATIC_TOKEN }),
    nextcloud: new McpClient(process.env.NEXTCLOUD_MCP_URL || 'http://nextcloud-mcp:8000/mcp'),
    firefly: new McpClient(process.env.FIREFLY_MCP_URL || 'http://firefly-mcp:3000/mcp'),
  };
}

// ------------------------------------------------------------------ checks
function genericChecks(c, resolved, run) {
  const { answer, exit, timedOut, logs, calls, toolText } = run;
  const checks = [];
  const completedWhy = [];
  if (timedOut) completedWhy.push(`timeout after ${CASE_TIMEOUT_S}s`);
  if (exit !== 0) completedWhy.push(`exit code ${exit}`);
  if (!answer.trim()) completedWhy.push('empty answer');
  if (logs.parse_errors) completedWhy.push(`${logs.parse_errors} tool-call parse error(s)`);
  if (logs.truncated) completedWhy.push(`${logs.truncated} truncation(s)`);
  if (logs.turn_end && !/^text_response/.test(logs.turn_end)) completedWhy.push(`turn ended: ${logs.turn_end}`);
  checks.push(check('completed', completedWhy.length === 0, completedWhy.join('; ') || 'ok'));

  const leaks = LEAK_PATTERNS.filter(([re]) => re.test(answer)).map(([, why]) => why);
  checks.push(check('no_reasoning_leak', answer.trim() ? leaks.length === 0 : null, leaks.join('; ') || (answer.trim() ? 'ok' : 'no answer')));

  const bad = [];
  const forbidden = calls.filter((x) => ALWAYS_FORBIDDEN.test(x.name || '')).map((x) => x.name);
  if (forbidden.length) bad.push(`forbidden: ${[...new Set(forbidden)].join(', ')}`);
  if (c.kind === 'cron') {
    const named = new Set((resolved.jobPrompt.match(/\b(mcp__[a-z0-9_]+|clock_now)\b/g) || []));
    named.add('clock_now');
    const extra = calls.map((x) => x.name).filter((n) => n && !named.has(n) && !/^clock_/.test(n) && !ALWAYS_FORBIDDEN.test(n));
    if (extra.length) bad.push(`tools not named in the prompt: ${[...new Set(extra)].join(', ')}`);
  }
  if (c.kind !== 'cron' && !c.chat.writeTools) {
    const writes = calls.filter((x) => WRITE_TOOL.test(x.name || '')).map((x) => x.name);
    if (writes.length) bad.push(`write tools in a read-only case: ${[...new Set(writes)].join(', ')}`);
  }
  const seen = {};
  for (const x of calls) {
    const k = `${x.name}|${JSON.stringify(canon(x.args))}`;
    seen[k] = (seen[k] || 0) + 1;
  }
  const reps = Object.entries(seen).filter(([, n]) => n > 1).map(([k, n]) => `${k.split('|')[0]} x${n}`);
  if (reps.length) bad.push(`repeated identical calls: ${reps.join(', ')}`);
  checks.push(check('no_forbidden_tools', bad.length === 0, bad.join('; ') || `${calls.length} call(s) ok`));

  if (c.kind === 'cron') {
    const t = answer.trim();
    const mixed = t !== '[SILENT]' && /\[SILENT\]|\bSILENT\b|\bNO_REPLY\b/.test(t);
    checks.push(check('silent_ok', t ? !mixed : null, mixed ? '[SILENT] mixed with content' : (t === '[SILENT]' ? 'silent' : 'content')));
    checks.push(check('size_ok', answer.length < 3500, `${answer.length} chars`));
  }

  if (c.research) {
    const urls = [...new Set((answer.match(/https?:\/\/[^\s)\]>"'`|]+/g) || []).map((u) => u.replace(/[.,;:!?*_]+$/, '')))];
    if (!toolText) checks.push(check('links_real', null, 'no tool results recorded'));
    else if (!urls.length) checks.push(check('links_real', null, 'no links in answer'));
    else {
      const hay = `${toolText}\n${decodeSafe(toolText)}`.replace(/&amp;/g, '&');
      const fake = urls.filter((u) => {
        const v = [u, u.replace(/\/$/, ''), decodeSafe(u)];
        try { const p = new URL(u); v.push(p.pathname.replace(/^\//, '').replace(/\/$/, '')); } catch { /* ignore */ }
        return !v.some((x) => x && x.length > 3 && hay.includes(x));
      });
      checks.push(check('links_real', fake.length === 0, fake.length ? `${fake.length}/${urls.length} link(s) not in any tool result: ${fake.slice(0, 5).join(' ')}` : `${urls.length} link(s) found in tool results`));
    }
  }
  return checks;
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

/**
 * Offline part of the cron `correct` check: output contract (heading, [SILENT], error line, links) and, for
 * research jobs, the digest content against the tool results (content.js). Used live and by rescoreRow.
 */
function cronProblems(c, answer, messages, nowIso, prompt) {
  const a = answer.trim();
  const silent = a === '[SILENT]';
  const problems = [];
  // Fetch failures arrive inside the tool's JSON envelope ({"result": "Could not fetch ..."}).
  const failedTools = content.anyToolFailed(messages);
  const headingRe = new RegExp(`^\\W*${c.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  const oneLineError = a.split('\n').filter((l) => l.trim()).length <= 2 && /error|fail|could not|unable|unavailable/i.test(a);
  if (!a) problems.push('empty answer');
  else if (silent && failedTools && !c.research) problems.push('[SILENT] after a tool failure');
  else if (!silent && !headingRe.test(a) && !oneLineError) problems.push(`does not start with heading "${c.heading}"`);
  if (!silent && c.research && headingRe.test(a) && !/https?:\/\//.test(a)) problems.push('digest without links');
  let summary = '';
  if (c.research && a) {
    const g = content.gradeContent(c.job, a, messages, nowIso, prompt);
    problems.push(...g.problems);
    summary = g.summary;
    // Without a content reference, keep the generic rule for [SILENT] after a failure.
    if (!g.applicable && silent && failedTools) problems.push('[SILENT] after a tool failure');
  }
  return { problems, silent, oneLineError, summary };
}

async function cronCorrectness(c, run, clients) {
  const { problems, silent, oneLineError, summary } = cronProblems(c, run.answer, run.messages, new Date().toISOString(), c.prompt);
  let expect = null;
  try { expect = await cronExpectation(c.job, clients); } catch (e) { expect = { why: `expectation unavailable: ${e.message}` }; }
  if (expect) {
    if (expect.expectSilent === true && !silent && !oneLineError) problems.push(`expected [SILENT] (${expect.why})`);
    if (expect.mustNotSilent && silent) problems.push(`answered [SILENT] but ${expect.why}`);
    if (c.job === 'payments-unpaid' && expect.mustMention && expect.mustMention.length && !silent) {
      const miss = expect.mustMention.filter((n) => !run.answer.toLowerCase().includes(String(n).toLowerCase()));
      if (miss.length) problems.push(`missing unpaid: ${miss.join(', ')}`);
    }
    if (c.job === 'payments-unpaid' && expect.expectSilent === false && silent) problems.push(`answered [SILENT] but ${expect.why}`);
    if (c.job === 'calories-report' && expect.kcal > 0) {
      if (silent) problems.push(`answered [SILENT] but ${expect.why}`);
      else {
        const nums = (a.match(/\d[\d.,]*/g) || []).map((x) => Number(x.replace(/,/g, '')));
        if (!nums.some((n) => Math.abs(n - expect.kcal) <= Math.max(2, expect.kcal * 0.02))) problems.push(`kcal ${Math.round(expect.kcal)} not in answer`);
      }
    }
  }
  return check('correct', problems.length === 0, problems.join('; ') || `${silent ? 'silent' : 'content'}${expect && expect.why ? ` (${expect.why})` : ''}${summary ? ` (${summary})` : ''}`);
}

// ------------------------------------------------------------------ one case
async function runCase(ctx, c, repeat) {
  const { model, runDir, log } = ctx;
  const row = {
    benchmark: 'hermes', model, case_id: c.id, group: c.profile, kind: c.kind, repeat,
    status: 'error', duration_s: null, exit_code: null, tokens_in: 0, tokens_out: 0, api_calls: 0, tool_calls: 0, tool_errors: 0,
    answer_chars: 0, decode_tps: null, prompt_tps: null, checks: [], failure_types: [], leftovers: [], transcript: null, notes: '',
  };
  const notes = [];
  const clients = mcpClients();
  const transcript = { case: c.id, model, profile: c.profile, kind: c.kind };
  let before = null;
  let setupOk = true;
  try {
    const resolved = await resolveCase(c);
    transcript.prompt = resolved.prompt;
    transcript.toolsets = resolved.toolsets;

    // Make sure the model under test is still the loaded one (other clients can swap it).
    const m = await router.getModel(model).catch(() => null);
    if (m && !['loaded', 'sleeping'].includes(m.status)) {
      notes.push(`model was ${m.status} before the case (another client swapped it); reloaded`);
      const lr = await router.load(model, { log });
      if (!lr.ok) throw new Error(`reload failed: ${lr.error}`);
    }

    if (c.kind !== 'cron' && c.chat.setup) {
      try { before = await c.chat.setup(clients); } catch (e) { setupOk = false; throw new Error(`setup snapshot failed: ${e.message}`); }
    }

    const w = await dockerExec(CONTAINER, ['sh', '-c', `cat > ${QUERY_FILE}`], { user: 'hermes', input: resolved.prompt, timeoutMs: 30_000 });
    if (w.code !== 0) throw new Error(`cannot write query file: ${w.stderr.slice(0, 200)}`);

    const cmd = ['timeout', '-k', '15', String(CASE_TIMEOUT_S), 'hermes'];
    if (c.profile !== 'default') cmd.push('-p', c.profile);
    cmd.push('chat', '--query-file', QUERY_FILE, '-m', model, '-t', resolved.toolsets.join(','), '--quiet', '--max-turns', String(MAX_TURNS), '--source', 'tool');
    const env = benchmarkEnv();
    transcript.command = `docker exec -u hermes ${Object.keys(env).map((k) => `-e ${k}`).join(' ')} ${CONTAINER} ${cmd.join(' ')}`;
    transcript.talk_room = TALK_ROOM || null;
    log(`  ${c.id} [${c.profile}] running...`);
    const started = Date.now();
    const startedIso = new Date(started - 1000).toISOString();
    const r = await dockerExec(CONTAINER, cmd, { user: 'hermes', env, timeoutMs: (CASE_TIMEOUT_S + 60) * 1000, signal: ctx.signal });
    row.duration_s = Math.round((Date.now() - started) / 100) / 10;
    row.exit_code = r.code;
    const timedOut = r.timedOut || r.code === 124 || r.code === 137;
    transcript.stdout = r.stdout;
    try {
      const lt = await llamaTimings(startedIso, new Date(Date.now() + 1000).toISOString());
      row.decode_tps = lt.decode_tps;
      row.prompt_tps = lt.prompt_tps;
      transcript.llama_timings = lt;
    } catch (e) { notes.push(`llama timings unavailable: ${e.message}`); }
    transcript.stderr = r.stderr.slice(-20000);

    const sidMatch = r.stderr.match(/session_id:\s*(\S+)/);
    let sid = sidMatch ? sidMatch[1] : null;
    let sess = { sessions: [], messages: [] };
    if (sid) sess = await sessionData(c.profile, sid);
    else notes.push('no session id in output');
    const ids = sess.sessions.map((s) => s.id);
    if (sid && !ids.includes(sid)) ids.push(sid);
    const stamp = sid && /^\d{8}_\d{6}/.test(sid) ? `${sid.slice(0, 4)}-${sid.slice(4, 6)}-${sid.slice(6, 8)} ${sid.slice(9, 11)}:${sid.slice(11, 13)}:${sid.slice(13, 15)}` : null;
    const lines = await logLines(c.profile, ids, stamp);
    const logs = parseLogs(lines, model);
    transcript.session_id = sid;
    transcript.sessions = sess.sessions;
    transcript.messages = sess.messages;
    transcript.log_lines = lines;

    // `hermes chat` validates -t before its background plugin discovery has finished and can
    // print a spurious "Warning: Unknown toolsets: clock" to stdout although the plugin's tools
    // are loaded for the turn. That line is CLI noise, not part of the model's answer.
    let answer = r.stdout.trim();
    const cliWarning = answer.match(/^Warning: Unknown toolsets: [^\n]*\n?/);
    if (cliWarning) {
      answer = answer.slice(cliWarning[0].length).trim();
      notes.push(`stripped CLI line from stdout: ${cliWarning[0].trim()}`);
    }
    if (!answer) {
      const last = [...sess.messages].reverse().find((x) => x.role === 'assistant' && x.content && !x.tool_calls);
      if (last) { answer = last.content.trim(); notes.push('answer taken from session (stdout empty)'); }
    }
    const calls = toolCallsFrom(sess.messages);
    const toolText = sess.messages.filter((x) => x.role === 'tool').map((x) => x.content).join('\n');
    const dbTok = sess.sessions.reduce((a, s) => ({ in: a.in + (s.input_tokens || 0), out: a.out + (s.output_tokens || 0), api: a.api + (s.api_call_count || 0) }), { in: 0, out: 0, api: 0 });
    row.tokens_in = logs.tokens_in || dbTok.in;
    row.tokens_out = logs.tokens_out || dbTok.out;
    row.api_calls = logs.api_calls || dbTok.api;
    row.tool_calls = calls.length || logs.tools_completed + logs.tools_failed.length;
    row.tool_errors = logs.tools_failed.length;
    row.answer_chars = answer.length;
    if (logs.wrong_model.length) notes.push(`log shows other model(s): ${logs.wrong_model.join(', ')}`);
    if (logs.errors.length) notes.push(`${logs.errors.length} ERROR log line(s)`);
    transcript.answer = answer;
    transcript.tool_calls = calls;
    row.answer_text = answer;
    const ts = toolStats(sess.messages, logs, row.api_calls);
    row.metrics = ts.metrics;
    if (ts.list) row.tool_call_list = ts.list;
    transcript.log_metrics = logs;

    const runInfo = { answer, exit: r.code, timedOut, logs, calls, toolText, messages: sess.messages };
    row.checks = genericChecks(c, resolved, runInfo);
    if (c.kind === 'cron') row.checks.push(await cronCorrectness(c, runInfo, clients));
    else if (c.chat.verify) {
      try {
        const v = await c.chat.verify(clients, before, runInfo);
        row.checks.push(...v.checks);
        if (v.notes) notes.push(...v.notes);
        if (v.leftovers) row.leftovers.push(...v.leftovers);
      } catch (e) { row.checks.push(check('correct', false, `verification error: ${e.message}`)); }
    }
    if (timedOut) row.status = 'timeout';
    else if (r.code !== 0 && !answer) row.status = 'error';
    else row.status = row.checks.every((x) => x.pass !== false) ? 'pass' : 'fail';
  } catch (e) {
    row.status = 'error';
    notes.push(`harness error: ${e.message}`);
  } finally {
    if (c.kind !== 'cron' && c.chat.cleanup && before && setupOk) {
      try {
        const cl = await c.chat.cleanup(clients, before);
        row.leftovers.push(...cl.leftovers);
        transcript.cleanup = cl;
        if (cl.deleted.length) notes.push(`cleanup deleted ${cl.deleted.length}: ${cl.deleted.join(', ')}`);
      } catch (e) { row.leftovers.push(`cleanup failed: ${e.message}`); }
    }
    const after = await router.getModel(model).catch(() => null);
    if (after && !['loaded', 'sleeping'].includes(after.status)) notes.push(`model ${after.status} after the case (possible interference)`);
  }
  for (const ch of row.checks) ch.category = ch.category || CATEGORY[ch.name] || 'correctness';
  row.failure_types = [
    ...(row.status === 'timeout' ? ['timeout'] : []),
    ...(row.status === 'error' ? ['error'] : []),
    ...row.checks.filter((x) => x.pass === false).map((x) => x.name),
    ...(row.leftovers.length ? ['leftover'] : []),
  ];
  row.notes = notes.join('; ');
  const tdir = path.join(runDir, 'transcripts', model);
  fs.mkdirSync(tdir, { recursive: true });
  const tname = `${c.id}${repeat > 1 ? `-r${repeat}` : ''}.json`;
  transcript.row = row;
  fs.writeFileSync(path.join(tdir, tname), JSON.stringify(transcript, null, 2));
  row.transcript = `transcripts/${model}/${tname}`;
  log(`  ${c.id}: ${row.status.toUpperCase()} in ${row.duration_s ?? '-'}s` + (row.status !== 'pass' ? ` (${row.checks.filter((x) => x.pass === false).map((x) => `${x.name}: ${x.reason}`).join('; ') || row.notes})` : ''));
  return row;
}

// ------------------------------------------------------------------ rescoring
// Checks that can be re-graded offline from a stored row and its transcript. Everything verified against
// live data at run time (wger, Nextcloud, Firefly state) keeps its stored result.
const OFFLINE_VERIFY = new Set(['shortAnswer']);

/**
 * `main.js rescore`: re-grade one stored row (lib/db.js loadRun shape) with the current rules.
 * Replaces the research cron `correct` check (format + content), adds the "[SILENT] after a tool failure"
 * rule to the other cron jobs, re-runs offline chat verifiers, then recomputes status and failure types.
 * Returns the list of changed check names.
 */
function rescoreRow(row, t) {
  const c = listCases().find((x) => x.id === row.case_id);
  if (!c || ['timeout', 'error', 'load_failed', 'skipped'].includes(row.status)) return [];
  const answer = (t && typeof t.answer === 'string' ? t.answer : row.answer_text) || '';
  const before = JSON.stringify(row.checks);
  const put = (ck) => {
    ck.category = CATEGORY[ck.name] || 'correctness';
    const i = row.checks.findIndex((x) => x.name === ck.name);
    if (i >= 0) row.checks[i] = ck; else row.checks.push(ck);
  };
  if (c.kind === 'cron' && t && Array.isArray(t.messages)) {
    const { problems, silent, summary } = cronProblems(c, answer, t.messages, row.created_at || null, t.prompt);
    const old = row.checks.find((x) => x.name === 'correct');
    if (c.research) {
      put(check('correct', problems.length === 0, problems.join('; ') || `${silent ? 'silent' : 'content'}${summary ? ` (${summary})` : ''}`));
    } else if (old && old.pass !== false && problems.length) {
      // Live expectations passed; the offline contract rules found a problem.
      put(check('correct', false, `${problems.join('; ')}; live check: ${old.reason || 'ok'}`));
    }
  } else if (c.kind !== 'cron' && c.chat.verifyHook && OFFLINE_VERIFY.has(c.chat.verifyHook)) {
    const v = hooks.verify[c.chat.verifyHook](null, null, { answer }, c.chat.params);
    return Promise.resolve(v).then((r) => { for (const ck of r.checks) put(ck); return finish(); });
  }
  return finish();

  function finish() {
    row.status = row.checks.every((x) => x.pass !== false) ? 'pass' : 'fail';
    row.failure_types = [
      ...row.checks.filter((x) => x.pass === false).map((x) => x.name),
      ...((row.leftovers || []).length ? ['leftover'] : []),
    ];
    if (JSON.stringify(row.checks) === before) return [];
    const was = Object.fromEntries(JSON.parse(before).map((x) => [x.name, x.pass]));
    return row.checks.filter((x) => was[x.name] !== x.pass || !(x.name in was)).map((x) => x.name);
  }
}

/** Kill a running benchmark hermes process (used on abort). */
async function abort() {
  await dockerExec(CONTAINER, ['pkill', '-f', `query-file ${QUERY_FILE}`], { timeoutMs: 15_000 }).catch(() => {});
}

/** ctx: { model, cases, repeat, runDir, log, signal, isAborted } */
async function run(ctx) {
  const rows = [];
  for (const c of ctx.cases) {
    for (let i = 1; i <= (ctx.repeat || 1); i++) {
      if (ctx.isAborted()) return rows;
      rows.push(await runCase(ctx, c, i));
      if (ctx.onRow) ctx.onRow(rows[rows.length - 1]);
    }
  }
  return rows;
}

async function describeCase(c) {
  try {
    const r = await resolveCase(c);
    return `${c.id.padEnd(22)} ${c.kind.padEnd(5)} profile=${c.profile.padEnd(16)} toolsets=${r.toolsets.join(',')}`;
  } catch (e) {
    return `${c.id.padEnd(22)} ${c.kind.padEnd(5)} profile=${c.profile.padEnd(16)} (unresolved: ${e.message})`;
  }
}

// Check categories for the scoring rubric (lib/report.js).
const CATEGORY = { completed: 'completed', correct: 'correctness', read_only: 'correctness', links_real: 'correctness', no_reasoning_leak: 'rules', no_forbidden_tools: 'rules', silent_ok: 'rules', size_ok: 'rules' };

/** Before the first model: snapshot test-date items and Firefly lists. */
async function prepareRun() {
  return runSnapshot(mcpClients());
}

/** After the run (also on abort/error): remove benchmark items, temp files; verify the test date is empty. */
async function finalCleanup(snap) {
  const res = snap ? await runCleanup(mcpClients(), snap) : { removed: [], leftovers: ['no start snapshot'], verification: {} };
  const tmp = await dockerExec(CONTAINER, ['sh', '-c', 'ls /tmp/bench_* 2>/dev/null; rm -f /tmp/bench_*'], { timeoutMs: 30_000 });
  for (const f of tmp.stdout.split('\n').filter(Boolean)) res.removed.push(`hermes-api ${f}`);
  return res;
}

module.exports = {
  name: 'hermes',
  categories: CATEGORY,
  prepareRun,
  finalCleanup,
  description: 'Hermes agent profiles on their real jobs: cron and chat tasks defined in tasks/*.md; chat writes on 2027-01-15 are verified and cleaned up.',
  listCases,
  run,
  abort,
  describeCase,
  enrichFromTranscript,
  rescoreRow,
};
