/**
 * content.js — versioned content data for Royal Circuit.
 *
 * Every playable unit is versioned data: identifier, seed, initial state,
 * goals, allowed mechanics, par values, tutorial flags and presentation
 * theme. Offline validators (tests/content.test.mjs) prove basic legality,
 * reachable goals, bounded duration and absence of soft locks.
 *
 * Daily seeds are immutable after publication: the daily definition is a
 * pure function of the UTC date, so a published day can never silently
 * change — a defective day is marked excluded from ranking instead.
 */

import { hashSeed } from './rng.js';

export const CONTENT_VERSION = 1;
export const BUILD_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Themes — five visual themes (presentation palettes + scene params)  */
/* ------------------------------------------------------------------ */
export const THEMES = Object.freeze([
  {
    id: 'lantern-pavilion', name: 'Lantern Pavilion',
    sky: 0x141026, fog: 0x1a1430, ground: 0x241c3a,
    boardWood: 0x5a3b2a, boardTrim: 0xc9973f, tileA: 0x3a2c50, tileB: 0x443456,
    lantern: 0xffb347, lanternEmissive: 0xff9a2e,
    ambient: 'evening drums', musicMood: 'calm',
    accentCss: '#e8b04b', bgCss: '#141026',
  },
  {
    id: 'jade-garden', name: 'Jade Garden',
    sky: 0x0d2018, fog: 0x123124, ground: 0x16352a,
    boardWood: 0x4a3423, boardTrim: 0x9fd6a8, tileA: 0x1e4232, tileB: 0x26503c,
    lantern: 0xa8e6b0, lanternEmissive: 0x7ce896,
    ambient: 'night crickets', musicMood: 'calm',
    accentCss: '#7ce896', bgCss: '#0d2018',
  },
  {
    id: 'ember-court', name: 'Ember Court',
    sky: 0x230d0d, fog: 0x2e1210, ground: 0x381a14,
    boardWood: 0x603020, boardTrim: 0xe8763f, tileA: 0x4a2018, tileB: 0x572619,
    lantern: 0xff7a45, lanternEmissive: 0xff5a26,
    ambient: 'low fire', musicMood: 'tense',
    accentCss: '#ff8a55', bgCss: '#230d0d',
  },
  {
    id: 'moonlight-dock', name: 'Moonlight Dock',
    sky: 0x0a1428, fog: 0x101c38, ground: 0x142038,
    boardWood: 0x3c3248, boardTrim: 0x8fb6e8, tileA: 0x22304e, tileB: 0x2a3a5c,
    lantern: 0x9fc8ff, lanternEmissive: 0x6fa8ff,
    ambient: 'water lapping', musicMood: 'calm',
    accentCss: '#8fb6e8', bgCss: '#0a1428',
  },
  {
    id: 'blossom-fete', name: 'Blossom Fête',
    sky: 0x241226, fog: 0x2e1830, ground: 0x331c30,
    boardWood: 0x54303c, boardTrim: 0xf0a8c0, tileA: 0x46263c, tileB: 0x522e46,
    lantern: 0xffc0d8, lanternEmissive: 0xff9ac2,
    ambient: 'festival chatter', musicMood: 'bright',
    accentCss: '#f0a8c0', bgCss: '#241226',
  },
]);

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/* ------------------------------------------------------------------ */
/* Lessons (Learn mode) — one rule at a time, action required          */
/* ------------------------------------------------------------------ */
/**
 * A lesson sets up a fixed initial state plus a scripted die sequence.
 * Each step requires the player to perform the matching action; the
 * session advances only when the expected event is produced.
 */
