'use strict';
// Thin wrapper around the Docker CLI (talks to the mounted host socket).
const { spawn } = require('node:child_process');

/**
 * Run `docker <args>` and capture output.
 * @param {string[]} args
 * @param {{timeoutMs?: number, input?: string, maxBytes?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean, ms: number}>}
 */
function docker(args, opts = {}) {
  const { timeoutMs = 60_000, input, maxBytes = 20 * 1024 * 1024, signal } = opts;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const add = (buf, which) => {
      const text = buf.toString('utf8');
      if (which === 'out') { if (stdout.length < maxBytes) stdout += text; } else if (stderr.length < maxBytes) stderr += text;
    };
    child.stdout.on('data', (b) => add(b, 'out'));
    child.stderr.on('data', (b) => add(b, 'err'));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, timedOut, ms: Date.now() - started });
    };
    child.on('error', (err) => { stderr += String(err); finish(-1); });
    child.on('close', (code) => finish(code));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** `docker exec [opts] <container> <cmd...>` */
function dockerExec(container, cmd, opts = {}) {
  const args = ['exec'];
  if (opts.input !== undefined) args.push('-i');
  if (opts.user) args.push('-u', opts.user);
  for (const [k, v] of Object.entries(opts.env || {})) args.push('-e', `${k}=${v}`);
  args.push(container, ...cmd);
  return docker(args, opts);
}

module.exports = { docker, dockerExec };
