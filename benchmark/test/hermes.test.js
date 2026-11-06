'use strict';
// Unit tests for the Hermes benchmark harness (no containers needed). Run from benchmark/:  node --test test/
const test = require('node:test');
const assert = require('node:assert');
const hermes = require('../benchmarks/hermes');
const content = require('../benchmarks/hermes/content');
const { scoreRow, aggregate } = require('../lib/report');
const T = hermes._test;

const ids = (o) => hermes.listCases(o).map((c) => c.id);

test('default selection: no opt-in group, no web cases, no gpu-watch', () => {
  const d = ids({ defaultSelection: true });
  for (const x of ['cron-ai-news', 'cron-selfhosted', 'cron-llamacpp-vulkan', 'cron-llamacpp-rocm', 'research-qa', 'assistant-event-en', 'cron-gpu-watch']) assert.ok(!d.includes(x), x);
  for (const x of ['cron-hf-models', 'food-log', 'reminder-todo', 'calendar-event', 'subscriptions-read', 'cron-calories-report']) assert.ok(d.includes(x), x);
});

test('--profiles ai-assistant selects the group, --with-optin adds it, --web adds web cases, --cases names anything', () => {
  assert.ok(ids({ profiles: ['ai-assistant'] }).every((x) => x.startsWith('assistant-')));
  assert.ok(ids({ defaultSelection: true, withOptin: true }).includes('assistant-agenda'));
  assert.ok(ids({ defaultSelection: true, web: true }).includes('cron-ai-news'));
  assert.deepStrictEqual(ids({ cases: ['cron-selfhosted'] }), ['cron-selfhosted']);
  assert.ok(!ids({ profiles: ['ai-news'] }).includes('cron-ai-news'));
});

test('links: Reddit host, slug, query and trailing slash variants all resolve to the same post', () => {
  const tool = '{"result": "- [A](https://www.reddit.com/r/selfhosted/comments/1xljfa9/scibrarian_your_personal_pubmed/) (2026-11-02T01:00:00+00:00)"}';
  const idx = T.linkIndex(tool);
  for (const u of [
    'https://www.reddit.com/r/selfhosted/comments/1xljfa9/scibrarian_your_personal_pubmed/',
    'https://old.reddit.com/r/selfhosted/comments/1xljfa9/scibrarian_your_personal_pubmed',
    'https://reddit.com/r/SelfHosted/comments/1xljfa9/',
    'https://www.reddit.com/r/selfhosted/comments/1xljfa9/scibrician_typo/?utm_source=x',
  ]) assert.ok(T.linkFound(u, idx), u);
  assert.ok(!T.linkFound('https://www.reddit.com/r/selfhosted/comments/1zzzzzz/invented/', idx));
  assert.ok(!T.linkFound('https://www.reddit.com/r/homelab/comments/1xljfa9/x/', idx));
});

const cronCase = { kind: 'cron', research: true, heading: 'Self-hosted', chat: null };
const resolved = { jobPrompt: 'clock_now once. mcp__web_search__fetch_url once.' };
const run = (answer, extra = {}) => ({ answer, exit: 0, timedOut: false, logs: { parse_errors: 0, truncated: 0, turn_end: null, wrong_model: [], errors: [] }, calls: [], toolText: '', messages: [], ...extra });
const byName = (cs, n) => cs.find((c) => c.name === n);

test('a digest bullet quoting "tool calls" is source text, not a reasoning leak; thinking aloud still is', () => {
  const ok = T.genericChecks(cronCase, resolved, run('Self-hosted, 2026-11-02\n- [Fix tool calls](https://www.reddit.com/r/x/comments/1abcdef/t/): users asked for better tool call parsing'));
  assert.strictEqual(byName(ok, 'no_reasoning_leak').pass, true);
  const bad = T.genericChecks(cronCase, resolved, run('Okay, let me check the feed.\n- [A](https://www.reddit.com/r/x/comments/1abcdef/t/): a'));
  assert.strictEqual(byName(bad, 'no_reasoning_leak').pass, false);
});

test('chat: re-reading after a change is not a loop, repeating a write or an unchanged read is', () => {
  const chat = { kind: 'chat', research: false, chat: { writeTools: true } };
  const mk = (calls) => byName(T.genericChecks(chat, {}, run('ok', { calls })), 'no_forbidden_tools');
  assert.strictEqual(mk([{ name: 'mcp__wger__list_log_items', args: { when: 'x' }, result: 'a' }, { name: 'mcp__wger__log_ingredient', args: { n: 1 }, result: 'r' }, { name: 'mcp__wger__list_log_items', args: { when: 'x' }, result: 'b' }]).pass, true);
  assert.strictEqual(mk([{ name: 'mcp__wger__list_log_items', args: { when: 'x' }, result: 'a' }, { name: 'mcp__wger__list_log_items', args: { when: 'x' }, result: 'a' }]).pass, false);
  assert.strictEqual(mk([{ name: 'mcp__wger__log_ingredient', args: { n: 1 }, result: 'a' }, { name: 'mcp__wger__log_ingredient', args: { n: 1 }, result: 'b' }]).pass, false);
});

