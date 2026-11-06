'use strict';
// Hermes benchmark cases, defined as data in tasks/<case-key>.md (see README "Task files"):
// front matter (kind, profile, toolsets, hooks, params) followed by the exact prompt.
//   kind: cron      - former Hermes cron job: Hermes' cron wrapper is prepended, the profile's
//                     platform_toolsets.cron is used, checks: heading/[SILENT]/links/size/tools.
//                     `kanban: true` keeps the profile's kanban toolset (ai-assistant delegation cases); every case
//                     runs against a throw-away board (HERMES_KANBAN_DB, see hermes-benchmark.js).
//   web: true       - the job depends on the web search/extract tools: excluded from the default selection and from
//                     --profiles; runs with --web or when named in --cases (see README "Web cases").
//   kind: chat|...  - any other kind runs as an interactive request with optional setup/verify/
//                     cleanup hooks (hooks.js) and the profile's CLI toolsets.
// Chat cases write on the test date 2027-01-15 through the real MCP servers, are verified through
// those servers, and are always cleaned up afterwards.
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const hooks = require('./hooks');

const { TEST_DATE, todayAthens, fold, check, asList, wgerItems, ncSnapshot, ncDiff, fireflyBills, fireflyTransactions, onTestDate } = H;
const TASKS_DIR = path.join(__dirname, 'tasks');

/** Replace {{TEST_DATE}} (and other {{NAME}} values) in strings, recursively. */
function template(v, vars) {
  if (typeof v === 'string') return v.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  if (Array.isArray(v)) return v.map((x) => template(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, template(x, vars)]));
  return v;
}

function parseTask(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    let v = kv[1] === 'params' ? kv[2] : kv[2].replace(/\s+#.*$/, '');
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    meta[kv[1]] = v === 'true' ? true : v === 'false' ? false : v;
  }
  const vars = { TEST_DATE };
  const id = meta.case || path.basename(file, '.md');
  const kind = meta.kind || (id.startsWith('cron-') ? 'cron' : 'chat');
  if (!meta.profile) throw new Error(`${file}: front matter needs profile`);
  let params = {};
  if (meta.params) { try { params = JSON.parse(meta.params); } catch (e) { throw new Error(`${file}: params is not JSON: ${e.message}`); } }
  params = template(params, vars);
  // Like the shell's $(cat <<EOF ...) the prompt has no trailing newline.
  const prompt = template(m[2].replace(/\n+$/, ''), vars);
  const task = {
    id, kind, profile: meta.profile, order: Number(meta.order) || 999, file: path.basename(file), prompt, params,
    research: meta.research === true, toolsets: meta.toolsets || (kind === 'cron' ? 'cron' : 'cli'),
    optin: meta.optin === true, web: meta.web === true, kanban: meta.kanban === true, writeTools: meta.write_tools === true, needs: String(meta.needs || '').split(',').map((x) => x.trim()).filter(Boolean),
    job: meta.job || id.replace(/^cron-/, ''), heading: meta.heading || null, schedule: meta.schedule || null,
  };
  if (kind === 'cron' && !task.heading) throw new Error(`${file}: a cron task needs heading`);
  for (const h of ['setup', 'verify', 'cleanup']) {
    if (!meta[h]) continue;
    const fn = hooks[h][meta[h]];
    if (!fn) throw new Error(`${file}: unknown ${h} hook "${meta[h]}" (see hooks.js)`);
    task[`${h}Hook`] = meta[h];
    if (h === 'setup') task.setup = (clients) => fn(clients, params);
    if (h === 'verify') task.verify = (clients, before, run) => fn(clients, before, run, params);
    if (h === 'cleanup') task.cleanup = (clients, before) => fn(clients, before, params);
  }
  return task;
}

const TASKS = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.md')).map((f) => parseTask(path.join(TASKS_DIR, f)))
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
const CRON_JOBS = TASKS.filter((t) => t.kind === 'cron');
const CHAT_CASES = TASKS.filter((t) => t.kind !== 'cron');

// ---------------------------------------------------------------- run-level snapshot / cleanup
/** Snapshot taken once before the run: what already exists on the test date and in Firefly. */
async function runSnapshot(c) {
  const snap = { errors: [] };
  const tryIt = async (k, fn) => { try { snap[k] = await fn(); } catch (e) { snap.errors.push(`${k}: ${e.message}`); } };
  await tryIt('wger', () => wgerItems(c.wger, TEST_DATE));
  await tryIt('nextcloud', () => ncSnapshot(c.nextcloud));
  await tryIt('bills', () => fireflyBills(c.firefly));
  await tryIt('transactions', () => fireflyTransactions(c.firefly));
  return snap;
}

