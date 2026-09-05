/**
 * rules.js — Royal Circuit rules engine.
 *
 * Pure deterministic state transitions, completely independent from rendering.
 * - legal-action queries:        legalActions(state)
 * - deterministic resolution:    applyCommand(state, cmd)
 * - serializable state:          plain JSON, includes its RNG stream state
 * - monotonically increasing tick: state.tick increments on every applied command
 * - terminal-state reason:       state.phase === 'over', state.reason
 *
 * Board model (original "Grand Circuit"):
 * - A shared circular circuit of TRACK_LEN=40 tiles.
 * - Each player enters at their start tile and must complete a full lap,
 *   then climb a private APPROACH_LEN=4 approach lane to be crowned.
 * - Float progress p: -1 = workshop (home), 0..39 = circuit (tile =
 *   (start + p) % 40), 40..43 = approach lane, 44 = crowned (DONE).
 * - Lantern tiles (SAFE_CELLS, every 5th tile) are safe: no captures and
 *   no blockades there; floats of any owner may share them.
 * - Two or more floats of one player on a non-safe circuit tile form a
 *   procession (blockade): opponents may neither land on nor pass over it.
 * - Rolling a 6 ("full kindle") deploys a float from the workshop and
 *   grants an extra roll. Three sixes in a row are "overkindled": the
 *   third roll is void and the turn passes.
 * - Captures send opponent floats back to their workshop.
 * - Crowned floats need an exact landing by default (variant: bounce-back).
 */

import { createStream, nextInt, hashState } from './rng.js';

export const TRACK_LEN = 40;
export const APPROACH_LEN = 4;
export const MAX_FLOATS = 4;
export const DONE = TRACK_LEN + APPROACH_LEN; // 44 — crowned
export const SAFE_CELLS = Object.freeze([0, 5, 10, 15, 20, 25, 30, 35]);

export const START_CELLS = Object.freeze({
  2: Object.freeze([0, 20]),
  3: Object.freeze([0, 10, 20]),
  4: Object.freeze([0, 10, 20, 30]),
});

/** Player identity palette (also used for shapes/icons in presentation). */
export const PLAYER_DEFS = Object.freeze([
  { key: 'vermilion', name: 'Vermilion', color: 0xd93a2b, shape: 'round' },
  { key: 'jade', name: 'Jade', color: 0x1f9d55, shape: 'square' },
  { key: 'azure', name: 'Azure', color: 0x2470c8, shape: 'tri' },
  { key: 'gilded', name: 'Gilded', color: 0xd9a416, shape: 'hex' },
]);

export const RULES_VERSION = 1;

/** Normalize + validate a ruleset. Throws on invalid combinations. */
export function normalizeRuleset(opts = {}) {
  const players = opts.players ?? 4;
  if (![2, 3, 4].includes(players)) throw new Error('ruleset.players must be 2, 3 or 4');
  const floats = opts.floats ?? MAX_FLOATS;
  if (floats < 2 || floats > MAX_FLOATS) throw new Error('ruleset.floats must be 2..4');
  const rs = {
    players,
    floats,
    exactFinish: opts.exactFinish !== false,
    blockades: opts.blockades !== false,
    safeTrack: opts.safeTrack !== false,
    captures: opts.captures !== false,
    maxTurns: Math.max(0, opts.maxTurns | 0), // rounds per player; 0 = unlimited
    seed: (opts.seed ?? 1) >>> 0,
  };
  // Optional early-finish goal: a player who first crowns `count` floats wins
  // immediately (used by journey "Be first to crown N float(s)" stages).
  if (opts.goal && opts.goal.type === 'crown-first') {
    rs.goal = { type: 'crown-first', count: Math.max(1, opts.goal.count | 0) };
  }
  if (Array.isArray(opts.forcedRolls)) {
    if (!opts.forcedRolls.every((v) => Number.isInteger(v) && v >= 1 && v <= 6)) {
      throw new Error('forcedRolls must be die faces 1..6');
    }
    rs.forcedRolls = opts.forcedRolls.slice();
  }
  return rs;
}

