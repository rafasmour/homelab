#!/usr/bin/env node
'use strict';
// The only benchmark runner.
//   docker exec benchmark npm run benchmark -- [model ...|all] [--only a,b] [--cases x,y]
//     [--profiles p,q] [--repeat N] [--list] [--dry-run]
//   docker exec benchmark npm run import -- reports/<run> [--models a,b]
//   docker exec benchmark npm run rescore -- [run ...]
const fs = require('node:fs');
const path = require('node:path');
const router = require('./lib/router');
const { GpuMonitor } = require('./lib/gpu');
const { writeReport, aggregate, renderFiles, scoreRow } = require('./lib/report');
const db = require('./lib/db');

const REPORTS = path.join(__dirname, 'reports');
const LOCK = path.join(REPORTS, '.running.lock');
const PRODUCTION_MODEL = process.env.PRODUCTION_MODEL || 'ornith-1.5-9b-mtp';
const TZ = process.env.TZ || 'Europe/Athens';

const USAGE = `Usage: npm run benchmark -- [model ...|all] [options]

Positional: router model ids/aliases (GET /models). "all" or none = every preset
model (vision variants and disabled presets are skipped).

Options:
  --only a,b        run only these benchmarks (default: all under benchmarks/ except the opt-in speech
                    benchmarks stt and tts, which use their own audio.cpp model ids and never touch llama.cpp)
  --cases x,y       run only these case ids
  --profiles p,q    run only cases of these Hermes profiles (default, finance, ...)
  --with-optin      add the opt-in group (ai-assistant) to the default selection
  --web             add the web cases (front matter web: true; they need the web search/extract tools)
  --repeat N        run each case N times (default 1)
  --list            list benchmarks, cases and models, then exit
  --dry-run         print the plan without loading models or calling them
  -h, --help        this help

Import an existing report folder into the SQLite DB (idempotent upsert by run + model + case + repeat):
  npm run import -- reports/<YYYY-MM-DD_HH-MM> [more dirs] [--models a,b]

Re-grade stored runs (default: all) with the current checks and scoring; backs up the DB first:
  npm run rescore -- [YYYY-MM-DD_HH-MM ...]

Example:
  docker exec benchmark npm run benchmark -- qwen-3.6-35b-a3b --only hermes --cases cron-ai-news`;

function parseArgs(argv) {
  const o = { models: [], only: null, cases: null, profiles: null, repeat: 1, list: false, dryRun: false, withOptin: false, web: false };
  const csv = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') { o.help = true; }
    else if (a === '--list') o.list = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--with-optin') o.withOptin = true;
    else if (a === '--web') o.web = true;
    else if (a.startsWith('--only')) o.only = csv(val());
    else if (a.startsWith('--cases')) o.cases = csv(val());
    else if (a.startsWith('--profiles')) o.profiles = csv(val());
    else if (a.startsWith('--repeat')) { o.repeat = Number(val()); if (!(o.repeat >= 1)) throw new Error('--repeat must be >= 1'); }
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.models.push(a);
  }
  return o;
}

function discoverBenchmarks() {
  const dir = path.join(__dirname, 'benchmarks');
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const idx = path.join(dir, name, 'index.js');
    if (!fs.existsSync(idx)) continue;
    const b = require(idx);
    for (const k of ['name', 'description', 'listCases', 'run']) if (!b[k]) throw new Error(`benchmarks/${name}/index.js does not export ${k}`);
    out.push(b);
  }
  return out;
}

function stamp() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}`;
}

function makeRunDir() {
  const base = path.join(REPORTS, stamp());
  let dir = base;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${base}-${n}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function log(...a) {
  const t = new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour12: false });
  console.log(`[${t}]`, ...a);
}

function acquireLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
    try { process.kill(cur.pid, 0); throw new Error(`another run is active (pid ${cur.pid}, started ${cur.started}, ${cur.run_dir})`); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  return () => { try { fs.unlinkSync(LOCK); } catch { /* gone */ } };
}

async function resolveModels(requested) {
  const all = await router.listModels();
  const presets = await router.presetModels();
  if (!requested.length || requested.includes('all')) return presets.map((m) => m.id);
  return requested.map((id) => {
    const m = all.find((x) => x.id === id || x.aliases.includes(id));
    if (!m) throw new Error(`unknown model "${id}". Known: ${presets.map((x) => x.id).join(', ')}`);
    return m.id;
  });
}

function readResults(dir) {
  const file = path.join(dir, 'results.json');
  // A running run rewrites results.json after every case: retry a torn read.
  for (let i = 0; ; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (i >= 5 || e.code === 'ENOENT') throw new Error(`cannot read ${file}: ${e.message}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}