/** Remove everything the run created on the test date and in Firefly; verify counts afterwards. */
async function runCleanup(c, snap) {
  const removed = [];
  const leftovers = [];
  const verification = {};
  // wger: test-date items that did not exist before the run.
  if (snap.wger) {
    const known = new Set(snap.wger.map((x) => String(x.id)));
    try {
      for (const it of await wgerItems(c.wger, TEST_DATE)) {
        if (known.has(String(it.id))) { leftovers.push(`wger item ${it.id} existed before the run (kept)`); continue; }
        try { await c.wger.call('delete_log_item', { log_item_id: String(it.id) }); removed.push(`wger log item ${it.id} (${it.amount} g)`); } catch (e) { leftovers.push(`wger item ${it.id}: ${e.message}`); }
      }
    } catch (e) { leftovers.push(`wger cleanup: ${e.message}`); }
  } else leftovers.push('wger: no start snapshot, nothing deleted');
  // Nextcloud: new to-dos/events dated on the test date (any calendar).
  if (snap.nextcloud) {
    try {
      const diff = ncDiff(snap.nextcloud, await ncSnapshot(c.nextcloud));
      for (const t of diff.todos) {
        if (!onTestDate(t.due) && !onTestDate(t.dtstart)) { leftovers.push(`new to-do "${t.summary}" on ${t.calendar} not on ${TEST_DATE} (kept, check manually)`); continue; }
        try { await c.nextcloud.call('nc_calendar_delete_todo', { calendar_name: t.calendar, todo_uid: t.uid }); removed.push(`to-do ${t.calendar}: ${t.summary}`); } catch (e) { leftovers.push(`to-do ${t.summary}: ${e.message}`); }
      }
      for (const e of diff.events) {
        if (!onTestDate(e.start)) { leftovers.push(`new event "${e.summary}" on ${e.calendar} not on ${TEST_DATE} (kept, check manually)`); continue; }
        try { await c.nextcloud.call('nc_calendar_delete_event', { calendar_name: e.calendar, event_uid: e.uid }); removed.push(`event ${e.calendar}: ${e.summary}`); } catch (err) { leftovers.push(`event ${e.summary}: ${err.message}`); }
      }
    } catch (e) { leftovers.push(`nextcloud cleanup: ${e.message}`); }
  } else leftovers.push('nextcloud: no start snapshot, nothing deleted');
  // Firefly: bills/transactions created during the run.
  if (snap.bills) {
    try {
      const known = new Set(snap.bills.map((b) => b.id));
      for (const b of await fireflyBills(c.firefly)) {
        if (known.has(b.id)) {
          const o = snap.bills.find((x) => x.id === b.id);
          if (JSON.stringify(o) !== JSON.stringify(b)) leftovers.push(`firefly bill ${b.id} "${b.name}" changed during the run (not reverted)`);
          continue;
        }
        try { await c.firefly.call('delete_bill', { id: b.id }); removed.push(`firefly bill ${b.id} "${b.name}"`); } catch (e) { leftovers.push(`firefly bill ${b.id}: ${e.message}`); }
      }
    } catch (e) { leftovers.push(`firefly bills cleanup: ${e.message}`); }
  }
  if (snap.transactions) {
    try {
      const known = new Set(snap.transactions.map((t) => t.id));
      for (const t of await fireflyTransactions(c.firefly)) {
        if (known.has(t.id)) continue;
        try { await c.firefly.call('delete_transaction', { id: t.id }); removed.push(`firefly transaction ${t.id} "${t.description}" ${t.date}`); } catch (e) { leftovers.push(`firefly transaction ${t.id}: ${e.message}`); }
      }
    } catch (e) { leftovers.push(`firefly transactions cleanup: ${e.message}`); }
  }
  // Final verification search on the test date.
  try { verification.wger_items_on_test_date = (await wgerItems(c.wger, TEST_DATE)).length; } catch (e) { verification.wger_items_on_test_date = `error: ${e.message}`; }
  try {
    const s = await ncSnapshot(c.nextcloud);
    verification.nextcloud_todos_on_test_date = s.todos.filter((t) => onTestDate(t.due) || onTestDate(t.dtstart)).length;
    verification.nextcloud_events_on_test_date = s.events.filter((e) => onTestDate(e.start)).length;
  } catch (e) { verification.nextcloud_on_test_date = `error: ${e.message}`; }
  if (snap.recovered) removed.push(snap.recovered);
  if (snap.errors.length) leftovers.push(...snap.errors.map((e) => `start snapshot failed: ${e}`));
  return { removed, leftovers, verification };
}

// ---------------------------------------------------------------- cron correctness extras
/** Extra expectations computed from live data (read-only MCP calls). */
async function cronExpectation(job, clients) {
  const today = todayAthens();
  if (job === 'payments-unpaid' && clients.firefly) {
    const r = await clients.firefly.call('list_bill', { start: `${today.slice(0, 8)}01`, end: today, limit: 50 });
    const unpaid = [];
    for (const b of asList(r, 'data')) {
      const a = b.attributes || {};
      if (!a.active) continue;
      const pay = (a.pay_dates || []).map((d) => String(d.date || d).slice(0, 10)).filter((d) => d <= today);
      const paid = (a.paid_dates || []).map((d) => String(d.date || d).slice(0, 10));
      if (pay.some((d) => !paid.includes(d))) unpaid.push(a.name);
    }
    return { expectSilent: unpaid.length === 0, mustMention: unpaid, why: unpaid.length ? `unpaid: ${unpaid.join(', ')}` : 'no unpaid bills due' };
  }
  if (job === 'calories-report' && clients.wger) {
    const s = await clients.wger.call('nutrition_summary', { when: today });
    const kcal = Number((s && s.totals && s.totals.kcal) || 0);
    const items = (s && s.items) || [];
    return { expectSilent: kcal === 0 && items.length === 0, kcal, why: `today ${Math.round(kcal)} kcal, ${items.length} item(s)` };
  }
  if (job === 'morning-digest' && clients.nextcloud) {
    const r = await clients.nextcloud.call('nc_calendar_search_todos', { status: 'NEEDS-ACTION' });
    const open = asList(r, 'todos').length;
    return { expectSilent: false, why: `${open} open to-do(s)`, mustNotSilent: open > 0 };
  }
  return null;
}

module.exports = { TEST_DATE, TASKS, CRON_JOBS, CHAT_CASES, cronExpectation, todayAthens, fold, check, runSnapshot, runCleanup, parseTask };
