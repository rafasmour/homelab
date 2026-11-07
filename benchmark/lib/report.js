'use strict';
// Generic reporter. Every benchmark returns rows in this standard shape:
//   { benchmark, model, case_id, group, kind ('cron'|'chat'|...), repeat,
//     status ('pass'|'fail'|'error'|'timeout'|'load_failed'|'skipped'),
//     duration_s, exit_code, tokens_in, tokens_out, api_calls, tool_calls, tool_errors, answer_chars,
//     decode_tps, prompt_tps,
//     checks: [{name, category ('completed'|'correctness'|'rules'), pass: true|false|null, reason}],
//     failure_types: [string], leftovers: [string], transcript, notes }
// Optional row fields stored in SQLite: answer_text, metrics {name: number} (e.g. tool_used_pct),
//   tool_call_list [{seq, tool, ok, duration_s, args_hash}].
// The reporter scores rows, stores them in SQLite (lib/db.js) and generates results.json, report.md
// and report.xlsx (export_xlsx.py) from the stored run.
//
// Scoring rubric (per case, 0-100; speed is never part of it):
//   completed 15 + correctness 50 (split over evaluable correctness checks, links_real included)
//   + rules 20 (split evenly over evaluable rule checks), normalised to 100 over the applicable parts.
//   A failed `completed` caps the case at 25, a failed `correct` (the task itself) at 50.
//   timeout (> 15 min), error and load_failed score 0. infra (environment fault that survived one retry: model swapped or
//   crashed, MCP/network down, source rate-limited) and skipped have no score and are excluded from all aggregates.

// Rankings per model:
//   cron score = mean case score over kind=cron rows.
//   chat score = 0.75 x mean chat case score + 0.25 x speed score (100 at the fastest median chat time,
//   linearly down to 0 at 5x the fastest). A write-case leftover or data-changing failure disqualifies
//   a model for chat.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const db = require('./db');

const WEIGHTS = { completed: 15, correctness: 50, rules: 20 };

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function scoreRow(row) {
  // infra / skipped: the environment, not the model, failed: no score, left out of every mean and pass rate.
  if (['infra', 'skipped'].includes(row.status)) return null;
  if (['timeout', 'error', 'load_failed'].includes(row.status)) return 0;
  // Speech benchmarks compute their own 0-100 score (WER-based etc.) and carry it as metrics.speech_score.
  if (row.metrics && typeof row.metrics.speech_score === 'number') return r1(row.metrics.speech_score);
  let earned = 0;
  let max = 0;
  let completedFailed = false;
  const correctFailed = (row.checks || []).some((c) => c.name === 'correct' && c.pass === false);
  for (const [cat, w] of Object.entries(WEIGHTS)) {
    const cs = (row.checks || []).filter((c) => (c.category || 'correctness') === cat && c.pass !== null && c.pass !== undefined);
    if (!cs.length) continue;
    max += w;
    earned += (w * cs.filter((c) => c.pass).length) / cs.length;
    if (cat === 'completed' && cs.some((c) => !c.pass)) completedFailed = true;
  }
  let score = max ? (earned / max) * 100 : 0;
  if (correctFailed) score = Math.min(score, 50);
  if (completedFailed) score = Math.min(score, 25);
  return r1(score);
}

const isDataChanging = (r) => (r.leftovers && r.leftovers.length > 0) || (r.checks || []).some((c) => c.name === 'read_only' && c.pass === false);

