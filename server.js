/**
 * server.js — Royal Circuit authoritative host (zero-dependency Node ESM).
 *
 * Three jobs:
 *   1. Static hosting of the client (index.html, styles.css, src/, vendor/,
 *      docs/, assets/, sfx/) with traversal protection and sane cache headers.
 *   2. REST: GET /api/v1/time (clock sync), POST /api/v1/telemetry (drop).
 *   3. WebSocket /ws: hosted rooms whose game truth comes ONLY from
 *      src/rules.js running here on the server.
 *
 * TRUST BOUNDARIES (the point of this file):
 *   - Clients are untrusted. The server never accepts client clocks, dice,
 *     scores or winners; every state transition is computed by src/rules.js.
 *   - The RNG seed is generated server-side at game start. `seed` and
 *     `forcedRolls` in client ruleset requests are stripped (sanitizeRuleset).
 *   - A connection is bound to (room, seat) at create/join. Commands apply
 *     under the BOUND seat; the seat field inside a client command is ignored.
 *   - A rejected (illegal) command is NOT committed: rules.applyCommand's
 *     invalid-attempt bookkeeping state is discarded so one client's garbage
 *     cannot tick the shared game forward.
 *   - seatToken (random UUID) authenticates reconnects. It is sent only to
 *     the connection owning the seat; public views carry `seatTokenPresent`.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGame,
  applyCommand,
  rankPlayers,
  scoreBreakdown,
  normalizeRuleset,
} from './src/rules.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8777;
const MAX_MSG = 64 * 1024; // max WebSocket message / telemetry body (bytes)
const RATE_PER_SEC = 20; // per-connection token bucket
const RATE_STRIKES = 5; // violations before the socket is closed
const EVENT_LOG_CAP = 500;
const ABANDON_MS = 5 * 60 * 1000; // disconnect -> remove (lobby) / auto-resign (game)
const GAMEOVER_SWEEP_MS = 10 * 60 * 1000; // finished rooms stay joinable this long
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const COMMAND_TYPES = new Set(['roll', 'move', 'pass', 'resign']);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/* ------------------------------------------------------------------ */
/* Static hosting + REST                                               */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.opus': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

// The client (index.html / render.js / audio.js) ships later; until it
// exists, serve a minimal placeholder so the launcher entry point answers.
const PLACEHOLDER_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Royal Circuit</title></head><body style="font-family:system-ui;' +
  'background:#14110f;color:#e8ded0;display:grid;place-items:center;min-height:100vh">' +
  '<main><h1>Royal Circuit</h1><p>Host is up — the game client has not been ' +
  'installed in this directory yet.</p></main></body></html>';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function handleHttp(req, res) {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return sendJson(res, 400, { error: 'bad-request' });
  }

  if (pathname === '/api/v1/time') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' });
    // Server clock is the only clock that matters (round-trip sync anchor).
    return sendJson(res, 200, { epochMs: Date.now(), iso: new Date().toISOString() });
  }
  if (pathname === '/api/v1/telemetry') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' });
    // Accept and drop: telemetry is fire-and-forget, never trusted, never stored.
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
    });
    req.on('end', () => {
      if (size > MAX_MSG) return sendJson(res, 413, { error: 'too-large' });
      res.writeHead(204);
      res.end();
    });
    req.on('error', () => res.destroy());
    return;
  }
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not-found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method-not-allowed' });
  }
  serveStatic(req, res, pathname);
}

function serveStatic(req, res, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'bad-path' });
  }
  if (p.includes('\0')) return sendJson(res, 400, { error: 'bad-path' });
  if (p === '/') p = '/index.html';

  // Path traversal protection: resolve and require containment under ROOT.
  const abs = path.resolve(ROOT, '.' + p);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const allowed =
    rel === 'index.html' ||
    rel === 'styles.css' ||
    rel === 'favicon.ico' ||
    rel === 'favicon.svg' ||
    rel === 'icon.png' ||
    /^(src|vendor|docs|assets|sfx)\//.test(rel);
  if (!allowed) return sendJson(res, 404, { error: 'not-found' });

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      if (rel === 'index.html') return sendPlaceholder(req, res);
      return sendJson(res, 404, { error: 'not-found' });
    }
    const ext = path.extname(abs).toLowerCase();
    const fingerprinted = /[.-][0-9a-f]{8,}\./i.test(path.basename(abs));
    const cache =
      ext === '.html'
        ? 'no-store'
        : rel.startsWith('vendor/') || fingerprinted
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cache,
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(abs)
      .on('error', () => res.destroy())
      .pipe(res);
  });
}

