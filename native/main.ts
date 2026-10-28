// Royal Circuit on the StarHermit engine: the entry module (starhermit.txt
// engine.entry), played natively by the StarHermit client and in browsers by
// the engine's web runtime. The rules (src/rules.js), AI (src/ai.js),
// content (src/content.js), session (src/session.js: validated commands,
// undo, replay envelope, snapshots), board layout and save model are the
// browser build's, unchanged; this module is what src/ui.js did around them
// as the game controller: the screen flow (title → setup / journey / learn /
// challenges → the match ⇄ pause → results), starting every mode (Practice,
// Daily Circuit, Journey, Learn, Challenges), the turn flow (roll, choose a
// float, pass, undo, the hint) by keys, pads, pointer and touch, the AI's
// paced turns, the lesson coach, progression, achievements, the local boards
// and the score post, the deterministic replay, "Resume saved game", the
// board's text mirror and the lifecycle (a hidden window pauses the match,
// as visibilitychange did). Screens are drawn by screens.ts (starhermit:ui),
// the pavilion by render.ts (starhermit:scene).
//
// Time is the runtime's fixed steps: the AI's pacing (650 ms, 1100 with
// timing assistance), the event playback's tweens, the banners, captions and
// toasts and the replay run on a clock advanced 1/60 s per fixed step, so
// slow frames never change a match and play scripts replay exactly.
import { clipboard, frame, onFixedUpdate, onPreferencesChange, onRender, onResume, onStart, onSuspend, onUpdate, preferences, setFixedRate } from "starhermit:engine";
import { onAction, onPointerButton, onPointerMove, onTouch, primaryPointer, vibrate } from "starhermit:input";
import * as ui from "starhermit:ui";
import { onSessionEnded, requestSignIn } from "starhermit:platform";
import {
  AI, Content, Layout, Rules, SaveModel, SessionCtor,
  type GameEvent, type Lesson, type Move, type Results, type Session, type SessionOpts, type Snapshot, type Stage, type State,
} from "./game.ts";
import * as audio from "./audio.ts";
import { N, S, T, pname } from "./i18n.ts";
import * as platform from "./platform.ts";
import { lookFor } from "./quality.ts";
import * as render from "./render.ts";
import { drawScreens } from "./screens.ts";
import { applyTokens, initStyles } from "./style.ts";

export type Screen = "title" | "setup" | "journey" | "learn" | "challenge" | "game";
export type Overlay = "pause" | "settings" | "results" | "help" | "achievements" | "boards" | "profile" | "boardstate" | "confirm";
export type Mode = "practice" | "daily" | "journey" | "learn" | "challenge" | "local" | "replay";
export interface SetupCfg { players: number; aiLevel: number; humans: number; floats: number; exactFinish: boolean; blockades: boolean; safeTrack: boolean }
export interface ResultsView { lessonOnly: boolean; results: Results; newAch: string[] }
export interface Lb { state: "posting" | "failed" | "posted"; rank?: number | null }

export const app = {
  screen: "title" as Screen,
  overlays: [] as Overlay[],
  openedFrame: 0,
  focusNext: null as string | null,
  session: null as Session | null,
  mode: null as Mode | null,
  content: null as Stage | null,
  lesson: null as Lesson | null,
  setupCfg: null as SetupCfg | null,
  lastGameOpts: null as Omit<SessionOpts, "onEvent"> | null,
  paused: false,
  inputLocked: false,
  replay: null as null | { real: Session; idx: number; nextAt: number },
  lessonStepIdx: 0,
  lessonFinishAt: 0,
  capturedThisGame: 0,
  lastEvents: null as GameEvent[] | null,
  resultsView: null as ResultsView | null,
  lb: null as Lb | null,
  confirm: null as null | { text: string; yes: () => void; no: () => void },
  boardsTab: "daily" as "daily" | "best",
  board: null as platform.BoardRow[] | null | "loading",
  pickIdx: 0,
  selection: null as { seat: number; floatId: number } | null,
  railOpen: null as "left" | "right" | null,
  resumeSnap: null as Snapshot | null,
  resumeUntil: 0,
  resumeOffered: false,
  toasts: [] as { text: string; kind: "info" | "error"; until: number }[],
  banner: null as { text: string; until: number } | null,
  caption: null as { text: string; until: number } | null,
  coach: "",
};
let clockMs = 0;
let epoch = 0;
/** The fixed-step clock (ms since start). */
export const nowMs = (): number => clockMs;
export const fresh = (): boolean => frame().frame !== app.openedFrame;

// ------------------------------------------------------------------ helpers
const spoken: string[] = [];
let spokenAssertive = false;
/** The live regions (objective, turn, score, errors, results): one announcement a frame, joined. */
export function announce(text: string, assertive = false): void {
  if (!text) return;
  spoken.push(text);
  spokenAssertive ||= assertive;
}
function flushAnnouncements(): void {
  if (!spoken.length) return;
  const text = spoken.splice(-4).join(" ").slice(0, 500);
  spoken.length = 0;
  try { ui.announce(text, { politeness: spokenAssertive ? "assertive" : "polite" }); } catch { /* busy */ }
  spokenAssertive = false;
}
export function toast(text: string, kind: "info" | "error" = "info", ms = 3400): void {
  app.toasts.push({ text, kind, until: clockMs + ms });
  if (app.toasts.length > 4) app.toasts.shift();
}
const pending: (() => void)[] = [];
/** A widget's press, run once the frame's UI is built (state changes mid-build would break later widgets). */
export function later(fn: () => void): void { pending.push(fn); }
function haptic(ms: number): void { try { vibrate(ms); } catch { /* none */ } }
const timing = (): boolean => platform.options.timingAssist;
export function theme(): ReturnType<typeof Content.themeById> { return Content.themeById(platform.options.theme); }

