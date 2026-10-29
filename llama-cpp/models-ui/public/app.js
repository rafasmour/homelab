'use strict';
// Model downloads UI: HF search -> quant table -> router pull; local model list; live router events.
(() => {
  const $ = (id) => document.getElementById(id);
  const GiB = 1024 ** 3;
  const fmtSize = (b) => (b ? (b >= GiB ? `${(b / GiB).toFixed(2)} GiB` : `${(b / 1024 ** 2).toFixed(0)} MiB`) : '?');
  const fmtNum = (n) => (n == null ? '?' : Intl.NumberFormat('en', { notation: 'compact' }).format(n));
  const fmtDate = (s) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(+d) ? d.toISOString().slice(0, 10) : ''; };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 8000 : 4000);
  }

  async function api(path, opts = {}) {
    const headers = { Accept: 'application/json', ...(opts.headers || {}) };
    if (opts.method && opts.method !== 'GET') headers['X-Requested-With'] = 'models-ui';
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { ...opts, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined, credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login'; throw new Error('login required'); }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
    if (!r.ok) {
      const e = data && (data.error?.message || data.error || data.message);
      throw new Error(typeof e === 'string' ? e : `HTTP ${r.status}`);
    }
    return data;
  }

  // ---------------------------------------------------------------- local models
  let localModels = [];
  const localIds = () => new Set(localModels.map((m) => String(m.id || '').toLowerCase()));
  const statusOf = (m) => {
    const s = m.status;
    if (s && typeof s === 'object') return s.failed ? 'failed' : (s.value || s.status || '');
    return s || (m.in_cache ? 'cached' : '');
  };

  async function loadModels() {
    try {
      const data = await api('/api/models');
      localModels = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
      $('models-error').hidden = true;
    } catch (e) {
      $('models-error').textContent = `Router: ${e.message}`;
      $('models-error').hidden = false;
    }
    renderModels();
    if (currentRepo) renderRepo(currentRepo);
  }

  function renderModels() {
    const ul = $('models');
    ul.replaceChildren();
    if (!localModels.length) { ul.append(el('li', { class: 'muted' }, 'No models reported.')); return; }
    const sorted = [...localModels].sort((a, b) => String(a.source || '').localeCompare(String(b.source || '')) || String(a.id).localeCompare(String(b.id)));
    for (const m of sorted) {
      const st = statusOf(m);
      const actions = el('span', { class: 'row-actions' });
      if (m.can_remove === true) {
        actions.append(el('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => removeModel(m.id) }, 'Delete'));
      }
      ul.append(el('li', { class: 'model' },
        el('div', { class: 'model-main' },
          el('span', { class: 'mono model-id', title: m.path || '' }, m.id || '?'),
          el('span', { class: 'tags' },
            m.source ? el('span', { class: `tag src-${String(m.source).replace(/\W/g, '')}` }, m.source) : null,
            st ? el('span', { class: `tag st-${String(st).replace(/\W/g, '')}` }, st) : null)),
        actions));
    }
  }

  async function removeModel(id) {
    if (!confirm(`Delete the downloaded files of ${id}?`)) return;
    try {
      await api(`/api/models?model=${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`Deleted ${id}`);
    } catch (e) { toast(`Delete failed: ${e.message}`, true); }
    loadModels();
  }

  // ---------------------------------------------------------------- search and repo
  let currentRepo = null;

  async function doSearch(q) {
    const list = $('results-list');
    $('results').hidden = false;
    list.replaceChildren(el('li', { class: 'muted' }, 'Searching...'));
    $('results-count').textContent = '';
    try {
      const rows = await api(`/api/search?q=${encodeURIComponent(q)}`);
      list.replaceChildren();
      $('results-count').textContent = `(${rows.length})`;
      if (!rows.length) list.append(el('li', { class: 'muted' }, 'No GGUF repositories found.'));
      for (const r of rows) {
        list.append(el('li', {},
          el('button', { class: 'result', type: 'button', onclick: () => openRepo(r.id) },
            el('span', { class: 'mono' }, r.id),
            el('span', { class: 'muted small nowrap' }, `${fmtNum(r.downloads)} dl · ${fmtNum(r.likes)} likes · ${fmtDate(r.lastModified)}`))));
      }
    } catch (e) {
      list.replaceChildren(el('li', { class: 'error' }, `Search failed: ${e.message}`));
    }
  }

  async function openRepo(id) {
    $('repo').hidden = false;
    $('repo-title').textContent = id;
    $('repo-meta').textContent = 'Loading files...';
    $('quant-rows').replaceChildren();
    $('repo-extra').replaceChildren();
    $('repo-link').href = `https://huggingface.co/${id}`;
    try {
      currentRepo = await api(`/api/repo?id=${encodeURIComponent(id)}`);
      renderRepo(currentRepo);
      $('repo').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      currentRepo = null;
      $('repo-meta').textContent = `Could not load repository: ${e.message}`;
    }
  }

  function renderRepo(r) {
    $('repo-meta').textContent = `${fmtNum(r.downloads)} downloads · ${fmtNum(r.likes)} likes · updated ${fmtDate(r.lastModified)}${r.gated ? ' · gated (needs HF_TOKEN with access)' : ''}`;
    const have = localIds();
    const tbody = $('quant-rows');
    tbody.replaceChildren();
    if (!r.quants.length) tbody.append(el('tr', {}, el('td', { colspan: 4, class: 'muted' }, 'No quantised GGUF files recognised in this repository.')));
    for (const q of r.quants) {
      const model = `${r.id}:${q.quant}`;
      const local = have.has(model.toLowerCase());
      const progress = activity.get(model.toLowerCase());
      const files = q.split ? `${q.parts}${q.expected_parts ? ` of ${q.expected_parts}` : ''} parts` : q.files[0].split('/').pop();
      tbody.append(el('tr', {},
        el('td', { class: 'mono' }, q.quant),
        el('td', { class: 'r num nowrap' }, fmtSize(q.size)),
        el('td', { class: 'small muted files', title: q.files.join('\n') }, files),
        el('td', { class: 'r' }, local
          ? el('span', { class: 'tag st-loaded' }, 'local')
          : el('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: progress && progress.active ? true : null, onclick: (ev) => pull(r.id, q.quant, ev.currentTarget) }, progress && progress.active ? 'Downloading' : 'Download'))));
    }
    const extra = $('repo-extra');
    extra.replaceChildren();
    if (r.mmproj.length) extra.append(el('p', {}, `Multimodal projectors: ${r.mmproj.map((m) => `${m.file.split('/').pop()} (${fmtSize(m.size)})`).join(', ')}. The router fetches a matching one with the quant.`));
    if (r.sidecars && r.sidecars.length) extra.append(el('p', {}, `Draft sidecars (MTP/DFlash): ${r.sidecars.map((m) => `${m.file} (${fmtSize(m.size)})`).join(', ')}. The router fetches these itself when the model uses them.`));
    if (r.other.length) extra.append(el('p', {}, `Other GGUF files without a recognised quant tag: ${r.other.map((m) => m.file).join(', ')}.`));
  }

  async function pull(repo, quant, btn) {
    const model = `${repo}:${quant}`;
    const q = currentRepo && currentRepo.quants.find((x) => x.quant === quant);
    if (!confirm(`Download ${model}${q ? ` (${fmtSize(q.size)})` : ''} into models/cache?`)) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Starting'; }
    try {
      await api('/api/pull', { method: 'POST', json: { repo, quant } });
      toast(`Download started: ${model}`);
      noteActivity(model, { kind: 'pull requested', active: true });
    } catch (e) {
      toast(`Download failed: ${e.message}`, true);
      if (btn) { btn.disabled = false; btn.textContent = 'Download'; }
    }
    loadModels();
  }

  // ---------------------------------------------------------------- live events
  const activity = new Map(); // lower-case model -> { model, kind, pct, done, total, active, at }
  function noteActivity(model, info) {
    const key = String(model).toLowerCase();
    activity.set(key, { ...(activity.get(key) || {}), model, ...info, at: Date.now() });
    renderActivity();
  }
  function renderActivity() {
    const ul = $('activity');
    ul.replaceChildren();
    const rows = [...activity.values()].sort((a, b) => b.at - a.at).slice(0, 30);
    if (!rows.length) { ul.append(el('li', { class: 'muted' }, 'No router events yet.')); return; }
    for (const a of rows) {
      const pct = a.pct != null ? Math.max(0, Math.min(100, a.pct)) : null;
      ul.append(el('li', {},
        el('div', { class: 'act-head' }, el('span', { class: 'mono model-id' }, a.model), el('span', { class: 'muted small nowrap' }, a.kind || '')),
        pct != null ? el('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': pct.toFixed(0), 'aria-valuemin': 0, 'aria-valuemax': 100 }, bar(pct)) : null,
        (a.done != null || pct != null) ? el('div', { class: 'muted small num' }, [a.done != null ? `${fmtSize(a.done)}${a.total ? ` of ${fmtSize(a.total)}` : ''}` : '', pct != null ? ` ${pct.toFixed(1)}%` : ''].join('')) : null,
        a.detail ? el('div', { class: 'small muted detail' }, a.detail) : null));
    }
  }

  // CSSOM writes are allowed by the CSP (style-src 'self'); style attributes are not.
  function bar(pct) { const s = el('span'); s.style.width = `${pct.toFixed(1)}%`; return s; }

  // Flattens one level of nesting so progress fields are found wherever the router puts them.
  function flat(o, out = {}, prefix = '') {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) flat(v, out, `${k}.`);
      else out[prefix + k] = v;
    }
    return out;
  }
  function onEvent(name, raw) {
    let d;
    try { d = JSON.parse(raw); } catch { d = { message: raw }; }
    if (d == null || typeof d !== 'object') d = { message: String(d) };
    const f = flat(d);
    const kind = String(d.event || d.type || (name !== 'message' ? name : '') || (typeof d.status === 'string' ? d.status : d.status?.value) || 'event');
    const model = d.model || d.id || d.name || d.model_name || f['data.model'] || f['data.id'] || 'router';
    const num = (re) => { for (const [k, v] of Object.entries(f)) if (re.test(k) && typeof v === 'number' && Number.isFinite(v)) return v; return null; };
    const done = num(/(downloaded|nread|received|current|bytes_done|done_bytes)$/i);
    const total = num(/(total|size|content_length|bytes_total)$/i);
    let pct = num(/(progress|percent|pct)$/i);
    if (pct != null && pct <= 1 && !/percent|pct/i.test(Object.keys(f).join(' '))) pct *= 100;
    if (pct == null && done != null && total) pct = (100 * done) / total;
    const finished = /finish|succeed|complete|done|fail|error|remove/i.test(kind);
    const err = d.error || d.message;
    noteActivity(String(model), {
      kind, done, total, pct: finished && /finish|succeed|complete/i.test(kind) ? 100 : pct,
      active: !finished && (done != null || pct != null || /download|pull|start/i.test(kind)),
      detail: typeof err === 'string' && err !== raw ? err : (err && typeof err === 'object' ? JSON.stringify(err) : null),
    });
    if (finished || /status|load|reload/i.test(kind)) scheduleReload();
  }
  let reloadTimer;
  const scheduleReload = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(loadModels, 800); };

  function connectEvents() {
    const live = $('live');
    const es = new EventSource('/api/events');
    const names = ['message', 'download_progress', 'download_finished', 'download_failed', 'status_change', 'model_status', 'model_remove', 'models_reload'];
    for (const n of names) es.addEventListener(n, (ev) => onEvent(n, ev.data));
    es.addEventListener('relay-open', () => { live.textContent = 'events: live'; live.className = 'pill ok'; });
    es.addEventListener('relay-error', (ev) => {
      let msg = 'unavailable';
      try { msg = JSON.parse(ev.data).error || msg; } catch { /* ignore */ }
      live.textContent = 'events: offline';
      live.title = msg;
      live.className = 'pill bad';
    });
    es.onerror = () => { if (live.className !== 'pill bad') { live.textContent = 'events: reconnecting'; live.className = 'pill'; } };
  }

  // ---------------------------------------------------------------- wiring
  $('search-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = $('q').value.trim();
    if (q) doSearch(q);
  });
  $('refresh').addEventListener('click', loadModels);
  loadModels();
  connectEvents();
  setInterval(loadModels, 60000);
})();