function sendPlaceholder(req, res) {
  const body = Buffer.from(PLACEHOLDER_HTML);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* WebSocket framing (RFC 6455, minimal but strict)                    */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const conns = new Set();

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendFrame(conn, op, payload) {
  if (conn.dead) return;
  try {
    conn.socket.write(encodeFrame(op, payload));
  } catch {
    cleanupConn(conn);
  }
}

function sendMsg(conn, obj) {
  sendFrame(conn, 0x1, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function closeWs(conn, code = 1000, reason = '') {
  if (conn.dead) return;
  try {
    const r = Buffer.from(reason.slice(0, 120));
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    conn.socket.write(encodeFrame(0x8, payload));
    conn.socket.end();
  } catch {
    /* socket already gone */
  }
  cleanupConn(conn);
}

function wsFail(code, reason) {
  const err = new Error(reason);
  err.wsCode = code;
  return err;
}

function onSocketData(conn, chunk) {
  conn.buf = conn.buf.length ? Buffer.concat([conn.buf, chunk]) : chunk;
  if (conn.buf.length > MAX_MSG + 16) return closeWs(conn, 1009, 'message too big');
  try {
    drainFrames(conn);
  } catch (err) {
    closeWs(conn, err.wsCode || 1002, err.message || 'protocol error');
  }
}

function drainFrames(conn) {
  for (;;) {
    const buf = conn.buf;
    if (buf.length < 2) return;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const op = b0 & 0x0f;
    if (b0 & 0x70) throw wsFail(1002, 'extensions not negotiated');
    if ((b1 & 0x80) === 0) throw wsFail(1002, 'client frames must be masked');
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_MSG)) throw wsFail(1009, 'message too big');
      len = Number(big);
      off = 10;
    }
    if (len > MAX_MSG) throw wsFail(1009, 'message too big');
    if (buf.length < off + 4 + len) return; // incomplete; wait for more data
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)); // copy
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    conn.buf = buf.subarray(off + 4 + len);
    handleFrame(conn, fin, op, payload);
    if (conn.dead) return;
  }
}

function handleFrame(conn, fin, op, payload) {
  if (op === 0x8) return closeWs(conn, 1000); // close
  if (op === 0x9) return sendFrame(conn, 0xa, payload); // ping -> pong
  if (op === 0xa) return; // pong
  if (op === 0x2) throw wsFail(1003, 'binary not supported');
  if (op !== 0x0 && op !== 0x1) throw wsFail(1002, 'bad opcode');

  // Minimal fragmentation support: buffer continuations until FIN.
  if (op === 0x1) {
    if (conn.fragOp) throw wsFail(1002, 'interleaved frame');
    if (fin) return onMessage(conn, decodeText(payload));
    conn.fragOp = 1;
    conn.frags = [payload];
    conn.fragLen = payload.length;
    return;
  }
  // op === 0x0 continuation
  if (!conn.fragOp) throw wsFail(1002, 'unexpected continuation');
  conn.frags.push(payload);
  conn.fragLen += payload.length;
  if (conn.fragLen > MAX_MSG) throw wsFail(1009, 'message too big');
  if (fin) {
    const whole = Buffer.concat(conn.frags);
    conn.fragOp = 0;
    conn.frags = [];
    conn.fragLen = 0;
    onMessage(conn, decodeText(whole));
  }
}

function decodeText(buf) {
  try {
    return utf8.decode(buf);
  } catch {
    throw wsFail(1007, 'invalid utf-8');
  }
}

function allowMessage(conn) {
  const now = Date.now();
  conn.bucket = Math.min(RATE_PER_SEC, conn.bucket + ((now - conn.bucketAt) * RATE_PER_SEC) / 1000);
  conn.bucketAt = now;
  if (conn.bucket < 1) return false;
  conn.bucket -= 1;
  return true;
}

/* ------------------------------------------------------------------ */
/* Rooms (in-memory authoritative state)                               */
/* ------------------------------------------------------------------ */

const rooms = new Map(); // code -> room

function makeCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
}

function publicPlayer(p) {
  return { seat: p.seat, name: p.name, connected: p.connected, seatTokenPresent: !!p.seatToken };
}