/** The player's display name: account nickname when signed in, the local name otherwise. */
export function displayName(): string {
  return (platform.signedIn() && platform.displayName()) || pname(platform.save().profile.name);
}

// ------------------------------------------------------------------ screens and overlays
export function topOverlay(): Overlay | null { return app.overlays[app.overlays.length - 1] ?? null; }
export function showOverlay(o: Overlay, focus: string | null = null): void {
  if (topOverlay() !== o) app.overlays.push(o);
  app.openedFrame = frame().frame;
  app.focusNext = focus;
  ui.setFocus(null);
}
export function hideOverlay(o: Overlay): void {
  const i = app.overlays.lastIndexOf(o);
  if (i < 0) return;
  app.overlays.splice(i, 1);
  app.openedFrame = frame().frame;
  if (o === "confirm" && app.confirm) { const c = app.confirm; app.confirm = null; c.no(); }
  // Dismissing the pause panel (Escape) also leaves the paused state.
  if (o === "pause" && app.paused) resumeGame();
  ui.setFocus(null);
}
function hideAllOverlays(): void { app.overlays = []; app.confirm = null; }
function showScreen(s: Screen, focus: string | null = null): void {
  app.screen = s;
  app.openedFrame = frame().frame;
  app.focusNext = focus ?? (primaryPointer() === "coarse" ? null : null);
  app.railOpen = null;
  ui.setFocus(null);
}
/** `text` is an English source string; it is translated where shown. */
export function confirmDialog(text: string, yes: () => void, no: () => void = () => undefined): void {
  app.confirm = { text, yes, no };
  showOverlay("confirm");
}
export function confirmYes(): void {
  const c = app.confirm;
  app.confirm = null;
  const i = app.overlays.lastIndexOf("confirm");
  if (i >= 0) app.overlays.splice(i, 1);
  app.openedFrame = frame().frame;
  c?.yes();
}

// ------------------------------------------------------------------ title + mode setup
export function showTitle(): void {
  hideAllOverlays();
  showScreen("title");
  audio.setMusic("title");
  const snap = SaveModel.loadSnapshot();
  if (snap && snap.state && snap.state.phase !== "over" && !app.resumeOffered) {
    app.resumeOffered = true;
    app.resumeSnap = snap;
    app.resumeUntil = clockMs + 30000;
  }
}
export function resumeAvailable(): boolean { return !!app.resumeSnap && clockMs < app.resumeUntil; }
export function resumeSnapshot(): void {
  const snap = app.resumeSnap;
  app.resumeSnap = null;
  if (!snap) return;
  try {
    const def = snap.contentId ? findContent(snap.contentId) : null;
    app.lesson = snap.mode === "learn" ? (def as Lesson | null) : null;
    app.content = snap.mode === "learn" ? null : (def as Stage | null);
    app.session = SessionCtor.restore(snap, onSessionEvent, { content: app.content, lesson: app.lesson, now: sessionNow });
    app.mode = snap.mode as Mode;
    app.lastGameOpts = {
      mode: snap.mode, ruleset: snap.state.ruleset, seed: snap.envelope.seed,
      players: snap.state.players.map((p) => ({ name: p.name, kind: p.kind, level: p.level })),
      ranked: snap.ranked, undoAllowed: snap.undoAllowed, content: app.content, lesson: app.lesson,
    };
    app.capturedThisGame = 0;
    app.replay = null;
    app.paused = false;
    enterGameScreen();
    syncAll();
    toast(T("Saved game restored."));
  } catch (e) {
    console.warn(`resume: ${String(e)}`);
    SaveModel.clearSnapshot();
    toast(T("Could not restore the saved game."), "error");
  }
}
function findContent(id: string): Stage | Lesson | null {
  return Content.JOURNEY.find((s) => s.id === id) || Content.CHALLENGES.find((c) => c.id === id) || Content.LESSONS.find((l) => l.id === id) || null;
}

export function showSetup(mode: Mode, content: Stage | null = null, lesson: Lesson | null = null): void {
  app.mode = mode; app.content = content; app.lesson = lesson;
  app.setupCfg = { players: 2, aiLevel: 2, humans: 1, floats: 4, exactFinish: true, blockades: true, safeTrack: true };
  hideAllOverlays();
  showScreen("setup", primaryPointer() === "coarse" ? null : "setup-start");
}
export function setupStart(): void {
  const mode = app.mode!, cfg = app.setupCfg!, content = app.content, lesson = app.lesson;
  const seed = ((epoch + clockMs) * 2654435761) >>> 0;
  if (mode === "practice") {
    const players: SessionOpts["players"] = [{ name: displayName(), kind: "human" }];
    for (let i = 1; i < cfg.players; i++) players.push({ kind: "ai", level: cfg.aiLevel, name: AI.aiName(cfg.aiLevel, i - 1) });
    startGame({
      mode, players, seed,
      ruleset: { players: cfg.players, floats: cfg.floats, exactFinish: cfg.exactFinish, blockades: cfg.blockades, safeTrack: cfg.safeTrack },
      ranked: false, undoAllowed: true,
    });
  } else if (mode === "local") {
    const players = Array.from({ length: cfg.players }, (_, i) => ({ name: `Seat ${i + 1}`, kind: "human" }));
    startGame({ mode, players, seed, ruleset: { players: cfg.players }, ranked: false, undoAllowed: true });
  } else if (mode === "learn" && lesson) {
    startGame({
      mode, lesson, seed: lesson.ruleset.seed, ruleset: lesson.ruleset,
      players: [{ name: displayName(), kind: "human" }, { kind: "ai", level: 1, name: AI.aiName(1, 0) }],
      ranked: false, undoAllowed: true,
    });
  } else if (content) {
    const players: SessionOpts["players"] = [{ name: displayName(), kind: "human" }];
    for (const a of content.ai) players.splice(a.seat, 0, { kind: "ai", level: a.level, name: AI.aiName(a.level, a.seat - 1) });
    startGame({ mode, content, seed: content.seed, ruleset: Content.stageRuleset(content), players, ranked: true, undoAllowed: false });
  }
}
export function setupBack(): void {
  if (app.mode === "journey") showJourney();
  else if (app.mode === "learn") showLearn();
  else if (app.mode === "challenge") showChallenges();
  else showTitle();
}
export function showJourney(): void { hideAllOverlays(); showScreen("journey"); }
export function showLearn(): void { hideAllOverlays(); showScreen("learn"); }
export function showChallenges(): void { hideAllOverlays(); showScreen("challenge"); }
export function showDaily(): void { showSetup("daily", Content.dailyForDate(new Date(platform.nowMs()))); }
export function stageUnlocked(index: number): boolean {
  return index === 1 || !!platform.save().journey[Content.JOURNEY[index - 2]?.id ?? ""];
}
export function lessonUnlocked(order: number): boolean {
  return order === 1 || !!platform.save().lessons[Content.LESSONS[order - 2]!.id];
}

