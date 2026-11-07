'use strict';
// Benchmark entry for main.js (see tts-benchmark.js).
const b = require('./tts-benchmark');
Object.assign(b, require('./version')); // version, changelog, fingerprintFiles, backfill (lib/version.js)
module.exports = b;