function publicRoom(room) {
  return {
    code: room.code,
    privacy: room.privacy,
    seats: room.seats,
    players: room.players.filter(Boolean).map(publicPlayer),
    started: room.started,
    hostSeat: room.hostSeat,
  };
}

/**
 * Client-visible view of authoritative state.
 *
 * TRUST: `state.rng` is a mulberry32 stream state and `ruleset.seed` seeds it,
 * so shipping either lets a client compute every future die roll before it
 * decides a move. Both are redacted here; clients never apply commands in
 * hosted play (the server is the only writer), so nothing they render or
 * evaluate — legal actions, hints, scores — needs the stream.
 */
function publicState(state) {
  if (!state) return state;
  const { rng, ruleset, ...rest } = state;
  const { seed, ...publicRuleset } = ruleset || {};
  return { ...rest, ruleset: publicRuleset };
}

function broadcast(room, obj) {
  for (const p of room.players) {
    if (p && p.conn && !p.conn.dead) sendMsg(p.conn, obj);
  }
}

function broadcastPresence(room) {
  broadcast(room, {
    t: 'presence',
    players: room.players.filter(Boolean).map(publicPlayer),
    hostSeat: room.hostSeat,
  });
}

/** Connected players have seen everything up to the current tick. */
function markSeen(room) {
  const tick = room.state ? room.state.tick : 0;
  for (const p of room.players) {
    if (p && p.connected) p.lastSeenTick = tick;
  }
}

function eventsSince(room, tick) {
  return room.eventLog
    .filter((e) => e.tick > tick)
    .flatMap((e) => e.events.map((ev) => ({ tick: e.tick, ...ev })));
}

/** Commit an applied command result: state, log, broadcast, maybe finish. */
function commitResult(room, res, commandId) {
  room.state = res.state;
  room.eventLog.push({ tick: res.state.tick, commandId, events: res.events });
  if (room.eventLog.length > EVENT_LOG_CAP) room.eventLog.shift();
  room.lastResult = { commandId, tick: res.state.tick, events: res.events };
  broadcast(room, { t: 'applied', snapshot: publicState(res.state), events: res.events });
  markSeen(room);
  if (res.state.phase === 'over') finishRoom(room);
}

function finishRoom(room) {
  // Results are computed here from authoritative state — never from clients.
  const st = room.state;
  room.results = rankPlayers(st).map((p, i) => ({
    rank: i + 1,
    seat: p.seat,
    name: p.name,
    resigned: p.resigned,
    score: scoreBreakdown(st, p.seat),
  }));
  broadcast(room, { t: 'result', results: room.results });
  room.finishedAt = Date.now();
  if (room.sweepTimer) clearTimeout(room.sweepTimer);
  room.sweepTimer = setTimeout(() => destroyRoom(room, 'gameover sweep'), GAMEOVER_SWEEP_MS);
  room.sweepTimer.unref?.();
  log(`[room ${room.code}] game over, winner seat ${st.winner} (${st.reason})`);
}

function destroyRoom(room, why) {
  if (!rooms.has(room.code)) return;
  if (room.sweepTimer) clearTimeout(room.sweepTimer);
  for (const p of room.players) {
    if (!p) continue;
    if (p.timer) clearTimeout(p.timer);
    if (p.conn && !p.conn.dead) {
      p.conn.binding = null;
      closeWs(p.conn, 1000, 'room closed');
    }
  }
  // Spectator connections (bound with seat null) are dropped too.
  for (const conn of conns) {
    if (conn.binding && conn.binding.code === room.code) {
      conn.binding = null;
      closeWs(conn, 1000, 'room closed');
    }
  }
  rooms.delete(room.code);
  log(`[room ${room.code}] dissolved (${why})`);
}

/** Fires ABANDON_MS after a player disconnects. */
function onAbandon(room, seat) {
  const p = room.players[seat];
  if (!p || p.connected) return;
  if (!room.started) {
    room.players[seat] = null;
    log(`[room ${room.code}] seat ${seat} (${p.name}) abandoned the lobby`);
    if (room.hostSeat === seat) {
      const next = room.players.find(Boolean);
      if (next) room.hostSeat = next.seat;
    }
    if (!room.players.some(Boolean)) return destroyRoom(room, 'abandoned lobby');
    broadcastPresence(room);
    return;
  }
  const st = room.state;
  if (!st || st.phase === 'over' || st.players[seat].resigned) return;
  // Server-issued resign on behalf of the vanished player.
  log(`[room ${room.code}] seat ${seat} (${p.name}) auto-resigned after 5min away`);
  const res = applyCommand(st, { id: 'srv-' + crypto.randomUUID(), seat, type: 'resign' });
  if (res.ok && !res.duplicate) commitResult(room, res, 'srv-resign-' + seat);
}

