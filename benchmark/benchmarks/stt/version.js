'use strict';
// STT benchmark version (see lib/version.js and README "Benchmark versions").
// Bump when the clip set, WER/CER normalisation or scoring, the pass threshold or the per-model overrides change.
// The fingerprint hashes the benchmark code, models.json, lib/speech.js (normalisation, WER) and the clip manifest.
const fs = require('node:fs');
const path = require('node:path');

const BENCHMARK_VERSION = '1.0.0';

const CHANGELOG = [
  { version: '1.0.0', date: '2026-11-03', summary: 'FLEURS el/en subset (100 clips per language), WER/CER with the score.py normalisation, pass at WER <= 25%, RTF, load time, VRAM.' },
];

const backfill = (runName) => (runName >= '2026-11-03_00-00' ? '1.0.0' : null);

const fingerprintFiles = () => {
  const clips = process.env.STT_CLIPS_DIR || path.join(process.env.SPEECH_MODELS_DIR || '/speech-models', '_asr-eval', 'clips');
  return [
    path.join(__dirname, 'stt-benchmark.js'), path.join(__dirname, 'models.json'), path.join(__dirname, '..', '..', 'lib', 'speech.js'),
    ...[path.join(clips, 'manifest.jsonl')].filter((f) => fs.existsSync(f)),
  ];
};

module.exports = { version: BENCHMARK_VERSION, BENCHMARK_VERSION, changelog: CHANGELOG, fingerprintFiles, backfill };
