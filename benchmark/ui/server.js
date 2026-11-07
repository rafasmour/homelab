'use strict';
// benchmark-ui: read-only JSON API + static single-page UI over benchmark/data/benchmark.db.
// Node built-ins only (node:http, node:sqlite). The DB is opened read-only; every query is parameterised.
const http = require('node:http');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.BENCH_DB || '/data/benchmark.db';
const REPORTS = path.resolve(process.env.REPORTS_DIR || '/reports');
const PUBLIC = path.join(__dirname, 'public');
const MAX_TRANSCRIPT = 32 * 1024 * 1024;
// Source clips of the STT benchmark (read-only mount of speech/audiocpp/models/_asr-eval/clips: <lang>/<stem>.wav).
const CLIPS_DIR = path.resolve(process.env.STT_CLIPS_DIR || '/stt-clips');
const USERNAME = process.env.BENCHMARK_UI_USERNAME || '';
const PASSWORD = process.env.BENCHMARK_UI_PASSWORD || '';
if (!USERNAME || !PASSWORD) {
  console.error('BENCHMARK_UI_USERNAME and BENCHMARK_UI_PASSWORD must be set');
  process.exit(1);
}

let db = null;
function conn() {
  if (db) return db;
  if (!fs.existsSync(DB_PATH)) throw Object.assign(new Error(`no database yet at ${DB_PATH} (import a report or run a benchmark)`), { status: 503 });
  db = new DatabaseSync(DB_PATH, { readOnly: true });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
  return db;
}
function all(sql, params = []) {
  try { return conn().prepare(sql).all(...params); } catch (e) {
    if (/no such table/.test(e.message)) return [];
    if (/database disk image|not a database|SQLITE_READONLY/i.test(e.message)) { try { db && db.close(); } catch { /* ignore */ } db = null; }
    throw e;
  }
}
const get = (sql, params = []) => all(sql, params)[0] || null;

// ------------------------------------------------------------------ helpers
const list = (v) => (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean)).slice(0, 200);
const numOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const rate = (bools) => (bools.length ? r1((100 * bools.filter(Boolean).length) / bools.length) : null);
/** Leaderboard order: average score, then pass rate, then the share of results whose task was correct. */
const byRank = (a, b) => ((b.avg_score ?? -1) - (a.avg_score ?? -1)) || ((b.pass_rate ?? -1) - (a.pass_rate ?? -1))
  || ((b.correct_rate ?? -1) - (a.correct_rate ?? -1)) || a.model.localeCompare(b.model);
const likeEsc = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const FROM = `case_results cr
  JOIN runs r ON r.id = cr.run_id
  JOIN benchmarks b ON b.id = cr.benchmark_id
  JOIN models m ON m.id = cr.model_id
  JOIN cases c ON c.id = cr.case_id
  LEFT JOIN run_benchmarks rb ON rb.run_id = cr.run_id AND rb.benchmark_id = cr.benchmark_id
  LEFT JOIN metrics tu ON tu.result_id = cr.id AND tu.name = 'tool_used_pct'
  LEFT JOIN metrics dt ON dt.result_id = cr.id AND dt.name = 'decode_tps'
  LEFT JOIN metrics pt ON pt.result_id = cr.id AND pt.name = 'prompt_tps'
  LEFT JOIN metrics tc ON tc.result_id = cr.id AND tc.name = 'tool_calls_total'`;

const COLS = `cr.id, r.name AS run, r.id AS run_id, b.name AS benchmark, rb.version AS bench_version, m.alias AS model, c.case_key AS case_key, c.profile, c.kind, c.title,
  cr.repeat_idx, cr.status, cr.score, cr.completed, cr.duration_s, cr.model_calls, cr.prompt_tokens, cr.output_tokens, cr.answer_chars,
  cr.error, cr.transcript_path, tu.value AS tool_used_pct, dt.value AS decode_tps, pt.value AS prompt_tps, tc.value AS tool_calls`;

