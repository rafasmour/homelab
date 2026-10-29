'use strict';
// llama-models-ui: browse GGUF repositories on Hugging Face and pull, list and
// delete models through the llama.cpp router's own model API.
// Node built-ins only (node:http, node:crypto, global fetch). The router API key
// is added here, server-side; the browser never sees it.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8080);
const LLAMA_URL = String(process.env.LLAMA_URL || 'http://llama-server:8080').replace(/\/+$/, '');
const LLAMA_API_KEY = process.env.LLAMA_API_KEY || '';
const HF_TOKEN = process.env.HF_TOKEN || '';
const HF = 'https://huggingface.co';
const PUBLIC = path.join(__dirname, 'public');
const USERNAME = process.env.MODELS_UI_USERNAME || '';
const PASSWORD = process.env.MODELS_UI_PASSWORD || '';
if (!USERNAME || !PASSWORD || !LLAMA_API_KEY) {
  console.error('MODELS_UI_USERNAME, MODELS_UI_PASSWORD and LLAMA_API_KEY must be set');
  process.exit(1);
}

// ------------------------------------------------------------------ input validation
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const QUANT_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const MODEL_RE = /^[\w.:/@+-]{1,256}$/;
const validRepo = (s) => typeof s === 'string' && s.length <= 200 && REPO_RE.test(s) && !s.split('/').some((p) => p === '.' || p === '..');
const validQuant = (s) => typeof s === 'string' && QUANT_TAG_RE.test(s);
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ------------------------------------------------------------------ GGUF quant grouping
// Quant tag at the end of a file stem or folder name: Q4_K_M, Q8_0, IQ3_XXS, UD-Q4_K_XL,
// TQ1_0, MXFP4_MOE, NVFP4, F16, BF16, F32. The router accepts the same tag as "<repo>:<tag>".
const TAG = '(?:UD-)?(?:I?Q\\d+(?:_[A-Z0-9]+)*|TQ\\d+_\\d+|MXFP4(?:_MOE)?|NVFP4|BF16|F16|F32)';
const QUANT_RE = new RegExp(`(?:^|[-_.])(${TAG})$`, 'i');
// Fallback for names like "Model-NVFP4-MTP": the last tag-shaped token anywhere.
const QUANT_ANY_RE = new RegExp(`(?:^|[-_.])(${TAG})(?=$|[-_.])`, 'gi');
const SPLIT_RE = /-(\d{5})-of-(\d{5})$/;

function normaliseTag(t) {
  const up = t.toUpperCase();
  return up.startsWith('UD-') ? `UD-${up.slice(3)}` : up;
}
/** Quant tag of a .gguf path, from the file stem first, then from its folders. */
function quantOf(file) {
  const parts = file.split('/');
  const stem = parts.pop().replace(/\.gguf$/i, '').replace(SPLIT_RE, '');
  const names = [stem, ...parts.reverse()];
  for (const name of names) {
    const m = name.match(QUANT_RE);
    if (m) return normaliseTag(m[1]);
  }
  const any = [...stem.matchAll(QUANT_ANY_RE)];
  return any.length ? normaliseTag(any[any.length - 1][1]) : null;
}

