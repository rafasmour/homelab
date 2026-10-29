"""Webhook runner for n8n/scripts/check-workflow-drift.sh.

POST /run with "Authorization: Bearer <N8N_DRIFT_WEBHOOK_SECRET>" starts one
drift check. The request body is never parsed or used: the script runs with a
fixed argument list and a fixed, minimal environment, so nothing a caller (or
Grafana's alert payload) sends reaches it. One run at a time and at least
MIN_INTERVAL seconds between starts; extra requests are acknowledged and
skipped. One log line per run.
"""
import hmac
import os
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("N8N_DRIFT_WEBHOOK_SECRET", "")
MIN_INTERVAL = int(os.environ.get("N8N_DRIFT_MIN_INTERVAL", "300"))
TIMEOUT = int(os.environ.get("N8N_DRIFT_RUN_TIMEOUT", "120"))
SCRIPT = "/app/check-workflow-drift.sh"
SCRIPT_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "N8N_API_URL": os.environ.get("N8N_API_URL", "http://n8n:5678"),
    "N8N_DRIFT_API_KEY": os.environ.get("N8N_DRIFT_API_KEY", ""),
    "N8N_WORKFLOWS_DIR": "/workflows",
    "N8N_TEXTFILE_DIR": "/textfile",
    "N8N_DRIFT_AUTO_EXPORT": os.environ.get("N8N_DRIFT_AUTO_EXPORT", "1"),
    "TMPDIR": "/tmp",
}

state_lock = threading.Lock()
running = False
last_start = None  # time.monotonic() of the last accepted run


def log(msg):
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}", flush=True)


def run_check():
    global running
    started = time.monotonic()
    try:
        proc = subprocess.run(
            [SCRIPT], env=SCRIPT_ENV, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, timeout=TIMEOUT, check=False,
        )
        out = (proc.stdout or proc.stderr).strip().splitlines()
        summary = out[0][:200] if out else ""
        result = "ok" if proc.returncode == 0 else "failed"
        log(f"run {result} rc={proc.returncode} {time.monotonic() - started:.1f}s {summary}")
    except subprocess.TimeoutExpired:
        log(f"run timeout after {TIMEOUT}s")
    except Exception as exc:  # never let a run kill the server
        log(f"run error {type(exc).__name__}")
    finally:
        with state_lock:
            running = False


class Handler(BaseHTTPRequestHandler):
    server_version = "n8n-drift-runner"
    protocol_version = "HTTP/1.0"

    def log_message(self, *_args):  # access log is replaced by run lines
        pass

    def _reply(self, code, text):
        body = (text + "\n").encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._reply(200, "ok")
        else:
            self._reply(404, "not found")

    def do_POST(self):
        global running, last_start
        if self.path != "/run":
            self._reply(404, "not found")
            return
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {SECRET}"
        if not SECRET or not hmac.compare_digest(header.encode(), expected.encode()):
            log("rejected: bad or missing bearer token")
            self._reply(401, "unauthorized")
            return
        # The body is ignored; HTTP/1.0 closes the connection, so it need not be read.
        with state_lock:
            now = time.monotonic()
            if running:
                log("skipped: a run is in progress")
                self._reply(200, "skipped: run in progress")
                return
            if last_start is not None and now - last_start < MIN_INTERVAL:
                log(f"skipped: last run started {now - last_start:.0f}s ago (minimum {MIN_INTERVAL}s)")
                self._reply(200, "skipped: rate limited")
                return
            running = True
            last_start = now
        threading.Thread(target=run_check, daemon=True).start()
        self._reply(202, "started")


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("N8N_DRIFT_WEBHOOK_SECRET is empty")
    log(f"listening on :8791, min interval {MIN_INTERVAL}s")
    ThreadingHTTPServer(("0.0.0.0", 8791), Handler).serve_forever()