/** Shared WHERE clause for every filtered endpoint. Only values are user-supplied; all go through `?`. */
function filter(q) {
  const where = [];
  const p = [];
  const inList = (col, vals) => { if (vals.length) { where.push(`${col} IN (${vals.map(() => '?').join(',')})`); p.push(...vals); } };
  const range = (expr, lo, hi) => {
    const a = numOrNull(lo); const z = numOrNull(hi);
    if (a != null) { where.push(`${expr} >= ?`); p.push(a); }
    if (z != null) { where.push(`${expr} <= ?`); p.push(z); }
  };
  if (q.get('benchmark')) { where.push('b.name = ?'); p.push(q.get('benchmark')); }
  // Benchmark version(s); 'none' = runs without a recorded version. Absent or 'all' = every version.
  const vers = list(q.get('versions')).filter((v) => v !== 'all');
  if (vers.length) {
    const real = vers.filter((v) => v !== 'none');
    const parts = [];
    if (real.length) { parts.push(`rb.version IN (${real.map(() => '?').join(',')})`); p.push(...real); }
    if (vers.includes('none')) parts.push('rb.version IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  inList('r.name', list(q.get('runs')));
  inList('m.alias', list(q.get('models')));
  inList('c.case_key', list(q.get('cases')));
  inList('c.profile', list(q.get('profiles')));
  inList('c.kind', list(q.get('kinds')));
  inList('cr.status', list(q.get('status')));
  range('cr.score', q.get('score_min'), q.get('score_max'));
  range('tu.value', q.get('tool_min'), q.get('tool_max'));
  range('(COALESCE(cr.prompt_tokens, 0) + COALESCE(cr.output_tokens, 0))', q.get('tokens_min'), q.get('tokens_max'));
  range('cr.duration_s', q.get('dur_min'), q.get('dur_max'));
  for (const name of list(q.get('check_pass'))) { where.push('EXISTS (SELECT 1 FROM checks k WHERE k.result_id = cr.id AND k.name = ? AND k.passed = 1)'); p.push(name); }
  for (const name of list(q.get('check_fail'))) { where.push('EXISTS (SELECT 1 FROM checks k WHERE k.result_id = cr.id AND k.name = ? AND k.passed = 0)'); p.push(name); }
  const text = (q.get('q') || '').trim().slice(0, 200);
  if (text) {
    where.push(`(m.alias LIKE ? ESCAPE '\\' OR c.case_key LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR cr.answer_text LIKE ? ESCAPE '\\' OR cr.error LIKE ? ESCAPE '\\')`);
    const l = likeEsc(text);
    p.push(l, l, l, l, l);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params: p };
}

function filteredRows(q) {
  const f = filter(q);
  return all(`SELECT ${COLS} FROM ${FROM} ${f.where} ORDER BY cr.id`, f.params);
}

function failedChecks(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...all(`SELECT result_id, name, category, passed, detail FROM checks WHERE result_id IN (${chunk.map(() => '?').join(',')})`, chunk));
  }
  return out;
}

// ------------------------------------------------------------------ endpoints
function meta() {
  const benchmarks = all(`SELECT b.id, b.name, b.description, COUNT(cr.id) AS results FROM benchmarks b LEFT JOIN case_results cr ON cr.benchmark_id = b.id GROUP BY b.id ORDER BY b.name`);
  const runs = all(`SELECT r.id, r.name, r.started_at, r.finished_at, r.status, r.command, r.host, COUNT(cr.id) AS results,
      COUNT(DISTINCT cr.model_id) AS models FROM runs r LEFT JOIN case_results cr ON cr.run_id = r.id GROUP BY r.id ORDER BY r.name DESC`);
  const models = all(`SELECT m.id, m.alias, m.file, m.quant, m.ctx, m.kv_type, COUNT(cr.id) AS results FROM models m LEFT JOIN case_results cr ON cr.model_id = m.id GROUP BY m.id ORDER BY m.alias`);
  const cases = all(`SELECT c.id, b.name AS benchmark, c.case_key, c.profile, c.kind, c.title FROM cases c JOIN benchmarks b ON b.id = c.benchmark_id ORDER BY b.name, c.kind, c.case_key`);
  const checks = all(`SELECT DISTINCT ch.name, ch.category FROM checks ch ORDER BY ch.category, ch.name`);
  const statuses = all(`SELECT DISTINCT status FROM case_results ORDER BY status`).map((x) => x.status);
  const metrics = all(`SELECT name, unit, COUNT(*) AS n FROM metrics GROUP BY name, unit ORDER BY name`);
  const versionRows = benchmarkVersions();
  for (const b of benchmarks) b.versions = versionRows.filter((v) => v.benchmark === b.name);
  const rv = all('SELECT rb.run_id, b.name AS benchmark, rb.version FROM run_benchmarks rb JOIN benchmarks b ON b.id = rb.benchmark_id');
  for (const r of runs) r.versions = Object.fromEntries(rv.filter((x) => x.run_id === r.id).map((x) => [x.benchmark, x.version]));
  return { benchmarks, runs, models, cases, checks, statuses, metrics, versions: versionRows };
}