export const LESSONS = Object.freeze([
  {
    id: 'lesson-1-kindle', title: 'Kindling a Float', order: 1,
    mechanics: ['deploy'],
    intro: 'Your floats begin in the workshop. Roll a 6 — a full kindle — to send one onto the circuit. The festival die is scripted for this lesson.',
    ruleset: { players: 2, seed: 101, forcedRolls: [6, 2, 3] },
    initial: null,
    steps: [
      { action: 'roll', text: 'Roll the festival die.' },
      { action: 'deploy', text: 'You rolled a 6! Choose a float to kindle it onto your start tile.' },
      { action: 'complete', text: 'Well done — a kindled float also grants an encore roll.' },
    ],
  },
  {
    id: 'lesson-2-circuit', title: 'Around the Circuit', order: 2,
    mechanics: ['move', 'turns'],
    intro: 'Floats travel the full circuit. Your rival will take turns with you.',
    ruleset: { players: 2, seed: 102, forcedRolls: [6, 4, 3, 2] },
    initial: null,
    steps: [
      { action: 'roll', text: 'Roll the die.' },
      { action: 'deploy', text: 'Kindle a float onto the circuit.' },
      { action: 'roll', text: 'Encore! Roll again.' },
      { action: 'move', text: 'Move your float along the circuit.' },
      { action: 'complete', text: 'Your rival now takes a turn. Turns alternate unless a 6 grants an encore.' },
    ],
  },
  {
    id: 'lesson-3-lanterns', title: 'Lantern Tiles', order: 3,
    mechanics: ['safe-cells'],
    intro: 'Tiles bearing a lit lantern are safe: floats of any color may rest there together, and no capture can happen.',
    ruleset: { players: 2, seed: 103, forcedRolls: [2] },
    initial: { floats: { 0: [3], 1: [25] } }, // rival waits on lantern tile 5... (seat1 progress 25 → cell 5)
    steps: [
      { action: 'roll', text: 'A rival float waits on the lantern tile ahead. Roll.' },
      { action: 'move', text: 'Move onto the lantern tile — you will share it peacefully.' },
      { action: 'complete', text: 'See? Both floats share the lantern tile. Safe tiles never capture.' },
    ],
  },
  {
    id: 'lesson-4-capture', title: 'The Capture', order: 4,
    mechanics: ['capture'],
    intro: 'Land on a rival float on an ordinary tile to send it all the way back to its workshop.',
    ruleset: { players: 2, seed: 104, forcedRolls: [3] },
    initial: { floats: { 0: [0], 1: [23] } }, // seat1 progress 23 → cell 3; roll 3 lands cell 3
    steps: [
      { action: 'roll', text: 'A rival float rests three tiles ahead, unguarded. Roll.' },
      { action: 'capture', text: 'Land exactly on it to send it home!' },
      { action: 'complete', text: 'Captured! Rival floats return to their workshop and must be kindled again.' },
    ],
  },
  {
    id: 'lesson-5-procession', title: 'Processions', order: 5,
    mechanics: ['blockade'],
    intro: 'Two of your floats on one ordinary tile form a procession. Rivals can neither land on it nor pass it.',
    ruleset: { players: 2, seed: 105, forcedRolls: [2, 4] },
    initial: { floats: { 0: [4, 6], 1: [30] } },
    steps: [
      { action: 'roll', text: 'Roll, then bring your floats together.' },
      { action: 'move', text: 'Move the rear float onto its companion (tile 6).' },
      { action: 'roll', text: 'A procession! Now roll again for your rival to feel it… actually, feel free to move on.' },
      { action: 'move', text: 'Move any float. Remember: rivals cannot cross your procession.' },
      { action: 'complete', text: 'Processions are walls. Break yours up when it blocks your own plans.' },
    ],
  },
  {
    id: 'lesson-6-crown', title: 'The Grand Approach', order: 6,
    mechanics: ['approach', 'exact-finish', 'victory'],
    intro: 'After a full lap, floats turn into their colored Grand Approach. Reach the pavilion crown with an exact roll.',
    ruleset: { players: 2, seed: 106, forcedRolls: [3, 1] },
    initial: { floats: { 0: [41], 1: [10] } }, // seat0 float 3 steps from crowning (DONE=44)
    steps: [
      { action: 'roll', text: 'Your float is on the approach, three steps from the crown. Roll.' },
      { action: 'crown', text: 'An exact 3 — guide it to the crown!' },
      { action: 'complete', text: 'Crowned! Crown all four floats to sweep the circuit and win.' },
    ],
  },
]);

