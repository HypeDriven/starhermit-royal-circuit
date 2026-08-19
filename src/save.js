/**
 * save.js — local persistence.
 *
 * Progression is a versioned, checksummed document. Corrupt or
 * future-version payloads never crash the game: they are quarantined and a
 * fresh document is issued. No credentials or private data are ever stored
 * here. Migration tests live in tests/save.test.mjs.
 */

import { hashString } from './rng.js';

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
    leaderboards: { daily: [], best: [] }, // local boards; hosted boards come from the server
    ratings: { circuit: 1000 },
  };
}

export function defaultSettings() {
  return {
    audio: { music: 0.7, effects: 0.9, ambience: 0.6, voice: 0.8, muted: false },
    graphics: { tier: 'auto', renderScale: 1 },
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
export function loadSettings() {
  const s = read(SETTINGS_KEY);
  // merge over defaults so new settings keys appear automatically
  const d = defaultSettings();
  if (!s) return d;
  return {
    ...d, ...s,
    audio: { ...d.audio, ...(s.audio || {}) },
    graphics: { ...d.graphics, ...(s.graphics || {}) },
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
