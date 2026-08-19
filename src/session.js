/**
 * session.js — game session controller.
 *
 * Owns one match lifecycle: setup → active ↔ paused → resolving → results.
 * - The only writer of rules state is applyCommand through this controller.
 * - Renders consume immutable snapshots + an interpolation event queue.
 * - Records a replay envelope: schema version, build/content version, seed,
 *   initial hash, ordered commands, periodic state hashes, terminal result.
 * - Undo (where rules permit: practice/learn) restores previous snapshots.
 * - AI turns are scheduled here, driven by the same legal-action API.
 */

import {
  createGame, cloneState, legalActions, applyCommand, stateHash,
  rankPlayers, scoreBreakdown, REASON_TEXT,
} from './rules.js';
import { chooseMove, aiName } from './ai.js';
import { CONTENT_VERSION, BUILD_VERSION } from './content.js';
import { storeSnapshot, clearSnapshot } from './save.js';

const HASH_EVERY = 10; // periodic state hashes in the replay envelope

export class Session {
  /**
   * @param opts {
   *   mode: 'learn'|'journey'|'daily'|'practice'|'challenge'|'hosted'|'local',
   *   ruleset, seed, players: [{name, kind, level?}],
   *   content?: content definition, lesson?: lesson def,
   *   ranked: bool, undoAllowed: bool,
   *   onEvent: (events, state) => void   — render/audio/hud hook
   * }
   */
  constructor(opts) {
    this.mode = opts.mode;
    this.content = opts.content || null;
    this.lesson = opts.lesson || null;
    this.ranked = !!opts.ranked;
    this.undoAllowed = !!opts.undoAllowed;
    this.onEvent = opts.onEvent || (() => {});
    this.startedAt = Date.now();
    this.endedAt = null;
    this.history = []; // snapshot stack for undo
    this.pendingTimer = null;
    this.paused = false; // UI pause: AI drive halts at the next decision point

    const players = opts.players.map((p, i) => ({
      name: p.name || (p.kind === 'ai' ? aiName(p.level || 1, i) : `Player ${i + 1}`),
      kind: p.kind,
      level: p.level,
    }));
    const ruleset = { ...opts.ruleset, seed: opts.seed };
    if (this.lesson?.initial) {
      // lesson preset: build state then patch floats
      this.state = createGame(ruleset, players);
      for (const [seat, arr] of Object.entries(this.lesson.initial.floats || {})) {
        const pl = this.state.players[Number(seat)];
        pl.floats = pl.floats.map((_, i) => (arr[i] !== undefined ? arr[i] : -1));
      }
    } else {
      this.state = createGame(ruleset, players);
    }
    this.envelope = {
      schema: 1,
      build: BUILD_VERSION,
      contentVersion: CONTENT_VERSION,
      mode: this.mode,
      seed: opts.seed,
      ruleset: this.state.ruleset,
      initialHash: stateHash(this.state),
      timestampOffset: 0,
      commands: [],
      hashes: [{ tick: 0, hash: stateHash(this.state) }],
      result: null,
    };
    this.lessonStep = 0;
  }

  get snapshot() { return this.state; }
  get actions() { return legalActions(this.state); }
  get currentPlayer() { return this.state.players[this.state.turnIndex]; }
  get isOver() { return this.state.phase === 'over'; }

  humanSeats() {
    return this.state.players.filter((p) => p.kind !== 'ai').map((p) => p.seat);
  }

  /** Validate + apply a player command. Returns {ok, error?, events}. */
  command(type, extra = {}, seat = this.state.turnIndex) {
    if (this.isOver) return { ok: false, error: 'game-over' };
    const cmd = {
      id: `${this.envelope.seed}:${this.state.tick}:${seat}:${type}:${extra.floatId ?? ''}`,
      tick: this.state.tick,
      seat, type, ...extra,
    };
    const r = applyCommand(this.state, cmd);
    if (!r.ok) {
      this.state = r.state; // invalid counter advanced (rules-owned)
      return { ok: false, error: r.error, errorText: REASON_TEXT[r.error] || r.error };
    }
    if (r.duplicate) return { ok: true, duplicate: true, events: [] };
    this.history.push(this.state);
    this.state = r.state;
    this.envelope.commands.push(cmd);
    if (this.state.tick % HASH_EVERY === 0) {
      this.envelope.hashes.push({ tick: this.state.tick, hash: stateHash(this.state) });
    }
    if (this.isOver && !this.endedAt) {
      this.endedAt = Date.now();
      this.envelope.result = this.results();
      clearSnapshot();
    } else {
      this.persistSnapshot();
    }
    this.onEvent(r.events, this.state);
    return { ok: true, events: r.events };
  }

