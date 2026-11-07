'use strict';
// Benchmark UI: plain JS, no dependencies. All view state lives in the URL query string.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));
  const fmtInt = (v) => (v == null ? '–' : Math.round(v).toLocaleString('en-US'));
  const fmtCompact = (v) => (v == null ? '–' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v));
  const fmtDur = (s) => {
    if (s == null) return '–';
    if (s < 60) return `${fmt(s)} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${Math.round(s - m * 60)} s`;
  };
  const fmtDate = (v) => (v ? String(v).replace('T', ' ').replace(/(:\d\d)(\.\d+)?Z?$/, '$1').slice(0, 16) : '–');
  const median = (xs) => {
    const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  };
  /** Leaderboard order (same as the server): average score, then pass rate, then Task correct rate. */
  const byRank = (x, y) => ((y.avg_score ?? -1) - (x.avg_score ?? -1)) || ((y.pass_rate ?? -1) - (x.pass_rate ?? -1))
    || ((y.correct_rate ?? -1) - (x.correct_rate ?? -1)) || x.model.localeCompare(y.model);
  const tone = (v) => (v == null ? 'tone-none' : v >= 80 ? 'tone-good' : v >= 50 ? 'tone-mid' : 'tone-bad');

  const FILTER_KEYS = ['benchmark', 'versions', 'runs', 'models', 'cases', 'profiles', 'kinds', 'status', 'check_pass', 'check_fail', 'q',
    'score_min', 'score_max', 'tool_min', 'tool_max', 'tokens_min', 'tokens_max', 'dur_min', 'dur_max'];
  const RANGES = [
    { key: 'score', label: 'Score', max: 100, hint: '0–100' },
    { key: 'tool', label: 'Tool used %', max: 100, hint: '0–100' },
    { key: 'tokens', label: 'Tokens (prompt + output)' },
    { key: 'dur', label: 'Time per case (s)' },
  ];
  const RANGE_KEYS = RANGES.flatMap((r) => [`${r.key}_min`, `${r.key}_max`]);
  const PAGE = 25;
  let META = null;

  // ------------------------------------------------------------------ definitions (tooltips + aria-describedby)
  const DEF = {
    n: ['Results', 'Number of case results included: every selected run and repeat.'],
    avg_score: ['Avg score', 'Mean case score, 0–100. Per case: run finished 15 + task correctness 50 + rules 20, normalised over the checks that apply. A run that did not finish is capped at 25, a wrong task result at 50; timeout and error score 0. Speed is not part of it. Equal scores are ranked by pass rate, then by Task correct rate.'],
    pass_rate: ['Pass rate', 'Share of results where every check passed. "n / N cases" = distinct cases this model has results for, out of the N cases in the current selection.'],
    cron_score: ['Cron score', 'Mean score of the scheduled (cron) cases.'],
    chat_score: ['Chat score', '0.75 × mean chat case score + 0.25 × speed score. Speed score: 100 at the fastest median chat time among the models shown, 0 at 5× that time.'],
    median_duration_s: ['Median time / case', 'Median wall time of one case, from start to the final answer. Cases where the model failed to load or was skipped are excluded.'],
    median_decode_tps: ['Generation speed (tok/s)', 'Median output tokens generated per second while the model writes its answer (llama.cpp decode speed).'],
    median_prompt_tps: ['Prompt speed (tok/s)', 'Median prompt tokens processed per second before the model starts writing (llama.cpp prompt processing).'],
    prompt_tokens_total: ['Total prompt tokens', 'All prompt (input) tokens sent to the model over the included results.'],
    output_tokens_total: ['Total output tokens', 'All tokens the model generated over the included results.'],
    prompt_tokens_mean: ['Avg prompt tokens / case', 'Average prompt (input) tokens of one case result, summed over all model calls of that case.'],
    output_tokens_mean: ['Avg output tokens / case', 'Average tokens the model generated in one case result.'],
    tool_used_pct: ['Tool used %', 'Share of model calls that contained at least one tool call, averaged over the results.'],
    tool_calls_total: ['Tool calls', 'Total number of tool calls made.'],
    load_s: ['Load time (s)', 'Time to load the model in llama.cpp, averaged over the selected runs.'],
    gpu_peak_mem_c: ['GPU memory peak (°C)', 'Peak GPU memory temperature during the run, averaged over the selected runs.'],
    gpu_peak_vram_gib: ['VRAM peak (GiB)', 'Peak GPU memory in use during the run, averaged over the selected runs.'],
    failures: ['Failures', 'Failed checks plus timeouts and errors, summed over all results.'],
    score: ['Score', 'Case score, 0–100 (see Avg score).'],
    duration_s: ['Time', 'Wall time of this case, from start to the final answer.'],
    prompt_tokens: ['Prompt tokens', 'Prompt (input) tokens over all model calls of this case.'],
    output_tokens: ['Output tokens', 'Tokens the model generated in this case.'],
    model_calls: ['Model calls', 'Number of LLM requests Hermes made for this case.'],
    tool_calls: ['Tool calls', 'Number of tool calls made in this case.'],
    decode_tps: ['Generation speed (tok/s)', 'Output tokens generated per second while the model writes.'],
    prompt_tps: ['Prompt speed (tok/s)', 'Prompt tokens processed per second.'],
    repeat_idx: ['Repeat', 'Repeat number when a case ran more than once in a run.'],
    checks: ['Failed checks', 'Checks that failed for this result, with the reason.'],
    partial: ['Partial', 'This model has results for fewer cases than the selection contains, so its averages cover only part of the benchmark. Partial models are ranked below complete ones.'],
  };
  const STATUS_DEF = {
    pass: ['Pass', 'Every check passed.'],
    fail: ['Fail', 'The run finished, but at least one check failed.'],
    error: ['Error', 'The run itself broke (crash, non-zero exit or verification error). Scores 0.'],
    timeout: ['Timeout', 'The run hit the case time limit. Scores 0.'],
    load_failed: ['Load failed', 'The model could not be loaded. Scores 0.'],
    skipped: ['Skipped', 'The case was not run (refused: the profile cannot run on this preset). No score.'],
    infra: ['Infra', 'The environment failed twice (model swapped or crashed, MCP or network down, source rate-limited). Excluded from the score.'],
  };
  const CHECK_INFO = {
    completed: ['Run finished', 'The Hermes run ended normally: no timeout, crash, empty answer, tool-call parse error, truncation or max-turns stop. It says nothing about whether the answer is right.'],
    correct: ['Task correct', 'The task was actually done right, verified against the real Nextcloud, wger or Firefly state or the expected answer.'],
    read_only: ['No data changed', 'A read-only case left the Firefly or Nextcloud data unchanged.'],
    links_real: ['Links are real', 'Every link in the answer appears in a tool result (no invented URLs).'],
    no_reasoning_leak: ['No reasoning leak', 'The answer contains no leaked thinking or internal markup.'],
    no_forbidden_tools: ['Allowed tools only', 'No forbidden tools, no tools outside those named in the prompt (cron; memory and clock are always allowed), no write tools in read-only cases and no repeated identical calls.'],
    spoken_style: ['Spoken style', 'ai-assistant cases: at most 3 short sentences, no Markdown, URLs, emoji, ISO dates or ids, answered in the language of the request.'],
    silent_ok: ['Silent marker OK', 'Cron: [SILENT] is either the whole answer or absent, never mixed with content.'],
    size_ok: ['Size OK', 'Cron: the answer is shorter than 3,500 characters.'],
    timeout: ['Timeout', STATUS_DEF.timeout[1]],
    error: ['Error', STATUS_DEF.error[1]],
    load_failed: ['Load failed', STATUS_DEF.load_failed[1]],
  };
  const checkLabel = (n) => (CHECK_INFO[n] ? CHECK_INFO[n][0] : n);
  const DEFS = new Map();
  function defId(text) {
    if (!DEFS.has(text)) {
      const id = `def-${DEFS.size}`;
      DEFS.set(text, id);
      const span = document.createElement('span');
      span.id = id;
      span.textContent = text;
      $('#defs').appendChild(span);
    }
    return DEFS.get(text);
  }
  const tipHtml = (title, text) => `<b>${esc(title)}</b><br>${esc(text)}`;
  /** Attributes that give an element a hover/focus definition and an accessible description. */
  const defAttrs = (title, text) => `data-tip="${esc(tipHtml(title, text))}" aria-describedby="${defId(`${title}: ${text}`)}"`;

  // ------------------------------------------------------------------ icons (inline SVG, no style attributes)
  const P = {
    chev: '<path d="m6 9 6 6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    sort: '<path d="m7 10 5 5 5-5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    play: '<path d="M6 4v16l14-8z"/>',
    layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><path d="M7.5 7.5h.01"/>',
    flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    pct: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
    hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
    tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    external: '<path d="M14 4h6v6M20 4 10 14M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    thermo: '<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>',
  };
  const icon = (n, cls = '') => `<svg class="i${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  const STATUS_ICON = { pass: 'check', fail: 'x', error: 'alert', timeout: 'clock', load_failed: 'alert', skipped: 'chev', infra: 'alert' };
  const statusTone = (st) => (st === 'pass' ? 'tone-good' : st === 'skipped' ? 'tone-mid' : 'tone-bad');
  const badge = (st, withDef = true) => {
    const d = STATUS_DEF[st];
    return `<span class="badge ${statusTone(st)}"${withDef && d ? ` tabindex="0" ${defAttrs(d[0], d[1])}` : ''}>${icon(STATUS_ICON[st] || 'info')}${esc(st)}</span>`;
  };
  const meter = (v, cls = '') => `<span class="meter${cls ? ` ${cls}` : ''}"><span data-w="${Math.max(0, Math.min(100, Number(v) || 0))}"></span></span>`;
  function applyWidths(root) { root.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; }); }

  // ------------------------------------------------------------------ theme (portfolio pill toggle)
  const themeBtn = $('#theme');
  function currentDark() {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    themeBtn.setAttribute('aria-checked', String(currentDark()));
  }
  try { applyTheme(localStorage.getItem('bench-theme')); } catch { applyTheme(null); }
  themeBtn.addEventListener('click', () => {
    const t = currentDark() ? 'light' : 'dark';
    applyTheme(t);
    try { localStorage.setItem('bench-theme', t); } catch { /* storage unavailable */ }
  });

  // ------------------------------------------------------------------ URL state
  const state = () => new URLSearchParams(location.search);
  function setState(changes, { push = true } = {}) {
    const s = state();
    for (const [k, v] of Object.entries(changes)) {
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) s.delete(k); else s.set(k, Array.isArray(v) ? v.join(',') : v);
    }
    // A filter change resets the results page.
    if (Object.keys(changes).some((k) => FILTER_KEYS.includes(k)) && !('rpage' in changes)) s.delete('rpage');
    const url = `${location.pathname}${s.toString() ? `?${s}` : ''}`;
    if (push) history.pushState(null, '', url); else history.replaceState(null, '', url);
    render();
  }
  const listOf = (s, k) => (s.get(k) ? s.get(k).split(',').filter(Boolean) : []);
  function apiQuery(s, extra = {}) {
    const q = new URLSearchParams();
    for (const k of FILTER_KEYS) if (k !== 'versions' && s.get(k)) q.set(k, s.get(k));
    const ev = effectiveVersions(s);
    if (ev.length) q.set('versions', ev.join(','));
    for (const [k, v] of Object.entries(extra)) q.set(k, v);
    return q.toString();
  }
  async function api(path) {
    const r = await fetch(path, { headers: { Accept: 'application/json' } });
    if (r.status === 401) { location.assign('/login'); throw new Error('login required'); }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  // Benchmark versions: comparisons stay within one version. Without a `versions` parameter the newest version of the
  // selected benchmark is used (unless runs are selected explicitly); `versions=all` mixes every version.
  const versionsOf = (bench) => ((META && META.versions) || []).filter((v) => v.benchmark === bench);
  function effectiveVersions(s) {
    const bench = s.get('benchmark');
    if (!bench) return [];
    const v = listOf(s, 'versions');
    if (v.includes('all')) return [];
    if (v.length) return v;
    if (listOf(s, 'runs').length) return [];
    const vs = versionsOf(bench).filter((x) => x.version !== 'none');
    return vs.length ? [vs[0].version] : [];
  }
  const isRunning = (r) => r && (r.status === 'running' || !r.finished_at);

  // ------------------------------------------------------------------ dropdowns
  // kinds: single (listbox, one value), multi (listbox, checkboxes), checks (tri-state per option), panel (free-form popover).
  const DDS = [];
  function closeAll(except) { for (const d of DDS) if (d !== except) d.close(false); }
  document.addEventListener('pointerdown', (e) => { for (const d of DDS) if (d.isOpen && !d.host.contains(e.target)) d.close(false); });
  window.addEventListener('resize', () => { for (const d of DDS) if (d.isOpen) d.place(); });

  function makeDropdown(host, cfg) {
    const kind = cfg.kind || 'multi';
    const id = `dd-${cfg.key}`;
    const listbox = kind !== 'panel';
    const multi = kind === 'multi' || kind === 'checks';
    const d = { host, isOpen: false, options: [], shown: [], active: 0, sel: new Set(), pass: new Set(), fail: new Set() };
    host.classList.add('dd');
    host.innerHTML = `<button type="button" class="dd-btn" id="${id}-btn" aria-haspopup="${listbox ? 'listbox' : 'dialog'}" aria-expanded="false" aria-controls="${id}-menu">
        ${icon(cfg.icon)}<span class="dd-text"><span class="dd-label">${esc(cfg.label)}</span><span class="dd-value"></span></span><span class="dd-count" hidden></span>${icon('chev', 'chev')}</button>
      <div class="dd-menu${listbox ? '' : ' dd-panel'}" id="${id}-menu"${listbox ? '' : ` role="dialog" aria-label="${esc(cfg.label)}"`} hidden>
        ${cfg.search ? `<div class="dd-search">${icon('search')}<input type="text" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${id}-list" aria-label="Search ${esc(cfg.label.toLowerCase())}" placeholder="Search ${esc(cfg.label.toLowerCase())}…" autocomplete="off" spellcheck="false"></div>` : ''}
        ${multi ? `<div class="dd-tools">${kind === 'multi' ? '<button type="button" class="link-btn" data-act="all">Select all</button>' : ''}<button type="button" class="link-btn" data-act="clear">Clear</button><span class="dd-meta"></span></div>` : ''}
        ${listbox ? `<ul class="dd-list" role="listbox" id="${id}-list" tabindex="0" aria-label="${esc(cfg.label)}"${multi ? ' aria-multiselectable="true"' : ''}></ul><p class="dd-empty" hidden>No matches</p>` : cfg.panel}
      </div>`;
    const btn = $('.dd-btn', host);
    const menu = $('.dd-menu', host);
    const list = $('.dd-list', host);
    const input = $('.dd-search input', host);
    const empty = $('.dd-empty', host);
    const valueEl = $('.dd-value', host);
    const countEl = $('.dd-count', host);
    const metaEl = $('.dd-meta', host);
    const checkState = (o) => (d.pass.has(o.value) ? 'pass' : d.fail.has(o.value) ? 'fail' : 'any');

    function optHtml(o, i) {
      const oid = `${id}-o${i}`;
      if (kind === 'checks') {
        const st = checkState(o);
        const said = st === 'any' ? 'any result' : `must ${st}`;
        return `<li role="option" id="${oid}" data-i="${i}" class="dd-opt chk-opt" aria-selected="${st !== 'any'}" aria-label="${esc(o.label)}: ${said}" title="${esc(o.meta || '')}"><span class="opt-label">${esc(o.label)}</span><span class="seg" aria-hidden="true">${['any', 'pass', 'fail'].map((x) => `<span data-state="${x}" class="seg-${x}${st === x ? ' on' : ''}">${x === 'any' ? 'Any' : x === 'pass' ? 'Pass' : 'Fail'}</span>`).join('')}</span></li>`;
      }
      const on = d.sel.has(o.value);
      return `<li role="option" id="${oid}" data-i="${i}" class="dd-opt" aria-selected="${on}"><span class="${kind === 'single' ? 'radio' : 'cbox'}" aria-hidden="true">${icon('check')}</span><span class="opt-text"><span class="opt-label">${esc(o.label)}</span>${o.meta ? `<span class="opt-meta">${esc(o.meta)}</span>` : ''}</span>${o.badge || ''}${o.count != null ? `<span class="opt-count">${esc(o.count)}</span>` : ''}</li>`;
    }
    function paintActive(scroll = true) {
      if (!list) return;
      list.querySelector('.dd-opt.active')?.classList.remove('active');
      const el = d.shown.length ? list.querySelector(`[data-i="${d.active}"]`) : null;
      if (el) { el.classList.add('active'); if (scroll) el.scrollIntoView({ block: 'nearest' }); }
      for (const x of [list, input]) if (x) { if (el) x.setAttribute('aria-activedescendant', el.id); else x.removeAttribute('aria-activedescendant'); }
    }
    function renderList() {
      if (!list) return;
      const q = input ? input.value.trim().toLowerCase() : '';
      d.shown = q ? d.options.filter((o) => `${o.label} ${o.value} ${o.meta || ''} ${o.group || ''}`.toLowerCase().includes(q)) : d.options;
      let html = '';
      let g = null;
      d.shown.forEach((o, i) => {
        if (o.group && o.group !== g) { g = o.group; html += `<li role="presentation" class="dd-group">${esc(g)}</li>`; }
        html += optHtml(o, i);
      });
      list.innerHTML = html;
      empty.hidden = d.shown.length > 0;
      if (d.active >= d.shown.length) d.active = d.shown.length - 1;
      if (d.active < 0) d.active = 0;
      paintActive(false);
      if (metaEl) metaEl.textContent = kind === 'checks' ? `${d.pass.size + d.fail.size} set` : `${d.sel.size} of ${d.options.length} selected`;
    }
    function renderButton() {
      let value;
      let count = 0;
      if (kind === 'single') value = d.options.find((o) => d.sel.has(o.value))?.label ?? '–';
      else if (kind === 'checks') { count = d.pass.size + d.fail.size; value = count ? `${count} rule${count > 1 ? 's' : ''}` : 'Any'; }
      else if (kind === 'panel') { count = cfg.count(); value = count ? `${count} set` : 'Any'; }
      else {
        count = d.sel.size;
        const first = [...d.sel][0];
        value = !count ? 'All' : count === 1 ? (d.options.find((o) => o.value === first)?.short ?? first) : `${count} selected`;
      }
      valueEl.textContent = value;
      countEl.hidden = !count || kind === 'single';
      countEl.textContent = String(count);
      host.classList.toggle('has-value', count > 0);
      btn.setAttribute('aria-label', `${cfg.label}: ${value}`);
    }
    d.place = () => {
      menu.style.transform = '';
      const r = menu.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      let dx = 0;
      if (r.right > vw - 16) dx = vw - 16 - r.right;
      if (r.left + dx < 16) dx = 16 - r.left;
      if (dx) menu.style.transform = `translateX(${Math.round(dx)}px)`;
    };
    d.open = () => {
      if (d.isOpen) return;
      closeAll(d);
      d.isOpen = true;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      host.classList.add('open');
      if (input) input.value = '';
      if (list) {
        renderList();
        const i = d.shown.findIndex((o) => (kind === 'checks' ? checkState(o) !== 'any' : d.sel.has(o.value)));
        d.active = i >= 0 ? i : 0;
        paintActive();
      }
      if (cfg.onOpen) cfg.onOpen();
      d.place();
      (input || list || menu.querySelector('input, button'))?.focus();
    };
    d.close = (focusBtn) => {
      if (!d.isOpen) return;
      d.isOpen = false;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      host.classList.remove('open');
      if (focusBtn) btn.focus();
    };
    d.set = (options, selected) => {
      if (kind === 'panel') { renderButton(); return; }
      d.options = options;
      if (kind === 'checks') { d.pass = new Set(selected.pass); d.fail = new Set(selected.fail); } else d.sel = new Set(selected);
      renderButton();
      renderList();
    };
    function choose(i, how) {
      const o = d.shown[i];
      if (!o) return;
      d.active = i;
      if (kind === 'single') {
        d.sel = new Set([o.value]);
        d.close(true);
        cfg.onChange(o.value);
        return;
      }
      if (kind === 'checks') {
        const order = ['any', 'pass', 'fail'];
        const cur = checkState(o);
        const next = typeof how === 'string' ? how : order[(order.indexOf(cur) + (how === -1 ? 2 : 1)) % 3];
        d.pass.delete(o.value);
        d.fail.delete(o.value);
        if (next === 'pass') d.pass.add(o.value);
        if (next === 'fail') d.fail.add(o.value);
        renderList(); renderButton();
        cfg.onChange([...d.pass], [...d.fail]);
        return;
      }
      if (d.sel.has(o.value)) d.sel.delete(o.value); else d.sel.add(o.value);
      renderList(); renderButton();
      cfg.onChange([...d.sel]);
    }

    btn.addEventListener('click', () => (d.isOpen ? d.close(true) : d.open()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); d.open(); } });
    if (list) {
      list.addEventListener('click', (e) => {
        const li = e.target.closest('.dd-opt');
        if (!li) return;
        const seg = e.target.closest('[data-state]');
        choose(Number(li.dataset.i), seg ? seg.dataset.state : 1);
      });
      list.addEventListener('mousemove', (e) => {
        const li = e.target.closest('.dd-opt');
        if (li && Number(li.dataset.i) !== d.active) { d.active = Number(li.dataset.i); paintActive(false); }
      });
    }
    if (input) input.addEventListener('input', () => { d.active = 0; renderList(); });
    menu.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]');
      if (!a) return;
      if (a.dataset.act === 'all') { for (const o of d.shown) d.sel.add(o.value); renderList(); renderButton(); cfg.onChange([...d.sel]); }
      if (a.dataset.act === 'clear') {
        if (kind === 'checks') { d.pass.clear(); d.fail.clear(); renderList(); renderButton(); cfg.onChange([], []); } else { d.sel.clear(); renderList(); renderButton(); cfg.onChange([]); }
      }
      if (a.dataset.act === 'done') d.close(true);
    });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { if (d.isOpen) { e.preventDefault(); e.stopPropagation(); d.close(true); } return; }
      if (!d.isOpen || !list) return;
      const inInput = e.target === input;
      const inList = e.target === list;
      if (!inInput && !inList) return;
      const n = d.shown.length;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); if (n) { d.active = Math.min(n - 1, d.active + 1); paintActive(); } break;
        case 'ArrowUp': e.preventDefault(); if (n) { d.active = Math.max(0, d.active - 1); paintActive(); } break;
        case 'PageDown': e.preventDefault(); if (n) { d.active = Math.min(n - 1, d.active + 8); paintActive(); } break;
        case 'PageUp': e.preventDefault(); if (n) { d.active = Math.max(0, d.active - 8); paintActive(); } break;
        case 'Home': if (inList && n) { e.preventDefault(); d.active = 0; paintActive(); } break;
        case 'End': if (inList && n) { e.preventDefault(); d.active = n - 1; paintActive(); } break;
        case 'Enter': e.preventDefault(); choose(d.active, 1); break;
        case ' ': if (inList) { e.preventDefault(); choose(d.active, 1); } break;
        case 'ArrowRight': if (inList && kind === 'checks') { e.preventDefault(); choose(d.active, 1); } break;
        case 'ArrowLeft': if (inList && kind === 'checks') { e.preventDefault(); choose(d.active, -1); } break;
        default:
          if (inList && input && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) input.focus();
      }
    });
    host.addEventListener('focusout', (e) => { if (d.isOpen && e.relatedTarget && !host.contains(e.relatedTarget)) d.close(false); });
    d.renderButton = renderButton;
    DDS.push(d);
    return d;
  }

  // ------------------------------------------------------------------ filter bar
  const rangePanel = `<div class="ranges-grid">${RANGES.map((r) => `<fieldset class="range"><legend>${esc(r.label)}${r.hint ? ` <span class="muted">(${r.hint})</span>` : ''}</legend><div class="range-inputs">
      <input class="input" id="f-${r.key}_min" data-range="${r.key}_min" type="number" min="0"${r.max ? ` max="${r.max}"` : ''} step="any" inputmode="decimal" placeholder="Min" aria-label="${esc(r.label)} minimum">
      <span class="dash" aria-hidden="true">–</span>
      <input class="input" id="f-${r.key}_max" data-range="${r.key}_max" type="number" min="0"${r.max ? ` max="${r.max}"` : ''} step="any" inputmode="decimal" placeholder="Max" aria-label="${esc(r.label)} maximum"></div></fieldset>`).join('')}</div>
    <div class="panel-foot"><button type="button" class="btn btn-ghost btn-sm" data-act="clear-ranges">Reset ranges</button><button type="button" class="btn btn-primary btn-sm" data-act="done">Done</button></div>`;

  const dd = {
    benchmark: makeDropdown($('#f-benchmark'), { key: 'benchmark', label: 'Benchmark', kind: 'single', icon: 'db', onChange: (v) => setState({ benchmark: v, versions: null, cases: [], profiles: [], kinds: [] }) }),
    versions: makeDropdown($('#f-version'), { key: 'versions', label: 'Version', kind: 'single', icon: 'tag', onChange: (v) => setState({ versions: v }) }),
    runs: makeDropdown($('#f-runs'), { key: 'runs', label: 'Runs', icon: 'play', search: true, onChange: (v) => setState({ runs: v }) }),
    models: makeDropdown($('#f-models'), { key: 'models', label: 'Models', icon: 'box', search: true, onChange: (v) => setState({ models: v }) }),
    cases: makeDropdown($('#f-cases'), { key: 'cases', label: 'Cases', icon: 'list', search: true, onChange: (v) => setState({ cases: v }) }),
    profiles: makeDropdown($('#f-profiles'), { key: 'profiles', label: 'Profiles', icon: 'user', onChange: (v) => setState({ profiles: v }) }),
    kinds: makeDropdown($('#f-kinds'), { key: 'kinds', label: 'Kinds', icon: 'layers', onChange: (v) => setState({ kinds: v }) }),
    status: makeDropdown($('#f-status'), { key: 'status', label: 'Status', icon: 'flag', onChange: (v) => setState({ status: v }) }),
    checks: makeDropdown($('#f-checks'), { key: 'checks', label: 'Checks', icon: 'shield', kind: 'checks', search: true, onChange: (p, f) => setState({ check_pass: p, check_fail: f }) }),
    ranges: makeDropdown($('#f-ranges'), { key: 'ranges', label: 'Ranges', icon: 'sliders', kind: 'panel', panel: rangePanel, count: () => RANGES.filter((r) => state().get(`${r.key}_min`) || state().get(`${r.key}_max`)).length }),
  };
  for (const el of document.querySelectorAll('[data-range]')) {
    el.addEventListener('change', () => setState({ [el.dataset.range]: el.value }));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); setState({ [el.dataset.range]: el.value }); } });
  }
  $('#f-ranges').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="clear-ranges"]')) setState(Object.fromEntries(RANGE_KEYS.map((k) => [k, null])));
  });

  let CHIPS = [];
  let chipFocus = null;
  function renderChips(s) {
    const chips = [];
    const names = { runs: 'Run', models: 'Model', cases: 'Case', profiles: 'Profile', kinds: 'Kind', status: 'Status' };
    for (const [k, n] of Object.entries(names)) {
      const v = listOf(s, k);
      if (v.length > 4) chips.push({ k: `${n}s`, v: `${v.length} selected`, rm: { [k]: [] } });
      else for (const x of v) chips.push({ k: n, v: x, rm: { [k]: v.filter((y) => y !== x) } });
    }
    const vsel = listOf(s, 'versions');
    if (vsel.length) chips.push({ k: 'Version', v: vsel.includes('all') ? 'all versions' : vsel.map((x) => `v${x}`).join(', '), rm: { versions: null } });
    const cp = listOf(s, 'check_pass');
    const cf = listOf(s, 'check_fail');
    for (const x of cp) chips.push({ k: 'Must pass', v: checkLabel(x), tone: 'tone-good', rm: { check_pass: cp.filter((y) => y !== x) } });
    for (const x of cf) chips.push({ k: 'Must fail', v: checkLabel(x), tone: 'tone-bad', rm: { check_fail: cf.filter((y) => y !== x) } });
    for (const r of RANGES) {
      const lo = s.get(`${r.key}_min`);
      const hi = s.get(`${r.key}_max`);
      if (lo || hi) chips.push({ k: r.label, v: lo && hi ? `${lo}–${hi}` : lo ? `≥ ${lo}` : `≤ ${hi}`, rm: { [`${r.key}_min`]: null, [`${r.key}_max`]: null } });
    }
    if (s.get('q')) chips.push({ k: 'Search', v: `“${s.get('q')}”`, rm: { q: null } });
    CHIPS = chips;
    $('#chips').innerHTML = chips.length
      ? chips.map((c, i) => `<span class="chip${c.tone ? ` ${c.tone}` : ''}"><span class="chip-k">${esc(c.k)}</span><span class="chip-v">${esc(c.v)}</span><button type="button" class="chip-x" data-chip="${i}" aria-label="Remove filter ${esc(c.k)} ${esc(c.v)}">${icon('x')}</button></span>`).join('')
      : '<span class="chips-none">No filters applied</span>';
    $('#reset').hidden = !chips.length;
    $('#ftoggle-n').hidden = !chips.length;
    $('#ftoggle-n').textContent = String(chips.length);
    if (chipFocus != null) {
      const btns = document.querySelectorAll('#chips .chip-x');
      (btns[Math.min(chipFocus, btns.length - 1)] || $('#f-q')).focus();
      chipFocus = null;
    }
  }
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    const c = CHIPS[Number(b.dataset.chip)];
    if (!c) return;
    chipFocus = Number(b.dataset.chip);
    if ('q' in c.rm) $('#f-q').value = '';
    setState(c.rm);
  });

  function renderFilters(s) {
    const bench = s.get('benchmark');
    const cases = META.cases.filter((c) => !bench || c.benchmark === bench);
    dd.benchmark.set(META.benchmarks.map((b) => ({ value: b.name, label: b.name, meta: b.description || '', count: b.results })), [bench]);
    const vs = versionsOf(bench);
    const ev = effectiveVersions(s);
    dd.versions.set([{ value: 'all', label: 'All versions', meta: 'Mixes results measured with different benchmark versions' },
      ...vs.map((v, i) => ({ value: v.version, label: v.version === 'none' ? 'unversioned' : `v${v.version}`, meta: `${i === 0 ? 'newest · ' : ''}${v.runs} run${v.runs === 1 ? '' : 's'}, ${v.results} results${v.summary ? ` · ${v.summary}` : ''}`, count: v.results }))],
    [ev.length ? ev[0] : 'all']);
    dd.runs.set(META.runs.map((r) => ({
      value: r.name, label: r.name, short: r.name,
      meta: `${r.status} · ${r.models} model${r.models === 1 ? '' : 's'} · started ${fmtDate(r.started_at)}`,
      badge: isRunning(r) ? '<span class="badge tone-bad running"><span class="pulse" aria-hidden="true"></span>running</span>' : '',
      count: r.results,
    })), listOf(s, 'runs'));
    dd.models.set(META.models.filter((m) => m.results).map((m) => ({ value: m.alias, label: m.alias, meta: [m.quant, m.ctx ? `ctx ${fmtCompact(m.ctx)}` : null, m.kv_type ? `KV ${m.kv_type}` : null].filter(Boolean).join(' · '), count: m.results })), listOf(s, 'models'));
    dd.cases.set(cases.map((c) => ({ value: c.case_key, label: c.case_key, meta: [c.profile ? `profile ${c.profile}` : null, c.title].filter(Boolean).join(' · '), group: c.kind || 'other' })), listOf(s, 'cases'));
    dd.profiles.set([...new Set(cases.map((c) => c.profile).filter(Boolean))].sort().map((v) => ({ value: v, label: v })), listOf(s, 'profiles'));
    dd.kinds.set([...new Set(cases.map((c) => c.kind).filter(Boolean))].sort().map((v) => ({ value: v, label: v })), listOf(s, 'kinds'));
    dd.status.set(META.statuses.map((v) => ({ value: v, label: v, meta: STATUS_DEF[v] ? STATUS_DEF[v][1] : '' })), listOf(s, 'status'));
    dd.checks.set(META.checks.map((c) => ({ value: c.name, label: checkLabel(c.name), meta: CHECK_INFO[c.name] ? CHECK_INFO[c.name][1] : c.name, group: c.category })), { pass: listOf(s, 'check_pass'), fail: listOf(s, 'check_fail') });
    for (const k of RANGE_KEYS) { const el = $(`#f-${k}`); if (document.activeElement !== el) el.value = s.get(k) || ''; }
    dd.ranges.set();
    const qEl = $('#f-q');
    if (document.activeElement !== qEl) qEl.value = s.get('q') || '';
    renderChips(s);
  }

  $('#ftoggle').addEventListener('click', () => {
    const open = !$('#filters').classList.contains('open');
    $('#filters').classList.toggle('open', open);
    $('#ftoggle').setAttribute('aria-expanded', String(open));
  });
  let qTimer = null;
  $('#f-q').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => setState({ q: e.target.value.trim() }, { push: false }), 300); });
  $('#reset').addEventListener('click', () => {
    const s = state();
    const keep = {};
    for (const k of ['view', 'model', 'run', 'id', 'benchmark', 'cols']) if (s.get(k)) keep[k] = s.get(k);
    $('#f-q').value = '';
    history.pushState(null, '', `?${new URLSearchParams(keep)}`);
    render();
    $('#f-q').focus();
  });
  $('#copy').addEventListener('click', async () => {
    const b = $('#copy');
    try { await navigator.clipboard.writeText(location.href); b.textContent = 'Link copied'; } catch { b.textContent = 'Copy failed'; }
    setTimeout(() => { b.textContent = 'Copy link'; }, 1500);
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      e.preventDefault();
      const nav = a.dataset.nav;
      if (nav === 'home') setState({ view: null, model: null, run: null, id: null });
      else if (nav === 'model') setState({ view: 'model', model: a.dataset.model, run: null, id: null });
      else if (nav === 'modelrun') setState({ view: 'modelrun', model: a.dataset.model, run: a.dataset.run, id: null });
      else if (nav === 'result') setState({ view: 'result', id: a.dataset.id });
      else if (nav === 'state') setState(JSON.parse(a.dataset.changes), { push: a.dataset.push !== 'false' });
      return;
    }
    const tr = e.target.closest('tr[data-href-model], tr[data-href-id]');
    if (tr && !e.target.closest('a, button, [tabindex], audio')) {
      if (tr.dataset.hrefRun) setState({ view: 'modelrun', model: tr.dataset.hrefModel, run: tr.dataset.hrefRun, id: null });
      else if (tr.dataset.hrefModel) setState({ view: 'model', model: tr.dataset.hrefModel, run: null, id: null });
      else setState({ view: 'result', id: tr.dataset.hrefId });
    }
  });
  window.addEventListener('popstate', render);

  function link(changes, text, attrs = '') {
    const s = state();
    for (const [k, v] of Object.entries(changes)) { if (v == null) s.delete(k); else s.set(k, v); }
    return `<a href="?${esc(s.toString())}" ${attrs}>${text}</a>`;
  }
  const stateLink = (changes, text, attrs = '', push = true) => link(changes, text, `data-nav="state" data-changes="${esc(JSON.stringify(changes))}"${push ? '' : ' data-push="false"'} ${attrs}`);
  const modelLink = (m, text = esc(m)) => link({ view: 'model', model: m, run: null, id: null }, text, `data-nav="model" data-model="${esc(m)}"`);
  const resultLink = (id, text) => link({ view: 'result', id: String(id) }, text, `data-nav="result" data-id="${esc(id)}"`);
  const runLink = (m, run, text = esc(run), attrs = '') => link({ view: 'modelrun', model: m, run, id: null }, text, `data-nav="modelrun" data-model="${esc(m)}" data-run="${esc(run)}"${attrs ? ` ${attrs}` : ''}`);

  // ------------------------------------------------------------------ tooltip (hover and keyboard focus)
  const tip = $('#tip');
  function showTip(t, x, y) {
    tip.innerHTML = t.dataset.tip;
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = document.documentElement.clientWidth;
    tip.style.left = `${Math.max(8, Math.min(vw - w - 8, x + 14))}px`;
    tip.style.top = `${y - h - 10 < 8 ? y + 18 : y - h - 10}px`;
  }
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { if (!tip.dataset.focus) tip.hidden = true; return; }
    delete tip.dataset.focus;
    showTip(t, e.clientX, e.clientY);
  });
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || !e.target.matches(':focus-visible')) { tip.hidden = true; delete tip.dataset.focus; return; }
    const r = t.getBoundingClientRect();
    tip.dataset.focus = '1';
    showTip(t, r.left, r.top);
  });
  document.addEventListener('focusout', () => { tip.hidden = true; delete tip.dataset.focus; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') tip.hidden = true; });
  window.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });

  // ------------------------------------------------------------------ charts (plain SVG, drawn at the slot's pixel width)
  let CHARTS = [];
  function chartSlot(build, label) {
    const cid = `chart-${CHARTS.length}`;
    CHARTS.push({ id: cid, build });
    return `<div class="chart-slot" id="${cid}" role="img" aria-label="${esc(label)}"></div>`;
  }
  function drawCharts() {
    for (const c of CHARTS) {
      const el = document.getElementById(c.id);
      if (el) el.innerHTML = c.build(Math.max(260, Math.floor(el.clientWidth)));
    }
  }
  let resizeTimer = null;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawCharts, 120);
  });

  function niceScale(v) {
    const top = Math.max(1, v || 0);
    const raw = top / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    let step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((x) => x >= raw);
    if (top <= 8) step = Math.max(1, Math.ceil(step));
    const max = step * Math.ceil(top / step);
    const ticks = [];
    for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
    return { max, ticks };
  }
  const clip = (s, n) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

  /** Horizontal bars; items: {label, values[], tip?, display?, dim?}. */
  function hbar(items, { series = ['s1'], names = [], max, unit = '', fmtV = (v) => fmt(v), track = false } = {}) {
    return (width) => {
      if (!items.length) return '<p class="empty">No data</p>';
      const longest = Math.max(...items.map((i) => i.label.length));
      const labelW = Math.round(Math.min(width * 0.38, 200, longest * 6.8 + 14));
      const maxChars = Math.floor((labelW - 12) / 6.6);
      const rowH = 26; const top = 4; const right = 58;
      const h = top + items.length * rowH + 22;
      const plotW = Math.max(40, width - labelW - right);
      const { max: mx, ticks } = max ? { max, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * max) } : niceScale(Math.max(...items.map((i) => i.values.reduce((a, b) => a + (b || 0), 0))));
      const X = (v) => labelW + (v / mx) * plotW;
      let svg = `<svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}"><g class="grid">${ticks.map((t, i) => `<line${i === 0 ? ' class="base"' : ''} x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${h - 20}"/>`).join('')}</g>`;
      svg += ticks.map((t) => `<text x="${X(t)}" y="${h - 5}" text-anchor="middle">${esc(fmtV(t))}</text>`).join('');
      items.forEach((it, i) => {
        const y = top + i * rowH;
        const bh = 14; const by = y + (rowH - bh) / 2;
        const tipH = it.tip || `<b>${esc(it.label)}</b><br>${it.values.map((v, si) => `${esc(names[si] || '')} ${esc(fmtV(v))}`).join('<br>')}`;
        svg += `<rect class="hit row-hit" x="0" y="${y}" width="${width}" height="${rowH}" data-tip="${esc(tipH)}"/>`;
        svg += `<text class="lbl" x="${labelW - 10}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(clip(it.label, maxChars))}</text>`;
        if (track) svg += `<rect class="trk" x="${labelW}" y="${by}" width="${plotW}" height="${bh}" rx="4" pointer-events="none"/>`;
        let x = labelW;
        it.values.forEach((v, si) => {
          const w = Math.max(0, ((v || 0) / mx) * plotW);
          if (w > 0) {
            const g = si > 0 ? 2 : 0;
            svg += `<rect class="m-${series[si]}${it.dim ? ' dimmed' : ''}" x="${x + g}" y="${by}" width="${Math.max(1, w - g)}" height="${bh}" rx="4" pointer-events="none"/>`;
          }
          x += w;
        });
        const total = it.values.reduce((a, b) => a + (b || 0), 0);
        svg += `<text class="val" x="${x + 6}" y="${y + rowH / 2 + 4}" pointer-events="none">${esc(it.display ?? `${fmtV(total)}${unit}`)}</text>`;
      });
      return `${svg}</svg>`;
    };
  }

  /** Scatter of avg score (y, 0-100) against median seconds per case (x). */
  function scatter(points) {
    return (width) => {
      if (!points.length) return '<p class="empty">No data</p>';
      const height = Math.round(Math.max(240, Math.min(340, width * 0.62)));
      const L = 44; const B = 40; const T = 12; const R = 16;
      const { max: mxX, ticks: xt } = niceScale(Math.max(...points.map((p) => p.x)) * 1.08);
      const sx = (x) => L + (x / mxX) * (width - L - R);
      const sy = (y) => T + (1 - y / 100) * (height - T - B);
      let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><g class="grid">`;
      for (const y of [0, 25, 50, 75, 100]) svg += `<line${y === 0 ? ' class="base"' : ''} x1="${L}" x2="${width - R}" y1="${sy(y)}" y2="${sy(y)}"/>`;
      svg += '</g>';
      for (const y of [0, 25, 50, 75, 100]) svg += `<text x="${L - 8}" y="${sy(y) + 4}" text-anchor="end">${y}</text>`;
      for (const t of xt) svg += `<text x="${sx(t)}" y="${height - 22}" text-anchor="middle">${fmt(t, 0)}</text>`;
      svg += `<text class="axis-title" x="${(L + width - R) / 2}" y="${height - 4}" text-anchor="middle">Median time per case (s) — faster is left</text>`;
      svg += `<text class="axis-title" x="12" y="${sy(50)}" text-anchor="middle" transform="rotate(-90 12 ${sy(50)})">Avg score</text>`;
      const placed = [];
      const sorted = [...points].sort((a, b) => b.y - a.y);
      for (const p of sorted) {
        const cx = sx(p.x); const cy = sy(p.y);
        svg += `<circle class="hit" cx="${cx}" cy="${cy}" r="13" data-tip="${esc(p.tip)}"/><circle class="dot${p.top ? ' top' : ''}${p.dim ? ' dimmed' : ''}" cx="${cx}" cy="${cy}" r="${p.top ? 6.5 : 5.5}" pointer-events="none"/>`;
      }
      for (const p of sorted) {
        const cx = sx(p.x); const cy = sy(p.y);
        const right = cx > width * 0.62;
        const tw = Math.min(p.label.length, 22) * 6.4;
        const bx = right ? cx - 9 - tw : cx + 9;
        const box = { x1: bx - 2, x2: bx + tw + 2, y1: cy - 18, y2: cy - 4 };
        if (placed.some((q) => box.x1 < q.x2 && box.x2 > q.x1 && box.y1 < q.y2 && box.y2 > q.y1)) continue;
        if (box.y1 < 0) continue;
        placed.push(box);
        svg += `<text class="lbl" x="${right ? cx - 9 : cx + 9}" y="${cy - 8}" text-anchor="${right ? 'end' : 'start'}" pointer-events="none">${esc(clip(p.label, 22))}</text>`;
      }
      return `${svg}</svg>`;
    };
  }
  /** Short time axis label: seconds below two minutes, then minutes. */
  const fmtAxisTime = (v) => (v >= 120 ? `${fmt(v / 60, v >= 600 ? 0 : 1)}m` : `${fmt(v, 0)}s`);

  /** Timeline: one row per item, bar from start to start + dur (seconds since the first start). items: {label, start, dur, series, tip}. */
  function gantt(items) {
    return (width) => {
      if (!items.length) return '<p class="empty">No data</p>';
      const longest = Math.max(...items.map((i) => i.label.length));
      const labelW = Math.round(Math.min(width * 0.32, 190, longest * 6.8 + 14));
      const maxChars = Math.floor((labelW - 12) / 6.6);
      const rowH = 24; const top = 4; const right = 16;
      const h = top + items.length * rowH + 22;
      const plotW = Math.max(40, width - labelW - right);
      const { max: mx, ticks } = niceScale(Math.max(...items.map((i) => i.start + i.dur)));
      const X = (v) => labelW + (v / mx) * plotW;
      let svg = `<svg viewBox="0 0 ${width} ${h}" width="${width}" height="${h}"><g class="grid">${ticks.map((t, i) => `<line${i === 0 ? ' class="base"' : ''} x1="${X(t)}" x2="${X(t)}" y1="${top}" y2="${h - 20}"/>`).join('')}</g>`;
      svg += ticks.map((t) => `<text x="${X(t)}" y="${h - 5}" text-anchor="middle">${esc(fmtAxisTime(t))}</text>`).join('');
      items.forEach((it, i) => {
        const y = top + i * rowH;
        const bh = 12; const by = y + (rowH - bh) / 2;
        svg += `<rect class="hit row-hit" x="0" y="${y}" width="${width}" height="${rowH}" data-tip="${esc(it.tip)}"/>`;
        svg += `<text class="lbl" x="${labelW - 10}" y="${y + rowH / 2 + 4}" text-anchor="end">${esc(clip(it.label, maxChars))}</text>`;
        svg += `<rect class="m-${it.series}" x="${X(it.start)}" y="${by}" width="${Math.max(2, X(it.start + it.dur) - X(it.start))}" height="${bh}" rx="3" pointer-events="none"/>`;
      });
      return `${svg}</svg>`;
    };
  }
  const legend = (entries) => `<div class="legend">${entries.map(([cls, name]) => `<span><i class="bg-${cls}"></i>${esc(name)}</span>`).join('')}</div>`;

  // ------------------------------------------------------------------ building blocks
  function crumbs(parts) {
    $('#crumbs').innerHTML = parts.join(`<span class="sep" aria-hidden="true">${icon('right')}</span>`);
  }
  const kpi = ({ label, value, sub = '', ic, def, hero = false, extra = '' }) => `<div class="card kpi${hero ? ' hero' : ''}">
      <span class="kpi-label"${def ? ` tabindex="0" ${defAttrs(label, def)}` : ''}>${icon(ic)}${esc(label)}${def ? icon('info', 'info-i') : ''}</span>
      <span class="kpi-value">${value}</span>${sub ? `<span class="kpi-sub">${sub}</span>` : ''}${extra}</div>`;
  const cardHead = (title, sub = '', actions = '') => `<div class="card-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${actions}</div>`;
  const emptyCard = (title, text) => `<div class="card empty"><b>${esc(title)}</b>${esc(text)}</div>`;

  function sortRows(rows, cols, key, dir) {
    const col = cols.find((c) => c.key === key);
    if (!col) return rows;
    const m = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = col.get(a); const y = col.get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * m;
    });
  }
  /** Sortable table. cols: {key,label,num,get,html,cls,def,sticky}. Returns {html, sorted}. */
  function table(cols, rows, s, { sortKey = 'sort', dirKey = 'dir', rowAttr = () => '', order = (r) => r, page = null, tall = false } = {}) {
    const key = s.get(sortKey); const dir = s.get(dirKey) || 'desc';
    const sorted = order(key ? sortRows(rows, cols, key, dir) : rows);
    const shown = page ? sorted.slice(page.from, page.from + page.size) : sorted;
    const head = cols.map((c) => {
      const sortAttr = c.key === key ? ` aria-sort="${dir === 'asc' ? 'ascending' : 'descending'}"` : '';
      const d = c.def || DEF[c.key];
      const desc = d ? ` ${defAttrs(c.label, Array.isArray(d) ? d[1] : d)}` : '';
      return `<th scope="col" class="${c.num ? 'num' : ''}${c.sticky ? ' sticky' : ''}"${sortAttr}><button type="button" class="th-btn${d ? ' has-def' : ''}" data-sort="${esc(c.key)}"${desc}>${esc(c.label)}${icon('sort')}</button></th>`;
    }).join('');
    const body = shown.map((r) => `<tr${rowAttr(r)}>${cols.map((c) => `<td class="${c.num ? 'num ' : ''}${c.cls || ''}${c.sticky ? ' sticky' : ''}">${c.html ? c.html(r) : (c.num ? fmt(c.get(r)) : esc(c.get(r) ?? ''))}</td>`).join('')}</tr>`).join('');
    return { html: `<div class="table-wrap${tall ? ' tall' : ''}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, sorted };
  }
  function wireSort(root, s, sortKey = 'sort', dirKey = 'dir') {
    root.querySelectorAll('.th-btn[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      const dir = s.get(sortKey) === k && (s.get(dirKey) || 'desc') === 'desc' ? 'asc' : 'desc';
      setState({ [sortKey]: k, [dirKey]: dir }, { push: false });
    }));
  }

  const statusLegend = () => {
    const items = [
      ...['pass', 'fail', 'error', 'timeout'].map((k) => `<div class="lg-item">${badge(k, false)}<span>${esc(STATUS_DEF[k][1])}</span></div>`),
      ...['completed', 'correct'].map((k) => `<div class="lg-item"><span class="lg-name">${esc(CHECK_INFO[k][0])}</span><span>${esc(CHECK_INFO[k][1])}</span></div>`),
    ];
    return `<details class="legend-box"><summary>${icon('info')}What the statuses and checks mean</summary><div class="lg-grid">${items.join('')}
      <div class="lg-item"><span class="badge tone-mid">partial</span><span>${esc(DEF.partial[1])}</span></div></div></details>`;
  };

  // ------------------------------------------------------------------ leaderboard view
  const partialBadge = (r) => (r.partial
    ? `<span class="badge tone-mid partial-b" tabindex="0" ${defAttrs('Partial', `${r.model} has results for ${r.cases} of ${r.cases_total} cases.${r.runs_in_progress && r.runs_in_progress.length ? ` Run ${r.runs_in_progress.join(', ')} is still in progress.` : ''} Its averages cover only part of the benchmark, so it is ranked below complete models.`)}>partial</span>`
    : '');
  const runningBadge = (r) => (r.partial && r.runs_in_progress && r.runs_in_progress.length ? `<span class="badge tone-bad running" title="Run ${esc(r.runs_in_progress.join(', '))} in progress"><span class="pulse" aria-hidden="true"></span>running</span>` : '');
  const coverage = (r) => (r.cases_total != null ? `<small class="cov${r.partial ? ' is-partial' : ''}">${r.cases} / ${r.cases_total} cases</small>` : '');

  function lbColumns(data, rankOf, all) {
    const hasRole = (k) => data.rows.some((r) => r[k] != null);
    const has = (k) => data.rows.some((r) => r[k] != null);
    const failSum = (r) => Object.values(r.failures).reduce((a, b) => a + b, 0);
    const isSpeech = data.rows.some((r) => r.speech);
    const has2 = (k) => data.rows.some((r) => r.speech && r.speech[k] != null);
    const cols = [
      { key: 'model', label: 'Model', sticky: true, get: (r) => r.model, def: ['Model', 'llama.cpp router preset. Click a row for every case result of the model.'],
        html: (r) => `<div class="model-cell"><span class="rank${rankOf(r) <= 3 ? ` r${rankOf(r)}` : ''}"${r.partial ? ' title="Partial: not ranked"' : ''}>${r.partial ? '–' : rankOf(r)}</span><span class="model-name">${modelLink(r.model)}<small>${esc([r.meta?.quant, r.meta?.ctx ? `ctx ${fmtCompact(r.meta.ctx)}` : null].filter(Boolean).join(' · ') || `${r.runs} run${r.runs === 1 ? '' : 's'}`)}</small></span>${partialBadge(r)}${runningBadge(r)}${r.chat_disqualified.length ? `<span class="warn" tabindex="0" ${defAttrs('Chat disqualified', r.chat_disqualified.join(' | '))}>${icon('alert')}</span>` : ''}</div>` },
      { key: 'avg_score', label: 'Avg score', num: true, get: (r) => r.avg_score, html: (r) => `<span class="scorecell"><b>${fmt(r.avg_score)}</b>${meter(r.avg_score)}</span>` },
      { key: 'pass_rate', label: 'Pass rate', num: true, get: (r) => r.pass_rate, html: (r) => `<span class="passcell"><span class="pill ${tone(r.pass_rate)}">${fmt(r.pass_rate)}%</span>${coverage(r)}</span>` },
      ...(hasRole('cron_score') ? [{ key: 'cron_score', label: 'Cron score', num: true, get: (r) => r.cron_score, html: (r) => (r.cron_score == null ? '<span class="zero">–</span>' : `<span class="scorecell">${fmt(r.cron_score)}${meter(r.cron_score)}</span>`) }] : []),
      ...(hasRole('chat_score') ? [{ key: 'chat_score', label: 'Chat score', num: true, get: (r) => r.chat_score,
        html: (r) => (r.chat_score == null ? '<span class="zero">–</span>' : `<span class="scorecell" tabindex="0" data-tip="${esc(`<b>${esc(r.model)} chat</b><br>case score ${fmt(r.chat_case_score)}<br>speed score ${fmt(r.speed_score)}<br>median chat time ${fmt(r.chat_median_s)} s`)}">${fmt(r.chat_score)}${meter(r.chat_score, 'm-bad')}</span>`) }] : []),
      ...(isSpeech ? [
        { key: 'wer', label: 'WER %', num: true, get: (r) => r.speech?.wer, def: ['WER %', 'Corpus word error rate (all word edits / all reference words), lower is better. TTS: the round-trip WER when the judge STT transcribes the generated audio.'] },
        ...(has2('wer_el') ? [{ key: 'wer_el', label: 'WER el %', num: true, get: (r) => r.speech?.wer_el, def: ['WER el %', 'Corpus WER over the Greek cases only.'] }] : []),
        ...(has2('wer_en') ? [{ key: 'wer_en', label: 'WER en %', num: true, get: (r) => r.speech?.wer_en, def: ['WER en %', 'Corpus WER over the English cases only.'] }] : []),
        { key: 'cer', label: 'CER %', num: true, get: (r) => r.speech?.cer, def: ['CER %', 'Corpus character error rate, lower is better.'] },
        { key: 'rtf', label: 'RTF', num: true, get: (r) => r.speech?.rtf, html: (r) => fmt(r.speech?.rtf, 3), def: ['RTF', 'Median real-time factor: processing time / audio length. Below 1 is faster than real time.'] },
        ...(has2('parsed_back_pct') ? [{ key: 'parsed_back_pct', label: 'Parsed back %', num: true, get: (r) => r.speech?.parsed_back_pct, def: ['Parsed back %', 'Share of TTS clips the judge STT transcribed back close enough to the original text.'] }] : []),
      ] : [
        { key: 'median_duration_s', label: 'Median time / case', num: true, get: (r) => r.median_duration_s, html: (r) => fmtDur(r.median_duration_s) },
        { key: 'median_decode_tps', label: 'Generation speed (tok/s)', num: true, get: (r) => r.median_decode_tps },
        { key: 'tool_used_pct', label: 'Tool used %', num: true, get: (r) => r.tool_used_pct },
      ]),
      { key: 'failures', label: 'Failures', num: true, get: failSum,
        html: (r) => { const n = failSum(r); return n ? `<span class="fails" tabindex="0" data-tip="${esc(`<b>${esc(r.model)}</b><br>${Object.entries(r.failures).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(checkLabel(k))}: ${v}`).join('<br>')}`)}">${n}</span>` : '<span class="zero">0</span>'; } },
      { key: 'n', label: 'Results', num: true, get: (r) => r.n },
    ];
    if (!all) return cols;
    const more = isSpeech ? [
      { key: 'median_duration_s', label: 'Median time / case', num: true, get: (r) => r.median_duration_s, html: (r) => fmtDur(r.median_duration_s) },
      { key: 'peak_rss_mb', label: 'Peak RAM (MB)', num: true, get: (r) => r.speech?.peak_rss_mb },
      { key: 'load_s', label: 'Load time (s)', num: true, get: (r) => r.load_s },
      ...(has('gpu_peak_vram_gib') ? [{ key: 'gpu_peak_vram_gib', label: 'VRAM peak (GiB)', num: true, get: (r) => r.gpu_peak_vram_gib }] : []),
    ] : [
      { key: 'median_prompt_tps', label: 'Prompt speed (tok/s)', num: true, get: (r) => r.median_prompt_tps },
      { key: 'prompt_tokens_mean', label: 'Avg prompt tokens / case', num: true, get: (r) => r.prompt_tokens_mean, html: (r) => fmtInt(r.prompt_tokens_mean) },
      { key: 'output_tokens_mean', label: 'Avg output tokens / case', num: true, get: (r) => r.output_tokens_mean, html: (r) => fmtInt(r.output_tokens_mean) },
      { key: 'prompt_tokens_total', label: 'Total prompt tokens', num: true, get: (r) => r.prompt_tokens_total, html: (r) => fmtInt(r.prompt_tokens_total) },
      { key: 'output_tokens_total', label: 'Total output tokens', num: true, get: (r) => r.output_tokens_total, html: (r) => fmtInt(r.output_tokens_total) },
      { key: 'tool_calls_total', label: 'Tool calls', num: true, get: (r) => r.tool_calls_total },
      { key: 'load_s', label: 'Load time (s)', num: true, get: (r) => r.load_s },
      ...(has('gpu_peak_mem_c') ? [{ key: 'gpu_peak_mem_c', label: 'GPU memory peak (°C)', num: true, get: (r) => r.gpu_peak_mem_c }] : []),
      ...(has('gpu_peak_vram_gib') ? [{ key: 'gpu_peak_vram_gib', label: 'VRAM peak (GiB)', num: true, get: (r) => r.gpu_peak_vram_gib }] : []),
      ...data.check_names.map((n) => ({
        key: `fail:${n}`, label: `✕ ${checkLabel(n)}`, num: true, get: (r) => r.failures[n] || 0,
        def: [`Failed: ${checkLabel(n)}`, `Number of results where this failed. ${CHECK_INFO[n] ? CHECK_INFO[n][1] : ''}`],
        html: (r) => (r.failures[n] ? `<span class="fails">${r.failures[n]}</span>` : '<span class="zero">0</span>'),
      })),
    ];
    return [...cols, ...more];
  }

  const audioCell = (x) => (x.audio
    ? `<audio class="aud" controls preload="none" src="/api/audio/${esc(x.id)}.wav" aria-label="${x.audio === 'tts' ? `Generated speech of ${esc(x.model)}` : 'Source clip'}"></audio>`
    : '<span class="zero">–</span>');
  const textCell = (v) => (v ? `<span class="clip-text" title="${esc(v)}">${esc(v)}</span>` : '<span class="zero">–</span>');
  /** Speech benchmarks (stt, tts): audio player and the text next to it. */
  const speechColumns = () => [
    { key: 'audio', label: 'Audio', get: (x) => (x.audio ? 1 : 0), html: audioCell, def: ['Audio', 'TTS: the speech this model and voice generated. STT: the source clip the model transcribed. Press play; the file loads on demand.'] },
    { key: 'reference', label: 'Reference text', cls: 'wrap', get: (x) => x.reference, html: (x) => textCell(x.reference), def: ['Reference text', 'TTS: the text that was spoken. STT: the reference transcript of the clip.'] },
    { key: 'answer_text', label: 'Transcript', cls: 'wrap', get: (x) => x.answer_text, html: (x) => textCell(x.answer_text), def: ['Transcript', 'STT: what the model heard. TTS: what the STT judge heard in the generated audio (round trip).'] },
  ];
  function resultColumns({ withModel, detailedChecks, speech = false }) {
    return [
      ...(withModel ? [{ key: 'model', label: 'Model', get: (x) => x.model, cls: 'nowrap', html: (x) => modelLink(x.model) }] : []),
      { key: 'case_key', label: 'Case', cls: 'nowrap', get: (x) => x.case_key, html: (x) => resultLink(x.id, `<b>${esc(x.case_key)}</b>`) + (x.repeat_idx > 1 ? ` <span class="muted">#${x.repeat_idx}</span>` : ''), def: ['Case', 'Benchmark task. Click for checks, metrics, tool calls and the transcript.'] },
      ...(speech ? speechColumns() : []),
      { key: 'status', label: 'Status', get: (x) => x.status, html: (x) => badge(x.status), def: ['Status', 'pass = every check passed; fail = the run finished but a check failed; error / timeout = the run itself broke.'] },
      { key: 'score', label: 'Score', num: true, get: (x) => x.score, html: (x) => `<span class="scorecell">${fmt(x.score)}${meter(x.score)}</span>` },
      { key: 'completed', label: 'Run finished', get: (x) => ckState(x, 'completed'), html: (x) => ckCell(x, 'completed'), def: CHECK_INFO.completed },
      { key: 'correct', label: 'Task correct', get: (x) => ckState(x, 'correct'), html: (x) => ckCell(x, 'correct'), def: CHECK_INFO.correct },
      { key: 'checks', label: 'Failed checks', cls: detailedChecks ? 'wrap top' : '', get: (x) => x.checks.filter((c) => c.passed === false).length, html: (x) => checksCell(x.checks, detailedChecks) },
      { key: 'kind', label: 'Kind', get: (x) => x.kind, def: ['Kind', 'cron = scheduled job prompt; chat = interactive request.'] },
      { key: 'profile', label: 'Profile', get: (x) => x.profile, def: ['Profile', 'Hermes profile (tool set) the case runs with.'] },
      { key: 'run', label: 'Run', cls: 'nowrap', get: (x) => x.run },
      { key: 'bench_version', label: 'Version', cls: 'nowrap', get: (x) => x.bench_version || 'none', html: (x) => (x.bench_version ? `v${esc(x.bench_version)}` : '<span class="zero">–</span>'), def: ['Benchmark version', 'Version of the benchmark this result was measured with. Results of different versions are not directly comparable.'] },
      { key: 'duration_s', label: 'Time', num: true, get: (x) => x.duration_s, html: (x) => fmtDur(x.duration_s) },
      { key: 'prompt_tokens', label: 'Prompt tokens', num: true, get: (x) => x.prompt_tokens, html: (x) => fmtInt(x.prompt_tokens) },
      { key: 'output_tokens', label: 'Output tokens', num: true, get: (x) => x.output_tokens, html: (x) => fmtInt(x.output_tokens) },
      { key: 'model_calls', label: 'Model calls', num: true, get: (x) => x.model_calls },
      { key: 'tool_calls', label: 'Tool calls', num: true, get: (x) => x.tool_calls },
      { key: 'tool_used_pct', label: 'Tool used %', num: true, get: (x) => x.tool_used_pct },
      { key: 'decode_tps', label: 'Generation speed (tok/s)', num: true, get: (x) => x.decode_tps },
      { key: 'prompt_tps', label: 'Prompt speed (tok/s)', num: true, get: (x) => x.prompt_tps },
      { key: 'transcript', label: 'Transcript', get: (x) => (x.has_transcript ? 1 : 0), html: (x) => (x.has_transcript ? '<span class="muted">yes</span>' : '<span class="zero">–</span>'), def: ['Transcript', 'Whether the conversation file is available in reports/.'] },
    ];
  }
  const ckState = (x, name) => { const c = x.checks.find((k) => k.name === name); return c ? (c.passed === true ? 1 : c.passed === false ? 0 : null) : null; };
  function ckCell(x, name) {
    const c = x.checks.find((k) => k.name === name);
    if (!c || c.passed == null) return '<span class="zero">–</span>';
    return c.passed ? `<span class="ckmark tone-good" aria-label="yes">${icon('check')}</span>` : `<span class="ckmark tone-bad" tabindex="0" aria-label="no: ${esc(c.detail || '')}" data-tip="${esc(`<b>${esc(checkLabel(name))}: no</b><br>${esc(c.detail || '')}`)}">${icon('x')}</span>`;
  }
  function checksCell(checks, detailed) {
    const failed = checks.filter((c) => c.passed === false && c.name !== 'completed' && c.name !== 'correct');
    const ok = checks.filter((c) => c.passed === true).length;
    if (!detailed) {
      if (!failed.length) return `<span class="muted">none · ${ok} passed</span>`;
      return `<span class="fails" tabindex="0" data-tip="${esc(failed.map((c) => `<b>${esc(checkLabel(c.name))}</b>: ${esc((c.detail || '').slice(0, 160))}`).join('<br>'))}">${failed.length}</span> <span class="muted">${esc(failed.map((c) => checkLabel(c.name)).join(', '))}</span>`;
    }
    return `${failed.map((c) => `<span class="ck fail"><b>${esc(checkLabel(c.name))}</b>: ${esc((c.detail || '').slice(0, 160))}</span>`).join('')}<span class="ck pass">${ok} passed</span>`;
  }

  // ------------------------------------------------------------------ benchmark versions
  const verLabel = (v) => (v === 'none' ? 'unversioned' : `v${v}`);
  function versionTag(s) {
    const ev = effectiveVersions(s);
    return `<span class="tag">${icon('tag')}${ev.length ? `<b>${esc(ev.map(verLabel).join(', '))}</b>` : '<b>all versions</b>'}</span>`;
  }
  /** Version selector (segmented) with the changelog line of the selected version and a warning when versions are mixed. */
  function versionBarHtml(s, b) {
    const vs = versionsOf(b ? b.name : s.get('benchmark'));
    if (!vs.length) return '';
    const ev = effectiveVersions(s);
    const sel = vs.filter((v) => ev.includes(v.version));
    const seg = [stateLink({ versions: 'all' }, 'All versions', `aria-current="${!ev.length}"`, false),
      ...vs.map((v) => stateLink({ versions: v.version }, `${esc(verLabel(v.version))} <span class="muted">${v.runs} run${v.runs === 1 ? '' : 's'}</span>`, `aria-current="${ev.includes(v.version)}"`, false))].join('');
    const notes = [];
    if (!ev.length && vs.length > 1) notes.push(`<div class="alert warn" role="note">${icon('alert')}<div><b>Mixed versions.</b> These results were measured with ${vs.length} different benchmark versions (what is measured changed between them), so scores are not directly comparable. Pick a version to compare within it.</div></div>`);
    for (const v of sel) {
      notes.push(`<p class="ver-note"><b>${esc(verLabel(v.version))}</b>${v.released_on ? ` · ${esc(v.released_on)}` : ''} · ${esc(v.summary || 'no changelog entry')}${v.backfilled ? ' <span class="badge tone-mid" ' + defAttrs('Backfilled', 'The version was assigned afterwards from the run date (git history and report notes); no content fingerprint was recorded.') + ' tabindex="0">backfilled</span>' : ''}</p>`);
      if (v.drift) notes.push(`<div class="alert warn" role="note">${icon('alert')}<div><b>Changed without a version bump.</b> ${v.fingerprints.length} different content fingerprints (${v.fingerprints.map((f) => `<code>${esc(f)}</code>`).join(', ')}) were recorded for ${esc(verLabel(v.version))}: the tasks, checks or scoring changed but the version constant did not. Bump the version.</div></div>`);
    }
    return `<section class="card version-bar" aria-label="Benchmark version"><div class="switch-row"><span class="muted">${icon('tag')}Benchmark version</span>
      <nav class="segmented wrap-seg" aria-label="Benchmark version">${seg}</nav></div>${notes.join('')}</section>`;
  }
  /** Per-version summary table of the selected benchmark. */
  function versionsCard(s, b) {
    const vs = versionsOf(b ? b.name : s.get('benchmark'));
    if (!vs.length) return '';
    const ev = effectiveVersions(s);
    const rows = vs.map((v) => `<tr${ev.includes(v.version) ? ' class="sel"' : ''}><td class="nowrap"><b>${esc(verLabel(v.version))}</b>${v.drift ? ' <span class="badge tone-bad" tabindex="0" ' + defAttrs('Fingerprint changed', 'More than one content fingerprint under this version: something measured changed without a version bump.') + '>changed</span>' : ''}</td>
      <td class="nowrap">${esc(v.released_on || '–')}</td><td class="nowrap">${esc(v.first_run)}${v.last_run !== v.first_run ? ` – ${esc(v.last_run)}` : ''}</td><td class="num">${v.runs}</td><td class="num">${v.models}</td><td class="num">${v.cases}</td><td class="num">${fmtInt(v.results)}</td>
      <td class="num">${fmt(v.avg_score)}</td><td class="num">${fmt(v.pass_rate)}%</td><td class="nowrap">${v.top_model ? `${modelLink(v.top_model)} <span class="muted">${fmt(v.top_score)}</span>` : '–'}</td>
      <td class="wrap">${esc(v.summary || '')}</td><td class="nowrap">${ev.includes(v.version) ? '<span class="muted">selected</span>' : stateLink({ versions: v.version }, 'Show this version', 'class="link-btn"')}</td></tr>`).join('');
    return `<section class="card" aria-labelledby="ver-h">${cardHead('<span id="ver-h">Versions</span>', 'Per benchmark version: runs, models and the best model (highest average score among models that covered the version\'s whole case set). Scores are comparable within a version only.')}
      <div class="table-wrap"><table class="data"><thead><tr><th scope="col">Version</th><th scope="col">Released</th><th scope="col">Run range</th><th scope="col" class="num">Runs</th><th scope="col" class="num">Models</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Results</th><th scope="col" class="num">Avg score</th><th scope="col" class="num">Pass</th><th scope="col">Top model</th><th scope="col">What changed</th><th scope="col"><span class="sr-only">Select</span></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }

  async function viewLeaderboard(s, my) {
    crumbs(['<span aria-current="page">Leaderboard</span>']);
    const [data, res] = await Promise.all([api(`/api/leaderboard?${apiQuery(s)}`), api(`/api/results?${apiQuery(s)}`)]);
    if (my !== seq) return;
    const runsSel = listOf(s, 'runs');
    const runCount = new Set(res.rows.map((r) => r.run)).size;
    $('#summary').textContent = `${data.total_results} result${data.total_results === 1 ? '' : 's'} · ${data.rows.length} model${data.rows.length === 1 ? '' : 's'} · ${runsSel.length ? `${runsSel.length} run${runsSel.length === 1 ? '' : 's'} selected` : 'all runs averaged'}`;
    const main = $('#main');
    const b = META.benchmarks.find((x) => x.name === s.get('benchmark'));
    const head = `<div class="page-head"><div><p class="eyebrow">Benchmark</p><h1>${esc(b ? b.name : 'Benchmark')}</h1>${b?.description ? `<p class="lede">${esc(b.description)}</p>` : ''}</div>
      <div class="tags">${versionTag(s)}<span class="tag">${icon('list')}<b>${data.cases_total ?? '–'}</b> cases</span><span class="tag">${icon('play')}<b>${runCount}</b> run${runCount === 1 ? '' : 's'}</span>${META.runs.some(isRunning) ? '<span class="badge tone-bad running"><span class="pulse" aria-hidden="true"></span>run in progress</span>' : ''}</div></div>`;
    if (!data.rows.length) { CHARTS = []; main.innerHTML = `${head}${versionBarHtml(s, b)}${emptyCard('No results match these filters', 'Remove a filter chip above or clear all filters.')}`; return; }

    // Complete models rank above partial ones; within each group by avg score.
    const ranked = [...data.rows].sort((x, y) => (x.partial - y.partial) || byRank(x, y));
    const rankMap = new Map(ranked.filter((r) => !r.partial).map((r, i) => [r.model, i + 1]));
    const rankOf = (r) => rankMap.get(r.model) || 0;
    const partialLast = (rows) => [...rows.filter((r) => !r.partial), ...rows.filter((r) => r.partial)];
    const top = ranked.find((r) => !r.partial) || ranked[0];
    const ran = res.rows.filter((r) => !['load_failed', 'skipped', 'infra'].includes(r.status));
    const nTot = data.rows.reduce((a, r) => a + r.n, 0);
    const wavg = (k) => { let w = 0; let t = 0; for (const r of data.rows) if (r[k] != null) { w += r.n; t += r[k] * r.n; } return w ? t / w : null; };
    const passRate = wavg('pass_rate');
    const avgScore = wavg('avg_score');
    const tokIn = data.rows.reduce((a, r) => a + r.prompt_tokens_total, 0);
    const tokOut = data.rows.reduce((a, r) => a + r.output_tokens_total, 0);
    const passed = res.rows.filter((r) => r.status === 'pass').length;
    const fastest = [...data.rows].filter((r) => r.median_duration_s != null && !r.partial).sort((x, y) => x.median_duration_s - y.median_duration_s)[0];
    const partialN = data.rows.filter((r) => r.partial).length;
    const bestWer = [...data.rows].filter((r) => r.speech?.wer != null && !r.partial).sort((x, y) => x.speech.wer - y.speech.wer)[0];

    const versionBar = versionBarHtml(s, b);
    const kpis = `<div class="kpis">
      ${kpi({ hero: true, label: 'Top model', ic: 'trophy', def: 'Highest average score among models with results for every case in the selection (partial models are not ranked).', value: `${modelLink(top.model)}`, sub: `<span class="big">${fmt(top.avg_score)}</span> avg score · ${fmt(top.pass_rate)}% pass`, extra: meter(top.avg_score) })}
      ${kpi({ label: 'Results', ic: 'hash', def: DEF.n[1], value: fmtInt(nTot), sub: `${data.rows.length} models${partialN ? ` (${partialN} partial)` : ''} · ${runCount} run${runCount === 1 ? '' : 's'}` })}
      ${kpi({ label: 'Pass rate', ic: 'pct', def: 'Share of all results where every check passed.', value: `${fmt(passRate)}<small>%</small>`, sub: `${fmtInt(passed)} of ${fmtInt(res.rows.length)} passed`, extra: meter(passRate) })}
      ${kpi({ label: 'Avg score', ic: 'target', def: DEF.avg_score[1], value: `${fmt(avgScore)}<small>/100</small>`, sub: 'mean over all results', extra: meter(avgScore) })}
      ${kpi({ label: 'Median time / case', ic: 'clock', def: DEF.median_duration_s[1], value: fmtDur(median(ran.map((r) => r.duration_s))), sub: fastest ? `fastest: ${esc(fastest.model)} ${fmtDur(fastest.median_duration_s)}` : '' })}
      ${bestWer ? kpi({ label: 'Lowest WER', ic: 'zap', def: 'Lowest corpus word error rate among complete models.', value: `${fmt(bestWer.speech.wer)}<small>%</small>`, sub: esc(bestWer.model) })
    : kpi({ label: 'Tokens', ic: 'zap', def: 'All prompt and output tokens over the included results.', value: fmtCompact(tokIn + tokOut), sub: `${fmtCompact(tokIn)} prompt · ${fmtCompact(tokOut)} output` })}
    </div>`;

    const allCols = s.get('cols') === 'all';
    const cols = lbColumns(data, rankOf, allCols);
    const defaultOrder = !s.get('sort');
    const lb = table(cols, defaultOrder ? ranked : data.rows, s, {
      order: partialLast,
      rowAttr: (r) => ` class="click${r.partial ? ' partial' : ''}" data-href-model="${esc(r.model)}"`,
    });
    const colToggle = `<nav class="segmented" aria-label="Columns">${stateLink({ cols: null }, 'Key metrics', `aria-current="${!allCols}"`, false)}${stateLink({ cols: 'all' }, 'All columns', `aria-current="${allCols}"`, false)}</nav>`;
    const roleNote = data.rows.some((r) => r.cron_score != null || r.chat_score != null)
      ? '<span><b>Cron score</b>: mean cron case score. <b>Chat score</b>: 0.75 × mean chat case score + 0.25 × speed score (100 at the fastest median chat time among the models shown, 0 at 5×). Both use the filtered results.</span>' : '';
    const leaderboard = `<section class="card" aria-labelledby="lb-h">${cardHead('<span id="lb-h">Leaderboard</span>', `One row per model, averaged over ${fmtInt(nTot)} results. Complete models are ranked first${partialN ? `; ${partialN} partial model${partialN === 1 ? ' is' : 's are'} greyed and not ranked` : ''}. Hover a column name for its definition.`, colToggle)}
      ${lb.html}
      <div class="card-foot">${roleNote}${statusLegend()}</div></section>`;

    const byScore = partialLast([...data.rows].sort(byRank));
    const failTotals = {};
    for (const r of data.rows) for (const [k, v] of Object.entries(r.failures)) failTotals[k] = (failTotals[k] || 0) + v;
    CHARTS = [];
    const charts = `<div class="grid-2">
      <section class="card">${cardHead('Average score per model', 'Mean case score 0–100. Partial models are shown faded below the complete ones.')}<div class="card-body">
        ${chartSlot(hbar(byScore.map((r) => ({ label: r.partial ? `${r.model} (partial)` : r.model, dim: r.partial, values: [r.avg_score || 0], tip: `<b>${esc(r.model)}</b><br>avg score ${fmt(r.avg_score)} (${r.n} results)<br>pass ${fmt(r.pass_rate)}%<br>${r.cases} / ${r.cases_total} cases${r.partial ? ' · partial' : ''}` })), { max: 100, track: true }), 'Bar chart of average score per model')}</div></section>
      <section class="card">${cardHead('Speed vs score', 'Each dot is a model: up is better, left is faster. The top model is highlighted.')}<div class="card-body">
        ${chartSlot(scatter(data.rows.filter((r) => r.median_duration_s != null).map((r) => ({ x: r.median_duration_s, y: r.avg_score || 0, label: r.model, top: r.model === top.model, dim: r.partial, tip: `<b>${esc(r.model)}</b>${r.partial ? ' (partial)' : ''}<br>avg score ${fmt(r.avg_score)}<br>median time / case ${fmtDur(r.median_duration_s)}<br>generation ${fmt(r.median_decode_tps)} tok/s` }))), 'Scatter plot of average score against median time per case')}</div></section>
      ${bestWer ? `<section class="card">${cardHead('WER per model', 'Corpus word error rate, lower is better. Partial models are faded.')}<div class="card-body">
        ${chartSlot(hbar([...data.rows].filter((r) => r.speech?.wer != null).sort((x, y) => x.speech.wer - y.speech.wer).map((r) => ({ label: r.model, dim: r.partial, values: [r.speech.wer], display: `${fmt(r.speech.wer)}%`, tip: `<b>${esc(r.model)}</b><br>WER ${fmt(r.speech.wer)}%${r.speech.wer_el != null ? `<br>el ${fmt(r.speech.wer_el)}%` : ''}${r.speech.wer_en != null ? `<br>en ${fmt(r.speech.wer_en)}%` : ''}<br>RTF ${fmt(r.speech.rtf, 3)}` })), { series: ['s2'], fmtV: (v) => fmt(v) }), 'Bar chart of word error rate per model')}</div></section>` : `<section class="card">${cardHead('Tokens per case', 'Average prompt and output tokens of one case result.')}<div class="card-body">${legend([['s1', 'Avg prompt tokens / case'], ['s2', 'Avg output tokens / case']])}
        ${chartSlot(hbar([...data.rows].sort((x, y) => (y.prompt_tokens_mean + y.output_tokens_mean) - (x.prompt_tokens_mean + x.output_tokens_mean)).map((r) => ({ label: r.model, values: [r.prompt_tokens_mean || 0, r.output_tokens_mean || 0], display: fmtCompact((r.prompt_tokens_mean || 0) + (r.output_tokens_mean || 0)), tip: `<b>${esc(r.model)}</b><br>prompt ${fmtInt(r.prompt_tokens_mean)} / case<br>output ${fmtInt(r.output_tokens_mean)} / case` })), { series: ['s1', 's2'], names: ['prompt', 'output'], fmtV: (v) => fmtCompact(v) }), 'Stacked bar chart of prompt and output tokens per case')}</div></section>`}
      <section class="card">${cardHead('Failures by type', 'Failed checks plus timeouts and errors, all models.')}<div class="card-body">
        ${chartSlot(hbar(Object.entries(failTotals).sort((x, y) => y[1] - x[1]).map(([k, v]) => ({ label: checkLabel(k), values: [v], tip: `<b>${esc(checkLabel(k))}</b><br>${v} failure(s)<br>${data.rows.filter((r) => r.failures[k]).map((r) => `${esc(r.model)}: ${r.failures[k]}`).join('<br>')}` })), { series: ['s2'], fmtV: (v) => fmtInt(v) }), 'Bar chart of failures by type')}</div></section>
    </div>`;

    const rcols = resultColumns({ withModel: true, detailedChecks: false, speech: res.rows.some((x) => x.audio) });
    const total = res.rows.length;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const pg = Math.min(pages, Math.max(1, Number(s.get('rpage')) || 1));
    const from = (pg - 1) * PAGE;
    const rt = table(rcols, res.rows, s, { sortKey: 'rsort', dirKey: 'rdir', page: { from, size: PAGE }, rowAttr: (x) => ` class="click" data-href-id="${x.id}"` });
    const pager = `<div class="pager"><span>${total ? `${from + 1}–${Math.min(total, from + PAGE)} of ${fmtInt(total)}` : '0'}${total >= 5000 ? ' (first 5,000)' : ''}</span>
      ${pg > 1 ? stateLink({ rpage: pg - 1 > 1 ? String(pg - 1) : null }, `${icon('left')}<span class="sr-only">Previous page</span>`, 'class="btn btn-sm"', false) : `<span class="btn btn-sm" aria-disabled="true">${icon('left')}</span>`}
      <span class="muted">Page ${pg} / ${pages}</span>
      ${pg < pages ? stateLink({ rpage: String(pg + 1) }, `${icon('right')}<span class="sr-only">Next page</span>`, 'class="btn btn-sm"', false) : `<span class="btn btn-sm" aria-disabled="true">${icon('right')}</span>`}</div>`;
    const results = `<section class="card" id="results" aria-labelledby="res-h">${cardHead('<span id="res-h">Results</span>', 'Every case result that matches the filters. Click a row for the full drill-down.')}
      ${total ? rt.html : '<p class="empty">No results.</p>'}<div class="card-foot">${pager}</div></section>`;

    const runs = META.runs;
    const runsCard = `<section class="card" aria-labelledby="runs-h">${cardHead('<span id="runs-h">Runs</span>', 'All recorded runs with their report files. Use “Only this run” to filter the dashboard to one run.')}
      <div class="table-wrap"><table class="data"><thead><tr><th scope="col">Run</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col">Finished</th><th scope="col" class="num">Models</th><th scope="col" class="num">Results</th><th scope="col">Host</th><th scope="col">Command</th><th scope="col">Files</th><th scope="col"><span class="sr-only">Filter</span></th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td class="nowrap"><b>${esc(r.name)}</b></td><td class="nowrap">${Object.entries(r.versions || {}).map(([bn, v]) => `<span class="muted">${esc(bn)}</span> ${v ? `v${esc(v)}` : '–'}`).join('<br>') || '<span class="zero">–</span>'}</td><td>${isRunning(r) ? '<span class="badge tone-bad running"><span class="pulse" aria-hidden="true"></span>running</span>' : `<span class="badge ${r.status === 'finished' ? 'tone-good' : 'tone-mid'}">${esc(r.status)}</span>`}</td>
        <td class="nowrap">${esc(fmtDate(r.started_at))}</td><td class="nowrap">${esc(fmtDate(r.finished_at))}</td><td class="num">${r.models}</td><td class="num">${r.results}</td><td class="nowrap">${esc(r.host || '–')}</td>
        <td><code class="cmd" title="${esc(r.command || '')}">${esc(r.command || '–')}</code></td>
        <td class="nowrap"><a class="dl" href="/api/run/${esc(r.name)}/report.md">${icon('download')}md</a> <a class="dl" href="/api/run/${esc(r.name)}/report.xlsx">${icon('download')}xlsx</a> <a class="dl" href="/api/run/${esc(r.name)}/results.json">${icon('download')}json</a></td>
        <td class="nowrap">${runsSel.length === 1 && runsSel[0] === r.name ? '<span class="muted">selected</span>' : stateLink({ runs: r.name, versions: null, ...(Object.keys(r.versions || {})[0] ? { benchmark: Object.keys(r.versions)[0] } : {}) }, 'Only this run', 'class="link-btn"')}</td></tr>`).join('')}
      </tbody></table></div></section>`;

    main.innerHTML = `${head}${versionBar}${kpis}${leaderboard}${versionsCard(s, b)}${charts}${results}${runsCard}`;
    applyWidths(main);
    drawCharts();
    wireSort(main.querySelector('[aria-labelledby="lb-h"]'), s);
    wireSort(main.querySelector('#results'), s, 'rsort', 'rdir');
  }

  // ------------------------------------------------------------------ model view
  async function viewModel(s, my) {
    const model = s.get('model');
    crumbs([link({ view: null, model: null, run: null, id: null }, 'Leaderboard', 'data-nav="home"'), `<span aria-current="page">${esc(model)}</span>`]);
    const q = new URLSearchParams(apiQuery(s));
    q.set('models', model);
    // Leaderboard over the same filters (all models) so the chat speed score compares against the others.
    const [lb, res] = await Promise.all([api(`/api/leaderboard?${apiQuery(s)}`), api(`/api/results?${q}`)]);
    if (my !== seq) return;
    const r = lb.rows.find((x) => x.model === model);
    const m = META.models.find((x) => x.alias === model) || {};
    $('#summary').textContent = `${res.rows.length} case result${res.rows.length === 1 ? '' : 's'} for ${model}`;
    const ranked = [...lb.rows].filter((x) => !x.partial).sort(byRank);
    const rank = ranked.findIndex((x) => x.model === model) + 1;
    const tags = [m.file ? ['file', m.file] : null, m.quant ? ['quant', m.quant] : null, m.ctx ? ['ctx', fmtInt(m.ctx)] : null, m.kv_type ? ['KV', m.kv_type] : null].filter(Boolean);
    const head = `<div class="page-head"><div>${link({ view: null, model: null, run: null, id: null }, `${icon('left')}Leaderboard`, 'data-nav="home" class="back"')}
      <p class="eyebrow">Model</p><h1>${esc(model)}${r ? partialBadge(r) + runningBadge(r) : ''}</h1>
      <div class="tags">${tags.length ? tags.map(([k, v]) => `<span class="tag">${esc(k)} <b>${esc(v)}</b></span>`).join('') : '<span class="tag">no preset metadata</span>'}</div></div></div>`;
    const kpis = r ? `<div class="kpis">
      ${kpi({ hero: true, label: 'Avg score', ic: 'trophy', def: DEF.avg_score[1], value: `<span class="big">${fmt(r.avg_score)}</span>`, sub: r.partial ? `not ranked (partial, ${r.cases} / ${r.cases_total} cases)` : `rank ${rank} of ${ranked.length} complete models`, extra: meter(r.avg_score) })}
      ${kpi({ label: 'Pass rate', ic: 'pct', def: DEF.pass_rate[1], value: `${fmt(r.pass_rate)}<small>%</small>`, sub: `${r.cases} / ${r.cases_total} cases · ${r.n} results`, extra: meter(r.pass_rate) })}
      ${kpi({ label: 'Cron score', ic: 'clock', def: DEF.cron_score[1], value: fmt(r.cron_score), sub: 'scheduled cases' })}
      ${kpi({ label: 'Chat score', ic: 'user', def: DEF.chat_score[1], value: fmt(r.chat_score), sub: `case ${fmt(r.chat_case_score)} · speed ${fmt(r.speed_score)} · median ${fmt(r.chat_median_s)} s` })}
      ${kpi({ label: 'Median time / case', ic: 'clock', def: DEF.median_duration_s[1], value: fmtDur(r.median_duration_s), sub: `load time ${fmt(r.load_s)} s` })}
      ${kpi({ label: 'Generation speed', ic: 'zap', def: DEF.median_decode_tps[1], value: `${fmt(r.median_decode_tps)}<small> tok/s</small>`, sub: `prompt ${fmt(r.median_prompt_tps)} tok/s` })}
      ${kpi({ label: 'Tool used %', ic: 'tool', def: DEF.tool_used_pct[1], value: `${fmt(r.tool_used_pct)}<small>%</small>`, sub: `${fmtInt(r.tool_calls_total)} tool calls` })}
      ${kpi({ label: 'Avg prompt tokens / case', ic: 'hash', def: DEF.prompt_tokens_mean[1], value: fmtCompact(r.prompt_tokens_mean), sub: `${fmtCompact(r.prompt_tokens_total)} total` })}
      ${kpi({ label: 'Avg output tokens / case', ic: 'hash', def: DEF.output_tokens_mean[1], value: fmtCompact(r.output_tokens_mean), sub: `${fmtCompact(r.output_tokens_total)} total` })}
      ${kpi({ label: 'GPU peaks', ic: 'thermo', def: `${DEF.gpu_peak_mem_c[1]} ${DEF.gpu_peak_vram_gib[1]}`, value: r.gpu_peak_mem_c != null ? `${fmt(r.gpu_peak_mem_c)}<small> °C</small>` : '–', sub: r.gpu_peak_vram_gib != null ? `${fmt(r.gpu_peak_vram_gib)} GiB VRAM` : 'memory temperature' })}
      ${kpi({ label: 'Runs', ic: 'play', def: 'Runs this model has results in, within the selection.', value: fmtInt(r.runs), sub: r.runs_in_progress.length ? `${esc(r.runs_in_progress.join(', '))} in progress` : 'all finished' })}
      ${kpi({ label: 'Failures', ic: 'alert', def: DEF.failures[1], value: fmtInt(Object.values(r.failures).reduce((a, b) => a + b, 0)), sub: Object.keys(r.failures).length ? esc(Object.entries(r.failures).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${checkLabel(k)} ${v}`).join(' · ')) : 'none' })}
    </div>` : '';
    const dq = r && r.chat_disqualified.length ? `<div class="alert" role="note">${icon('alert')}<div><b>Chat disqualified.</b> ${esc(r.chat_disqualified.join(' | '))}</div></div>` : '';
    CHARTS = [];
    const perCase = {};
    for (const x of res.rows) (perCase[x.case_key] || (perCase[x.case_key] = [])).push(x);
    const caseItems = Object.entries(perCase).map(([k, xs]) => {
      const sc = xs.map((x) => x.score).filter((v) => v != null);
      const avg = sc.length ? sc.reduce((a, b) => a + b, 0) / sc.length : 0;
      return { label: k, values: [avg], tip: `<b>${esc(k)}</b><br>avg score ${fmt(avg)} over ${xs.length} result(s)<br>${xs.map((x) => `${esc(x.run)}: ${esc(x.status)} ${fmt(x.score)}`).join('<br>')}` };
    }).sort((a, b) => b.values[0] - a.values[0]);
    const charts = r ? `<div class="grid-2">
      <section class="card">${cardHead('Score by case', 'Average over runs and repeats.')}<div class="card-body">${chartSlot(hbar(caseItems, { max: 100, track: true }), 'Bar chart of score per case')}</div></section>
      <section class="card">${cardHead('Score by kind and failures', 'Mean score per case kind, then failure counts by type.')}<div class="card-body">
        ${chartSlot(hbar(Object.entries(r.kind_scores).map(([k, v]) => ({ label: k, values: [v || 0] })), { max: 100, track: true }), 'Bar chart of score per kind')}
        ${Object.keys(r.failures).length ? chartSlot(hbar(Object.entries(r.failures).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: checkLabel(k), values: [v] })), { series: ['s2'], fmtV: (v) => fmtInt(v) }), 'Bar chart of failures by type') : '<p class="muted">No failures.</p>'}</div></section></div>` : '';
    const perRun = {};
    for (const x of res.rows) (perRun[x.run] || (perRun[x.run] = [])).push(x);
    const runRows = Object.entries(perRun).sort((a, b) => b[0].localeCompare(a[0])).map(([run, xs]) => {
      const info = META.runs.find((x) => x.name === run) || {};
      const fails = xs.reduce((a, x) => a + x.checks.filter((c) => c.passed === false).length + (['timeout', 'error', 'load_failed'].includes(x.status) ? 1 : 0), 0);
      const avg = xs.reduce((a, x) => a + (x.score || 0), 0) / xs.length;
      const pass = (100 * xs.filter((x) => x.status === 'pass').length) / xs.length;
      return `<tr class="click" data-href-model="${esc(model)}" data-href-run="${esc(run)}"><td class="nowrap">${runLink(model, run, `<b>${esc(run)}</b>`)}</td>
        <td>${isRunning(info) ? '<span class="badge tone-bad running"><span class="pulse" aria-hidden="true"></span>running</span>' : `<span class="badge ${info.status === 'finished' ? 'tone-good' : 'tone-mid'}">${esc(info.status || '–')}</span>`}</td>
        <td class="nowrap">${esc(fmtDate(info.started_at))}</td><td class="num">${new Set(xs.map((x) => x.case_key)).size}</td>
        <td class="num"><span class="scorecell">${fmt(avg)}${meter(avg)}</span></td><td class="num"><span class="pill ${tone(pass)}">${fmt(pass)}%</span></td>
        <td class="num">${fmtDur(xs.reduce((a, x) => a + (x.duration_s || 0), 0))}</td><td class="num">${fmtDur(median(xs.map((x) => x.duration_s)))}</td>
        <td class="num">${fmtCompact(xs.reduce((a, x) => a + (x.prompt_tokens || 0) + (x.output_tokens || 0), 0))}</td>
        <td class="num">${fails ? `<span class="fails">${fails}</span>` : '<span class="zero">0</span>'}</td>
        <td class="nowrap">${runLink(model, run, `Analyse${icon('right')}`, 'class="link-btn"')}</td></tr>`;
    });
    const runsCard = runRows.length ? `<section class="card" aria-labelledby="mruns-h">${cardHead('<span id="mruns-h">Runs</span>', 'This model in each run, within the filters. Open a run for the in-depth analysis: timeline, checks, tool use and the other models of that run.')}
      <div class="table-wrap"><table class="data"><thead><tr><th scope="col">Run</th><th scope="col">Status</th><th scope="col">Started</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Avg score</th><th scope="col" class="num">Pass rate</th><th scope="col" class="num">Total time</th><th scope="col" class="num">Median time / case</th><th scope="col" class="num">Tokens</th><th scope="col" class="num">Failures</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
      <tbody>${runRows.join('')}</tbody></table></div></section>` : '';
    const cols = resultColumns({ withModel: false, detailedChecks: true, speech: res.rows.some((x) => x.audio) });
    const t = table(cols, res.rows, s, { sortKey: 'msort', dirKey: 'mdir', rowAttr: (x) => ` class="click" data-href-id="${x.id}"`, tall: true });
    const cases = `<section class="card" id="cases" aria-labelledby="cases-h">${cardHead('<span id="cases-h">Case results</span>', `${res.rows.length} result(s). Click a row for the full drill-down.`)}
      ${res.rows.length ? t.html : '<p class="empty">No results match these filters.</p>'}<div class="card-foot">${statusLegend()}</div></section>`;
    $('#main').innerHTML = `${head}${kpis}${dq}${runsCard}${charts}${cases}`;
    applyWidths($('#main'));
    drawCharts();
    wireSort($('#cases'), s, 'msort', 'mdir');
  }

  // ------------------------------------------------------------------ model run view (one model in one run)
  const CHECK_ORDER = ['completed', 'correct', 'read_only', 'links_real', 'no_reasoning_leak', 'no_forbidden_tools', 'spoken_style', 'silent_ok', 'size_ok'];
  const checkRank = (n) => { const i = CHECK_ORDER.indexOf(n); return i < 0 ? CHECK_ORDER.length : i; };
  const epoch = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t / 1000 : null; };
  const delta = (v) => (v == null ? '<span class="zero">–</span>' : Math.abs(v) < 0.05 ? '<span class="delta">±0</span>'
    : `<span class="delta ${v > 0 ? 'up' : 'down'}">${v > 0 ? '+' : '−'}${fmt(Math.abs(v))}</span>`);
  /** Score pill linking to a result; v = mean score of the result(s). */
  const heat = (v, id, tip) => (v == null ? '<span class="zero">–</span>'
    : resultLink(id, `<span class="pill ${tone(v)}" data-tip="${esc(tip)}">${fmt(v, 0)}</span>`));
  const meanScore = (xs) => (xs.length ? xs.reduce((a, x) => a + (x.score || 0), 0) / xs.length : null);

  async function viewModelRun(s, my) {
    const model = s.get('model'); const run = s.get('run');
    const q = new URLSearchParams({ model, run });
    if (s.get('benchmark')) q.set('benchmark', s.get('benchmark'));
    const d = await api(`/api/model-run?${q}`);
    if (my !== seq) return;
    CHARTS = [];
    crumbs([link({ view: null, model: null, run: null, id: null }, 'Leaderboard', 'data-nav="home"'), modelLink(model), `<span aria-current="page">${esc(run)}</span>`]);
    const rs = d.results;
    $('#summary').textContent = `${rs.length} case result${rs.length === 1 ? '' : 's'} of ${model} in ${run} · only the benchmark filter applies on this page`;
    const me = d.peers.find((p) => p.model === model) || null;
    const ranked = [...d.peers].sort(byRank);
    const rank = ranked.findIndex((p) => p.model === model) + 1;
    const stat = Object.fromEntries(d.stats.map((x) => [x.name, x]));
    const running = isRunning(d.run);
    const sum = (f) => rs.reduce((a, x) => a + (f(x) || 0), 0);
    const ld = d.load || {};
    const gp = ld.gpu_peak || {};

    // ---- head
    const myRuns = [...new Set(d.history.map((h) => h.run))].sort();
    const tags = [d.preset?.quant && ['quant', d.preset.quant], d.preset?.ctx && ['ctx', fmtInt(d.preset.ctx)], d.preset?.kv_type && ['KV', d.preset.kv_type],
      ['started', fmtDate(d.run.started_at)], d.run.host && ['host', d.run.host]].filter(Boolean);
    const runBadge = running ? '<span class="badge tone-bad running"><span class="pulse" aria-hidden="true"></span>running</span>'
      : `<span class="badge ${d.run.status === 'finished' ? 'tone-good' : 'tone-mid'}">${esc(d.run.status)}</span>`;
    const sections = [['mr-timeline', 'Timeline'], ['mr-cases', 'Per case'], ['mr-checks', 'Checks'], ['mr-tools', 'Failures & tools'],
      ...(d.peers.length > 1 ? [['mr-peers', 'Other models']] : []), ...(myRuns.length > 1 ? [['mr-history', 'Other runs']] : []), ['mr-results', 'Results'], ['mr-info', 'Run info']];
    const head = `<div class="page-head"><div>${modelLink(model, `${icon('left')}${esc(model)}`).replace('<a ', '<a class="back" ')}
        <p class="eyebrow">Model run</p><h1>${esc(model)} <span class="muted h1-sub">in ${esc(run)}</span>${runBadge}${me ? partialBadge(me) : ''}</h1>
        <div class="tags">${tags.map(([k, v]) => `<span class="tag">${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div></div>
        <div class="actions-row">${stateLink({ view: null, model: null, run: null, id: null, runs: run }, `${icon('filter')}Dashboard for this run`, 'class="btn btn-sm"')}
          <a class="btn btn-sm" href="/api/run/${esc(run)}/report.md">${icon('download')}report.md</a><a class="btn btn-sm" href="/api/run/${esc(run)}/report.xlsx">${icon('download')}report.xlsx</a></div></div>
      ${myRuns.length > 1 ? `<div class="switch-row"><span class="muted">Runs of this model</span><nav class="segmented wrap-seg" aria-label="Runs of ${esc(model)}">${myRuns.map((x) => runLink(model, x, esc(x), `aria-current="${x === run}"`)).join('')}</nav></div>` : ''}
      <nav class="jump" aria-label="Sections">${sections.map(([id, t]) => `<a href="#${id}" data-jump="${id}">${esc(t)}</a>`).join('')}</nav>`;

    // ---- alerts
    const alerts = [];
    if (ld.load_error) alerts.push(`<b>Load failed.</b> ${esc(ld.load_error)}`);
    if (d.run.aborted) alerts.push(`<b>Run aborted</b>${d.run.abort_reason ? ` (${esc(d.run.abort_reason)})` : ''}.`);
    if (stat.chat_disqualified?.text) alerts.push(`<b>Chat disqualified.</b> ${esc(stat.chat_disqualified.text)}`);
    if (me?.partial) alerts.push(`<b>Partial.</b> ${me.cases} of the ${me.cases_total} cases of this run${running ? '; the run is still going' : ''}. Averages and the rank cover only these cases.`);
    const alertHtml = alerts.map((a) => `<div class="alert" role="note">${icon('alert')}<div>${a}</div></div>`).join('');

    // ---- KPIs
    const spans = rs.map((x) => { const end = epoch(x.created_at); return end != null && x.duration_s != null ? { start: end - x.duration_s, end } : null; });
    const valid = spans.filter(Boolean);
    const t0 = valid.length ? Math.min(...valid.map((v) => v.start)) : 0;
    const wall = valid.length ? Math.max(...valid.map((v) => v.end)) - t0 : null;
    const caseTime = sum((x) => x.duration_s);
    const slow = [...rs].sort((a, b) => (b.duration_s || 0) - (a.duration_s || 0))[0];
    const passes = rs.filter((x) => x.status === 'pass').length;
    const pIn = sum((x) => x.prompt_tokens); const pOut = sum((x) => x.output_tokens);
    const calls = sum((x) => x.model_calls);
    const toolTotal = rs.reduce((a, x) => a + (x.tool_calls_list.length || x.tool_calls || 0), 0);
    const repeatsOf = (x) => { const seen = new Set(); let n = 0; for (const t of x.tool_calls_list) { const k = `${t.tool}|${t.args_hash}`; if (t.args_hash && seen.has(k)) n += 1; seen.add(k); } return n; };
    const kpis = `<div class="kpis">
      ${kpi({ hero: true, label: 'Avg score', ic: 'trophy', def: DEF.avg_score[1], value: `<span class="big">${fmt(me?.avg_score)}</span>`, sub: rank ? `rank ${rank} of ${ranked.length} in this run · run median ${fmt(median(d.peers.map((p) => p.avg_score)))}` : '', extra: meter(me?.avg_score) })}
      ${kpi({ label: 'Pass rate', ic: 'pct', def: DEF.pass_rate[1], value: `${fmt(me?.pass_rate)}<small>%</small>`, sub: `${passes} of ${rs.length} passed${me ? ` · ${me.cases} / ${me.cases_total} cases` : ''}`, extra: meter(me?.pass_rate) })}
      ${kpi({ label: 'Cron / chat score', ic: 'user', def: `${DEF.cron_score[1]} ${DEF.chat_score[1]} The speed score compares the models of this run only.`, value: `${fmt(me?.cron_score)}<small> / ${fmt(me?.chat_score)}</small>`, sub: me?.chat_score != null ? `chat case ${fmt(me.chat_case_score)} · speed ${fmt(me.speed_score)}` : 'no chat cases' })}
      ${kpi({ label: 'Time in cases', ic: 'clock', def: 'Sum of the case times. Wall time runs from the first case start to the last case end, so it also includes setup and verification between cases.', value: fmtDur(caseTime), sub: wall ? `wall ${fmtDur(wall)} · ${fmt((100 * caseTime) / wall, 0)}% in cases` : '' })}
      ${kpi({ label: 'Median time / case', ic: 'clock', def: DEF.median_duration_s[1], value: fmtDur(me?.median_duration_s ?? median(rs.map((x) => x.duration_s))), sub: slow ? `slowest ${esc(slow.case_key)} ${fmtDur(slow.duration_s)}` : '' })}
      ${kpi({ label: 'Generation speed', ic: 'zap', def: DEF.median_decode_tps[1], value: `${fmt(me?.median_decode_tps)}<small> tok/s</small>`, sub: `prompt ${fmt(me?.median_prompt_tps)} tok/s` })}
      ${kpi({ label: 'Tokens', ic: 'hash', def: 'Prompt and output tokens over all cases of this model in this run.', value: fmtCompact(pIn + pOut), sub: `${fmtCompact(pIn)} prompt · ${fmtCompact(pOut)} output` })}
      ${kpi({ label: 'Model calls', ic: 'layers', def: DEF.model_calls[1], value: fmtInt(calls), sub: `${fmt(calls / (rs.length || 1))} per case` })}
      ${kpi({ label: 'Tool calls', ic: 'tool', def: 'Tool calls over all cases. Repeated = the same tool with the same arguments called again within one case.', value: fmtInt(toolTotal), sub: `${fmtInt(sum((x) => x.tool_calls_failed))} failed · ${fmtInt(rs.reduce((a, x) => a + repeatsOf(x), 0))} repeated` })}
      ${kpi({ label: 'Load time', ic: 'box', def: 'Time llama.cpp took to load this model at the start of its part of the run.', value: ld.load_ms != null ? `${fmt(ld.load_ms / 1000)}<small> s</small>` : stat.load_s ? `${fmt(stat.load_s.value)}<small> s</small>` : '–', sub: esc(ld.load_status || stat.load_status?.text || '') })}
      ${kpi({ label: 'VRAM peak', ic: 'db', def: 'Peak GPU memory in use while this model ran.', value: gp.vram_used_gib != null ? `${fmt(gp.vram_used_gib, 2)}<small> GiB</small>` : stat.gpu_peak_vram_gib ? `${fmt(stat.gpu_peak_vram_gib.value, 2)}<small> GiB</small>` : '–', sub: me?.gpu_peak_vram_gib != null && d.peers.length > 1 ? `run median ${fmt(median(d.peers.map((p) => p.gpu_peak_vram_gib)), 2)} GiB` : '' })}
      ${kpi({ label: 'GPU temperatures', ic: 'thermo', def: 'Peak GPU temperatures while this model ran: memory, junction (hotspot) and edge.', value: gp.mem_c != null ? `${fmt(gp.mem_c)}<small> °C mem</small>` : '–', sub: gp.junction_c != null ? `junction ${fmt(gp.junction_c)} °C · edge ${fmt(gp.edge_c)} °C` : '' })}
    </div>`;

    // ---- timeline and per-case charts
    const failedOf = (x) => x.checks.filter((c) => c.passed === false);
    const caseTip = (x) => `<b>${esc(x.case_key)}</b><br>${esc(x.status)} · score ${fmt(x.score)} · ${fmtDur(x.duration_s)}${failedOf(x).length ? `<br>failed: ${esc(failedOf(x).map((c) => checkLabel(c.name)).join(', '))}` : ''}`;
    const tl = rs.map((x, i) => (spans[i] ? { label: x.case_key, start: spans[i].start - t0, dur: x.duration_s, series: x.status === 'pass' ? 's1' : 's2',
      tip: `${caseTip(x)}<br>started +${fmtDur(spans[i].start - t0)}` } : null)).filter(Boolean);
    const timeline = `<section class="card" id="mr-timeline">${cardHead('Timeline', 'Cases in the order they ran. Gaps between bars are setup and verification. Hover a bar for details.', legend([['s1', 'pass'], ['s2', 'fail, error or timeout']]))}
      <div class="card-body">${tl.length ? chartSlot(gantt(tl), 'Timeline of the cases of this run') : '<p class="muted">No timing data.</p>'}</div></section>`;
    const perCase = `<div class="grid-2" id="mr-cases">
      <section class="card">${cardHead('Score per case', 'In run order.')}<div class="card-body">${chartSlot(hbar(rs.map((x) => ({ label: x.case_key, values: [x.score || 0], tip: caseTip(x) })), { max: 100, track: true }), 'Bar chart of score per case')}</div></section>
      <section class="card">${cardHead('Time per case', 'Wall time of each case, slowest first.')}<div class="card-body">${chartSlot(hbar([...rs].sort((a, b) => (b.duration_s || 0) - (a.duration_s || 0)).map((x) => ({ label: x.case_key, values: [x.duration_s || 0], display: fmtDur(x.duration_s), tip: `${caseTip(x)}<br>${fmt(x.model_calls)} model calls · ${fmt(x.decode_tps)} tok/s` })), { series: ['s2'], fmtV: fmtAxisTime }), 'Bar chart of time per case')}</div></section>
      <section class="card">${cardHead('Tokens per case', 'Prompt and output tokens over all model calls of each case.')}<div class="card-body">${legend([['s1', 'prompt'], ['s2', 'output']])}
        ${chartSlot(hbar([...rs].sort((a, b) => ((b.prompt_tokens || 0) + (b.output_tokens || 0)) - ((a.prompt_tokens || 0) + (a.output_tokens || 0))).map((x) => ({ label: x.case_key, values: [x.prompt_tokens || 0, x.output_tokens || 0], display: fmtCompact((x.prompt_tokens || 0) + (x.output_tokens || 0)), tip: `<b>${esc(x.case_key)}</b><br>prompt ${fmtInt(x.prompt_tokens)}<br>output ${fmtInt(x.output_tokens)}<br>${fmt(x.model_calls)} model calls` })), { series: ['s1', 's2'], names: ['prompt', 'output'], fmtV: (v) => fmtCompact(v) }), 'Stacked bar chart of tokens per case')}</div></section>
      <section class="card">${cardHead('Model and tool calls per case', 'LLM requests and tool calls of each case.')}<div class="card-body">${legend([['s1', 'model calls'], ['s2', 'tool calls']])}
        ${chartSlot(hbar(rs.map((x) => ({ label: x.case_key, values: [x.model_calls || 0, x.tool_calls_list.length || x.tool_calls || 0], tip: `<b>${esc(x.case_key)}</b><br>${fmtInt(x.model_calls)} model calls<br>${fmtInt(x.tool_calls_list.length || x.tool_calls)} tool calls${repeatsOf(x) ? `<br>${repeatsOf(x)} repeated` : ''}` })), { series: ['s1', 's2'], names: ['model calls', 'tool calls'], fmtV: (v) => fmtInt(v) }), 'Stacked bar chart of model and tool calls per case')}</div></section>
    </div>`;

    // ---- check matrix
    const ckNames = [...new Set(rs.flatMap((x) => x.checks.map((c) => c.name)))].sort((a, b) => checkRank(a) - checkRank(b) || a.localeCompare(b));
    const mxCell = (x, n) => {
      const c = x.checks.find((k) => k.name === n);
      if (!c || c.passed == null) return '<td class="mx"><span class="zero">–</span></td>';
      const tip = `<b>${esc(x.case_key)} · ${esc(checkLabel(n))}: ${c.passed ? 'pass' : 'fail'}</b>${c.detail ? `<br>${esc(c.detail.slice(0, 300))}` : ''}`;
      return `<td class="mx"><span class="ckmark ${c.passed ? 'tone-good' : 'tone-bad'}" aria-label="${esc(checkLabel(n))}: ${c.passed ? 'pass' : `fail, ${esc(c.detail || '')}`}"${c.passed ? '' : ' tabindex="0"'} data-tip="${esc(tip)}">${icon(c.passed ? 'check' : 'x')}</span></td>`;
    };
    const ckFoot = ckNames.map((n) => { const xs = rs.map((x) => x.checks.find((k) => k.name === n)).filter((c) => c && c.passed != null); return `<td class="mx">${xs.filter((c) => c.passed).length} / ${xs.length}</td>`; }).join('');
    const matrix = `<section class="card" id="mr-checks" aria-labelledby="mx-h">${cardHead('<span id="mx-h">Checks per case</span>', 'Every check of every case. Hover a cross for the reason; – means the check does not apply to that case.')}
      <div class="table-wrap"><table class="data matrix"><thead><tr><th scope="col" class="sticky">Case</th><th scope="col">Status</th><th scope="col" class="num">Score</th>
        ${ckNames.map((n) => `<th scope="col" class="mx"><span class="has-def" tabindex="0"${CHECK_INFO[n] ? ` ${defAttrs(CHECK_INFO[n][0], CHECK_INFO[n][1])}` : ''}>${esc(checkLabel(n))}</span></th>`).join('')}</tr></thead>
      <tbody>${rs.map((x) => `<tr class="click" data-href-id="${x.id}"><td class="sticky nowrap">${resultLink(x.id, `<b>${esc(x.case_key)}</b>`)}</td><td>${badge(x.status, false)}</td><td class="num">${fmt(x.score)}</td>${ckNames.map((n) => mxCell(x, n)).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td class="sticky">Passed</td><td>${passes} / ${rs.length}</td><td class="num">${fmt(me?.avg_score)}</td>${ckFoot}</tr></tfoot></table></div></section>`;

    // ---- failure reasons and tool usage
    const reasons = {};
    for (const x of rs) {
      for (const c of failedOf(x)) (reasons[c.name] || (reasons[c.name] = [])).push({ x, detail: c.detail });
      if (['timeout', 'error', 'load_failed'].includes(x.status)) (reasons[x.status] || (reasons[x.status] = [])).push({ x, detail: x.error });
    }
    const reasonHtml = Object.entries(reasons).sort((a, b) => b[1].length - a[1].length || checkRank(a[0]) - checkRank(b[0])).map(([n, xs]) => `
      <h3 class="reason-h"><span>${esc(checkLabel(n))}</span><span class="fails">${xs.length}</span></h3>
      <ul class="reasons">${xs.map(({ x, detail }) => `<li>${resultLink(x.id, esc(x.case_key))}${esc((detail || 'no detail recorded').slice(0, 400))}</li>`).join('')}</ul>`).join('');
    const tools = {};
    for (const x of rs) {
      const seen = new Set();
      for (const t of x.tool_calls_list) {
        const k = t.tool || '?';
        const e = tools[k] || (tools[k] = { n: 0, cases: new Set(), failed: 0, rep: 0, dur: [] });
        e.n += 1; e.cases.add(x.case_key);
        if (t.ok === false) e.failed += 1;
        const h = `${k}|${t.args_hash}`;
        if (t.args_hash && seen.has(h)) e.rep += 1;
        seen.add(h);
        if (t.duration_s != null) e.dur.push(t.duration_s);
      }
    }
    const toolRows = Object.entries(tools).sort((a, b) => b[1].n - a[1].n);
    const failTools = `<div class="grid-2" id="mr-tools">
      <section class="card">${cardHead('Where points were lost', 'Failed checks, timeouts and errors grouped by type, with the reason recorded for each case.')}
        <div class="card-body">${reasonHtml || '<p class="muted">Nothing failed. Every check of every case passed.</p>'}</div></section>
      <section class="card">${cardHead('Tool usage', `${fmtInt(toolTotal)} calls to ${toolRows.length} tool${toolRows.length === 1 ? '' : 's'}. Repeated = same tool and arguments again within one case.`)}
        ${toolRows.length ? `<div class="table-wrap tall"><table class="data"><thead><tr><th scope="col">Tool</th><th scope="col" class="num">Calls</th><th scope="col" class="num">Cases</th><th scope="col" class="num">Repeated</th><th scope="col" class="num">Failed</th><th scope="col" class="num">Avg time</th></tr></thead><tbody>
          ${toolRows.map(([k, e]) => `<tr><td class="mono" title="${esc([...e.cases].join(', '))}">${esc(k)}</td><td class="num">${e.n}</td><td class="num">${e.cases.size}</td>
            <td class="num">${e.rep ? `<span class="fails">${e.rep}</span>` : '<span class="zero">0</span>'}</td><td class="num">${e.failed ? `<span class="fails">${e.failed}</span>` : '<span class="zero">0</span>'}</td>
            <td class="num">${e.dur.length ? `${fmt(e.dur.reduce((a, b) => a + b, 0) / e.dur.length, 2)} s` : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No tool calls recorded.</p>'}</section></div>`;

    // ---- the other models of this run
    let peersHtml = '';
    if (d.peers.length > 1) {
      const pcases = [...new Set(d.peers.flatMap((p) => p.points.map((x) => x.case)))].sort();
      const pts = (p, c) => p.points.filter((x) => x.case === c);
      const best = (c) => Math.max(...ranked.filter((p) => p.model !== model).map((p) => meanScore(pts(p, c)) ?? -1));
      peersHtml = `<section class="card" id="mr-peers" aria-labelledby="peers-h">${cardHead('<span id="peers-h">Compared with the other models of this run</span>', 'Same run, same cases. Click a model for its own run analysis.')}
        <div class="table-wrap"><table class="data"><thead><tr><th scope="col" class="num">#</th><th scope="col">Model</th><th scope="col" class="num">Avg score</th><th scope="col" class="num">Pass rate</th><th scope="col" class="num">Cron</th><th scope="col" class="num">Chat</th><th scope="col" class="num">Median time / case</th><th scope="col" class="num">Gen. tok/s</th><th scope="col" class="num">Tokens / case</th><th scope="col" class="num">Tool used %</th><th scope="col" class="num">VRAM GiB</th><th scope="col" class="num">Load s</th></tr></thead><tbody>
        ${ranked.map((p, i) => `<tr class="click${p.model === model ? ' current' : ''}${p.partial ? ' partial' : ''}" data-href-model="${esc(p.model)}" data-href-run="${esc(run)}">
          <td class="num">${i + 1}</td><td class="nowrap">${runLink(p.model, run, `<b>${esc(p.model)}</b>`)}${p.partial ? ' <span class="badge tone-mid">partial</span>' : ''}</td>
          <td class="num"><span class="scorecell">${fmt(p.avg_score)}${meter(p.avg_score)}</span></td><td class="num"><span class="passcell"><span class="pill ${tone(p.pass_rate)}">${fmt(p.pass_rate)}%</span>${coverage(p)}</span></td>
          <td class="num">${fmt(p.cron_score)}</td><td class="num">${fmt(p.chat_score)}</td><td class="num">${fmtDur(p.median_duration_s)}</td><td class="num">${fmt(p.median_decode_tps)}</td>
          <td class="num">${fmtInt((p.prompt_tokens_mean || 0) + (p.output_tokens_mean || 0))}</td><td class="num">${fmt(p.tool_used_pct)}</td><td class="num">${fmt(p.gpu_peak_vram_gib, 2)}</td><td class="num">${fmt(p.load_s)}</td></tr>`).join('')}
        </tbody></table></div></section>
      <section class="card" aria-labelledby="pcase-h">${cardHead('<span id="pcase-h">Case scores across the models of this run</span>', `Score per case and model. “vs best other” = ${esc(model)} minus the best other model on that case.`)}
        <div class="table-wrap"><table class="data matrix"><thead><tr><th scope="col" class="sticky">Case</th>${ranked.map((p) => `<th scope="col" class="mx${p.model === model ? ' cur' : ''}">${runLink(p.model, run, esc(p.model))}</th>`).join('')}<th scope="col" class="num">vs best other</th></tr></thead><tbody>
        ${pcases.map((c) => { const mine = me ? meanScore(pts(me, c)) : null; const b = best(c); return `<tr><td class="sticky nowrap"><b>${esc(c)}</b></td>
          ${ranked.map((p) => { const xs = pts(p, c); return `<td class="mx${p.model === model ? ' cur' : ''}">${xs.length ? heat(meanScore(xs), xs[0].id, `<b>${esc(p.model)}</b><br>${esc(c)}: ${fmt(meanScore(xs))}<br>${fmtDur(xs[0].duration_s)}`) : '<span class="zero">–</span>'}</td>`; }).join('')}
          <td class="num">${mine != null && b >= 0 ? delta(mine - b) : '<span class="zero">–</span>'}</td></tr>`; }).join('')}</tbody></table></div></section>`;
    }

    // ---- this model's other runs
    let historyHtml = '';
    if (myRuns.length > 1) {
      const hcases = [...new Set(d.history.map((h) => h.case_key))].sort();
      const hx = (r, c) => d.history.filter((h) => h.run === r && h.case_key === c);
      const idx = myRuns.indexOf(run);
      const prevScore = (c) => { for (let i = idx - 1; i >= 0; i -= 1) { const xs = hx(myRuns[i], c); if (xs.length) return meanScore(xs); } return null; };
      historyHtml = `<section class="card" id="mr-history" aria-labelledby="hist-h">${cardHead('<span id="hist-h">This model in its other runs</span>', 'Score per case in every run of this model. “vs previous” = this run minus the latest earlier run that has the case. Prompts and settings may differ between runs.')}
        <div class="table-wrap"><table class="data matrix"><thead><tr><th scope="col" class="sticky">Case</th>${myRuns.map((r) => `<th scope="col" class="mx${r === run ? ' cur' : ''}">${r === run ? `<b>${esc(r)}</b>` : runLink(model, r)}</th>`).join('')}<th scope="col" class="num">vs previous</th></tr></thead><tbody>
        ${hcases.map((c) => { const cur = hx(run, c); const pv = prevScore(c); return `<tr><td class="sticky nowrap"><b>${esc(c)}</b></td>
          ${myRuns.map((r) => { const xs = hx(r, c); return `<td class="mx${r === run ? ' cur' : ''}">${xs.length ? heat(meanScore(xs), xs[0].id, `<b>${esc(r)}</b><br>${esc(c)}: ${esc(xs.map((h) => `${h.status} ${fmt(h.score)}`).join(', '))}<br>${fmtDur(xs[0].duration_s)}`) : '<span class="zero">–</span>'}</td>`; }).join('')}
          <td class="num">${cur.length && pv != null ? delta(meanScore(cur) - pv) : '<span class="zero">–</span>'}</td></tr>`; }).join('')}</tbody></table></div></section>`;
    }

    // ---- all results and run info
    const t = table(resultColumns({ withModel: false, detailedChecks: false, speech: rs.some((x) => x.audio) }).filter((c) => c.key !== 'run'), rs, s, { sortKey: 'xsort', dirKey: 'xdir', rowAttr: (x) => ` class="click" data-href-id="${x.id}"` });
    const resultsHtml = `<section class="card" id="mr-results" aria-labelledby="mrr-h">${cardHead('<span id="mrr-h">Case results</span>', `${rs.length} result(s) in run order. Click a row for the answer, checks and transcript.`)}
      ${rs.length ? t.html : '<p class="empty">No results.</p>'}<div class="card-foot">${statusLegend()}</div></section>`;
    const runDur = epoch(d.run.finished_at) && epoch(d.run.started_at) ? epoch(d.run.finished_at) - epoch(d.run.started_at) : null;
    const info = [['Run', `<b>${esc(d.run.name)}</b> ${runBadge}`], ['Started', esc(fmtDate(d.run.started_at))], ['Finished', esc(fmtDate(d.run.finished_at))], ['Run duration', fmtDur(runDur)],
      ['Host', esc(d.run.host || '–')], ['Command', d.run.command ? `<code>${esc(d.run.command)}</code>` : '–'], ['Notes', esc(d.run.notes.join('; ') || '–')],
      ['Model file', d.preset?.file ? `<span class="mono">${esc(d.preset.file)}</span>` : '–'], ['Quant / ctx / KV', esc([d.preset?.quant, d.preset?.ctx ? fmtInt(d.preset.ctx) : null, d.preset?.kv_type].map((v) => v || '–').join(' · '))],
      ['Load', esc([ld.load_status, ld.load_ms != null ? `${fmt(ld.load_ms / 1000)} s` : null, ld.load_error].filter(Boolean).join(' · ') || '–')]];
    const infoHtml = `<div class="grid-2" id="mr-info">
      <section class="card">${cardHead('Run and preset')}<div class="card-body"><dl class="kv">${info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div></section>
      <section class="card">${cardHead('Recorded by the runner', 'Per-model aggregates stored at the end of the model’s part of the run.')}<div class="card-body"><dl class="kv">
        ${d.stats.map((x) => `<dt class="mono">${esc(x.name)}</dt><dd>${x.value != null ? fmt(x.value, 2) : ''}${x.text ? ` ${esc(x.text)}` : ''}</dd>`).join('') || '<dt>none yet</dt><dd>written when this model finishes</dd>'}</dl></div></section></div>`;

    $('#main').innerHTML = `${head}${alertHtml}${kpis}${timeline}${perCase}${matrix}${failTools}${peersHtml}${historyHtml}${resultsHtml}${infoHtml}`;
    applyWidths($('#main'));
    drawCharts();
    wireSort($('#mr-results'), s, 'xsort', 'xdir');
    $('#main').querySelectorAll('a[data-jump]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const el = document.getElementById(a.dataset.jump);
      if (el) { el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
    }));
  }

  // ------------------------------------------------------------------ result view
  async function viewResult(s, my) {
    const id = s.get('id');
    const r = await api(`/api/result/${encodeURIComponent(id)}`);
    if (my !== seq) return;
    CHARTS = [];
    crumbs([link({ view: null, model: null, run: null, id: null }, 'Leaderboard', 'data-nav="home"'), modelLink(r.model), runLink(r.model, r.run), `<span aria-current="page">${esc(r.case_key)}${r.repeat_idx > 1 ? ` #${r.repeat_idx}` : ''}</span>`]);
    $('#summary').textContent = `Result ${r.id} · run ${r.run}`;
    const extra = r.extra || {};
    const otherExtra = Object.entries(extra).filter(([k]) => !['notes', 'leftovers'].includes(k));
    const kv = [
      ['Benchmark version', r.bench_version ? `v${esc(r.bench_version)}` : '–'], ['Run', `${runLink(r.model, r.run)}${r.run_started_at ? ` <span class="muted">started ${esc(fmtDate(r.run_started_at))}</span>` : ''}`], ['Benchmark', esc(r.benchmark)], ['Model', modelLink(r.model)],
      ['Case', `<b>${esc(r.case_key)}</b>${r.title && r.title !== r.case_key ? ` — ${esc(r.title)}` : ''}`], ['Kind / profile', `${esc(r.kind || '–')} · ${esc(r.profile || '–')}`], ['Repeat', esc(r.repeat_idx)],
      ['Status', badge(r.status)], ['Run finished (completed)', r.completed == null ? '–' : r.completed ? 'yes' : 'no'], ['Recorded', esc(fmtDate(r.created_at))],
      ['Answer chars', fmtInt(r.answer_chars)], ['Notes', esc(extra.notes || '–')], ['Leftovers', esc((extra.leftovers || []).join('; ') || '–')],
      ...otherExtra.map(([k, v]) => [k, `<code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code>`]),
      ['Error', r.error ? `<span class="ck fail">${esc(r.error)}</span>` : '–'],
    ];
    const tools = {};
    for (const t of r.tool_calls) { const k = t.tool || '?'; tools[k] = tools[k] || { n: 0, failed: 0 }; tools[k].n += 1; if (t.ok === false) tools[k].failed += 1; }
    const ck = (name) => r.checks.find((c) => c.name === name);
    const fin = ck('completed'); const cor = ck('correct');
    const yn = (c) => (!c || c.passed == null ? '–' : c.passed ? 'Yes' : 'No');
    const kpis = `<div class="kpis">
      ${kpi({ hero: true, label: 'Score', ic: 'target', def: DEF.avg_score[1], value: `<span class="big">${fmt(r.score)}</span>`, sub: `status ${esc(r.status)}`, extra: meter(r.score) })}
      ${kpi({ label: 'Run finished', ic: 'flag', def: CHECK_INFO.completed[1], value: yn(fin), sub: fin ? esc(fin.detail || '') : 'not checked' })}
      ${kpi({ label: 'Task correct', ic: 'shield', def: CHECK_INFO.correct[1], value: yn(cor), sub: cor ? esc(cor.detail || '') : 'not checked' })}
      ${kpi({ label: 'Time', ic: 'clock', def: DEF.duration_s[1], value: fmtDur(r.duration_s), sub: `${fmt(r.model_calls)} model calls` })}
      ${kpi({ label: 'Tokens', ic: 'hash', def: 'Prompt and output tokens over all model calls of this case.', value: fmtCompact((r.prompt_tokens || 0) + (r.output_tokens || 0)), sub: `${fmtInt(r.prompt_tokens)} prompt · ${fmtInt(r.output_tokens)} output` })}
      ${kpi({ label: 'Tool calls', ic: 'tool', def: DEF.tool_calls[1], value: fmtInt(r.tool_calls.length), sub: `${fmt(r.tool_used_pct)}% of calls used tools` })}
    </div>`;
    const html = `
      <div class="page-head"><div>${modelLink(r.model, `${icon('left')}${esc(r.model)}`).replace('<a ', '<a class="back" ')}
        <p class="eyebrow">Case result</p><h1>${esc(r.case_key)}${r.repeat_idx > 1 ? ` <span class="muted">#${r.repeat_idx}</span>` : ''} ${badge(r.status)}</h1>
        ${r.title && r.title !== r.case_key ? `<p class="lede">${esc(r.title)}</p>` : ''}</div>
        <div class="actions-row"><a class="btn btn-sm" href="/api/run/${esc(r.run)}/report.md">${icon('download')}report.md</a><a class="btn btn-sm" href="/api/run/${esc(r.run)}/report.xlsx">${icon('download')}report.xlsx</a><a class="btn btn-sm" href="/api/run/${esc(r.run)}/results.json">${icon('download')}results.json</a></div></div>
      ${kpis}
      <div class="grid-2">
        <section class="card">${cardHead('Details')}<div class="card-body"><dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl></div></section>
        <section class="card">${cardHead('Metrics', 'Raw values recorded for this result.')}<div class="card-body"><dl class="kv">
          ${[['Generation speed', r.decode_tps, 'tok/s'], ['Prompt speed', r.prompt_tps, 'tok/s']].filter(([, v]) => v != null).map(([k, v, u]) => `<dt>${esc(k)}</dt><dd>${fmt(v, 2)} ${u}</dd>`).join('')}
          ${r.metrics.map((x) => `<dt class="mono">${esc(x.name)}</dt><dd>${fmt(x.value, 2)} ${esc(x.unit || '')}</dd>`).join('') || '<dt>none</dt><dd></dd>'}</dl>
          <h3 class="mt">Tool usage (${r.tool_calls.length} calls)</h3>
          <dl class="kv">${Object.entries(tools).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => `<dt class="mono">${esc(k)}</dt><dd>${v.n}${v.failed ? ` <span class="badge tone-bad">${v.failed} failed</span>` : ''}</dd>`).join('') || '<dt>none recorded</dt><dd></dd>'}</dl></div></section>
      </div>
      <section class="card" aria-labelledby="ck-h">${cardHead('<span id="ck-h">Checks</span>', 'Each check with its weight in the case score and the reason it passed or failed.')}
        <div class="table-wrap"><table class="data"><thead><tr><th scope="col">Check</th><th scope="col">Category</th><th scope="col">Result</th><th scope="col" class="num">Weight</th><th scope="col">Reason</th></tr></thead><tbody>
        ${r.checks.map((c) => `<tr><td class="nowrap"><span tabindex="0" class="has-def"${CHECK_INFO[c.name] ? ` ${defAttrs(CHECK_INFO[c.name][0], CHECK_INFO[c.name][1])}` : ''}><b>${esc(checkLabel(c.name))}</b></span> <span class="muted mono">${esc(c.name)}</span></td><td>${esc(c.category)}</td>
          <td>${c.passed === true ? `<span class="badge tone-good">${icon('check')}pass</span>` : c.passed === false ? `<span class="badge tone-bad">${icon('x')}fail</span>` : '<span class="badge tone-mid">n/a</span>'}</td>
          <td class="num">${fmt(c.weight, 2)}</td><td class="wrap">${esc(c.detail || '')}</td></tr>`).join('')}
        </tbody></table></div><div class="card-foot">${statusLegend()}</div></section>
      ${r.tool_calls.length ? `<section class="card">${cardHead('Tool call sequence', 'In call order. Args hash identifies repeated identical calls.')}<div class="table-wrap tall"><table class="data"><thead><tr><th scope="col" class="num">#</th><th scope="col">Tool</th><th scope="col">OK</th><th scope="col" class="num">Time</th><th scope="col">Args hash</th></tr></thead><tbody>
        ${r.tool_calls.map((t) => `<tr><td class="num">${t.seq}</td><td class="mono">${esc(t.tool)}</td><td>${t.ok === false ? `<span class="badge tone-bad">${icon('x')}failed</span>` : t.ok ? `<span class="badge tone-good">${icon('check')}ok</span>` : '–'}</td><td class="num">${t.duration_s != null ? `${fmt(t.duration_s, 2)} s` : '–'}</td><td class="mono">${esc(t.args_hash || '')}</td></tr>`).join('')}
      </tbody></table></div></section>` : ''}
      ${r.audio ? `<section class="card" aria-labelledby="aud-h">${cardHead('<span id="aud-h">Audio</span>', r.audio === 'tts' ? `Speech generated by ${esc(r.model)}.` : 'Source clip the model transcribed.')}<div class="card-body">
        <audio class="aud wide" controls preload="none" src="/api/audio/${esc(r.id)}.wav" aria-label="${r.audio === 'tts' ? 'Generated speech' : 'Source clip'}"></audio>
        <dl class="kv"><dt>${r.audio === 'tts' ? 'Text spoken' : 'Reference transcript'}</dt><dd>${esc(r.reference || '–')}</dd><dt>${r.audio === 'tts' ? 'Heard back (STT judge)' : 'Model transcript'}</dt><dd>${esc(r.answer_text || '–')}</dd></dl></div></section>` : ''}
      <section class="card">${cardHead('Answer', `${fmtInt(r.answer_chars)} characters`)}<div class="card-body"><pre class="answer">${esc(r.answer_text || '(no answer text stored)')}</pre></div></section>
      <section class="card">${cardHead('Transcript', r.has_transcript ? 'Full conversation from reports/.' : 'Transcript file not available.', r.has_transcript ? `<div class="actions-row"><a class="btn btn-sm" href="/api/result/${esc(r.id)}/transcript" target="_blank" rel="noopener">${icon('external')}Raw JSON</a><a class="btn btn-sm" href="/api/result/${esc(r.id)}/transcript?download=1">${icon('download')}Download</a><button type="button" class="btn btn-sm btn-primary" id="show-tr">Show conversation</button></div>` : '')}
        <div class="card-body" id="tr"></div></section>`;
    $('#main').innerHTML = html;
    applyWidths($('#main'));
    const btn = $('#show-tr');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      $('#tr').innerHTML = '<p class="muted"><span class="spinner"></span>Loading transcript…</p>';
      try {
        const t = await api(`/api/result/${encodeURIComponent(id)}/transcript`);
        const msgs = t.messages || [];
        $('#tr').innerHTML = `<div class="msg role-prompt"><div class="msg-head">Prompt</div><pre class="answer">${esc((t.prompt || '').slice(0, 20000))}</pre></div>
          ${msgs.map((m) => `<div class="msg role-${esc(m.role)}"><div class="msg-head">${esc(m.role)}${m.tool_name ? ` · <span class="mono">${esc(m.tool_name)}</span>` : ''}</div>
            ${m.content ? `<pre class="answer">${esc(m.content.slice(0, 8000))}${m.content.length > 8000 ? '\n… (truncated, see raw JSON)' : ''}</pre>` : ''}
            ${m.tool_calls ? `<pre class="answer">${esc(String(typeof m.tool_calls === 'string' ? m.tool_calls : JSON.stringify(m.tool_calls, null, 2)).slice(0, 4000))}</pre>` : ''}</div>`).join('')}`;
        btn.textContent = `${msgs.length} messages`;
      } catch (e) { $('#tr').innerHTML = `<p class="ck fail">${esc(e.message)}</p>`; btn.disabled = false; }
    });
  }

  // ------------------------------------------------------------------ render loop
  let seq = 0;
  let lastViewKey = null;
  async function render() {
    const my = ++seq;
    const main = $('#main');
    try {
      if (!META) META = await api('/api/meta');
      let s = state();
      if (!s.get('benchmark') && META.benchmarks.length) {
        const b = META.benchmarks.find((x) => x.results) || META.benchmarks[0];
        s.set('benchmark', b.name);
        history.replaceState(null, '', `?${s}`);
        s = state();
      }
      renderFilters(s);
      if (!META.benchmarks.length) { main.innerHTML = emptyCard('No results yet', 'The database has no results. Import a report or run a benchmark.'); return; }
      const view = s.get('view');
      const viewKey = `${view || ''}|${s.get('model') || ''}|${s.get('run') || ''}|${s.get('id') || ''}`;
      main.classList.add('busy');
      if (view === 'model' && s.get('model')) await viewModel(s, my);
      else if (view === 'modelrun' && s.get('model') && s.get('run')) await viewModelRun(s, my);
      else if (view === 'result' && s.get('id')) await viewResult(s, my);
      else await viewLeaderboard(s, my);
      if (my === seq && viewKey !== lastViewKey) {
        if (lastViewKey !== null) { window.scrollTo(0, 0); main.focus({ preventScroll: true }); }
        lastViewKey = viewKey;
      }
    } catch (e) {
      if (my === seq) main.innerHTML = emptyCard('Something went wrong', `Error: ${e.message}`);
    } finally {
      if (my === seq) main.classList.remove('busy');
    }
  }
  render();
})();
