'use strict';
// Text-to-speech benchmark. Every quantized audio.cpp TTS GGUF x voice (model alias "<gguf>@<voice>") speaks a fixed
// snapshot of Hermes answers (data/tts-texts.json, built by build-texts.js; personal data, ignored by Git).
// The audio is transcribed back by the best STT model per language (round-trip WER/CER) and checked for audio sanity.
// Synthesis runs through audiocpp_cli in the audiocpp-tts container (offline batch per model x voice x language).
// Scoring: see README "TTS benchmark" and scoreOf() below.
const fs = require('node:fs');
const path = require('node:path');
const sp = require('../../lib/speech');
const db = require('../../lib/db');
const sttOverrides = require('../stt/stt-benchmark').overrides; // langArgs etc. of the ASR models (judges)

const TEXTS_FILE = process.env.TTS_TEXTS_FILE || path.join(path.dirname(db.DEFAULT_PATH), 'tts-texts.json');
const VOICES = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'voices.json'), 'utf8')); } catch { return {}; } })();
const PARSED_BACK_WER = 0.10; // round-trip WER at or below this = "parsed back"
const CPS_RANGE = [8, 25]; // plausible speech rate, characters of text per second of audio
const LANGS = ['en', 'el'];
// Fallback judges when no STT run is stored in the DB and no TTS_JUDGE_<LANG> / TTS_JUDGE env is set.
// Defaults from the STT run 2026-11-03_22-12: Greek Parakeet for el (WER 12.4%), Qwen3-ASR 1.7B for en (WER 3.3%).
const DEFAULT_JUDGE = { el: 'parakeet-tdt-0.6b-v3-greek-q6_k', en: 'qwen3-asr-1.7b-q6_k' };

function loadTexts() {
  if (!fs.existsSync(TEXTS_FILE)) return [];
  const j = JSON.parse(fs.readFileSync(TEXTS_FILE, 'utf8'));
  return (j.items || []).map((i) => ({ id: `${i.lang}/${i.id}`, group: i.lang, kind: 'tts', lang: i.lang, stem: i.id, text: i.text, title: `${i.lang} ${i.id}` }));
}

function listCases({ cases, profiles } = {}) {
  let all = loadTexts();
  const limit = Number(process.env.SPEECH_LIMIT) || 0;
  if (limit) { const seen = {}; all = all.filter((c) => (seen[c.lang] = (seen[c.lang] || 0) + 1) <= limit); }
  if (profiles) all = all.filter((c) => profiles.includes(c.lang));
  if (cases) all = all.filter((c) => cases.includes(c.id) || cases.includes(c.lang));
  return all;
}

function describeCase(c) { return `${c.id.padEnd(10)} ${String(c.text.length).padStart(4)} chars  ${c.text.slice(0, 70)}`; }

/** One entry per model x voice: id "<gguf>@<voice>". Float GGUFs are never listed (lib/speech discoverModels). */
function ownModels() {
  const out = [];
  for (const m of sp.discoverModels('tts', {})) {
    const cfg = VOICES[path.basename(m.file, '.gguf')] || {};
    if (cfg.default === false && !process.env.TTS_ALL) continue;
    const voices = cfg.voices || [{ id: 'default', langs: LANGS.filter((l) => (m.languages || []).includes(l)), args: [] }];
    for (const v of voices) {
      if (!v.langs.length) continue;
      out.push({ ...m, id: `${m.id}@${v.id}`, base: m.id, voice: v.id, langs: v.langs, voiceArgs: v.args || [], prefix: v.prefix || '', language: v.language });
    }
  }
  return out;
}