/* ------------------------------------------------------------------ */
/* Message validation + dispatch                                       */
/* ------------------------------------------------------------------ */

function validName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.length <= 24;
}

/** Keep only presentation-affecting ruleset knobs. Seed/forcedRolls stripped. */
function sanitizeRuleset(raw, seats) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ruleset must be an object');
  const out = {};
  for (const k of ['exactFinish', 'blockades', 'safeTrack', 'captures']) {
    if (k in raw) {
      if (typeof raw[k] !== 'boolean') throw new Error(`${k} must be boolean`);
      out[k] = raw[k];
    }
  }
  for (const k of ['floats', 'maxTurns']) {
    if (k in raw) {
      if (!Number.isInteger(raw[k]) || raw[k] < 0 || raw[k] > 10000) throw new Error(`bad ${k}`);
      out[k] = raw[k];
    }
  }
  normalizeRuleset({ ...out, players: seats }); // throws on invalid combinations
  return out;
}

function validCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.type !== 'string' || !COMMAND_TYPES.has(raw.type)) return null;
  if (raw.id == null || (typeof raw.id !== 'string' && typeof raw.id !== 'number')) return null;
  const id = String(raw.id);
  if (id.length < 1 || id.length > 64) return null;
  if (!Number.isInteger(raw.tick) || raw.tick < 0) return null; // hosted play requires tick
  const cmd = { id, tick: raw.tick, type: raw.type };
  if (raw.type === 'move') {
    if (!Number.isInteger(raw.floatId) || raw.floatId < 0 || raw.floatId > 3) return null;
    cmd.floatId = raw.floatId;
  }
  return cmd;
}

function fail(conn, replyTo, error) {
  sendMsg(conn, { t: 'error', error, replyTo });
}

function onMessage(conn, text) {
  if (!allowMessage(conn)) {
    sendMsg(conn, { t: 'error', error: 'rate-limit' });
    conn.strikes += 1;
    if (conn.strikes >= RATE_STRIKES) closeWs(conn, 1008, 'rate limit abuse');
    return;
  }
  conn.strikes = 0;

  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return fail(conn, undefined, 'bad-message');
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') {
    return fail(conn, undefined, 'bad-message');
  }
  // Every client message carries an id for RPC-style replies (ping tolerates none).
  const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
  if (msg.t !== 'ping' && (!hasId || String(msg.id).length > 64)) {
    return fail(conn, undefined, 'bad-message');
  }
  const replyTo = hasId ? msg.id : undefined;

  switch (msg.t) {
    case 'create': return handleCreate(conn, msg, replyTo);
    case 'join': return handleJoin(conn, msg, replyTo);
    case 'start': return handleStart(conn, msg, replyTo);
    case 'command': return handleCommand(conn, msg, replyTo);
    case 'leave': return handleLeave(conn, msg, replyTo);
    case 'list': return handleList(conn, replyTo);
    case 'ping': return sendMsg(conn, replyTo === undefined ? { t: 'pong' } : { t: 'pong', replyTo });
    default: return fail(conn, replyTo, 'bad-message');
  }
}

function handleCreate(conn, msg, replyTo) {
  if (conn.binding) return fail(conn, replyTo, 'already-in-room');
  if (!validName(msg.name)) return fail(conn, replyTo, 'bad-message');
  if (![2, 3, 4].includes(msg.seats)) return fail(conn, replyTo, 'bad-message');
  if (msg.privacy !== 'private' && msg.privacy !== 'public') return fail(conn, replyTo, 'bad-message');
  let rulesetOpts;
  try {
    rulesetOpts = sanitizeRuleset(msg.ruleset, msg.seats);
  } catch {
    return fail(conn, replyTo, 'bad-ruleset');
  }
  const code = makeCode();
  const room = {
    code,
    privacy: msg.privacy,
    seats: msg.seats,
    rulesetOpts,
    players: new Array(msg.seats).fill(null),
    hostSeat: 0,
    started: false,
    state: null,
    eventLog: [],
    lastResult: null,
    results: null,
    createdAt: Date.now(),
    finishedAt: null,
    sweepTimer: null,
  };
  const player = {
    seat: 0,
    name: msg.name.trim(),
    connected: true,
    seatToken: crypto.randomUUID(),
    conn,
    lastSeenTick: 0,
    timer: null,
  };
  room.players[0] = player;
  rooms.set(code, room);
  conn.binding = { code, seat: 0 };
  log(`[room ${code}] created by "${player.name}" (${msg.privacy}, ${msg.seats} seats)`);
  sendMsg(conn, { t: 'room', room: publicRoom(room), you: { seat: 0, seatToken: player.seatToken }, replyTo });
}

