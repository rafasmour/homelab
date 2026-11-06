'use strict';
// Shared helpers of the speech benchmarks (stt, tts): text normalisation and WER/CER, WAV analysis,
// audio.cpp model discovery (GGUF header) and the audiocpp_cli wrapper (docker exec into audiocpp-tts).
const fs = require('node:fs');
const path = require('node:path');
const { dockerExec, docker } = require('./docker');

const AUDIOCPP_CONTAINER = process.env.AUDIOCPP_CONTAINER || 'audiocpp-tts';
const CLI = '/opt/audiocpp/audiocpp_cli';
// The runner mounts speech/audiocpp/models read-only here; the audiocpp-tts container sees it as /models.
const MODELS_LOCAL = process.env.SPEECH_MODELS_DIR || '/speech-models';
const MODELS_REMOTE = '/models';

// ---------------------------------------------------------------- text scoring
/** Normalise like the STT evaluation (score.py): NFKC, lowercase, non letter/digit -> space; Greek drops accents, ς -> σ. */
function normWords(text, lang) {
  let t = String(text || '').normalize('NFKC').toLowerCase();
  if (lang === 'el') t = t.normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
  t = t.replace(/[^\p{L}\p{N}]/gu, ' ');
  return t.split(/\s+/).filter(Boolean);
}

/** Levenshtein distance between two sequences (arrays or strings; strings by code point). */
function editDistance(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] !== y[j - 1] ? 1 : 0));
    prev = cur;
  }
  return prev[y.length];
}

/** WER/CER of hypothesis vs reference after normalisation. Returns counts too so callers can pool them. */
function scoreText(ref, hyp, lang) {
  const rw = normWords(ref, lang);
  const hw = normWords(hyp, lang);
  const rc = rw.join(' ');
  const hc = hw.join(' ');
  const wordEdits = editDistance(rw, hw);
  const charEdits = editDistance(rc, hc);
  const refChars = Array.from(rc).length;
  return {
    ref_words: rw.length, word_edits: wordEdits, wer: rw.length ? wordEdits / rw.length : (hw.length ? 1 : 0),
    ref_chars: refChars, char_edits: charEdits, cer: refChars ? charEdits / refChars : (hc.length ? 1 : 0),
  };
}

// ---------------------------------------------------------------- stats
const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const round = (x, d = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---------------------------------------------------------------- WAV
/** Parse a PCM16/PCM24/PCM32/float32 RIFF WAV (any channel count; analysis is on the channel mean). */
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (start + size > buf.length) size = buf.length - start; // streamed WAVs may carry bogus sizes
    if (id === 'fmt ') fmt = { tag: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    else if (id === 'data') { data = buf.subarray(start, start + size); break; }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data chunk');
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      let v;
      if (fmt.tag === 3 && fmt.bits === 32) v = data.readFloatLE(o);
      else if (fmt.bits === 16) v = data.readInt16LE(o) / 32768;
      else if (fmt.bits === 24) v = data.readIntLE(o, 3) / 8388608;
      else if (fmt.bits === 32) v = data.readInt32LE(o) / 2147483648;
      else if (fmt.bits === 8) v = (data.readUInt8(o) - 128) / 128;
      else throw new Error(`unsupported WAV format tag ${fmt.tag} bits ${fmt.bits}`);
      s += v;
    }
    samples[i] = s / fmt.channels;
  }
  return { rate: fmt.rate, channels: fmt.channels, samples, duration: frames / fmt.rate };
}

/**
 * Audio sanity numbers of a mono signal: duration, RMS/peak (dBFS), clipping ratio, leading/trailing/internal
 * silence ratios (20 ms frames below -45 dBFS; "internal" = silent frames between the first and last voiced frame).
 */
