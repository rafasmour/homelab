'use strict';
// Shared helpers for the Hermes benchmark: dates, check(), and read-only snapshots of the
// MCP-backed data (Nextcloud, wger, Firefly) used by the case hooks and the run cleanup.

const TEST_DATE = '2027-01-15';
const TZ = 'Europe/Athens';

// ---------------------------------------------------------------- helpers
const athensParts = (d) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
};
const todayAthens = () => athensParts(new Date()).date;
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const parseDate = (s) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
// Accent-, case- and final-sigma-insensitive (Greek "Λογιστής" and "ΛΟΓΙΣΤΗΣ" fold to the same string).
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
const check = (name, pass, reason = '') => ({ name, pass, reason });
const asList = (x, key) => (Array.isArray(x) ? x : (x && Array.isArray(x[key]) ? x[key] : []));

// ---------------------------------------------------------------- nextcloud snapshots
async function ncSnapshot(nc) {
  const todosRaw = await nc.call('nc_calendar_search_todos', {});
  const todos = asList(todosRaw, 'todos').map((t) => ({ uid: t.uid, calendar: t.calendar_name, summary: t.summary, due: t.due, dtstart: t.dtstart, status: t.status }));
  const events = [];
  const windows = [[addDays(TEST_DATE, -2), addDays(TEST_DATE, 2)], [addDays(todayAthens(), -1), addDays(todayAthens(), 2)]];
  for (const [start, end] of windows) {
    const r = await nc.call('nc_calendar_list_events', { start_date: start, end_date: end, search_all_calendars: true, limit: 500 });
    for (const e of asList(r, 'events')) if (!events.some((x) => x.uid === e.uid && x.calendar === e.calendar_name)) events.push({ uid: e.uid, calendar: e.calendar_name, summary: e.summary, start: e.start, end: e.end, all_day: e.all_day });
  }
  return { todos, events };
}

function ncDiff(before, after) {
  const key = (x) => `${x.calendar}|${x.uid}`;
  const b1 = new Set(before.todos.map(key));
  const b2 = new Set(before.events.map(key));
  return { todos: after.todos.filter((t) => !b1.has(key(t))), events: after.events.filter((e) => !b2.has(key(e))) };
}

/** Delete new nextcloud items that the benchmark created (test date or case keywords). */
async function ncCleanup(nc, before, keywords) {
  const leftovers = [];
  const deleted = [];
  let after;
  try { after = await ncSnapshot(nc); } catch (e) { return { leftovers: [`nextcloud snapshot failed: ${e.message}`], deleted }; }
  const diff = ncDiff(before, after);
  const ours = (summary, dateStr) => {
    const d = parseDate(dateStr);
    return (d && athensParts(d).date === TEST_DATE) || keywords.some((k) => fold(summary).includes(k));
  };
  for (const t of diff.todos) {
    if (!ours(t.summary, t.due || t.dtstart)) { leftovers.push(`unrecognized new to-do "${t.summary}" on ${t.calendar} (not deleted)`); continue; }
    try { await nc.call('nc_calendar_delete_todo', { calendar_name: t.calendar, todo_uid: t.uid }); deleted.push(`todo ${t.calendar}/${t.summary}`); } catch (e) { leftovers.push(`to-do "${t.summary}" on ${t.calendar}: delete failed: ${e.message}`); }
  }
  for (const e of diff.events) {
    if (!ours(e.summary, e.start)) { leftovers.push(`unrecognized new event "${e.summary}" on ${e.calendar} (not deleted)`); continue; }
    try { await nc.call('nc_calendar_delete_event', { calendar_name: e.calendar, event_uid: e.uid }); deleted.push(`event ${e.calendar}/${e.summary}`); } catch (err) { leftovers.push(`event "${e.summary}" on ${e.calendar}: delete failed: ${err.message}`); }
  }
  // Verify nothing new remains.
  try {
    const rest = ncDiff(before, await ncSnapshot(nc));
    for (const t of rest.todos) if (!leftovers.some((l) => l.includes(t.summary))) leftovers.push(`to-do "${t.summary}" on ${t.calendar} still present`);
    for (const e of rest.events) if (!leftovers.some((l) => l.includes(e.summary))) leftovers.push(`event "${e.summary}" on ${e.calendar} still present`);
  } catch (e) { leftovers.push(`nextcloud re-check failed: ${e.message}`); }
  return { leftovers, deleted };
}

// ---------------------------------------------------------------- wger snapshots
async function wgerItems(wger, when) {
  return asList(await wger.call('list_log_items', { when, limit: 500 }), 'result');
}

// ---------------------------------------------------------------- firefly snapshots
async function fireflyBills(ff) {
  const r = await ff.call('list_bill', { limit: 50 });
  return asList(r, 'data').map((b) => {
    const a = b.attributes || {};
    return { id: b.id, name: a.name, amount_min: a.amount_min, amount_max: a.amount_max, date: a.date, repeat_freq: a.repeat_freq, active: a.active, skip: a.skip, updated_at: a.updated_at };
  });
}

async function fireflyTransactions(ff) {
  // Window covering recent real data, today and the test date; ids are compared before/after.
  const start = addDays(todayAthens(), -60);
  const end = addDays(TEST_DATE, 16);
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const r = await ff.call('list_transaction', { start, end, limit: 50, page });
    for (const t of asList(r, 'data')) {
      const a = (t.attributes && t.attributes.transactions && t.attributes.transactions[0]) || {};
      out.push({ id: String(t.id), description: a.description, date: a.date, amount: a.amount });
    }
    const pg = r && r.meta && r.meta.pagination;
    if (!pg || page >= pg.total_pages) break;
  }
  return out;
}


// ---------------------------------------------------------------- isolated Kanban board
// Every benchmark case runs with HERMES_KANBAN_DB pointing at this throw-away board, so a model that calls
// kanban_create never writes to the real board (whose dispatcher would start a real specialist run).
const KANBAN_DIR = '/tmp/bench-kanban';
const KANBAN_DB = `${KANBAN_DIR}/kanban.db`;
const KANBAN_PY = `
import json, sqlite3, os
db = ${JSON.stringify(KANBAN_DB)}
out = {"tasks": [], "links": []}
if os.path.exists(db):
    c = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=10)
    c.row_factory = sqlite3.Row
    out["tasks"] = [dict(r) for r in c.execute("select id, title, body, assignee, status from tasks")]
    out["links"] = [dict(r) for r in c.execute("select parent_id, child_id from task_links")]
print(json.dumps(out))
`;
/** Cards the model created on the isolated benchmark board during the current case. */
async function kanbanCards() {
  const { dockerExec } = require('../../lib/docker');
  const r = await dockerExec('hermes-api', ['/opt/hermes/.venv/bin/python3', '-'], { user: 'hermes', input: KANBAN_PY, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cannot read the benchmark Kanban board: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

const onTestDate = (s) => { const d = parseDate(s); return Boolean(d) && athensParts(d).date === TEST_DATE; };

module.exports = {
  TEST_DATE, TZ, athensParts, todayAthens, addDays, parseDate, fold, check, asList, onTestDate,
  ncSnapshot, ncDiff, ncCleanup, wgerItems, fireflyBills, fireflyTransactions,
  KANBAN_DIR, KANBAN_DB, kanbanCards,
};