export function startCell(ruleset, seat) {
  return START_CELLS[ruleset.players][seat];
}

export function isSafeCell(ruleset, absCell) {
  return ruleset.safeTrack && SAFE_CELLS.includes(((absCell % TRACK_LEN) + TRACK_LEN) % TRACK_LEN);
}

/** Absolute circuit tile for progress p of seat; null if not on the circuit. */
export function circuitCell(ruleset, seat, p) {
  if (p < 0 || p >= TRACK_LEN) return null;
  return (startCell(ruleset, seat) + p) % TRACK_LEN;
}

/**
 * Create the initial game state.
 * players: [{ name, kind: 'human'|'ai'|'remote' }] length === ruleset.players
 */
export function createGame(rulesetOpts, players) {
  const ruleset = normalizeRuleset(rulesetOpts);
  if (!Array.isArray(players) || players.length !== ruleset.players) {
    throw new Error('players array must match ruleset.players');
  }
  const state = {
    version: RULES_VERSION,
    ruleset,
    rng: createStream(ruleset.seed),
    forcedRollIdx: 0,
    tick: 0,
    turnIndex: 0,
    round: 1,
    turnsPlayed: 0,
    phase: 'roll',
    die: null,
    sixes: 0,
    players: players.map((p, i) => ({
      seat: i,
      name: p.name || PLAYER_DEFS[i].name,
      kind: p.kind || 'human',
      color: i,
      floats: new Array(ruleset.floats).fill(-1),
      crowned: 0,
      captures: 0,
      invalid: 0,
      resigned: false,
    })),
    winner: null,
    reason: null,
    lastCommandId: null,
  };
  return state;
}

/** Deep clone (state is plain JSON). */
export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

export function stateHash(state) {
  return hashState(state);
}

/** Next non-resigned seat after `seat`. */
function nextSeat(state, seat) {
  const n = state.players.length;
  for (let i = 1; i <= n; i++) {
    const s = (seat + i) % n;
    if (!state.players[s].resigned) return s;
  }
  return seat;
}

export function activePlayers(state) {
  return state.players.filter((p) => !p.resigned);
}

/** Count a player's floats sitting on absolute circuit tile `cell`. */
export function floatsOnCell(state, seat, cell) {
  const pl = state.players[seat];
  let n = 0;
  for (const p of pl.floats) {
    if (circuitCell(state.ruleset, seat, p) === cell) n++;
  }
  return n;
}

/**
 * Opponent blockade on a circuit tile: 2+ floats of one opponent on a
 * non-safe tile (blockades disabled → never). Returns blocking seat or -1.
 */
export function blockadeAt(state, cell) {
  if (!state.ruleset.blockades) return -1;
  if (isSafeCell(state.ruleset, cell)) return -1;
  for (const pl of state.players) {
    if (pl.resigned) continue;
    if (floatsOnCell(state, pl.seat, cell) >= 2) return pl.seat;
  }
  return -1;
}

/** Opponent floats exactly on a circuit tile: [{seat, floatId}]. */
export function opponentsOnCell(state, seat, cell) {
  const out = [];
  for (const pl of state.players) {
    if (pl.seat === seat || pl.resigned) continue;
    pl.floats.forEach((p, i) => {
      if (circuitCell(state.ruleset, pl.seat, p) === cell) out.push({ seat: pl.seat, floatId: i });
    });
  }
  return out;
}

/**
 * Why can't this float move with this roll? Returns a reason code or null
 * if the move is legal. Codes (unit-tested):
 *  'game-over' | 'need-six-to-deploy' | 'already-crowned' |
 *  'overshoot' | 'blocked-by-procession' | null
 */
