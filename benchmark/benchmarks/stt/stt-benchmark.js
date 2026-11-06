'use strict';
// Speech-to-text benchmark: every quantized audio.cpp ASR GGUF transcribes the fixed FLEURS clips
// (speech/audiocpp/models/_asr-eval/clips/{el,en}/*.wav + manifest.jsonl) through audiocpp_cli in the
// audiocpp-tts container. Per clip: WER/CER (score.py normalisation), wall seconds, RTF. Per model: load time,
// peak VRAM (GPU monitor) and RSS. See benchmark/README.md.
const fs = require('node:fs');
const path = require('node:path');
const sp = require('../../lib/speech');

const CLIPS_DIR = process.env.STT_CLIPS_DIR || path.join(sp.MODELS_LOCAL, '_asr-eval', 'clips');
const PASS_WER = 0.25; // a clip "passes" at or below this word error rate
const OVERRIDES = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'models.json'), 'utf8')); } catch { return {}; } })();

function loadManifest() {
  const file = path.join(CLIPS_DIR, 'manifest.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => {
    const rel = r.path.includes('/clips/') ? r.path.split('/clips/').pop() : r.path.replace(/^\/+/, '');
    const stem = path.basename(rel, '.wav');
    return { id: `${r.lang}/${stem}`, group: r.lang, kind: 'stt', lang: r.lang, rel, stem, text: r.text, duration: r.duration, title: `${r.lang} ${stem}` };
  });
}

/** Cases: all clips; --profiles el,en filters languages; SPEECH_LIMIT=N keeps the first N clips per language. */
function listCases({ cases, profiles } = {}) {
  let all = loadManifest();
  const limit = Number(process.env.SPEECH_LIMIT) || 0;
  if (limit) {
    const seen = {};
    all = all.filter((c) => (seen[c.lang] = (seen[c.lang] || 0) + 1) <= limit);
  }
  if (profiles) all = all.filter((c) => profiles.includes(c.lang));
  if (cases) all = all.filter((c) => cases.includes(c.id) || cases.includes(c.lang));
  return all;
}

function describeCase(c) { return `${c.id.padEnd(34)} ${String(Math.round((c.duration || 0) * 10) / 10).padStart(5)}s  ${c.text.slice(0, 60)}`; }

/** Quantized ASR GGUFs found under the models dir. */
function ownModels() { return sp.discoverModels('asr', OVERRIDES); }

function rowFor(model, c, r, extra = {}) {
  const base = { benchmark: 'stt', model: model.id, case_id: c.id, group: c.lang, kind: 'stt', title: c.title, repeat: 1, tokens_in: 0, tokens_out: 0, api_calls: 1, tool_calls: 0, tool_errors: 0, leftovers: [], transcript: null };
  if (!r || r.text == null) {
    return { ...base, status: 'error', duration_s: null, exit_code: null, answer_chars: 0, checks: [{ name: 'completed', category: 'completed', pass: false, reason: 'no transcription in the CLI output' }], failure_types: ['no_output'], notes: extra.error || 'no transcription in the CLI output', metrics: { speech_score: 0 } };
  }
  // MOSS-Transcribe-Diarize emits "[start][S01]text[end]"; timestamps and speaker tags are not speech.
  const scored = model.family === 'moss_transcribe_diarize' ? r.text.replace(/\[\d+(?:\.\d+)?\]/g, ' ').replace(/\[S\d+\]/g, ' ') : r.text;
  const s = sp.scoreText(c.text, scored, c.lang);
  const empty = !scored.trim();
  const audioS = r.audio_ms != null ? r.audio_ms / 1000 : c.duration;
  const wall = r.wall_ms != null ? r.wall_ms / 1000 : null;
  const ok = !empty && s.wer <= PASS_WER;
  return {
    ...base, status: ok ? 'pass' : 'fail', duration_s: wall, exit_code: 0, answer_chars: r.text.length, answer_text: r.text,
    checks: [
      { name: 'completed', category: 'completed', pass: !empty, reason: empty ? 'empty transcript' : null },
      { name: 'correct', category: 'correctness', pass: ok, reason: ok ? null : `WER ${(s.wer * 100).toFixed(1)}% > ${PASS_WER * 100}%` },
    ],
    failure_types: empty ? ['empty'] : (ok ? [] : ['high_wer']),
    notes: `ref: ${c.text}`,
    metrics: {
      speech_score: Math.round(100 * (1 - Math.min(1, s.wer)) * 10) / 10, wer: s.wer, cer: s.cer, word_edits: s.word_edits, ref_words: s.ref_words,
      char_edits: s.char_edits, ref_chars: s.ref_chars, audio_s: audioS, rtf: wall != null && audioS ? wall / audioS : null, peak_rss_mb: r.peak_rss_mb,
    },
  };
}