// ------------------------------------------------------------------ overlays: boards / profile
export function showBoards(tab: "daily" | "best" = "daily"): void {
  app.boardsTab = tab;
  if (topOverlay() !== "boards") showOverlay("boards");
  if (platform.signedIn()) {
    app.board = "loading";
    void platform.topEntries(20).then((rows) => { app.board = rows; });
  } else app.board = null;
}
export function setProfileName(typed: string): void {
  const p = platform.save().profile;
  const t = typed.trim().slice(0, 20);
  const next = !t || t === pname("Guest Envoy") ? "Guest Envoy" : t;
  if (next === p.name) return;
  p.name = next;
  platform.persist();
  toast(T("Name saved."));
}
export function eraseProgress(): void {
  confirmDialog(N("Erase all local progress, settings stay. This cannot be undone."), () => {
    platform.replaceSave(SaveModel.defaultSave());
    toast(T("Progress erased."));
    showTitle();
  });
}
export function signIn(): void { void requestSignIn().catch(() => undefined); }
export function invite(): void {
  const link = platform.inviteLink();
  if (!link) return;
  try { clipboard.writeText(link); toast(S("inviteCopied")); } catch { toast(S("inviteLink", { url: link }), "info", 8000); }
}

// ------------------------------------------------------------------ progression + achievements (idempotent unlocks)
let unlocksListedInResults = false;
function unlock(key: string): boolean {
  const s = platform.save();
  if (s.achievements[key]) return false;
  s.achievements[key] = new Date(platform.nowMs()).toISOString();
  const def = Content.ACHIEVEMENTS.find((a) => a.key === key);
  if (!unlocksListedInResults) toast(T("Achievement unlocked: {name}", { name: T(def?.name || key) }), "info", 5000);
  audio.event("crown");
  return true;
}
function updateProgression(results: Results): void {
  const s = platform.save();
  const st = s.stats;
  const mySeat = 0;
  st.gamesPlayed += 1;
  const me = results.rows.find((r) => r.seat === mySeat);
  const won = results.winner === mySeat;
  if (won) st.gamesWon += 1;
  st.captures += me?.captures ?? 0;
  st.crowned += me?.crowned ?? 0;
  if ((me?.crowned ?? 0) > 0 || st.crowned > 0) unlock("first_crown");
  if (won) unlock("first_victory");
  if (st.captures >= 10) unlock("capturer");
  if (won && app.capturedThisGame === 0 && results.mode !== "learn") unlock("flawless");
  if (st.gamesPlayed >= 100) unlock("centurion");
  if (Object.keys(s.lessons).length >= Content.LESSONS.length) unlock("scholar");
  const journeyDone = Object.keys(s.journey).length;
  if (journeyDone >= 20) unlock("journey_half");
  if (journeyDone >= 40) unlock("journey_complete");
  // journey stars: 1 complete + 1 under par + 1 no invalids
  if (results.mode === "journey" && app.content && won) {
    const prev = s.journey[app.content.id] || { stars: 0 };
    let stars = 1;
    if (results.turns <= (app.content.par?.turns ?? Infinity)) stars += 1;
    if ((me?.invalid ?? 0) === 0) stars += 1;
    const best = Math.min(prev.bestTurns ?? Infinity, results.turns);
    s.journey[app.content.id] = { stars: Math.max(prev.stars || 0, stars), bestTurns: best, completedAt: new Date(platform.nowMs()).toISOString() };
  }
  // daily record + streak
  if (results.mode === "daily" && app.content) {
    const key = (app.content as { date?: string }).date ?? "";
    const score = me?.breakdown.total ?? 0;
    const prev = s.dailies[key];
    if (!prev || score > prev.score) s.dailies[key] = { score, won, turns: results.turns };
    const yKey = Content.dailyForDate(new Date(platform.nowMs() - 86400000)).date;
    if (!prev) {
      st.streakDays = s.dailies[yKey] ? st.streakDays + 1 : 1;
      st.lastDaily = key;
      if (st.streakDays >= 3) unlock("daily_streak_3");
    }
    pushBoard("daily", results, me?.breakdown.total ?? 0);
  }
  if (results.mode === "challenge" || results.mode === "journey" || results.mode === "daily") pushBoard("best", results, me?.breakdown.total ?? 0);
  platform.persist();
}
function pushBoard(board: "daily" | "best", results: Results, score: number): void {
  const entry = {
    contentId: results.contentId, won: results.winner === 0, score, turns: results.turns, seed: results.seed, durationMs: results.elapsedMs,
    ruleset: app.session?.state.ruleset, version: 1, at: new Date(platform.nowMs()).toISOString(),
  };
  if (entry.score < 0 || entry.score > 100000 || entry.turns <= 0) return; // reject impossible
  const s = platform.save();
  const list = s.leaderboards[board];
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.turns - b.turns);
  s.leaderboards[board] = list.slice(0, 50);
}