export function moveBlockReason(state, seat, floatId, roll) {
  if (state.phase === 'over') return 'game-over';
  const pl = state.players[seat];
  const p = pl.floats[floatId];
  if (p === undefined) return 'unknown-float';
  if (p === DONE) return 'already-crowned';
  if (p === -1) return roll === 6 ? null : 'need-six-to-deploy';
  let target = p + roll;
  if (target > DONE) {
    if (!state.ruleset.exactFinish) {
      target = 2 * DONE - target; // bounce-back variant
    } else {
      return 'overshoot';
    }
  }
  // Processions block the path on circuit tiles (including the landing tile).
  const start = startCell(state.ruleset, seat);
  const from = Math.max(p + 1, 0);
  for (let t = from; t <= Math.min(target, TRACK_LEN - 1); t++) {
    const cell = (start + t) % TRACK_LEN;
    const blocker = blockadeAt(state, cell);
    if (blocker !== -1 && blocker !== seat) return 'blocked-by-procession';
  }
  return null;
}

/** Resolve the target progress for a legal move (handles bounce variant). */
export function moveTarget(state, seat, floatId, roll) {
  const p = state.players[seat].floats[floatId];
  if (p === -1) return 0;
  let target = p + roll;
  if (target > DONE && !state.ruleset.exactFinish) target = 2 * DONE - target;
  return target;
}

/**
 * The legal-action API used by play, tutorials and hints alike.
 * Returns one of:
 *  { type:'none', reason:'game-over' }
 *  { type:'roll', seat }
 *  { type:'pass', seat, explanation }
 *  { type:'moves', seat, die, moves:[{floatId, from, to, deploys, crowns, captures:[..]}] }
 */
export function legalActions(state) {
  if (state.phase === 'over') return { type: 'none', reason: 'game-over' };
  const seat = state.turnIndex;
  if (state.phase === 'roll') return { type: 'roll', seat };
  const pl = state.players[seat];
  const die = state.die;
  const moves = [];
  for (let i = 0; i < pl.floats.length; i++) {
    if (moveBlockReason(state, seat, i, die) !== null) continue;
    const from = pl.floats[i];
    const to = moveTarget(state, seat, i, die);
    const cell = circuitCell(state.ruleset, seat, to);
    const captures =
      cell !== null && state.ruleset.captures && !isSafeCell(state.ruleset, cell)
        ? opponentsOnCell(state, seat, cell).filter(() => blockadeAt(state, cell) === -1)
        : [];
    moves.push({
      floatId: i,
      from,
      to,
      deploys: from === -1,
      crowns: to === DONE,
      captures,
    });
  }
  if (moves.length === 0) {
    return {
      type: 'pass',
      seat,
      explanation: explainNoMoves(state, seat, die),
    };
  }
  return { type: 'moves', seat, die, moves };
}

function explainNoMoves(state, seat, die) {
  const pl = state.players[seat];
  const reasons = new Set();
  pl.floats.forEach((_, i) => {
    const r = moveBlockReason(state, seat, i, die);
    if (r) reasons.add(r);
  });
  if (reasons.size === 1) {
    const r = [...reasons][0];
    if (r === 'need-six-to-deploy') return 'All floats are in the workshop — only a 6 can kindle one.';
    if (r === 'overshoot') return 'Every float would overshoot the crown — the roll must fit exactly.';
    if (r === 'blocked-by-procession') return 'Every path is blocked by an opposing procession.';
    if (r === 'already-crowned') return 'All floats are already crowned.';
  }
  return 'No float can use this roll.';
}

/* ------------------------------------------------------------------ */
/* Command application                                                 */
/* ------------------------------------------------------------------ */

/**
 * Validate and apply a command. Never mutates `state`; returns
 * { ok, state, events, error?, duplicate? }.
 * cmd: { id, tick?, seat, type:'roll'|'move'|'pass'|'resign', floatId? }
 */