/** Per benchmark and version: runs, models, results, scores, date range, fingerprints (more than one = measured thing changed without a bump), top model, changelog text. Newest version first. */
function benchmarkVersions() {
  const rows = all(`SELECT b.name AS benchmark, COALESCE(rb.version, 'none') AS version, m.alias AS model, r.name AS run, r.started_at, rb.fingerprint, rb.source,
      c.case_key, cr.score, cr.status
    FROM case_results cr JOIN runs r ON r.id = cr.run_id JOIN benchmarks b ON b.id = cr.benchmark_id JOIN models m ON m.id = cr.model_id JOIN cases c ON c.id = cr.case_id
    LEFT JOIN run_benchmarks rb ON rb.run_id = cr.run_id AND rb.benchmark_id = cr.benchmark_id`);
  const info = Object.fromEntries(all(`SELECT b.name AS benchmark, v.version, v.released_on, v.summary FROM benchmark_versions v JOIN benchmarks b ON b.id = v.benchmark_id`).map((x) => [`${x.benchmark}@${x.version}`, x]));
  const groups = {};
  for (const x of rows) (groups[`${x.benchmark}@${x.version}`] || (groups[`${x.benchmark}@${x.version}`] = [])).push(x);
  const out = Object.values(groups).map((rs) => {
    const { benchmark, version } = rs[0];
    const byModel = {};
    for (const x of rs) (byModel[x.model] || (byModel[x.model] = [])).push(x);
    const cases = new Set(rs.map((x) => x.case_key));
    const models = Object.entries(byModel).map(([model, ms]) => ({
      model, cases: new Set(ms.map((x) => x.case_key)).size, avg_score: mean(ms.map((x) => x.score)), pass_rate: rate(ms.map((x) => x.status === 'pass')),
    }));
    // Top model: best average score among models that covered the version's whole case set (else among all).
    const maxCases = Math.max(...models.map((m) => m.cases));
    const full = models.filter((m) => m.cases >= maxCases);
    const top = [...(full.length ? full : models)].sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1) || a.model.localeCompare(b.model))[0];
    const runs = [...new Set(rs.map((x) => x.run))].sort();
    const fps = [...new Set(rs.map((x) => x.fingerprint).filter(Boolean))];
    const meta = info[`${benchmark}@${version}`] || {};
    return {
      benchmark, version, runs: runs.length, first_run: runs[0], last_run: runs[runs.length - 1], models: models.length, results: rs.length, cases: cases.size,
      avg_score: r1(mean(rs.map((x) => x.score))), pass_rate: rate(rs.map((x) => x.status === 'pass')),
      top_model: top ? top.model : null, top_score: top ? r1(top.avg_score) : null,
      fingerprints: fps, drift: fps.length > 1, backfilled: rs.some((x) => x.source === 'backfill'), released_on: meta.released_on || null, summary: meta.summary || null,
    };
  });
  const semver = (v) => v.split('.').map((n) => Number(n) || 0);
  const cmp = (a, b) => { const x = semver(a); const y = semver(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  return out.sort((a, b) => a.benchmark.localeCompare(b.benchmark) || (a.version === 'none' ? -1 : b.version === 'none' ? 1 : cmp(b.version, a.version)));
}

function leaderboard(q) {
  const rows = filteredRows(q);
  const ids = rows.map((r) => r.id);
  const checks = failedChecks(ids);
  const byResult = {};
  for (const c of checks) (byResult[c.result_id] || (byResult[c.result_id] = [])).push(c);
  // Load time and GPU peaks come from the per-run aggregates, averaged over the selected runs.
  const runs = list(q.get('runs'));
  const statParams = [];
  let statWhere = '';
  if (q.get('benchmark')) { statWhere += ' AND b.name = ?'; statParams.push(q.get('benchmark')); }
  if (runs.length) { statWhere += ` AND r.name IN (${runs.map(() => '?').join(',')})`; statParams.push(...runs); }
  const vf = list(q.get('versions')).filter((v) => v !== 'all' && v !== 'none');
  if (vf.length) { statWhere += ` AND EXISTS (SELECT 1 FROM run_benchmarks rb WHERE rb.run_id = r.id AND rb.benchmark_id = b.id AND rb.version IN (${vf.map(() => '?').join(',')}))`; statParams.push(...vf); }
  const stats = all(`SELECT m.alias AS model, s.name, AVG(s.value) AS value, COUNT(s.value) AS n FROM run_model_stats s
      JOIN runs r ON r.id = s.run_id JOIN benchmarks b ON b.id = s.benchmark_id JOIN models m ON m.id = s.model_id
      WHERE s.value IS NOT NULL AND s.name IN ('load_s', 'gpu_peak_mem_c', 'gpu_peak_vram_gib')${statWhere}
      GROUP BY m.alias, s.name`, statParams);
  const dq = all(`SELECT m.alias AS model, r.name AS run, s.text FROM run_model_stats s JOIN runs r ON r.id = s.run_id JOIN benchmarks b ON b.id = s.benchmark_id
      JOIN models m ON m.id = s.model_id WHERE s.name = 'chat_disqualified' AND s.text IS NOT NULL${statWhere}`, statParams);
  const modelMeta = Object.fromEntries(all('SELECT alias, file, quant, ctx, kv_type FROM models').map((m) => [m.alias, m]));

  const groups = {};
  for (const r of rows) (groups[r.model] || (groups[r.model] = [])).push(r);
  // Case coverage. With no run/case filter, only the benchmark's current case set counts: cases run
  // within 24 h of its newest run, so retired or opt-in cases from older runs do not mark every new
  // model partial. Speech benchmarks (stt/tts) are scored per language: a Greek-only voice is
  // complete when it covers every Greek case.
  const explicit = list(q.get('runs')).length || list(q.get('cases')).length;
  const activeCases = (() => {
    if (explicit || !rows.length) return new Set(rows.map((r) => r.case_key));
    const ids = [...new Set(rows.map((r) => r.run_id))];
    const started = Object.fromEntries(all(`SELECT id, started_at FROM runs WHERE id IN (${ids.map(() => '?').join(',')})`, ids).map((x) => [x.id, Date.parse(x.started_at)]));
    const newest = Math.max(...Object.values(started).filter(Number.isFinite));
    if (!Number.isFinite(newest)) return new Set(rows.map((r) => r.case_key));
    return new Set(rows.filter((r) => started[r.run_id] >= newest - 864e5).map((r) => r.case_key));
  })();
  const casesTotal = activeCases.size;
  const isSpeech = rows.length > 0 && rows.every((r) => r.kind === 'stt' || r.kind === 'tts');
  const profileOf = Object.fromEntries(rows.map((r) => [r.case_key, r.profile]));
  const expectedFor = (rs) => {
    if (!isSpeech) return activeCases;
    const langs = new Set(rs.map((r) => r.profile));
    return new Set([...activeCases].filter((k) => langs.has(profileOf[k])));
  };
  // Speech metrics per model: corpus WER/CER (sum of edits / sum of reference size) per language.
  const speech = {};
  if (isSpeech) {
    const sm = byIds(`SELECT result_id, name, value FROM metrics WHERE name IN ('word_edits','ref_words','char_edits','ref_chars','rtf','parsed_back','peak_rss_mb') AND result_id IN (?)`, ids);
    const byRes = {};
    for (const x of sm) (byRes[x.result_id] || (byRes[x.result_id] = {}))[x.name] = x.value;
    for (const [model, rs] of Object.entries(groups)) {
      const acc = { all: {}, el: {}, en: {} };
      const add = (a, k, v) => { if (v != null) a[k] = (a[k] || 0) + v; };
      const rtf = []; const pb = []; const rss = [];
      for (const r of rs) {
        const m = byRes[r.id] || {};
        for (const a of [acc.all, acc[r.profile] || {}]) for (const k of ['word_edits', 'ref_words', 'char_edits', 'ref_chars']) add(a, k, m[k]);
        if (m.rtf != null) rtf.push(m.rtf);
        if (m.parsed_back != null) pb.push(m.parsed_back);
        if (m.peak_rss_mb != null) rss.push(m.peak_rss_mb);
      }
      const pct = (a, e, n) => (a[n] ? r1((100 * (a[e] || 0)) / a[n]) : null);
      speech[model] = {
        wer: pct(acc.all, 'word_edits', 'ref_words'), cer: pct(acc.all, 'char_edits', 'ref_chars'),
        wer_el: pct(acc.el, 'word_edits', 'ref_words'), wer_en: pct(acc.en, 'word_edits', 'ref_words'),
        rtf: rtf.length ? Math.round(median(rtf) * 1000) / 1000 : null,
        parsed_back_pct: pb.length ? r1(100 * mean(pb)) : null,
        peak_rss_mb: rss.length ? Math.round(median(rss)) : null,
        languages: [...new Set(rs.map((r) => r.profile))].sort(),
      };
    }
  }
  const runStatus = Object.fromEntries(all('SELECT name, status, finished_at FROM runs').map((x) => [x.name, x]));
  const inProgress = (name) => { const x = runStatus[name]; return Boolean(x && (x.status === 'running' || !x.finished_at)); };
  const checkNames = new Set();
  const out = Object.entries(groups).map(([model, rs]) => {
    const failures = {};
    for (const r of rs) {
      for (const c of byResult[r.id] || []) if (c.passed === 0) { failures[c.name] = (failures[c.name] || 0) + 1; checkNames.add(c.name); }
      if (['timeout', 'error', 'load_failed'].includes(r.status)) { failures[r.status] = (failures[r.status] || 0) + 1; checkNames.add(r.status); }
    }
    const ran = rs.filter((r) => !['load_failed', 'skipped'].includes(r.status));
    const pin = rs.map((r) => r.prompt_tokens || 0);
    const pout = rs.map((r) => r.output_tokens || 0);
    const st = Object.fromEntries(stats.filter((s) => s.model === model).map((s) => [s.name, r1(s.value)]));
    const byKind = {};
    for (const r of rs) (byKind[r.kind || 'other'] || (byKind[r.kind || 'other'] = [])).push(r.score);
    return {
      model,
      meta: modelMeta[model] || null,
      n: rs.length,
      runs: new Set(rs.map((r) => r.run)).size,
      cases: [...expectedFor(rs)].filter((k) => rs.some((r) => r.case_key === k)).length,
      cases_total: expectedFor(rs).size,
      partial: [...expectedFor(rs)].some((k) => !rs.some((r) => r.case_key === k)),
      speech: speech[model] || null,
      runs_in_progress: [...new Set(rs.map((r) => r.run))].filter(inProgress),
      avg_score: r1(mean(rs.map((r) => r.score))),
      pass_rate: rs.length ? r1((100 * rs.filter((r) => r.status === 'pass').length) / rs.length) : null,
      correct_rate: rate(rs.map((r) => (byResult[r.id] || []).find((c) => c.name === 'correct')).filter((c) => c && c.passed != null).map((c) => c.passed === 1)),
      // Role scores as in lib/report.js, recomputed over the filtered results of all selected runs:
      // cron = mean cron case score; chat = 0.75 x mean chat case score + 0.25 x speed score (below).
      cron_score: byKind.cron ? r1(mean(byKind.cron)) : null,
      chat_case_score: byKind.chat ? r1(mean(byKind.chat)) : null,
      chat_median_s: r1(median(ran.filter((r) => r.kind === 'chat').map((r) => r.duration_s))),
      chat_score: null,
      speed_score: null,
      kind_scores: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, r1(mean(v))])),
      median_duration_s: r1(median(ran.map((r) => r.duration_s))),
      median_decode_tps: r1(median(ran.map((r) => r.decode_tps))),
      median_prompt_tps: r1(median(ran.map((r) => r.prompt_tps))),
      prompt_tokens_total: pin.reduce((a, b) => a + b, 0),
      output_tokens_total: pout.reduce((a, b) => a + b, 0),
      prompt_tokens_mean: r1(mean(pin)),
      output_tokens_mean: r1(mean(pout)),
      tool_used_pct: r1(mean(rs.map((r) => r.tool_used_pct))),
      tool_calls_total: rs.reduce((a, r) => a + (r.tool_calls || 0), 0),
      load_s: st.load_s ?? null,
      gpu_peak_mem_c: st.gpu_peak_mem_c ?? null,
      gpu_peak_vram_gib: st.gpu_peak_vram_gib ?? null,
      chat_disqualified: dq.filter((d) => d.model === model).map((d) => `${d.run}: ${d.text}`),
      failures,
      points: rs.map((r) => ({ id: r.id, case: r.case_key, run: r.run, score: r.score, duration_s: r.duration_s })),
    };
  });
  // Speed score: 100 at the fastest median chat time among the shown models, 0 at 5x.
  const fastest = Math.min(...out.map((a) => a.chat_median_s).filter((x) => x > 0));
  for (const a of out) {
    if (a.chat_case_score == null) continue;
    a.speed_score = Number.isFinite(fastest) && a.chat_median_s > 0 ? r1(Math.max(0, Math.min(100, (100 * (5 * fastest - a.chat_median_s)) / (4 * fastest)))) : 0;
    a.chat_score = r1(0.75 * a.chat_case_score + 0.25 * a.speed_score);
  }
  out.sort(byRank);
  return { rows: out, check_names: [...checkNames].sort(), total_results: rows.length, cases_total: casesTotal };
}

