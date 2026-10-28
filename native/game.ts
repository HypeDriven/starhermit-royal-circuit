// The browser build's pure game modules (shared with the node tests), typed
// for this client: the rules (src/rules.js: the 40-tile circuit, kindling,
// captures, processions, the crown approach, scoring), the AI and hint
// (src/ai.js), the content (src/content.js: themes, lessons, the 40 Journey
// stages, challenges, the Daily, achievements), the session (src/session.js:
// validated commands, undo, replay envelope, snapshots), the shared board
// layout (src/boardlayout.js), the save model (src/save.js) and the game's
// options (src/options.js).
import * as rules from "../src/rules.js";
import * as ai from "../src/ai.js";
import * as content from "../src/content.js";
import * as sessionMod from "../src/session.js";
import * as layout from "../src/boardlayout.js";
import * as save from "../src/save.js";
import * as options from "../src/options.js";

export interface Ruleset {
  players: number; floats: number; exactFinish: boolean; blockades: boolean; safeTrack: boolean; captures: boolean;
  maxTurns: number; seed: number; goal?: { type: string; count: number }; forcedRolls?: number[];
}
export interface Player {
  seat: number; name: string; kind: string; color: number; floats: number[]; crowned: number; captures: number; invalid: number;
  resigned: boolean; level?: number;
}
export interface State {
  ruleset: Ruleset; tick: number; turnIndex: number; round: number; turnsPlayed: number; phase: string; die: number | null;
  players: Player[]; winner: number | null; reason: string | null;
}
export interface Move { floatId: number; from: number; to: number; deploys: boolean; crowns: boolean; captures: unknown[] }
export type Actions =
  | { type: "roll"; seat: number }
  | { type: "pass"; seat: number; explanation: string }
  | { type: "moves"; seat: number; die: number; moves: Move[] }
  | { type: "none"; reason: string };
export interface GameEvent { t: string; seat?: number; floatId?: number; value?: number; winner?: number; bySeat?: number; [k: string]: unknown }
export interface Breakdown { parts: Record<string, number>; total: number; win: boolean }
export interface ResultRow {
  place: number; seat: number; name: string; kind: string; breakdown: Breakdown; crowned: number; captures: number; invalid: number; resigned: boolean;
}
export interface Results {
  mode: string; contentId: string | null; winner: number | null; reason: string | null; turns: number; elapsedMs: number;
  rows: ResultRow[]; ranked: boolean; seed: number;
}
export interface Goal { type: string; count?: number }
export interface Stage {
  id: string; index: number; name: string; seed: number; ruleset: Partial<Ruleset> & { players: number }; ai: { seat: number; level: number }[];
  goal?: Goal; par?: { turns: number }; mastery?: boolean; theme?: string;
}
export interface Challenge extends Stage { blurb: string }
export interface Daily extends Stage { date: string; excluded?: boolean }
export interface Lesson {
  id: string; title: string; order: number; intro: string; ruleset: Partial<Ruleset> & { seed: number; players: number };
  steps: { text: string; action: string }[]; initial?: { floats?: Record<string, number[]> };
}
export interface Theme {
  id: string; name: string; sky: number; fog: number; ground: number; boardWood: number; boardTrim: number; tileA: number; tileB: number;
  lantern: number; lanternEmissive: number; musicMood: string; accentCss: string; bgCss: string;
}
export interface Achievement { key: string; name: string; desc: string; icon: string }
export interface Envelope { seed: number; ruleset: Ruleset; commands: { type: string; seat: number; floatId?: number }[] }
export interface SessionOpts {
  mode: string; ruleset: Partial<Ruleset>; seed: number; players: { name?: string; kind: string; level?: number }[];
  content?: Stage | null; lesson?: Lesson | null; ranked: boolean; undoAllowed: boolean;
  onEvent: (events: GameEvent[], state: State) => void; now?: () => number;
}
export interface Session {
  mode: string; content: Stage | null; lesson: Lesson | null; ranked: boolean; undoAllowed: boolean; paused: boolean;
  history: State[]; state: State; envelope: Envelope; startedAt: number; endedAt: number | null;
  progressionApplied?: boolean;
  readonly actions: Actions; readonly currentPlayer: Player; readonly isOver: boolean;
  command(type: string, extra?: { floatId?: number }, seat?: number): { ok: boolean; error?: string; errorText?: string; duplicate?: boolean; events?: GameEvent[] };
  undo(): boolean;
  aiStep(): boolean;
  hint(): Move | null;
  results(): Results;
  goalStatus(): { met: boolean; label: string | null };
}
interface SessionClass {
  new (o: SessionOpts): Session;
  restore(doc: unknown, onEvent: SessionOpts["onEvent"], o: { content?: Stage | null; lesson?: Lesson | null; now?: () => number }): Session;
  verifyReplay(env: Envelope): { ok: boolean };
}
export interface SaveDoc {
  profile: { name: string; avatar: string; guest: boolean };
  journey: Record<string, { stars: number; bestTurns?: number; completedAt?: string }>;
  lessons: Record<string, { done: boolean; at?: string }>;
  dailies: Record<string, { score: number; won: boolean; turns: number; excluded?: boolean }>;
  achievements: Record<string, string>;
  stats: { gamesPlayed: number; gamesWon: number; captures: number; crowned: number; streakDays: number; lastDaily: string | null };
  leaderboards: { daily: BoardEntry[]; best: BoardEntry[] };
  ratings: Record<string, number>;
}
export interface BoardEntry {
  contentId: string | null; won: boolean; score: number; turns: number; seed: number; durationMs: number; ruleset?: Ruleset; version: number; at: string;
}
export interface Options { captions: boolean; camera: "auto" | "top" | "low"; theme: string; palette: "standard" | "cvd"; timingAssist: boolean; leftHanded: boolean }
export interface Snapshot { mode: string; contentId: string | null; state: State; envelope: Envelope; startedAt: number; undoAllowed: boolean; ranked: boolean }