test('chat: one ask_agent consult is allowed (also read-only), repeating it is a loop; in cron it is not named in the prompt', () => {
  const chat = { kind: 'chat', research: false, chat: { writeTools: false, kanban: true } };
  const ask = { name: 'ask_agent', args: { profile: 'calories', request: 'toast' }, result: '{"ok": true}' };
  assert.strictEqual(byName(T.genericChecks(chat, {}, run('ok', { calls: [ask] })), 'no_forbidden_tools').pass, true);
  assert.strictEqual(byName(T.genericChecks(chat, {}, run('ok', { calls: [ask, ask] })), 'no_forbidden_tools').pass, false);
  const cron = { kind: 'cron', research: false };
  assert.strictEqual(byName(T.genericChecks(cron, { jobPrompt: 'use clock_now' }, run('ok', { calls: [ask] })), 'no_forbidden_tools').pass, false);
});

test('chat: delegate and task_status are allowed once, flagged in cron; delegate_task is always forbidden', () => {
  const chat = { kind: 'chat', research: false, chat: { writeTools: false, kanban: true } };
  const del = { name: 'delegate', args: { assignee: 'calories', title: 't', details: 'd' }, result: '{"ok": true}' };
  const st = { name: 'task_status', args: {}, result: '{"ok": true}' };
  const ck = (c, calls, ctx = {}) => byName(T.genericChecks(c, ctx, run('ok', { calls })), 'no_forbidden_tools').pass;
  assert.strictEqual(ck(chat, [del, st]), true);
  assert.strictEqual(ck(chat, [del, del]), false);
  assert.strictEqual(ck({ ...chat, chat: { writeTools: false } }, [del]), true);
  assert.strictEqual(ck(chat, [{ name: 'delegate_task', args: { goal: 'x' }, result: 'r' }]), false);
  const cron = { kind: 'cron', research: false };
  assert.strictEqual(ck(cron, [del], { jobPrompt: 'use clock_now' }), false);
  assert.strictEqual(ck(cron, [st], { jobPrompt: 'use clock_now' }), false);
});

test('reddit window: expected within 24 h, accepted up to 25 h, older is wrong', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  const feed = (h) => new Date(now - h * 3600e3).toISOString().replace('.000Z', '+00:00');
  const msg = (text) => [{ role: 'tool', tool_name: 'mcp__web_search__fetch_url', content: `{"result": ${JSON.stringify(text)}}` },
    { role: 'tool', tool_name: 'clock_now', content: `{"utc": "${new Date(now).toISOString().replace('.000', '')}"}` }];
  const text = `- [a](https://www.reddit.com/r/LocalLLaMA/comments/1aaaaaa/a/) (${feed(2)})\n- [b](https://www.reddit.com/r/LocalLLaMA/comments/1bbbbbb/b/) (${feed(24.5)})\n- [c](https://www.reddit.com/r/LocalLLaMA/comments/1cccccc/c/) (${feed(30)})`;
  const ans = (links) => `r/LocalLLaMA\n${links.map((l) => `- [x](https://www.reddit.com/r/LocalLLaMA/comments/${l}/x/): y`).join('\n')}`;
  assert.deepStrictEqual(content.gradeContent('ai-news', ans(['1aaaaaa']), msg(text), null, 'Keep at most 8 posts').problems, []);
  assert.deepStrictEqual(content.gradeContent('ai-news', ans(['1aaaaaa', '1bbbbbb']), msg(text), null, 'at most 8 bullets').problems, []);
  assert.ok(content.gradeContent('ai-news', ans(['1cccccc', '1bbbbbb']), msg(text), null, 'at most 8 bullets').problems.length > 0);
});

test('source problems: 429, 5xx, timeouts and an empty Reddit feed are the source, not the model', () => {
  const m = (c, tool = 'mcp__web_search__fetch_url') => [{ role: 'tool', tool_name: tool, content: c }];
  assert.ok(content.sourceProblem(m('{"result": "Could not fetch https://www.reddit.com/r/x/top/.rss: HTTP 429 Too Many Requests"}')));
  assert.ok(content.sourceProblem(m('{"result": "# feed\\nURL: https://www.reddit.com/r/x/top/.rss?t=day\\n\\n"}')));
  assert.strictEqual(content.sourceProblem(m('{"result": "Could not fetch https://x.test/a: HTTP 404"}')), null);
  assert.strictEqual(content.sourceProblem(m('{"result": "- [a](https://www.reddit.com/r/x/comments/1a/a/) (2026-11-02T00:00:00+00:00)"}')), null);
});

