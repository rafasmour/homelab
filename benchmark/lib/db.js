'use strict';
// SQLite store (node:sqlite, no npm dependency): the source of truth for every
// benchmark result. report.md, results.json and report.xlsx are generated from it.
//
// Default file: <app>/data/benchmark.db (host: benchmark/data/benchmark.db),
// overridable with BENCH_DB. Rollback-journal mode (not WAL) so that the UI
// container can open the file read-only from a read-only bind mount.
//
// Schema (see MIGRATIONS for the exact SQL):
//   runs             one row per run folder (name = reports/<name>)
//   benchmarks       benchmark modules (hermes, ...)
//   models           router model aliases + metadata parsed from router-config.ini
//   cases            benchmark_id + case_key (profile, kind, title)
//   case_results     one row per run x model x case x repeat (upsert key)
//   checks           scored checks of a result (category completed|correctness|rules|other)
//   metrics          benchmark-specific numbers per result (decode_tps, tool_used_pct, ...)
//   tool_calls       every tool call of a result (seq, tool, ok, args_hash)
//   run_model_stats  per run x benchmark x model aggregates (cron_score, chat_score, load_s, ...)
//   run_benchmarks   benchmark version + content fingerprint per run x benchmark (lib/version.js); source 'run' or 'backfill'
//   benchmark_versions  changelog entry (released_on, summary) per benchmark version
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PATH = process.env.BENCH_DB || path.join(__dirname, '..', 'data', 'benchmark.db');
const WEIGHTS = { completed: 15, correctness: 50, rules: 20 };
const CATEGORIES = ['completed', 'correctness', 'rules', 'other'];

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  started_at TEXT,
  finished_at TEXT,
  host TEXT,
  command TEXT,
  flags_json TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  meta_json TEXT
);
CREATE TABLE benchmarks (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  alias TEXT NOT NULL UNIQUE,
  file TEXT,
  quant TEXT,
  ctx INTEGER,
  kv_type TEXT,
  extra_json TEXT
);
CREATE TABLE cases (
  id INTEGER PRIMARY KEY,
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id),
  case_key TEXT NOT NULL,
  profile TEXT,
  kind TEXT,
  title TEXT,
  UNIQUE (benchmark_id, case_key)
);
CREATE TABLE case_results (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  case_id INTEGER NOT NULL REFERENCES cases(id),
  repeat_idx INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  score REAL,
  completed INTEGER,
  duration_s REAL,
  model_calls INTEGER,
  prompt_tokens INTEGER,
  output_tokens INTEGER,
  answer_chars INTEGER,
  answer_text TEXT,
  transcript_path TEXT,
  error TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, model_id, case_id, repeat_idx)
);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES case_results(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('completed', 'correctness', 'rules', 'other')),
  passed INTEGER,
  weight REAL,
  detail TEXT
);
CREATE TABLE metrics (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES case_results(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value REAL,
  unit TEXT,
  UNIQUE (result_id, name)
);
CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY,
  result_id INTEGER NOT NULL REFERENCES case_results(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  tool TEXT,
  ok INTEGER,
  duration_s REAL,
  args_hash TEXT
);
CREATE TABLE run_model_stats (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id),
  model_id INTEGER NOT NULL REFERENCES models(id),
  name TEXT NOT NULL,
  value REAL,
  text TEXT,
  UNIQUE (run_id, benchmark_id, model_id, name)
);
CREATE INDEX idx_results_bench_model ON case_results (benchmark_id, model_id);
CREATE INDEX idx_results_run ON case_results (run_id);
CREATE INDEX idx_results_case ON case_results (case_id);
CREATE INDEX idx_checks_result ON checks (result_id);
CREATE INDEX idx_checks_name ON checks (name, passed);
CREATE INDEX idx_metrics_name ON metrics (name);
CREATE INDEX idx_tool_calls_result ON tool_calls (result_id);
CREATE INDEX idx_stats_run ON run_model_stats (run_id, benchmark_id, model_id);
`,
  },
  {
    version: 2,
    name: 'benchmark versions',
    // Existing rows are untouched; runs without a row in run_benchmarks have no version until `backfill-versions`.
    sql: `
