'use strict';
// Validation tests for api.js. Run from benchmark/:  node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-api-'));
process.env.BENCH_REPORTS = tmp;
process.env.BENCH_DB = path.join(tmp, 'none.db');
process.env.BENCH_API_TOKEN = 't'.repeat(32);
process.env.ROUTER_CONFIG = path.join(tmp, 'router.ini');
fs.writeFileSync(process.env.ROUTER_CONFIG, '[*]\nfit = off\n[good-model]\nmodel = /models/a/good.Q4_K_M.gguf\n[good-model-vision]\nmodel = /models/a/v.gguf\n');
const api = require('../api.js');

test('only benchmarkable presets are listed', () => {
  assert.deepStrictEqual(api.presetModels(), ['good-model']);
});

test('unknown model, bad suite, bad profile and extra fields are rejected', () => {
  for (const body of [{ model: 'nope' }, { model: '../x' }, { model: 'good-model-vision' }, { model: 'good-model', suite: 'x' },
    { model: 'good-model', profile: 'nope' }, { model: 'good-model', cmd: 'id' }, {}]) {
    assert.throws(() => api.startRun(body), (e) => e.status === 400, JSON.stringify(body));
  }
});

test('a second start is refused while a run holds the lock', () => {
  fs.writeFileSync(path.join(tmp, '.running.lock'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
  assert.throws(() => api.startRun({ model: 'good-model' }), (e) => e.status === 409);
  fs.unlinkSync(path.join(tmp, '.running.lock'));
});

test('a stale lock does not block', () => {
  fs.writeFileSync(path.join(tmp, '.running.lock'), JSON.stringify({ pid: 2 ** 22 + 7, started: 'x' }));
  assert.strictEqual(api.activeRun(), null);
});

test('cancel with nothing running is refused', () => {
  assert.throws(() => api.cancelRun(), (e) => e.status === 409);
});