test('infra signals: connection errors, a swapped model and a down MCP count; context overflow and bad tool JSON do not', () => {
  const logs = (errors = [], wrong = []) => ({ errors, wrong_model: wrong });
  const base = { logs: logs(), stderr: '', messages: [], exit: 0, timedOut: false, sid: 's', modelAfter: { status: 'loaded' }, model: 'm' };
  assert.deepStrictEqual(T.infraSignals(base), []);
  assert.ok(T.infraSignals({ ...base, modelAfter: { status: 'unloaded' } }).length);
  assert.ok(T.infraSignals({ ...base, logs: logs(['x ERROR APIConnectionError: Connection error.']) }).length);
  assert.ok(T.infraSignals({ ...base, logs: logs([], ['other-model']) }).length);
  assert.ok(T.infraSignals({ ...base, sid: null, exit: 1, stderr: 'Traceback' }).length);
  assert.deepStrictEqual(T.infraSignals({ ...base, logs: logs(['HTTP 400: request (102282 tokens) exceeds the available context size']) }), []);
  assert.deepStrictEqual(T.infraSignals({ ...base, logs: logs(['HTTP 500: Failed to parse tool call arguments as JSON']) }), []);
  const down = [{ role: 'tool', tool_name: 'mcp__wger__list_log_items', content: '{"error": "Tool execution failed: ConnectError: All connection attempts failed"}' }];
  assert.ok(T.infraSignals({ ...base, messages: down }).length);
});

test('infra and skipped rows have no score and are left out of the aggregates', () => {
  const row = (status, extra = {}) => ({ benchmark: 'hermes', model: 'm', case_id: extra.id || status, group: 'g', kind: 'chat', repeat: 1, status, duration_s: 1, checks: [{ name: 'completed', category: 'completed', pass: true }], failure_types: [], leftovers: [], tokens_in: 0, tokens_out: 0, api_calls: 0, tool_calls: 0, ...extra });
  assert.strictEqual(scoreRow(row('infra')), null);
  assert.strictEqual(scoreRow(row('skipped')), null);
  assert.strictEqual(scoreRow(row('error')), 0);
  const run2 = { run_dir: '/x/r', models: [], benchmarks: [{ name: 'hermes', results: [row('pass', { id: 'a' }), row('infra', { id: 'b' }), row('error', { id: 'c' })] }] };
  const a = aggregate(run2)[0];
  assert.strictEqual(a.cases, 2);
  assert.strictEqual(a.infra_cases, 1);
  assert.strictEqual(a.score, 50);
});

test('wgerMealLogged: an item attached to a sandbox-faked meal is not a model failure', async () => {
  const hooks = require('../benchmarks/hermes/hooks');
  const item = { id: 'item-1', datetime: '2027-01-15T13:00:00+02:00', meal: null, amount: '150.00', ingredient: 1 };
  const wger = { call: async () => ({ result: [item] }) };
  const before = { test: [], today: [], todayDate: '2027-01-15' };
  const intercepted = [
    { tool: 'mcp__wger__create_meal', fake: true, args: { name: 'Lunch' }, result: { id: 'meal-fake-1' } },
    { tool: 'mcp__wger__update_log_item', fake: false, args: { log_item_id: 'item-1', meal_id: 'meal-fake-1' } },
  ];
  const ok = await hooks.verify.wgerMealLogged({ wger }, before, { intercepted }, {});
  assert.strictEqual(ok.checks[0].pass, true);
  const bad = await hooks.verify.wgerMealLogged({ wger }, before, { intercepted: [] }, {});
  assert.strictEqual(bad.checks[0].pass, false);
});

test('preset sampling: the sandbox script removes temperature/presence_penalty from extra_body only', (t) => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  if (spawnSync('python3', ['-c', 'import yaml']).status !== 0) return t.skip('python3 with PyYAML not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-'));
  const f = path.join(dir, 'config.yaml');
  fs.writeFileSync(f, 'custom_providers:\n- name: x\n  extra_body:\n    temperature: 0.6\n    presence_penalty: 0\n    id_slot: 0\nauxiliary:\n  temperature: 0.2\n');
  const r = spawnSync('python3', ['-c', hermes.PRESET_SAMPLING_PY, f], { encoding: 'utf8' });
  assert.match(r.stdout, /removed 2/);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(!/presence_penalty/.test(out) && /id_slot: 0/.test(out) && /temperature: 0.2/.test(out) && !/temperature: 0.6/.test(out));
});
