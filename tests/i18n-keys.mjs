// Key extraction for the i18n coverage test (also handy for listing keys):
// literal T("…") / N("…") calls in native/*.ts and the pure src/ modules,
// the sound captions (native/audio.ts EVENT_CAPTIONS), and the display fields
// of the content tables.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, LESSONS, JOURNEY, CHALLENGES, ACHIEVEMENTS } from '../src/content.js';
import { AI_LEVELS, aiName } from '../src/ai.js';
import { REASON_TEXT } from '../src/rules.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.js', 'shstrings.js', 'i18n.ts']);
const unescape = (s) => s.replace(/\\(['"\\`])/g, '$1');
const STR = String.raw`(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")`;

function scan(dir, ext, keys) {
  const call = new RegExp(String.raw`(?<![\w.$])(?:T|N)\(\s*` + STR, 'g');
  // T(cond ? "a" : "b", …) picks one of two keys.
  const ternary = new RegExp(String.raw`(?<![\w.$])T\([^'"\n()]*?\?\s*` + STR + String.raw`\s*:\s*` + STR, 'g');
  for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith(ext) || SKIP.has(f)) continue;
    const src = readFileSync(join(ROOT, dir, f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1] ?? m[2])); keys.add(unescape(m[3] ?? m[4])); }
  }
}

export function sourceKeys() {
  const keys = new Set();
  scan('native', '.ts', keys);
  scan('src', '.js', keys);
  return keys;
}

/** native/audio.ts EVENT_CAPTIONS values. */
export function captionKeys() {
  const src = readFileSync(join(ROOT, 'native', 'audio.ts'), 'utf8');
  const block = src.slice(src.indexOf('export const EVENT_CAPTIONS'), src.indexOf('};', src.indexOf('export const EVENT_CAPTIONS')));
  return [...block.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]);
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const t of THEMES) add(t.name);
  for (const l of LESSONS) { add(l.title, l.intro); for (const s of l.steps) add(s.text); }
  for (const s of JOURNEY) add(s.name, s.blurb);
  for (const c of CHALLENGES) add(c.name, c.blurb);
  for (const a of ACHIEVEMENTS) add(a.name, a.desc);
  for (const l of AI_LEVELS) { add(l.name); for (let i = 0; i < 3; i++) add(aiName(l.level, i)); }
  Object.values(REASON_TEXT).forEach((s) => add(s));
  captionKeys().forEach((s) => add(s));
  // Fallbacks passed through T() as expressions, and default player names.
  add('Follow the lesson.', 'Not allowed.', 'Guest Envoy', 'Seat {n}', 'Set up');
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