function handleJoin(conn, msg, replyTo) {
  if (conn.binding) return fail(conn, replyTo, 'already-in-room');
  if (!validName(msg.name)) return fail(conn, replyTo, 'bad-message');
  if (typeof msg.code !== 'string' || !CODE_RE.test(msg.code)) return fail(conn, replyTo, 'bad-message');
  const room = rooms.get(msg.code);
  if (!room) return fail(conn, replyTo, 'no-room');

  // Reconnect path: a seatToken proves ownership of a disconnected seat.
  if (msg.seatToken != null) {
    if (typeof msg.seatToken !== 'string' || msg.seatToken.length > 64) {
      return fail(conn, replyTo, 'bad-message');
    }
    const p = room.players.find((pl) => pl && pl.seatToken === msg.seatToken);
    if (!p) return fail(conn, replyTo, 'bad-token');
    if (p.connected) return fail(conn, replyTo, 'seat-taken');
    if (p.timer) {
      clearTimeout(p.timer);
      p.timer = null;
    }
    p.connected = true;
    p.conn = conn;
    conn.binding = { code: room.code, seat: p.seat };
    const reply = {
      t: 'room',
      room: publicRoom(room),
      you: { seat: p.seat, seatToken: p.seatToken },
      replyTo,
    };
    if (room.state) {
      reply.snapshot = publicState(room.state);
      reply.away = { fromTick: p.lastSeenTick, events: eventsSince(room, p.lastSeenTick) };
      p.lastSeenTick = room.state.tick;
      if (room.results) reply.results = room.results;
    }
    sendMsg(conn, reply);
    broadcastPresence(room);
    log(`[room ${room.code}] seat ${p.seat} ("${p.name}") reconnected`);
    return;
  }

  // Finished rooms stay joinable for replay viewing (seat-less spectator).
  if (room.started) {
    if (room.state && room.state.phase === 'over') {
      conn.binding = { code: room.code, seat: null };
      sendMsg(conn, {
        t: 'room',
        room: publicRoom(room),
        you: { seat: null, seatToken: null },
        snapshot: publicState(room.state),
        results: room.results,
        replyTo,
      });
      return;
    }
    return fail(conn, replyTo, 'room-full'); // started games have every seat bound
  }

  const free = room.players.findIndex((p) => p === null);
  if (free === -1) return fail(conn, replyTo, 'room-full');
  const player = {
    seat: free,
    name: msg.name.trim(),
    connected: true,
    seatToken: crypto.randomUUID(),
    conn,
    lastSeenTick: 0,
    timer: null,
  };
  room.players[free] = player;
  conn.binding = { code: room.code, seat: free };
  sendMsg(conn, { t: 'room', room: publicRoom(room), you: { seat: free, seatToken: player.seatToken }, replyTo });
  broadcastPresence(room);
  log(`[room ${room.code}] "${player.name}" joined seat ${free}`);
}

function boundRoom(conn, msg, replyTo) {
  const b = conn.binding;
  if (!b) {
    fail(conn, replyTo, 'not-in-room');
    return null;
  }
  if (typeof msg.code !== 'string' || msg.code !== b.code) {
    fail(conn, replyTo, 'bad-message');
    return null;
  }
  const room = rooms.get(b.code);
  if (!room) {
    conn.binding = null;
    fail(conn, replyTo, 'no-room');
    return null;
  }
  return room;
}

