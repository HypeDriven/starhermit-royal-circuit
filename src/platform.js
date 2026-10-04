/**
 * platform.js — host/platform adapter over the canonical StarHermit SDK
 * (starhermit-sdk.js, loaded as a classic script before the modules;
 * window.StarHermit).
 *
 * - Hosted mode is active while the SDK holds a launch token (read from
 *   `#game_token=` or the sign-in return `#access_token=`, stripped, never
 *   persisted, renewed by the SDK). The slug is the `game_scope` claim.
 * - Identity: profile nickname via the SDK ("Player <id>" fallback) + avatar.
 * - Cloud save mirrors the local save document to the `game:<slug>` slot;
 *   localStorage stays the offline cache and remote wins on conflict. Saves
 *   are debounced 2 s and flushed on pagehide/visibilitychange; sync status
 *   is surfaced via onSyncChange.
 * - Settings KV mirrors player preferences; controls come from the
 *   platform controls API (control.* in starhermit.txt).
 * - Leaderboards are read-only on-platform; personal bests stay local +
 *   cloud-saved.
 * - Without a token the game makes no network request at all: device clock,
 *   local saves, boards and achievements. Own-server routes (/api, /ws) are
 *   never called.
 * - Telemetry: anonymous funnel events only (start, tutorial step, round
 *   end, retry, settings change, error category), consent-gated, kept in
 *   memory.
 */

const CLOUD_DEBOUNCE_MS = 2000;
// Settings groups mirrored to the per-player KV (input bindings use the controls API).
const SETTING_GROUPS = ['audio', 'graphics', 'accessibility', 'camera', 'theme', 'tutorial', 'consent'];
const SH = () => (typeof window !== 'undefined' && window.StarHermit) || globalThis.StarHermit || null;

export class Platform {
  constructor() {
    this.hosted = false;       // true while the SDK holds a launch token
    this.nickname = null;
    this.consented = false;
    this.funnel = [];
    this.syncStatus = 'offline'; // offline | synced | saving | error
    this.onSyncChange = null;
    this.onAuthChange = null;
    this._sentSettings = {};
    this._settingsTimer = null;
  }

  get token() { const sh = SH(); return sh && sh.signedIn ? sh.token : null; }
  get sub() { const sh = SH(); return this.token ? sh.userId : null; }
  get slug() { const sh = SH(); return sh ? sh.slug : null; }