// ------------------------------------------------------------------ the match
let animChain: Promise<void> = Promise.resolve();
let animPending = 0;
let aiNextAt: number | null = null;
const sessionNow = (): number => epoch + clockMs;

function startGame(opts: Omit<SessionOpts, "onEvent">): void {
  SaveModel.clearSnapshot();
  app.lastGameOpts = opts;
  app.session = new SessionCtor({ ...opts, onEvent: onSessionEvent, now: sessionNow });
  app.mode = opts.mode as Mode;
  app.capturedThisGame = 0;
  app.lessonStepIdx = 0;
  app.lessonFinishAt = 0;
  app.replay = null;
  app.paused = false;
  app.lb = null;
  app.resultsView = null;
  enterGameScreen();
  audio.setMusic(theme().musicMood === "tense" ? "tense" : "calm");
  audio.setAmbience(true);
  syncAll();
  // countdown: the banner, then the round is live at once
  banner(T("{name} begins — roll!", { name: currentName() }), 1600);
}
function enterGameScreen(): void {
  hideAllOverlays();
  showScreen("game");
  announce(objectiveText());
  if (app.mode === "learn") showLessonStep();
}
export function objectiveText(): string {
  if (app.mode === "learn" && app.lesson) return T(app.lesson.steps[0]?.text || "Follow the lesson.");
  const g = app.content?.goal;
  if (g) {
    if (g.type === "crown-first") return T("Be first to crown {n} float(s).", { n: g.count || 1 });
    if (g.type === "captures") return T("First to {n} captures wins the stage.", { n: g.count ?? 0 });
    if (g.type === "captures-then-win") return T("Win the race with at least {n} captures.", { n: g.count ?? 0 });
    if (g.type === "win-no-captures") return T("Win without capturing any rival float.");
  }
  const mt = app.session?.state.ruleset.maxTurns;
  return mt ? T("Crown all your floats first. Lantern schedule: {n} rounds.", { n: mt }) : T("Crown all your floats first.");
}
export function modeName(): string {
  return app.mode === "journey" && app.content ? T("Journey {n}", { n: app.content.index })
    : app.mode === "daily" ? T("Daily Circuit")
    : app.mode === "challenge" && app.content ? T(app.content.name)
    : app.mode === "learn" && app.lesson ? T(app.lesson.title)
    : app.mode === "local" ? T("Local Table") : T("Practice");
}
export function rulesList(): string[] {
  const r = app.session!.state.ruleset;
  return [
    T(r.exactFinish ? "Exact finish at the crown" : "Bounce-back finish"),
    T(r.blockades ? "Processions block rivals" : "No processions"),
    T(r.safeTrack ? "Lantern tiles are safe" : "No safe tiles"),
    T(r.captures ? "Captures on" : "Captures off"),
    r.maxTurns ? T("{n}-round limit", { n: r.maxTurns }) : T("No turn limit"),
  ];
}
function currentName(): string { return pname(app.session!.currentPlayer.name); }

/** Central event fan-out (session → audio / render / HUD). */
function onSessionEvent(events: GameEvent[], state: State): void {
  app.lastEvents = events;
  const SFX: Record<string, string | null> = {
    roll: "roll", move: "move", deploy: "deploy", capture: "capture", crown: "crown", encore: "encore", overkindled: "overkindled",
    pass: "pass", turn: "turn", resign: "lose", gameover: null, undo: "undo",
  };
  for (const e of events) {
    if (e.t === "gameover") sfxPlay(state.winner === 0 ? "win" : "lose");
    else if (SFX[e.t]) sfxPlay(SFX[e.t]!);
    if (e.t === "capture" && e.seat === 0) app.capturedThisGame += 1;
    if (e.t === "capture") haptic(30);
  }
  animPending++;
  const session = app.session;
  animChain = animChain.then(() => animateAndSettle(events, state, session));
}
async function animateAndSettle(events: GameEvent[], state: State, session: Session | null): Promise<void> {
  app.inputLocked = true;
  try { await render.animateEvents(events, state); } catch (e) { console.warn(`render animation failed: ${String(e)}`); }
  app.inputLocked = false;
  animPending--;
  if (app.session !== session || !session) return;
  if (session.isOver && !app.replay) { showResults(); return; }
  if (app.mode === "learn") checkLessonProgress();
  updateFlow();
}