/** One audiocpp_cli process per model (one load), all selected clips in one batch. */
async function run(ctx) {
  const { cases, log, signal, onRow, mrec, gpu } = ctx;
  const model = ctx.modelInfo || ownModels().find((m) => m.id === ctx.model);
  if (!model) throw new Error(`unknown STT model ${ctx.model}`);
  const mine = cases.filter((c) => !model.languages || model.languages.includes(c.lang));
  const skipped = cases.filter((c) => !mine.includes(c));
  if (skipped.length) log(`  ${skipped.length} clip(s) skipped: ${model.id} does not list language(s) ${[...new Set(skipped.map((c) => c.lang))].join(', ')}`);
  const rows = [];
  if (!mine.length) return rows;
  // One audiocpp_cli process per language when the model needs a language argument (langArgs), else one for all clips.
  const groups = model.langArgs ? [...new Set(mine.map((c) => c.lang))].map((l) => ({ cs: mine.filter((c) => c.lang === l), extra: model.langArgs[l] || [] })) : [{ cs: mine, extra: [] }];
  let loadMs = 0;
  let loaded = false;
  let lastErr = '';
  log(`  ${model.id} (${model.family}, ${model.quant}, ${model.size_mb} MB): ${mine.length} clip(s)${groups.length > 1 ? ` in ${groups.length} language batches` : ''}`);
  for (const [gi, g] of groups.entries()) {
    const tmp = `/tmp/bench-stt/${model.id}${gi ? `-${gi}` : ''}`;
    const remoteClips = path.posix.join(sp.MODELS_REMOTE, path.relative(sp.MODELS_LOCAL, CLIPS_DIR).split(path.sep).join('/'));
    const links = g.cs.map((c) => `ln -sf '${remoteClips}/${c.rel}' '${tmp}/${c.lang}__${c.stem}.wav'`).join('\n');
    const prep = await sp.sh(`rm -rf '${tmp}' && mkdir -p '${tmp}'\n${links}`);
    if (prep.code !== 0) throw new Error(`could not stage clips: ${prep.stderr.slice(0, 300)}`);
    const args = ['--task', 'asr', '--family', model.family, '--model', model.remote, '--backend', 'vulkan', '--batch-audio-dir', tmp,
      '--batch-manifest-out', `${tmp}.manifest.json`, '--metrics', ...(model.extraArgs || []), ...g.extra];
    const r = await sp.runCli(args, { signal });
    const parsed = sp.parseBatchOutput(r.stdout);
    let sumWall = 0;
    for (const v of parsed.values()) sumWall += v.wall_ms || 0;
    // Process wall time minus the per-request times: model load + warmup + process start (summed over language batches).
    if (parsed.size) { loadMs += Math.max(0, r.ms - sumWall); loaded = true; }
    lastErr = `audiocpp_cli exit ${r.code}${r.timedOut ? ' (timeout)' : ''}: ${(r.stderr || r.stdout).slice(-300)}`;
    if (r.code !== 0) log(`  ${lastErr.slice(0, 260).replace(/\n/g, ' ')}`);
    for (const c of g.cs) {
      const row = rowFor(model, c, parsed.get(`${c.lang}__${c.stem}`), { error: lastErr });
      rows.push(row);
      if (onRow) onRow(row);
    }
    log(`  ${g.cs.length ? g.cs[0].lang : ''}: ${g.cs.filter((c) => parsed.get(`${c.lang}__${c.stem}`)).length}/${g.cs.length} transcribed, ${Math.round(r.ms / 1000)} s`);
    await sp.sh(`rm -rf '${tmp}' '${tmp}.manifest.json'`).catch(() => {});
  }
  if (mrec) {
    mrec.load_ms = loaded ? loadMs : null;
    mrec.load_status = loaded ? 'loaded' : 'load_failed';
    mrec.load_error = loaded ? null : lastErr;
    mrec.meta = { family: model.family, quant: model.quant, size_mb: model.size_mb, file: model.remote };
  }
  return rows;
}

