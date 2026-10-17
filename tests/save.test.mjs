// mergeSaves: a cloud-save conflict keeps the best of both devices (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSaves, defaultSave } from '../src/save.js';

test('merge keeps the better record of every kind and drops nothing', () => {
  const remote = {
    ...defaultSave(),
    journey: { 'journey-01': { stars: 1, bestTurns: 40, completedAt: '2026-01-02' }, 'journey-02': { stars: 2, bestTurns: 50, completedAt: '2026-01-03' } },
    lessons: { 'lesson-1-kindle': { done: true } },
    dailies: { '2026-01-01': { score: 900, won: true, turns: 30 } },
    achievements: { first_crown: '2026-01-02T00:00:00Z' },
    stats: { gamesPlayed: 5, gamesWon: 2, captures: 9, crowned: 6, streakDays: 1, lastDaily: '2026-01-01' },
    leaderboards: { daily: [{ at: 'a', seed: 1, contentId: 'd', score: 900, turns: 30 }], best: [] },
  };
  const local = {
    ...defaultSave(),
    profile: { name: 'Lu', avatar: '🏮', guest: true },
    journey: { 'journey-01': { stars: 3, bestTurns: 44, completedAt: '2026-01-01' } },
    lessons: { 'lesson-2-circuit': { done: true } },
    dailies: { '2026-01-01': { score: 1200, won: true, turns: 28 }, '2026-01-02': { score: 100, won: false, turns: 40 } },
    achievements: { first_crown: '2026-01-05T00:00:00Z', capturer: '2026-01-05T00:00:00Z' },
    stats: { gamesPlayed: 3, gamesWon: 3, captures: 12, crowned: 2, streakDays: 2, lastDaily: '2026-01-02' },
    leaderboards: { daily: [{ at: 'b', seed: 2, contentId: 'd', score: 1200, turns: 28 }, { at: 'a', seed: 1, contentId: 'd', score: 900, turns: 30 }], best: [] },
  };
  const m = mergeSaves(remote, local);
  assert.deepEqual(m.journey['journey-01'], { stars: 3, bestTurns: 40, completedAt: '2026-01-01' });
  assert.equal(m.journey['journey-02'].stars, 2);
  assert.deepEqual(Object.keys(m.lessons).sort(), ['lesson-1-kindle', 'lesson-2-circuit']);
  assert.equal(m.dailies['2026-01-01'].score, 1200);
  assert.equal(m.dailies['2026-01-02'].score, 100);
  assert.equal(m.achievements.first_crown, '2026-01-02T00:00:00Z');
  assert.ok(m.achievements.capturer);
  assert.deepEqual(m.stats, { gamesPlayed: 5, gamesWon: 3, captures: 12, crowned: 6, streakDays: 2, lastDaily: '2026-01-02' });
  assert.deepEqual(m.leaderboards.daily.map((e) => e.score), [1200, 900]);
  assert.equal(m.profile.name, 'Lu');
});

test('a default local profile keeps the remote name', () => {
  const m = mergeSaves({ ...defaultSave(), profile: { name: 'Remote', avatar: '🏮', guest: true } }, defaultSave());
  assert.equal(m.profile.name, 'Remote');
});
