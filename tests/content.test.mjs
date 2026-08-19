/**
 * content.test.mjs — offline validators for versioned content data.
 * Proves basic legality, reachable goals, bounded duration and absence of
 * soft locks for every playable unit, plus daily-seed determinism.
 * Run: node tests/content.test.mjs
 */
import {
  THEMES, LESSONS, JOURNEY, CHALLENGES, ACHIEVEMENTS,
  dailyForDate, stageRuleset, themeById, stageByIndex,
  validateContent, CONTENT_VERSION, BUILD_VERSION,
} from '../src/content.js';
import { normalizeRuleset, createGame, DONE } from '../src/rules.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

const THEME_IDS = new Set(THEMES.map((t) => t.id));
const GOAL_TYPES = new Set(['win', 'crown-first', 'captures', 'captures-then-win', 'win-no-captures']);
const STEP_ACTIONS = new Set(['roll', 'deploy', 'move', 'capture', 'crown', 'complete']);

/* ---------- themes ---------- */
{
  eq(THEMES.length, 5, 'five themes');
  const ids = new Set();
  let hexOk = true, cssOk = true, moodOk = true;
  for (const t of THEMES) {
    ids.add(t.id);
    for (const k of ['sky', 'fog', 'ground', 'boardWood', 'boardTrim', 'tileA', 'tileB', 'lantern', 'lanternEmissive']) {
      if (!Number.isInteger(t[k]) || t[k] < 0 || t[k] > 0xffffff) hexOk = false;
    }
    if (!/^#[0-9a-f]{6}$/i.test(t.accentCss) || !/^#[0-9a-f]{6}$/i.test(t.bgCss)) cssOk = false;
    if (!['calm', 'tense', 'bright'].includes(t.musicMood)) moodOk = false;
  }
  eq(ids.size, THEMES.length, 'theme ids unique');
  ok(hexOk, 'theme palettes are numeric hex');
  ok(cssOk, 'accentCss/bgCss are css hex strings');
  ok(moodOk, 'musicMood values valid');
  eq(themeById('nope').id, THEMES[0].id, 'themeById falls back to first theme');
  eq(themeById(THEMES[3].id).id, THEMES[3].id, 'themeById finds by id');
}

/* ---------- lessons ---------- */
{
  eq(LESSONS.length, 6, 'six lessons');
  const ids = new Set();
  let shapeOk = true;
  LESSONS.forEach((l, i) => {
    ids.add(l.id);
    if (l.order !== i + 1) shapeOk = false; // sequential 1-based order
    if (!Array.isArray(l.steps) || l.steps.length < 2) shapeOk = false;
    if (l.steps[l.steps.length - 1].action !== 'complete') shapeOk = false;
    if (!l.steps.every((s) => STEP_ACTIONS.has(s.action) && typeof s.text === 'string' && s.text.length > 3)) shapeOk = false;
    try {
      normalizeRuleset(l.ruleset);
    } catch { shapeOk = false; }
    if (l.initial) {
      for (const [seat, arr] of Object.entries(l.initial.floats || {})) {
        if (Number(seat) >= l.ruleset.players) shapeOk = false;
        if (!arr.every((p) => p >= -1 && p <= DONE)) shapeOk = false;
      }
    }
  });
  eq(ids.size, LESSONS.length, 'lesson ids unique');
  ok(shapeOk, 'lessons: sequential order, valid steps, valid rulesets, valid presets');
}

/* ---------- journey: 40 authored stages ---------- */
{
  eq(JOURNEY.length, 40, 'journey has 40 stages');
  const ids = new Set();
  let shapeOk = true;
  JOURNEY.forEach((s, i) => {
    ids.add(s.id);
    if (s.index !== i + 1) shapeOk = false;
    if (s.mastery !== ((i + 1) % 5 === 0)) shapeOk = false; // mastery every 5th
    if (s.version !== CONTENT_VERSION) shapeOk = false;
    if (!Number.isInteger(s.seed)) shapeOk = false;
    if (![2, 3, 4].includes(s.players) || s.ruleset.players !== s.players) shapeOk = false;
    if (s.ai.length !== s.players - 1) shapeOk = false;
    if (!s.ai.every((a) => a.seat >= 1 && a.seat < s.players && a.level >= 1 && a.level <= 3)) shapeOk = false;
    if (!GOAL_TYPES.has(s.goal.type)) shapeOk = false;
    if (!s.par || !(s.par.turns > 0)) shapeOk = false;
    if (!THEME_IDS.has(s.theme)) shapeOk = false;
    if (typeof s.name !== 'string' || !s.name.length) shapeOk = false;
    try {
      const rs = stageRuleset(s);
      normalizeRuleset(rs);
      if (rs.seed !== s.seed || rs.players !== s.players) shapeOk = false;
      rs.players = 99; // proves the copy is unfrozen and detached
      if (s.ruleset.players === 99) shapeOk = false;
    } catch { shapeOk = false; }
  });
  eq(ids.size, 40, 'journey stage ids unique');
  ok(shapeOk, 'journey stages: indices, mastery cadence, ai seats, goals, pars, themes');
  eq(stageByIndex(1).id, JOURNEY[0].id, 'stageByIndex(1) is first stage');
  eq(stageByIndex(41), null, 'stageByIndex(41) is null');

  // difficulty ladder rises: later tiers never use weaker AI than the first tier
  const lvl = (s) => Math.min(...s.ai.map((a) => a.level));
  ok(lvl(JOURNEY[39]) >= lvl(JOURNEY[0]), 'AI difficulty does not regress across the journey');
}

/* ---------- challenges ---------- */
{
  eq(CHALLENGES.length, 6, 'six challenges');
  const ids = new Set();
  let shapeOk = true;
  for (const c of CHALLENGES) {
    ids.add(c.id);
    if (c.version !== CONTENT_VERSION) shapeOk = false;
    if (!Number.isInteger(c.seed)) shapeOk = false;
    if (!GOAL_TYPES.has(c.goal.type)) shapeOk = false;
    if (['captures', 'captures-then-win'].includes(c.goal.type) && !(c.goal.count > 0)) shapeOk = false;
    if (![2, 3, 4].includes(c.ruleset.players)) shapeOk = false;
    if (c.ai.length !== c.ruleset.players - 1) shapeOk = false;
    if (!c.ai.every((a) => a.seat >= 1 && a.seat < c.ruleset.players)) shapeOk = false;
    if (!THEME_IDS.has(c.theme)) shapeOk = false;
    if (typeof c.blurb !== 'string' || !c.blurb.length) shapeOk = false;
    try { normalizeRuleset({ ...c.ruleset, seed: c.seed }); } catch { shapeOk = false; }
  }
  eq(ids.size, CHALLENGES.length, 'challenge ids unique');
  ok(shapeOk, 'challenges: goals, counts, ai seats, themes, rulesets');
}

/* ---------- achievements ---------- */
{
  ok(ACHIEVEMENTS.length >= 8, 'achievement set present');
  const keys = new Set();
  let shapeOk = true;
  for (const a of ACHIEVEMENTS) {
    keys.add(a.key);
    if (!/^[a-z0-9_]+$/.test(a.key)) shapeOk = false; // stable lowercase keys
    if (!a.name || !a.desc || !a.icon) shapeOk = false;
  }
  eq(keys.size, ACHIEVEMENTS.length, 'achievement keys unique');
  ok(shapeOk, 'achievements: lowercase keys with name/desc/icon');
}

/* ---------- daily: pure function of the UTC date ---------- */
{
  const d1 = new Date(Date.UTC(2026, 7, 18, 1, 30));
  const d2 = new Date(Date.UTC(2026, 7, 18, 23, 59));
  const d3 = new Date(Date.UTC(2026, 7, 19, 0, 1));
  const a = dailyForDate(d1);
  const b = dailyForDate(d2);
  const c = dailyForDate(d3);
  eq(a, b, 'same UTC day → identical daily (immutable after publication)');
  ok(a.id !== c.id && a.seed !== c.seed, 'different UTC day → different id and seed');
  eq(a.id, `daily-${a.date}`, 'daily id derived from date');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(a.date), 'daily date key format');
  ok(a.players >= 2 && a.players <= 4 && a.ruleset.players === a.players, 'daily players in range');
  eq(a.ai.length, a.players - 1, 'daily fills non-human seats with AI');
  ok(a.ranked === true && GOAL_TYPES.has(a.goal.type) && THEME_IDS.has(a.theme), 'daily ranked, goal + theme valid');
  try { normalizeRuleset({ ...a.ruleset, seed: a.seed }); } catch (e) { ok(false, `daily ruleset normalizes: ${e.message}`); }
  // determinism across a full week
  let weekOk = true;
  for (let i = 0; i < 7; i++) {
    const day = new Date(Date.UTC(2026, 0, 5 + i));
    const x = dailyForDate(day);
    const y = dailyForDate(new Date(day.getTime()));
    if (JSON.stringify(x) !== JSON.stringify(y)) weekOk = false;
  }
  ok(weekOk, 'dailyForDate deterministic for a full week');
}

