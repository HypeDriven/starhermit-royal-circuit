/**
 * platform.js — host/platform adapter (StarHermit-style).
 *
 * - Hosted mode activates iff a launch token was read from the URL fragment
 *   (`#game_token=<jwt>`); the fragment is stripped immediately and the token
 *   is never persisted. Query-param fallbacks exist for local dev only.
 *   The JWT payload (base64url decode, no verify) carries `sub` (user id)
 *   and `game_scope` (this game's slug); the slug is never hard-coded.
 * - Authenticated REST uses `Authorization: Bearer <token>` on every call;
 *   scoped tokens are re-minted every 45 min via
 *   POST /api/v1/games/{slug}/launch-token (retry ~60 s on failure).
 * - Identity: GET /api/v1/users/{sub}/profile → nickname (never /api/v1/me,
 *   never usernames; fallback "Player " + sub.slice(0,8)).
 * - Cloud save mirrors the local save document (zip+base64) to
 *   /api/v1/me/cloud-saves/{slug}; localStorage stays the offline cache and
 *   remote wins on conflict. Saves are debounced 2 s and flushed on
 *   pagehide/visibilitychange; sync status is surfaced via onSyncChange.
 * - Leaderboards are read-only on-platform (script-owned); personal-best
 *   records stay local + cloud-saved.
 * - Local dev server (server.js): when no token is present, the adapter still
 *   syncs clocks with GET /api/v1/time and may use the game's own /ws room
 *   relay and /api/v1 telemetry sink. None of those own-server routes are
 *   called in hosted mode, so nothing fabricated runs on-platform.
 * - Telemetry: anonymous funnel events only (start, tutorial step, round
 *   end, retry, settings change, error category), consent-gated.
 */

const REFRESH_MS = 45 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
const CLOUD_DEBOUNCE_MS = 2000;

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

function decodeJwtPayload(token) {
  const seg = token.split('.')[1] || '';
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  return JSON.parse(atob(b64 + pad));
}

export class Platform {
  constructor() {
    this.hosted = false;       // true iff a launch token was read (platform-hosted)
    this.localServer = false;  // true when the game's own dev server answers /api/v1/time
    this.timeOffsetMs = 0;
    this.token = null;
    this.sub = null;
    this.slug = null;
    this.nickname = null;
    this.profileCache = new Map();
    this.launchScope = null;
    this.refreshTimer = null;
    this.ws = null;
    this.handlers = {};
    this.seq = 0;
    this.pending = new Map();
    this.heartbeat = null;
    this.consented = false;
    this.funnel = [];
    this.syncStatus = 'offline'; // offline | synced | saving | error
    this.onSyncChange = null;
    this.cloudTimer = null;
    this.cloudPending = null;
    this.flushing = null;
  }