function handleStart(conn, msg, replyTo) {
  const room = boundRoom(conn, msg, replyTo);
  if (!room) return;
  if (conn.binding.seat == null) return fail(conn, replyTo, 'not-in-room');
  if (room.hostSeat !== conn.binding.seat) return fail(conn, replyTo, 'not-host');
  if (room.started) return fail(conn, replyTo, 'already-started');
  if (!room.players.every(Boolean)) return fail(conn, replyTo, 'room-not-full');

  // TRUST: the seed is generated here; clients never see it before the fact.
  const seed = crypto.randomInt(0x100000000);
  const ruleset = normalizeRuleset({ ...room.rulesetOpts, players: room.seats, seed });
  const players = room.players.map((p) => ({ name: p.name, kind: 'human' }));
  room.state = createGame(ruleset, players);
  room.started = true;
  room.eventLog = [];
  room.lastResult = null;
  broadcast(room, { t: 'begin', snapshot: publicState(room.state) });
  markSeen(room);
  log(`[room ${room.code}] game started (seed ${seed})`);
}

function handleCommand(conn, msg, replyTo) {
  const room = boundRoom(conn, msg, replyTo);
  if (!room) return;
  const seat = conn.binding.seat; // TRUST: bound seat only, never the payload's
  if (seat == null) return fail(conn, replyTo, 'not-in-room');
  if (!room.started || !room.state) return fail(conn, replyTo, 'not-started');
  const cmd = validCommand(msg.command);
  if (!cmd) return fail(conn, replyTo, 'bad-message');
  cmd.seat = seat;

  const st = room.state;
  if (seat !== st.turnIndex) {
    return sendMsg(conn, { t: 'rejected', error: 'not-your-turn', replyTo });
  }
  if (cmd.tick !== st.tick) {
    return sendMsg(conn, { t: 'rejected', error: 'stale-tick', snapshot: publicState(st), replyTo });
  }
  const res = applyCommand(st, cmd);
  if (res.duplicate) {
    // Idempotent redelivery: same answer, no broadcast, no log append.
    const events = room.lastResult && room.lastResult.commandId === cmd.id ? room.lastResult.events : [];
    return sendMsg(conn, { t: 'applied', snapshot: publicState(room.state), events, duplicate: true, replyTo });
  }
  if (!res.ok) {
    // TRUST: rejected commands are discarded — the returned state (which only
    // records the invalid attempt) is never committed to the room.
    return sendMsg(conn, { t: 'rejected', error: res.error, replyTo });
  }
  commitResult(room, res, cmd.id);
}

function handleLeave(conn, msg, replyTo) {
  const room = boundRoom(conn, msg, replyTo);
  if (!room) return;
  detach(conn);
  if (room.players.some(Boolean)) broadcastPresence(room);
}

function handleList(conn, replyTo) {
  const list = [];
  for (const room of rooms.values()) {
    const count = room.players.filter(Boolean).length;
    if (room.privacy === 'public' && !room.started && count < room.seats) {
      list.push({ code: room.code, seats: room.seats, players: count, createdAt: room.createdAt });
    }
  }
  list.sort((a, b) => a.createdAt - b.createdAt);
  sendMsg(conn, { t: 'rooms', rooms: list, replyTo });
}

/** Mark the bound seat disconnected (leave or socket drop) and arm the timer. */
function detach(conn) {
  const b = conn.binding;
  conn.binding = null;
  if (!b) return;
  const room = rooms.get(b.code);
  if (!room || b.seat == null) return;
  const p = room.players[b.seat];
  if (!p || p.conn !== conn) return;
  p.connected = false;
  p.conn = null;
  log(`[room ${room.code}] seat ${p.seat} ("${p.name}") disconnected`);
  p.timer = setTimeout(() => onAbandon(room, p.seat), ABANDON_MS);
  p.timer.unref?.();
  broadcastPresence(room);
}

function cleanupConn(conn) {
  if (conn.dead) return;
  conn.dead = true;
  conns.delete(conn);
  detach(conn);
  try {
    conn.socket.destroy();
  } catch {
    /* already gone */
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(handleHttp);

server.on('upgrade', (req, socket) => {
  let pathname = '';
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    /* fall through to reject */
  }
  const key = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = {
    socket,
    buf: Buffer.alloc(0),
    fragOp: 0,
    frags: [],
    fragLen: 0,
    bucket: RATE_PER_SEC,
    bucketAt: Date.now(),
    strikes: 0,
    binding: null,
    dead: false,
  };
  conns.add(conn);
  socket.on('data', (chunk) => onSocketData(conn, chunk));
  socket.on('error', () => cleanupConn(conn));
  socket.on('close', () => cleanupConn(conn));
});

server.listen(PORT, () => {
  log(`royal-circuit host listening on http://localhost:${PORT} (ws: /ws)`);
});