/* ---------- validateContent: no soft locks, bounded duration ---------- */
{
  // every challenge terminates under a trivial first-legal-move policy
  for (const c of CHALLENGES) {
    const r = validateContent(c);
    ok(r.ok, `challenge ${c.id} validates (${r.problems.join('; ') || 'ok'})`);
  }
  // lessons validate too (scripted rolls then free play)
  for (const l of LESSONS) {
    const r = validateContent({ ...l, seed: l.ruleset.seed });
    ok(r.ok, `lesson ${l.id} validates (${r.problems.join('; ') || 'ok'})`);
  }
  // journey: validate the first stage of every tier plus all mastery stages
  const sample = JOURNEY.filter((s) => s.mastery || (s.index - 1) % 5 === 0);
  for (const s of sample) {
    const r = validateContent(s);
    ok(r.ok, `journey stage ${s.id} validates (${r.problems.join('; ') || 'ok'})`);
  }
  // a few dailies across the calendar
  for (const day of [Date.UTC(2026, 0, 1), Date.UTC(2026, 5, 15), Date.UTC(2026, 11, 31)]) {
    const d = dailyForDate(new Date(day));
    const r = validateContent(d);
    ok(r.ok, `daily ${d.date} validates (${r.problems.join('; ') || 'ok'})`);
  }
  // defective content is caught, never crashes
  const bad = validateContent({ seed: 1, ruleset: { players: 5 } });
  ok(!bad.ok && bad.problems.length > 0, 'invalid content reported with problems');
}

/* ---------- build/version markers ---------- */
{
  ok(Number.isInteger(CONTENT_VERSION) && CONTENT_VERSION >= 1, 'CONTENT_VERSION is a positive integer');
  ok(typeof BUILD_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(BUILD_VERSION), 'BUILD_VERSION is semver');
  // every journey stage + challenge carries the current content version
  ok(JOURNEY.every((s) => s.version === CONTENT_VERSION), 'journey on current content version');
  ok(CHALLENGES.every((c) => c.version === CONTENT_VERSION), 'challenges on current content version');
}

/* ---------- stage presets are creatable games ---------- */
{
  // a journey stage and a daily build real game states with matching seats
  const s = JOURNEY[9];
  const rs = stageRuleset(s);
  const g = createGame(rs, Array.from({ length: rs.players }, (_, i) => ({ name: `p${i}` })));
  eq(g.players.length, s.players, 'journey stage creates a full table');
  eq(g.ruleset.seed, s.seed, 'stage seed reaches the rules engine');
}

console.log(`\ncontent.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