/* ------------------------------------------------------------------ */
/* Journey — 40 authored stages, one new concept at a time             */
/* ------------------------------------------------------------------ */
/**
 * Mechanics introduced in isolation, combined with a known one, then a
 * mastery stage every 5th stage tests the combination. Difficulty rises
 * through AI depth, goal pressure, turn limits and variant flags —
 * not merely larger numbers.
 */
const J = [];
const STAGE_NAMES = [
  'First Lanterns', 'Open Causeway', 'Rival at Dusk', 'Double Time', 'Mastery: Kindling',
  'Lantern Watch', 'Shared Shelter', 'First Blood', 'Escort Duty', 'Mastery: Shelter',
  'Two Deep', 'The Long Wall', 'Breakthrough', 'Wall and Blade', 'Mastery: Processions',
  'Home Stretch', 'Exact Measure', 'Bounce Step', 'Crown Guard', 'Mastery: The Approach',
  'Three Lamps', 'Crossroads', 'Encore Line', 'Festival Rush', 'Mastery: Three Ways',
  'Short Circuit', 'Swift Crown', 'Tight Reins', 'Twin Floats', 'Mastery: Economy',
  'Four Lamps', 'Crowded Ring', 'No Shelter', 'Long Night', 'Mastery: Grand Fête',
  'Ember Trial', 'Jade Trial', 'Azure Trial', 'Gilded Trial', 'Mastery: Royal Circuit',
];
(function buildJourney() {
  for (let i = 0; i < 40; i++) {
    const n = i + 1;
    const mastery = n % 5 === 0;
    const tier = Math.floor(i / 5); // 0..7
    const players = tier < 3 ? 2 : tier < 6 ? 3 : 4;
    const stage = {
      id: `journey-${String(n).padStart(2, '0')}`,
      index: n,
      name: STAGE_NAMES[i],
      version: CONTENT_VERSION,
      seed: hashSeed(`royal-circuit:journey:${n}`),
      mastery,
      theme: THEMES[Math.min(tier, THEMES.length - 1)].id,
      players,
      ai: [],
      ruleset: { players, floats: 4 },
      goal: { type: 'win' },
      par: { turns: 60 + tier * 6 },
      mechanics: [],
      tutorialFlags: [],
      blurb: '',
    };
    // AI difficulty ladder
    const aiLevel = mastery
      ? Math.min(3, 1 + Math.floor(tier / 2))
      : Math.min(3, Math.max(1, Math.floor(tier / 2)));
    for (let s = 1; s < players; s++) stage.ai.push({ seat: s, level: aiLevel });

    // Concept introduction: isolate → combine → mastery
    if (tier === 0) { stage.mechanics = ['deploy', 'move']; stage.goal = { type: 'crown-first', count: 1 }; stage.par.turns = 40; }
    if (tier === 1) { stage.mechanics = ['safe-cells', 'capture']; }
    if (tier === 2) { stage.mechanics = ['blockade']; if (mastery) stage.goal = { type: 'win' }; }
    if (tier === 3) {
      stage.mechanics = ['approach', 'exact-finish'];
      if (n === 18) { stage.ruleset.exactFinish = false; stage.blurb = 'Bounce-back finish: overshoot reflects down the approach.'; }
      if (n === 19) { stage.goal = { type: 'captures', count: 3 }; stage.blurb = 'Win by captures: send three rival floats home first.'; }
    }
    if (tier === 4) {
      stage.mechanics = ['encore-pressure'];
      stage.ruleset.maxTurns = 34 - (n % 5) * 2;
      stage.goal = { type: 'win' };
      stage.blurb = 'A strict lantern schedule: finish before the turn limit.';
    }
    if (tier === 5) {
      stage.mechanics = ['economy'];
      stage.ruleset.floats = n % 2 === 0 ? 2 : 3;
      stage.ruleset.maxTurns = 30;
      stage.blurb = 'Fewer floats, tighter schedule.';
    }
    if (tier === 6) {
      stage.mechanics = ['full-field'];
      if (n === 33) { stage.ruleset.safeTrack = false; stage.blurb = 'The lanterns are dark — nowhere is safe.'; }
      if (n === 34) { stage.ruleset.maxTurns = 40; }
    }
    if (tier === 7) {
      stage.mechanics = ['mastery-track'];
      stage.ruleset.maxTurns = mastery ? 44 : 0;
      stage.goal = { type: 'win' };
      stage.theme = THEMES[(n - 36) % THEMES.length]?.id || THEMES[0].id;
      stage.blurb = 'The final trials of the Royal Circuit.';
    }
    if (mastery) stage.tutorialFlags = ['mastery'];
    J.push(Object.freeze(stage));
  }
})();

