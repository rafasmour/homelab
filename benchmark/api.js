#!/usr/bin/env node
'use strict';
// Minimal job API of the runner (PID 1 of the `benchmark` container), used only by benchmark-mcp.
//   GET  /healthz            open
//   GET  /models             benchmarkable preset names (router-config.ini)
//   GET  /options            suites and profiles
//   POST /runs               {"model","suite","profile"}: start `main.js <model> [--cases ..] [--profiles ..]`
//   POST /runs/cancel        SIGTERM the active run (the runner aborts cleanly and reloads the production model)
//   GET  /status             active run, progress, last finished run
//   GET  /runs/latest | /runs/<run id>   scores and per-case rows
// Everything except /healthz needs `Authorization: Bearer $BENCH_API_TOKEN`. Arguments are validated against
// fixed enums and the preset list; the child is started with an argv array (no shell) and no free-form input.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const db = require('./lib/db');
const hermes = require('./benchmarks/hermes');

const PORT = 8780;
const REPORTS = process.env.BENCH_REPORTS || path.join(__dirname, 'reports'); // main.js uses ./reports; override for tests only
const LOCK = path.join(REPORTS, '.running.lock');
const LOG = path.join(REPORTS, '.api-last-run.log');
const DB_FILE = process.env.BENCH_DB || path.join(__dirname, 'data', 'benchmark.db');
const TOKEN = process.env.BENCH_API_TOKEN || '';
const SUITES = ['all', 'cron', 'chat'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUN_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d{1,3})?$/;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

let child = null; // { proc, pid, model, suite, profile, total, started_at, exit_code, ended_at, signal }

/** Models the runner would accept: presets of router-config.ini minus vision variants and drafters. */
function presetModels() {
  return Object.keys(db.routerPresets()).filter((id) => !/-vision$/.test(id) && !/dflash/i.test(id)).sort();
}
function profiles() { return [...new Set(hermes.listCases({}).map((c) => c.profile))].sort(); }

function lockInfo() {
  let cur;
  try { cur = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
  try { process.kill(cur.pid, 0); } catch (e) { if (e.code === 'ESRCH') return null; }
  return cur;
}
function activeRun() {
  if (child && child.exit_code === undefined && child.signal === undefined) return { source: 'api', pid: child.pid, started: child.started_at };
  const l = lockInfo();
  return l ? { source: 'lock', pid: l.pid, started: l.started, run_dir: l.run_dir || null } : null;
}

function readDb(fn) {
  if (!fs.existsSync(DB_FILE)) return null;
  const conn = new DatabaseSync(DB_FILE, { readOnly: true });
  try { conn.exec('PRAGMA busy_timeout = 5000'); return fn(conn); } finally { conn.close(); }
}

function startRun(body) {
  const keys = Object.keys(body || {});
  if (keys.some((k) => !['model', 'suite', 'profile'].includes(k))) throw new HttpError(400, 'unknown field');
  const { model, suite = 'all', profile = null } = body;
  if (typeof model !== 'string' || !MODEL_RE.test(model) || !presetModels().includes(model)) throw new HttpError(400, 'model is not a benchmarkable preset (see /models)');
  if (!SUITES.includes(suite)) throw new HttpError(400, `suite must be one of ${SUITES.join(', ')}`);
  if (profile !== null && (typeof profile !== 'string' || !profiles().includes(profile))) throw new HttpError(400, `profile must be one of ${profiles().join(', ')}`);
  const all = hermes.listCases({ profiles: profile ? [profile] : null, defaultSelection: !profile });
  const cases = all.filter((c) => suite === 'all' || (suite === 'cron') === (c.kind === 'cron'));
  if (!cases.length) throw new HttpError(400, 'no cases match that suite and profile');
  const act = activeRun();
  if (act) throw new HttpError(409, `a benchmark run is already active (pid ${act.pid}, started ${act.started})`);

  const args = ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'main.js'), model, '--cases', cases.map((c) => c.id).join(',')];
  fs.mkdirSync(REPORTS, { recursive: true });
  const fd = fs.openSync(LOG, 'w');
  const proc = spawn(process.execPath, args, { cwd: __dirname, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  child = { proc, pid: proc.pid, model, suite, profile, total: cases.length, started_at: new Date().toISOString() };
  const me = child;
  proc.on('exit', (code, signal) => { me.exit_code = code; me.signal = signal || undefined; if (code === null && signal) me.exit_code = null; me.ended_at = new Date().toISOString(); });
  proc.on('error', (e) => { me.exit_code = -1; me.error = e.code || 'spawn error'; me.ended_at = new Date().toISOString(); });
  return { started: true, model, suite, profile, cases: cases.length, pid: proc.pid };
}

function cancelRun() {
  const l = lockInfo();
  const pid = child && child.exit_code === undefined && child.signal === undefined ? child.pid : (l && l.pid);
  if (!pid) throw new HttpError(409, 'no benchmark run is active');
  let cmd = '';
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { /* gone */ }
  if (!/main\.js/.test(cmd) || /rescore|import/.test(cmd)) throw new HttpError(409, 'the active process is not a benchmark run');
  process.kill(pid, 'SIGTERM');
  return { cancelling: true, pid };
}

function tailLog(n = 12) {
  try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => l.slice(0, 300)); } catch { return []; }
}