function results(q) {
  const rows = filteredRows(q).slice(0, 5000);
  const checks = failedChecks(rows.map((r) => r.id));
  const by = {};
  for (const c of checks) (by[c.result_id] || (by[c.result_id] = [])).push({ name: c.name, category: c.category, passed: c.passed == null ? null : Boolean(c.passed), detail: c.detail });
  // Speech rows: audio availability and the reference text (TTS: the text that was spoken, STT: the clip's reference transcript).
  const speechIds = rows.filter((r) => r.benchmark === 'stt' || r.benchmark === 'tts').map((r) => r.id);
  const refs = {};
  for (const x of byIds('SELECT id, extra_json, answer_text FROM case_results WHERE id IN (?)', speechIds)) refs[x.id] = { reference: referenceText(parse(x.extra_json, {}).notes), answer_text: x.answer_text };
  return { rows: rows.map((r) => ({ ...r, has_transcript: Boolean(r.transcript_path), transcript_path: undefined, checks: by[r.id] || [],
    audio: audioKind(r) && Boolean(audioFile(r)) ? audioKind(r) : null, reference: refs[r.id]?.reference ?? null, answer_text: refs[r.id]?.answer_text ?? null })) };
}

/** The text a speech result is about, from the row notes: TTS "... | text: <spoken text>", STT "ref: <reference transcript>". */
function referenceText(notes) {
  if (!notes) return null;
  const t = notes.match(/\| text: ([\s\S]*)$/);
  if (t) return t[1];
  return notes.startsWith('ref: ') ? notes.slice(5) : null;
}