/** Deep-unfreeze helper: stages are stored frozen, sessions clone them. */
export function stageRuleset(stage) {
  return JSON.parse(JSON.stringify({ ...stage.ruleset, players: stage.players, seed: stage.seed }));
}
export const JOURNEY = Object.freeze(J);
export function stageByIndex(n) { return JOURNEY[n - 1] || null; }

/* ------------------------------------------------------------------ */
/* Challenges — constrained goals                                      */
/* ------------------------------------------------------------------ */
export const CHALLENGES = Object.freeze([
  {
    id: 'ch-sprint', name: 'Lantern Sprint', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:sprint'),
    ruleset: { players: 2, floats: 4, maxTurns: 24 }, ai: [{ seat: 1, level: 2 }],
    goal: { type: 'win' }, par: { turns: 20 }, theme: 'ember-court',
    blurb: 'Win in 24 rounds or fewer. Every roll must count.',
  },
  {
    id: 'ch-pacifist', name: 'Pacifist Parade', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:pacifist'),
    ruleset: { players: 2, floats: 4 }, ai: [{ seat: 1, level: 2 }],
    goal: { type: 'win-no-captures' }, par: { turns: 70 }, theme: 'jade-garden',
    blurb: 'Win without capturing a single rival float.',
  },
  {
    id: 'ch-hunter', name: 'Float Hunter', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:hunter'),
    ruleset: { players: 3, floats: 4 }, ai: [{ seat: 1, level: 2 }, { seat: 2, level: 2 }],
    goal: { type: 'captures-then-win', count: 5 }, par: { captures: 5 }, theme: 'ember-court',
    blurb: 'Land at least 5 captures on the way to victory.',
  },
  {
    id: 'ch-photo', name: 'Photo Finish', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:photo'),
    ruleset: { players: 2, floats: 3, exactFinish: false }, ai: [{ seat: 1, level: 3 }],
    goal: { type: 'win' }, par: { turns: 40 }, theme: 'moonlight-dock',
    blurb: 'Bounce-back rules against a master rival. Overshoots reflect.',
  },
  {
    id: 'ch-dark', name: 'Dark Circuit', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:dark'),
    ruleset: { players: 2, floats: 4, safeTrack: false }, ai: [{ seat: 1, level: 2 }],
    goal: { type: 'win' }, par: { turns: 60 }, theme: 'moonlight-dock',
    blurb: 'No lantern tiles. Every tile is dangerous.',
  },
  {
    id: 'ch-grand', name: 'Grand Melee', version: CONTENT_VERSION,
    seed: hashSeed('royal-circuit:challenge:grand'),
    ruleset: { players: 4, floats: 4, maxTurns: 50 },
    ai: [{ seat: 1, level: 3 }, { seat: 2, level: 3 }, { seat: 3, level: 3 }],
    goal: { type: 'win' }, par: { turns: 44 }, theme: 'lantern-pavilion',
    blurb: 'Four master floats, one circuit, fifty rounds.',
  },
]);

