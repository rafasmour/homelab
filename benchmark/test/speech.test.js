'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sp = require('../lib/speech');

test('normWords: English punctuation, case, NFKC', () => {
  assert.deepEqual(sp.normWords('Hello, World! It’s 5 o’clock.', 'en'), ['hello', 'world', 'it', 's', '5', 'o', 'clock']);
  assert.deepEqual(sp.normWords('ＡＢＣ  def', 'en'), ['abc', 'def']);
});

test('normWords: Greek drops accents and folds final sigma', () => {
  assert.deepEqual(sp.normWords('Καλημέρα, κόσμος!', 'el'), ['καλημερα', 'κοσμοσ'.replace('σ', 'σ')]);
  assert.deepEqual(sp.normWords('ΚΑΛΗΜΈΡΑ κόσμος', 'el'), sp.normWords('καλημερα κοσμοσ', 'el'));
  // accents are kept for other languages
  assert.notDeepEqual(sp.normWords('café', 'en'), sp.normWords('cafe', 'en'));
});

test('editDistance and scoreText', () => {
  assert.equal(sp.editDistance(['a', 'b', 'c'], ['a', 'c']), 1);
  assert.equal(sp.editDistance('kitten', 'sitting'), 3);
  const s = sp.scoreText('the cat sat on the mat', 'The cat sit on mat.', 'en');
  assert.equal(s.ref_words, 6);
  assert.equal(s.word_edits, 2); // sat->sit, the deleted
  assert.ok(Math.abs(s.wer - 2 / 6) < 1e-9);
  assert.equal(sp.scoreText('abc', 'abc', 'en').wer, 0);
  assert.equal(sp.scoreText('', 'x', 'en').wer, 1);
  assert.equal(sp.scoreText('', '', 'en').wer, 0);
});

function wav(samples, rate = 16000) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), 44 + i * 2));
  return b;
}

test('parseWav + analyseAudio: leading/trailing/internal silence, clipping', () => {
  const rate = 16000;
  const tone = (n, f = 200, a = 0.3) => Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate));
  const sil = (n) => new Array(n).fill(0);
  const x = [...sil(rate / 2), ...tone(rate), ...sil(rate / 4), ...tone(rate), ...sil(rate)];
  const w = sp.parseWav(wav(x, rate));
  assert.equal(w.rate, rate);
  const a = sp.analyseAudio(w);
  assert.ok(Math.abs(a.lead_silence_s - 0.5) < 0.05, `lead ${a.lead_silence_s}`);
  assert.ok(Math.abs(a.trail_silence_s - 1) < 0.05, `trail ${a.trail_silence_s}`);
  assert.ok(Math.abs(a.internal_silence_ratio - 0.25 / 2.25) < 0.03, `internal ${a.internal_silence_ratio}`);
  assert.equal(a.clip_ratio, 0);
  assert.ok(Math.abs(a.peak_dbfs - 20 * Math.log10(0.3)) < 0.2);
  const clipped = sp.analyseAudio(sp.parseWav(wav(tone(rate, 200, 1.0), rate)));
  assert.ok(clipped.clip_ratio > 0.01);
  const f0 = sp.medianPitch(w);
  assert.ok(Math.abs(f0 - 200) < 5, `f0 ${f0}`);
});

test('parseBatchOutput reads text and metrics per request', () => {
  const out = 'request_index=0\nrequest_id=a\ntext_output=Hello there\nmetrics[a].wall_ms=120.5\nmetrics[a].audio_duration_ms=2000\nmetrics[a].memory.peak_rss_mb=1410\nrequest_index=1\nrequest_id=b\ntext_output=\nmetrics[b].wall_ms=10\n';
  const m = sp.parseBatchOutput(out);
  assert.equal(m.get('a').text, 'Hello there');
  assert.equal(m.get('a').wall_ms, 120.5);
  assert.equal(m.get('a').peak_rss_mb, 1410);
  assert.equal(m.get('b').text, '');
});