CREATE TABLE run_benchmarks (
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id),
  version TEXT,
  fingerprint TEXT,
  source TEXT NOT NULL DEFAULT 'run',
  PRIMARY KEY (run_id, benchmark_id)
);
CREATE TABLE benchmark_versions (
  benchmark_id INTEGER NOT NULL REFERENCES benchmarks(id),
  version TEXT NOT NULL,
  released_on TEXT,
  summary TEXT,
  PRIMARY KEY (benchmark_id, version)
);
CREATE INDEX idx_run_benchmarks_version ON run_benchmarks (benchmark_id, version);
`,
  },
];

// Units of the standard metrics; anything else is stored without a unit.
const UNITS = {
  decode_tps: 'tok/s', prompt_tps: 'tok/s', tool_calls_total: 'count', tool_calls_failed: 'count',
  tool_used_pct: '%', model_calls_with_tools: 'count', exit_code: 'code', gpu_peak_c: '°C',
};

let cached = null;

/** Open (and migrate) the database for writing. Cached per process. */
function open(file = DEFAULT_PATH) {
  if (cached && cached.file === file) return cached.db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 15000; PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON;');
  migrate(db);
  cached = { file, db };
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
    });
  }
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const json = (v) => (v == null ? null : JSON.stringify(v));
const parse = (s, d = null) => { if (s == null) return d; try { return JSON.parse(s); } catch { return d; } };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (v === true ? 1 : v === false ? 0 : null));
const bool = (v) => (v === true ? 1 : v === false ? 0 : null);

// ------------------------------------------------------------------ model metadata
/** Parse llama.cpp router-config.ini: { alias: {file, quant, ctx, kv_type, extra} } (defaults from [*]). */
function routerPresets(file = process.env.ROUTER_CONFIG) {
  if (!file || !fs.existsSync(file)) return {};
  const sections = {};
  let cur = null;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { cur = sections[sec[1]] = {}; continue; }
    const kv = line.match(/^([^=]+?)\s*=\s*(.*)$/);
    if (kv && cur) cur[kv[1].trim()] = kv[2].trim();
  }
  const defaults = sections['*'] || {};
  const out = {};
  for (const [alias, s] of Object.entries(sections)) {
    if (alias === '*') continue;
    const o = { ...defaults, ...s };
    const fileName = o.model ? path.basename(o.model) : null;
    const quant = fileName && (fileName.match(/(UD-)?(IQ\d_[A-Z0-9_]+|Q\d_[A-Z0-9_]+|Q\d_\d|MXFP4(_MOE)?|BF16|F16|F32)/i) || [])[0];
    const k = o['cache-type-k'];
    const v = o['cache-type-v'];
    out[alias] = {
      file: fileName,
      quant: quant || null,
      ctx: o['ctx-size'] ? Number(o['ctx-size']) : null,
      kv_type: k ? (v && v !== k ? `${k}/${v}` : k) : null,
      extra: o,
    };
  }
  return out;
}

// ------------------------------------------------------------------ writes
function upsertBenchmark(db, name, description) {
  db.prepare('INSERT INTO benchmarks (name, description) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET description = COALESCE(excluded.description, benchmarks.description)')
    .run(name, description ?? null);
  return db.prepare('SELECT id FROM benchmarks WHERE name = ?').get(name).id;
}

function upsertModel(db, alias, meta = {}) {
  db.prepare(`INSERT INTO models (alias, file, quant, ctx, kv_type, extra_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(alias) DO UPDATE SET file = COALESCE(excluded.file, models.file), quant = COALESCE(excluded.quant, models.quant),
      ctx = COALESCE(excluded.ctx, models.ctx), kv_type = COALESCE(excluded.kv_type, models.kv_type),
      extra_json = COALESCE(excluded.extra_json, models.extra_json)`)
    .run(alias, meta.file ?? null, meta.quant ?? null, meta.ctx ?? null, meta.kv_type ?? null, json(meta.extra));
  return db.prepare('SELECT id FROM models WHERE alias = ?').get(alias).id;
}

function upsertCase(db, benchmarkId, row) {
  db.prepare(`INSERT INTO cases (benchmark_id, case_key, profile, kind, title) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(benchmark_id, case_key) DO UPDATE SET profile = COALESCE(excluded.profile, cases.profile),
      kind = COALESCE(excluded.kind, cases.kind), title = COALESCE(excluded.title, cases.title)`)
    .run(benchmarkId, row.case_id, row.group || null, row.kind || null, row.title || row.case_id);
  return db.prepare('SELECT id FROM cases WHERE benchmark_id = ? AND case_key = ?').get(benchmarkId, row.case_id).id;
}

function runStatus(run) {
  if (!run.finished_at) return 'running';
  return run.aborted ? 'aborted' : 'finished';
}

/** Upsert the run row; returns its id. */
function upsertRun(db, run, { name = path.basename(run.run_dir), status, host = process.env.BENCH_HOST || os.hostname() } = {}) {
  const meta = {
    run_dir: run.run_dir, aborted: Boolean(run.aborted), abort_reason: run.abort_reason || null, notes: run.notes || [],
    models: run.models || [], gpu: run.gpu || null, cleanup: run.cleanup || {},
    benchmarks: (run.benchmarks || []).map((b) => ({ name: b.name, description: b.description || '', ...(b.version ? { version: b.version, fingerprint: b.fingerprint ?? null, ...(b.version_source ? { version_source: b.version_source } : {}) } : {}) })),
  };
  const flags = { argv: String(run.command || '').replace(/^npm run benchmark --\s*/, '').split(/\s+/).filter(Boolean) };
  db.prepare(`INSERT INTO runs (name, started_at, finished_at, host, command, flags_json, status, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at, host = COALESCE(runs.host, excluded.host),
      command = excluded.command, flags_json = excluded.flags_json, status = excluded.status, meta_json = excluded.meta_json`)
    .run(name, run.started_at || null, run.finished_at || null, host, run.command || null, json(flags), status || runStatus(run), json(meta));
  return db.prepare('SELECT id FROM runs WHERE name = ?').get(name).id;
}

/** Points a passing check is worth in the score (category weight split over its evaluable checks). */
function checkWeights(checks) {
  const n = {};
  for (const c of checks) if (c.pass === true || c.pass === false) n[c.category || 'correctness'] = (n[c.category || 'correctness'] || 0) + 1;
  return checks.map((c) => {
    const cat = c.category || 'correctness';
    return (c.pass === true || c.pass === false) && WEIGHTS[cat] ? Math.round((WEIGHTS[cat] / n[cat]) * 100) / 100 : null;
  });
}

/** Record the benchmark version (and fingerprint) of a run; a changelog summary also lands in benchmark_versions. */
function saveVersion(db, runId, benchmarkId, b, source = b.version_source || 'run') {
  db.prepare(`INSERT INTO run_benchmarks (run_id, benchmark_id, version, fingerprint, source) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(run_id, benchmark_id) DO UPDATE SET version = excluded.version, fingerprint = excluded.fingerprint, source = excluded.source`)
    .run(runId, benchmarkId, b.version, b.fingerprint ?? null, source);
  if (b.version_summary || b.version_date) {
    db.prepare(`INSERT INTO benchmark_versions (benchmark_id, version, released_on, summary) VALUES (?, ?, ?, ?)
      ON CONFLICT(benchmark_id, version) DO UPDATE SET released_on = COALESCE(excluded.released_on, benchmark_versions.released_on), summary = COALESCE(excluded.summary, benchmark_versions.summary)`)
      .run(benchmarkId, b.version, b.version_date ?? null, b.version_summary ?? null);
  }
}

/** Upsert one standard row (see lib/report.js) under runId, replacing its checks, metrics and tool calls. */
function saveRow(db, runId, row, { runName, benchmarkId, presets = {} }) {
  const bId = benchmarkId || upsertBenchmark(db, row.benchmark, null);
  const mId = upsertModel(db, row.model, presets[row.model]);
  const cId = upsertCase(db, bId, row);
  const checks = row.checks || [];
  const completed = checks.find((c) => c.name === 'completed');
  const transcript = row.transcript ? (runName ? `${runName}/${row.transcript}` : row.transcript) : null;
  const errorText = ['error', 'timeout', 'load_failed'].includes(row.status) ? (row.notes || row.status) : null;
  const extra = {
    group: row.group ?? null, exit_code: row.exit_code ?? null, failure_types: row.failure_types || [], leftovers: row.leftovers || [],
    notes: row.notes || '', tool_calls: row.tool_calls ?? null, tool_errors: row.tool_errors ?? null,
  };
  const res = db.prepare(`INSERT INTO case_results (run_id, benchmark_id, model_id, case_id, repeat_idx, status, score, completed, duration_s, model_calls,
      prompt_tokens, output_tokens, answer_chars, answer_text, transcript_path, error, extra_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, model_id, case_id, repeat_idx) DO UPDATE SET benchmark_id = excluded.benchmark_id, status = excluded.status,
      score = excluded.score, completed = excluded.completed, duration_s = excluded.duration_s, model_calls = excluded.model_calls,
      prompt_tokens = excluded.prompt_tokens, output_tokens = excluded.output_tokens, answer_chars = excluded.answer_chars,
      answer_text = COALESCE(excluded.answer_text, case_results.answer_text), transcript_path = excluded.transcript_path,
      error = excluded.error, extra_json = excluded.extra_json
    RETURNING id`)
    .get(runId, bId, mId, cId, row.repeat || 1, row.status, num(row.score), completed ? bool(completed.pass) : (row.status === 'pass' ? 1 : null),
      num(row.duration_s), num(row.api_calls), num(row.tokens_in), num(row.tokens_out), num(row.answer_chars), row.answer_text ?? null,
      transcript, errorText, json(extra), row.created_at || new Date().toISOString());
  const id = res.id;
  db.prepare('DELETE FROM checks WHERE result_id = ?').run(id);
  db.prepare('DELETE FROM metrics WHERE result_id = ?').run(id);
  const insCheck = db.prepare('INSERT INTO checks (result_id, name, category, passed, weight, detail) VALUES (?, ?, ?, ?, ?, ?)');
  const weights = checkWeights(checks);
  checks.forEach((c, i) => {
    const cat = CATEGORIES.includes(c.category) ? c.category : 'other';
    insCheck.run(id, c.name, cat, bool(c.pass), weights[i], c.reason ?? null);
  });
  const metrics = { decode_tps: row.decode_tps, prompt_tps: row.prompt_tps, tool_calls_total: row.tool_calls, tool_calls_failed: row.tool_errors, exit_code: row.exit_code, ...(row.metrics || {}) };
  const insMetric = db.prepare('INSERT INTO metrics (result_id, name, value, unit) VALUES (?, ?, ?, ?)');
  for (const [name, v] of Object.entries(metrics)) {
    if (num(v) == null) continue;
    insMetric.run(id, name, num(v), UNITS[name] || null);
  }
  // Tool calls: keep previously recorded calls when the row does not carry a list (e.g. a plain re-import).
  if (Array.isArray(row.tool_call_list)) {
    db.prepare('DELETE FROM tool_calls WHERE result_id = ?').run(id);
    const insTool = db.prepare('INSERT INTO tool_calls (result_id, seq, tool, ok, duration_s, args_hash) VALUES (?, ?, ?, ?, ?, ?)');
    row.tool_call_list.forEach((t, i) => insTool.run(id, t.seq ?? i + 1, t.tool ?? null, bool(t.ok), num(t.duration_s), t.args_hash ?? null));
  }
  return id;
}

/**
 * Write a whole in-memory run (main.js shape) into the DB in one transaction.
 * opts.models: only rows of these model aliases (import filter).
 */
function saveRun(db, run, opts = {}) {
  const name = opts.name || path.basename(run.run_dir);
  const presets = routerPresets();
  return tx(db, () => {
    const runId = upsertRun(db, run, { name, status: opts.status });
    for (const b of run.benchmarks || []) {
      const bId = upsertBenchmark(db, b.name, b.description || null);
      if (b.version) saveVersion(db, runId, bId, b);
      for (const row of b.results || []) {
        if (opts.models && !opts.models.includes(row.model)) continue;
        saveRow(db, runId, row, { runName: name, benchmarkId: bId, presets });
      }
    }
    for (const m of run.models || []) if (!opts.models || opts.models.includes(m.id)) upsertModel(db, m.id, presets[m.id]);
    return runId;
  });
}

const STAT_KEYS = ['score', 'cron_score', 'chat_score', 'chat_case_score', 'speed_score', 'chat_median_s', 'pass_rate', 'load_s',
  'gpu_peak_mem_c', 'gpu_peak_vram_gib', 'median_decode_tps', 'median_prompt_tps'];
const STAT_TEXT = ['load_status', 'chat_disqualified'];

/** Replace run_model_stats of a run with the aggregates computed by lib/report.js. */
function saveStats(db, runId, agg) {
  tx(db, () => {
    db.prepare('DELETE FROM run_model_stats WHERE run_id = ?').run(runId);
    const ins = db.prepare('INSERT INTO run_model_stats (run_id, benchmark_id, model_id, name, value, text) VALUES (?, ?, ?, ?, ?, ?)');
    for (const a of agg) {
      const bId = upsertBenchmark(db, a.benchmark, null);
      const mId = upsertModel(db, a.model);
      for (const k of STAT_KEYS) if (num(a[k]) != null) ins.run(runId, bId, mId, k, num(a[k]), null);
      for (const k of STAT_TEXT) if (a[k] != null) ins.run(runId, bId, mId, k, null, String(a[k]));
    }
  });
}

// ------------------------------------------------------------------ reads
/** Rebuild the in-memory run (main.js shape, rows in the standard shape) from the DB. */
function loadRun(db, name) {
  const r = db.prepare('SELECT * FROM runs WHERE name = ?').get(name);
  if (!r) return null;
  const meta = parse(r.meta_json, {});
  const rows = db.prepare(`SELECT cr.*, b.name AS benchmark, m.alias AS model, c.case_key, c.profile, c.kind, c.title
    FROM case_results cr JOIN benchmarks b ON b.id = cr.benchmark_id JOIN models m ON m.id = cr.model_id JOIN cases c ON c.id = cr.case_id
    WHERE cr.run_id = ? ORDER BY cr.id`).all(r.id);
  const checksBy = groupBy(db.prepare('SELECT ch.* FROM checks ch JOIN case_results cr ON cr.id = ch.result_id WHERE cr.run_id = ? ORDER BY ch.id').all(r.id));
  const metricsBy = groupBy(db.prepare('SELECT mt.* FROM metrics mt JOIN case_results cr ON cr.id = mt.result_id WHERE cr.run_id = ? ORDER BY mt.id').all(r.id));
  const benches = (meta.benchmarks && meta.benchmarks.length ? meta.benchmarks : []).map((b) => ({ ...b, results: [] }));
  const vers = db.prepare('SELECT b.name, rb.version, rb.fingerprint, rb.source FROM run_benchmarks rb JOIN benchmarks b ON b.id = rb.benchmark_id WHERE rb.run_id = ?').all(r.id);
  for (const v of vers) {
    let b = benches.find((y) => y.name === v.name);
    if (!b) benches.push(b = { name: v.name, description: '', results: [] });
    b.version = v.version; b.fingerprint = v.fingerprint;
    if (v.source && v.source !== 'run') b.version_source = v.source; else delete b.version_source;
  }
  const prefix = `${name}/`;
  for (const x of rows) {
    let b = benches.find((y) => y.name === x.benchmark);
    if (!b) benches.push(b = { name: x.benchmark, description: '', results: [] });
    const extra = parse(x.extra_json, {});
    const mets = Object.fromEntries((metricsBy[x.id] || []).map((mm) => [mm.name, mm.value]));
    const { decode_tps: decodeTps = null, prompt_tps: promptTps = null, tool_calls_total: _t, tool_calls_failed: _f, exit_code: _e, ...rest } = mets;
    b.results.push({
      benchmark: x.benchmark, model: x.model, case_id: x.case_key, group: extra.group ?? x.profile ?? '', kind: x.kind || '', repeat: x.repeat_idx,
      status: x.status, duration_s: x.duration_s, exit_code: extra.exit_code ?? null, tokens_in: x.prompt_tokens || 0, tokens_out: x.output_tokens || 0,
      api_calls: x.model_calls || 0, tool_calls: extra.tool_calls ?? mets.tool_calls_total ?? 0, tool_errors: extra.tool_errors ?? mets.tool_calls_failed ?? 0,
      answer_chars: x.answer_chars || 0, decode_tps: decodeTps, prompt_tps: promptTps,
      checks: (checksBy[x.id] || []).map((c) => ({ name: c.name, pass: c.passed == null ? null : Boolean(c.passed), reason: c.detail, category: c.category })),
      failure_types: extra.failure_types || [], leftovers: extra.leftovers || [],
      transcript: x.transcript_path ? (x.transcript_path.startsWith(prefix) ? x.transcript_path.slice(prefix.length) : x.transcript_path) : null,
      notes: extra.notes || '', score: x.score, metrics: rest, result_id: x.id, answer_text: x.answer_text, created_at: x.created_at,
    });
  }
  return {
    run_id: r.id, name: r.name, run_dir: meta.run_dir || name, command: r.command, started_at: r.started_at, finished_at: r.finished_at,
    status: r.status, aborted: Boolean(meta.aborted), abort_reason: meta.abort_reason || null, notes: meta.notes || [], models: meta.models || [],
    benchmarks: benches, gpu: meta.gpu || null, cleanup: meta.cleanup || {},
  };
}

function groupBy(rows) {
  const out = {};
  for (const r of rows) (out[r.result_id] || (out[r.result_id] = [])).push(r);
  return out;
}

module.exports = { DEFAULT_PATH, WEIGHTS, MIGRATIONS, saveVersion, upsertBenchmark, open, migrate, saveRun, saveRow, saveStats, loadRun, routerPresets, upsertRun, runStatus };
