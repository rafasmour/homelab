'use strict';
// Benchmark versioning. Every benchmark module exports
//   version     explicit semver-like string, bumped by hand when what is measured changes
//   changelog   [{version, date, summary}] (the last entry is the current version), mirrored in README "Benchmark versions"
//   fingerprintFiles()  absolute paths whose content defines the measurement (task files, checks/verifier code, case set)
//   backfill(runName)   optional: historical version of a stored run that has none (see `main.js backfill-versions`)
// The fingerprint is a SHA-256 over those files plus the scoring code (lib/report.js scoreRow + weights); it is stored
// next to the version in the DB (run_benchmarks), results.json and report.md. A fingerprint that differs within one version
// means something that is measured changed without a version bump.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function scoringSource() {
  const report = require('./report');
  const db = require('./db');
  return `${report.scoreRow.toString()}\n${JSON.stringify(db.WEIGHTS)}`;
}

/** 12-hex content fingerprint of `files` (sorted by name, name + content) and the scoring code. */
function fingerprint(files, { scoring = true } = {}) {
  const h = crypto.createHash('sha256');
  for (const f of [...new Set(files)].sort()) {
    h.update(`file:${path.basename(path.dirname(f))}/${path.basename(f)}\n`);
    try { h.update(fs.readFileSync(f)); } catch { h.update('(missing)'); }
    h.update('\n');
  }
  if (scoring) h.update(`scoring:${scoringSource()}`);
  return h.digest('hex').slice(0, 12);
}

/** { name, version, fingerprint, summary } for a benchmark module (null version when it declares none). */
function info(b) {
  if (!b || !b.version) return { version: null, fingerprint: null, summary: null };
  const entry = (b.changelog || []).find((c) => c.version === b.version);
  let fp = null;
  try { fp = fingerprint(b.fingerprintFiles ? b.fingerprintFiles() : []); } catch { fp = null; }
  return { version: b.version, fingerprint: fp, summary: entry ? entry.summary : null };
}

/** Standard fingerprint file list: every file of `dir` with these extensions (non-recursive), plus extra paths. */
function filesIn(dir, exts, extra = []) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => exts.some((e) => n.endsWith(e))); } catch { /* none */ }
  return [...names.map((n) => path.join(dir, n)), ...extra];
}

module.exports = { fingerprint, info, filesIn };
