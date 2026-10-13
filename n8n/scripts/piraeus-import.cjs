#!/usr/bin/env node
"use strict";

const AdmZip = require("adm-zip");
const iconv = require("iconv-lite");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  unlinkSync,
  rmSync,
} = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const http = require("http");

const importDir = process.env.FIREFLY_IMPORT_DIR || "/firefly-import";
const archiveDir = process.env.FIREFLY_IMPORT_ARCHIVE || "/firefly-import-archive";
const currentName = "piraeus-current.csv";

const importMappingTemplate = {
  version: 3,
  date: "Y-m-d",
  default_account: 0,
  delimiter: "comma",
  headers: true,
  rules: true,
  skip_form: true,
  add_import_tag: true,
  roles: ["date_transaction", "amount", "description", "note"],
  do_mapping: [false, false, false, false],
  mapping: {},
  duplicate_detection_method: "classic",
  ignore_duplicate_lines: true,
  ignore_duplicate_transactions: true,
  unique_column_index: 0,
  unique_column_type: "internal-id",
  flow: "file",
  conversion: false,
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function cleanCell(value) {
  const text = String(value || "").trim();
  const wrapped = text.match(/^="(.*)"$/);
  return (wrapped ? wrapped[1] : text).trim();
}

function parseAmount(value) {
  const text = cleanCell(value);
  if (!text) return null;
  const normalized = text.replace(/\./g, "").replace(",", ".");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function csvField(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function classifyNote(note) {
  if (/eur$/i.test(note)) return "amount";
  if (/x{2,}/i.test(note) || /\d{6}x+\d{3,}/i.test(note)) return "card";
  if (/^\d{4}$/.test(note)) return "mcc";
  if (/^PO\d+/i.test(note)) return "reference";
  if (/^[A-Z0-9]{12,}$/i.test(note)) return "reference";
  return "merchant";
}

const GREEK_RE = /[\u0370-\u03FF\u1F00-\u1FFF]/g;

function countGreek(text) {
  return (text.match(GREEK_RE) || []).length;
}

/** Piraeus Greece exports are usually Windows-1253, not UTF-8. */
function decodeCsvBytes(buffer) {
  const configured = (process.env.PIRAEUS_CSV_ENCODING || "").trim();
  if (configured) {
    return iconv.decode(buffer, configured);
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return iconv.decode(buffer, "utf8");
  }
  const asUtf8 = buffer.toString("utf8");
  if (!asUtf8.includes("\uFFFD") && countGreek(asUtf8) >= 3) {
    return asUtf8;
  }
  const asWin1253 = iconv.decode(buffer, "win1253");
  if (countGreek(asWin1253) >= countGreek(asUtf8)) {
    return asWin1253;
  }
  return asUtf8;
}

function detectDelimiter(lines) {
  for (const line of lines) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(line)) continue;
    const tabs = line.split("\t").length;
    const semis = line.split(";").length;
    if (semis > tabs) return ";";
    if (tabs > 1) return "\t";
  }
  return ";";
}

function parseStatement(text) {
  const allLines = text.split(/\r?\n/);
  let start = allLines.findIndex((line) => /opening balance/i.test(line));
  if (start < 0) {
    start = allLines.findIndex((line) => /^\d{4}-\d{2}-\d{2}/.test(line.split(/[;\t]/)[0] || ""));
  }
  const lines = start >= 0 ? allLines.slice(start + 1) : allLines.slice(11);
  const delimiter = detectDelimiter(allLines);

  const transactions = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const columns = line.split(delimiter).map(cleanCell);
    const date = columns[0] || "";
    const reason = columns[1] || "";
    const credit = parseAmount(columns[3]);
    const debit = parseAmount(columns[4]);

    if (/opening balance/i.test(line)) {
      current = null;
      continue;
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const amount = debit !== null ? debit : credit;
      if (amount === null) fail(`Transaction on ${date} has no amount`);
      current = { date, reason, amount, notes: [] };
      transactions.push(current);
      continue;
    }

    const note = columns.find((column) => column) || "";
    if (current && note) current.notes.push(note);
  }

  return transactions;
}

