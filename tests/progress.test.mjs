// The engine client's data model (node --test): the save document as the
// runtime keeps it, the browser build's cloud slot read as a foreign save,
// the game's options and the browser build's settings KV carried over, and
// the session's injected clock and fixed-step AI turns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave, mergeSaves, normalizeSave, readForeign, serializeSave } from '../src/save.js';
import { DEFAULT_OPTIONS, OPTION_KEYS, pickOptions, readLegacySettings } from '../src/options.js';
import { Session } from '../src/session.js';

test('normalizeSave fills a fresh document and keeps a real one', () => {
  assert.deepEqual(normalizeSave(null), defaultSave());
  assert.deepEqual(normalizeSave({ junk: 1 }), defaultSave());
  const s = defaultSave();
  s.journey['journey-01'] = { stars: 2, bestTurns: 30, completedAt: '2026-01-01' };
  s.stats.gamesPlayed = 4;
  const n = normalizeSave(JSON.parse(JSON.stringify(s)));
  assert.equal(n.journey['journey-01'].stars, 2);
  assert.equal(n.stats.gamesPlayed, 4);
});

test('the browser build cloud slot (versioned, checksummed) reads as a foreign save', () => {
  const s = defaultSave();
  s.lessons['lesson-1-kindle'] = { done: true };
  s.achievements.first_crown = '2026-02-01T00:00:00Z';
  const text = JSON.stringify(serializeSave(s));
  const doc = readForeign(text);
  assert.ok(doc);
  assert.equal(doc.lessons['lesson-1-kindle'].done, true);
  // a tampered checksum or junk is refused
  const bad = JSON.parse(text); bad.payload.stats.gamesPlayed = 99;
  assert.equal(readForeign(JSON.stringify(bad)), null);
  assert.equal(readForeign('not json'), null);
  // merged with this device's progress, nothing is dropped
  const local = defaultSave(); local.lessons['lesson-2-circuit'] = { done: true };
  const m = mergeSaves(doc, local);
  assert.deepEqual(Object.keys(m.lessons).sort(), ['lesson-1-kindle', 'lesson-2-circuit']);
  assert.equal(m.achievements.first_crown, '2026-02-01T00:00:00Z');
});

test('options: defaults, validation and the browser build settings KV', () => {
  assert.deepEqual([...OPTION_KEYS].sort(), Object.keys(DEFAULT_OPTIONS).sort());
  assert.deepEqual(pickOptions({ captions: 'yes', camera: 'top', theme: 'nope', palette: 'cvd', leftHanded: true }),
    { camera: 'top', palette: 'cvd', leftHanded: true });
  const kv = {
    audio: { music: 0.3, muted: true },
    graphics: { preset: 'high' },
    accessibility: { captions: false, palette: 'cvd', timingAssist: true, leftHanded: true, reducedMotion: true },
    camera: { mode: 'low' },
    theme: 'jade-garden',
  };
  assert.deepEqual(readLegacySettings(kv), { captions: false, timingAssist: true, leftHanded: true, palette: 'cvd', camera: 'low', theme: 'jade-garden' });
  assert.deepEqual(readLegacySettings(null), {});
});

test('the session takes an injected clock and plays AI turns one decision at a time', () => {
  let now = 1000;
  const s = new Session({
    mode: 'practice', ruleset: { players: 2 }, seed: 7, now: () => now,
    players: [{ name: 'A', kind: 'ai', level: 2 }, { name: 'B', kind: 'ai', level: 3 }],
  });
  assert.equal(s.startedAt, 1000);
  let steps = 0;
  while (!s.isOver && steps < 5000) { assert.equal(s.aiStep(), true); steps++; now += 650; }
  assert.ok(s.isOver, 'two AIs finish a game');
  assert.equal(s.results().elapsedMs, s.endedAt - 1000);
  // the same seed and decisions replay to the same end
  const again = new Session({ mode: 'practice', ruleset: { players: 2 }, seed: 7, players: [{ name: 'A', kind: 'ai', level: 2 }, { name: 'B', kind: 'ai', level: 3 }] });
  while (again.aiStep()) { /* until over */ }
  assert.deepEqual(again.state.players.map((p) => p.floats), s.state.players.map((p) => p.floats));
  assert.equal(Session.verifyReplay(s.envelope).ok, true);
  // a human on move: no AI decision
  const h = new Session({ mode: 'practice', ruleset: { players: 2 }, seed: 1, players: [{ name: 'H', kind: 'human' }, { name: 'A', kind: 'ai', level: 1 }] });
  assert.equal(h.aiStep(), false);
});
