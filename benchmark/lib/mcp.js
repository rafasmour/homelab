'use strict';
// Minimal streamable-HTTP MCP client: initialize, notifications/initialized, tools/call.
let nextId = 1;

function parseBody(text) {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    try {
      const msg = JSON.parse(line.slice(5).trim());
      if (msg && (msg.result !== undefined || msg.error !== undefined)) last = msg;
    } catch { /* partial or keep-alive */ }
  }
  return last;
}

class McpClient {
  constructor(url, { token, timeoutMs = 120_000 } = {}) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
  }
  async post(body) {
    const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const text = await res.text();
    if (!res.ok && res.status !== 202) throw new Error(`MCP ${this.url} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return body.id === undefined ? null : parseBody(text);
  }
  async init() {
    if (this.ready) return;
    const r = await this.post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'homelab-benchmark', version: '1.0.0' } } });
    if (!r || r.error) throw new Error(`MCP initialize failed: ${JSON.stringify(r && r.error)}`);
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
  }
  /** Call a tool; returns parsed JSON payload (structuredContent or JSON text) or raw text. */
  async call(name, args = {}) {
    await this.init();
    const r = await this.post({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } });
    if (!r) throw new Error(`MCP ${name}: empty response`);
    if (r.error) throw new Error(`MCP ${name}: ${JSON.stringify(r.error).slice(0, 300)}`);
    const res = r.result || {};
    const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (res.isError) throw new Error(`MCP ${name} error: ${text.slice(0, 300)}`);
    if (res.structuredContent !== undefined) {
      const sc = res.structuredContent;
      return sc && Object.keys(sc).length === 1 && sc.result !== undefined ? sc.result : sc;
    }
    try { return JSON.parse(text); } catch { return text; }
  }
}

module.exports = { McpClient };
