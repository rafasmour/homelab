'use strict';
// Hermes benchmark: runs the real Hermes profiles (container hermes-api) on a
// given llama.cpp model with `hermes chat --query-file ... --quiet` and scores
// correctness, rule-following and speed. A `chat` run never posts to the real
// Talk rooms: see "Talk isolation" below.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { docker, dockerExec } = require('../../lib/docker');
const db = require('../../lib/db');
const { McpClient } = require('../../lib/mcp');
const router = require('../../lib/router');
const { TASKS, cronExpectation, check, runSnapshot, runCleanup } = require('./cases');
const { KANBAN_DIR, KANBAN_DB, kanbanCards } = require('./helpers');
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
const ALWAYS_FORBIDDEN = /^(talk_send|send_message|kanban_.*|clarify|delegate_task|cronjob.*)$/;
// ask_agent (agents plugin) is deliberately not matched: chat cases may consult a specialist. A cron case that calls it is
// flagged by "tools not named in the prompt". delegate_task is Hermes' subagent tool and stays forbidden; delegate and task_status
// (agents plugin, ai-assistant cards) are allowed in chat cases like ask_agent and flagged in cron cases the same way.
// Cases with `kanban: true` (ai-assistant delegation) may create and read cards; every other kanban tool stays forbidden.
const KANBAN_ALLOWED = /^kanban_(create|list|show|comment)$/;
const forbiddenFor = (c, name) => ALWAYS_FORBIDDEN.test(name || '') && !(c.kind !== 'cron' && c.chat.kanban && KANBAN_ALLOWED.test(name));
// Hermes built-ins every profile's system prompt offers (memory is enabled on all
// profiles since 2026-11-02): allowed in every case, never "not named in the prompt".
// hindsight_retain/recall/reflect exist only when the Hindsight config is present; it is moved aside per case.
const HERMES_BUILTIN = /^(memory|clock_.*|hindsight_.*)$/;
// Every case runs in a throw-away HERMES_HOME (see "Sandbox" below): memory, skills, cron jobs, sessions and logs of the
// real profile are neither read nor written.
const PROFILE_HOME = (profile) => (profile === 'default' ? '/home/hermes/.hermes' : `/home/hermes/.hermes/profiles/${profile}`);
const BENCH_HOME = '/tmp/bench-home';
// Profiles the ask_agent tool can consult (hermes/plugins/agents). Each gets a throw-away copy under BENCH_HOME/profiles/<p>
// (the agents plugin runs the target with HERMES_HOME=<root>/profiles/<p>, root = BENCH_HOME), so a consulted profile is as
// sandboxed as the profile under test.
const CONSULT_PROFILES = ['calories', 'finance', 'nextcloud', 'planner', 'web-search', 'n8n', 'models', 'hf-models', 'ai-news', 'selfhosted', 'llamacpp-vulkan', 'llamacpp-rocm'];
const SHARED_PLUGINS = '/usr/local/share/hermes/plugins';
// nc_<app>_<verb>: calendar, notes, webdav, deck, ... (nc_notes_create_note and nc_notes_append_content count as writes).
const WRITE_TOOL = /(^|__)(store_|update_|delete_|destroy_|create_|log_ingredient|nc_[a-z]+_(create|update|delete|complete|bulk|manage|append|write|upload|move|copy|add|remove|share|edit))/;
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
  [/\bI should (call|use|check|fetch|search|look|first|now|start|begin|verify|compile)\b/i, '"I should <act>"'],
  [/enough thinking; answer now/i, 'reasoning-budget message (extra_body reasoning_budget_message)'],
  [/\bmcp__\w+/i, 'mentions mcp__ tool name'],
  [/\btool (call|calls|result|results|name|output)\b/i, 'mentions tool calls/results'],
  [/\b(fetch_url|web_search|hub_repo_search|list_bill|nutrition_summary|clock_now|nc_calendar_\w+|log_ingredient|list_log_items)\b/, 'mentions a tool name'],
  [/<\/?think>|<\|channel\|>|<tool_call>/i, 'raw reasoning/tool markup', true],
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

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
        # llama.cpp slot pinned by the profile's custom provider (extra_body.id_slot) and its reasoning budget.
        eb = {}
        for cp in (c.get("custom_providers") or []):
            if isinstance(cp, dict) and isinstance(cp.get("extra_body"), dict):
                eb = cp["extra_body"]
        out["toolsets"][p]["id_slot"] = eb.get("id_slot")
        out["toolsets"][p]["reasoning_budget_tokens"] = eb.get("reasoning_budget_tokens")
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
for r in c.execute("select session_id, role, content, tool_calls, tool_name, tool_call_id, finish_reason, timestamp from messages where session_id in (%s) order by id" % ",".join("?" * len(ids)), ids):
    content = r["content"] or ""
    msgs.append({"session_id": r["session_id"], "role": r["role"], "content": content[:60000], "tool_calls": r["tool_calls"], "tool_name": r["tool_name"], "tool_call_id": r["tool_call_id"], "finish_reason": r["finish_reason"]})
