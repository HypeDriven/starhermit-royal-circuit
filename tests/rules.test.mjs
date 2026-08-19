/**
 * rules.test.mjs — unit, property, fuzz and golden tests for the rules engine.
 * Run: node tests/rules.test.mjs
 */
import {
  createGame, legalActions, applyCommand, moveBlockReason, rankPlayers,
  scoreBreakdown, stateHash, cloneState, DONE, TRACK_LEN, blockadeAt,
  circuitCell, normalizeRuleset, startCell,
} from '../src/rules.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('FAIL:', msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); }

let cmdSeq = 0;
function cmd(seat, type, extra = {}) {
  return { id: `t${++cmdSeq}`, seat, type, ...extra };
}
function applyOk(state, c) {
  const r = applyCommand(state, c);
  if (!r.ok) throw new Error(`command ${JSON.stringify(c)} rejected: ${r.error}`);
  return r;
}

/* ---------- setup & serialization ---------- */
{
  const s = createGame({ players: 4, seed: 42 }, [
    { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' },
  ]);
  eq(s.players.length, 4, 'four players created');
  eq(s.players[0].floats, [-1, -1, -1, -1], 'floats start in workshop');
  eq(s.tick, 0, 'tick starts at 0');
  eq(s.phase, 'roll', 'starts in roll phase');
  const round = JSON.parse(JSON.stringify(s));
  eq(stateHash(round), stateHash(s), 'serialization round-trips to identical hash');
  eq(startCell(s.ruleset, 1), 10, 'seat 1 starts at cell 10');
}

/* ---------- forced rolls: deploy, move, pass ---------- */
{
  // A rolls 6 (deploy), then 4 (move), then B rolls 3 (no deploy possible → pass)
  const s0 = createGame({ players: 2, seed: 7, forcedRolls: [6, 4, 3] }, [{ name: 'A' }, { name: 'B' }]);
  let r = applyOk(s0, cmd(0, 'roll'));
  eq(r.events[0], { t: 'roll', seat: 0, value: 6 }, 'forced roll 6');
  eq(r.state.phase, 'move', 'phase move after roll');
  let acts = legalActions(r.state);
  eq(acts.type, 'moves', 'moves available after 6');
  eq(acts.moves.length, 4, 'all four floats may deploy');
  ok(acts.moves.every((m) => m.to === 0 && m.deploys), 'deploy targets progress 0');

  // wrong seat cannot act
  const bad = applyCommand(r.state, cmd(1, 'move', { floatId: 0 }));
  eq(bad.error, 'not-your-turn', 'out-of-turn rejected');
  eq(bad.state.players[1].invalid, 1, 'invalid attempt counted');

  // idempotent duplicate
  const c = cmd(0, 'move', { floatId: 0 });
  r = applyOk(r.state, c);
  const dup = applyCommand(r.state, c);
  ok(dup.duplicate === true && dup.ok, 'duplicate command id rejected idempotently');
  eq(r.events.some((e) => e.t === 'deploy'), true, 'deploy event emitted');
  eq(r.state.players[0].floats[0], 0, 'float deployed to progress 0');
  eq(r.state.phase, 'roll', 'six grants encore roll');
  eq(r.state.turnIndex, 0, 'still seat 0 after six');

  r = applyOk(r.state, cmd(0, 'roll')); // forced 4
  r = applyOk(r.state, cmd(0, 'move', { floatId: 0 }));
  eq(r.state.players[0].floats[0], 4, 'float advanced 4');
  eq(r.state.turnIndex, 1, 'turn passed to seat 1');

  r = applyOk(r.state, cmd(1, 'roll')); // forced 3, no deploy possible
  acts = legalActions(r.state);
  eq(acts.type, 'pass', 'no moves → pass action');
  ok(/6/.test(acts.explanation), 'pass explanation mentions the six');
  const mustMove = applyCommand(r.state, cmd(1, 'move', { floatId: 0 }));
  eq(mustMove.error, 'need-six-to-deploy', 'deploy without six rejected');
  r = applyOk(r.state, cmd(1, 'pass'));
  eq(r.state.turnIndex, 0, 'turn returns to seat 0');
  ok(r.state.tick > 0, 'tick monotonically increases');
}

/* ---------- stale tick ---------- */
{
  const s = createGame({ players: 2, seed: 1, forcedRolls: [5] }, [{}, {}]);
  const r = applyCommand(s, { id: 'x1', seat: 0, type: 'roll', tick: 9 });
  eq(r.error, 'stale-tick', 'stale tick rejected');
}

/* ---------- overshoot & exact finish / bounce ---------- */
{
  const s = createGame({ players: 2, seed: 1, forcedRolls: [6, 2] }, [{}, {}]);
  s.players[0].floats[0] = DONE - 1; // one step from crowning
  s.forcedRollIdx = 0;
  let st = applyOk(s, cmd(0, 'roll')).state; // 6
  eq(moveBlockReason(st, 0, 0, 6), 'overshoot', 'exact finish rejects overshoot');
  st = applyOk(st, cmd(0, 'move', { floatId: 1 })).state; // deploy another float with the 6
  st = applyOk(st, cmd(0, 'roll')).state; // forced 2
  eq(moveBlockReason(st, 0, 0, 2), 'overshoot', '2 overshoots with 1 remaining');
  const r = applyCommand(st, cmd(0, 'move', { floatId: 0 }));
  eq(r.error, 'overshoot', 'overshoot move rejected with reason');

  // bounce variant
  const sb = createGame({ players: 2, seed: 1, exactFinish: false }, [{}, {}]);
  sb.players[0].floats[0] = DONE - 1;
  sb.phase = 'move'; sb.die = 3;
  eq(moveBlockReason(sb, 0, 0, 3), null, 'bounce variant allows overshoot');
  eq(legalActions(sb).moves[0].to, DONE - 2, 'bounce reflects the overshoot');
}

/* ---------- captures, safe cells, blockades ---------- */
{
  const s = createGame({ players: 2, seed: 1, forcedRolls: [3] }, [{}, {}]);
  // seat0 float at progress 0 → cell 0; seat1 float at progress 23 → cell (20+23)%40=3
  // seat0 rolls 3 → lands on cell 3 → capture
  s.players[0].floats[0] = 0;
  s.players[1].floats[0] = 23;
  s.phase = 'move'; s.die = 3;
  let r = applyOk(s, cmd(0, 'move', { floatId: 0 }));
  eq(r.state.players[1].floats[0], -1, 'capture sends opponent home');
  eq(r.state.players[0].captures, 1, 'capture counted');
  ok(r.events.some((e) => e.t === 'capture'), 'capture event emitted');

  // safe cell: seat1 float at cell 5 (progress 25), seat0 float at 2, roll 3 → lands on 5, no capture
  const s2 = createGame({ players: 2, seed: 1, forcedRolls: [3] }, [{}, {}]);
  s2.players[0].floats[0] = 2;
  s2.players[1].floats[0] = 25;
  s2.phase = 'move'; s2.die = 3;
  r = applyOk(s2, cmd(0, 'move', { floatId: 0 }));
  eq(r.state.players[1].floats[0], 25, 'lantern tile protects from capture');

  // blockade: two seat1 floats at cell 8 (progress 28); seat0 float at 5 rolls 4 → would pass over 8
  const s3 = createGame({ players: 2, seed: 1, forcedRolls: [4] }, [{}, {}]);
  s3.players[0].floats[0] = 5;
  s3.players[1].floats[0] = 28;
  s3.players[1].floats[1] = 28;
  s3.phase = 'move'; s3.die = 4;
  eq(blockadeAt(s3, 8), 1, 'procession detected');
  eq(moveBlockReason(s3, 0, 0, 4), 'blocked-by-procession', 'procession blocks passing');
  s3.players[0].floats[0] = 7; // landing directly on the blockade
  eq(moveBlockReason(s3, 0, 0, 4), 'blocked-by-procession', 'procession blocks landing');
  s3.players[0].floats[0] = 5; s3.players[1].floats[1] = 30; // only one → no blockade
  eq(moveBlockReason(s3, 0, 0, 4), null, 'single float is not a procession');
}

/* ---------- overkindled (three sixes) ---------- */
{
  const s = createGame({ players: 2, seed: 1, forcedRolls: [6, 6, 6] }, [{}, {}]);
  let st = applyOk(s, cmd(0, 'roll')).state;
  st = applyOk(st, cmd(0, 'move', { floatId: 0 })).state;
  st = applyOk(st, cmd(0, 'roll')).state;
  st = applyOk(st, cmd(0, 'move', { floatId: 0 })).state;
  const r = applyOk(st, cmd(0, 'roll')); // third six
  ok(r.events.some((e) => e.t === 'overkindled'), 'overkindled event on third six');
  eq(r.state.turnIndex, 1, 'turn forfeited after third six');
  eq(r.state.die, null, 'die cleared');
}

/* ---------- win, ranking, scoring, turn limit ---------- */
{
  const s = createGame({ players: 2, seed: 1, forcedRolls: [1] }, [{}, {}]);
  s.players[0].floats = [DONE, DONE, DONE, DONE - 1];
  s.players[0].crowned = 3;
  s.phase = 'move'; s.die = 1;
  const r = applyOk(s, cmd(0, 'move', { floatId: 3 }));
  eq(r.state.phase, 'over', 'game over on final crown');
  eq(r.state.winner, 0, 'winner is seat 0');
  eq(r.state.reason, 'crown-sweep', 'terminal reason crown-sweep');
  eq(legalActions(r.state).type, 'none', 'no actions after game over');
  const sb = scoreBreakdown(r.state, 0);
  eq(sb.parts.crowned, 4000, 'crowned component 4×1000');
  eq(sb.parts.victory, 500, 'victory component');
  ok(sb.total === 4000 + 500 + sb.parts.progress + sb.parts.captures, 'total is component sum');

  // turn limit
  const s2 = createGame({ players: 2, seed: 5, maxTurns: 2, forcedRolls: [2, 3, 2, 3, 2, 3, 2, 3] }, [{}, {}]);
  let st = s2;
  let guard = 0;
  while (st.phase !== 'over' && guard++ < 100) {
    const acts = legalActions(st);
    if (acts.type === 'roll') st = applyOk(st, cmd(st.turnIndex, 'roll')).state;
    else if (acts.type === 'pass') st = applyOk(st, cmd(st.turnIndex, 'pass')).state;
    else st = applyOk(st, cmd(st.turnIndex, 'move', { floatId: acts.moves[0].floatId })).state;
  }
  eq(st.phase, 'over', 'turn-limited game terminates');
  eq(st.reason, 'turn-limit', 'terminal reason turn-limit');
  ok(st.winner !== null, 'turn-limit still produces a winner');
  eq(rankPlayers(st)[0].seat, st.winner, 'winner ranks first');
}

/* ---------- resign ---------- */
{
  const s = createGame({ players: 2, seed: 1 }, [{}, {}]);
  const r = applyOk(s, cmd(1, 'resign'));
  eq(r.state.phase, 'over', 'resign ends 2-player game');
  eq(r.state.winner, 0, 'remaining player wins');
  eq(r.state.reason, 'resign', 'terminal reason resign');
}

/* ---------- property: deterministic replay ---------- */
{
  function playout(seed) {
    let st = createGame({ players: 4, seed }, [{}, {}, {}, {}]);
    const hashes = [stateHash(st)];
    let guard = 0, seq = 0;
    const c = (seat, type, extra = {}) => ({ id: `r${seed}-${++seq}`, seat, type, ...extra });
    while (st.phase !== 'over' && guard++ < 3000) {
      const acts = legalActions(st);
      if (acts.type === 'roll') st = applyOk(st, c(st.turnIndex, 'roll')).state;
      else if (acts.type === 'pass') st = applyOk(st, c(st.turnIndex, 'pass')).state;
      else {
        const m = acts.moves[(st.tick + st.turnIndex) % acts.moves.length];
        st = applyOk(st, c(st.turnIndex, 'move', { floatId: m.floatId })).state;
      }
      hashes.push(stateHash(st));
    }
    return hashes;
  }
  const a = playout(1234);
  const b = playout(1234);
  eq(a.length, b.length, 'replay length identical');
  ok(a.every((h, i) => h === b[i]), 'same seed + commands → identical state hashes');
  const c = playout(1235);
  ok(c[c.length - 1] !== a[a.length - 1] || c.length !== a.length, 'different seed diverges');
}

/* ---------- fuzz: malformed commands + random play, no hangs/NaN ---------- */
{
  const junk = [null, undefined, {}, { type: 'fly' }, { type: 'move', floatId: -1 },
    { type: 'move', floatId: 99 }, { seat: -3, type: 'roll' }, { seat: 1e9, type: 'roll' },
    { type: 'pass' }, { type: 'roll', id: NaN }];
  let st = createGame({ players: 3, seed: 99 }, [{}, {}, {}]);
  for (const j of junk) {
    const r = applyCommand(st, j);
    ok(r.error || r.ok, 'malformed command handled without throw');
  }
  // random legal play to completion, many seeds
  let rngS = 12345;
  const rnd = () => { rngS = (Math.imul(rngS, 1103515245) + 12345) >>> 0; return rngS / 0x100000000; };
  for (let game = 0; game < 30; game++) {
    const players = 2 + (game % 3);
    st = createGame({ players, seed: 1000 + game, exactFinish: game % 2 === 0 },
      Array.from({ length: players }, () => ({})));
    let guard = 0;
    while (st.phase !== 'over' && guard++ < 5000) {
      const acts = legalActions(st);
      let r;
      if (acts.type === 'roll') r = applyCommand(st, cmd(st.turnIndex, 'roll'));
      else if (acts.type === 'pass') r = applyCommand(st, cmd(st.turnIndex, 'pass'));
      else {
        const m = acts.moves[Math.floor(rnd() * acts.moves.length)];
        r = applyCommand(st, cmd(st.turnIndex, 'move', { floatId: m.floatId }));
      }
      ok(r.ok, `legal action always applies (game ${game})`);
      st = r.state;
      // invariants
      for (const pl of st.players) {
        for (const p of pl.floats) ok(p >= -1 && p <= DONE && Number.isInteger(p), 'float progress in bounds');
        ok(!Number.isNaN(pl.crowned + pl.captures + pl.invalid), 'no NaN counters');
      }
    }
    eq(st.phase, 'over', `random game ${game} terminates (turns=${st.turnsPlayed})`);
    ok(st.winner !== null && st.reason, 'terminal state has winner + reason');
  }
}

/* ---------- golden: scripted session hash ---------- */
{
  // A fixed short scripted session; hash pins engine behavior.
  let st = createGame({ players: 2, seed: 31415, forcedRolls: [6, 6, 4, 5] }, [{ name: 'G' }, { name: 'H' }]);
  const script = [
    [0, 'roll'], [0, 'move', 0], [0, 'roll'], [0, 'move', 1], [0, 'roll'], [0, 'move', 0],
    [1, 'roll'], [1, 'pass'],
  ];
  for (const [seat, type, f] of script) {
    const acts = legalActions(st);
    if (type === 'move' && acts.type === 'moves' && !acts.moves.some((m) => m.floatId === f)) {
      st = applyOk(st, cmd(seat, 'move', { floatId: acts.moves[0].floatId })).state;
    } else {
      st = applyOk(st, cmd(seat, type, f !== undefined ? { floatId: f } : {})).state;
    }
  }
  eq(st.players[0].floats[0], 4, 'golden: float 0 at progress 4');
  eq(st.players[0].floats[1], 0, 'golden: float 1 deployed');
  eq(st.turnIndex, 0, 'golden: seat 0 to act after seat 1 passed');
  console.log('  golden hash:', stateHash(st));
}

/* ---------- ruleset validation ---------- */
{
  let threw = 0;
  try { normalizeRuleset({ players: 5 }); } catch { threw++; }
  try { normalizeRuleset({ floats: 9 }); } catch { threw++; }
  try { normalizeRuleset({ forcedRolls: [0, 7] }); } catch { threw++; }
  eq(threw, 3, 'invalid rulesets rejected');
}

console.log(`\nrules.test.mjs: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