interface RulesApi {
  PLAYER_DEFS: { key: string; name: string; color: number; shape: string }[]; REASON_TEXT: Record<string, string>;
  TRACK_LEN: number; DONE: number; SAFE_CELLS: number[];
  legalActions(s: State): Actions; circuitCell(r: Ruleset, seat: number, p: number): number | null; isSafeCell(r: Ruleset, c: number): boolean;
  startCell(r: Ruleset, seat: number): number;
}
interface AiApi { AI_LEVELS: { level: number; name: string }[]; aiName(level: number, idx: number): string }
interface ContentApi {
  THEMES: Theme[]; LESSONS: Lesson[]; JOURNEY: Stage[]; CHALLENGES: Challenge[]; ACHIEVEMENTS: Achievement[];
  dailyForDate(d: Date): Daily; stageRuleset(s: Stage): Partial<Ruleset>; themeById(id: string): Theme;
}
type Pos = { x: number; y: number; z: number; angle?: number };
interface LayoutApi {
  RING_RADIUS: number; TILE_SIZE: number; WORKSHOP_RADIUS: number;
  cellAngle(c: number): number; circuitPos(c: number, y?: number): Pos & { angle: number };
  floatPos(r: Ruleset, seat: number, p: number, stackIndex?: number, stackSize?: number, y?: number): Pos;
  diePos(r: Ruleset, seat: number, y?: number): Pos;
}
interface SaveApi {
  defaultSave(): SaveDoc; mergeSaves(remote: unknown, local: unknown): SaveDoc; normalizeSave(raw: unknown): SaveDoc;
  readForeign(text: string): SaveDoc | null; loadSnapshot(): Snapshot | null; clearSnapshot(): void;
}
interface OptionsApi {
  DEFAULT_OPTIONS: Options; OPTION_KEYS: (keyof Options)[]; BROWSER_KEYS: string[]; CAMERA_MODES: string[]; PALETTES: string[];
  pickOptions(raw: unknown): Partial<Options>; readLegacySettings(kv: Record<string, unknown>): Partial<Options>;
}

export const Rules = rules as unknown as RulesApi;
export const AI = ai as unknown as AiApi;
export const Content = content as unknown as ContentApi;
export const Layout = layout as unknown as LayoutApi;
export const SaveModel = save as unknown as SaveApi;
export const OptionsModel = options as unknown as OptionsApi;
export const SessionCtor = (sessionMod as unknown as { Session: SessionClass }).Session;