const f = (x, d = 1) => (x == null ? '' : Number(x).toFixed(d));

/** Markdown summary (per-language leaderboard) written next to report.md as stt-summary.md. */
function summarize({ results, models = [], notes = [] }) {
  const L = ['# STT benchmark summary', ''];
  for (const n of notes) if (/speech|VRAM|LLM/i.test(n)) L.push(`- ${n}`);
  L.push('', `A clip passes at WER <= ${PASS_WER * 100}%. WER/CER are pooled over words/characters (edits / reference size) after the score.py normalisation (NFKC, lowercase, punctuation removed; Greek without accents, final sigma folded). RTF = processing seconds / audio seconds. Load = process time minus the per-clip times (model read + upload + warmup). Score = mean per-clip 100 x (1 - min(1, WER)).`, '');
  const langs = [...new Set(results.map((r) => r.group))].sort();
  for (const lang of langs) {
    const byModel = {};
    for (const r of results.filter((x) => x.group === lang)) (byModel[r.model] || (byModel[r.model] = [])).push(r);
    const rows = Object.entries(byModel).map(([m, rs]) => {
      const sum = (k) => rs.reduce((a, r) => a + ((r.metrics && r.metrics[k]) || 0), 0);
      const walls = rs.map((r) => r.duration_s).filter((x) => x != null);
      return {
        m, n: rs.length, wer: sum('ref_words') ? sum('word_edits') / sum('ref_words') : null, cer: sum('ref_chars') ? sum('char_edits') / sum('ref_chars') : null,
        spc: sp.mean(walls), med: sp.median(walls), rtf: sum('audio_s') ? walls.reduce((a, b) => a + b, 0) / sum('audio_s') : null,
        fails: rs.filter((r) => r.status === 'error' || r.status === 'fail' && r.failure_types.includes('empty')).length, passed: rs.filter((r) => r.status === 'pass').length,
        score: sp.mean(rs.map((r) => r.score)),
      };
    }).sort((a, b) => (a.wer ?? 9) - (b.wer ?? 9));
    L.push(`## ${lang}`, '', '| Model | Clips | WER % | CER % | s/clip (mean) | s/clip (median) | RTF | Passed | Failures | Score |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const x of rows) L.push(`| ${x.m} | ${x.n} | ${x.wer == null ? '' : f(x.wer * 100, 2)} | ${x.cer == null ? '' : f(x.cer * 100, 2)} | ${f(x.spc, 2)} | ${f(x.med, 2)} | ${f(x.rtf, 3)} | ${x.passed}/${x.n} | ${x.fails} | ${f(x.score)} |`);
    L.push('');
  }
  L.push('## Models', '', '| Model | Family | Quant | Size MB | Load s | Peak VRAM GiB (system / over baseline) | Status |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const m of models) L.push(`| ${m.id} | ${m.meta?.family ?? ''} | ${m.meta?.quant ?? ''} | ${m.meta?.size_mb ?? ''} | ${f(m.load_ms != null ? m.load_ms / 1000 : null)} | ${m.gpu_peak?.vram_used_gib ?? ''}${m.baseline_vram_gib != null && m.gpu_peak?.vram_used_gib != null ? ` / +${(m.gpu_peak.vram_used_gib - m.baseline_vram_gib).toFixed(2)}` : ''} | ${m.load_status} |`);
  L.push('');
  return L.join('\n');
}

module.exports = {
  name: 'stt', description: 'Speech-to-text: quantized audio.cpp ASR GGUFs on the fixed FLEURS el/en clips (WER, CER, latency, RTF, load, VRAM).',
  optin: true, listCases, describeCase, ownModels, run, summarize, overrides: OVERRIDES, _rowFor: rowFor,
};