function analyseAudio({ rate, samples, duration }, { silenceDb = -45, frameMs = 20 } = {}) {
  const n = samples.length;
  if (!n) return { sample_rate: rate, duration_s: 0, rms_dbfs: -120, peak_dbfs: -120, clip_ratio: 0, lead_silence_s: 0, trail_silence_s: 0, internal_silence_ratio: 0, silence_ratio: 1 };
  let peak = 0;
  let sq = 0;
  let clip = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sq += a * a;
    if (a >= 0.999) clip++;
  }
  const db = (x) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
  const fl = Math.max(1, Math.round((rate * frameMs) / 1000));
  const frames = [];
  for (let i = 0; i < n; i += fl) {
    let s = 0;
    const e = Math.min(n, i + fl);
    for (let j = i; j < e; j++) s += samples[j] * samples[j];
    frames.push(db(Math.sqrt(s / (e - i))) < silenceDb);
  }
  let first = frames.findIndex((x) => !x);
  let last = frames.length - 1;
  while (last >= 0 && frames[last]) last--;
  if (first < 0) { first = frames.length; last = frames.length - 1; }
  const fs_ = fl / rate;
  let internal = 0;
  for (let i = first; i <= last; i++) if (frames[i]) internal++;
  const voicedSpan = Math.max(0, last - first + 1);
  return {
    sample_rate: rate, duration_s: duration, rms_dbfs: db(Math.sqrt(sq / n)), peak_dbfs: db(peak), clip_ratio: clip / n,
    lead_silence_s: first * fs_, trail_silence_s: (frames.length - 1 - last) * fs_, internal_silence_ratio: voicedSpan ? internal / voicedSpan : 0,
    silence_ratio: frames.filter(Boolean).length / frames.length,
  };
}

/** Median fundamental frequency (Hz) by autocorrelation on voiced 40 ms frames (60-400 Hz); null if nothing voiced. */
function medianPitch({ rate, samples }, { maxFrames = 60 } = {}) {
  const win = Math.round(rate * 0.04);
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(win - 1, Math.floor(rate / 60));
  const hop = Math.max(win, Math.floor(samples.length / maxFrames));
  const f0s = [];
  for (let s = 0; s + win + maxLag < samples.length; s += hop) {
    let e0 = 0;
    for (let i = 0; i < win; i++) e0 += samples[s + i] * samples[s + i];
    if (e0 / win < 1e-4) continue;
    let best = 0;
    let bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < win; i++) c += samples[s + i] * samples[s + i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    if (bestLag && best / e0 > 0.5) f0s.push(rate / bestLag);
  }
  return f0s.length >= 3 ? median(f0s) : null;
}

// ---------------------------------------------------------------- models (GGUF header)
const QUANT_RE = /(q[2-8]_(?:k(?:_[sml])?|[01])|iq[1-4]_[a-z]+)/i;
const FLOAT_RE = /(^|[-_.])(f16|f32|fp16|fp32|bf16)([-_.]|$)/i;

