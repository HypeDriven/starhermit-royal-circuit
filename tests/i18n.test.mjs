// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings: literal T('…') / N('…') calls in
// src/, data-i18n markup in index.html, and the display fields of the content
// tables (stages, lessons, challenges, achievements, AI names, …).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, pname, setLocale, getLang } from '../src/i18n.js';
import { gfxStrings } from '../src/gfxstrings.js';
import { shText } from '../src/shstrings.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('T falls back to the key, fills placeholders; built-in names translate, player names pass through', () => {
  setLocale('de-DE');
  assert.equal(getLang(), 'de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Roll'), 'Würfeln');
  assert.equal(pname('Seat 3'), 'Platz 3');
  assert.equal(pname('Paper Crane'), 'Papierkranich');
  assert.equal(pname('Lantern Lu'), 'Lantern Lu');
  setLocale('fr-CA');
  assert.equal(T('Watch Replay'), 'Voir la reprise');
  assert.equal(T('Roll'), 'Lancer'); // inherited from fr-FR
  setLocale('xx-YY');
  assert.equal(getLang(), 'en-US');
  assert.equal(T('Roll'), 'Roll');
});

test('graphics and StarHermit chrome strings follow the game language', () => {
  setLocale('it-IT');
  assert.equal(gfxStrings().quality, gfxStrings('it-IT').quality);
  assert.equal(shText('invite'), shText('invite'));
  assert.notEqual(shText('signIn'), 'Sign in with StarHermit');
  setLocale('en-US');
  assert.equal(shText('signIn'), 'Sign in with StarHermit');
});
