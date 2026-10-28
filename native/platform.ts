// The game's data and the StarHermit platform, on the runtime's modules (what
// src/platform.js and src/save.js did over the JS SDK and localStorage):
// - the save (starhermit:storage `saves`, schema 1: on the device and in the
//   player's cloud slot) is the progression document (src/save.js
//   defaultSave: profile, journey stars, lessons, dailies, achievements,
//   stats, the local boards, the rating); two devices' saves merge on a
//   conflict (mergeSaves, as the browser build did on its saveconflict); the
//   slot the browser build wrote through the JS SDK (game:<slug>, the
//   versioned, checksummed document) shows as foreign: it is merged in and
//   replaced once;
// - `localStorage` is a shim over the device's key/value storage, so the
//   in-progress match snapshot (src/save.js storeSnapshot, "Resume saved
//   game") stays on this device as before;
// - the game's own options (captions, camera view, theme, palette, timing
//   assistance, left-handed tray: src/options.js) are engine `settings`
//   (synced with the account); the browser build's values in the account's
//   settings KV are adopted (unless set here since), then its keys are removed
//   (volumes, mute, graphics, controls, reduced motion, contrast, larger text,
//   vibration and the language are the runtime's Options);
// - the player, the invite link, the platform's clock for the Daily, posting a
//   finished Journey, Daily or Challenge total through score-script.js (a
//   practice session whose socket carries { type: 'result', scores }, as the
//   JS SDK's submitScores did) with the rank, and the board's top entries.
import type { JsonValue } from "starhermit:engine";
import {
  connectGame, inviteLink as fetchInviteLink, leaderboards, onPlayerChange, player, serverNow, serverTime, sessions, type Leaderboard,
} from "starhermit:platform";
import { saves, settings as store, storage } from "starhermit:storage";
import { OptionsModel, SaveModel, type Options, type SaveDoc } from "./game.ts";

// --- localStorage (the device's key/value storage) ---------------------------------------------
const shim = {
  getItem: (k: string): string | null => { try { return storage.getText(k); } catch { return null; } },
  setItem: (k: string, v: string): void => { try { storage.set(k, String(v)); } catch (e) { console.warn(`storage: ${String(e)}`); } },
  removeItem: (k: string): void => { try { storage.remove(k); } catch { /* gone */ } },
};
(globalThis as unknown as { localStorage: typeof shim }).localStorage = shim;

// --- the save --------------------------------------------------------------------------------
let data: SaveDoc = SaveModel.defaultSave();
let lastSavedAt = 0;
const mergedListeners = new Set<() => void>();
/** fn() after progress from the account (another device, the browser build) was merged in. */
export function onProgressMerged(fn: () => void): void { mergedListeners.add(fn); }
function merged(): void { for (const fn of mergedListeners) fn(); }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function write(opts: { replaceForeign?: boolean } = {}): void {
  try {
    saves.save(data as unknown as JsonValue, { schema: 1, ...opts });
    lastSavedAt = saves.load()?.savedAt ?? lastSavedAt;
  } catch (e) { console.warn(`save: ${String(e)}`); }
}
/** The live progression (change it, then persist()). */
export function save(): SaveDoc { return data; }
/** Replaces the progression (Erase all local progress). */
export function replaceSave(next: SaveDoc): void { data = next; write(); }
/** Saves (the device at once, the account debounced by the runtime). */
export function persist(): void { write(); }
function adopt(other: unknown): boolean {
  const next = SaveModel.mergeSaves(SaveModel.normalizeSave(other), data);
  if (same(next, data)) return false;
  data = next;
  write();
  return true;
}
saves.onConflict((mine, remote) => ({
  merged: SaveModel.mergeSaves(SaveModel.normalizeSave(remote.data), SaveModel.normalizeSave(mine?.data ?? null)) as unknown as JsonValue,
}));
saves.onStatus((_status, state) => {
  if (state === "foreign") { migrateForeign(); return; }
  const cur = saves.load();
  if (cur && cur.savedAt !== lastSavedAt) {
    lastSavedAt = cur.savedAt;
    if (adopt(cur.data)) merged();
  }
});
/** The browser build's cloud document: merged with this device's save, saved over it once. */
function migrateForeign(): void {
  const old = saves.foreign();
  if (!old) return;
  const doc = old.text != null ? SaveModel.readForeign(old.text) : null;
  let grew = false;
  if (doc) {
    const next = SaveModel.mergeSaves(doc, data);
    grew = !same(next, data);
    data = next;
  }
  write({ replaceForeign: true });
  if (grew) merged();
}

/** The sync status: local for a guest, else connecting / saving / synced / error. */
export function syncState(): "local" | "connecting" | "saving" | "synced" | "error" {
  if (!player()) return "local";
  const st = saves.state();
  if (st === "error" || st === "read-blocked") return "error";
  if (st === "loading") return "connecting";
  if (st === "foreign" || st === "uploading" || saves.status() === "pending") return "saving";
  return "synced";
}
export function flush(): void { void saves.flush().catch(() => undefined); }