/** `main.js import <dir...> [--models a,b]`: load results.json (+ transcripts) into SQLite. Never writes to the report folder. */
function importReports(argv) {
  const dirs = [];
  let models = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models' || a.startsWith('--models=')) models = (a.includes('=') ? a.slice(a.indexOf('=') + 1) : argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a.startsWith('-')) throw new Error(`unknown import option ${a}`);
    else dirs.push(a);
  }
  if (!dirs.length) throw new Error('usage: main.js import <reports/dir> [more dirs] [--models a,b]');
  const benches = Object.fromEntries(discoverBenchmarks().map((b) => [b.name, b]));
  const conn = db.open();
  for (const d of dirs) {
    const dir = path.resolve(d);
    const data = readResults(dir);
    const name = path.basename(dir);
    const keep = (m) => !models || models.includes(m);
    const run = {
      ...data, run_dir: data.run_dir || dir,
      models: (data.models || []).filter((m) => keep(m.id)),
      benchmarks: (data.benchmarks || []).map((b) => ({
        name: b.name, description: b.description,
        results: (b.results || []).filter((r) => keep(r.model)).map((r) => {
          const row = { ...r };
          const hook = benches[b.name] && benches[b.name].enrichFromTranscript;
          if (hook && row.transcript) {
            let t = null;
            try { t = JSON.parse(fs.readFileSync(path.join(dir, row.transcript), 'utf8')); } catch { /* missing transcript */ }
            hook(row, t);
          }
          return row;
        }),
      })),
    };
    const runId = db.saveRun(conn, run, { name });
    const stored = db.loadRun(conn, name);
    db.saveStats(conn, runId, aggregate(stored));
    const n = stored.benchmarks.reduce((a, b) => a + b.results.length, 0);
    console.log(`imported ${name}: ${n} result(s), ${new Set(stored.benchmarks.flatMap((b) => b.results.map((r) => r.model))).size} model(s), status ${stored.status} -> ${db.DEFAULT_PATH}`);
  }
  return 0;
}

/**
 * `main.js rescore [run ...]`: re-grade stored runs with the current rules. Each benchmark's rescoreRow
 * hook recomputes the checks it can grade offline (from the transcript); every row is then re-scored, and
 * the run aggregates and report files are regenerated. Takes the run lock and backs up the DB first.
 */