  /** Read the launch token (SDK) and wire auth/save events. */
  async init() {
    const sh = SH();
    if (sh) {
      sh.init();
      this.hosted = sh.signedIn;
      sh.on('saved', (ok) => this.setSyncStatus(ok ? 'synced' : 'error'));
      sh.on('auth', (a) => {
        this.hosted = !!a.signedIn;
        if (!a.signedIn) { this.nickname = null; this.setSyncStatus('offline'); }
        this.onAuthChange?.(this.hosted);
      });
    }
    if (this.hosted) {
      window.addEventListener('pagehide', () => this.flushCloudSave());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushCloudSave();
      });
    }
    return this;
  }

  /** Device clock (no time sync standalone). */
  now() { return Date.now(); }

  setConsent(ok) { this.consented = !!ok; }

  /* ---------------- account ---------------- */

  canSignIn() { const sh = SH(); return !!(sh && sh.canSignIn()); }
  signIn() { const sh = SH(); return !!(sh && sh.signIn()); }
  inviteLink() { return this.hosted ? SH().inviteLink() : null; }

  /* ---------------- identity ---------------- */

  /** Account nickname for a user id; "Player <id>" fallback, never usernames. */
  async profileFor(userId) {
    if (!userId || !this.hosted) return null;
    const p = await SH().profile(userId).catch(() => null);
    return p ? p.displayName : `Player ${String(userId).slice(0, 8)}`;
  }

  /** The signed-in player's display name (null when local). */
  async fetchNickname() {
    if (!this.hosted || !this.sub) return null;
    this.nickname = await this.profileFor(this.sub);
    return this.nickname;
  }

  /** Object URL of the signed-in player's avatar, or null. */
  async avatarUrl() {
    return this.hosted ? SH().avatarUrl().catch(() => null) : null;
  }

  /* ---------------- per-player settings (KV) ---------------- */

  /** Apply platform settings over `settings` (platform wins). Resolves true when changed. */
  async applyPlatformSettings(settings) {
    if (!this.hosted) return false;
    const remote = await SH().getSettings().catch(() => ({}));
    let changed = false;
    for (const g of SETTING_GROUPS) {
      const v = remote ? remote[g] : undefined;
      if (v === undefined || v === null) continue;
      settings[g] = v && typeof v === 'object' && settings[g] && typeof settings[g] === 'object' ? { ...settings[g], ...v } : v;
      changed = true;
    }
    this._sentSettings = JSON.parse(JSON.stringify(this._pick(settings)));
    return changed;
  }
  _pick(settings) {
    return Object.fromEntries(SETTING_GROUPS.filter((g) => settings[g] !== undefined).map((g) => [g, settings[g]]));
  }
  /** Patch changed settings groups to the platform (debounced). */
  mirrorSettings(settings) {
    if (!this.hosted) return;
    clearTimeout(this._settingsTimer);
    this._settingsTimer = setTimeout(() => {
      const now = this._pick(settings);
      const diff = {};
      for (const [k, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(this._sentSettings[k])) diff[k] = v;
      if (!Object.keys(diff).length) return;
      this._sentSettings = JSON.parse(JSON.stringify(now));
      SH().patchSettings(diff);
    }, 600);
  }

  /* ---------------- controls ---------------- */

  /** Effective bindings: `base` with the platform's overrides (no call standalone). */
  async loadBindings(base) {
    const sh = SH();
    return sh ? sh.loadBindings(base).catch(() => base) : base;
  }
  /** Persist one remapped action (signed in only). */
  setControl(action, codes) {
    if (this.hosted) SH().setControl(action, codes).catch(() => {});
  }
  resetControls() {
    if (this.hosted) SH().resetControls();
  }

  /* ---------------- cloud save (mirror of the local save document) ---------------- */

  setSyncStatus(status) {
    if (this.syncStatus === status) return;
    this.syncStatus = status;
    this.onSyncChange?.(status);
  }

  /** Remote save document (parsed), or null when none/unsupported. */
  async cloudLoad() {
    if (!this.hosted) return null;
    return SH().loadJSON();
  }

  /** Debounced cloud mirror (2 s); call on every local persist. */
  queueCloudSave(save) {
    if (!this.hosted) return;
    this.setSyncStatus('saving');
    SH().saveJSON(save, CLOUD_DEBOUNCE_MS);
  }

  /** Push any pending save immediately (pagehide / visibilitychange). */
  flushCloudSave() {
    if (!this.hosted) return Promise.resolve();
    return SH().flushSave(true);
  }

  /* ---------------- leaderboards (read-only on-platform) ---------------- */

  /** Global board entries with nicknames resolved, or null when unavailable. */
  async fetchGlobalBoard() {
    if (!this.hosted) return null;
    const sh = SH();
    const game = await sh.getGame();
    let leaderboardId = game && game.leaderboardId;
    if (!leaderboardId) {
      const boards = await sh.leaderboards();
      leaderboardId = boards && boards[0] && boards[0].id;
    }
    if (!leaderboardId) return null;
    const data = await sh.leaderboardEntries(leaderboardId, { page: 1, pageSize: 20 });
    const raw = Array.isArray(data) ? data : (data.items || data.entries || []);
    const entries = [];
    for (const e of raw.slice(0, 20)) {
      const userId = e.userId ?? e.user_id ?? e.sub;
      const name = await this.profileFor(userId).catch(() => null) || 'Player';
      entries.push({
        rank: e.rank ?? e.place ?? entries.length + 1,
        name,
        score: e.score ?? e.value ?? 0,
      });
    }
    return entries;
  }

  /* ---------------- telemetry (in-memory only) ---------------- */

  /** Anonymous funnel event, consent-gated and kept in memory. Never sent
   *  anywhere (the platform has no such route). */
  track(event, props = {}) {
    const allowed = ['start', 'tutorial_step', 'round_end', 'retry', 'settings_change', 'error'];
    if (!this.consented || !allowed.includes(event)) return;
    const rec = { event, props: sanitize(props), t: Math.round(this.now() / 1000) };
    this.funnel.push(rec);
  }
}

function sanitize(props) {
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 40 && !/[@\s]/.test(v)) out[k] = v;
  }
  return out;
}
