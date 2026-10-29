#!/usr/bin/env python3
"""Export a run to <run_dir>/report.xlsx with native Excel charts.

  export_xlsx.py <run_dir> --db <benchmark.db> --run <run name>
      Rows, checks and run metadata are read from SQLite (the source of truth);
      the aggregates and rankings computed by lib/report.js come as JSON on stdin.
  export_xlsx.py <run_dir>
      Legacy mode: read everything from <run_dir>/results.json.

Sheets: Summary (every benchmark x model), one sheet per benchmark (aggregate
table + pass-rate, median-duration, tokens and failure-type charts), Cases
(one row per case run).
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HEAD_FILL = PatternFill("solid", fgColor="1F4E78")
HEAD_FONT = Font(bold=True, color="FFFFFF")
PASS_FILL = PatternFill("solid", fgColor="C6EFCE")
FAIL_FILL = PatternFill("solid", fgColor="FFC7CE")


def sheet_title(name, used):
    base = re.sub(r"[\[\]:*?/\\]", "-", name)[:28] or "Sheet"
    title, n = base, 2
    while title.lower() in used:
        title = f"{base[:25]}-{n}"
        n += 1
    used.add(title.lower())
    return title


def write_table(ws, row, headers, rows):
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=row, column=c, value=h)
        cell.fill, cell.font = HEAD_FILL, HEAD_FONT
        cell.alignment = Alignment(wrap_text=True, vertical="top")
    for r, values in enumerate(rows, row + 1):
        for c, v in enumerate(values, 1):
            ws.cell(row=r, column=c, value=v)
    return row + len(rows)


def autosize(ws, max_width=60):
    widths = {}
    for row in ws.iter_rows():
        for cell in row:
            if cell.value is not None:
                widths[cell.column] = max(widths.get(cell.column, 0), min(max_width, len(str(cell.value))))
    for col, w in widths.items():
        ws.column_dimensions[get_column_letter(col)].width = max(8, w + 2)


def bar(title, y_title, ws, cats, data_cols, first_row, last_row, stacked=False):
    ch = BarChart()
    ch.type = "col"
    ch.title = title
    ch.y_axis.title = y_title
    ch.height, ch.width = 9, 18
    if stacked:
        ch.grouping = "stacked"
        ch.overlap = 100
    for col in data_cols:
        ch.add_data(Reference(ws, min_col=col, min_row=first_row - 1, max_row=last_row), titles_from_data=True)
    ch.set_categories(Reference(ws, min_col=cats, min_row=first_row, max_row=last_row))
    ch.y_axis.delete = False
    ch.x_axis.delete = False
    return ch


def load_from_db(db_path, run_name):
    """Rebuild the results.json shape (without aggregates) from SQLite, read-only."""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
    con.row_factory = sqlite3.Row
    run = con.execute("SELECT * FROM runs WHERE name = ?", (run_name,)).fetchone()
    if run is None:
        sys.exit(f"run {run_name} not found in {db_path}")
    meta = json.loads(run["meta_json"] or "{}")
    benches = [{"name": b["name"], "description": b.get("description", ""), "results": []} for b in meta.get("benchmarks", [])]
    checks, metrics = {}, {}
    for c in con.execute("SELECT ch.* FROM checks ch JOIN case_results cr ON cr.id = ch.result_id WHERE cr.run_id = ? ORDER BY ch.id", (run["id"],)):
        checks.setdefault(c["result_id"], []).append({"name": c["name"], "category": c["category"], "reason": c["detail"],
                                                      "pass": None if c["passed"] is None else bool(c["passed"])})
    for m in con.execute("SELECT mt.* FROM metrics mt JOIN case_results cr ON cr.id = mt.result_id WHERE cr.run_id = ?", (run["id"],)):
        metrics.setdefault(m["result_id"], {})[m["name"]] = m["value"]
    prefix = f"{run_name}/"
    q = """SELECT cr.*, b.name AS benchmark, m.alias AS model, c.case_key, c.profile, c.kind
           FROM case_results cr JOIN benchmarks b ON b.id = cr.benchmark_id JOIN models m ON m.id = cr.model_id
           JOIN cases c ON c.id = cr.case_id WHERE cr.run_id = ? ORDER BY cr.id"""
    for r in con.execute(q, (run["id"],)):
        extra = json.loads(r["extra_json"] or "{}")
        mt = metrics.get(r["id"], {})
        b = next((x for x in benches if x["name"] == r["benchmark"]), None)
        if b is None:
            b = {"name": r["benchmark"], "description": "", "results": []}
            benches.append(b)
        tp = r["transcript_path"]
        b["results"].append({
            "model": r["model"], "case_id": r["case_key"], "group": extra.get("group") or r["profile"], "kind": r["kind"],
            "repeat": r["repeat_idx"], "status": r["status"], "score": r["score"], "duration_s": r["duration_s"],
            "decode_tps": mt.get("decode_tps"), "exit_code": extra.get("exit_code"), "tokens_in": r["prompt_tokens"],
            "tokens_out": r["output_tokens"], "api_calls": r["model_calls"], "tool_calls": extra.get("tool_calls"),
            "tool_errors": extra.get("tool_errors"), "tool_used_pct": mt.get("tool_used_pct"), "answer_chars": r["answer_chars"],
            "checks": checks.get(r["id"], []), "failure_types": extra.get("failure_types", []), "leftovers": extra.get("leftovers", []),
            "notes": extra.get("notes", ""), "transcript": tp[len(prefix):] if tp and tp.startswith(prefix) else tp,
        })
    con.close()
    return {"started_at": run["started_at"], "finished_at": run["finished_at"], "aborted": meta.get("aborted"),
            "abort_reason": meta.get("abort_reason"), "benchmarks": benches}


def main(run_dir, db_path=None, run_name=None):
    run_dir = Path(run_dir)
    if db_path:
        data = load_from_db(db_path, run_name or run_dir.name)
        stdin = sys.stdin.read().strip()
        data.update(json.loads(stdin) if stdin else {"aggregates": [], "rankings": {}})
    else:
        data = json.loads((run_dir / "results.json").read_text())
    agg = data.get("aggregates", [])
    wb = Workbook()
    used = set()

    ws = wb.active
    ws.title = sheet_title("Summary", used)
    ws["A1"] = f"Benchmark run {run_dir.name}"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = f"Started {data.get('started_at')} - finished {data.get('finished_at') or '(partial)'}"
    if data.get("aborted"):
        ws["A3"] = f"ABORTED: {data.get('abort_reason')}"
        ws["A3"].font = Font(bold=True, color="C00000")
    headers = ["Benchmark", "Model", "Cron score", "Chat score", "Chat case score", "Speed score", "Score (all)", "Cases", "Passed",
               "Pass %", "Chat median s", "Median s", "Decode tok/s", "Prompt tok/s", "Model calls", "Tokens in", "Tokens out",
               "Tool calls", "Load s", "Load status", "Peak VRAM °C", "Peak VRAM GiB", "Chat disqualified"]
    order = sorted(agg, key=lambda a: (a["benchmark"], -((a.get("cron_score") or 0) + (a.get("chat_score") or 0))))
    rows = [[a["benchmark"], a["model"], a.get("cron_score"), a.get("chat_score"), a.get("chat_case_score"), a.get("speed_score"),
             a.get("score"), a["cases"], a["passed"], a["pass_rate"], a.get("chat_median_s"), a["median_duration_s"],
             a.get("median_decode_tps"), a.get("median_prompt_tps"), a["api_calls"], a["tokens_in"], a["tokens_out"],
             a["tool_calls"], a["load_s"], a["load_status"], a["gpu_peak_mem_c"], a["gpu_peak_vram_gib"],
             a.get("chat_disqualified") or ""] for a in order]
    hdr = 5
    last = write_table(ws, hdr, headers, rows)
    ws.freeze_panes = "C6"
    autosize(ws)
    if rows:
        ch = BarChart()
        ch.type = "col"
        ch.title = "Score per model"
        ch.y_axis.title = "score (0-100)"
        ch.height, ch.width = 10, 24
        for col in (3, 4):
            ch.add_data(Reference(ws, min_col=col, min_row=hdr, max_row=last), titles_from_data=True)
        ch.set_categories(Reference(ws, min_col=2, min_row=hdr + 1, max_row=last))
        ch.y_axis.scaling.min = 0
        ch.y_axis.scaling.max = 100
        ch.y_axis.delete = False
        ch.x_axis.delete = False
        ws.add_chart(ch, f"A{last + 3}")
        r = last + 25
        ws.cell(row=r, column=1, value="Recommendation").font = Font(bold=True, size=12)
        for bench, rk in (data.get("rankings") or {}).items():
            r += 1
            rec = rk.get("recommend", {})
            ws.cell(row=r, column=1, value=bench)
            ws.cell(row=r, column=2, value=f"Cron: best {rec.get('cron', {}).get('best')}, runner-up {rec.get('cron', {}).get('runner_up')}")
            r += 1
            ws.cell(row=r, column=2, value=f"Chat: best {rec.get('chat', {}).get('best')}, runner-up {rec.get('chat', {}).get('runner_up')}")
            for x in rk.get("chat", []):
                if x.get("disqualified"):
                    r += 1
                    ws.cell(row=r, column=2, value=f"Disqualified for chat: {x['model']}: {x['disqualified'][:300]}")
        r += 2
        ws.cell(row=r, column=1, value="Scoring: completed 15 + correctness 50 + rules 20 per case, normalised to 100; failed completed caps at 25, failed correct at 50; "
                                     "timeout/error = 0. Chat score = 0.75 x chat case score + 0.25 x speed score (100 at fastest median, 0 at 5x).")

    for b in data.get("benchmarks", []):
        bws = wb.create_sheet(sheet_title(b["name"], used))
        bws["A1"] = b["name"]
        bws["A1"].font = Font(bold=True, size=14)
        bws["A2"] = b.get("description", "")
        rows_a = sorted([a for a in agg if a["benchmark"] == b["name"]], key=lambda a: (-a["pass_rate"], a["median_duration_s"] or 1e9))
        ftypes = sorted({t for a in rows_a for t in a["failures"]})
        headers = ["Model", "Cases", "Passed", "Pass %", "Median s", "Tokens in", "Tokens out", "Tool calls", "Score"] + ftypes
        table = [[a["model"], a["cases"], a["passed"], a["pass_rate"], a["median_duration_s"] or 0, a["tokens_in"], a["tokens_out"], a["tool_calls"], a.get("score") or 0]
                 + [a["failures"].get(t, 0) for t in ftypes] for a in rows_a]
        hdr = 4
        last = write_table(bws, hdr, headers, table)
        first = hdr + 1
        bws.freeze_panes = bws.cell(row=hdr + 1, column=2)
        autosize(bws)
        if table:
            anchor_row = last + 3
            bws.add_chart(bar("Pass rate per model", "%", bws, 1, [4], first, last), f"A{anchor_row}")
            bws.add_chart(bar("Median duration per case", "seconds", bws, 1, [5], first, last), f"K{anchor_row}")
            bws.add_chart(bar("Tokens per model", "tokens", bws, 1, [6, 7], first, last), f"A{anchor_row + 20}")
            bws.add_chart(bar("Score per model", "score", bws, 1, [9], first, last), f"U{anchor_row}")
            if ftypes:
                cols = list(range(10, 10 + len(ftypes)))
                bws.add_chart(bar("Failures by type per model", "count", bws, 1, cols, first, last, stacked=True), f"K{anchor_row + 20}")

    cws = wb.create_sheet(sheet_title("Cases", used))
    check_names = []
    for b in data.get("benchmarks", []):
        for r in b.get("results", []):
            for c in r.get("checks", []):
                if c["name"] not in check_names:
                    check_names.append(c["name"])
    headers = ["Benchmark", "Model", "Case", "Group", "Kind", "Repeat", "Status", "Score", "Duration s", "Decode tok/s", "Exit", "Tokens in",
               "Tokens out", "API calls", "Tool calls", "Tool errors", "Tool used %", "Answer chars"] + check_names + [
               "Failed checks", "All checks", "Failure types", "Leftovers", "Notes", "Transcript"]
    rows = []
    for b in data.get("benchmarks", []):
        for r in b.get("results", []):
            failed = "; ".join(f"{c['name']}: {c.get('reason', '')}" for c in r.get("checks", []) if c.get("pass") is False)
            by = {c["name"]: c for c in r.get("checks", [])}
            marks = [("PASS" if by[n]["pass"] else ("n/a" if by[n]["pass"] is None else "FAIL")) if n in by else "" for n in check_names]
            allc = "; ".join(f"{c['name']}[{c.get('category', '')}]={'n/a' if c.get('pass') is None else ('PASS' if c['pass'] else 'FAIL')} ({c.get('reason', '')})"
                             for c in r.get("checks", []))
            rows.append([b["name"], r.get("model"), r.get("case_id"), r.get("group"), r.get("kind"), r.get("repeat"), r.get("status"),
                         r.get("score"), r.get("duration_s"), r.get("decode_tps"), r.get("exit_code"), r.get("tokens_in"), r.get("tokens_out"),
                         r.get("api_calls"), r.get("tool_calls"), r.get("tool_errors"), r.get("tool_used_pct", (r.get("metrics") or {}).get("tool_used_pct")),
                         r.get("answer_chars")] + marks + [
                         failed[:2000], allc[:4000], ", ".join(r.get("failure_types", [])), "; ".join(r.get("leftovers", []))[:1000],
                         (r.get("notes") or "")[:1000], r.get("transcript")])
    write_table(cws, 1, headers, rows)
    for i in range(2, len(rows) + 2):
        st = cws.cell(row=i, column=7)
        st.fill = PASS_FILL if st.value == "pass" else FAIL_FILL
        for j in range(19, 19 + len(check_names)):
            c = cws.cell(row=i, column=j)
            if c.value == "PASS":
                c.fill = PASS_FILL
            elif c.value == "FAIL":
                c.fill = FAIL_FILL
    cws.freeze_panes = "D2"
    cws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"
    autosize(cws)

    out = run_dir / "report.xlsx"
    wb.save(out)
    print(out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Export a benchmark run to report.xlsx")
    ap.add_argument("run_dir")
    ap.add_argument("--db", help="SQLite database (source of truth); aggregates JSON on stdin")
    ap.add_argument("--run", help="run name in the database (default: run_dir basename)")
    a = ap.parse_args()
    main(a.run_dir, a.db, a.run)
