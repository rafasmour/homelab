'use strict';
// Shared helpers for the Hermes benchmark: dates, check(), and read-only snapshots of the
// MCP-backed data (Nextcloud, wger) used by the case hooks and the run cleanup.

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

/** UTC ("YYYY-MM-DDTHH:MM:SSZ") of an Athens wall-clock time on an Athens date, with that day's EET/EEST offset. */
const athensUtc = (ymd, hhmm) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  for (const off of [2, 3]) {
    const t = new Date(Date.UTC(y, m - 1, d, h - off, mi));
    const p = athensParts(t);
    if (p.date === ymd && p.time === hhmm) return t.toISOString().replace('.000Z', 'Z');
  }
  throw new Error(`${ymd} ${hhmm} does not exist in ${TZ}`);
};

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Greek accusative with its article ("την Πέμπτη", "το Σάββατο") and genitive months ("12 Νοεμβρίου").
const WEEKDAYS_EL = ['την Κυριακή', 'τη Δευτέρα', 'την Τρίτη', 'την Τετάρτη', 'την Πέμπτη', 'την Παρασκευή', 'το Σάββατο'];
const MONTHS_EL = ['Ιανουαρίου', 'Φεβρουαρίου', 'Μαρτίου', 'Απριλίου', 'Μαΐου', 'Ιουνίου', 'Ιουλίου', 'Αυγούστου', 'Σεπτεμβρίου', 'Οκτωβρίου', 'Νοεμβρίου', 'Δεκεμβρίου'];
/** "Thursday 12 November" / "την Πέμπτη 12 Νοεμβρίου" for an Athens date. */
const dateWords = (ymd, lang) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  const [wd, day, mon] = [d.getUTCDay(), d.getUTCDate(), d.getUTCMonth()];
  return lang === 'el' ? `${WEEKDAYS_EL[wd]} ${day} ${MONTHS_EL[mon]}` : `${WEEKDAYS_EN[wd]} ${day} ${MONTHS_EN[mon]}`;
};

/**
 * Template variables of the relative-date cases, from the Athens date and time at `now` (bound when a case starts, so
 * a run that crosses midnight still asks about the right days):
 *   D0..D7          Athens dates today .. today+7 (YYYY-MM-DD)
 *   D4_EL, D4_EN    today+4 in words ("την Πέμπτη 12 Νοεμβρίου", "Thursday 12 November")
 *   LATER/LATER_END a whole hour 2 h ahead (at most 22:00) and one hour after it, HH:MM
 * plus {{UTC:<date var>T<HH:MM or time var>}} (see cases.js template()).
 */
const relativeVars = (now = new Date()) => {
  const { date, time } = athensParts(now);
  const vars = { TEST_DATE };
  for (let i = 0; i <= 7; i++) vars[`D${i}`] = addDays(date, i);
  vars.D4_EL = dateWords(vars.D4, 'el');
  vars.D4_EN = dateWords(vars.D4, 'en');
  const start = Math.min(Number(time.slice(0, 2)) + 2, 22);
  vars.LATER = `${String(start).padStart(2, '0')}:00`;
  vars.LATER_END = `${String(start + 1).padStart(2, '0')}:00`;
  vars.NOW = time;
  return vars;
};

// ---------------------------------------------------------------- nextcloud snapshots
async function ncSnapshot(nc) {
  const todosRaw = await nc.call('nc_calendar_search_todos', {});
  const todos = asList(todosRaw, 'todos').map((t) => ({ uid: t.uid, calendar: t.calendar_name, summary: t.summary, due: t.due, dtstart: t.dtstart, status: t.status }));
  const events = [];
  // Today's window reaches today+8: the relative-date cases write up to today+4 (and a wrong answer may land later).
  const windows = [[addDays(TEST_DATE, -2), addDays(TEST_DATE, 2)], [addDays(todayAthens(), -1), addDays(todayAthens(), 8)]];
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
  const r = await dockerExec('hermes', ['/opt/hermes/.venv/bin/python3', '-'], { user: 'hermes', input: KANBAN_PY, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`cannot read the benchmark Kanban board: ${r.stderr.slice(0, 200)}`);
  return JSON.parse(r.stdout);
}

const onTestDate = (s) => { const d = parseDate(s); return Boolean(d) && athensParts(d).date === TEST_DATE; };

module.exports = {
  TEST_DATE, TZ, athensParts, todayAthens, addDays, parseDate, fold, check, asList, onTestDate,
  athensUtc, dateWords, relativeVars,
  ncSnapshot, ncDiff, ncCleanup, wgerItems,
  KANBAN_DIR, KANBAN_DB, kanbanCards,
};