/** Per benchmark, per model aggregates (also consumed by export_xlsx.py via results.json). */
function aggregate(run) {
  const out = [];
  for (const b of run.benchmarks) {
    for (const r of b.results) r.score = scoreRow(r);
    const models = [...new Set(b.results.map((r) => r.model))];
    for (const model of models) {
      const allRows = b.results.filter((r) => r.model === model);
      const infraN = allRows.filter((r) => r.status === 'infra').length;
      const rows = allRows.filter((r) => !['infra', 'skipped'].includes(r.status));
      const ran = rows.filter((r) => !['load_failed', 'skipped'].includes(r.status));
      const cron = rows.filter((r) => r.kind === 'cron');
      const chat = rows.filter((r) => r.kind === 'chat');
      const passed = rows.filter((r) => r.status === 'pass').length;
      const failures = {};
      for (const r of rows) for (const t of r.failure_types || []) failures[t] = (failures[t] || 0) + 1;
      const m = (run.models || []).find((x) => x.id === model) || {};
      const dq = chat.filter(isDataChanging).map((r) => `${r.case_id}: ${(r.leftovers || []).join('; ') || 'data changed'}`);
      out.push({
        benchmark: b.name,
        model,
        cases: rows.length,
        infra_cases: infraN,
        passed,
        pass_rate: rows.length ? Math.round((passed / rows.length) * 1000) / 10 : 0,
        score: r1(mean(rows.map((r) => r.score))),
        cron_cases: cron.length,
        cron_score: cron.length ? r1(mean(cron.map((r) => r.score))) : null,
        chat_cases: chat.length,
        chat_case_score: chat.length ? r1(mean(chat.map((r) => r.score))) : null,
        chat_median_s: r1(median(chat.filter((r) => r.duration_s != null && r.status !== 'load_failed').map((r) => r.duration_s))),
        speed_score: null,
        chat_score: null,
        chat_disqualified: dq.length ? dq.join(' | ') : null,
        median_duration_s: r1(median(ran.map((r) => r.duration_s))),
        total_duration_s: r1(sum(ran.map((r) => r.duration_s))),
        median_decode_tps: r1(median(ran.map((r) => r.decode_tps))),
        median_prompt_tps: r1(median(ran.map((r) => r.prompt_tps))),
        tokens_in: sum(rows.map((r) => r.tokens_in)),
        tokens_out: sum(rows.map((r) => r.tokens_out)),
        median_tokens_out: median(ran.map((r) => r.tokens_out)),
        api_calls: sum(rows.map((r) => r.api_calls)),
        tool_calls: sum(rows.map((r) => r.tool_calls)),
        load_s: m.load_ms != null ? r1(m.load_ms / 1000) : null,
        load_status: m.load_status || null,
        gpu_peak_mem_c: m.gpu_peak ? m.gpu_peak.mem_c : null,
        gpu_peak_vram_gib: m.gpu_peak ? m.gpu_peak.vram_used_gib : null,
        failures,
      });
    }
    // Speed score and chat score need the fastest model of this benchmark.
    const mine = out.filter((a) => a.benchmark === b.name);
    const fastest = Math.min(...mine.map((a) => a.chat_median_s).filter((x) => x > 0));
    for (const a of mine) {
      if (a.chat_case_score == null) continue;
      a.speed_score = Number.isFinite(fastest) && a.chat_median_s > 0 ? r1(Math.max(0, Math.min(100, (100 * (5 * fastest - a.chat_median_s)) / (4 * fastest)))) : 0;
      a.chat_score = r1(0.75 * a.chat_case_score + 0.25 * a.speed_score);
    }
  }
  return out;
}

function rankings(agg) {
  const out = {};
  for (const bench of [...new Set(agg.map((a) => a.benchmark))]) {
    const mine = agg.filter((a) => a.benchmark === bench && a.load_status !== 'load_failed');
    const cron = mine.filter((a) => a.cron_score != null).sort((x, y) => y.cron_score - x.cron_score || (x.median_duration_s ?? 1e9) - (y.median_duration_s ?? 1e9));
    const chat = mine.filter((a) => a.chat_score != null).sort((x, y) => y.chat_score - x.chat_score);
    const chatOk = chat.filter((a) => !a.chat_disqualified);
    out[bench] = {
      cron: cron.map((a) => ({ model: a.model, score: a.cron_score })),
      chat: chat.map((a) => ({ model: a.model, score: a.chat_score, disqualified: a.chat_disqualified })),
      recommend: {
        cron: { best: cron[0]?.model || null, runner_up: cron[1]?.model || null },
        chat: { best: chatOk[0]?.model || null, runner_up: chatOk[1]?.model || null },
      },
    };
  }
  return out;
}