function toCsv(transactions) {
  const rows = [["date", "amount", "description", "notes"]];
  for (const transaction of transactions) {
    const grouped = { merchant: [], reference: [], card: [], mcc: [] };
    for (const note of transaction.notes) {
      const kind = classifyNote(note);
      if (kind === "amount") continue;
      grouped[kind].push(note);
    }
    const merchant = grouped.merchant[0];
    const description = merchant
      ? `${transaction.reason} — ${merchant}`
      : transaction.reason;
    const notes = ["reference", "card", "mcc"]
      .flatMap((kind) => grouped[kind])
      .concat(grouped.merchant.slice(1))
      .join(" | ");
    rows.push([
      transaction.date,
      transaction.amount.toFixed(2),
      description,
      notes,
    ]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
}

function resolveZipPath(rawPath) {
  const defaultPath =
    process.env.PIRAEUS_ZIP_PATH || "/tmp/piraeus-statement.zip";
  const candidates = [];
  if (rawPath) candidates.push(rawPath);
  if (!rawPath || !rawPath.startsWith("/")) {
    candidates.push(join("/tmp", rawPath || "piraeus-statement.zip"));
    candidates.push(defaultPath);
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  fail(
    `Zip not found (tried: ${candidates.filter(Boolean).join(", ")}). ` +
      "Run Save zip first or set PIRAEUS_ZIP_PATH.",
  );
}

function extractZip(zipPath, workDir, password) {
  const zipBytes = readFileSync(zipPath);
  const zip = new AdmZip(zipBytes);
  try {
    // adm-zip: extractAllTo(target, overwrite, keepOriginalPermission, pass)
    zip.extractAllTo(workDir, true, false, password);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to extract zip: ${message}`);
  }
}

function ensureImportMapping(importDir, csvFileName) {
  const fallbackPath = join(importDir, "_fallback.json");
  if (existsSync(fallbackPath)) {
    return;
  }
  const jsonName = csvFileName.replace(/\.csv$/i, ".json");
  const jsonPath = join(importDir, jsonName);
  if (existsSync(jsonPath)) {
    return;
  }
  const accountId = Number.parseInt(
    process.env.FIREFLY_IMPORT_DEFAULT_ACCOUNT_ID || "",
    10,
  );
  if (!Number.isFinite(accountId) || accountId <= 0) {
    fail(
      "Auto-import needs firefly-iii/imports/_fallback.json or FIREFLY_IMPORT_DEFAULT_ACCOUNT_ID in n8n/.env",
    );
  }
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ ...importMappingTemplate, default_account: accountId }, null, 2)}\n`,
  );
}

function postAutoImport() {
  const secret = process.env.AUTO_IMPORT_SECRET || "";
  if (secret.length < 16) {
    console.log("CSV written. Auto-import is not configured yet, so the file stays in the import directory.");
    return Promise.resolve(false);
  }
  const requestUrl = new URL(
    "http://firefly-iii-data-importer:8080/autoimport",
  );
  requestUrl.searchParams.set("directory", "/import");
  requestUrl.searchParams.set("secret", secret);

  return new Promise((resolve, reject) => {
    const request = http.request(requestUrl, { method: "POST" }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Auto-import returned HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = {};
        }
        if (parsed.error) {
          reject(new Error(`Auto-import did not import the statement: ${String(parsed.error).slice(0, 300)}`));
          return;
        }
        resolve(true);
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function main() {
  const zipArg = process.argv[2];
  const zipPath = resolveZipPath(zipArg);
  const password = process.env.PIRAEUS_ZIP_PASSWORD || "";
  if (!password) fail("Set PIRAEUS_ZIP_PASSWORD in n8n/.env");
  mkdirSync(importDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "piraeus-"));
  try {
    extractZip(zipPath, workDir, password);
    const csvName = readdirSync(workDir).find((name) => name.toLowerCase().endsWith(".csv"));
    if (!csvName) fail("The zip does not contain a CSV");
    const csvBytes = readFileSync(join(workDir, csvName));
    const transactions = parseStatement(decodeCsvBytes(csvBytes));
    if (transactions.length === 0) fail("No transactions were found after the preamble");

    const destination = join(importDir, currentName);
    writeFileSync(destination, toCsv(transactions));
    ensureImportMapping(importDir, currentName);
    console.log(`Wrote ${transactions.length} transactions to ${destination}`);
    if (!(await postAutoImport())) {
      return;
    }
    const archived = join(
      archiveDir,
      `piraeus-${transactions[0].date.slice(0, 7)}-${Date.now()}.csv`,
    );
    if (existsSync(destination)) {
      copyFileSync(destination, archived);
      unlinkSync(destination);
      console.log(`Archived imported statement to ${archived}`);
    } else {
      console.log("Auto-import consumed the CSV from the import directory.");
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message));
}

module.exports = { parseStatement, toCsv, decodeCsvBytes };
