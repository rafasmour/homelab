'use strict';
// Named hooks that task files (tasks/<case>.md) reference by name in their front matter:
//   setup: <name>    setup(clients, params)                 -> `before` state (snapshot)
//   verify: <name>   verify(clients, before, run, params)   -> { checks, notes?, leftovers? }
//   cleanup: <name>  cleanup(clients, before, params)       -> { leftovers, deleted }
// clients = { wger, nextcloud, firefly } MCP clients; run = { answer, exit, timedOut, logs, calls, toolText };
// params = the task's `params` JSON with {{TEST_DATE}} expanded. A verify hook returns checks named
// `correct` (category correctness) or `read_only`; generic checks (completed, leaks, tools) run anyway.
// Add a hook here, then reference it from a task file; no other code changes are needed.
const {
  TEST_DATE, athensParts, todayAthens, parseDate, fold, check,
  ncSnapshot, ncDiff, ncCleanup, wgerItems, fireflyBills,
} = require('./helpers');

const near = (dateStr, iso, ms = 60_000) => { const d = parseDate(dateStr); return Boolean(d) && Math.abs(d.getTime() - Date.parse(iso)) <= ms; };

// ---------------------------------------------------------------- setup
const setup = {
  /** wger log items on the test date and today (to catch entries logged on the wrong day). */
  async wgerTestDateAndToday({ wger }) {
    return { test: await wgerItems(wger, TEST_DATE), today: await wgerItems(wger, todayAthens()), todayDate: todayAthens() };
  },
  /** Nextcloud to-dos and events around the test date and today. */
  nextcloudSnapshot: ({ nextcloud }) => ncSnapshot(nextcloud),
  /** Firefly bills (id, name, amounts, dates, flags). */
  fireflyBillsSnapshot: ({ firefly }) => fireflyBills(firefly),
};

