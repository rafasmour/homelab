'use strict';
// llama.cpp router client: list presets, load/unload models, wait for status.
const BASE = (process.env.LLAMA_URL || 'http://llama-server:8080').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (process.env.LLAMA_API_KEY) h.Authorization = `Bearer ${process.env.LLAMA_API_KEY}`;
  return h;
}

async function request(method, path, body, timeoutMs = 30_000) {
  const res = await fetch(BASE + path, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

function statusOf(m) {
  const s = m && m.status;
  if (!s) return { value: 'unknown' };
  if (typeof s === 'string') return { value: s };
  return { value: s.value || 'unknown', failed: Boolean(s.failed), exitCode: s.exit_code };
}

/** GET /models → [{id, aliases, source, status, failed}] */
async function listModels() {
  const r = await request('GET', '/models');
  if (!r.ok) throw new Error(`GET /models failed: HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return (r.json.data || []).map((m) => ({
    id: m.id,
    aliases: m.aliases || [],
    source: m.source,
    status: statusOf(m).value,
    failed: statusOf(m).failed,
  }));
}

/** Preset models the benchmark can test (skips -vision variants and disabled presets). */
async function presetModels() {
  const all = await listModels();
  return all.filter((m) => m.source === 'preset' && !/-vision$/.test(m.id) && !/dflash/i.test(m.id));
}

async function getModel(id) {
  return (await listModels()).find((m) => m.id === id || m.aliases.includes(id));
}

async function unload(id, { timeoutMs = 120_000 } = {}) {
  const r = await request('POST', '/models/unload', { model: id });
  // Unloading is asynchronous: wait until the router reports the model gone.
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const m = await getModel(id).catch(() => null);
    if (!m || !['loaded', 'loading', 'sleeping', 'unloading'].includes(m.status)) break;
    await sleep(1000);
  }
  return r;
}

/** Unload every other loaded model, load `id`, wait until loaded or failed. */
async function load(id, { timeoutMs = 900_000, log = () => {} } = {}) {
  const started = Date.now();
  for (const m of await listModels()) {
    if (m.id !== id && ['loaded', 'loading', 'sleeping'].includes(m.status)) {
      log(`unloading ${m.id}`);
      await unload(m.id).catch(() => {});
    }
  }
  const cur = await getModel(id);
  if (!cur) return { ok: false, ms: 0, error: `model ${id} not found in /models` };
  // A sleeping model is resident and wakes on the next request.
  if (cur.status === 'loaded' || cur.status === 'sleeping') return { ok: true, ms: Date.now() - started, already: true };
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await request('POST', '/models/load', { model: id }, 60_000).catch((e) => ({ ok: false, status: 0, text: String(e) }));
    // "model limit reached" while a previous model is still shutting down: retry for up to 2 min.
    if (r.ok || !/limit reached|try again/i.test(String(r.text)) || attempt >= 40) break;
    await sleep(3000);
  }
  if (!r.ok && r.status !== 409) return { ok: false, ms: Date.now() - started, error: `POST /models/load: HTTP ${r.status} ${String(r.text).slice(0, 300)}` };
  let sawLoading = false;
  while (Date.now() - started < timeoutMs) {
    await sleep(3000);
    let m;
    try { m = await getModel(id); } catch (e) { log(`poll error: ${e.message}`); continue; }
    if (!m) return { ok: false, ms: Date.now() - started, error: 'model disappeared from /models' };
    if (m.status === 'loaded' || m.status === 'sleeping') return { ok: true, ms: Date.now() - started };
    if (m.failed || m.status === 'failed') return { ok: false, ms: Date.now() - started, error: `status ${m.status} (failed)` };
    if (m.status === 'loading') sawLoading = true;
    else if (m.status === 'unloaded' && sawLoading) return { ok: false, ms: Date.now() - started, error: 'model went back to unloaded while loading (load failed)' };
  }
  return { ok: false, ms: Date.now() - started, error: `timeout after ${Math.round(timeoutMs / 1000)} s` };
}

module.exports = { listModels, presetModels, getModel, load, unload, BASE };
