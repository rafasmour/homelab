'use strict';
// TTS benchmark version (see lib/version.js and README "Benchmark versions").
// Bump when the text set (data/tts-texts.json), the voices, the judge rules, the audio sanity checks or the score formula change.
// The fingerprint hashes the benchmark code, voices.json, lib/speech.js, the STT overrides used by the judges and the text snapshot.
const fs = require('node:fs');
const path = require('node:path');

const BENCHMARK_VERSION = '1.0.0';

const CHANGELOG = [
  { version: '1.0.0', date: '2026-11-04', summary: 'Texts from Hermes answers (35 items: en + el), round-trip WER by the best STT judge, five audio sanity checks, RTF; score 60% intelligibility + 25% sanity + 15% speed.' },
];

const backfill = (runName) => (runName >= '2026-11-04_00-00' ? '1.0.0' : null);

const fingerprintFiles = () => {
  const dbPath = process.env.BENCH_DB || path.join(__dirname, '..', '..', 'data', 'benchmark.db');
  const texts = process.env.TTS_TEXTS_FILE || path.join(path.dirname(dbPath), 'tts-texts.json');
  return [
    path.join(__dirname, 'tts-benchmark.js'), path.join(__dirname, 'voices.json'), path.join(__dirname, '..', '..', 'lib', 'speech.js'),
    path.join(__dirname, '..', 'stt', 'models.json'), ...[texts].filter((f) => fs.existsSync(f)),
  ];
};

module.exports = { version: BENCHMARK_VERSION, BENCHMARK_VERSION, changelog: CHANGELOG, fingerprintFiles, backfill };