/** STT judge per language: TTS_JUDGE_<LANG>/TTS_JUDGE env, else DEFAULT_JUDGE; with TTS_JUDGE_AUTO=1 the model with the lowest pooled WER in the latest finished stt run instead. */
function pickJudge(lang, notes = []) {
  const env = process.env[`TTS_JUDGE_${lang.toUpperCase()}`] || process.env.TTS_JUDGE;
  const have = new Set(sp.discoverModels('asr', {}).map((m) => m.id));
  if (env) return { id: env, why: 'env' };
  if (!process.env.TTS_JUDGE_AUTO) return { id: DEFAULT_JUDGE[lang] || 'phonon-2.5-q6_k', why: 'default (best of the STT run 2026-11-03_22-12)' };
  try {
    const conn = db.open();
    const rows = conn.prepare(`SELECT m.alias AS model,
        SUM(CASE WHEN mt.name = 'word_edits' THEN mt.value END) AS edits, SUM(CASE WHEN mt.name = 'ref_words' THEN mt.value END) AS words
      FROM case_results cr JOIN benchmarks b ON b.id = cr.benchmark_id AND b.name = 'stt' JOIN cases c ON c.id = cr.case_id
      JOIN models m ON m.id = cr.model_id JOIN metrics mt ON mt.result_id = cr.id
      WHERE c.profile = ? AND cr.run_id = (SELECT MAX(r2.id) FROM runs r2 JOIN case_results x ON x.run_id = r2.id JOIN benchmarks b2 ON b2.id = x.benchmark_id AND b2.name = 'stt' WHERE r2.status = 'finished')
      GROUP BY m.alias HAVING words > 0`).all(lang).filter((r) => have.has(r.model)).sort((a, b) => a.edits / a.words - b.edits / b.words);
    if (rows.length) return { id: rows[0].model, why: `lowest WER in the latest finished stt run (${(100 * rows[0].edits / rows[0].words).toFixed(1)}%)` };
  } catch (e) { notes.push(`judge lookup failed: ${e.message}`); }
  return { id: DEFAULT_JUDGE[lang] || 'phonon-2.5-q6_k', why: 'default (best of the STT run 2026-11-03_22-12)' };
}

const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * Per-row TTS score (0-100): 60% intelligibility (round-trip WER: 1 at 0%, 0 at >= 50%), 25% audio sanity (share of the
 * sanity checks passed) and 15% speed (RTF <= 0.1 scores 1, RTF >= 1.0 scores 0). A failed synthesis scores 0.
 */
function scoreOf({ wer, sanityPassed, sanityTotal, rtf }) {
  const intel = clamp(1 - wer / 0.5);
  const sanity = sanityTotal ? sanityPassed / sanityTotal : 0;
  const speed = rtf == null ? 0 : clamp(1 - (rtf - 0.1) / 0.9);
  return Math.round(100 * (0.6 * intel + 0.25 * sanity + 0.15 * speed) * 10) / 10;
}

function sanityChecks(a, textChars, durationS) {
  const cps = durationS ? textChars / durationS : 0;
  return [
    { name: 'speech_rate', pass: cps >= CPS_RANGE[0] && cps <= CPS_RANGE[1], reason: `${cps.toFixed(1)} chars/s (plausible ${CPS_RANGE.join('-')})` },
    { name: 'no_clipping', pass: a.clip_ratio < 0.001, reason: `${(a.clip_ratio * 100).toFixed(3)}% of samples at full scale` },
    { name: 'edge_silence', pass: a.lead_silence_s <= 1.5 && a.trail_silence_s <= 2, reason: `lead ${a.lead_silence_s.toFixed(2)} s, trail ${a.trail_silence_s.toFixed(2)} s` },
    { name: 'internal_silence', pass: a.internal_silence_ratio <= 0.35, reason: `${(a.internal_silence_ratio * 100).toFixed(0)}% of the spoken span is silent` },
    { name: 'loudness', pass: a.peak_dbfs <= -0.5 && a.peak_dbfs >= -30 && a.rms_dbfs >= -40 && a.rms_dbfs <= -8, reason: `peak ${a.peak_dbfs.toFixed(1)} dBFS, RMS ${a.rms_dbfs.toFixed(1)} dBFS` },
  ];
}

function failRow(model, c, why, ft = 'synthesis_failed') {
  return {
    benchmark: 'tts', model: model.id, case_id: c.id, group: c.lang, kind: 'tts', title: c.title, repeat: 1, status: 'error', duration_s: null, exit_code: null,
    tokens_in: 0, tokens_out: 0, api_calls: 1, tool_calls: 0, tool_errors: 0, answer_chars: 0, leftovers: [], transcript: null, notes: why, failure_types: [ft],
    checks: [{ name: 'completed', category: 'completed', pass: false, reason: why }], metrics: { speech_score: 0 },
  };
}

