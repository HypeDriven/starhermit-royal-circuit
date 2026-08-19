/**
 * rng.js — deterministic, serializable seeded random streams.
 *
 * Rules, content decoration and audiovisual variants each use their own
 * stream so cosmetic randomness can never influence rules outcomes.
 * A stream state is a plain `{ s: uint32 }` object that can be serialized
 * as part of the game state and resumed exactly.
 */

/** Hash an arbitrary string into a uint32 seed (fnv1a). */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Create a serializable stream state from a numeric or string seed. */
export function createStream(seed) {
  const s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return { s: (s === 0 ? 0x9e3779b9 : s) >>> 0 };
}

/** Clone a stream state. */
export function cloneStream(st) {
  return { s: st.s >>> 0 };
}

/** Next uint32 in [0, 2^32). mulberry32. */
export function nextUint(st) {
  st.s = (st.s + 0x6d2b79f5) >>> 0;
  let t = st.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0);
}

/** Integer in [0, n). */
export function nextInt(st, n) {
  return nextUint(st) % n;
}

/** Integer in [min, max] inclusive. */
export function nextRange(st, min, max) {
  return min + nextInt(st, max - min + 1);
}

/** Float in [0, 1). */
export function nextFloat(st) {
  return nextUint(st) / 0x100000000;
}

/** Pick an element. */
export function pick(st, arr) {
  return arr[nextInt(st, arr.length)];
}

/** fnv1a hash of a string, hex — used for state hashes in replay envelopes. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Canonical JSON (sorted keys) for stable hashing. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

/** Stable short hash of any JSON-serializable value. */
export function hashState(value) {
  return hashString(canonicalJSON(value));
}