/* ------------------------------------------------------------------ */
/* Daily — one shared seed + ruleset per UTC day (immutable)           */
/* ------------------------------------------------------------------ */
export function dailyForDate(date = new Date()) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const key = `${y}-${m}-${d}`;
  const h = hashSeed(`royal-circuit:daily:${key}`);
  const players = 2 + (h % 3); // 2..4, fixed for the day
  const variants = [
    {},
    { exactFinish: false },
    { maxTurns: 36 },
    { safeTrack: false },
    { floats: 3 },
  ];
  const variant = variants[h % variants.length];
  return Object.freeze({
    id: `daily-${key}`,
    date: key,
    version: CONTENT_VERSION,
    seed: h,
    players,
    ruleset: { players, floats: 4, ...variant },
    ai: Array.from({ length: players - 1 }, (_, i) => ({ seat: i + 1, level: 2 })),
    goal: { type: 'win' },
    theme: THEMES[h % THEMES.length].id,
    ranked: true,
  });
}

/* ------------------------------------------------------------------ */
/* Achievements — small static set, stable lowercase keys, idempotent  */
/* ------------------------------------------------------------------ */
export const ACHIEVEMENTS = Object.freeze([
  { key: 'first_crown', name: 'First Crown', desc: 'Crown your first float.', icon: '♛' },
  { key: 'first_victory', name: 'Circuit Victor', desc: 'Win your first game.', icon: '🏮' },
  { key: 'capturer', name: 'Lantern Snuffer', desc: 'Land 10 captures in total.', icon: '⚔' },
  { key: 'journey_half', name: 'Pilgrim of the Ring', desc: 'Complete 20 journey stages.', icon: '🥾' },
  { key: 'journey_complete', name: 'Master of the Circuit', desc: 'Complete all 40 journey stages.', icon: '👑' },
  { key: 'daily_streak_3', name: 'Three Dusks Running', desc: 'Play the daily challenge 3 days in a row.', icon: '🌇' },
  { key: 'flawless', name: 'Untouchable', desc: 'Win a game without any float being sent home.', icon: '✦' },
  { key: 'scholar', name: 'Festival Scholar', desc: 'Complete every lesson.', icon: '📜' },
  { key: 'centurion', name: 'Hundred Circuits', desc: 'Complete 100 games across any mode. (Counts every mode equally — no grind advantage.)', icon: '💯' },
]);

/* ------------------------------------------------------------------ */
/* Validators (offline; also used by tests)                            */
/* ------------------------------------------------------------------ */
import { createGame, legalActions, applyCommand } from './rules.js';

/**
 * Prove basic legality, bounded duration and absence of soft locks for a
 * content definition by simulating it with a trivial "first legal move"
 * policy. Returns { ok, problems: [] }.
 */
export function validateContent(def) {
  const problems = [];
  try {
    const players = Array.from({ length: def.ruleset.players }, (_, i) => ({
      name: `v${i}`, kind: 'ai',
    }));
    let st = createGame({ ...def.ruleset, seed: def.seed }, players);
    let guard = 0;
    // Guard counts commands, not turns: a turn can span several commands
    // (roll + move, encore chains up to three sixes), so allow 8 per turn.
    const limit = (def.ruleset.maxTurns > 0 ? def.ruleset.maxTurns * def.ruleset.players * 8 : 5000) + 50;
    let seq = 0;
    while (st.phase !== 'over' && guard++ < limit) {
      const acts = legalActions(st);
      let r;
      if (acts.type === 'roll') r = applyCommand(st, { id: `v${++seq}`, seat: st.turnIndex, type: 'roll' });
      else if (acts.type === 'pass') r = applyCommand(st, { id: `v${++seq}`, seat: st.turnIndex, type: 'pass' });
      else r = applyCommand(st, { id: `v${++seq}`, seat: st.turnIndex, type: 'move', floatId: acts.moves[0].floatId });
      if (!r.ok) { problems.push(`validator command rejected: ${r.error}`); break; }
      st = r.state;
    }
    if (st.phase !== 'over') problems.push('simulation did not terminate within bound (possible soft lock)');
  } catch (e) {
    problems.push(`exception: ${e.message}`);
  }
  return { ok: problems.length === 0, problems };
}