async function run(ctx) {
  const { cases, log, signal, onRow, mrec, gpu, runDir } = ctx;
  const model = ctx.modelInfo || ownModels().find((m) => m.id === ctx.model);
  if (!model) throw new Error(`unknown TTS model ${ctx.model}`);
  const rows = [];
  const tmpRoot = `/tmp/bench-tts/${model.id.replace(/[^\w.@-]/g, '_')}`;
  const audioDir = path.join(runDir, 'audio', model.id);
  let loadMs = null;
  let judgeNote = [];
  for (const lang of LANGS) {
    const mine = cases.filter((c) => c.lang === lang);
    if (!mine.length) continue;
    if (!model.langs.includes(lang)) { log(`  ${model.id}: no ${lang} voice, ${mine.length} item(s) skipped`); continue; }
    if (signal && signal.aborted) break;
    const inDir = `${tmpRoot}/${lang}/in`;
    const outDir = `${tmpRoot}/${lang}/out`;
    const writes = mine.map((c) => `printf '%s' "$(cat <<'__EOT__'\n${model.prefix ? `${model.prefix} ` : ''}${c.text}\n__EOT__\n)" > '${inDir}/${c.stem}.txt'`).join('\n');
    const prep = await sp.sh(`rm -rf '${tmpRoot}/${lang}' && mkdir -p '${inDir}' '${outDir}'\n${writes}`);
    if (prep.code !== 0) { for (const c of mine) { const r = failRow(model, c, `could not stage text: ${prep.stderr.slice(0, 200)}`); rows.push(r); if (onRow) onRow(r); } continue; }
    // 1. synthesis (this is the part whose VRAM/time belongs to the TTS model)
    if (gpu) gpu.setLabel(`${model.id}:run`);
    const args = ['--task', 'tts', '--family', model.family, '--model', model.remote, '--backend', 'vulkan', '--batch-text-dir', inDir, '--out-dir', outDir,
      ...(model.language === false ? [] : ['--language', typeof model.language === 'string' ? model.language : lang]), '--metrics', ...(model.extraArgs || []), ...model.voiceArgs];
    log(`  ${model.id} ${lang}: synthesizing ${mine.length} item(s)`);
    const r = await sp.runCli(args, { signal });
    const parsed = sp.parseBatchOutput(r.stdout);
    let sumWall = 0;
    for (const v of parsed.values()) sumWall += v.wall_ms || 0;
    if (parsed.size && loadMs == null) loadMs = Math.max(0, r.ms - sumWall);
    if (r.code !== 0) log(`  audiocpp_cli exit ${r.code}${r.timedOut ? ' (timeout)' : ''}: ${(r.stderr || r.stdout).slice(-240).replace(/\n/g, ' ')}`);
    await sp.copyOut(`${outDir}/.`, audioDir).catch((e) => log(`  copying audio failed: ${e.message}`));
    // 2. judge: transcribe the generated audio with the STT model of this language
    if (gpu) gpu.setLabel('judge');
    const judge = pickJudge(lang, ctx.notes || []);
    const jm = sp.discoverModels('asr', sttOverrides).find((m) => m.id === judge.id);
    let transcripts = new Map();
    if (!jm) log(`  judge ${judge.id} not found: WER cannot be computed`);
    else {
      judgeNote.push(`${lang}: ${judge.id} (${judge.why})`);
      const jr = await sp.runCli(['--task', 'asr', '--family', jm.family, '--model', jm.remote, '--backend', 'vulkan', '--batch-audio-dir', outDir,
        '--batch-manifest-out', `${tmpRoot}/${lang}/judge.json`, '--metrics', ...(jm.extraArgs || []), ...((jm.langArgs && jm.langArgs[lang]) || [])], { signal });
      transcripts = sp.parseBatchOutput(jr.stdout);
    }
    // 3. rows
    for (const c of mine) {
      const syn = parsed.get(c.stem);
      const wavFile = path.join(audioDir, `${c.stem}.wav`);
      if (!syn || !fs.existsSync(wavFile)) { const fr = failRow(model, c, `no audio produced (audiocpp_cli exit ${r.code})`); rows.push(fr); if (onRow) onRow(fr); continue; }
      let wav; let a; let pitch = null;
      try { wav = sp.parseWav(fs.readFileSync(wavFile)); a = sp.analyseAudio(wav); pitch = sp.medianPitch(wav); } catch (e) { const fr = failRow(model, c, `unreadable audio: ${e.message}`, 'bad_audio'); rows.push(fr); if (onRow) onRow(fr); continue; }
      const audioS = a.duration_s;
      const wall = syn.wall_ms != null ? syn.wall_ms / 1000 : null;
      const rtf = wall != null && audioS ? wall / audioS : null;
      const hyp = transcripts.get(c.stem);
      const hypText = hyp && hyp.text != null ? hyp.text : null;
      const s = hypText != null ? sp.scoreText(c.text, hypText, lang) : null;
      const san = sanityChecks(a, c.text.length, audioS);
      const parsedBack = s ? s.wer <= PARSED_BACK_WER : false;
      const sanityPassed = san.filter((x) => x.pass).length;
      const score = scoreOf({ wer: s ? s.wer : 1, sanityPassed, sanityTotal: san.length, rtf });
      const status = s && parsedBack && sanityPassed === san.length ? 'pass' : 'fail';
      const row = {
        benchmark: 'tts', model: model.id, case_id: c.id, group: lang, kind: 'tts', title: c.title, repeat: 1, status, duration_s: wall, exit_code: 0,
        tokens_in: 0, tokens_out: 0, api_calls: 1, tool_calls: 0, tool_errors: 0, answer_chars: hypText ? hypText.length : 0, answer_text: hypText,
        leftovers: [], transcript: null,
        checks: [
          { name: 'completed', category: 'completed', pass: true, reason: null },
          { name: 'correct', category: 'correctness', pass: s ? parsedBack : false, reason: s ? `round-trip WER ${(s.wer * 100).toFixed(1)}% (parsed back at <= ${PARSED_BACK_WER * 100}%)` : 'no transcription from the judge' },
          ...san.map((x) => ({ ...x, category: 'rules' })),
        ],
        failure_types: [...(s && !parsedBack ? ['not_parsed_back'] : []), ...(s ? [] : ['no_judge']), ...san.filter((x) => !x.pass).map((x) => x.name)],
        notes: `audio: audio/${model.id}/${c.stem}.wav | judge ${judge.id} | text: ${c.text}`,
        metrics: {
          speech_score: score, wer: s ? s.wer : null, cer: s ? s.cer : null, word_edits: s ? s.word_edits : null, ref_words: s ? s.ref_words : null,
          char_edits: s ? s.char_edits : null, ref_chars: s ? s.ref_chars : null, parsed_back: parsedBack ? 1 : 0, audio_s: audioS, text_chars: c.text.length,
          rtf, chars_per_s: audioS ? c.text.length / audioS : null, sample_rate: a.sample_rate, lead_silence_s: a.lead_silence_s, trail_silence_s: a.trail_silence_s,
          internal_silence_ratio: a.internal_silence_ratio, clip_ratio: a.clip_ratio, rms_dbfs: a.rms_dbfs, peak_dbfs: a.peak_dbfs, pitch_hz: pitch,
          peak_rss_mb: syn.peak_rss_mb,
        },
      };
      rows.push(row);
      if (onRow) onRow(row);
    }
    await sp.sh(`rm -rf '${tmpRoot}/${lang}'`).catch(() => {});
  }
  await sp.sh(`rm -rf '${tmpRoot}'`).catch(() => {});
  if (mrec) {
    mrec.load_ms = loadMs;
    mrec.load_status = rows.length && rows.every((x) => x.status === 'error') ? 'load_failed' : 'loaded';
    mrec.load_error = mrec.load_status === 'load_failed' ? (rows[0] && rows[0].notes) : null;
    mrec.meta = { family: model.family, quant: model.quant, size_mb: model.size_mb, file: model.remote, voice: model.voice, judge: judgeNote.join('; ') };
  }
  log(`  ${rows.filter((x) => x.status === 'pass').length}/${rows.length} pass, ${rows.filter((x) => x.status === 'error').length} failed${judgeNote.length ? `, judge ${judgeNote.join('; ')}` : ''}`);
  return rows;
}

