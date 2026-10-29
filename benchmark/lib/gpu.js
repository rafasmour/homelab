'use strict';
// Host GPU sampling via `docker exec llama-server` (it can read the amdgpu sysfs).
const { dockerExec } = require('./docker');

const SCRIPT = [
  'd=/sys/class/drm/card1/device',
  'for f in $d/hwmon/hwmon*/temp1_input $d/hwmon/hwmon*/temp2_input $d/hwmon/hwmon*/temp3_input $d/mem_info_vram_used $d/mem_info_vram_total; do',
  '  if [ -r "$f" ]; then cat "$f"; else echo -1; fi',
  'done',
].join('\n');

async function sampleOnce() {
  const r = await dockerExec('llama-server', ['sh', '-c', SCRIPT], { timeoutMs: 15_000 });
  if (r.code !== 0) return null;
  const v = r.stdout.trim().split(/\s+/).map(Number);
  if (v.length < 5) return null;
  const t = (x) => (x >= 0 ? x / 1000 : null);
  const g = (x) => (x >= 0 ? Math.round((x / 1024 ** 3) * 100) / 100 : null);
  return { at: new Date().toISOString(), edge_c: t(v[0]), junction_c: t(v[1]), mem_c: t(v[2]), vram_used_gib: g(v[3]), vram_total_gib: g(v[4]) };
}

/**
 * Background GPU monitor. Samples every `intervalMs`, tracks peaks per label and
 * calls `onOverheat` when temp3 (VRAM) stays >= limitC for holdMs.
 */
class GpuMonitor {
  constructor({ intervalMs = 15_000, limitC = 104, holdMs = 60_000, onOverheat = () => {} } = {}) {
    Object.assign(this, { intervalMs, limitC, holdMs, onOverheat });
    this.samples = [];
    this.peaks = {};
    this.label = 'idle';
    this.hotSince = null;
    this.timer = null;
    this.overheated = false;
  }
  setLabel(label) { this.label = label; }
  async tick() {
    const s = await sampleOnce().catch(() => null);
    if (!s) return;
    s.label = this.label;
    this.samples.push(s);
    const p = this.peaks[this.label] || (this.peaks[this.label] = { edge_c: 0, junction_c: 0, mem_c: 0, vram_used_gib: 0, samples: 0 });
    p.samples += 1;
    for (const k of ['edge_c', 'junction_c', 'mem_c', 'vram_used_gib']) if (s[k] != null && s[k] > p[k]) p[k] = s[k];
    if (s.mem_c != null && s.mem_c >= this.limitC) {
      this.hotSince = this.hotSince || Date.now();
      if (!this.overheated && Date.now() - this.hotSince >= this.holdMs) {
        this.overheated = true;
        this.onOverheat(s);
      }
    } else this.hotSince = null;
  }
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  peakFor(prefix) {
    const out = { edge_c: null, junction_c: null, mem_c: null, vram_used_gib: null };
    for (const [label, p] of Object.entries(this.peaks)) {
      if (!label.startsWith(prefix)) continue;
      for (const k of Object.keys(out)) if (out[k] == null || p[k] > out[k]) out[k] = p[k];
    }
    return out;
  }
}

module.exports = { sampleOnce, GpuMonitor };