function mdEscape(s) {
  return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(mdEscape).join(' | ')} |`),
  ].join('\n');
}

/** "Benchmark version: 3.2.0 (fingerprint abc123def456)" line of report.md; a backfilled version has no fingerprint. */
function versionLine(b) {
  return `Benchmark version: ${b.version}${b.fingerprint ? ` (fingerprint ${b.fingerprint})` : (b.version_source === 'backfill' ? ' (assigned afterwards from the run date, no fingerprint)' : '')}`;
}

function renderMarkdown(run, agg, ranks) {
  const L = [];
  L.push(`# Benchmark report ${path.basename(run.run_dir)}`, '');
  L.push(`- Started: ${run.started_at}`, `- Finished: ${run.finished_at || '(partial, still running or interrupted)'}`);
  L.push(`- Command: \`${run.command}\``);
  if (run.aborted) L.push(`- **ABORTED:** ${run.abort_reason}`);
  for (const n of run.notes || []) L.push(`- Note: ${n}`);
  L.push('');
  for (const [bench, rk] of Object.entries(ranks)) {
    if (!rk.cron.length && !rk.chat.length) continue; // speech benchmarks: see <name>-summary.md
    L.push(`## Recommendation (${bench})`, '');
    L.push(`- Cron role: best **${rk.recommend.cron.best || '-'}**, runner-up ${rk.recommend.cron.runner_up || '-'}`);
    L.push(`- Chat role: best **${rk.recommend.chat.best || '-'}**, runner-up ${rk.recommend.chat.runner_up || '-'}`);
    const dq = rk.chat.filter((x) => x.disqualified);
    for (const x of dq) L.push(`- Disqualified for chat: ${x.model} (${mdEscape(x.disqualified)})`);
    L.push('');
    const a = agg.filter((x) => x.benchmark === bench).sort((x, y) => (y.cron_score ?? -1) + (y.chat_score ?? -1) - (x.cron_score ?? -1) - (x.chat_score ?? -1));
    L.push(table(['Model', 'Cron score', 'Chat score', 'Chat case score', 'Speed score', 'Chat median s', 'Median s (all)', 'Decode tok/s', 'Prompt tok/s', 'Model calls', 'Tokens in', 'Tokens out', 'Chat DQ'],
      a.map((x) => [x.model, x.cron_score ?? '', x.chat_score ?? '', x.chat_case_score ?? '', x.speed_score ?? '', x.chat_median_s ?? '', x.median_duration_s ?? '', x.median_decode_tps ?? '', x.median_prompt_tps ?? '', x.api_calls, x.tokens_in, x.tokens_out, x.chat_disqualified ? 'yes' : ''])));
    L.push('');
  }
  L.push('Scoring: per case completed 15 + correctness 50 + rules 20, normalised to 100 over the applicable checks; a failed `completed` caps a case at 25 and a failed `correct` at 50; timeouts (> 15 min) and errors score 0. Cron score = mean over cron cases. Chat score = 0.75 x mean chat case score + 0.25 x speed score (100 at the fastest median chat time, 0 at 5x). Speed is otherwise reported separately.', '');
  L.push('## Models', '');
  L.push(table(['Model', 'Load', 'Load s', 'Peak VRAM °C', 'Peak junction °C', 'Peak VRAM GiB', 'Error'],
    (run.models || []).map((m) => [m.id, m.load_status, m.load_ms != null ? r1(m.load_ms / 1000) : '', m.gpu_peak?.mem_c ?? '', m.gpu_peak?.junction_c ?? '', m.gpu_peak?.vram_used_gib ?? '', m.load_error || ''])));
  L.push('');
  for (const b of run.benchmarks) {
    const a = agg.filter((x) => x.benchmark === b.name).sort((x, y) => (y.score ?? 0) - (x.score ?? 0));
    L.push(`## ${b.name}`, '');
    if (b.version) L.push(versionLine(b), '');
    L.push(b.description || '', '');
    L.push(table(['Model', 'Score', 'Passed', 'Pass %', 'Median s', 'Total s', 'Tokens in', 'Tokens out', 'API calls', 'Tool calls', 'Failures'],
      a.map((x) => [x.model, x.score ?? '', `${x.passed}/${x.cases}`, x.pass_rate, x.median_duration_s ?? '', x.total_duration_s ?? '', x.tokens_in, x.tokens_out, x.api_calls, x.tool_calls,
        Object.entries(x.failures).map(([k, v]) => `${k}:${v}`).join(', ')])));
    L.push('');
    const cases = [...new Set(b.results.map((r) => r.case_id))];
    const models = [...new Set(b.results.map((r) => r.model))];
    L.push('### Case matrix (status, score, seconds)', '');
    L.push(table(['Case', ...models], cases.map((c) => [c, ...models.map((m) => {
      const rs = b.results.filter((r) => r.case_id === c && r.model === m);
      return rs.map((r) => `${r.status.toUpperCase()} ${r.score}${r.duration_s != null ? ` ${Math.round(r.duration_s)}s` : ''}`).join(' / ');
    })])));
    L.push('');
    const bad = b.results.filter((r) => r.status !== 'pass');
    if (bad.length) {
      L.push('### Failures', '');
      for (const r of bad) {
        const why = (r.checks || []).filter((c) => c.pass === false).map((c) => `${c.name}: ${c.reason}`);
        if (r.notes) why.push(r.notes);
        if (r.metrics && r.metrics.consults) why.push(`${r.metrics.consults} ask_agent consult(s), ${r.metrics.consult_seconds ?? 0}s`);
        L.push(`- **${r.model}** / ${r.case_id}${r.repeat > 1 ? ` #${r.repeat}` : ''} (${r.status}, score ${r.score}): ${mdEscape(why.join('; ')).slice(0, 600)}${r.transcript ? ` ([transcript](${r.transcript}))` : ''}`);
      }
      L.push('');
    }
    const left = b.results.filter((r) => r.leftovers && r.leftovers.length);
    L.push('### Per-case cleanup', '');
    if (!left.length) L.push('No per-case leftovers recorded.');
    for (const r of left) L.push(`- ${r.model} / ${r.case_id}: ${mdEscape(r.leftovers.join('; '))}`);
    L.push('');
  }
  L.push('## Cleanup', '');
  const cl = run.cleanup || {};
  if (!Object.keys(cl).length) L.push('Final cleanup has not run yet (run in progress or interrupted before it).');
  for (const [bench, c] of Object.entries(cl)) {
    L.push(`### ${bench}`, '');
    L.push(`Removed (${(c.removed || []).length}):`);
    for (const x of c.removed || []) L.push(`- ${mdEscape(x)}`);
    if (!(c.removed || []).length) L.push('- nothing');
    L.push('', `Left over (${(c.leftovers || []).length}):`);
    for (const x of c.leftovers || []) L.push(`- ${mdEscape(x)}`);
    if (!(c.leftovers || []).length) L.push('- nothing');
    L.push('', 'Final verification on the test date:');
    for (const [k, v] of Object.entries(c.verification || {})) L.push(`- ${k}: ${v}`);
    if (c.error) L.push(`- cleanup error: ${c.error}`);
    L.push('');
  }
  L.push('## Files', '', '- `results.json`: every row with all checks and scores', '- `report.xlsx`: Summary (scores, rankings, charts), per-benchmark sheets with charts, Cases (every check)', '- `transcripts/`: raw stdout/stderr, session messages, log lines and llama.cpp timings per case', '');
  return L.join('\n');
}

