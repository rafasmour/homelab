#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const {
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

function parseStatement(text) {
  const lines = text.split(/\r?\n/).slice(11);
  if (lines[0] && lines[0].includes("Ημ/νία Συν/γης")) lines.shift();

  const transactions = [];
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const columns = line.split("\t").map(cleanCell);
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
  const zipPath = process.argv[2];
  const password = process.env.PIRAEUS_ZIP_PASSWORD || "";
  if (!zipPath) fail("Usage: piraeus-import.cjs <statement.zip>");
  if (!password) fail("Set PIRAEUS_ZIP_PASSWORD in n8n/.env");
  mkdirSync(importDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const workDir = mkdtempSync(join(tmpdir(), "piraeus-"));
  try {
    execFileSync("unzip", ["-P", password, "-o", zipPath, "-d", workDir], {
      stdio: "pipe",
    });
    const csvName = readdirSync(workDir).find((name) => name.toLowerCase().endsWith(".csv"));
    if (!csvName) fail("The zip does not contain a CSV");
    const transactions = parseStatement(readFileSync(join(workDir, csvName), "utf8"));
    if (transactions.length === 0) fail("No transactions were found after the preamble");

    const destination = join(importDir, currentName);
    writeFileSync(destination, toCsv(transactions));
    console.log(`Wrote ${transactions.length} transactions to ${destination}`);
    if (await postAutoImport()) {
      const archived = join(
        archiveDir,
        `piraeus-${transactions[0].date.slice(0, 7)}-${Date.now()}.csv`,
      );
      copyFileSync(destination, archived);
      unlinkSync(destination);
      console.log(`Archived imported statement to ${archived}`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((error) => fail(error.message));
}

module.exports = { parseStatement, toCsv };