  /** Read the launch token (fragment first, query fallback for local dev),
   *  strip it, decode scope, sync time with the local dev server, and
   *  schedule token refresh. */
  async init() {
    this.readLaunchToken();
    if (this.token) {
      this.hosted = true;
      this.scheduleRefresh();
      window.addEventListener('pagehide', () => this.flushCloudSave());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushCloudSave();
      });
    }
    // Clock sync uses the local dev server's own route; on-platform there is
    // no /api/v1/time, so hosted mode keeps device time and stays quiet.
    if (!this.hosted) {
      try {
        const t0 = performance.now();
        const res = await fetch('/api/v1/time', { cache: 'no-store' });
        const rtt = performance.now() - t0;
        if (res.ok) {
          const body = await res.json();
          if (body && body.epochMs) {
            const serverNow = body.epochMs + rtt / 2;
            this.timeOffsetMs = serverNow - Date.now();
            this.localServer = true;
          }
        }
      } catch { /* offline: local time */ }
    }
    return this;
  }

  /** Read `#game_token=<jwt>` (once, then strip) or dev query fallbacks. */
  readLaunchToken() {
    const onPlatform = /(^|\.)starhermit\.com$/i.test(location.hostname);
    let token = null;
    if (location.hash) {
      const frag = new URLSearchParams(location.hash.slice(1));
      token = frag.get('game_token') || null;
      if (token) {
        frag.delete('game_token');
        const rest = frag.toString();
        history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
      }
    }
    // Query fallbacks are for the local dev server only, never on-platform.
    if (!token && !onPlatform) {
      const params = new URLSearchParams(location.search);
      token = params.get('launch_token') || params.get('token');
    }
    if (!token) return;
    try {
      const payload = decodeJwtPayload(token);
      this.token = token;
      this.sub = payload.sub || null;
      this.slug = payload.game_scope || payload.scope || null;
      this.launchScope = { game: this.slug, sub: this.sub };
    } catch { this.token = null; this.launchScope = null; }
  }

  /** Platform-synchronized now(). */
  now() { return Date.now() + this.timeOffsetMs; }

  setConsent(ok) { this.consented = !!ok; }

  authHeaders(extra = {}) {
    return this.token ? { ...extra, authorization: `Bearer ${this.token}` } : extra;
  }

  /** Authenticated JSON GET; returns null on any failure. */
  async apiGet(path) {
    if (!this.token) return null;
    try {
      const res = await fetch(path, { headers: this.authHeaders(), cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /* ---------------- identity ---------------- */

  /** Account nickname for a user id; "Player "+id8 fallback, never usernames. */
  async profileFor(userId) {
    if (!userId || !this.token) return null;
    if (this.profileCache.has(userId)) return this.profileCache.get(userId);
    const p = await this.apiGet(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
    const nick = (p && p.nickname) || `Player ${String(userId).slice(0, 8)}`;
    this.profileCache.set(userId, nick);
    return nick;
  }

  /** The signed-in player's display name (null when local). */
  async fetchNickname() {
    if (!this.hosted || !this.sub) return null;
    this.nickname = await this.profileFor(this.sub);
    return this.nickname;
  }

  /* ---------------- token refresh (45-min schedule, ~60 s retry) ---------------- */

  scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshToken(), REFRESH_MS);
  }

  async refreshToken() {
    if (!this.token || !this.slug) return;
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(this.slug)}/launch-token`, {
        method: 'POST',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
      });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const next = body && (body.token || body.launchToken || (body.launch_token));
        if (next) this.token = next;
        this.scheduleRefresh();
        return;
      }
    } catch { /* fall through to retry */ }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refreshToken(), REFRESH_RETRY_MS);
  }

  /* ---------------- cloud save (mirror of the local save document) ---------------- */

  setSyncStatus(status) {
    if (this.syncStatus === status) return;
    this.syncStatus = status;
    this.onSyncChange?.(status);
  }

  /** Remote save document (parsed), or null when none/unsupported. */
  async cloudLoad() {
    if (!this.token || !this.slug) return null;
    try {
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        headers: this.authHeaders(), cache: 'no-store',
      });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const raw = new TextDecoder().decode(unzipFirstEntry(bytes));
      return JSON.parse(raw);
    } catch { return null; }
  }

  async cloudPut(save) {
    if (!this.token || !this.slug) return false;
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(save));
      const body = JSON.stringify({ dataBase64: bytesToBase64(zipStore('save.json', bytes)) });
      const res = await fetch(`/api/v1/me/cloud-saves/${encodeURIComponent(this.slug)}`, {
        method: 'PUT',
        headers: this.authHeaders({ 'content-type': 'application/json' }),
        body,
      });
      return res.ok;
    } catch { return false; }
  }

  /** Debounced cloud mirror (2 s); call on every local persist. */
  queueCloudSave(save) {
    if (!this.hosted) return;
    this.cloudPending = save;
    this.setSyncStatus('saving');
    if (this.cloudTimer) clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => this.flushCloudSave(), CLOUD_DEBOUNCE_MS);
  }

  /** Push any pending save immediately (pagehide / visibilitychange). */
  flushCloudSave() {
    if (!this.hosted) return Promise.resolve();
    if (this.cloudTimer) { clearTimeout(this.cloudTimer); this.cloudTimer = null; }
    if (this.flushing) return this.flushing;
    if (!this.cloudPending) return Promise.resolve();
    const doc = this.cloudPending;
    this.cloudPending = null;
    this.setSyncStatus('saving');
    this.flushing = this.cloudPut(doc)
      .then((ok) => this.setSyncStatus(ok ? 'synced' : 'error'))
      .catch(() => this.setSyncStatus('error'))
      .finally(() => {
        this.flushing = null;
        if (this.cloudPending) this.flushCloudSave(); // a save arrived mid-flight
      });
    return this.flushing;
  }

  /* ---------------- leaderboards (read-only on-platform) ---------------- */

  /** Global board entries with nicknames resolved, or null when unavailable. */
  async fetchGlobalBoard() {
    if (!this.hosted || !this.slug) return null;
    const game = await this.apiGet(`/api/v1/games/${encodeURIComponent(this.slug)}`);
    const leaderboardId = game && game.leaderboardId;
    if (!leaderboardId) return null;
    const data = await this.apiGet(
      `/api/v1/leaderboards/${encodeURIComponent(leaderboardId)}/entries?page=1&pageSize=20`,
    );
    if (!data) return null;
    const raw = Array.isArray(data) ? data : (data.entries || []);
    const entries = [];
    for (const e of raw.slice(0, 20)) {
      const userId = e.userId ?? e.user_id ?? e.sub;
      const name = await this.profileFor(userId).catch(() => null) || 'Player';
      entries.push({
        rank: e.rank ?? e.place ?? entries.length + 1,
        name,
        score: e.score ?? e.value ?? 0,
      });
    }
    return entries;
  }

  /* ---------------- telemetry (consent-gated; local dev server sink only) ---------------- */

  /** Anonymous funnel event; kept local unless consented + the own dev
   *  server is present. Never sent to the platform (no such route). */
  track(event, props = {}) {
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!allowed.includes(event)) return;
    const rec = { event, props: sanitize(props), t: Math.round(this.now() / 1000) };
    this.funnel.push(rec);
    if (this.consented && this.localServer && !this.hosted) {
      fetch('/api/v1/telemetry', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rec),
      }).catch(() => {});
    }
  }

  /* ---------------- hosted play (WebSocket rooms, local dev server only) ---------------- */

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

export const _zip = { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };

function sanitize(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 40 && !/[@\s]/.test(v)) out[k] = v;
  }
  return out;
}
