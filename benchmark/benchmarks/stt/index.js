'use strict';
// Benchmark entry for main.js (see stt-benchmark.js).
const b = require('./stt-benchmark');
Object.assign(b, require('./version')); // version, changelog, fingerprintFiles, backfill (lib/version.js)
module.exports = b;
