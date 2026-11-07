'use strict';
// Benchmark entry for main.js: { name, description, listCases(opts), run(ctx) }.
// The implementation lives in hermes-benchmark.js.
const b = require('./hermes-benchmark');
Object.assign(b, require('./version')); // version, changelog, fingerprintFiles, backfill (lib/version.js)
module.exports = b;