/**
 * Called after every case: store the in-memory run in SQLite (the source of truth), read it
 * back and generate results.json, report.md and report.xlsx from the stored data.
 * If the DB cannot be opened, the files are written from memory and the error is logged.
 */
function writeReport(run, { log = console.log } = {}) {
  fs.mkdirSync(run.run_dir, { recursive: true });
  for (const b of run.benchmarks) for (const r of b.results) r.score = scoreRow(r);
  let view = run;
  let dbInfo = null;
  try {
    const conn = db.open();
    const name = path.basename(run.run_dir);
    const runId = db.saveRun(conn, run, { name });
    view = { ...db.loadRun(conn, name), run_dir: run.run_dir };
    dbInfo = { conn, runId, name };
  } catch (e) {
    log(`database write failed, reporting from memory: ${e.message}`);
  }
  return renderFiles(view, { log, dbInfo });
}

/** Write results.json, report.md and report.xlsx for a run object (from loadRun or memory). */
function renderFiles(run, { log = console.log, dbInfo = null, outDir = run.run_dir } = {}) {
  const agg = aggregate(run);
  const ranks = rankings(agg);
  if (dbInfo) {
    try { db.saveStats(dbInfo.conn, dbInfo.runId, agg); } catch (e) { log(`database stats write failed: ${e.message}`); }
  }
  const { run_id: _id, name: _n, status: _s, ...plain } = run;
  const data = { ...plain, aggregates: agg, rankings: ranks };
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(run, agg, ranks));
  // The xlsx exporter reads rows and checks from SQLite; aggregates/rankings come on stdin.
  const args = [path.join(__dirname, 'export_xlsx.py'), outDir];
  if (dbInfo) args.push('--db', db.DEFAULT_PATH, '--run', dbInfo.name);
  const py = spawnSync('python3', args, { encoding: 'utf8', timeout: 120_000, input: dbInfo ? JSON.stringify({ aggregates: agg, rankings: ranks }) : '' });
  if (py.status !== 0) log(`xlsx export failed: ${(py.stderr || py.error || '').toString().slice(0, 500)}`);
  return { agg, ranks, xlsxOk: py.status === 0 };
}

module.exports = { writeReport, renderFiles, aggregate, rankings, scoreRow, median, versionLine };
