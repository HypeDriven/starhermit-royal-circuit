// Royal Circuit localization for the pure modules: every player-facing string
// is authored in US English and looked up by that text. T('Play') is the
// current locale's translation through the engine's strings, which the client
// installs (native/i18n.ts); node tests get the English keys. Placeholders use
// {name}. N('…') marks a string for extraction without translating it there.

let hasKey = () => false;
let translate = (k) => k;
/** The engine client's lookup. */
export function setTranslator(has, t) { hasKey = has; translate = t; }

export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/** Translate an English source string (unknown strings, e.g. player names, pass through). */
export function T(key, vars) {
  if (key == null) return '';
  const s = String(key);
  if (hasKey(s)) return translate(s, vars);
  return vars ? fmt(s, vars) : s;
}

/** Mark a string for extraction; translated later with T(). */
export const N = (key) => key;

/** A player's display name: built-in names (AI rivals, seats, the guest) are translated. */
export function pname(name) {
  const s = String(name ?? '');
  const seat = /^Seat (\d+)$/.exec(s);
  if (seat) return T('Seat {n}', { n: seat[1] });
  return T(s);
}