/** The turn flow after a change: the turn line for screen readers, the board's hints, the float picker. */
function updateFlow(): void {
  const s = app.session;
  if (!s || s.isOver) return;
  const acts = s.actions;
  const cur = s.currentPlayer;
  announce(`${pname(cur.name)}: ${flowText()}`);
  if (acts.type === "moves" && canAct()) {
    render.setMoveHints(acts.moves, false, acts.die);
    app.pickIdx = 0;
    setSelection({ seat: s.state.turnIndex, floatId: acts.moves[0]!.floatId });
  } else {
    if (acts.type === "roll" && canAct()) render.setMoveHints([], true, null);
    else render.clearHints();
    setSelection(null);
  }
}
function setSelection(sel: { seat: number; floatId: number } | null): void {
  app.selection = sel;
  render.setSelection(sel);
}
/** The human on move may act now. */
export function canAct(): boolean {
  const s = app.session;
  return !!s && !s.isOver && s.currentPlayer.kind !== "ai" && !app.inputLocked && !app.replay && !app.paused && app.screen === "game";
}
export function flowText(): string {
  const s = app.session;
  if (!s) return "—";
  if (s.isOver) return T("Game over");
  const acts = s.actions, cur = s.currentPlayer, ok = cur.kind !== "ai" && !app.inputLocked && !app.replay;
  const name = pname(cur.name);
  return acts.type === "roll" ? (ok ? T("Your turn — roll!") : T("{name} to roll…", { name }))
    : acts.type === "pass" ? (ok ? T("No moves — you must pass.") : T("{name} has no moves.", { name }))
    : acts.type === "moves" ? (ok ? T("Rolled {n} — choose a float.", { n: acts.die }) : T("{name} is choosing…", { name }))
    : "—";
}
export function legalMoves(): Move[] {
  const s = app.session;
  if (!s || !canAct()) return [];
  const acts = s.actions;
  return acts.type === "moves" ? acts.moves : [];
}
export function describeMove(m: Move): string {
  const st = app.session!.state;
  const n = m.floatId + 1;
  if (m.deploys) return T("Float {n}: kindle!", { n });
  if (m.crowns) return T("Float {n}: CROWN 👑", { n });
  if (m.captures.length) return T("Float {n}: capture!", { n });
  const cell = Rules.circuitCell(st.ruleset, st.turnIndex, m.to);
  if (cell !== null && Rules.isSafeCell(st.ruleset, cell)) return T("Float {n}: to lantern tile", { n });
  return T("Float {n}: move {die}", { n, die: st.die ?? 0 });
}
/** Where a legal move's float stands (for the floating picker buttons). */
export function moveAnchor(m: Move): { x: number; y: number; visible: boolean } {
  const st = app.session!.state;
  const p = st.players[st.turnIndex]!.floats[m.floatId]!;
  return render.projectToScreen(Layout.floatPos(st.ruleset, st.turnIndex, p < 0 ? m.floatId : p, m.floatId, 1));
}

// ----- player actions
export function doRoll(): void {
  if (!canAct() || app.session!.actions.type !== "roll") return;
  const r = app.session!.command("roll");
  if (!r.ok) rejectFeedback(r);
}
export function doMove(floatId: number): void {
  if (!canAct()) return;
  setSelection(null);
  const r = app.session!.command("move", { floatId });
  if (!r.ok) rejectFeedback(r);
}
export function doPass(): void {
  if (!canAct() || app.session!.actions.type !== "pass") return;
  const r = app.session!.command("pass");
  if (!r.ok) rejectFeedback(r);
  else toast(T("Passed — no legal moves."));
}
export function canUndo(): boolean { const s = app.session; return !!s && s.undoAllowed && s.history.length > 0 && !app.replay; }
export function doUndo(): void {
  if (!canUndo() || app.inputLocked) return;
  if (app.session!.undo()) {
    render.skip();
    syncAll();
    toast(T("Undone."));
  }
}
export function doHint(): void {
  if (!canAct()) return;
  const m = app.session!.hint();
  if (!m) return;
  sfxPlay("hint");
  const desc = describeMove(m);
  toast(T("Hint: {move}", { move: desc }));
  announce(T("Hint: {move}", { move: desc }));
  const moves = legalMoves();
  const i = moves.findIndex((x) => x.floatId === m.floatId);
  if (i >= 0) app.pickIdx = i;
  setSelection({ seat: app.session!.state.turnIndex, floatId: m.floatId });
}
export function rejectFeedback(r: { error?: string | null; errorText?: string }): void {
  sfxPlay("error");
  haptic(40);
  const text = T(r.errorText || (r.error ? Rules.REASON_TEXT[r.error] : "") || "Not allowed.");
  toast(text, "error");
  announce(text, true);
}
function syncAll(): void {
  const st = app.session!.state;
  render.skip();
  render.syncState(st);
  updateFlow();
}
export function banner(text: string, ms = 1400): void { app.banner = { text, until: clockMs + (timing() ? ms * 1.6 : ms) }; }
export function sfxPlay(name: string): void {
  audio.event(name);
  if (platform.options.captions && audio.EVENT_CAPTIONS[name]) app.caption = { text: `♪ ${T(audio.EVENT_CAPTIONS[name]!)}`, until: clockMs + 1600 };
}
export function cyclePick(dir: number): void {
  const moves = legalMoves();
  if (!moves.length) return;
  app.pickIdx = (app.pickIdx + dir + moves.length) % moves.length;
  setSelection({ seat: app.session!.state.turnIndex, floatId: moves[app.pickIdx]!.floatId });
  sfxPlay("ui");
  announce(describeMove(moves[app.pickIdx]!));
}
export function previewPick(i: number): void {
  const moves = legalMoves();
  if (!moves[i] || i === app.pickIdx) return;
  app.pickIdx = i;
  setSelection({ seat: app.session!.state.turnIndex, floatId: moves[i]!.floatId });
}
function onConfirm(): void {
  const s = app.session;
  if (!s || !canAct()) return;
  const acts = s.actions;
  if (acts.type === "moves") { const m = acts.moves[app.pickIdx] ?? acts.moves[0]!; doMove(m.floatId); }
  else if (acts.type === "roll") doRoll();
  else if (acts.type === "pass") doPass();
}
function cancelSelection(): void { setSelection(null); }