  /** Undo one full human decision point (practice/learn only). */
  undo() {
    if (!this.undoAllowed || this.history.length === 0) return false;
    // Roll back to the most recent point where a human is to act.
    let snap = this.history.pop();
    while (this.history.length && snap.players[snap.turnIndex].kind === 'ai') {
      snap = this.history.pop();
    }
    this.state = snap;
    this.endedAt = null;
    this.envelope.commands.push({ id: `undo:${snap.tick}`, tick: snap.tick, seat: snap.turnIndex, type: 'undo-marker' });
    this.persistSnapshot();
    this.onEvent([{ t: 'undo' }], this.state);
    return true;
  }

  /** Drive AI turns until a human (or game over) is on move. Async-paced. */
  async driveAI(paceMs = 650) {
    while (!this.isOver && !this.paused && this.currentPlayer.kind === 'ai') {
      await new Promise((res) => { this.pendingTimer = setTimeout(res, paceMs); });
      this.pendingTimer = null;
      if (this.isOver) break;
      const acts = this.actions;
      const seat = this.state.turnIndex;
      if (acts.type === 'roll') {
        this.command('roll');
      } else if (acts.type === 'pass') {
        this.command('pass');
      } else if (acts.type === 'moves') {
        const level = this.currentPlayer.level || 1;
        const m = chooseMove(this.state, acts.moves, seat, level);
        this.command('move', { floatId: m.floatId });
      }
    }
  }

  cancelPending() {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null; }
  }

  /** Hint via the same legal-action API + master-level scorer. */
  hint() {
    const acts = this.actions;
    if (acts.type !== 'moves') return null;
    return chooseMove(this.state, acts.moves, this.state.turnIndex, 3);
  }

  elapsedMs() {
    return (this.endedAt || Date.now()) - this.startedAt;
  }

  /** Authoritative-style results with component breakdown + tie-breaks. */
  results() {
    const ranked = rankPlayers(this.state);
    const elapsed = this.elapsedMs();
    const rows = ranked.map((pl, i) => ({
      place: i + 1,
      seat: pl.seat,
      name: pl.name,
      kind: pl.kind,
      breakdown: scoreBreakdown(this.state, pl.seat),
      crowned: pl.crowned,
      captures: pl.captures,
      invalid: pl.invalid,
      resigned: pl.resigned,
    }));
    return {
      mode: this.mode,
      contentId: this.content?.id || this.lesson?.id || null,
      winner: this.state.winner,
      reason: this.state.reason,
      turns: this.state.turnsPlayed,
      elapsedMs: elapsed,
      rows,
      ranked: this.ranked,
      seed: this.envelope.seed,
    };
  }

  /** Goal evaluation for challenge/journey constraints. */
  goalStatus() {
    const goal = this.content?.goal;
    if (!goal || goal.type === 'win' || !this.isOver) {
      return { met: this.isOver && this.state.winner === this.primarySeat(), label: null };
    }
    const me = this.state.players[this.primarySeat()];
    const won = this.state.winner === me.seat;
    switch (goal.type) {
      case 'crown-first':
        return { met: me.crowned >= (goal.count || 1), label: `Crown ${goal.count || 1} float(s)` };
      case 'captures':
        return { met: me.captures >= goal.count, label: `${goal.count} captures` };
      case 'captures-then-win':
        return { met: won && me.captures >= goal.count, label: `Win with ${goal.count}+ captures` };
      case 'win-no-captures':
        return { met: won && me.captures === 0, label: 'Win without capturing' };
      default:
        return { met: won, label: null };
    }
  }

  primarySeat() { return 0; } // human seats start at 0 in solo modes

  persistSnapshot() {
    if (this.mode === 'hosted') return; // hosted snapshots come from the server
    storeSnapshot({
      mode: this.mode,
      contentId: this.content?.id || this.lesson?.id || null,
      state: this.state,
      envelope: this.envelope,
      startedAt: this.startedAt,
      undoAllowed: this.undoAllowed,
      ranked: this.ranked,
    });
  }

  /** Restore a persisted solo snapshot. */
  static restore(doc, onEvent) {
    const s = new Session({
      mode: doc.mode, ruleset: doc.state.ruleset, seed: doc.envelope.seed,
      players: doc.state.players.map((p) => ({ name: p.name, kind: p.kind })),
      ranked: doc.ranked, undoAllowed: doc.undoAllowed, onEvent,
    });
    s.state = doc.state;
    s.envelope = doc.envelope;
    s.startedAt = doc.startedAt;
    return s;
  }

  /** Verify a replay envelope reproduces the terminal state hash. */
  static verifyReplay(env) {
    let st = createGame(env.ruleset, env.ruleset.players
      ? Array.from({ length: env.ruleset.players }, (_, i) => ({ name: `p${i}` }))
      : []);
    // rebuild player kinds from nothing — replay only needs legality
    for (const c of env.commands) {
      if (c.type === 'undo-marker') continue;
      const r = applyCommand(st, { ...c, tick: undefined });
      if (!r.ok && !r.duplicate) return { ok: false, at: c, error: r.error };
      st = r.state;
    }
    const last = env.hashes[env.hashes.length - 1];
    return { ok: true, finalHash: stateHash(st), matches: last ? stateHash(st) === last.hash : null, state: st };
  }
}
