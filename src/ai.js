/**
 * ai.js — deterministic practice AI.
 *
 * Difficulty is measured by decision depth and information use, not by
 * altering the die: all levels see the same rolls.
 *  1 'casual'  — random legal move (seeded stream)
 *  2 'skilled' — one-ply heuristic: captures, crowns, safety, danger
 *  3 'master'  — skilled + opponent-reply danger model + procession sense
 *
 * The AI consumes its own seeded stream derived from the game seed, so a
 * given seed + command history always produces identical games.
 */

import { createStream, nextInt, nextFloat } from './rng.js';
import {
  circuitCell, isSafeCell, blockadeAt, opponentsOnCell, floatsOnCell,
  DONE, TRACK_LEN,
} from './rules.js';

export const AI_LEVELS = Object.freeze([
  { level: 1, key: 'casual', name: 'Casual' },
  { level: 2, key: 'skilled', name: 'Skilled' },
  { level: 3, key: 'master', name: 'Master' },
]);

export function aiStream(seed, tick, seat) {
  return createStream(((seed >>> 0) ^ Math.imul(tick + 1, 0x9e3779b9) ^ Math.imul(seat + 7, 0x85ebca6b)) >>> 0);
}

/** Choose a move from legalActions(type 'moves'). Deterministic. */
export function chooseMove(state, moves, seat, level) {
  const st = aiStream(state.ruleset.seed, state.tick, seat);
  if (moves.length === 1) return moves[0];
  if (level <= 1) return moves[nextInt(st, moves.length)];

  let best = null, bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(state, seat, m, level, st);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

function scoreMove(state, seat, m, level, st) {
  const rs = state.ruleset;
  const me = state.players[seat];
  const from = m.from, to = m.to;
  let score = nextFloat(st) * 0.5; // seeded tiebreak jitter

  // Terminal and high-value outcomes first.
  if (m.crowns) score += 120;
  if (m.captures.length) score += 60 * m.captures.length;
  if (m.deploys) score += 35;

  // Progress: prefer advancing floats that are already far (race pressure),
  // but not at the expense of the above.
  score += Math.min(to, DONE) * 0.6;

  const landingCell = circuitCell(rs, seat, to);
  if (landingCell !== null) {
    // Safety of the landing tile.
    if (isSafeCell(rs, landingCell)) score += 18;
    // Forming or joining a procession is strong defense.
    if (rs.blockades && !isSafeCell(rs, landingCell)) {
      const own = floatsOnCell(state, seat, landingCell) + 1; // after move
      if (own >= 2) score += 22;
    }
    // Danger: can an opponent capture this tile on their next turn?
    if (!isSafeCell(rs, landingCell) && rs.captures) {
      const threat = threatOnCell(state, seat, landingCell, level >= 3);
      if (threat > 0) score -= 30 * threat;
    }
    // Leaving a threatened tile is worth something.
    const fromCell = circuitCell(rs, seat, from);
    if (fromCell !== null && !isSafeCell(rs, fromCell) && rs.captures) {
      if (threatOnCell(state, seat, fromCell, false) > 0) score += 12;
    }
  } else if (to > TRACK_LEN - 1 && to < DONE) {
    score += 15; // entering the private approach: fully safe
  }

  if (level >= 3) {
    // Master: value capturing floats by their progress, avoid breaking own
    // processions, and prefer keeping a deploy option when rivals near start.
    for (const c of m.captures) {
      const vp = state.players[c.seat].floats[c.floatId];
      score += Math.max(0, vp) * 0.5;
    }
    const fromCell = circuitCell(rs, seat, from);
    if (fromCell !== null && rs.blockades && !isSafeCell(rs, fromCell)) {
      if (floatsOnCell(state, seat, fromCell) >= 2) score -= 26; // breaking a wall
    }
    // Don't stack more than 2 (wasted wall).
    if (landingCell !== null && floatsOnCell(state, seat, landingCell) >= 2) score -= 8;
    // Late game: push the leader float hard.
    const maxOwn = Math.max(...me.floats.map((p) => (p < 0 ? 0 : p)));
    if (from === maxOwn && me.crowned >= 1) score += 10;
  }
  return score;
}

/**
 * How many opponent floats could plausibly capture on `cell` next turn?
 * withRange=false: any die 1..6 reach counts as one threat.
 * withRange=true (master): weight by reachability window 1..6 and require
 * the path to be clear of processions (approximate).
 */
function threatOnCell(state, seat, cell, withRange) {
  let threats = 0;
  for (const pl of state.players) {
    if (pl.seat === seat || pl.resigned) continue;
    for (const p of pl.floats) {
      const c = circuitCell(state.ruleset, pl.seat, p);
      if (c === null) continue;
      const dist = (cell - c + TRACK_LEN) % TRACK_LEN;
      if (dist >= 1 && dist <= 6) {
        if (withRange) {
          // rough path check: any blockade between reduces threat
          let blocked = false;
          for (let t = 1; t <= dist; t++) {
            if (blockadeAt(state, (c + t) % TRACK_LEN) !== -1) { blocked = true; break; }
          }
          threats += blocked ? 0.2 : 1;
        } else {
          threats += 1;
        }
      }
    }
  }
  return threats;
}

/** Short explanation of an AI-free hint for humans: reuse the same scorer. */
export function hintMove(state, moves, seat) {
  if (!moves.length) return null;
  return chooseMove(state, moves, seat, 3);
}

/** AI display names per level. */
export function aiName(level, idx) {
  const names = {
    1: ['Paper Crane', 'Tea Monk', 'Kite Child'],
    2: ['Lantern Keeper', 'Drum Major', 'Silk Dancer'],
    3: ['Pavilion Sage', 'Ember Herald', 'Moon Regent'],
  };
  const list = names[level] || names[1];
  return list[idx % list.length];
}