function runSummary(conn, name) {
  const run = db.loadRun(conn, name);
  if (!run) return null;
  const stats = conn.prepare(`SELECT m.alias AS model, s.name, s.value, s.text FROM run_model_stats s JOIN runs r ON r.id = s.run_id
    JOIN models m ON m.id = s.model_id WHERE r.name = ?`).all(name);
  const byModel = {};
  for (const s of stats) (byModel[s.model] || (byModel[s.model] = {}))[s.name] = s.value ?? s.text;
  const rows = run.benchmarks.flatMap((b) => b.results);
  return {
    run_id: run.name, status: run.status, started_at: run.started_at, finished_at: run.finished_at, aborted: run.aborted,
    abort_reason: run.abort_reason, models: run.models.map((m) => ({ id: m.id, load_status: m.load_status, load_ms: m.load_ms })),
    scores: byModel,
    cases: rows.map((r) => ({ model: r.model, case_id: r.case_id, kind: r.kind, status: r.status, score: r.score, duration_s: r.duration_s,
      tool_calls: r.tool_calls, tool_errors: r.tool_errors, failure_types: r.failure_types })),
    report: `reports/${run.name}/report.md`,
  };
}

function latestName(conn) {
  const r = conn.prepare('SELECT name FROM runs ORDER BY started_at DESC, id DESC LIMIT 1').get();
  return r ? r.name : null;
}

function status() {
  const act = activeRun();
  const out = { active: Boolean(act), run: null, last_finished: null, log_tail: [] };
  const latest = readDb((conn) => {
    const name = latestName(conn);
    if (!name) return null;
    const s = runSummary(conn, name);
    return s && { run_id: s.run_id, status: s.status, started_at: s.started_at, finished_at: s.finished_at, aborted: s.aborted,
      abort_reason: s.abort_reason, rows: s.cases.length, models: s.models.map((m) => m.id), scores: s.scores };
  });
  if (act) {
    out.run = { ...act, model: child && child.model, suite: child && child.suite, profile: child && child.profile, cases_total: child && child.total,
      cases_done: latest && latest.status === 'running' ? latest.rows : 0, latest_run_id: latest && latest.status === 'running' ? latest.run_id : null };
    out.log_tail = tailLog();
  } else {
    out.last_finished = latest;
    if (child) { out.last_api_run = { model: child.model, suite: child.suite, profile: child.profile, exit_code: child.exit_code ?? null, signal: child.signal ?? null, ended_at: child.ended_at || null }; out.log_tail = tailLog(); }
  }
  return out;
}

function results(id) {
  if (id !== 'latest' && !RUN_RE.test(id)) throw new HttpError(400, 'bad run id');
  const r = readDb((conn) => runSummary(conn, id === 'latest' ? latestName(conn) : id));
  if (!r) throw new HttpError(404, 'no such run');
  return r;
}

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new HttpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!size) return resolve({});
      try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(b && typeof b === 'object' && !Array.isArray(b) ? b : {}); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'GET' && p === '/healthz') return { ok: true };
  if (!authorized(req)) throw new HttpError(401, 'unauthorized');
  if (req.method === 'GET' && p === '/models') return { models: presetModels() };
  if (req.method === 'GET' && p === '/options') return { suites: SUITES, profiles: profiles() };
  if (req.method === 'GET' && p === '/status') return status();
  if (req.method === 'POST' && p === '/runs') return startRun(await readBody(req));
  if (req.method === 'POST' && p === '/runs/cancel') return cancelRun();
  const m = p.match(/^\/runs\/([^/]+)$/);
  if (req.method === 'GET' && m) return results(decodeURIComponent(m[1]));
  throw new HttpError(404, 'not found');
}

function createServer() {
  return http.createServer(async (req, res) => {
    let status = 200; let body;
    try { body = await handle(req, res); } catch (e) {
      status = e instanceof HttpError ? e.status : 500;
      body = { error: e instanceof HttpError ? e.message : 'internal error' };
      if (status === 500) console.error(`api error: ${e.stack || e.message}`);
    }
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
}

module.exports = { createServer, startRun, cancelRun, presetModels, activeRun, HttpError };

if (require.main === module) {
  if (TOKEN.length < 16) { console.error('BENCH_API_TOKEN is missing or shorter than 16 characters'); process.exit(1); }
  const srv = createServer();
  srv.listen(PORT, '0.0.0.0', () => console.log(`benchmark job API on :${PORT}`));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (child && child.exit_code === undefined && child.proc) child.proc.kill('SIGTERM'); srv.close(); setTimeout(() => process.exit(0), 1500); });
}