// ----- lessons
function showLessonStep(): void {
  const step = app.lesson?.steps[app.lessonStepIdx];
  if (!step) return;
  app.coach = step.text;
  announce(T(step.text));
}
function checkLessonProgress(): void {
  const step = app.lesson?.steps[app.lessonStepIdx];
  const evs = app.lastEvents;
  if (!step || !evs) return;
  const match: Record<string, () => boolean> = {
    roll: () => evs.some((e) => e.t === "roll" && e.seat === 0),
    deploy: () => evs.some((e) => e.t === "deploy" && e.seat === 0),
    move: () => evs.some((e) => e.t === "move" && e.seat === 0),
    capture: () => evs.some((e) => e.t === "capture" && e.bySeat === 0),
    crown: () => evs.some((e) => e.t === "crown" && e.seat === 0),
    complete: () => true,
  };
  if (match[step.action]?.()) {
    app.lessonStepIdx += 1;
    const next = app.lesson!.steps[app.lessonStepIdx];
    if (next) {
      showLessonStep();
      // final card: complete the lesson shortly after showing it
      if (next.action === "complete") app.lessonFinishAt = clockMs + (timing() ? 4000 : 2400);
    }
  }
}
function finishLesson(): void {
  const s = platform.save();
  if (!s.lessons[app.lesson!.id]) {
    s.lessons[app.lesson!.id] = { done: true, at: new Date(platform.nowMs()).toISOString() };
    if (Object.keys(s.lessons).length >= Content.LESSONS.length) unlock("scholar");
    platform.persist();
  }
  showResults(true);
}

// ----- results
function showResults(lessonOnly = false): void {
  const s = app.session!;
  render.clearHints();
  setSelection(null);
  const results = s.results();
  const before = new Set(Object.keys(platform.save().achievements));
  // once per match: watching a replay returns here with the real session
  if (!s.progressionApplied) {
    s.progressionApplied = true;
    unlocksListedInResults = true;
    try { updateProgression(results); } finally { unlocksListedInResults = false; }
  }
  if (!lessonOnly && app.lb === null) postToLeaderboard(results);
  const newAch = Object.keys(platform.save().achievements).filter((k) => !before.has(k));
  app.resultsView = { lessonOnly, results, newAch };
  const won = results.winner === 0;
  announce(`${T(won ? "Victory" : "Game over")}. ${resultSub() || ""}`, true);
  hideAllOverlays();
  showOverlay("results", primaryPointer() === "coarse" ? null : "results-next");
}
export function resultSub(): string {
  const r = app.resultsView?.results;
  if (!r) return "";
  const winnerName = pname(r.rows.find((x) => x.seat === r.winner)?.name ?? "");
  switch (r.reason) {
    case "crown-sweep": return T("{name} crowned every float.", { name: winnerName });
    case "crown-first": return T("{name} reached the crown target first.", { name: winnerName });
    case "turn-limit": return T("The turn limit was reached.");
    case "resign": return T("A player resigned.");
    case "abandon": return T("A player abandoned the match.");
    default: return "";
  }
}
/** Hosted play only: post a finished journey, daily or challenge match to the high-score board (score-script.js). */
function postToLeaderboard(results: Results): void {
  if (!platform.signedIn() || !["journey", "daily", "challenge"].includes(app.mode ?? "")) { app.lb = { state: "failed", rank: -1 }; return; }
  const me = results.rows.find((r) => r.seat === 0);
  const lb: Lb = { state: "posting" };
  app.lb = lb;
  const session = app.session;
  void platform.postScore(Math.max(0, me?.breakdown.total ?? 0)).then((r) => {
    if (app.session !== session) return;
    app.lb = !r.posted ? { state: "failed" } : { state: "posted", rank: r.rank };
  });
}
export function lbLine(): string | null {
  const lb = app.lb;
  if (!lb || lb.rank === -1) return null;
  if (lb.state === "posting") return S("lbPosting");
  if (lb.state === "failed") return S("lbFailed");
  return lb.rank ? S("lbRank", { rank: lb.rank }) : S("lbPosted");
}
/** The results panel's next recommended action. */
export function nextAction(): { text: string; act: () => void } {
  const rv = app.resultsView;
  const won = rv?.results.winner === 0;
  if (app.mode === "journey" && app.content && won && app.content.index < 40) {
    const next = Content.JOURNEY[app.content.index]!;
    return { text: T("Next: Stage {n}", { n: app.content.index + 1 }), act: () => showSetup("journey", next) };
  }
  if (app.mode === "learn" && app.lesson) {
    const next = Content.LESSONS[app.lesson.order];
    if (next) return { text: T("Next: {title}", { title: T(next.title) }), act: () => showSetup("learn", null, next) };
  }
  return { text: T("Back to title"), act: leaveToTitle };
}
export function retryCurrent(): void {
  if (app.mode === "learn") showSetup("learn", null, app.lesson);
  else if ((app.mode === "journey" || app.mode === "challenge") && app.content) showSetup(app.mode, app.content);
  else if (app.mode === "daily") showDaily();
  else if (app.mode === "local") showSetup("local");
  else showSetup("practice");
}
export function leaveToTitle(): void {
  app.session = null;
  app.replay = null;
  app.paused = false;
  render.skip();
  render.clearHints();
  render.syncState(null);
  showTitle();
}