// --- the game's options -----------------------------------------------------------------------
export const options: Options = { ...OptionsModel.DEFAULT_OPTIONS };
const KEYS = OptionsModel.OPTION_KEYS;
const optionListeners = new Set<() => void>();
export function onOptionsChange(fn: () => void): void { optionListeners.add(fn); }
function optionsChanged(): void { for (const fn of optionListeners) fn(); }
function readOption(key: keyof Options): void {
  let v: JsonValue | undefined;
  try { v = store.get(key); } catch { return; }
  const ok = OptionsModel.pickOptions({ [key]: v })[key];
  if (ok !== undefined) (options as unknown as Record<string, unknown>)[key] = ok;
}
/** A migrated value, kept unless this game set the key since. */
function adoptOption(key: keyof Options, value: unknown): void {
  try {
    if (store.get(key) !== undefined) return;
    store.set(key, value as JsonValue);
    (options as unknown as Record<string, unknown>)[key] = value;
  } catch { /* keep the device's */ }
}
/** Changes one of the game's options (device and account). */
export function setOption<K extends keyof Options>(key: K, value: Options[K]): void {
  if (options[key] === value) return;
  options[key] = value;
  try { store.set(key, value as JsonValue); } catch (e) { console.warn(`option ${key}: ${String(e)}`); }
  optionsChanged();
}
/** The browser build's settings KV: the game's options carry over (unless set here since), then its keys go. */
function importLegacy(): void {
  const keys = store.legacyKeys();
  if (!keys) return;
  const kv: Record<string, unknown> = {};
  for (const key of keys) kv[key] = store.legacy(key);
  const old = OptionsModel.readLegacySettings(kv);
  for (const [k, v] of Object.entries(old)) adoptOption(k as keyof Options, v);
  for (const key of keys) if (OptionsModel.BROWSER_KEYS.includes(key) || key.startsWith("ui.")) store.removeLegacy(key);
  optionsChanged();
}

/** Reads the device's save and the game's options (from onStart). */
export function initPlatform(): void {
  const cur = saves.load();
  lastSavedAt = cur?.savedAt ?? 0;
  data = SaveModel.normalizeSave(cur?.data ?? null);
  for (const k of KEYS) readOption(k);
  store.onChange((key) => {
    if (!(KEYS as string[]).includes(key)) return;
    readOption(key as keyof Options);
    optionsChanged();
  });
  store.onLegacy(importLegacy);
  importLegacy();
  if (saves.state() === "foreign") migrateForeign();
  optionsChanged();
  refreshPlayer();
  void serverTime().then(() => undefined, () => undefined);
}

// --- the player and the clock -----------------------------------------------------------------
export function signedIn(): boolean { return !!player(); }
export function displayName(): string { return player()?.displayName ?? ""; }
let invite: string | null = null;
/** The invite link, fetched ahead so a button press can copy it at once. */
export function inviteLink(): string | null { return player() ? invite : null; }
function refreshPlayer(): void {
  invite = null;
  board = undefined;
  if (!player()) return;
  fetchInviteLink().then((u) => { invite = u; }, () => { invite = null; });
}
const playerListeners = new Set<() => void>();
export function onPlayer(fn: () => void): void { playerListeners.add(fn); }
onPlayerChange(() => { refreshPlayer(); for (const fn of playerListeners) fn(); });

/** Now in ms by the platform's clock when it has answered, else the device's (the Daily's UTC day). */
export function nowMs(): number {
  try { return serverNow() ?? Date.now(); } catch { return Date.now(); }
}

// --- the high-score board ---------------------------------------------------------------------
let board: Leaderboard | null | undefined;
async function highScoreBoard(): Promise<Leaderboard | null> {
  if (board !== undefined) return board;
  const list = await leaderboards.list();
  board = list.find((b) => b.key === "high-score") ?? list[0] ?? null;
  return board;
}
export interface BoardRow { rank: number; name: string; score: number }
/** platform.js fetchGlobalBoard: the festival board's top entries (signed in), null when unavailable. */
export async function topEntries(n: number): Promise<BoardRow[] | null> {
  if (!player()) return null;
  try {
    const b = await highScoreBoard();
    if (!b) return null;
    const r = await leaderboards.entries(b.id, { pageSize: n });
    return r.items.slice(0, n).map((e, i) => ({
      rank: Number.isFinite(e.rank) ? e.rank : i + 1, name: e.displayName || e.username || "", score: Number.isFinite(e.score) ? e.score : 0,
    }));
  } catch { return null; }
}
export interface Posted { posted: boolean; rank: number | null }
/** Signed in only: post a finished match's total through score-script.js; { posted, rank }. Never rejects. */
export async function postScore(total: number): Promise<Posted> {
  const me = player();
  if (!me) return { posted: false, rank: null };
  const score = Math.max(0, Math.round(total));
  let accepted: string[] = [];
  try {
    const sessionId = await sessions.practice();
    accepted = await new Promise<string[]>((resolve) => {
      const socket = connectGame(sessionId);
      let done = false;
      const finish = (list: string[]): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), 15000);
      socket.on("open", () => { socket.sendCommand({ type: "result", scores: { "high-score": score } }); });
      socket.on("game", (d) => {
        const m = d as { type?: string; accepted?: string[] } | null;
        if (m && m.type === "result-ack") finish(Array.isArray(m.accepted) ? m.accepted : []);
      });
      socket.on("error", () => finish([]));
      socket.on("stopped", () => finish([]));
      socket.on("abandoned", () => finish([]));
    });
  } catch { return { posted: false, rank: null }; }
  if (!accepted.includes("high-score")) return { posted: false, rank: null };
  try {
    const b = await highScoreBoard();
    if (!b) return { posted: true, rank: null };
    const r = await leaderboards.entries(b.id, { pageSize: 100 });
    const mine = r.items.find((e) => e.userId === me.userId);
    return { posted: true, rank: mine ? mine.rank : null };
  } catch { return { posted: true, rank: null }; }
}
