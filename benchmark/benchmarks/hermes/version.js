'use strict';
// Hermes benchmark version (see lib/version.js and README "Benchmark versions").
// Bump BENCHMARK_VERSION (and add a CHANGELOG entry, and a row in the README table) whenever what is measured changes:
// the case set, a case's prompt or checks, the verifiers/scoring, or the Hermes setup under test (SOUL, plugins, hooks).
// The fingerprint below hashes tasks/*.md, the case/check/verifier code and the scoring code, so an un-bumped change is visible.
const path = require('node:path');
const { filesIn } = require('../../lib/version');

const BENCHMARK_VERSION = '3.3.0';

const CHANGELOG = [
  { version: '1.0.0', date: '2026-10-24', summary: 'First release: 13 cases (8 cron, 5 chat) on the Hermes profiles.' },
  { version: '1.1.0', date: '2026-10-28', summary: 'cron-llamacpp-rocm added: 14 cases. Runs before it use the 13-case set.' },
  { version: '2.0.0', date: '2026-11-03', summary: 'ai-assistant group (9 spoken-style chat cases) added; with --with-optin the set is 17 cases = 4 cron + 4 chat + 9 assistant (web cases and GPU watch left the default set).' },
  { version: '3.0.0', date: '2026-11-06', summary: 'New setup: the assistant consults specialist agents with ask_agent, no sentence limit, reply language not enforced by the style check.' },
  { version: '3.1.0', date: '2026-11-06', summary: 'ai-assistant slimmed Kanban toolset (delegate plugin) and SOUL fixes.' },
  { version: '3.2.0', date: '2026-11-06', summary: 'Clock hooks, last SOUL fixes, no language check; optional preset-sampling switch (HERMES_BENCH_PRESET_SAMPLING, used for the LFM3 runs).' },
  { version: '3.3.0', date: '2026-11-07', summary: 'Reminder argument repair (clock hook), ai-assistant reply cleaner (spoken_reply).' },
];

/** Version of a stored run without one (run folder name `YYYY-MM-DD_HH-MM[-n]`, local time). First matching threshold from the end. */
const BACKFILL = [
  ['2026-11-06_18-19', '3.2.0'],
  ['2026-11-06_16-12', '3.1.0'],
  ['2026-11-06_10-33', '3.0.0'],
  ['2026-11-03_00-00', '2.0.0'],
  ['2026-10-28_00-00', '1.1.0'],
  ['2026-10-24_00-00', '1.0.0'],
];
const backfill = (runName) => { const hit = BACKFILL.find(([from]) => runName >= from); return hit ? hit[1] : null; };

const fingerprintFiles = () => [
  ...filesIn(__dirname, ['.js']).filter((f) => !/[\\/](index|version)\.js$/.test(f)),
  ...filesIn(path.join(__dirname, 'tasks'), ['.md']),
];

module.exports = { version: BENCHMARK_VERSION, BENCHMARK_VERSION, changelog: CHANGELOG, fingerprintFiles, backfill };