// ----- deterministic replay viewing
export function watchReplay(): void {
  const real = app.session!;
  if (!SessionCtor.verifyReplay(real.envelope).ok) { toast(T("Replay failed verification."), "error"); return; }
  const env = real.envelope;
  const players = real.state.players.map((p) => ({ name: p.name, kind: "ai", level: 1 }));
  const replay = new SessionCtor({ mode: "replay", ruleset: env.ruleset, seed: env.seed, players, ranked: false, undoAllowed: false, onEvent: onSessionEvent, now: sessionNow });
  hideAllOverlays();
  app.replay = { real, idx: 0, nextAt: clockMs + 550 };
  app.session = replay;
  render.skip();
  render.clearHints();
  render.syncState(replay.state);
  banner(T("Replay — Esc to exit"), 2200);
}
function replayTick(): void {
  const r = app.replay;
  if (!r || animPending > 0 || clockMs < r.nextAt) return;
  const cmds = r.real.envelope.commands;
  while (r.idx < cmds.length && cmds[r.idx]!.type === "undo-marker") r.idx++;
  if (r.idx >= cmds.length) { endReplay(); return; }
  const c = cmds[r.idx++]!;
  app.session!.command(c.type, c.floatId !== undefined ? { floatId: c.floatId } : {}, c.seat);
  r.nextAt = clockMs + 550;
}
export function endReplay(): void {
  const r = app.replay;
  if (!r) return;
  app.replay = null;
  app.session = r.real;
  render.skip();
  render.syncState(r.real.state);
  hideAllOverlays();
  showOverlay("results", primaryPointer() === "coarse" ? null : "results-next");
}

// ----- board mirror (accessible navigable model)
export function describeFloat(st: State, seat: number, p: number, idx: number): string {
  const n = idx + 1;
  if (p === -1) return T("Float {n}: in the workshop", { n });
  if (p === Rules.DONE) return T("Float {n}: crowned 👑", { n });
  if (p >= Rules.TRACK_LEN) return T("Float {n}: approach step {step} of 4", { n, step: p - Rules.TRACK_LEN + 1 });
  const cell = Rules.circuitCell(st.ruleset, seat, p)!;
  return Rules.isSafeCell(st.ruleset, cell)
    ? T("Float {n}: circuit tile {tile} (lantern, safe)", { n, tile: cell + 1 })
    : T("Float {n}: circuit tile {tile}", { n, tile: cell + 1 });
}
export function openBoardState(): void { if (app.session) showOverlay("boardstate", "btn-bs-close"); }

// ----- pause / lifecycle
export function pauseGame(): void {
  const s = app.session;
  if (!s || s.isOver || app.replay || app.screen !== "game" || app.overlays.length) return;
  s.paused = true;
  app.paused = true;
  aiNextAt = null;
  render.clearHints();
  audio.setSuspended(true);
  showOverlay("pause", primaryPointer() === "coarse" ? null : "btn-resume");
  audio.event("ui");
}
export function resumeGame(): void {
  const i = app.overlays.lastIndexOf("pause");
  if (i >= 0) app.overlays.splice(i, 1);
  app.openedFrame = frame().frame;
  audio.setSuspended(false);
  if (!app.session) return;
  app.session.paused = false;
  app.paused = false;
  syncAll();
}
export function restartGame(): void {
  if (!app.lastGameOpts) return;
  confirmDialog(N("Restart this match from the beginning?"), () => { startGame({ ...app.lastGameOpts! }); audio.setSuspended(false); });
}
export function leaveGame(): void {
  const inProgress = app.session && !app.session.isOver;
  if (!inProgress) { audio.setSuspended(false); leaveToTitle(); return; }
  confirmDialog(N("Leave the game? Solo progress is saved and can be resumed."), () => { audio.setSuspended(false); leaveToTitle(); });
}
export function replayTutorial(): void { showLearn(); }

// ------------------------------------------------------------------ keys and pads (ui.js onKeyDown / pollGamepad)
onAction((e) => {
  if (!e.pressed || ui.capturingKeys()) return;
  const a = e.action;
  const o = topOverlay();
  if (o) {
    // panels take Escape / East themselves (the dialog closes); nothing else reaches the board
    return;
  }
  if (app.replay) {
    if (a === "cancel" || a === "confirm" || a === "pause") later(endReplay);
    return;
  }
  if (app.screen !== "game" || !app.session) return;
  if (a === "pause") { later(pauseGame); return; }
  if (ui.focused() !== null && (a === "confirm" || a === "next" || a === "prev" || a === "cancel")) {
    // Enter / Space on a focused HUD button are the button's; arrows hand the keys back to the board
    if (a === "confirm") return;
    ui.setFocus(null);
  }
  switch (a) {
    case "confirm": later(onConfirm); break;
    case "cancel": cancelSelection(); break;
    case "undo": later(doUndo); break;
    case "hint": later(doHint); break;
    case "camera": render.resetCamera(); break;
    case "board": later(openBoardState); break;
    case "next": cyclePick(1); break;
    case "prev": cyclePick(-1); break;
  }
});