export function applyCommand(state, cmd) {
  if (!cmd || typeof cmd !== 'object') return fail(state, 'bad-command');
  if (cmd.id != null && cmd.id === state.lastCommandId) {
    return { ok: true, duplicate: true, state, events: [] }; // idempotent
  }
  if (cmd.tick != null && cmd.tick !== state.tick) return fail(state, 'stale-tick');
  if (state.phase === 'over' && cmd.type !== 'resign') return fail(state, 'game-over');
  const seat = cmd.seat;
  if (!Number.isInteger(seat) || seat < 0 || seat >= state.players.length) return fail(state, 'bad-seat');

  let next = cloneState(state);
  const events = [];
  let err = null;

  switch (cmd.type) {
    case 'roll': err = applyRoll(next, seat, events); break;
    case 'move': err = applyMove(next, seat, cmd.floatId, events); break;
    case 'pass': err = applyPass(next, seat, events); break;
    case 'resign': err = applyResign(next, seat, events); break;
    default: return fail(state, 'bad-command');
  }
  if (err) {
    if (Number.isInteger(seat) && state.players[seat]) {
      // invalid attempts are counted for tie-breaks, on the returned state
      next = cloneState(state);
      next.players[seat].invalid += 1;
      next.tick += 1;
      next.lastCommandId = cmd.id ?? state.lastCommandId;
    }
    return { ok: false, error: err, state: next, events: [] };
  }
  next.tick += 1;
  next.lastCommandId = cmd.id ?? state.lastCommandId;
  return { ok: true, state: next, events };
}

function fail(state, error) {
  return { ok: false, error, state, events: [] };
}

function applyRoll(state, seat, events) {
  if (state.phase !== 'roll') return 'phase-mismatch';
  if (seat !== state.turnIndex) return 'not-your-turn';
  let value;
  if (state.ruleset.forcedRolls && state.forcedRollIdx < state.ruleset.forcedRolls.length) {
    value = state.ruleset.forcedRolls[state.forcedRollIdx++];
  } else {
    value = nextInt(state.rng, 6) + 1;
  }
  state.die = value;
  events.push({ t: 'roll', seat, value });
  if (value === 6) {
    state.sixes += 1;
    if (state.sixes >= 3) {
      events.push({ t: 'overkindled', seat });
      endTurn(state, events, 'overkindled');
      return null;
    }
  }
  state.phase = 'move'; // if no moves exist, an explicit pass is still required
  return null;
}

function applyMove(state, seat, floatId, events) {
  if (state.phase !== 'move') return 'phase-mismatch';
  if (seat !== state.turnIndex) return 'not-your-turn';
  const pl = state.players[seat];
  if (!Number.isInteger(floatId) || floatId < 0 || floatId >= pl.floats.length) return 'unknown-float';
  const reason = moveBlockReason(state, seat, floatId, state.die);
  if (reason) return reason;

  const from = pl.floats[floatId];
  const to = moveTarget(state, seat, floatId, state.die);
  pl.floats[floatId] = to;
  events.push({ t: 'move', seat, floatId, from, to, die: state.die });
  if (from === -1) events.push({ t: 'deploy', seat, floatId });

  // Captures on the landing circuit tile.
  const cell = circuitCell(state.ruleset, seat, to);
  if (cell !== null && state.ruleset.captures && !isSafeCell(state.ruleset, cell)) {
    for (const vic of opponentsOnCell(state, seat, cell)) {
      state.players[vic.seat].floats[vic.floatId] = -1;
      pl.captures += 1;
      events.push({ t: 'capture', bySeat: seat, seat: vic.seat, floatId: vic.floatId, cell });
    }
  }
  if (to === DONE) {
    pl.crowned += 1;
    events.push({ t: 'crown', seat, floatId });
  }

  if (checkTerminal(state, events)) return null;

  if (state.die === 6) {
    state.phase = 'roll'; // encore roll
    state.die = null;
    events.push({ t: 'encore', seat });
  } else {
    endTurn(state, events, 'moved');
  }
  return null;
}

function applyPass(state, seat, events) {
  if (state.phase !== 'move') return 'phase-mismatch';
  if (seat !== state.turnIndex) return 'not-your-turn';
  const acts = legalActions(state);
  if (acts.type === 'moves') return 'must-move';
  events.push({ t: 'pass', seat, reason: acts.explanation || 'no legal moves' });
  endTurn(state, events, 'passed');
  return null;
}

function applyResign(state, seat, events) {
  if (state.phase === 'over') return 'game-over';
  const pl = state.players[seat];
  if (pl.resigned) return 'bad-command';
  pl.resigned = true;
  events.push({ t: 'resign', seat });
  const alive = activePlayers(state);
  if (alive.length === 1) {
    finish(state, alive[0].seat, 'resign', events);
    return null;
  }
  if (seat === state.turnIndex) endTurn(state, events, 'resigned');
  return null;
}

