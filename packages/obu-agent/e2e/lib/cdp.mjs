// Minimal raw-CDP client over the browser's --remote-debugging-port (Node >= 22 global WebSocket).
// Used ONLY by the harness for things the daemon must not be trusted with: fixture
// self-tests, the focus-theft sentinel, and ground-truth assertions. Never used to act.
export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return r.json();
}

export async function browserWsUrl(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).webSocketDebuggerUrl;
}

export class Cdp {
  #ws; #id = 0; #pending = new Map(); #listeners = new Set();
  static async connect(wsUrl) {
    const c = new Cdp();
    c.#ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { c.#ws.onopen = res; c.#ws.onerror = (e) => rej(new Error(`cdp connect failed: ${e.message ?? wsUrl}`)); });
    c.#ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString());
      if (msg.id !== undefined) {
        const p = c.#pending.get(msg.id); if (!p) return; c.#pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
      } else {
        if (msg.method === "Target.detachedFromTarget") {
          for (const [id, p] of c.#pending) if (p.sessionId === msg.params.sessionId) { c.#pending.delete(id); p.reject(new Error(`${p.method}: target detached`)); }
        }
        for (const l of c.#listeners) l(msg);
      }
    };
    c.#ws.onclose = () => { for (const p of c.#pending.values()) p.reject(new Error("cdp socket closed")); c.#pending.clear(); };
    return c;
  }
  send(method, params = {}, sessionId, timeoutMs = 20_000) {
    const id = ++this.#id;
    this.#ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method}: cdp timeout ${timeoutMs} ms`)); }, timeoutMs);
      const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
      this.#pending.set(id, { resolve: done(resolve), reject: done(reject), method, sessionId });
    });
  }
  on(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }
  waitFor(pred, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error("cdp waitFor timeout")); }, timeoutMs);
      const off = this.on((m) => { if (pred(m)) { clearTimeout(t); off(); resolve(m); } });
    });
  }
  close() { try { this.#ws.close(); } catch {} }
}

/** Open a page session on the browser connection; returns helpers bound to it. */
export async function attachPage(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { sessionId, evaluate, send: (m, p) => cdp.send(m, p, sessionId), detach: () => cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {}) };
}
