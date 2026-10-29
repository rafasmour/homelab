'use strict';
// Content grading of the research cron digests, from the tool results the model saw in the run.
// Pure functions of (answer, transcript messages): used live by hermes-benchmark.js and again by
// `main.js rescore`, so stored runs can be re-graded without network access.
//
// Per job, the tool results define the reference set of items the job's rules keep:
//   ai-news, selfhosted  Reddit RSS entries dated within 24 h of clock_now (selfhosted: 5 per subreddit)
//   llamacpp-*           GitHub issues/PRs/commits since yesterday that mention the job's keywords
//   hf-models            models created today or yesterday with the gguf tag or > 100 downloads, text only
//   gpu-watch            shop pages read: [SILENT] needs one, the error line needs none; prices must be real
// Item limits come from the prompt the model actually got (stored runs used older prompts); JOBS has the fallbacks.
// The digest passes when it recalls >= 60 % of the expected items (expected = reference set capped at the
// job's item limit), at least 80 % of the items it lists are in the reference set, and [SILENT] or the
// error line is used only when the rules allow it.

const RECALL_MIN = 0.6;
const PRECISION_MIN = 0.8;
const SHOP_RE = /^https?:\/\/(?:www\.)?(?:skroutz|bestprice|public|plaisio|kotsovolos|e-shop)\.gr\//i;
const FAIL_RE = /^(?:Could not fetch|Could not extract)|\bHTTP (?:error )?[45]\d\d\b|returned error: [45]\d\d/i;

const JOBS = {
  'ai-news': { source: 'reddit', cap: 8 },
  selfhosted: { source: 'reddit', cap: 10, perGroup: 5 },
  'llamacpp-vulkan': { source: 'github', cap: 12, keywords: /\bvulkan\b/i },
  'llamacpp-rocm': { source: 'github', cap: 12, keywords: /\b(?:rocm|hip|hipblas|rocwmma|gfx11\d*|amd)\b/i },
  'hf-models': { source: 'hf', cap: 15 },
  'gpu-watch': { source: 'shops' },
};

/** Item limits stated in the prompt ("Keep up to 8 posts per subreddit", "at most 12 bullets"); null = no limit. */
function limits(prompt, spec) {
  const p = String(prompt || '');
  if (!p) return { cap: spec.cap, perGroup: spec.perGroup || null };
  const per = p.match(/(?:up to|at most) (\d+) posts per subreddit/i);
  const total = p.match(/at most (\d+) bullets/i) || p.match(/(?:keep up to|keep at most) (\d+) (?:posts|items|models)(?! per)/i) || p.match(/\(at most (\d+)\)/i);
  const perGroup = per ? Number(per[1]) : null;
  return { cap: total ? Number(total[1]) : perGroup ? perGroup * 2 : null, perGroup };
}

/** Tool results of a transcript: [{tool, text, failed}], with the untrusted-content wrapper and JSON envelope removed. */
function toolResults(messages) {
  return (messages || []).filter((m) => m.role === 'tool').map((m) => {
    let text = String(m.content || '');
    const open = text.indexOf('<untrusted_tool_result');
    if (open >= 0) {
      const body = text.indexOf('\n\n', open);
      const close = text.lastIndexOf('</untrusted_tool_result>');
      text = text.slice(body >= 0 ? body + 2 : open, close > body ? close : undefined).trim();
    }
    if (text.startsWith('{')) {
      try { const j = JSON.parse(text); if (typeof j.result === 'string') text = j.result; } catch { /* spilled or truncated JSON: keep raw */ }
    }
    return { tool: m.tool_name || m.name || '', text, failed: FAIL_RE.test(text.slice(0, 400)) };
  });
}

/** Run time: the last clock_now result in the transcript, else the fallback. */
function runNow(results, fallbackIso) {
  for (const r of [...results].reverse()) {
    const m = r.text.match(/"utc":\s*"([^"]+)"/);
    if (m && Number.isFinite(Date.parse(m[1]))) return new Date(m[1]);
  }
  return fallbackIso ? new Date(fallbackIso) : null;
}

const athensDate = (d, offsetDays = 0) => new Date(d.getTime() + offsetDays * 86400e3).toLocaleDateString('en-CA', { timeZone: 'Europe/Athens' });

// ---------------------------------------------------------------- reference sets
function redditItems(results, now, job) {
  const items = [];
  for (const r of results) {
    if (r.failed || !/reddit\.com/.test(r.text)) continue;
    const re = /^- \[(.+?)\]\((https?:\/\/(?:www\.)?reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)[^)]*)\)\s*\((\d{4}-\d\d-\d\dT[^)]+)\)/gim;
    let m;
    while ((m = re.exec(r.text))) {
      const at = Date.parse(m[5]);
      items.push({ key: `reddit:${m[4]}`, title: m[1], group: m[3].toLowerCase(), eligible: Number.isFinite(at) && now - at <= 25 * 3600e3 && at - now <= 3600e3 });
    }
  }
  return dedupe(items, job.perGroup);
}

