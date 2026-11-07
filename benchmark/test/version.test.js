'use strict';
// Benchmark versioning: constants, changelog, fingerprint, backfill thresholds, DB storage. Run from benchmark/:  node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ver-'));
process.env.BENCH_DB = path.join(tmp, 'v.db');
process.env.ROUTER_CONFIG = path.join(tmp, 'none.ini');
const db = require('../lib/db');
const versions = require('../lib/version');
const { versionLine } = require('../lib/report');
const mods = ['hermes', 'stt', 'tts'].map((n) => require(`../benchmarks/${n}`));

test('every benchmark declares a version that has a changelog entry and a fingerprint', () => {
  for (const b of mods) {
    assert.match(b.version, /^\d+\.\d+\.\d+$/, b.name);
    assert.ok(b.changelog.some((c) => c.version === b.version), `${b.name}: current version missing in changelog`);
    assert.strictEqual(b.changelog[b.changelog.length - 1].version, b.version, `${b.name}: newest changelog entry is last`);
    assert.ok(b.changelog.every((c) => c.summary && /^\d{4}-\d\d-\d\d$/.test(c.date)));
    assert.ok(b.fingerprintFiles().length > 0);
    assert.match(versions.info(b).fingerprint, /^[0-9a-f]{12}$/);
  }
});

test('hermes backfill follows the documented milestones', () => {
  const h = require('../benchmarks/hermes');
  const at = (n) => h.backfill(n);
  assert.strictEqual(at('2026-10-24_09-07'), '1.0.0');
  assert.strictEqual(at('2026-10-27_17-09'), '1.0.0');
  assert.strictEqual(at('2026-10-28_16-41'), '1.1.0');
  assert.strictEqual(at('2026-11-02_14-36'), '1.1.0');
  assert.strictEqual(at('2026-11-03_21-43'), '2.0.0');
  assert.strictEqual(at('2026-11-04_08-15'), '2.0.0');
  assert.strictEqual(at('2026-11-06_10-33'), '3.0.0');
  assert.strictEqual(at('2026-11-06_16-12'), '3.1.0');
  assert.strictEqual(at('2026-11-06_18-19'), '3.2.0');
  assert.strictEqual(at('2026-11-06_22-12'), '3.2.0');
  assert.strictEqual(at('2026-10-01_00-00'), null);
  for (const b of mods) for (const n of ['2026-10-24_09-07', '2026-11-06_23-56-2']) { const v = b.backfill(n); assert.ok(v === null || b.changelog.some((c) => c.version === v)); }
});

test('fingerprint changes with file content and is stable otherwise', () => {
  const f = path.join(tmp, 'task.md');
  fs.writeFileSync(f, 'prompt one');
  const a = versions.fingerprint([f]);
  assert.strictEqual(versions.fingerprint([f]), a);
  fs.writeFileSync(f, 'prompt two');
  assert.notStrictEqual(versions.fingerprint([f]), a);
});

test('migration is idempotent; versions round-trip through saveRun/loadRun and report.md', () => {
  const conn = db.open();
  db.migrate(conn);
  db.migrate(conn);
  assert.deepStrictEqual(conn.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version), [1, 2]);
  const run = {
    run_dir: path.join(tmp, '2026-11-07_10-00'), command: 'x', started_at: '2026-11-07T08:00:00Z', finished_at: '2026-11-07T08:05:00Z', models: [], notes: [], gpu: null, cleanup: {},
    benchmarks: [{ name: 'hermes', description: 'd', version: '3.2.0', fingerprint: 'abc123abc123', version_summary: 'sum', version_date: '2026-11-06',
      results: [{ benchmark: 'hermes', model: 'm', case_id: 'c', group: 'g', kind: 'chat', repeat: 1, status: 'pass', score: 100, checks: [] }] }],
  };
  assert.ok(db.saveRun(conn, run));
  const back = db.loadRun(conn, '2026-11-07_10-00');
  assert.strictEqual(back.benchmarks[0].version, '3.2.0');
  assert.strictEqual(back.benchmarks[0].fingerprint, 'abc123abc123');
  assert.strictEqual(conn.prepare('SELECT summary FROM benchmark_versions').get().summary, 'sum');
  assert.match(versionLine(back.benchmarks[0]), /3\.2\.0 \(fingerprint abc123abc123\)/);
  assert.match(versionLine({ version: '1.0.0', fingerprint: null, version_source: 'backfill' }), /assigned afterwards/);
  db.saveRun(conn, run); // the next case saves the same run again: still one row
  assert.strictEqual(conn.prepare('SELECT COUNT(*) n FROM run_benchmarks').get().n, 1);
});
