/**
 * save.js — local persistence.
 *
 * Progression is a versioned, checksummed document. Corrupt or
 * future-version payloads never crash the game: they are quarantined and a
 * fresh document is issued. No credentials or private data are ever stored
 * here. Migration tests live in tests/save.test.mjs.
 */

import { hashString } from './rng.js';
import { migrateGraphics } from './gfx.js';

export const SAVE_VERSION = 1;
const KEY = 'royal-circuit:save:v1';
const SETTINGS_KEY = 'royal-circuit:settings:v1';

export function defaultSave() {
  return {
    profile: { name: 'Guest Envoy', avatar: '🏮', guest: true },
    journey: {},              // stageId -> { stars, bestTurns, completedAt }
    lessons: {},              // lessonId -> { done: true }
    dailies: {},              // 'YYYY-MM-DD' -> { score, won, turns, excluded? }
    achievements: {},         // key -> unlockedAt
    stats: { gamesPlayed: 0, gamesWon: 0, captures: 0, crowned: 0, streakDays: 0, lastDaily: null },
    leaderboards: { daily: [], best: [] }, // local boards; platform boards are read-only
    ratings: { circuit: 1000 },
  };
}

export function defaultSettings() {
  return {
    audio: { music: 0.7, effects: 0.9, ambience: 0.6, voice: 0.8, muted: false },
    // gfx.js model: preset auto|low|balanced|high|ultra, per-category overrides
    graphics: { preset: 'auto', render_scale: 1, adaptive: true, show_fps: false },
    accessibility: {
      reducedMotion: false, highContrast: false, largeText: false,
      palette: 'standard', leftHanded: false, holdToConfirm: false,
      timingAssist: false, haptics: true, captions: true,
    },
    camera: { mode: 'auto' }, // auto | top | low
    input: { bindings: null }, // player overrides for desktop bindings
    theme: 'lantern-pavilion',
    tutorial: { seenIntro: false },
    consent: { analytics: false },
  };
}

function checksum(payload) {
  return hashString(JSON.stringify(payload));
}

function wrap(payload) {
  return { version: SAVE_VERSION, checksum: checksum(payload), payload };
}

function unwrap(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.version > SAVE_VERSION) return null; // future version: do not touch
  if (doc.checksum !== checksum(doc.payload)) return null;
  return migrate(doc);
}

/** Migrate older payloads forward. Version 1 is current; kept for tests. */
export function migrate(doc) {
  let { version, payload } = doc;
  if (version === SAVE_VERSION) return payload;
  // Future migrations chain here: if (version === 1) { payload = v1tov2(payload); version = 2; }
  return version === SAVE_VERSION ? payload : null;
}

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return unwrap(JSON.parse(raw));
  } catch {
    return null;
  }
}

function write(key, payload) {
  try {
    localStorage.setItem(key, JSON.stringify(wrap(payload)));
    return true;
  } catch {
    return false; // storage full / blocked: play continues without persistence
  }
}

export function loadSave() {
  return read(KEY) || defaultSave();
}
export function storeSave(save) {
  return write(KEY, save);
}
const num = (v) => (Number.isFinite(v) ? v : 0);
const later = (a, b) => (!a ? b : !b ? a : (String(a) > String(b) ? a : b));
const earlier = (a, b) => (!a ? b : !b ? a : (String(a) < String(b) ? a : b));

/**
 * Merge two save payloads (cloud `remote`, this device's `local`) so neither
 * side's progress is lost: best journey stars and turns per stage, every
 * completed lesson, the better daily result per date, every achievement (the
 * earliest unlock time), the larger of each counter, the union of both local
 * boards (top 50) and the higher rating. The profile name is this device's
 * unless it is still the default guest name.
 */
export function mergeSaves(remote, local) {
  const d = defaultSave();
  const r = { ...d, ...(remote || {}) };
  const l = { ...d, ...(local || {}) };
  const out = defaultSave();
  out.profile = { ...r.profile, ...(l.profile?.name && l.profile.name !== d.profile.name ? l.profile : {}) };
  for (const id of new Set([...Object.keys(r.journey || {}), ...Object.keys(l.journey || {})])) {
    const a = r.journey?.[id], b = l.journey?.[id];
    if (!a || !b) { out.journey[id] = { ...(a || b) }; continue; }
    out.journey[id] = {
      stars: Math.max(num(a.stars), num(b.stars)),
      bestTurns: Math.min(a.bestTurns ?? Infinity, b.bestTurns ?? Infinity),
      completedAt: earlier(a.completedAt, b.completedAt),
    };
    if (!Number.isFinite(out.journey[id].bestTurns)) delete out.journey[id].bestTurns;
  }
  out.lessons = { ...(r.lessons || {}), ...(l.lessons || {}) };
  for (const day of new Set([...Object.keys(r.dailies || {}), ...Object.keys(l.dailies || {})])) {
    const a = r.dailies?.[day], b = l.dailies?.[day];
    out.dailies[day] = { ...(!a ? b : !b ? a : num(b.score) > num(a.score) ? b : a) };
  }
  for (const k of new Set([...Object.keys(r.achievements || {}), ...Object.keys(l.achievements || {})])) {
    out.achievements[k] = earlier(r.achievements?.[k], l.achievements?.[k]);
  }
  const rs = r.stats || {}, ls = l.stats || {};
  for (const k of ['gamesPlayed', 'gamesWon', 'captures', 'crowned', 'streakDays']) out.stats[k] = Math.max(num(rs[k]), num(ls[k]));
  out.stats.lastDaily = later(rs.lastDaily, ls.lastDaily) || null;
  for (const board of ['daily', 'best']) {
    const seen = new Set();
    out.leaderboards[board] = [...(r.leaderboards?.[board] || []), ...(l.leaderboards?.[board] || [])]
      .filter((e) => { const key = `${e.at}|${e.seed}|${e.contentId}|${e.score}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .sort((a, b) => b.score - a.score || a.turns - b.turns)
      .slice(0, 50);
  }
  out.ratings = { ...(r.ratings || {}), ...(l.ratings || {}) };
  for (const k of Object.keys(out.ratings)) out.ratings[k] = Math.max(num(r.ratings?.[k]), num(l.ratings?.[k]));
  return out;
}

/** Wrapped document for the cloud mirror (version + checksum + payload). */
export function serializeSave(save) {
  return wrap(save);
}
/** Parse a wrapped document (local or cloud); null when invalid/future. */
export function parseDoc(doc) {
  return unwrap(doc);
}
export function loadSettings() {
  const s = read(SETTINGS_KEY);
  // merge over defaults so new settings keys appear automatically
  const d = defaultSettings();
  if (!s) return d;
  return {
    ...d, ...s,
    audio: { ...d.audio, ...(s.audio || {}) },
    graphics: { ...d.graphics, ...migrateGraphics(s.graphics) },
    accessibility: { ...d.accessibility, ...(s.accessibility || {}) },
    camera: { ...d.camera, ...(s.camera || {}) },
    input: { ...d.input, ...(s.input || {}) },
    tutorial: { ...d.tutorial, ...(s.tutorial || {}) },
    consent: { ...d.consent, ...(s.consent || {}) },
  };
}
export function storeSettings(settings) {
  return write(SETTINGS_KEY, settings);
}

/** Last safe local snapshot of an in-progress solo game (resume support). */
const SNAPSHOT_KEY = 'royal-circuit:snapshot:v1';
export function storeSnapshot(env) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(wrap(env))); } catch { /* optional */ }
}
export function loadSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    return unwrap(JSON.parse(raw));
  } catch { return null; }
}
export function clearSnapshot() {
  try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
}