const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '' : Number(x).toFixed(d));
const pct = (x, d = 1) => (x == null ? '' : f(x * 100, d));

/** Markdown summary written next to report.md as tts-summary.md; links the WAVs under audio/. */
function summarize({ results, models = [], notes = [] }) {
  const L = ['# TTS benchmark summary', ''];
  for (const n of notes) if (/tts|VRAM|LLM/i.test(n)) L.push(`- ${n}`);
  L.push('', `Round-trip intelligibility: the generated audio is transcribed by the STT judge (best model per language) and scored against the original text with the STT normalisation (WER, CER). "Parsed back" = WER <= ${PARSED_BACK_WER * 100}%. Sanity: speech rate ${CPS_RANGE.join('-')} chars/s, clipping < 0.1% of samples, leading <= 1.5 s / trailing <= 2 s silence, internal silence <= 35% of the spoken span, peak -30..-0.5 dBFS and RMS -40..-8 dBFS. RTF = synthesis seconds / audio seconds (offline batch, no streaming time-to-first-audio). Score per item = 60% intelligibility (WER 0 -> 1, WER >= 50% -> 0) + 25% sanity checks passed + 15% speed (RTF <= 0.1 -> 1, >= 1.0 -> 0); failed synthesis = 0. Pitch = median F0 by autocorrelation (crude; for consistency per voice, not absolute truth).`, '');
  for (const lang of [...new Set(results.map((r) => r.group))].sort()) {
    const by = {};
    for (const r of results.filter((x) => x.group === lang)) (by[r.model] || (by[r.model] = [])).push(r);
    const rows = Object.entries(by).map(([m, rs]) => {
      const mt = (k) => rs.map((r) => r.metrics && r.metrics[k]).filter((x) => typeof x === 'number');
      const sum = (k) => mt(k).reduce((a, b) => a + b, 0);
      const done = rs.filter((r) => r.status !== 'error');
      const walls = done.map((r) => r.duration_s).filter((x) => x != null);
      return {
        m, n: rs.length, fails: rs.length - done.length, wer: sum('ref_words') ? sum('word_edits') / sum('ref_words') : null, cer: sum('ref_chars') ? sum('char_edits') / sum('ref_chars') : null,
        pb: done.length ? done.filter((r) => r.metrics.parsed_back === 1).length / done.length : null, rtf: sum('audio_s') ? walls.reduce((a, b) => a + b, 0) / sum('audio_s') : null,
        syn: sp.mean(walls), cps: sp.median(mt('chars_per_s')), lead: sp.median(mt('lead_silence_s')), trail: sp.median(mt('trail_silence_s')), inner: sp.mean(mt('internal_silence_ratio')),
        clip: sp.mean(mt('clip_ratio')), rms: sp.median(mt('rms_dbfs')), peak: sp.median(mt('peak_dbfs')), sr: sp.median(mt('sample_rate')), f0: sp.median(mt('pitch_hz')),
        score: sp.mean(rs.map((r) => r.score)),
      };
    }).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    L.push(`## ${lang}`, '', '| Model@voice | Items | Score | WER % | CER % | Parsed back % | RTF | s/item | chars/s | Lead s | Trail s | Inner silence % | Clip % | RMS dBFS | Peak dBFS | Rate Hz | F0 Hz | Failed |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const x of rows) L.push(`| [${x.m}](audio/${x.m}/) | ${x.n} | ${f(x.score)} | ${pct(x.wer)} | ${pct(x.cer)} | ${pct(x.pb, 0)} | ${f(x.rtf, 3)} | ${f(x.syn, 2)} | ${f(x.cps)} | ${f(x.lead, 2)} | ${f(x.trail, 2)} | ${pct(x.inner, 0)} | ${pct(x.clip, 3)} | ${f(x.rms)} | ${f(x.peak)} | ${f(x.sr, 0)} | ${f(x.f0, 0)} | ${x.fails} |`);
    L.push('');
  }
  L.push('## Models', '', '| Model@voice | Family | Quant | Size MB | Load s | Peak VRAM GiB (system / over baseline) | Judge | Status |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const m of models) L.push(`| ${m.id} | ${m.meta?.family ?? ''} | ${m.meta?.quant ?? ''} | ${m.meta?.size_mb ?? ''} | ${f(m.load_ms != null ? m.load_ms / 1000 : null)} | ${m.gpu_peak?.vram_used_gib ?? ''}${m.baseline_vram_gib != null && m.gpu_peak?.vram_used_gib != null ? ` / +${(m.gpu_peak.vram_used_gib - m.baseline_vram_gib).toFixed(2)}` : ''} | ${m.meta?.judge ?? ''} | ${m.load_status} |`);
  L.push('', 'Load = synthesis process time minus the per-item times (model read + upload + warmup). Peak VRAM is the whole GPU while that model synthesized (judge phases excluded); "over baseline" subtracts what was resident before the run.', '');
  return L.join('\n');
}

module.exports = {
  name: 'tts', description: 'Text-to-speech: quantized audio.cpp TTS GGUFs x voices speaking Hermes answers; round-trip WER by an STT judge, audio sanity, RTF, load, VRAM.',
  optin: true, listCases, describeCase, ownModels, run, summarize, scoreOf, sanityChecks, pickJudge,
};