print(json.dumps({"sessions": sessions, "messages": msgs}))
`;

async function sessionData(profile, sid) {
  const r = await dockerExec(CONTAINER, [PY, '-', `${BENCH_HOME}/state.db`, sid], { user: 'hermes', input: SESSION_PY, timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024 });
  if (r.code !== 0) return { error: r.stderr.slice(0, 300), sessions: [], messages: [] };
  try { return JSON.parse(r.stdout); } catch (e) { return { error: `bad session JSON: ${e.message}`, sessions: [], messages: [] }; }
}

async function logLines(profile, sids, sinceStamp) {
  if (!sids.length) return [];
  const dir = `${BENCH_HOME}/logs`;
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
      calls.push({ name: fn.name, args, id: c.id || c.call_id || null });
    }
  }
  // Attach each call's tool result (by tool_call_id, else in order per tool name).
  const byId = new Map();
  const byName = {};
  for (const m of messages) {
    if (m.role !== 'tool') continue;
    if (m.tool_call_id) byId.set(m.tool_call_id, m.content || '');
    (byName[m.tool_name] || (byName[m.tool_name] = [])).push(m.content || '');
  }
  const used = {};
  for (const c of calls) {
    if (c.id && byId.has(c.id)) c.result = byId.get(c.id);
    else if (byName[c.name]) { used[c.name] = (used[c.name] || 0); c.result = byName[c.name][used[c.name]++]; }
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
    if (t.kind === 'cron') cases.push({ id: t.id, kind: 'cron', profile: t.profile, job: t.job, heading: t.heading, research: t.research, prompt: t.prompt, optin: t.optin, web: t.web });
    else cases.push({ id: t.id, kind: t.kind, profile: t.profile, chat: t, research: t.research, optin: t.optin, web: t.web });
  }
  // optin (ai-assistant group): only with --profiles/--cases (or --with-optin); web: only with --web or --cases.
  return cases.filter((c) => (!opts.cases || opts.cases.includes(c.id)) && (!opts.profiles || opts.profiles.includes(c.profile))
    && !(opts.defaultSelection && c.optin && !opts.withOptin) && !(c.web && !opts.web && !opts.cases));
}

async function resolveCase(c) {
  const cfg = await loadLiveConfig();
  const ts = cfg.toolsets[c.profile];
  if (!ts) throw new Error(`profile ${c.profile} not found in hermes-api`);
  if (ts.error) throw new Error(`profile ${c.profile} config unreadable: ${ts.error}`);
  if (c.kind === 'cron') {
    if (!ts.cron.length) throw new Error(`profile ${c.profile} has no platform_toolsets.cron`);
    talkGuard(c.profile, ts.cron, ts);
    return { prompt: CRON_HINT + c.prompt, jobPrompt: c.prompt, toolsets: ts.cron, idSlot: ts.id_slot ?? null, reasoningBudget: ts.reasoning_budget_tokens ?? null };
  }
  // toolsets: cli (default: the profile's CLI toolsets without kanban/clarify/talk), cron, or an explicit list "a,b".
  const spec = c.chat.toolsets || 'cli';
  let toolsets;
  // `kanban: true` cases (ai-assistant delegation) keep the kanban toolset; the board is the throw-away one (see runCase).
  if (spec === 'cli') toolsets = (ts.cli || []).filter((t) => !CHAT_DROP_TOOLSETS.includes(t) || (t === 'kanban' && c.chat.kanban));
  else if (spec === 'cron') toolsets = ts.cron || [];
  else toolsets = spec.split(',').map((x) => x.trim()).filter(Boolean);
  if (!toolsets.length) throw new Error(`profile ${c.profile} resolves to no toolsets (${spec})`);
  talkGuard(c.profile, toolsets, ts);
  return { prompt: c.chat.prompt, toolsets, idSlot: ts.id_slot ?? null, reasoningBudget: ts.reasoning_budget_tokens ?? null };
}

/** llama.cpp `parallel` (slots) of a preset, from the mounted router-config.ini; null when unknown. */
function presetSlots(model) {
  const p = db.routerPresets()[model];
  const n = p && p.extra ? Number(p.extra.parallel) : NaN;
  return Number.isFinite(n) ? n : null;
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

  // Phrase patterns run on the prose only: a quoted Reddit title in a digest link ("I should've listened...")
  // is source text, not the model thinking aloud (cron-selfhosted was failed for it in six runs).
  // Research digests also quote source text in their bullet descriptions ("improves tool calls", "users asked ..."):
  // only their heading and non-bullet lines are checked for thinking aloud.
  let prose = answer.replace(/\[[^\]]*\]\([^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  if (c.research && c.kind === 'cron') prose = prose.split('\n').filter((l) => !/^\s*(?:[-*\u2022]|\d+[.)])\s/.test(l) && !/^\s{2,}\S/.test(l)).join('\n');
  const leaks = LEAK_PATTERNS.filter(([re, , raw]) => re.test(raw ? answer : prose)).map(([, why]) => why);
  checks.push(check('no_reasoning_leak', answer.trim() ? leaks.length === 0 : null, leaks.join('; ') || (answer.trim() ? 'ok' : 'no answer')));

  const bad = [];
  const forbidden = calls.filter((x) => forbiddenFor(c, x.name)).map((x) => x.name);
  if (forbidden.length) bad.push(`forbidden: ${[...new Set(forbidden)].join(', ')}`);
  if (c.kind === 'cron') {
    const named = new Set((resolved.jobPrompt.match(/\b(mcp__[a-z0-9_]+|clock_now)\b/g) || []));
    named.add('clock_now');
    const extra = calls.map((x) => x.name).filter((n) => n && !named.has(n) && !HERMES_BUILTIN.test(n) && !forbiddenFor(c, n));
    if (extra.length) bad.push(`tools not named in the prompt: ${[...new Set(extra)].join(', ')}`);
  }
  if (c.kind !== 'cron' && !c.chat.writeTools) {
    const writes = calls.filter((x) => WRITE_TOOL.test(x.name || '')).map((x) => x.name);
    if (writes.length) bad.push(`write tools in a read-only case: ${[...new Set(writes)].join(', ')}`);
  }
  const seen = {};
  const lastResult = {};
  for (const x of calls) {
    // clock_now returns a new time on every call: repeating it in a chat is not a loop (cron prompts say "once").
    if (c.kind !== 'cron' && /^clock_/.test(x.name || '')) continue;
    const k = `${x.name}|${JSON.stringify(canon(x.args))}`;
    // In a chat, re-reading after a change (list_log_items after log_ingredient) is legitimate: a repeated read only
    // counts when it returned what the earlier identical call returned. Repeated writes and cron repeats always count.
    if (c.kind !== 'cron' && k in lastResult && !WRITE_TOOL.test(x.name || '') && x.result !== undefined && lastResult[k] !== undefined && x.result !== lastResult[k]) {
      lastResult[k] = x.result;
      continue;
    }
    lastResult[k] = x.result;
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
    // Trailing markdown emphasis characters are stripped, but an underscore can belong to a Reddit slug: try both forms.
    const urls = [...new Set((answer.match(/https?:\/\/[^\s)\]>"'`|]+/g) || []).map((u) => u.replace(/[.,;:!?*]+$/, '')))];
    if (!toolText) checks.push(check('links_real', null, 'no tool results recorded'));
    else if (!urls.length) checks.push(check('links_real', null, 'no links in answer'));
    else {
      const index = linkIndex(toolText);
      const fake = urls.filter((u) => !linkFound(u, index) && !linkFound(u.replace(/_+$/, ''), index));
      checks.push(check('links_real', fake.length === 0, fake.length ? `${fake.length}/${urls.length} link(s) not in any tool result: ${fake.slice(0, 5).join(' ')}` : `${urls.length} link(s) found in tool results`));
    }
  }
  return checks;
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