function endTurn(state, events, why) {
  state.turnsPlayed += 1;
  state.die = null;
  state.sixes = 0;
  const prev = state.turnIndex;
  state.turnIndex = nextSeat(state, prev);
  if (state.turnIndex <= prev) state.round += 1;
  state.phase = 'roll';
  events.push({ t: 'turn', seat: state.turnIndex, round: state.round, why });
  checkTerminal(state, events);
}

function checkTerminal(state, events) {
  // Early-finish goal: a player who is first to crown `count` floats wins.
  // (Journey "Be first to crown N float(s)" stages end as soon as the goal
  // is reached, rather than waiting for a full crown-sweep.)
  const goal = state.ruleset.goal;
  if (goal && goal.type === 'crown-first') {
    for (const pl of state.players) {
      if (!pl.resigned && pl.crowned >= goal.count) {
        finish(state, pl.seat, 'crown-first', events);
        return true;
      }
    }
  }
  // Crown sweep: a player crowned every float.
  for (const pl of state.players) {
    if (!pl.resigned && pl.floats.every((p) => p === DONE)) {
      finish(state, pl.seat, 'crown-sweep', events);
      return true;
    }
  }
  // Turn limit (challenge/daily bounded duration).
  const mt = state.ruleset.maxTurns;
  if (mt > 0 && state.turnsPlayed >= mt * state.players.length) {
    finish(state, rankPlayers(state)[0].seat, 'turn-limit', events);
    return true;
  }
  return false;
}

function finish(state, winner, reason, events) {
  state.phase = 'over';
  state.winner = winner;
  state.reason = reason;
  state.die = null;
  events.push({ t: 'gameover', winner, reason });
}

/** Total progress of a float for ranking: crowned counts as DONE. */
function floatProgress(p) {
  return p < 0 ? 0 : Math.min(p, DONE);
}

/**
 * Ranking with the spec tie-break order: primary objective completion
 * (crowned count), then fewer invalid actions, then total track progress,
 * then stable seat order. (Elapsed time is layered on by the session,
 * which owns the clock.)
 */
export function rankPlayers(state) {
  return state.players
    .slice()
    .sort((a, b) => {
      if (b.crowned !== a.crowned) return b.crowned - a.crowned;
      if (a.invalid !== b.invalid) return a.invalid - b.invalid;
      const pa = a.floats.reduce((s, p) => s + floatProgress(p), 0);
      const pb = b.floats.reduce((s, p) => s + floatProgress(p), 0);
      if (pb !== pa) return pb - pa;
      return a.seat - b.seat;
    });
}

/**
 * Component score breakdown (integers; formatting is a presentation concern).
 */
export function scoreBreakdown(state, seat) {
  const pl = state.players[seat];
  const progress = pl.floats.reduce((s, p) => s + floatProgress(p), 0);
  const win = state.winner === seat;
  const parts = {
    crowned: pl.crowned * 1000,
    progress: progress * 10,
    captures: pl.captures * 50,
    victory: win ? 500 : 0,
    invalidPenalty: pl.invalid * -25,
  };
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, total, win };
}

/** Reason codes surfaced to players (kept stable for tests + i18n). */
export const REASON_TEXT = Object.freeze({
  'not-your-turn': 'It is not your turn.',
  'phase-mismatch': 'That action is not available right now.',
  'unknown-float': 'That float does not exist.',
  'need-six-to-deploy': 'A float needs a 6 to leave the workshop.',
  'already-crowned': 'That float is already crowned.',
  overshoot: 'The roll overshoots the crown — it must fit exactly.',
  'blocked-by-procession': 'An opposing procession blocks the way.',
  'must-move': 'You have a legal move, so you cannot pass.',
  'game-over': 'The game is over.',
  'stale-tick': 'The game has moved on — refresh the state.',
  'bad-command': 'That command is not valid.',
  'bad-seat': 'Unknown player seat.',
});