function githubItems(results, now, job) {
  const since = athensDate(now, -1);
  const items = [];
  for (const r of results) {
    if (r.failed || !/api\.github\.com\/search\//.test(r.text)) continue;
    const json = r.text.slice(r.text.indexOf('{'));
    let data = null;
    try { data = JSON.parse(json); } catch { data = null; }
    if (!data) {
      // max_chars cut the JSON: keep the items up to the last complete one (pretty-printed, items at indent 4).
      const end = json.lastIndexOf('\n    }');
      if (end > 0) { try { data = JSON.parse(`${json.slice(0, end)}\n    }\n  ]\n}`); } catch { data = null; } }
    }
    for (const it of (data && data.items) || []) {
      const commit = it.commit;
      const url = it.html_url || '';
      const num = url.match(/\/(?:pull|issues)\/(\d+)/);
      const sha = url.match(/\/commit\/([0-9a-f]{7,40})/);
      const key = num ? `gh:${num[1]}` : sha ? `ghc:${sha[1].slice(0, 7)}` : null;
      if (!key) continue;
      const text = commit ? commit.message || '' : `${it.title || ''}\n${it.body || ''}`;
      const date = String(commit ? (commit.committer && commit.committer.date) || '' : it.updated_at || '').slice(0, 10);
      items.push({ key, title: commit ? (commit.message || '').split('\n')[0] : it.title, eligible: job.keywords.test(text) && date >= since });
    }
  }
  return dedupe(items);
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function hfItems(results, now) {
  const days = [athensDate(now), athensDate(now, -1)];
  const items = [];
  for (const r of results) {
    if (r.failed || !/^### /m.test(r.text)) continue;
    for (const block of r.text.split(/^### /m).slice(1)) {
      const id = block.split('\n')[0].trim();
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) continue;
      const task = (block.match(/\*\*Task:\*\*\s*([^|\n]+)/) || [])[1] || '';
      const tags = (block.match(/\*\*Tags:\*\*\s*([^\n]+)/) || [])[1] || '';
      const dl = (block.match(/\*\*Downloads:\*\*\s*([\d.]+)\s*([KMB]?)/i) || []);
      const downloads = dl[1] ? Number(dl[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(dl[2] || '').toUpperCase()] || 1) : 0;
      const cm = block.match(/\*\*Created:\*\*\s*(\d{1,2}) (\w{3})\w*,? (\d{4})/);
      const created = cm ? `${cm[3]}-${String(MONTHS[cm[2].toLowerCase()] || 0).padStart(2, '0')}-${cm[1].padStart(2, '0')}` : '';
      const textOnly = !/image|audio|video|speech|vision/i.test(task);
      items.push({ key: `hf:${id.toLowerCase()}`, id, title: id, eligible: days.includes(created) && textOnly && (/\bgguf\b/i.test(tags) || downloads > 100) });
    }
  }
  return dedupe(items);
}

/** First occurrence per key; with perGroup, only the first n eligible items of each group stay eligible-expected. */
function dedupe(items, perGroup) {
  const seen = new Map();
  for (const it of items) if (!seen.has(it.key)) seen.set(it.key, it);
  const out = [...seen.values()];
  const counts = {};
  for (const it of out) {
    it.expected = it.eligible;
    if (perGroup && it.eligible) {
      counts[it.group] = (counts[it.group] || 0) + 1;
      if (counts[it.group] > perGroup) it.expected = false;
    }
  }
  return out;
}

/** Item keys the answer refers to, matched against the reference set by link or (Hugging Face) by model id. */
function answerKeys(answer, items) {
  const keys = new Set();
  for (const m of answer.matchAll(/reddit\.com\/r\/[^/\s]+\/comments\/([a-z0-9]+)/gi)) keys.add(`reddit:${m[1].toLowerCase()}`);
  for (const m of answer.matchAll(/github\.com\/ggml-org\/llama\.cpp\/(?:pull|issues)\/(\d+)/gi)) keys.add(`gh:${m[1]}`);
  for (const m of answer.matchAll(/github\.com\/ggml-org\/llama\.cpp\/commit\/([0-9a-f]{7,40})/gi)) keys.add(`ghc:${m[1].slice(0, 7).toLowerCase()}`);
  const low = answer.toLowerCase();
  for (const it of items) if (it.id && low.includes(it.id.toLowerCase())) keys.add(it.key);
  return keys;
}

/** Item lines: top-level bullets (an indented "why it matters" sub-bullet is not an item), only those with a link if any have one. */
function bullets(answer) {
  const top = answer.split('\n').filter((l) => /^(?:[-*•]|\d+\.)\s+/.test(l));
  const linked = top.filter((l) => /https?:\/\//.test(l));
  return linked.length ? linked : top;
}

// ---------------------------------------------------------------- grading
/**
 * Content problems of a research cron answer. Returns { applicable, problems[], summary }.
 * applicable=false when the job has no content rules or the tool results give no reference.
 */
function gradeContent(job, answer, messages, fallbackIso, prompt) {
  const spec = JOBS[job];
  if (!spec) return { applicable: false, problems: [], summary: '' };
  const results = toolResults(messages);
  const a = String(answer || '').trim();
  const silent = a === '[SILENT]';
  const errorLine = /^Error:/i.test(a) && a.split('\n').filter((l) => l.trim()).length <= 2;
  if (spec.source === 'shops') return gradeShops(a, silent, errorLine, results);

  const now = runNow(results, fallbackIso);
  if (!now) return { applicable: false, problems: [], summary: 'no run time' };
  const lim = limits(prompt, spec);
  const cap = lim.cap ?? Infinity;
  const items = spec.source === 'reddit' ? redditItems(results, now, lim) : spec.source === 'github' ? githubItems(results, now, spec) : hfItems(results, now);
  const sourceFailed = results.some((r) => r.failed);
  if (!items.length) {
    if (sourceFailed && silent) return { applicable: true, problems: ['[SILENT] after a source failed'], summary: '' };
    return { applicable: false, problems: [], summary: 'no parsable items in the tool results' };
  }
  const expectedAll = items.filter((i) => i.expected);
  const expectN = Math.min(cap, expectedAll.length);
  const eligibleKeys = new Set(items.filter((i) => i.eligible).map((i) => i.key));
  const problems = [];
  if (silent || errorLine) {
    if (expectN > 0) problems.push(`${silent ? '[SILENT]' : 'error line'} but ${expectN} item(s) qualified`);
    return { applicable: true, problems, summary: `${expectN} item(s) qualified` };
  }
  const listed = answerKeys(a, items);
  const known = [...listed].filter((k) => items.some((i) => i.key === k));
  const hits = known.filter((k) => eligibleKeys.has(k)).length;
  const wrong = known.length - hits;
  const recall = expectN ? Math.min(1, hits / expectN) : 1;
  const precision = known.length ? hits / known.length : 1;
  const nBullets = bullets(a).length;
  if (expectN === 0 && nBullets) problems.push(`listed ${nBullets} item(s) but none qualified (expected [SILENT])`);
  if (expectN > 0 && recall < RECALL_MIN) problems.push(`recalled ${hits} of ${expectN} qualifying item(s)`);
  if (known.length && precision < PRECISION_MIN) problems.push(`${wrong} of ${known.length} listed item(s) do not qualify (outside the date window or off topic)`);
  if (nBullets > cap) problems.push(`${nBullets} items, the limit is ${cap}`);
  if (lim.perGroup) {
    const per = {};
    for (const k of known) { const g = items.find((i) => i.key === k).group; per[g] = (per[g] || 0) + 1; }
    const over = Object.entries(per).filter(([, n]) => n > lim.perGroup);
    if (over.length) problems.push(`${over.map(([g, n]) => `${n} from r/${g}`).join(', ')}, the limit is ${lim.perGroup} per subreddit`);
  }
  return { applicable: true, problems, summary: `${hits} of ${expectN} qualifying item(s) listed${wrong ? `, ${wrong} not qualifying` : ''}` };
}

function gradeShops(a, silent, errorLine, results) {
  // A fetched page starts "# <title>\nURL: <url>"; a failed fetch is "Could not fetch <url>: ...".
  const pageUrl = (r) => (r.text.match(/^Could not fetch (\S+):\s/) || r.text.slice(0, 2000).match(/^URL:\s*(\S+)/m) || [])[1] || '';
  const shops = results.filter((r) => SHOP_RE.test(pageUrl(r)));
  const read = shops.filter((r) => !r.failed);
  if (!shops.length && !silent) return { applicable: false, problems: [], summary: 'no shop page requested' };
  const problems = [];
  if (silent && !read.length) problems.push(`[SILENT] but no shop page could be read (${shops.length} failed)`);
  if (errorLine && read.length) problems.push(`error line but ${read.length} shop page(s) were read`);
  if (!silent && !errorLine) {
    const hay = results.map((r) => r.text).join('\n').replace(/[.\s]/g, '');
    const fake = bullets(a).map((l) => (l.match(/(\d[\d.,]*)\s*€/) || [])[1]).filter(Boolean)
      .filter((p) => { const digits = p.replace(/[.,]\d\d$/, '').replace(/[.,]/g, ''); return !hay.includes(digits); });
    if (fake.length) problems.push(`price(s) not in any tool result: ${fake.join(', ')}`);
    if (!bullets(a).length) problems.push('no offer bullets');
  }
  return { applicable: true, problems, summary: `${read.length} of ${shops.length} shop page(s) read` };
}

/** True when a tool result in the run is a fetch failure (also inside the JSON envelope). */
const anyToolFailed = (messages) => toolResults(messages).some((r) => r.failed);

module.exports = { gradeContent, toolResults, anyToolFailed, JOBS };
