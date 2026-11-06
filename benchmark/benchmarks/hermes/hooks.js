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
  ncSnapshot, ncDiff, ncCleanup, wgerItems, fireflyBills, kanbanCards,
} = require('./helpers');

const near = (dateStr, iso, ms = 60_000) => { const d = parseDate(dateStr); return Boolean(d) && Math.abs(d.getTime() - Date.parse(iso)) <= ms; };


// ---------------------------------------------------------------- assistant (ai-assistant) outcome checks

/** Problems of a spoken-style answer (ai-assistant persona): no Markdown/URLs/ids/emoji (the reply language is not checked). No sentence limit. */
function spokenProblems(answer, s = {}) {
  const problems = [];
  const a = String(answer || '');
  if (/\*\*|__|`|^\s*#{1,6}\s|^\s*[-*•]\s|^\s*\d+[.)]\s|\|.*\||\[[^\]]+\]\([^)]+\)/m.test(a)) problems.push('contains Markdown (bold, list, table, link or heading)');
  if (/https?:\/\//i.test(a)) problems.push('contains a URL');
  if (/\b\d{4}-\d{2}-\d{2}\b|\b\d{2}:\d{2}:\d{2}|\d{2}:\d{2}\s?Z\b|\bUTC\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(a)) problems.push('reads out an ISO date, UTC time or id');
  if (/\p{Extended_Pictographic}/u.test(a)) problems.push('contains an emoji');
  return problems;
}

const lastName = (n) => String(n || '').split('__').pop();
const inList = (v, exp) => !exp || [].concat(exp).map(fold).includes(fold(v));

/** Match each wanted item to a distinct actual one; returns problems (missing, mismatched, unexpected extras). */
function matchItems(kind, actual, wanted, test, describe) {
  const problems = [];
  const used = new Set();
  for (const w of wanted) {
    const hit = actual.findIndex((a, i) => !used.has(i) && test(a, w).length === 0);
    if (hit >= 0) { used.add(hit); continue; }
    const near = actual.findIndex((a, i) => !used.has(i) && (!w.summary_pattern || new RegExp(w.summary_pattern, 'i').test(describe(a))));
    problems.push(near >= 0 ? `${kind} "${describe(actual[near])}": ${test(actual[near], w).join(', ')}` : `no ${kind} for ${w.label || w.summary_pattern || w.assignee}`);
  }
  const extra = actual.filter((_, i) => !used.has(i));
  if (extra.length) problems.push(`${extra.length} unexpected ${kind}(s): ${extra.map(describe).join(' | ')}`);
  return problems;
}

/**
 * Problems of the wanted consults [{profile, request_patterns, label}] against the run's ask_agent calls
 * (args.profile, args.request); every wanted consult needs its own matching call. Empty list = all matched.
 */
function consultMismatches(calls, wanted) {
  const asks = (calls || []).filter((c) => lastName(c.name) === 'ask_agent').map((c) => {
    let a = c.args;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
    a = a || {};
    return { profile: String(a.profile || ''), request: String(a.request || '') };
  });
  const used = new Set();
  const problems = [];
  for (const w of wanted) {
    const test = (a) => inList(a.profile, w.profile) && (w.request_patterns || []).every((b) => new RegExp(b.pattern, 'i').test(fold(a.request)));
    const hit = asks.findIndex((a, i) => !used.has(i) && test(a));
    if (hit >= 0) { used.add(hit); continue; }
    const same = asks.find((a, i) => !used.has(i) && inList(a.profile, w.profile));
    problems.push(same
      ? `consult of ${same.profile} does not mention ${(w.request_patterns || []).filter((b) => !new RegExp(b.pattern, 'i').test(fold(same.request))).map((b) => b.label || b.pattern).join(', ')}`
      : `no ask_agent consult of ${[].concat(w.profile).join(' or ')}${w.label ? ` (${w.label})` : ''}`);
  }
  return problems;
}

/** Summaries (titles) of the items in the run's tool results (to-dos, events). */
function toolSummaries(toolText) {
  const out = [];
  for (const m of String(toolText || '').matchAll(/"summary\\?":\s*\\?"((?:[^"\\]|\\.)*?)\\?"/g)) {
    try { out.push(JSON.parse(`"${m[1]}"`)); } catch { out.push(m[1]); }
  }
  return [...new Set(out)];
}

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
  async wgerMealLogged({ wger }, before, run = {}, p = {}) {
    const time = p.time || '13:00';
    const tol = p.tolerance_min ?? 15;
    const checks = [];
    const notes = [];
    // The sandbox fakes create_meal (wger MCP has no delete_meal) and strips that fake meal id from the real
    // log call, so a correctly attached item has no meal in wger. Count it as attached when the model passed
    // a sandbox-faked meal id for that item (log_ingredient result id, or update_log_item log_item_id).
    const fakeMeals = new Set();
    const fakeAttached = new Set();
    const rec = Array.isArray(run.intercepted) ? run.intercepted : [];
    for (const x of rec) if (x.fake && /create_meal$/.test(x.tool || '') && x.result && x.result.id) fakeMeals.add(String(x.result.id));
    for (const x of rec) {
      const a = x.args || {};
      if (!a.meal_id || !fakeMeals.has(String(a.meal_id))) continue;
      if (/update_log_item$/.test(x.tool || '') && a.log_item_id) fakeAttached.add(String(a.log_item_id));
      if (/log_ingredient$/.test(x.tool || '')) {
        const m = String(typeof x.result === 'string' ? x.result : JSON.stringify(x.result || '')).match(/\\?"id\\?":\s*\\?"([0-9a-f-]{8,})/i);
        if (m) fakeAttached.add(m[1]);
      }
    }
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
      if (!it.meal && !fakeAttached.has(String(it.id))) problems.push(`item ${it.id} has no meal`);
      else if (!it.meal) notes.push(`item ${it.id} attached to sandbox-faked meal`);
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
      if ((p.calendars || p.calendar) && ![].concat(p.calendars || p.calendar).includes(t.calendar)) problems.push(`to-do on calendar "${t.calendar}", expected ${[].concat(p.calendars || p.calendar).join(' or ')}`);
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


  /**
   * ai-assistant outcome. Compares what the run created with the expectation (params), through the Nextcloud MCP
   * (to-dos, events: before/after snapshot) and the isolated benchmark Kanban board (cards):
   *   todos  [{summary_pattern, due_utc, calendars, label}]   exactly these to-dos (matched in any order)
   *   events [{summary_pattern, start_utc, end_utc, calendars, label}]
   *   cards  [{assignee, body_patterns: [{pattern, label}], label}]
   *   consults [{profile: string|[string], request_patterns: [{pattern, label}], label}]  ask_agent calls (args.profile, args.request)
   *   any_of ["cards", "consults"]  that part passes when the cards check OR the consults check passes (the notes say which)
   *   must_call [[tool suffix, ...], ...]  every group needs at least one call whose name ends with one of its entries
   *   max_calls  at most this many tool calls
   *   mention_from_results  the answer names at least one to-do/event title that a tool result contained
   *   spoken  {language}  -> separate `spoken_style` check (rules)
   * Anything not listed must not exist: an empty todos/events/cards list means "none may be created".
   */
  async assistantOutcome({ nextcloud }, before, run, p = {}) {
    const problems = [];
    const diff = ncDiff(before, await ncSnapshot(nextcloud));
    problems.push(...matchItems('to-do', diff.todos, p.todos || [], (t, w) => {
      const r = [];
      if (!inList(t.calendar, w.calendars || p.calendars)) r.push(`on list "${t.calendar}", expected ${[].concat(w.calendars || p.calendars).join(' or ')}`);
      if (w.due_utc && !near(t.due, w.due_utc)) r.push(`due ${t.due || 'none'}, expected ${w.due_utc}`);
      if (w.summary_pattern && !new RegExp(w.summary_pattern, 'i').test(t.summary || '')) r.push('summary does not match');
      return r;
    }, (t) => t.summary || ''));
    problems.push(...matchItems('event', diff.events, p.events || [], (e, w) => {
      const r = [];
      if (!inList(e.calendar, w.calendars || 'personal')) r.push(`on calendar "${e.calendar}", expected ${[].concat(w.calendars || 'personal').join(' or ')}`);
      if (w.start_utc && !near(e.start, w.start_utc)) r.push(`start ${e.start}, expected ${w.start_utc}`);
      if (w.end_utc && !near(e.end, w.end_utc)) r.push(`end ${e.end}, expected ${w.end_utc}`);
      if (w.summary_pattern && !new RegExp(w.summary_pattern, 'i').test(e.summary || '')) r.push('summary does not match');
      return r;
    }, (e) => e.summary || ''));
    const cardProblems = [];
    try {
      const board = await kanbanCards();
      cardProblems.push(...matchItems('Kanban card', board.tasks, p.cards || [], (c, w) => {
        const r = [];
        if (!inList(c.assignee, w.assignee)) r.push(`assigned to ${c.assignee}, expected ${[].concat(w.assignee).join(' or ')}`);
        const text = fold(`${c.title}\n${c.body || ''}`);
        for (const b of w.body_patterns || []) if (!new RegExp(b.pattern, 'i').test(text)) r.push(`card does not mention ${b.label || b.pattern}`);
        return r;
      }, (c) => `${c.assignee}: ${c.title}`));
    } catch (e) { cardProblems.push(`Kanban board unreadable: ${e.message}`); }
    const consultProblems = consultMismatches(run.calls, p.consults || []);
    const notes = [];
    if ((p.any_of || []).includes('cards') && (p.any_of || []).includes('consults')) {
      if (!cardProblems.length) notes.push('any_of: the Kanban card matched');
      else if (!consultProblems.length) notes.push(`any_of: the ask_agent consult matched (cards: ${cardProblems.join(' | ')})`);
      else problems.push(`neither the card nor the consult matched (cards: ${cardProblems.join(' | ')}; consults: ${consultProblems.join(' | ')})`);
    } else {
      problems.push(...cardProblems);
      problems.push(...consultProblems);
    }
    const names = (run.calls || []).map((c) => lastName(c.name));
    for (const group of p.must_call || []) if (!names.some((n) => group.some((g) => n === g || n.endsWith(g)))) problems.push(`no call to ${group.join(' / ')}`);
    if (p.max_calls != null && names.length > p.max_calls) problems.push(`${names.length} tool calls, at most ${p.max_calls} expected`);
    if (p.mention_from_results) {
      const titles = toolSummaries(run.toolText);
      const words = titles.flatMap((t) => fold(t).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
      const ans = fold(run.answer);
      if (words.length && !words.some((w) => ans.includes(w))) problems.push('answer names none of the items the tools returned');
    }
    const checks = [check('correct', problems.length === 0, problems.join('; ') || p.ok || 'outcome as expected')];
    if (p.spoken) {
      const sp = spokenProblems(run.answer, p.spoken);
      checks.push(check('spoken_style', sp.length === 0, sp.join('; ') || 'spoken style ok'));
    }
    return { checks, notes };
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
