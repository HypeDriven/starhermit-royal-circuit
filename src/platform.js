/**
 * platform.js — host/platform adapter (StarHermit-style).
 *
 * - Reads launch scope from the launch token when hosted; never persists
 *   tokens. Same-origin /api and /ws routes are used when available.
 * - Synchronizes clock with GET /api/v1/time using round-trip adjustment.
 * - When no host is present (plain static hosting / file://), every
 *   capability degrades to a local implementation and hosted play UI shows
 *   a clear offline state instead of failing.
 * - Telemetry: anonymous funnel events only (start, tutorial step, round
 *   end, retry, settings change, error category), consent-gated.
 */

export class Platform {
  constructor() {
    this.hosted = false;
    this.timeOffsetMs = 0;
    this.launchScope = null;
    this.ws = null;
    this.handlers = {};
    this.seq = 0;
    this.pending = new Map();
    this.heartbeat = null;
    this.consented = false;
    this.funnel = [];
  }

  /** Detect host, sync time, read launch token scope. */
  async init() {
    const params = new URLSearchParams(location.search);
    const token = params.get('launch_token');
    if (token) {
      // scope is carried in the token payload segment (JWT-style); we never
      // persist it, and tolerate undecodable tokens by staying local.
      try {
        const payload = JSON.parse(atob(token.split('.')[1] || ''));
        this.launchScope = { game: payload.game || payload.scope || null };
      } catch { this.launchScope = null; }
    }
    try {
      const t0 = performance.now();
      const res = await fetch('/api/v1/time', { cache: 'no-store' });
      const rtt = performance.now() - t0;
      if (res.ok) {
        const body = await res.json();
        if (body && body.epochMs) {
          const serverNow = body.epochMs + rtt / 2;
          this.timeOffsetMs = serverNow - Date.now();
          this.hosted = true;
        }
      }
    } catch { /* offline: local time */ }
    return this;
  }

  /** Platform-synchronized now(). */
  now() { return Date.now() + this.timeOffsetMs; }

  setConsent(ok) { this.consented = !!ok; }

  /** Anonymous funnel event; kept local unless consented + hosted. */
  track(event, props = {}) {
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
    const rec = { event, props: sanitize(props), t: Math.round(this.now() / 1000) };
    this.funnel.push(rec);
    if (this.consented && this.hosted) {
      fetch('/api/v1/telemetry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
      }).catch(() => {});
    }
  }

  /* ---------------- hosted play (WebSocket rooms) ---------------- */

  /** Connect to the hosted session relay. Resolves false when unavailable. */
  connect() {
    if (this.ws) return Promise.resolve(true);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws`;
    return new Promise((resolve) => {
      let settled = false;
      try {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          if (!settled) { settled = true; try { ws.close(); } catch {} resolve(false); }
        }, 4000);
        ws.onopen = () => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          this.ws = ws;
          this.startHeartbeat();
          resolve(true);
        };
        ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(false); } };
        ws.onclose = () => { this.ws = null; this.stopHeartbeat(); this.emit('closed', {}); };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.replyTo && this.pending.has(msg.replyTo)) {
            const { resolve: res } = this.pending.get(msg.replyTo);
            this.pending.delete(msg.replyTo);
            res(msg);
            return;
          }
          this.emit(msg.t, msg);
        };
      } catch { resolve(false); }
    });
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); return this; }
  emit(type, msg) { (this.handlers[type] || []).forEach((fn) => fn(msg)); }

  send(msg, expectReply = true) {
    if (!this.ws) return Promise.resolve({ t: 'error', error: 'offline' });
    const id = `c${++this.seq}`;
    const payload = { ...msg, id };
    if (!expectReply) { this.ws.send(JSON.stringify(payload)); return Promise.resolve(null); }
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); resolve({ t: 'error', error: 'timeout' }); }
      }, 8000);
      this.ws.send(JSON.stringify(payload));
    });
  }

  createRoom(opts) { return this.send({ t: 'create', ...opts }); }
  joinRoom(code, name, seatToken) { return this.send({ t: 'join', code, name, seatToken }); }
  startRoom(code) { return this.send({ t: 'start', code }); }
  leaveRoom(code) { return this.send({ t: 'leave', code }); }
  sendCommand(code, command) { return this.send({ t: 'command', code, command }); }
  listPublic() { return this.send({ t: 'list' }); }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => { this.send({ t: 'ping' }, false); }, 25000);
  }
  stopHeartbeat() { if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; } }

  disconnect() {
    this.stopHeartbeat();
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
  }
}

function sanitize(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 40 && !/[@\s]/.test(v)) out[k] = v;
  }
  return out;
}