// ---------------------------------------------------------------- verify
const verify = {
  /**
   * One meal logged in wger on the test date at params.time (Athens, ± tolerance_min), with a meal set,
   * total grams in [grams_min, grams_max], no duplicate entries and nothing logged today instead.
   */
  async wgerMealLogged({ wger }, before, _run, p = {}) {
    const time = p.time || '13:00';
    const tol = p.tolerance_min ?? 15;
    const checks = [];
    const notes = [];
    const known = new Set(before.test.map((x) => String(x.id)));
    const items = (await wgerItems(wger, TEST_DATE)).filter((x) => !known.has(String(x.id)));
    const knownToday = new Set(before.today.map((x) => String(x.id)));
    const wrongDay = before.todayDate !== TEST_DATE ? (await wgerItems(wger, before.todayDate)).filter((x) => !knownToday.has(String(x.id))) : [];
    if (!items.length) {
      checks.push(check('correct', false, wrongDay.length ? `nothing logged on ${TEST_DATE}; ${wrongDay.length} item(s) logged on ${before.todayDate} instead` : `no wger log item on ${TEST_DATE}`));
      return { checks, notes };
    }
    const [eh, em] = time.split(':').map(Number);
    const problems = [];
    for (const it of items) {
      const d = parseDate(it.datetime);
      const t = d ? athensParts(d) : null;
      if (!t || t.date !== TEST_DATE) problems.push(`item ${it.id} date ${it.datetime}`);
      else {
        const [h, m] = t.time.split(':').map(Number);
        if (Math.abs(h * 60 + m - (eh * 60 + em)) > tol) problems.push(`item ${it.id} at ${t.time} Athens (${it.datetime}), expected ${time}`);
      }
      if (!it.meal) problems.push(`item ${it.id} has no meal`);
    }
    const grams = items.reduce((a, it) => a + Number(it.amount || 0), 0);
    const gMin = p.grams_min ?? 120;
    const gMax = p.grams_max ?? 180;
    if (grams < gMin || grams > gMax) problems.push(`total ${grams} g, expected about ${p.grams_expected ?? Math.round((gMin + gMax) / 2)} g`);
    const sig = items.map((it) => `${it.ingredient}|${Number(it.amount)}`);
    const dups = sig.filter((s, i) => sig.indexOf(s) !== i);
    if (dups.length) problems.push(`duplicate entries (${dups.length})`);
    if (wrongDay.length) problems.push(`${wrongDay.length} extra item(s) logged on ${before.todayDate}`);
    notes.push(`${items.length} item(s), ${grams} g`);
    checks.push(check('correct', problems.length === 0, problems.join('; ') || `${items.length} item(s), ${grams} g at ${time} Athens`));
    return { checks, notes };
  },

  /** Exactly one new VTODO (no VEVENT) on params.calendar, due at params.due_utc, summary matching params.summary_pattern. */
  async nextcloudTodoCreated({ nextcloud }, before, _run, p = {}) {
    const diff = ncDiff(before, await ncSnapshot(nextcloud));
    const problems = [];
    if (diff.events.length) problems.push(`created ${diff.events.length} VEVENT(s) instead of / besides a to-do: ${diff.events.map((e) => `${e.calendar}:${e.summary}`).join(', ')}`);
    if (!diff.todos.length) problems.push('no VTODO created');
    if (diff.todos.length > 1) problems.push(`${diff.todos.length} to-dos created (duplicates)`);
    for (const t of diff.todos) {
      if (p.calendar && t.calendar !== p.calendar) problems.push(`to-do on calendar "${t.calendar}", expected ${p.calendar}`);
      if (p.due_utc) {
        if (!parseDate(t.due)) problems.push('to-do has no due date');
        else if (!near(t.due, p.due_utc)) problems.push(`due ${t.due}, expected ${p.due_utc}${p.due_label ? ` (${p.due_label})` : ''}`);
      }
      if (p.summary_pattern && !new RegExp(p.summary_pattern, 'i').test(t.summary || '')) problems.push(`summary "${t.summary}" does not mention the task`);
    }
    return { checks: [check('correct', problems.length === 0, problems.join('; ') || p.ok || 'VTODO created as expected')] };
  },

  /** Exactly one new VEVENT (no VTODO) on params.calendar from start_utc to end_utc, summary matching summary_pattern. */
  async nextcloudEventCreated({ nextcloud }, before, _run, p = {}) {
    const diff = ncDiff(before, await ncSnapshot(nextcloud));
    const problems = [];
    if (diff.todos.length) problems.push(`created ${diff.todos.length} to-do(s) instead of / besides an event`);
    if (!diff.events.length) problems.push('no VEVENT created');
    if (diff.events.length > 1) problems.push(`${diff.events.length} events created (duplicates)`);
    for (const e of diff.events) {
      if (p.calendar && e.calendar !== p.calendar) problems.push(`event on calendar "${e.calendar}", expected ${p.calendar}`);
      if (p.start_utc && !near(e.start, p.start_utc)) problems.push(`start ${e.start}, expected ${p.start_utc}`);
      if (p.end_utc && !near(e.end, p.end_utc)) problems.push(`end ${e.end}, expected ${p.end_utc}`);
      if (p.summary_pattern && !new RegExp(p.summary_pattern, 'i').test(e.summary || '')) problems.push(`summary "${e.summary}" does not mention ${p.summary_label || 'the event'}`);
    }
    return { checks: [check('correct', problems.length === 0, problems.join('; ') || p.ok || 'VEVENT created as expected')] };
  },

  /** The answer names every bill in params.expected (accent-insensitive) and no Firefly bill changed (read_only). */
  async fireflyBillsListedReadOnly({ firefly }, before, { answer }, p = {}) {
    const checks = [];
    const expected = p.expected || [];
    const a = fold(answer);
    const missing = expected.filter((n) => !a.includes(fold(n)));
    checks.push(check('correct', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `all ${expected.length} bills listed`));
    const after = await fireflyBills(firefly);
    const changes = [];
    for (const b of after) {
      const o = before.find((x) => x.id === b.id);
      if (!o) changes.push(`new bill ${b.id} "${b.name}"`);
      else if (JSON.stringify(o) !== JSON.stringify(b)) changes.push(`bill ${b.id} "${b.name}" changed`);
    }
    for (const o of before) if (!after.some((b) => b.id === o.id)) changes.push(`bill ${o.id} "${o.name}" deleted`);
    checks.push(check('read_only', changes.length === 0, changes.join('; ') || 'bills unchanged'));
    return { checks, leftovers: changes.map((c) => `firefly: ${c} (not reverted automatically)`) };
  },

  /**
   * Short free-text answer: every params.must_mention [{pattern, label}] matches, no params.must_not matches, at most max_sentences
   * sentences (links ignored) and at most max_chars characters.
   */
  async shortAnswer(_clients, _before, { answer }, p = {}) {
    const sentences = answer.replace(/https?:\/\/\S+/g, '').split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 3);
    const problems = [];
    for (const m of p.must_mention || []) if (!new RegExp(m.pattern, 'i').test(answer)) problems.push(`does not mention ${m.label || m.pattern}`);
    for (const m of p.must_not || []) if (new RegExp(m.pattern, 'i').test(answer)) problems.push(`${m.label || m.pattern}`);
    if (p.max_sentences && sentences.length > p.max_sentences) problems.push(`${sentences.length} sentences, asked for ${p.asked || p.max_sentences}`);
    if (p.max_chars && answer.length > p.max_chars) problems.push(`${answer.length} chars, asked for ${p.asked_chars || `at most ${p.max_chars}`}`);
    return { checks: [check('correct', problems.length === 0, problems.join('; ') || `${sentences.length} sentence(s)`)] };
  },
};

// ---------------------------------------------------------------- cleanup
const cleanup = {
  /** Delete wger items created on the test date; report (never delete) items created today. */
  async wgerTestDate({ wger }, before) {
    const leftovers = [];
    const deleted = [];
    const known = new Set(before.test.map((x) => String(x.id)));
    try {
      for (const it of (await wgerItems(wger, TEST_DATE)).filter((x) => !known.has(String(x.id)))) {
        try { await wger.call('delete_log_item', { log_item_id: String(it.id) }); deleted.push(`wger log item ${it.id}`); } catch (e) { leftovers.push(`wger item ${it.id}: delete failed: ${e.message}`); }
      }
      const rest = (await wgerItems(wger, TEST_DATE)).filter((x) => !known.has(String(x.id)));
      for (const it of rest) leftovers.push(`wger item ${it.id} on ${TEST_DATE} still present`);
      if (before.todayDate !== TEST_DATE) {
        const knownToday = new Set(before.today.map((x) => String(x.id)));
        for (const it of (await wgerItems(wger, before.todayDate)).filter((x) => !knownToday.has(String(x.id)))) {
          leftovers.push(`wger item ${it.id} logged on ${before.todayDate} (${it.amount} g) during the case: not deleted automatically (could be real data)`);
        }
      }
    } catch (e) { leftovers.push(`wger cleanup failed: ${e.message}`); }
    return { leftovers, deleted };
  },
  /** Delete new Nextcloud to-dos/events on the test date or whose summary contains one of params.keywords. */
  nextcloudNew: ({ nextcloud }, before, p = {}) => ncCleanup(nextcloud, before, (p.keywords || []).map((k) => fold(k))),
};

module.exports = { setup, verify, cleanup };