/**
 * Comparable form of a link: lower-case host without www./old./np./m./new. (Reddit), no query, fragment or trailing slash.
 * A Reddit post is identified by its id: a mangled or missing slug (".../comments/1abc/some_title/" vs ".../comments/1abc")
 * still opens the same post, so "r/<sub>/comments/<id>" is the whole key.
 */
function normUrl(u) {
  let p;
  try { p = new URL(String(u).replace(/&amp;/g, '&')); } catch { return null; }
  const host = p.hostname.toLowerCase().replace(/^(?:www|old|np|new|m|i)\./, '');
  const reddit = /^reddit\.com$/.test(host) && p.pathname.match(/^\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (reddit) return `reddit.com/r/${reddit[1].toLowerCase()}/comments/${reddit[2].toLowerCase()}`;
  if (host === 'redd.it') return `redd.it/${p.pathname.replace(/^\//, '').toLowerCase()}`;
  return `${host}${decodeSafe(p.pathname).replace(/\/+$/, '')}`.toLowerCase();
}

/** Index of what the tool results contain: the raw text (several encodings) and every link in it, normalised. */
function linkIndex(toolText) {
  const hay = `${toolText}\n${decodeSafe(toolText)}`.replace(/&amp;/g, '&').replace(/\\\//g, '/');
  const norm = new Set();
  for (const m of hay.match(/https?:\/\/[^\s)\]>"'`|\\]+/g) || []) { const n = normUrl(m); if (n) norm.add(n); }
  return { hay, norm };
}

function linkFound(u, { hay, norm }) {
  const n = normUrl(u);
  if (n && norm.has(n)) return true;
  const v = [u, u.replace(/\/$/, ''), decodeSafe(u)];
  try { v.push(new URL(u).pathname.replace(/^\//, '').replace(/\/$/, '')); } catch { /* ignore */ }
  return v.some((x) => x && x.length > 3 && hay.includes(x));
}

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
        const nums = (run.answer.trim().match(/\d[\d.,]*/g) || []).map((x) => Number(x.replace(/,/g, '')));
        if (!nums.some((n) => Math.abs(n - expect.kcal) <= Math.max(2, expect.kcal * 0.02))) problems.push(`kcal ${Math.round(expect.kcal)} not in answer`);
      }
    }
  }
  return check('correct', problems.length === 0, problems.join('; ') || `${silent ? 'silent' : 'content'}${expect && expect.why ? ` (${expect.why})` : ''}${summary ? ` (${summary})` : ''}`);
}

// ------------------------------------------------------------------ sandbox
// Every case runs in a throw-away HERMES_HOME (BENCH_HOME) built from a copy of the profile's config, plugins and skills:
//  - memory (MEMORY.md/USER.md, Hindsight), skills, cron jobs, sessions, logs and state.db are the copy's, so the case
//    neither reads the real memories nor writes to them or to the real session history; the folder is deleted afterwards.
//  - plugins/local_only/benchmark_sandbox.py (HERMES_BENCHMARK=1) answers writes to real systems with a fake success and
//    records every write in BENCH_HOME/benchmark-calls.jsonl; the calendar events/to-dos and wger items it lets through
//    are deleted by id (cleanupRecorded) in addition to the snapshot/diff cleanup of the hooks.
let sandboxBroken = null;

// HERMES_BENCH_PRESET_SAMPLING=1: drop the temperature/presence_penalty that hermes/start.sh writes into every custom
// provider's extra_body (HERMES_SAMPLING_*), so the llama.cpp preset's own sampling applies. Sandbox copies only.
const PRESET_SAMPLING_PY = `
import sys, yaml
changed = 0
for path in sys.argv[1:]:
    try:
        with open(path) as f:
            doc = yaml.safe_load(f)
    except Exception:
        continue
    def walk(node):
        global changed
        if isinstance(node, dict):
            body = node.get("extra_body")
            if isinstance(body, dict):
                for k in ("temperature", "presence_penalty"):
                    if k in body:
                        del body[k]
                        changed += 1
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(doc)
    with open(path, "w") as f:
        yaml.safe_dump(doc, f, default_flow_style=False, sort_keys=False, allow_unicode=True)
print("removed", changed)
`;
const presetSamplingCommand = (home) => ['sh', '-c', `for f in ${home}/config.yaml ${home}/profiles/*/config.yaml; do [ -f "$f" ] && echo "$f"; done | xargs python3 -c '${PRESET_SAMPLING_PY.replace(/'/g, "'\\''")}'`];

async function prepareHome(profile) {
  const P = PROFILE_HOME(profile);
  const H = BENCH_HOME;
  const R = '/home/hermes/.hermes/profiles';
  // One script builds the profile under test and the consult copies. A consult copy costs a few hundred KB (skills ~190 KB,
  // plugins ~125 KB); sessions, caches, state.db and hindsight of the real profiles are not copied.
  const script = `set -e
build() { S="$1"; D="$2"
  mkdir -p "$D"; chmod 700 "$D"
  for f in config.yaml .env SOUL.md auth.json profile.yaml .no-bundled-skills; do if [ -f "$S/$f" ]; then cp -a "$S/$f" "$D/"; fi; done
  for d in plugins skills hooks platforms; do if [ -d "$S/$d" ]; then cp -a "$S/$d" "$D/"; fi; done
  mkdir -p "$D/plugins" "$D/memories" "$D/workspace" "$D/logs" "$D/sessions" "$D/cron"
  rm -rf "$D/plugins/hermes-relay"
  for n in local_only talk_send; do if [ -d ${SHARED_PLUGINS}/$n ]; then rm -rf "$D/plugins/$n"; cp -a ${SHARED_PLUGINS}/$n "$D/plugins/$n"; fi; done
}
rm -rf ${H}; mkdir -p ${H}; chmod 700 ${H}
build ${P} ${H}
test -f ${H}/config.yaml && test -f ${H}/plugins/local_only/benchmark_sandbox.py
for p in ${CONSULT_PROFILES.join(' ')}; do
  if [ -d ${R}/$p ]; then
    build ${R}/$p ${H}/profiles/$p
    test -f ${H}/profiles/$p/config.yaml || { echo "consult copy $p: config.yaml missing" >&2; exit 3; }
    test -f ${H}/profiles/$p/plugins/local_only/benchmark_sandbox.py || { echo "consult copy $p: plugins/local_only/benchmark_sandbox.py missing" >&2; exit 3; }
  else echo "skip:$p"; fi
done`;
  const r = await dockerExec(CONTAINER, ['sh', '-c', script], { user: 'hermes', timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`cannot build the sandbox home ${H} from ${P} (and the consult copies): ${r.stderr.slice(0, 300) || 'config.yaml or benchmark_sandbox.py missing'}`);
  return (r.stdout.match(/^skip:(\S+)$/gm) || []).map((l) => l.slice(5));
}

/**
 * The write calls the sandbox plugin recorded (the profile under test's BENCH_HOME/benchmark-calls.jsonl and every consult
 * copy's BENCH_HOME/profiles/<p>/benchmark-calls.jsonl, tagged `consult_profile`), the ask_agent log (consults) and the files
 * the model wrote to its (throw-away) memory.
 */
async function readSandbox() {
  const out = { calls: [], loaded: false, memory: {}, consults: [] };
  const script = `for f in ${BENCH_HOME}/benchmark-calls.jsonl ${BENCH_HOME}/profiles/*/benchmark-calls.jsonl; do [ -f "$f" ] || continue; echo "@@FILE $f"; cat "$f"; echo; done; echo "@@CONSULTS"; cat ${BENCH_HOME}/logs/ask_agent.log 2>/dev/null; true`;
  const r = await dockerExec(CONTAINER, ['sh', '-c', script], { user: 'hermes', timeoutMs: 30_000 }).catch(() => null);
  let section = null;
  for (const l of ((r && r.stdout) || '').split('\n').filter(Boolean)) {
    const f = l.match(/^@@FILE (.+)$/);
    if (f) { const m = f[1].match(/\/profiles\/([^/]+)\/benchmark-calls\.jsonl$/); section = { consult: m ? m[1] : null }; continue; }
    if (l === '@@CONSULTS') { section = 'consults'; continue; }
    if (!section) continue;
    try {
      const x = JSON.parse(l);
      if (section === 'consults') out.consults.push(x);
      else if (x.tool === '__sandbox__') out.loaded = true;
      else out.calls.push(section.consult ? { ...x, consult_profile: section.consult } : x);
    } catch { /* partial line */ }
  }
  const m = await dockerExec(CONTAINER, ['sh', '-c', `for f in ${BENCH_HOME}/memories/*.md; do [ -f "$f" ] && { echo "== $(basename $f)"; head -c 3000 "$f"; echo; }; done 2>/dev/null; true`], { user: 'hermes', timeoutMs: 30_000 }).catch(() => null);
  if (m && m.stdout.trim()) out.memory = m.stdout.trim();
  return out;
}

/** Number of consults and their total seconds from the ask_agent log lines. */
function consultStats(consults) {
  const list = Array.isArray(consults) ? consults : [];
  return { count: list.length, seconds: Math.round(list.reduce((a, x) => a + (Number(x.seconds) || 0), 0) * 10) / 10 };
}

const UID_RE = /"(?:uid|id)\\?"\s*:\s*\\?"([0-9A-Za-z-]{8,})\\?"/;
const toolTail = (n) => String(n || '').split('__').pop();

/** Delete what the sandbox let through for real (events, to-dos, wger log items), by the ids it recorded. */
async function cleanupRecorded(clients, calls) {
  const deleted = [];
  const leftovers = [];
  const gone = new Set();
  for (const x of calls) {
    if (x.fake) continue;
    const t = toolTail(x.tool);
    const a = x.args || {};
    if (/^(nc_calendar_delete_(event|todo)|delete_log_item)$/.test(t)) gone.add(String(a.event_uid || a.todo_uid || a.log_item_id || ''));
  }
  for (const x of calls) {
    if (x.fake) continue;
    const t = toolTail(x.tool);
    const a = x.args || {};
    const id = (String(x.result || '').match(UID_RE) || [])[1];
    if (!id || gone.has(id)) continue;
    try {
      if (t === 'nc_calendar_create_event') { await clients.nextcloud.call('nc_calendar_delete_event', { calendar_name: a.calendar_name, event_uid: id }); deleted.push(`event ${a.calendar_name}/${a.summary || id}`); }
      else if (t === 'nc_calendar_create_todo') { await clients.nextcloud.call('nc_calendar_delete_todo', { calendar_name: a.calendar_name, todo_uid: id }); deleted.push(`todo ${a.calendar_name}/${a.summary || id}`); }
      else if (t === 'log_ingredient') { await clients.wger.call('delete_log_item', { log_item_id: id }); deleted.push(`wger log item ${id}`); }
      else continue;
      gone.add(id);
    } catch (e) {
      if (!/not.?found|404|does not exist/i.test(e.message)) leftovers.push(`${t} ${id}: delete failed: ${e.message}`);
    }
  }
  return { deleted, leftovers };
}

// ------------------------------------------------------------------ infra vs model faults
// A model that misbehaves (garbage, loops, malformed tool calls, refusals, timeouts, context overflow, HTTP 400/500 from
// a bad tool call) is scored. Faults of the environment are not: the case is retried once (model reloaded first) and, when
// the retry fails the same way, reported as `infra` and left out of the model's score.
const LLM_INFRA_RE = /Connection error|APIConnectionError|ConnectError|Connection refused|Connection reset|RemoteProtocolError|Server disconnected|Name or service not known|Temporary failure in name resolution|ReadTimeout|\b50[234]\b[^\n]{0,80}(?:llama|Bad Gateway|Unavailable)|Loading model|model is (?:loading|unloaded|not loaded)|Service Unavailable/i;
const TOOL_INFRA_RE = /ConnectError|ConnectTimeout|ReadTimeout|Connection (?:refused|reset|error)|ECONN(?:REFUSED|RESET)|Name or service not known|Temporary failure in name resolution|Server disconnected|RemoteProtocolError|Bad Gateway|Service Unavailable|Gateway Time-?out|\bHTTP (?:error )?(?:429|50\d|52\d)\b|Too Many Requests|rate.?limit|timed? ?out|MCP server[^\n]{0,60}(?:not connected|unavailable|disconnected|not running)/i;
const ERRORISH_RE = /^\s*(?:\{\s*"error"|error\b|could not|tool execution failed|mcp\b|\{\s*"result":\s*"(?:could not|error))/i;

function infraSignals({ logs, stderr, messages, exit, timedOut, sid, modelAfter, model }) {
  const why = [];
  if (!sid && !timedOut && exit !== 0) why.push(`hermes did not start (exit ${exit}): ${String(stderr || '').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  if (exit === -1 || exit === 125 || exit === 126 || exit === 127) why.push(`docker exec failed (exit ${exit})`);
  if (logs.wrong_model.length) why.push(`another model answered: ${logs.wrong_model.join(', ')}`);
  const llm = [...logs.errors, ...String(stderr || '').split('\n')].filter((l) => LLM_INFRA_RE.test(l));
  if (llm.length) why.push(`llama.cpp unreachable or loading: ${llm[0].replace(/\s+/g, ' ').slice(0, 160)}`);
  if (modelAfter && !['loaded', 'sleeping'].includes(modelAfter.status)) why.push(`${model} was ${modelAfter.status} after the case (swapped or crashed)`);
  const bad = content.toolResults(messages).filter((r) => (r.failed || ERRORISH_RE.test(r.text)) && TOOL_INFRA_RE.test(r.text.slice(0, 600)));
  if (bad.length) why.push(`tool ${bad[0].tool || '?'} failed: ${bad[0].text.replace(/\s+/g, ' ').slice(0, 140)}`);
  const src = content.sourceProblem(messages);
  if (src && !bad.length) why.push(src);
  return why;
}

// ------------------------------------------------------------------ one case
/** One attempt. The row carries `infra` (array of reasons) when the environment, not the model, may be to blame. */
async function runCaseOnce(ctx, c, repeat, attempt) {
  const { model, runDir, log } = ctx;
  const row = {
    benchmark: 'hermes', model, case_id: c.id, group: c.profile, kind: c.kind, repeat,
    status: 'error', duration_s: null, exit_code: null, tokens_in: 0, tokens_out: 0, api_calls: 0, tool_calls: 0, tool_errors: 0,
    answer_chars: 0, decode_tps: null, prompt_tps: null, checks: [], failure_types: [], leftovers: [], transcript: null, notes: '',
  };
  const notes = [];
  const infra = [];
  const clients = mcpClients();
  const transcript = { case: c.id, model, profile: c.profile, kind: c.kind, attempt };
  let before = null;
  let setupOk = true;
  let homeBuilt = false;
  let sandbox = null;
  let calls = [];
  try {
    if (sandboxBroken) throw new Error(`refused: ${sandboxBroken}`);
    const resolved = await resolveCase(c);
    transcript.prompt = resolved.prompt;
    transcript.toolsets = resolved.toolsets;
    // The profile's custom provider pins an llama.cpp slot (id_slot; ai-assistant 1, every other profile 0). A preset with
    // fewer slots has no such slot: llama-server would defer the request until the 15 min timeout, scored against the model.
    const slots = presetSlots(model);
    // The pin only chooses the prompt-cache slot, not behaviour: on a preset without that slot the case runs with
    // id_slot 0 in the throw-away profile copy (production config untouched) instead of being skipped.
    let remapSlot = false;
    if (resolved.idSlot != null) {
      transcript.id_slot = resolved.idSlot;
      if (slots != null && resolved.idSlot >= slots) {
        remapSlot = true;
        transcript.id_slot = 0;
        notes.push(`profile pins slot ${resolved.idSlot} but ${model} has parallel=${slots}: ran with id_slot 0 in the sandbox copy`);
      } else if (resolved.idSlot > 0) notes.push(`profile pins slot ${resolved.idSlot}${resolved.reasoningBudget ? ` and a ${resolved.reasoningBudget}-token reasoning budget` : ''}: on the production preset this overwrites the primed Hermes prompt (the prime replay restores it within ~2.5 min)`);
    }

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

    const skippedConsults = await prepareHome(c.profile);
    homeBuilt = true;
    if (skippedConsults.length) notes.push(`no real profile to copy for consults: ${skippedConsults.join(', ')}`);
    if (remapSlot) {
      const rs = await dockerExec(CONTAINER, ['sh', '-c', `for f in ${BENCH_HOME}/config.yaml ${BENCH_HOME}/profiles/*/config.yaml; do [ -f "$f" ] && sed -i -E 's/^([[:space:]]*id_slot:)[[:space:]]*[0-9]+/\\1 0/' "$f"; done; grep -q 'id_slot: 0' ${BENCH_HOME}/config.yaml`], { user: 'hermes', timeoutMs: 30_000 });
      if (rs.code !== 0) throw new Error(`refused: could not remap id_slot in the sandbox copy: ${(rs.stderr || '').slice(0, 200)}`);
    }
    if (process.env.HERMES_BENCH_PRESET_SAMPLING === '1') {
      const ps = await dockerExec(CONTAINER, presetSamplingCommand(BENCH_HOME), { user: 'hermes', timeoutMs: 30_000 });
      const m = /removed (\d+)/.exec(ps.stdout || '');
      if (ps.code !== 0 || !m || Number(m[1]) < 1) throw new Error(`refused: could not remove the temperature/presence_penalty override in the sandbox copy: ${((ps.stderr || '') + (ps.stdout || '')).slice(0, 200)}`);
      notes.push('preset sampling (Hermes temperature/presence override removed)');
    }
    // Throw-away Kanban board (HERMES_KANBAN_DB): kanban_create never reaches the real board and its dispatcher.
    const kb = await dockerExec(CONTAINER, ['sh', '-c', `rm -rf ${KANBAN_DIR} && mkdir -p ${KANBAN_DIR}`], { user: 'hermes', timeoutMs: 30_000 });
    if (kb.code !== 0) throw new Error(`cannot prepare ${KANBAN_DIR}: ${kb.stderr.slice(0, 200)}`);

    const w = await dockerExec(CONTAINER, ['sh', '-c', `cat > ${QUERY_FILE}`], { user: 'hermes', input: resolved.prompt, timeoutMs: 30_000 });
    if (w.code !== 0) throw new Error(`cannot write query file: ${w.stderr.slice(0, 200)}`);

    // No `-p`: HERMES_HOME is the profile's throw-away copy, which is the whole Hermes home of this process.
    const cmd = ['timeout', '-k', '15', String(CASE_TIMEOUT_S), 'hermes'];
    cmd.push('chat', '--query-file', QUERY_FILE, '-m', model, '-t', resolved.toolsets.join(','), '--quiet', '--max-turns', String(MAX_TURNS), '--source', 'tool');
    const env = { ...benchmarkEnv(), HERMES_HOME: BENCH_HOME, HERMES_WRITE_SAFE_ROOT: BENCH_HOME, HERMES_KANBAN_DB: KANBAN_DB, HERMES_ASK_AGENT_MODEL: model, HERMES_PROFILE: c.profile };
    transcript.command = `docker exec -u hermes ${Object.keys(env).map((k) => `-e ${k}`).join(' ')} ${CONTAINER} ${cmd.join(' ')}`;
    transcript.talk_room = TALK_ROOM || null;
    log(`  ${c.id} [${c.profile}] running${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);
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

    sandbox = await readSandbox();
    transcript.sandbox = sandbox;
    calls = sandbox.calls;
    transcript.consults = sandbox.consults;
    const cs = consultStats(sandbox.consults);
    row.consults = cs.count;
    row.consult_seconds = cs.seconds;
    const sidMatch = r.stderr.match(/session_id:\s*(\S+)/);
    const sid = sidMatch ? sidMatch[1] : null;
    if (!sandbox.loaded && (sid || r.stdout.trim())) {
      sandboxBroken = 'the benchmark sandbox plugin did not load in Hermes (hermes/plugins/local_only/benchmark_sandbox.py); remaining cases are refused so no write can reach a real system';
      throw new Error(sandboxBroken);
    }
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
    const callList = toolCallsFrom(sess.messages);
    const toolText = sess.messages.filter((x) => x.role === 'tool').map((x) => x.content).join('\n');
    const dbTok = sess.sessions.reduce((a, s) => ({ in: a.in + (s.input_tokens || 0), out: a.out + (s.output_tokens || 0), api: a.api + (s.api_call_count || 0) }), { in: 0, out: 0, api: 0 });
    row.tokens_in = logs.tokens_in || dbTok.in;
    row.tokens_out = logs.tokens_out || dbTok.out;
    row.api_calls = logs.api_calls || dbTok.api;
    row.tool_calls = callList.length || logs.tools_completed + logs.tools_failed.length;
    row.tool_errors = logs.tools_failed.length;
    row.answer_chars = answer.length;
    if (logs.wrong_model.length) notes.push(`log shows other model(s): ${logs.wrong_model.join(', ')}`);
    if (logs.errors.length) notes.push(`${logs.errors.length} ERROR log line(s)`);
    const fakes = calls.filter((x) => x.fake);
    if (fakes.length) notes.push(`sandbox answered ${fakes.length} write call(s) with a fake success: ${[...new Set(fakes.map((x) => toolTail(x.tool)))].join(', ')}`);
    if (sandbox.memory && typeof sandbox.memory === 'string') notes.push('model wrote to its throw-away memory');
    transcript.answer = answer;
    transcript.tool_calls = callList.map(({ result: _r, ...rest }) => rest);
    row.answer_text = answer;
    const ts = toolStats(sess.messages, logs, row.api_calls);
    row.metrics = { ...ts.metrics, consults: cs.count, consult_seconds: cs.seconds };
    if (ts.list) row.tool_call_list = ts.list;
    transcript.log_metrics = logs;

    transcript.kanban_cards = await kanbanCards().then((b) => b.tasks).catch(() => null);
    const runInfo = { answer, exit: r.code, timedOut, logs, calls: callList, toolText, messages: sess.messages, intercepted: calls.filter((x) => !x.consult_profile), consults: sandbox.consults };
    row.checks = genericChecks(c, resolved, runInfo);
    if (c.kind === 'cron') row.checks.push(await cronCorrectness(c, runInfo, clients));
    else if (c.chat.verify) {
      try {
        const v = await c.chat.verify(clients, before, runInfo);
        row.checks.push(...v.checks);
        if (v.notes) notes.push(...v.notes);
        if (v.leftovers) row.leftovers.push(...v.leftovers);
      } catch (e) { infra.push(`verification could not read the real system: ${e.message}`); }
    }
    if (timedOut) row.status = 'timeout';
    else if (r.code !== 0 && !answer) row.status = 'error';
    else row.status = row.checks.every((x) => x.pass !== false) ? 'pass' : 'fail';
    // Environment faults only matter when they can explain a bad outcome.
    if (row.status !== 'pass') {
      const after = await router.getModel(model).catch(() => null);
      infra.push(...infraSignals({ logs, stderr: r.stderr, messages: sess.messages, exit: r.code, timedOut, sid, modelAfter: after, model }));
    }
  } catch (e) {
    row.status = 'error';
    if (/^refused:/.test(e.message)) { row.status = 'skipped'; notes.push(e.message); } else { notes.push(`harness error: ${e.message}`); infra.push(`harness: ${e.message}`); }
  } finally {
    await dockerExec(CONTAINER, ['rm', '-rf', KANBAN_DIR], { user: 'hermes', timeoutMs: 30_000 }).catch(() => {});
    if (homeBuilt) {
      if (!sandbox) { sandbox = await readSandbox(); calls = sandbox.calls; }
      try {
        const cr = await cleanupRecorded(clients, calls);
        row.leftovers.push(...cr.leftovers);
        if (cr.deleted.length) notes.push(`sandbox cleanup deleted ${cr.deleted.length}: ${cr.deleted.join(', ')}`);
      } catch (e) { row.leftovers.push(`sandbox cleanup failed: ${e.message}`); }
    }
    if (c.kind !== 'cron' && c.chat.cleanup && before && setupOk) {
      try {
        const cl = await c.chat.cleanup(clients, before, calls);
        row.leftovers.push(...cl.leftovers);
        transcript.cleanup = cl;
        if (cl.deleted.length) notes.push(`cleanup deleted ${cl.deleted.length}: ${cl.deleted.join(', ')}`);
      } catch (e) { row.leftovers.push(`cleanup failed: ${e.message}`); }
    }
    if (homeBuilt) {
      const rm = await dockerExec(CONTAINER, ['rm', '-rf', BENCH_HOME], { user: 'hermes', timeoutMs: 60_000 }).catch((e) => ({ code: 1, stderr: e.message }));
      if (rm.code !== 0) row.leftovers.push(`sandbox home ${BENCH_HOME} not removed: ${(rm.stderr || '').slice(0, 200)}`);
    }
    const after = await router.getModel(model).catch(() => null);
    if (after && !['loaded', 'sleeping'].includes(after.status)) notes.push(`model ${after.status} after the case (possible interference)`);
  }
  for (const ch of row.checks) ch.category = ch.category || CATEGORY[ch.name] || 'correctness';
  row.infra = infra;
  row.failure_types = [
    ...(row.status === 'timeout' ? ['timeout'] : []),
    ...(row.status === 'error' ? ['error'] : []),
    ...row.checks.filter((x) => x.pass === false).map((x) => x.name),
    ...(row.leftovers.length ? ['leftover'] : []),
  ];
  row.notes = notes.join('; ');
  const tdir = path.join(runDir, 'transcripts', model);
  fs.mkdirSync(tdir, { recursive: true });
  const tname = `${c.id}${repeat > 1 ? `-r${repeat}` : ''}${attempt > 1 ? '-retry' : ''}.json`;
  transcript.row = row;
  fs.writeFileSync(path.join(tdir, tname), JSON.stringify(transcript, null, 2));
  row.transcript = `transcripts/${model}/${tname}`;
  return row;
}

/**
 * One case with infra handling: an attempt that did not pass and shows an environment fault (see infraSignals) is run once
 * more after making sure the model is loaded. If that attempt fails with an environment fault too, the row is `infra`
 * (no score, not counted against the model); otherwise the retry's outcome stands and is scored like any other.
 */
async function runCase(ctx, c, repeat) {
  const { model, log } = ctx;
  let row = await runCaseOnce(ctx, c, repeat, 1);
  const show = (r) => log(`  ${c.id}: ${r.status.toUpperCase()} in ${r.duration_s ?? '-'}s` + (r.status !== 'pass' ? ` (${r.checks.filter((x) => x.pass === false).map((x) => `${x.name}: ${x.reason}`).join('; ') || r.notes})` : ''));
  if (row.status !== 'pass' && row.status !== 'skipped' && row.infra.length && !ctx.isAborted()) {
    log(`  ${c.id}: environment fault (${row.infra[0]}); reloading ${model} and running the case once more`);
    const lr = await router.load(model, { log }).catch((e) => ({ ok: false, error: e.message }));
    if (!lr.ok) log(`  reload failed: ${lr.error}`);
    await new Promise((r) => setTimeout(r, /\b429\b|rate.?limit|Too Many/i.test(row.infra.join(' ')) ? 60_000 : 5_000));
    const first = row;
    row = await runCaseOnce(ctx, c, repeat, 2);
    row.notes = `${row.notes}${row.notes ? '; ' : ''}attempt 1 hit an environment fault (${first.infra.join(' | ').slice(0, 300)}; transcript ${first.transcript})`;
    if (row.status !== 'pass' && row.status !== 'skipped' && (row.infra.length || !lr.ok)) {
      const reasons = [...row.infra, ...(!lr.ok ? [`reload failed: ${lr.error}`] : [])];
      row.status = 'infra';
      row.notes = `${row.notes}; INFRA, excluded from the score: ${reasons.join(' | ').slice(0, 400)}`;
      row.failure_types = ['infra', ...(row.leftovers.length ? ['leftover'] : [])];
    }
  } else if (row.status === 'skipped') {
    row.failure_types = ['skipped'];
  }
  delete row.infra;
  show(row);
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
  const c = listCases({ web: true, withOptin: true }).find((x) => x.id === row.case_id);
  if (!c || ['timeout', 'error', 'load_failed', 'skipped', 'infra'].includes(row.status)) return [];
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

const tags = (c) => `${c.web ? '  [web: --web or --cases]' : ''}${c.optin ? '  [opt-in group: --profiles/--cases/--with-optin]' : ''}`;
async function describeCase(c) {
  try {
    const r = await resolveCase(c);
    return `${c.id.padEnd(22)} ${c.kind.padEnd(5)} profile=${c.profile.padEnd(16)} toolsets=${r.toolsets.join(',')}${tags(c)}`;
  } catch (e) {
    return `${c.id.padEnd(22)} ${c.kind.padEnd(5)} profile=${c.profile.padEnd(16)} (unresolved: ${e.message})${tags(c)}`;
  }
}

// Check categories for the scoring rubric (lib/report.js).
const CATEGORY = { completed: 'completed', correct: 'correctness', read_only: 'correctness', links_real: 'correctness', no_reasoning_leak: 'rules', no_forbidden_tools: 'rules', spoken_style: 'rules', silent_ok: 'rules', size_ok: 'rules' };

/** Before the first model: snapshot test-date items and Firefly lists. */
async function prepareRun() {
  // A run killed mid-case (container restart, host crash) leaves a Hindsight config moved aside: put it back,
  // otherwise Hindsight would stay off for real Hermes traffic.
  const rec = await dockerExec(CONTAINER, ['sh', '-c',
    `for f in ${HERMES_HOME}/hindsight/config.json.bench-off ${HERMES_HOME}/profiles/*/hindsight/config.json.bench-off; do [ -f "$f" ] || continue; t="\${f%.bench-off}"; if [ -f "$t" ]; then rm -f "$f"; else mv "$f" "$t"; fi; echo "$t"; done`],
    { user: 'hermes', timeoutMs: 30_000 }).catch(() => null);
  await dockerExec(CONTAINER, ['rm', '-rf', BENCH_HOME], { user: 'hermes', timeoutMs: 60_000 }).catch(() => {}); // left by a killed run
  const snap = await runSnapshot(mcpClients());
  if (rec && rec.stdout.trim()) snap.recovered = `Hindsight config(s) left aside by an earlier run restored: ${rec.stdout.trim().split('\n').join(', ')}`;
  return snap;
}

/** After the run (also on abort/error): remove benchmark items, temp files; verify the test date is empty. */
async function finalCleanup(snap) {
  const res = snap ? await runCleanup(mcpClients(), snap) : { removed: [], leftovers: ['no start snapshot'], verification: {} };
  const tmp = await dockerExec(CONTAINER, ['sh', '-c', `ls /tmp/bench_* 2>/dev/null; rm -f /tmp/bench_*; rm -rf ${KANBAN_DIR} ${BENCH_HOME}`], { timeoutMs: 30_000 });
  for (const f of tmp.stdout.split('\n').filter(Boolean)) res.removed.push(`hermes-api ${f}`);
  return res;
}

module.exports = {
  name: 'hermes',
  categories: CATEGORY,
  prepareRun,
  finalCleanup,
  PRESET_SAMPLING_PY,
  description: 'Hermes agent profiles on their real jobs: cron and chat tasks defined in tasks/*.md; chat writes on 2027-01-15 are verified and cleaned up.',
  listCases,
  run,
  abort,
  describeCase,
  enrichFromTranscript,
  rescoreRow,
  _test: { normUrl, linkIndex, linkFound, genericChecks, cronProblems, infraSignals, cleanupRecorded, WRITE_TOOL },
};