/** Read audio.cpp metadata (family, category, languages) from the start of a GGUF. */
function readGgufInfo(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.toString('latin1', 0, n);
    const family = (head.match(/audiocpp\.model_spec\.family[\s\S]{0,12}?([a-z0-9_]{3,40})/) || [])[1] || null;
    const category = (head.match(/"category":"([a-z_]+)"/) || [])[1] || null;
    const langs = (head.match(/"languages":\[([^\]]*)\]/) || [])[1];
    const tasks = (head.match(/"tasks":\[([^\]]*)\]/) || [])[1];
    return {
      family, category,
      languages: langs ? langs.split(',').map((s) => s.replace(/["\s]/g, '')).filter(Boolean) : null,
      tasks: tasks ? tasks.split(',').map((s) => s.replace(/["\s]/g, '')).filter(Boolean) : null,
    };
  } finally { fs.closeSync(fd); }
}

/** Every quantized GGUF under the models dir (skips float variants, _build/_asr-eval/dl dirs). */
function findGgufs(root = MODELS_LOCAL, depth = 3) {
  const out = [];
  const walk = (dir, d) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (d < depth && !e.name.startsWith('.') && !e.name.startsWith('_') && !['_build', 'src', 'ref', 'staged', 'dl'].includes(e.name)) walk(p, d + 1); } else if (e.name.endsWith('.gguf')) out.push(p);
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Quantized audio.cpp models of a kind ('asr' | 'tts'), from GGUF headers. `overrides` (models.json) can rename,
 * restrict languages or add CLI args (extraArgs always, langArgs per language) per id. Float GGUFs are never listed. Returns
 * [{id, file, remote, family, quant, size_mb, languages, extraArgs}].
 */
function discoverModels(kind, overrides = {}) {
  const out = [];
  if (!fs.existsSync(MODELS_LOCAL)) return out;
  for (const file of findGgufs()) {
    const base = path.basename(file, '.gguf');
    if (FLOAT_RE.test(base)) continue;
    const q = (base.match(QUANT_RE) || [])[1];
    if (!q) continue;
    let info;
    try { info = readGgufInfo(file); } catch { continue; }
    if (!info.family || (info.category && info.category !== kind) || (!info.category && !(info.tasks || []).includes(kind))) continue;
    const ov = overrides[base] || {};
    if (ov.skip) continue;
    out.push({
      id: ov.id || base, file, remote: path.posix.join(MODELS_REMOTE, path.relative(MODELS_LOCAL, file).split(path.sep).join('/')),
      family: ov.family || info.family, quant: q.toLowerCase(), size_mb: Math.round(fs.statSync(file).size / 1048576),
      // Language tags like el-GR (Nemotron) count as their base code (el).
      languages: ov.languages || (info.languages ? [...new Set(info.languages.map((l) => l.split(/[-_]/)[0].toLowerCase()))] : null),
      extraArgs: ov.extraArgs || [], langArgs: ov.langArgs || null,
      voices: ov.voices || null, notes: ov.notes || '',
    });
  }
  return out;
}

// ---------------------------------------------------------------- audiocpp_cli
/** Run audiocpp_cli inside audiocpp-tts. Returns {code, stdout, stderr, ms, timedOut}. */
function runCli(args, opts = {}) {
  return dockerExec(AUDIOCPP_CONTAINER, [CLI, ...args], { timeoutMs: 30 * 60_000, maxBytes: 64 * 1024 * 1024, ...opts });
}

/** Run a shell snippet inside audiocpp-tts. */
function sh(script, opts = {}) {
  return dockerExec(AUDIOCPP_CONTAINER, ['sh', '-c', script], { timeoutMs: 120_000, ...opts });
}

/** Copy a file out of audiocpp-tts to a local path. */
async function copyOut(remote, local) {
  fs.mkdirSync(path.dirname(local), { recursive: true });
  const r = await docker(['cp', `${AUDIOCPP_CONTAINER}:${remote}`, local], { timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`docker cp ${remote}: ${r.stderr.slice(0, 200)}`);
}

/**
 * Parse the stdout of a batch run: one block per `request_id=`. Returns
 * Map<id, {text, wall_ms, audio_ms, rtf, peak_rss_mb, raw}>.
 */
function parseBatchOutput(stdout) {
  const res = new Map();
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    let m = line.match(/^request_id=(.+)$/);
    if (m) { cur = { id: m[1].trim(), text: null }; res.set(cur.id, cur); continue; }
    m = line.match(/^text_output=(.*)$/);
    if (m && cur) { cur.text = m[1]; continue; }
    m = line.match(/^metrics\[(.+?)\]\.([a-z_.]+)=(.*)$/);
    if (m) {
      const r = res.get(m[1]) || (() => { const x = { id: m[1], text: null }; res.set(m[1], x); return x; })();
      const v = Number(m[3]);
      if (m[2] === 'wall_ms') r.wall_ms = v;
      else if (m[2] === 'audio_duration_ms') r.audio_ms = v;
      else if (m[2] === 'rtf') r.rtf = v;
      else if (m[2] === 'memory.peak_rss_mb') r.peak_rss_mb = v;
      else if (m[2] === 'sample_rate') r.sample_rate = v;
    }
  }
  return res;
}

module.exports = {
  AUDIOCPP_CONTAINER, MODELS_LOCAL, MODELS_REMOTE, normWords, editDistance, scoreText, median, mean, round,
  parseWav, analyseAudio, medianPitch, readGgufInfo, findGgufs, discoverModels, runCli, sh, copyOut, parseBatchOutput,
};