async function rescore(argv) {
  const release = acquireLock();
  try {
    const benches = Object.fromEntries(discoverBenchmarks().map((b) => [b.name, b]));
    const conn = db.open();
    const names = argv.length ? argv : conn.prepare('SELECT name FROM runs ORDER BY name').all().map((r) => r.name);
    const bak = `${db.DEFAULT_PATH}.bak-${stamp()}`;
    conn.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`);
    console.log(`backup: ${bak}`);
    for (const name of names) {
      const run = db.loadRun(conn, name);
      if (!run) { console.log(`${name}: not in the DB, skipped`); continue; }
      const dir = path.join(REPORTS, name);
      const changes = [];
      for (const b of run.benchmarks) {
        const hook = benches[b.name] && benches[b.name].rescoreRow;
        for (const row of b.results) {
          const before = { status: row.status, score: row.score };
          if (hook) {
            let t = null;
            if (row.transcript) { try { t = JSON.parse(fs.readFileSync(path.join(dir, row.transcript), 'utf8')); } catch { /* missing transcript */ } }
            await hook(row, t);
          }
          row.score = scoreRow(row);
          if (row.score !== before.score || row.status !== before.status) {
            changes.push(`  ${row.model} ${row.case_id}: ${before.status} ${before.score} -> ${row.status} ${row.score}${row.status === 'fail' ? ` (${row.checks.filter((c) => c.pass === false).map((c) => `${c.name}: ${c.reason}`).join('; ')})` : ''}`);
          }
        }
      }
      const runId = db.saveRun(conn, run, { name, status: run.status });
      const view = { ...db.loadRun(conn, name), run_dir: dir };
      if (fs.existsSync(dir)) renderFiles(view, { log: console.log, dbInfo: { conn, runId, name } });
      else db.saveStats(conn, runId, aggregate(view));
      console.log(`${name}: ${changes.length} result(s) changed`);
      for (const c of changes) console.log(c);
    }
  } finally { release(); }
  return 0;
}

async function main() {
  if (process.argv[2] === 'import') return importReports(process.argv.slice(3));
  if (process.argv[2] === 'rescore') return rescore(process.argv.slice(3));
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); return 0; }
  let benches = discoverBenchmarks();
  if (opts.only) {
    const unknown = opts.only.filter((n) => !benches.some((b) => b.name === n));
    if (unknown.length) throw new Error(`unknown benchmark(s): ${unknown.join(', ')}`);
    benches = benches.filter((b) => opts.only.includes(b.name));
  } else benches = benches.filter((b) => !b.optin); // speech benchmarks (stt, tts) run only when named with --only
  // Opt-in cases (front matter `optin: true`, the ai-assistant group) run only when selected by --cases or --profiles.
  const caseOpts = { cases: opts.cases, profiles: opts.profiles, defaultSelection: !opts.cases && !opts.profiles, withOptin: opts.withOptin, web: opts.web };

  if (opts.list) {
    for (const b of benches) {
      console.log(`\nBenchmark ${b.name}: ${b.description}`);
      for (const c of b.listCases({ web: true, withOptin: true })) console.log(`  ${b.describeCase ? await b.describeCase(c) : c.id}`);
    }
    for (const b of benches.filter((x) => x.ownModels)) {
      console.log(`\nModels of ${b.name} (audio.cpp GGUF, quantized only):`);
      for (const m of b.ownModels()) console.log(`  ${m.id.padEnd(34)} family=${m.family} quant=${m.quant} ${m.size_mb} MB${m.languages ? ` langs=${m.languages.length > 6 ? `${m.languages.length} languages` : m.languages.join(',')}` : ''}`);
    }
    if (!benches.some((b) => !b.ownModels)) return 0; // speech-only listing never touches llama.cpp
    const models = await router.listModels();
    console.log('\nModels (router GET /models):');
    for (const m of models) {
      const tested = m.source === 'preset' && !/-vision$/.test(m.id) && !/dflash/i.test(m.id);
      console.log(`  ${m.id.padEnd(28)} ${String(m.status).padEnd(10)} source=${m.source}${tested ? '' : '  (skipped by "all")'}`);
    }
    return 0;
  }

  // Benchmarks with their own model list (ownModels, the speech benchmarks) never use the llama.cpp router.
  const ownIds = new Set(benches.filter((b) => b.ownModels).flatMap((b) => b.ownModels().map((m) => m.id)));
  const routerRequested = opts.models.filter((m) => !ownIds.has(m));
  let plan = benches.map((b) => ({ b, cases: b.listCases(caseOpts) })).filter((p) => p.cases.length);
  // Only speech model ids named on the command line: skip the router benchmarks.
  if (opts.models.length && !routerRequested.length) plan = plan.filter((p) => p.b.ownModels);
  const models = plan.some((p) => !p.b.ownModels) ? await resolveModels(routerRequested) : [];
  if (routerRequested.length && !plan.some((p) => !p.b.ownModels)) throw new Error(`unknown model(s) for the selected benchmark(s): ${routerRequested.join(', ')}. Speech models: ${[...ownIds].join(', ')}`);
  const ownSel = (b) => {
    const all = b.ownModels();
    const want = opts.models.filter((m) => all.some((x) => x.id === m));
    return want.length || !opts.models.length || opts.models.includes('all') ? (want.length ? all.filter((x) => want.includes(x.id)) : all) : [];
  };
  if (opts.cases) {
    const known = new Set(benches.flatMap((b) => b.listCases({ web: true }).map((c) => c.id)));
    const unknown = opts.cases.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(`unknown case(s): ${unknown.join(', ')}`);
  }
  if (!plan.length) throw new Error('no cases selected');
  const routerPlan = plan.filter((p) => !p.b.ownModels);
  const ownPlan = plan.filter((p) => p.b.ownModels);
  const total = models.length * routerPlan.reduce((a, p) => a + p.cases.length, 0) * opts.repeat
    + ownPlan.reduce((a, p) => a + ownSel(p.b).length * p.cases.length, 0) * opts.repeat;

  if (opts.dryRun) {
    console.log(`Dry run: ${total} case run(s)`);
    if (models.length) console.log(`Models: ${models.join(', ')}`);
    for (const p of ownPlan) console.log(`${p.b.name} models (${ownSel(p.b).length}): ${ownSel(p.b).map((m) => m.id).join(', ')}`);
    for (const p of plan) {
      console.log(`\n${p.b.name}:`);
      for (const c of p.cases) console.log(`  ${p.b.describeCase ? await p.b.describeCase(c) : c.id}`);
    }
    console.log(`\n${routerPlan.length ? `After the run: reload ${PRODUCTION_MODEL}. ` : ''}Reports: reports/<YYYY-MM-DD_HH-MM>/`);
    return 0;
  }

  fs.mkdirSync(REPORTS, { recursive: true });
  const release = acquireLock();
  const runDir = makeRunDir();
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, started: new Date().toISOString(), run_dir: runDir }));
  const run = {
    run_dir: runDir,
    command: `npm run benchmark -- ${process.argv.slice(2).join(' ')}`,
    started_at: new Date().toISOString(),
    finished_at: null,
    aborted: false,
    abort_reason: null,
    notes: [],
    models: [],
    benchmarks: plan.map((p) => ({ name: p.b.name, description: p.b.description, results: [] })),
    gpu: null,
    cleanup: {},
  };
  const snapshots = {};
  const ac = new AbortController();
  const abortRun = async (reason) => {
    if (run.aborted) return;
    run.aborted = true;
    run.abort_reason = reason;
    log(`ABORT: ${reason}`);
    ac.abort();
    for (const p of plan) if (p.b.abort) await p.b.abort();
  };
  const gpu = new GpuMonitor({ intervalMs: routerPlan.length ? 15_000 : 2_000, onOverheat: (s) => abortRun(`GPU VRAM temperature ${s.mem_c} °C >= 104 °C for 60 s`) });
  gpu.start();
  const save = () => {
    run.gpu = { peaks: gpu.peaks, samples: gpu.samples.length, overall_peak: gpu.peakFor('') };
    writeReport(run, { log });
    // Benchmarks with a `summarize` hook (speech) also get their own <name>-summary.md next to report.md.
    for (const [i, p] of plan.entries()) {
      if (!p.b.summarize) continue;
      try { fs.writeFileSync(path.join(runDir, `${p.b.name}-summary.md`), p.b.summarize({ results: run.benchmarks[i].results, models: run.models, notes: run.notes })); } catch (e) { log(`summary failed: ${e.message}`); }
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { abortRun(`received ${sig}`); });

  log(`Run ${path.basename(runDir)}: ${models.length + ownPlan.reduce((a, p) => a + ownSel(p.b).length, 0)} model(s), ${total} case run(s). Report: ${runDir}`);
  try {
    for (const p of plan) {
      if (!p.b.prepareRun) continue;
      log(`${p.b.name}: snapshot before the run`);
      snapshots[p.b.name] = await p.b.prepareRun();
      if (snapshots[p.b.name] && snapshots[p.b.name].errors && snapshots[p.b.name].errors.length) log(`  snapshot warnings: ${snapshots[p.b.name].errors.join('; ')}`);
    }
    for (const [mi, model] of models.entries()) {
      if (run.aborted) break;
      log(`[${mi + 1}/${models.length}] loading ${model}`);
      gpu.setLabel(`${model}:load`);
      let lr = await router.load(model, { log: (m) => log(`  ${m}`) });
      if (!lr.ok && !run.aborted) {
        log(`  load failed (${lr.error}); retrying once`);
        await new Promise((r) => setTimeout(r, 15_000));
        lr = await router.load(model, { log: (m) => log(`  ${m}`) });
      }
      const mrec = { id: model, load_status: lr.ok ? 'loaded' : 'load_failed', load_ms: lr.ms, load_error: lr.error || null, gpu_peak: null };
      run.models.push(mrec);
      log(lr.ok ? `  loaded in ${Math.round(lr.ms / 1000)} s` : `  LOAD FAILED: ${lr.error}`);
      gpu.setLabel(`${model}:run`);
      for (const [pi, p] of plan.entries()) {
        if (p.b.ownModels) continue;
        if (!lr.ok) {
          for (const c of p.cases) run.benchmarks[pi].results.push({
            benchmark: p.b.name, model, case_id: c.id, group: c.profile || c.group || '', kind: c.kind || '', repeat: 1,
            status: 'load_failed', duration_s: null, exit_code: null, tokens_in: 0, tokens_out: 0, api_calls: 0, tool_calls: 0,
            tool_errors: 0, answer_chars: 0, checks: [], failure_types: ['load_failed'], leftovers: [], transcript: null, notes: lr.error || '',
          });
          continue;
        }
        const rows = await p.b.run({
          model, cases: p.cases, repeat: opts.repeat, runDir, log, signal: ac.signal,
          isAborted: () => run.aborted,
          onRow: (row) => { run.benchmarks[pi].results.push(row); save(); },
        });
        // Rows are pushed through onRow; keep any a benchmark returned without it.
        for (const r of rows) if (!run.benchmarks[pi].results.includes(r)) run.benchmarks[pi].results.push(r);
      }
      mrec.gpu_peak = gpu.peakFor(`${model}:`);
      save();
    }
    // Speech benchmarks: own model lists, no llama.cpp calls. Nothing else of ours should be running.
    for (const [pi, p] of plan.entries()) {
      if (!p.b.ownModels || run.aborted) continue;
      const own = ownSel(p.b);
      gpu.setLabel('baseline');
      const base = await require('./lib/gpu').sampleOnce().catch(() => null);
      if (base) {
        const note = `${p.b.name}: baseline VRAM in use before the run ${base.vram_used_gib} GiB${base.vram_used_gib > 3 ? ' (an LLM or other GPU model appears to be loaded: latency numbers are not idle-GPU numbers)' : ' (idle GPU: no LLM loaded)'}`;
        run.notes.push(note);
        log(note);
      }
      for (const [mi, m] of own.entries()) {
        if (run.aborted) break;
        log(`[${p.b.name} ${mi + 1}/${own.length}] ${m.id}`);
        const mrec = { id: m.id, load_status: 'loaded', load_ms: null, load_error: null, gpu_peak: null, baseline_vram_gib: base ? base.vram_used_gib : null };
        run.models.push(mrec);
        gpu.setLabel(`${m.id}:run`);
        try {
          const rows = await p.b.run({
            model: m.id, modelInfo: m, mrec, gpu, cases: p.cases, repeat: opts.repeat, runDir, log, signal: ac.signal,
            isAborted: () => run.aborted, notes: run.notes,
            onRow: (row) => { run.benchmarks[pi].results.push(row); },
          });
          for (const r of rows) if (!run.benchmarks[pi].results.includes(r)) run.benchmarks[pi].results.push(r);
        } catch (e) {
          mrec.load_status = 'load_failed';
          mrec.load_error = e.message;
          log(`  ${m.id} failed: ${e.message}`);
        }
        mrec.gpu_peak = gpu.peakFor(`${m.id}:`);
        save();
      }
    }
  } catch (e) {
    run.notes.push(`runner error: ${e.stack || e.message}`);
    log(`runner error: ${e.message}`);
  } finally {
    for (const p of plan) {
      if (!p.b.finalCleanup) continue;
      log(`${p.b.name}: final cleanup`);
      try {
        run.cleanup[p.b.name] = await p.b.finalCleanup(snapshots[p.b.name]);
        const c = run.cleanup[p.b.name];
        log(`  removed ${c.removed.length}, left over ${c.leftovers.length}, verification ${JSON.stringify(c.verification)}`);
      } catch (e) {
        run.cleanup[p.b.name] = { removed: [], leftovers: [], verification: {}, error: e.message };
        log(`  cleanup error: ${e.message}`);
      }
    }
    if (routerPlan.length) {
      gpu.setLabel('restore');
      log(`restoring production model ${PRODUCTION_MODEL}`);
      const r = await router.load(PRODUCTION_MODEL, { log: (m) => log(`  ${m}`) }).catch((e) => ({ ok: false, error: e.message }));
      run.notes.push(r.ok ? `production model ${PRODUCTION_MODEL} reloaded` : `could not reload ${PRODUCTION_MODEL}: ${r.error}`);
    }
    gpu.stop();
    run.finished_at = new Date().toISOString();
    save();
    release();
    log(`Done. ${path.join(runDir, 'report.md')}`);
  }
  return run.aborted ? 2 : 0;
}

main().then((code) => process.exit(code), (e) => { console.error(`error: ${e.message}`); process.exit(1); });