function groupGguf(siblings) {
  const quants = new Map();
  const mmproj = [];
  const sidecars = [];
  const other = [];
  for (const s of siblings || []) {
    const file = s && s.rfilename;
    if (typeof file !== 'string' || !/\.gguf$/i.test(file)) continue;
    const size = Number(s.size ?? (s.lfs && s.lfs.size) ?? 0) || 0;
    const base = file.split('/').pop();
    if (/mmproj/i.test(base)) { mmproj.push({ file, size, quant: quantOf(file) }); continue; }
    // Speculative-decoding drafts (MTP/DFlash) are sidecars the router fetches itself.
    if (/^(mtp|draft|dflash)[-_]/i.test(base) || /(^|\/)(mtp|draft|dflash)\//i.test(file)) { sidecars.push({ file, size, quant: quantOf(file) }); continue; }
    const tag = quantOf(file);
    if (!tag) { other.push({ file, size }); continue; }
    const split = base.replace(/\.gguf$/i, '').match(SPLIT_RE);
    const q = quants.get(tag) || { quant: tag, size: 0, files: [], parts: 0, expected_parts: 0 };
    q.size += size;
    q.files.push(file);
    q.parts += 1;
    if (split) q.expected_parts = Math.max(q.expected_parts, Number(split[2]));
    quants.set(tag, q);
  }
  const list = [...quants.values()].map((q) => ({ ...q, split: q.parts > 1 || q.expected_parts > 1 })).sort((a, b) => a.size - b.size);
  return { quants: list, mmproj: mmproj.sort((a, b) => a.size - b.size), sidecars, other };
}

// ------------------------------------------------------------------ upstream calls
async function hf(pathAndQuery) {
  const headers = { Accept: 'application/json', 'User-Agent': 'homelab-llama-models-ui' };
  if (HF_TOKEN) headers.Authorization = `Bearer ${HF_TOKEN}`;
  let r;
  try {
    r = await fetch(HF + pathAndQuery, { headers, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw Object.assign(new Error(`Hugging Face unreachable: ${e.message}`), { status: 502 });
  }
  if (r.status === 404 || r.status === 401) throw Object.assign(new Error('repository not found (or gated without HF_TOKEN access)'), { status: 404 });
  if (!r.ok) throw Object.assign(new Error(`Hugging Face returned ${r.status}`), { status: 502 });
  return r.json();
}

async function search(q) {
  q = String(q || '').trim();
  if (!q) return [];
  if (q.length > 100) throw bad('query too long');
  const qs = new URLSearchParams({ search: q, filter: 'gguf', sort: 'downloads', direction: '-1', limit: '30' });
  const data = await hf(`/api/models?${qs}`);
  return (Array.isArray(data) ? data : []).map((m) => ({
    id: m.id || m.modelId,
    downloads: m.downloads ?? null,
    likes: m.likes ?? null,
    lastModified: m.lastModified || m.createdAt || null,
  })).filter((m) => typeof m.id === 'string');
}

async function repo(id) {
  if (!validRepo(id)) throw bad('invalid repository id');
  const data = await hf(`/api/models/${id}?blobs=true`);
  const g = groupGguf(data.siblings);
  return {
    id: data.id || id,
    gated: data.gated || false,
    downloads: data.downloads ?? null,
    likes: data.likes ?? null,
    lastModified: data.lastModified || null,
    ...g,
  };
}

/** Calls the router with the API key; returns { status, type, body } without throwing on HTTP errors. */
async function router(method, pathAndQuery, json) {
  const headers = { Authorization: `Bearer ${LLAMA_API_KEY}`, Accept: 'application/json' };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  let r;
  try {
    r = await fetch(LLAMA_URL + pathAndQuery, {
      method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { status: 502, type: 'application/json; charset=utf-8', body: JSON.stringify({ error: `llama-server unreachable: ${e.cause?.code || e.message}` }) };
  }
  const body = await r.text();
  let type = r.headers.get('content-type') || 'application/json; charset=utf-8';
  if (!/json/i.test(type)) {
    type = 'application/json; charset=utf-8';
    return { status: r.status, type, body: JSON.stringify(r.ok ? { ok: true, message: body } : { error: body || `llama-server returned ${r.status}` }) };
  }
  return { status: r.status, type, body };
}

// Live router events (download progress, status changes), relayed as SSE.
let sseClients = 0;
async function relayEvents(req, res) {
  if (sseClients >= 20) return send(res, 429, { error: 'too many event streams' });
  sseClients += 1;
  const ac = new AbortController();
  let atBoundary = true;
  const ping = setInterval(() => { if (atBoundary) res.write(': ping\n\n'); }, 25000);
  const done = () => { clearInterval(ping); ac.abort(); };
  req.on('close', done);
  res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n\n');
  const fail = (msg) => res.write(`event: relay-error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
  try {
    const r = await fetch(`${LLAMA_URL}/models/sse`, {
      headers: { Authorization: `Bearer ${LLAMA_API_KEY}`, Accept: 'text/event-stream' }, signal: ac.signal,
    });
    if (!r.ok || !r.body) fail(`llama-server returned ${r.status}`);
    else {
      res.write('event: relay-open\ndata: {}\n\n');
      for await (const chunk of r.body) {
        res.write(chunk);
        atBoundary = Buffer.from(chunk).toString('utf8').endsWith('\n\n');
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) fail(`llama-server unreachable: ${e.cause?.code || e.message}`);
  } finally {
    sseClients -= 1;
    clearInterval(ping);
    res.end();
  }
}

// ------------------------------------------------------------------ login
// Stateless session cookie "<expiry>.<hmac>", signed with a key that lives only
// in this process: restarting the container (or changing the credentials,
// which needs a restart) logs everyone out.
const COOKIE = 'models_session';
const SESSION_S = 7 * 24 * 3600;
const SESSION_KEY = crypto.randomBytes(32);
const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const sign = (exp) => crypto.createHmac('sha256', SESSION_KEY).update(`${USERNAME}\n${exp}`).digest('base64url');

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function loggedIn(req) {
  const [exp, mac] = (cookies(req)[COOKIE] || '').split('.');
  if (!exp || !mac || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return same(mac, sign(exp));
}
const sessionCookie = (value, maxAge) => `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict`;

// Failed logins per client address (Traefik's X-Forwarded-For): 10 per 15 min.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return fwd[fwd.length - 1] || req.socket.remoteAddress || '?';
}
function blocked(ip) {
  const f = failures.get(ip);
  if (f && Date.now() - f.first > WINDOW_MS) { failures.delete(ip); return false; }
  return Boolean(f && f.count >= 10);
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count += 1;
  if (failures.size > 10000) failures.clear();
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function loginPage(message = '') {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Model downloads</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/style.css">
</head>
<body class="login-body">
  <main class="login">
    <div class="login-brand">
      <img class="brand-mark" src="/favicon.svg" alt="">
      <div><h1>Model downloads</h1><p>Sign in to manage the llama.cpp models.</p></div>
    </div>
    <form method="post" action="/login">
      <label>Username <input name="username" autocomplete="username" required autofocus></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      ${message ? `<p class="login-error" role="alert">${esc(message)}</p>` : ''}
      <button class="btn btn-primary wide" type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (blocked(ip)) return send(res, 429, loginPage('Too many failed attempts. Try again in 15 minutes.'), TYPES['.html']);
  const form = new URLSearchParams(await readBody(req));
  const ok = same(form.get('username') || '', USERNAME) && same(form.get('password') || '', PASSWORD);
  if (!ok) {
    noteFailure(ip);
    await new Promise((r) => setTimeout(r, 500));
    return send(res, 401, loginPage('Wrong username or password.'), TYPES['.html']);
  }
  failures.delete(ip);
  const exp = Math.floor(Date.now() / 1000) + SESSION_S;
  return send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/', 'Set-Cookie': sessionCookie(`${exp}.${sign(exp)}`, SESSION_S) });
}

// ------------------------------------------------------------------ HTTP
const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SEC = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { ...SEC, 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}
const sendRouter = (res, r) => send(res, r.status, r.body, r.type);

// Paths reachable without a session: the login form, its stylesheet and icon, and the health check.
const PUBLIC_PATHS = new Set(['/login', '/style.css', '/favicon.svg', '/healthz']);

// Changing requests must come from app.js: a custom header forces a CORS
// preflight, which this server never answers, on top of the SameSite cookie.
const fromApp = (req) => req.headers['x-requested-with'] === 'models-ui';

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: 'bad url' }); }
  const p = url.pathname;
  const m = req.method;
  try {
    if (p === '/healthz' && (m === 'GET' || m === 'HEAD')) return send(res, 200, { ok: true });
    if (m === 'POST' && p === '/login') return await handleLogin(req, res);
    if (m === 'POST' && p === '/logout') return send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/login', 'Set-Cookie': sessionCookie('', 0) });
    if (!PUBLIC_PATHS.has(p) && !loggedIn(req)) {
      return p.startsWith('/api/') ? send(res, 401, { error: 'login required' }) : send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/login' });
    }
    if (m === 'GET' || m === 'HEAD') {
      if (p === '/login') return loggedIn(req) ? send(res, 303, '', 'text/plain; charset=utf-8', { Location: '/' }) : send(res, 200, loginPage(), TYPES['.html']);
      if (STATIC[p]) {
        const f = path.join(PUBLIC, STATIC[p]);
        return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]);
      }
      if (p === '/api/search') return send(res, 200, await search(url.searchParams.get('q')));
      if (p === '/api/repo') return send(res, 200, await repo(url.searchParams.get('id') || ''));
      if (p === '/api/models') return sendRouter(res, await router('GET', '/models'));
      if (p === '/api/events') return await relayEvents(req, res);
      return send(res, 404, { error: 'not found' });
    }
    if (m === 'POST' && p === '/api/pull') {
      if (!fromApp(req)) return send(res, 403, { error: 'forbidden' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch (e) { if (e.status) throw e; throw bad('invalid JSON'); }
      const { repo: id, quant } = body || {};
      if (!validRepo(id)) throw bad('invalid repository id');
      if (!validQuant(quant)) throw bad('invalid quant tag');
      console.log(new Date().toISOString(), 'pull', `${id}:${quant}`);
      return sendRouter(res, await router('POST', '/models', { model: `${id}:${quant}` }));
    }
    if (m === 'DELETE' && p === '/api/models') {
      if (!fromApp(req)) return send(res, 403, { error: 'forbidden' });
      const model = url.searchParams.get('model') || '';
      if (!MODEL_RE.test(model)) throw bad('invalid model name');
      console.log(new Date().toISOString(), 'delete', model);
      return sendRouter(res, await router('DELETE', `/models?model=${encodeURIComponent(model)}`));
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), m, p, e.message);
    if (res.headersSent) return res.end();
    return send(res, status, { error: status === 500 ? 'internal error' : e.message });
  }
});

server.listen(PORT, () => console.log(`llama-models-ui on :${PORT}, router ${LLAMA_URL}, HF token ${HF_TOKEN ? 'set' : 'not set'}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