// ------------------------------------------------------------------ pointer and touch on the board (ui.js bindCanvasInput)
interface Down { x: number; y: number; t: number; moved: boolean; lx: number; ly: number; overUi: boolean | null }
let down: Down | null = null;
const taps: { x: number; y: number }[] = [];
const moves: { x: number; y: number }[] = [];
let lastTouch = -1e9;
function press(x: number, y: number): void { down = { x, y, t: clockMs, moved: false, lx: 0, ly: 0, overUi: null }; }
function drag(x: number, y: number): void {
  if (!down) return;
  moves.push({ x, y });
}
function release(x: number, y: number): void {
  if (!down) return;
  const d = down;
  down = null;
  if (d.overUi) return;
  if (!d.moved && clockMs - d.t < 600) taps.push({ x, y });
}
onTouch((e) => {
  lastTouch = clockMs;
  if (e.control || !e.primary) return;
  if (e.phase === "start") press(e.x, e.y);
  else if (e.phase === "move") drag(e.x, e.y);
  else if (e.phase === "end") release(e.x, e.y);
  else if (e.phase === "cancel") down = null;
});
onPointerButton((e) => {
  if (e.button !== 0 || clockMs - lastTouch < 600) return;
  if (e.pressed) press(e.x, e.y);
  else release(e.x, e.y);
});
onPointerMove((x, y) => { if (clockMs - lastTouch >= 600) drag(x, y); });
/** After the UI is built: a press over a widget is the widget's; drags orbit the camera; taps pick floats and the die. */
function pointerInput(wasPlaying: boolean): void {
  const sc = frame().scale;
  if (down && down.overUi === null) down.overUi = ui.pointerOver() || app.overlays.length > 0 || app.screen !== "game";
  const list = moves.splice(0);
  if (down && !down.overUi) {
    for (const m of list) {
      const dx = (m.x - down.x) / sc, dy = (m.y - down.y) / sc;
      if (!down.moved && Math.hypot(dx, dy) > 9) down.moved = true;
      if (down.moved) { render.orbit(dx - down.lx, dy - down.ly); down.lx = dx; down.ly = dy; }
    }
  }
  const tapsNow = taps.splice(0);
  if (!wasPlaying || app.screen !== "game" || app.overlays.length || !app.session || app.session.isOver || app.replay) return;
  for (const p of tapsNow) onBoardTap(p.x, p.y);
}
function onBoardTap(x: number, y: number): void {
  const s = app.session!;
  if (app.inputLocked) return;
  const hit = render.pick(x, y);
  if (!hit) return;
  ui.setFocus(null);
  const acts = s.actions;
  const seat = s.state.turnIndex;
  if (hit.kind === "die") { if (acts.type === "roll") doRoll(); return; }
  if (hit.kind === "float") {
    haptic(8);
    if (acts.type === "moves" && hit.seat === seat && canAct()) {
      if (acts.moves.some((m) => m.floatId === hit.floatId)) doMove(hit.floatId!);
      else rejectFeedback({ errorText: N("That float cannot use this roll.") });
      return;
    }
    // inspect: select + describe any float
    setSelection({ seat: hit.seat!, floatId: hit.floatId! });
    const p = s.state.players[hit.seat!]!.floats[hit.floatId!]!;
    toast(`${pname(s.state.players[hit.seat!]!.name)} — ${describeFloat(s.state, hit.seat!, p, hit.floatId!)}`);
  }
}

// ------------------------------------------------------------------ the clock
let hidden = false;
onFixedUpdate(() => {
  if (hidden) return;
  clockMs += 1000 / 60;
  render.step(1 / 60);
  const s = app.session;
  if (app.replay) { replayTick(); return; }
  // AI turns (session.driveAI): one decision per pace while an AI seat is on move
  if (s && !s.isOver && !app.paused && app.screen === "game" && s.currentPlayer.kind === "ai") {
    const pace = timing() ? 1100 : 650;
    if (aiNextAt === null) aiNextAt = clockMs + pace;
    else if (clockMs >= aiNextAt) { s.aiStep(); aiNextAt = clockMs + pace; }
  } else aiNextAt = null;
  if (app.lessonFinishAt && clockMs >= app.lessonFinishAt && app.session && app.mode === "learn" && !app.overlays.includes("results")) {
    app.lessonFinishAt = 0;
    finishLesson();
  }
});

// ------------------------------------------------------------------ boot and lifecycle
let lookKey = "";
function applyLook(): void {
  const f = frame();
  const k = `${f.quality}:${f.levelIndex}`;
  if (k === lookKey) return;
  lookKey = k;
  render.applyLook(lookFor(f.quality, f.levelIndex));
}
function applyOptions(): void {
  render.setPalette(platform.options.palette);
  render.setTheme(theme());
  render.setCameraMode(platform.options.camera);
}
onStart(() => {
  setFixedRate(60);
  epoch = Date.now();
  initStyles();
  platform.initPlatform();
  audio.loadSfx();
  render.setReducedMotion(preferences().reducedMotion);
  applyLook();
  applyOptions();
  render.setActive(true);
  showTitle();
});
onPreferencesChange((p) => render.setReducedMotion(p.reducedMotion));
platform.onOptionsChange(applyOptions);
platform.onProgressMerged(() => { if (app.screen === "title") toast(T("Progress restored from your StarHermit cloud save.")); });
onSessionEnded(() => toast(S("signedOut")));
onSuspend(() => {
  hidden = true;
  // backgrounding pauses solo simulation (visibilitychange)
  if (app.session && !app.session.isOver && app.screen === "game" && !app.overlays.length && !app.replay) pauseGame();
  audio.setSuspended(true);
  platform.flush();
});
onResume(() => { hidden = false; if (!app.paused) audio.setSuspended(false); });

let frameDt = 0;
onUpdate((dt) => {
  frameDt = dt;
  applyLook();
  applyTokens(ui.preferences().highContrast, platform.options.palette === "cvd");
  audio.update();
  app.toasts = app.toasts.filter((x) => x.until >= clockMs);
  if (app.banner && app.banner.until < clockMs) app.banner = null;
  if (app.caption && app.caption.until < clockMs) app.caption = null;
});
onRender(() => {
  const wasPlaying = app.screen === "game" && !app.overlays.length;
  const f = frame();
  render.update(frameDt, f.width, f.height);
  drawScreens();
  for (const fn of pending.splice(0)) fn();
  pointerInput(wasPlaying);
  flushAnnouncements();
});
