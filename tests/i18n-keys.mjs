// Key extraction for the i18n coverage test (also handy for listing keys):
// literal T('…') / N('…') calls in src/, data-i18n markup in index.html, and
// the display fields of the content tables.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, LESSONS, JOURNEY, CHALLENGES, ACHIEVEMENTS } from '../src/content.js';
import { AI_LEVELS, aiName } from '../src/ai.js';
import { REASON_TEXT } from '../src/rules.js';
import { EVENT_CAPTIONS } from '../src/audio.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.js', 'gfxstrings.js', 'shstrings.js']);
const unescape = (s) => s.replace(/\\(['"\\`])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  // T(cond ? 'a' : 'b', …) picks one of two keys.
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const dir = join(ROOT, 'src');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || SKIP.has(f)) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1].replace(/&quot;/g, '"'));
  return keys;
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
  Object.values(EVENT_CAPTIONS).forEach((s) => add(s));
  // Fallbacks passed through T() as expressions, and default player names.
  add('Follow the lesson.', 'Not allowed.', 'Guest Envoy', 'Seat {n}');
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