// ------------------------------------------------------------------ audio
// Only two things are ever served as audio, both resolved from the database row (never from a client-supplied path):
//   tts: reports/<run>/audio/<model@voice>/<item>.wav  (the generated speech)
//   stt: <STT_CLIPS_DIR>/<lang>/<clip>.wav             (the source clip)
const audioKind = (r) => (r.benchmark === 'tts' ? 'tts' : r.benchmark === 'stt' ? 'stt' : null);
const SAFE_NAME = /^[\w][\w.@+-]*$/;

function inside(root, full) {
  try {
    const rootReal = fs.realpathSync(root);
    const real = fs.realpathSync(full);
    return real.startsWith(rootReal + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

/** Absolute path of the audio of a result row ({benchmark, run, model, case_key}); null when none exists or a name is unsafe. */
function audioFile(r) {
  const kind = audioKind(r);
  const [lang, stem] = String(r.case_key || '').split('/');
  if (!kind || !stem || !/^[a-z]{2,3}$/.test(lang) || !SAFE_NAME.test(stem) || stem.includes('..')) return null;
  if (kind === 'stt') return inside(CLIPS_DIR, path.join(CLIPS_DIR, lang, `${stem}.wav`));
  if (!SAFE_NAME.test(String(r.run)) || !SAFE_NAME.test(String(r.model)) || String(r.model).includes('..')) return null;
  const root = path.join(REPORTS, r.run, 'audio');
  return inside(root, path.join(root, r.model, `${stem}.wav`));
}

/** Serve a WAV with single-range support (players seek with Range requests). */
function serveAudio(req, res, file) {
  const size = fs.statSync(file).size;
  const head = { ...SEC, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300' };
  let start = 0; let end = size - 1; let status = 200;
  const range = req.headers.range;
  if (range) {
    const m = String(range).match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` }); return res.end(); }
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` }); return res.end(); }
    status = 206;
    head['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  res.writeHead(status, { ...head, 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  return stream.pipe(res);
}

function result(id) {
  const r = get(`SELECT ${COLS}, cr.answer_text, cr.extra_json, cr.created_at, r.started_at AS run_started_at FROM ${FROM} WHERE cr.id = ?`, [id]);
  if (!r) return null;
  const checks = all('SELECT name, category, passed, weight, detail FROM checks WHERE result_id = ? ORDER BY id', [id])
    .map((c) => ({ ...c, passed: c.passed == null ? null : Boolean(c.passed) }));
  const metrics = all('SELECT name, value, unit FROM metrics WHERE result_id = ? ORDER BY name', [id]);
  const tools = all('SELECT seq, tool, ok, duration_s, args_hash FROM tool_calls WHERE result_id = ? ORDER BY seq', [id])
    .map((t) => ({ ...t, ok: t.ok == null ? null : Boolean(t.ok) }));
  const { extra_json: ej, transcript_path: tp, ...rest } = r;
  const extra = parse(ej, {});
  const audio = audioKind(r) && audioFile(r) ? audioKind(r) : null;
  return { ...rest, extra, has_transcript: Boolean(tp && transcriptFile(tp)), audio, reference: audio ? referenceText(extra.notes) : null, checks, metrics, tool_calls: tools };
}

/** Rows of `sql ... IN (ids)` in chunks of 500 (SQLite's variable limit). */
function byIds(sql, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    out.push(...all(sql.replace('(?)', `(${chunk.map(() => '?').join(',')})`), chunk));
  }
  return out;
}

/** Everything about one model in one run: results with all checks and tool calls, load and GPU data,
 *  the other models of the same run, and this model's scores per case across all its runs. */
function modelRun(q) {
  const model = q.get('model'); const run = q.get('run'); const bench = q.get('benchmark') || '';
  if (!model || !run) throw Object.assign(new Error('model and run are required'), { status: 400 });
  const runRow = get('SELECT id, name, started_at, finished_at, status, host, command, meta_json FROM runs WHERE name = ?', [run]);
  if (!runRow) return null;
  const bw = bench ? ' AND b.name = ?' : '';
  const bp = bench ? [bench] : [];
  const rows = all(`SELECT ${COLS}, cr.created_at, cr.extra_json, CASE WHEN b.name IN ('stt', 'tts') THEN cr.answer_text END AS answer_text FROM ${FROM} WHERE r.name = ? AND m.alias = ?${bw} ORDER BY cr.created_at, cr.id`, [run, model, ...bp]);
  const meta = parse(runRow.meta_json, {});
  const load = (meta.models || []).find((x) => x.id === model) || null;
  if (!rows.length && !load) return null;
  const ids = rows.map((r) => r.id);
  const checks = {};
  for (const c of byIds('SELECT result_id, name, category, passed, weight, detail FROM checks WHERE result_id IN (?) ORDER BY id', ids)) {
    (checks[c.result_id] || (checks[c.result_id] = [])).push({ name: c.name, category: c.category, passed: c.passed == null ? null : Boolean(c.passed), weight: c.weight, detail: c.detail });
  }
  const tools = {};
  for (const t of byIds('SELECT result_id, seq, tool, ok, duration_s, args_hash FROM tool_calls WHERE result_id IN (?) ORDER BY result_id, seq', ids)) {
    (tools[t.result_id] || (tools[t.result_id] = [])).push({ seq: t.seq, tool: t.tool, ok: t.ok == null ? null : Boolean(t.ok), duration_s: t.duration_s, args_hash: t.args_hash });
  }
  const failedTools = Object.fromEntries(byIds("SELECT result_id, value FROM metrics WHERE name = 'tool_calls_failed' AND result_id IN (?)", ids).map((x) => [x.result_id, x.value]));
  const stats = all(`SELECT s.name, s.value, s.text FROM run_model_stats s JOIN runs r ON r.id = s.run_id JOIN benchmarks b ON b.id = s.benchmark_id
      JOIN models m ON m.id = s.model_id WHERE r.name = ? AND m.alias = ?${bw} ORDER BY s.name`, [run, model, ...bp]);
  const peerQ = new URLSearchParams({ runs: run });
  if (bench) peerQ.set('benchmark', bench);
  const peers = leaderboard(peerQ).rows.map(({ meta: _m, ...p }) => p);
  const history = all(`SELECT r.name AS run, r.started_at, r.status AS run_status, c.case_key, cr.id, cr.repeat_idx, cr.status, cr.score, cr.duration_s
      FROM case_results cr JOIN runs r ON r.id = cr.run_id JOIN models m ON m.id = cr.model_id JOIN cases c ON c.id = cr.case_id JOIN benchmarks b ON b.id = cr.benchmark_id
      WHERE m.alias = ?${bw} ORDER BY r.name, c.case_key, cr.repeat_idx`, [model, ...bp]);
  const { meta_json: _mj, ...runInfo } = runRow;
  return {
    model,
    preset: get('SELECT alias, file, quant, ctx, kv_type FROM models WHERE alias = ?', [model]),
    run: { ...runInfo, aborted: Boolean(meta.aborted), abort_reason: meta.abort_reason || null, notes: meta.notes || [] },
    load,
    stats,
    results: rows.map(({ extra_json: ej, transcript_path: tp, ...r }) => ({
      ...r, extra: parse(ej, {}), audio: audioKind(r) && audioFile(r) ? audioKind(r) : null, reference: audioKind(r) ? referenceText(parse(ej, {}).notes) : null, has_transcript: Boolean(tp), checks: checks[r.id] || [], tool_calls_list: tools[r.id] || [], tool_calls_failed: failedTools[r.id] ?? null,
    })),
    peers,
    history,
  };
}

/** Resolve a stored transcript path inside REPORTS; null if it escapes the folder or is missing. */
function transcriptFile(rel) {
  if (!rel || !rel.endsWith('.json')) return null;
  const full = path.resolve(REPORTS, rel);
  if (!full.startsWith(REPORTS + path.sep)) return null;
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

/** Generated report files of a run (report.md, report.xlsx, results.json). */
const RUN_FILES = { 'report.md': 'text/markdown; charset=utf-8', 'report.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'results.json': 'application/json' };

// ------------------------------------------------------------------ login
// Stateless session cookie "<expiry>.<hmac>", signed with a key that lives only
// in this process: restarting the container (or changing the credentials,
// which needs a restart) logs everyone out.
const COOKIE = 'bench_session';
const SESSION_S = 7 * 24 * 3600;
const SESSION_KEY = crypto.randomBytes(32);
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const sign = (exp) => crypto.createHmac('sha256', SESSION_KEY).update(`${USERNAME}\n${exp}`).digest('base64url');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function loggedIn(req) {
  const [exp, mac] = (cookies(req)[COOKIE] || '').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return same(mac, sign(exp));
}
const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;

// Failed logins per client address (Traefik's X-Forwarded-For): 10 per 15 min.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return fwd[fwd.length - 1] || req.socket.remoteAddress || '?';
}
function blocked(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return false; }
  return Boolean(f && f.count >= 10);
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count += 1;
  if (failures.size > 10000) failures.clear();
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function loginPage(message = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Benchmarks</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
</head>
<body class="login-body">
  <main class="login">
    <div class="login-brand">
      <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect class="bm-bg" width="32" height="32" rx="8"/><rect class="bm-1" x="7" y="17" width="4.5" height="8" rx="1.2"/><rect class="bm-2" x="13.75" y="11" width="4.5" height="14" rx="1.2"/><rect class="bm-3" x="20.5" y="7" width="4.5" height="18" rx="1.2"/></svg>
      <div><h1>Benchmarks</h1><p>Sign in to view the model results.</p></div>
    </div>
    <form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username" required autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      ${message ? `<p class="login-error" role="alert">${esc(message)}</p>` : ''}
      <button class="btn primary" type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function readForm(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (blocked(ip)) return send(res, 429, loginPage('Too many failed attempts. Try again in 15 minutes.'), TYPES['.html']);
  const form = await readForm(req);
  const ok = same(form.get('username') || '', USERNAME) && same(form.get('password') || '', PASSWORD);
  if (!ok) {
    noteFailure(ip);
    await new Promise((r) => setTimeout(r, 500));
    return send(res, 401, loginPage('Wrong username or password.'), TYPES['.html']);
  }
  failures.delete(ip);
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  return send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/', 'Set-Cookie': sessionCookie(`${exp}.${sign(exp)}`, SESSION_S) });
}

// ------------------------------------------------------------------ HTTP
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  // Gzip text responses: result lists are ~1 MB of JSON, which is slow over the VPN uncompressed.
  const enc = {};
  if (buf.length > 1024 && /^(application\/json|text\/|application\/javascript|image\/svg)/.test(type) && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    buf = zlib.gzipSync(buf, { level: 6 });
    enc['Content-Encoding'] = 'gzip';
    enc.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, { ...SEC, 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...enc, ...extra });
  res.end(buf);
}

// Paths reachable without a session: the login form, its stylesheet and icon, and the health check.
const PUBLIC_PATHS = new Set(['/login', '/style.css', '/favicon.svg', '/healthz']);

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad url' }); }
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/login') return await handleLogin(req, res);
    if (req.method === 'POST' && p === '/logout') return send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/login', 'Set-Cookie': sessionCookie('', 0) });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
    if (!PUBLIC_PATHS.has(p) && !loggedIn(req)) {
      return p.startsWith('/api/') ? send(res, 401, { error: 'login required' }) : send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/login' });
    }
    if (p === '/login') return loggedIn(req) ? send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/' }) : send(res, 200, loginPage(), TYPES['.html']);
    if (STATIC[p]) {
      const f = path.join(PUBLIC, STATIC[p]);
      return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
    }
    if (p === '/healthz') return send(res, 200, { ok: true, db: fs.existsSync(DB_PATH) });
    if (p === '/api/meta') return send(res, 200, meta());
    if (p === '/api/benchmarks') return send(res, 200, meta().benchmarks);
    if (p === '/api/runs') return send(res, 200, meta().runs);
    if (p === '/api/models') return send(res, 200, meta().models);
    if (p === '/api/leaderboard') return send(res, 200, leaderboard(url.searchParams));
    if (p === '/api/results') return send(res, 200, results(url.searchParams));
    if (p === '/api/model-run') {
      const r = modelRun(url.searchParams);
      return r ? send(res, 200, r) : send(res, 404, { error: 'no results for this model in this run' });
    }
    let m;
    if ((m = p.match(/^\/api\/result\/(\d+)$/))) {
      const r = result(Number(m[1]));
      return r ? send(res, 200, r) : send(res, 404, { error: 'not found' });
    }
    if ((m = p.match(/^\/api\/audio\/(\d+)\.wav$/))) {
      const row = get(`SELECT cr.id, r.name AS run, b.name AS benchmark, m.alias AS model, c.case_key FROM ${FROM} WHERE cr.id = ?`, [Number(m[1])]);
      const f = row && audioFile(row);
      if (!f) return send(res, 404, { error: 'audio not available' });
      return serveAudio(req, res, f);
    }
    if (p === '/api/versions') {
      const bench = url.searchParams.get('benchmark');
      return send(res, 200, benchmarkVersions().filter((v) => !bench || v.benchmark === bench));
    }
    if ((m = p.match(/^\/api\/result\/(\d+)\/transcript$/))) {
      const row = get('SELECT transcript_path FROM case_results WHERE id = ?', [Number(m[1])]);
      const f = row && transcriptFile(row.transcript_path);
      if (!f) return send(res, 404, { error: 'transcript not available' });
      if (fs.statSync(f).size > MAX_TRANSCRIPT) return send(res, 413, { error: 'transcript too large' });
      return send(res, 200, fs.readFileSync(f), 'application/json; charset=utf-8',
        url.searchParams.get('download') ? { 'Content-Disposition': `attachment; filename="result-${m[1]}-transcript.json"` } : {});
    }
    if ((m = p.match(/^\/api\/run\/([\w.-]+)\/(report\.md|report\.xlsx|results\.json)$/))) {
      const run = get('SELECT name FROM runs WHERE name = ?', [m[1]]);
      if (!run) return send(res, 404, { error: 'unknown run' });
      const f = path.resolve(REPORTS, run.name, m[2]);
      if (!f.startsWith(REPORTS + path.sep) || !fs.existsSync(f)) return send(res, 404, { error: 'file not available' });
      return send(res, 200, fs.readFileSync(f), RUN_FILES[m[2]], { 'Content-Disposition': `attachment; filename="${run.name}-${m[2]}"` });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), p, e.message);
    return send(res, status, { error: status === 500 ? 'internal error' : e.message });
  }
});

server.listen(PORT, () => console.log(`benchmark-ui on :${PORT}, db ${DB_PATH}, reports ${REPORTS}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
