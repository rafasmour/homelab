#!/usr/bin/env node
'use strict';
// Builds the fixed TTS text snapshot from Hermes answers stored in the benchmark DB
// (case_results.answer_text of the `hermes` benchmark): cleaned to speakable text, split to <= MAX chars.
//   docker exec benchmark npm run tts-texts -- [--en 20] [--el 15] [--max 400] [--out data/tts-texts.json]
// The output contains personal data (calendar, finance, nutrition). It lives under the ignored data/ folder: never commit it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../../lib/db');

const GREEK = /[Ͱ-Ͽἀ-῿]/g;
const LATIN = /[A-Za-z]/g;
const EMOJI = /[\p{Extended_Pictographic}‍️⃣\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/gu;

/** Markdown/answer text -> plain speakable prose paragraphs (array of strings). */
function clean(raw) {
  let t = String(raw || '').replace(/\r/g, '');
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  t = t.replace(/<[^>\n]+>/g, ' ').replace(/https?:\/\/\S+|www\.\S+/g, ' ');
  const out = [];
  for (let line of t.split('\n')) {
    if (/^\s*\|/.test(line) || /^\s*[-=_*]{3,}\s*$/.test(line) || /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')) continue; // tables, rules
    line = line.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\s*>\s?/, '');
    line = line.replace(/\*\*|__|\*|~~/g, '').replace(EMOJI, ' ').replace(/[#|\\]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line) out.push(line);
  }
  return out;
}

const scriptOf = (s) => {
  const g = (s.match(GREEK) || []).length;
  const l = (s.match(LATIN) || []).length;
  if (g + l < 8) return null;
  // Single-script prose only: a mixed English/Greek chunk would test code-switching, not the language voices.
  if (g === 0) return 'en';
  return l / (g + l) <= 0.15 ? 'el' : null;
};

/** Split text into chunks <= max chars on sentence boundaries (then on commas, then on spaces). */
function split(text, max) {
  const sents = text.match(/.+?[.!?;·]+["')\]]*(?=\s|$)|.+$/gs) || [text];
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (let s of sents) {
    s = s.trim();
    while (s.length > max) {
      let cut = s.lastIndexOf(', ', max);
      if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
      if (cut < 1) cut = max;
      if (cur) flush();
      chunks.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if ((cur + ' ' + s).trim().length > max) flush();
    cur = (cur + ' ' + s).trim();
  }
  flush();
  return chunks;
}

const ok = (c) => {
  const words = c.split(/\s+/).length;
  const sym = (c.match(/[^\p{L}\p{N}\s.,;:!?'"()%€$-]/gu) || []).length;
  const digits = (c.match(/\d/g) || []).length;
  if (/_|\bmcp|tool[ _-]?call|\bapi\b|\.(py|js|json|md)\b|\bhttp|\/\w+\/|\bkcal\b|\bdocker\b|\bsession\b/i.test(c)) return false; // not natural prose
  return c.length >= 30 && words >= 5 && sym / c.length < 0.05 && digits / c.length < 0.05 && !/\d{4}-\d{2}|\d{1,2}:\d{2}/.test(c); // numbers and dates are read in too many ways to score by WER
};

function build({ en = 20, el = 15, max = 400, dbFile } = {}) {
  const conn = db.open(dbFile);
  const rows = conn.prepare(`SELECT cr.id, cr.answer_text, cr.status, cs.case_key, r.name AS run FROM case_results cr
    JOIN benchmarks b ON b.id = cr.benchmark_id JOIN cases cs ON cs.id = cr.case_id JOIN runs r ON r.id = cr.run_id
    WHERE b.name = 'hermes' AND cr.answer_text IS NOT NULL AND length(cr.answer_text) > 30
    ORDER BY r.name DESC, cr.id`).all();
  // candidates[lang][case_key] = [{text, run, status}] (newest runs first, passing answers first)
  const cand = { en: new Map(), el: new Map() };
  const seen = new Set();
  for (const r of rows.sort((a, b) => (a.status === 'pass' ? 0 : 1) - (b.status === 'pass' ? 0 : 1) || (a.run < b.run ? 1 : -1))) {
    if (r.answer_text.length > 12000) continue; // runaway outputs
    for (const para of clean(r.answer_text)) {
      const lang = scriptOf(para);
      if (!lang) continue;
      for (const chunk of split(para, max)) {
        if (!ok(chunk) || scriptOf(chunk) !== lang) continue;
        const key = chunk.toLowerCase().replace(/\W+/g, ' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const m = cand[lang];
        if (!m.has(r.case_key)) m.set(r.case_key, []);
        m.get(r.case_key).push({ text: chunk, run: r.run, case: r.case_key, result: r.id });
      }
    }
  }
  const pick = (lang, n) => {
    // Round-robin over cases, mixing short and long chunks: sort each case's list by |len - 160| so typical sentences go first.
    const lists = [...cand[lang].entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v.slice().sort((a, b) => Math.abs(a.text.length - 180) - Math.abs(b.text.length - 180) || (a.text < b.text ? -1 : 1)).slice(0, Math.max(3, Math.ceil(n / 3)))); // cap per case: no single case dominates
    const out = [];
    for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
    return out;
  };
  const items = [];
  for (const [lang, n] of [['en', en], ['el', el]]) {
    pick(lang, n).forEach((c, i) => items.push({ id: `${lang}${String(i + 1).padStart(2, '0')}`, lang, text: c.text, chars: c.text.length, source: { run: c.run, case: c.case, result_id: c.result }, hash: crypto.createHash('sha1').update(c.text).digest('hex').slice(0, 8) }));
  }
  return { built_at: new Date().toISOString(), max_chars: max, available: { en: [...cand.en.values()].reduce((a, v) => a + v.length, 0), el: [...cand.el.values()].reduce((a, v) => a + v.length, 0) }, items };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const out = path.resolve(get('--out', path.join(path.dirname(db.DEFAULT_PATH), 'tts-texts.json')));
  const res = build({ en: Number(get('--en', 20)), el: Number(get('--el', 15)), max: Number(get('--max', 400)) });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  const n = (l) => res.items.filter((i) => i.lang === l).length;
  console.log(`wrote ${out}: ${n('en')} en + ${n('el')} el items (available chunks: en ${res.available.en}, el ${res.available.el}). Contains personal data; stays under data/ (ignored by Git).`);
  if (n('el') < Number(get('--el', 15))) console.log('note: fewer Greek items than requested; rebuild after Hermes runs with the assistant-*-el cases.');
}
module.exports = { clean, split, scriptOf, build };
