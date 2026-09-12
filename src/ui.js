/**
 * ui.js — responsive DOM shell: screens, overlays, focus, input, settings,
 * accessibility mirror, and the game controller binding session ↔ renderer
 * ↔ audio. UI state and simulation state are strictly separate: the only
 * writer of rules state is Session.command().
 */

import {
  PLAYER_DEFS, REASON_TEXT, legalActions, circuitCell, isSafeCell, DONE, TRACK_LEN,
  rankPlayers, scoreBreakdown,
} from './rules.js';
import { Session } from './session.js';
import {
  THEMES, LESSONS, JOURNEY, CHALLENGES, ACHIEVEMENTS,
  dailyForDate, stageRuleset, themeById,
} from './content.js';
import { AI_LEVELS, aiName, hintMove } from './ai.js';
import { floatPos, diePos } from './boardlayout.js';
import {
  loadSave, storeSave, serializeSave, parseDoc, loadSettings, storeSettings, loadSnapshot, clearSnapshot,
} from './save.js';
import { EVENT_CAPTIONS } from './audio.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const DIE_GLYPHS = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

/* ------------------------------------------------------------------ */
/* App state machine — every transition has one owner and a reason     */
/* ------------------------------------------------------------------ */
export const AppState = Object.freeze({
  BOOT: 'boot', TITLE: 'title', PROFILE: 'profile-ready', MODE_SELECT: 'mode-select',
  SETUP: 'setup', PREPARING: 'preparing', COUNTDOWN: 'countdown', ACTIVE: 'active',
  PAUSED: 'paused', RECONNECTING: 'reconnecting', RESOLVING: 'resolving',
  RESULTS: 'results', PROGRESSION: 'progression',
});

const app = {
  state: AppState.BOOT,
  platform: null, renderer: null, audio: null,
  save: null, settings: null,
  session: null,           // Session or HostedSession
  mode: null, content: null, lesson: null,
  inputLocked: false,
  replayMode: false,
  hosted: null,            // hosted room context
  focusBeforeOverlay: null,
  keyMap: null,
  lessonStepIdx: 0,
  capturedThisGame: 0,     // times the primary player was captured (flawless)
  gamepad: { idx: null, prev: [] },
};

function setState(next, reason, owner = 'ui') {
  const prev = app.state;
  app.state = next;
  document.getElementById('app').dataset.state = next;
  if (prev !== next) console.info(`[state] ${prev} → ${next} (${reason}, owner=${owner})`);
}

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                    */
/* ------------------------------------------------------------------ */
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

function toast(text, kind = 'info', ms = 3400) {
  const t = el('div', { class: `toast ${kind}`, role: 'status', text });
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), ms);
}

/* ----- platform identity + persistence ----- */

/** The player's display name: account nickname when hosted, local name otherwise. */
function displayName() {
  return (app.platform?.hosted && app.platform.nickname) || app.save.profile.name;
}

/** Local write + cloud mirror (debounced; no-op when offline). */
function persistSave() {
  storeSave(app.save);
  app.platform?.queueCloudSave(serializeSave(app.save));
}

const SYNC_LABELS = { synced: '☁ synced', saving: '☁ saving…', error: '☁ offline' };
function renderSyncStatus() {
  const n = $('#sync-status');
  if (!n) return;
  const p = app.platform;
  n.textContent = (p?.hosted && SYNC_LABELS[p.syncStatus]) || '';
}

/** Hosted boot: apply the remote save (remote wins) and account nickname. */
async function applyPlatformIdentity() {
  const p = app.platform;
  if (!p?.hosted) return;
  p.onSyncChange = renderSyncStatus;
  try {
    const doc = await p.cloudLoad();
    const payload = doc && parseDoc(doc);
    if (payload && payload.profile && payload.stats) {
      app.save = payload;
      storeSave(app.save);
    }
  } catch { /* keep the local cache */ }
  try { await p.fetchNickname(); } catch { /* fallback name already set */ }
  renderSyncStatus();
  if (app.state === AppState.TITLE || app.state === AppState.PROFILE) showTitle();
}

function announce(region, text) {
  const n = $(`#live-${region}`);
  if (!n) return;
  n.textContent = '';
  requestAnimationFrame(() => { n.textContent = text; });
}

let confirmResolve = null;
function confirmDialog(text, danger = true) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $('#confirm-text').textContent = text;
    $('#confirm-yes').classList.toggle('danger', danger);
    showOverlay('confirm');
  });
}

/* ------------------------------------------------------------------ */
/* overlay manager: focus trap + restoration, no keyboard traps        */
/* ------------------------------------------------------------------ */
const OVERLAYS = ['pause', 'settings', 'results', 'help', 'achievements', 'boards', 'profile', 'boardstate', 'confirm'];

function showOverlay(name) {
  app.focusBeforeOverlay = document.activeElement;
  const ov = $(`#overlay-${name}`);
  ov.hidden = false;
  const focusable = ov.querySelector('button, [href], input, select, [tabindex]');
  if (focusable) focusable.focus();
  ov.onkeydown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); hideOverlay(name); }
    if (e.key !== 'Tab') return;
    const items = [...ov.querySelectorAll('button, [href], input, select, [tabindex]')]
      .filter((n) => !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
}

function hideOverlay(name) {
  $(`#overlay-${name}`).hidden = true;
  if (name === 'confirm' && confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
  restoreFocus();
  // Dismissing the pause panel (Escape) must also leave the paused state,
  // otherwise the match is frozen with no visible way back.
  if (name === 'pause' && app.state === AppState.PAUSED) resumeGame();
}

function hideAllOverlays() { OVERLAYS.forEach((n) => { $(`#overlay-${n}`).hidden = true; }); }

function restoreFocus() {
  const elPrev = app.focusBeforeOverlay;
  if (elPrev && document.contains(elPrev)) elPrev.focus();
  app.focusBeforeOverlay = null;
}

function anyOverlayOpen() { return OVERLAYS.some((n) => !$(`#overlay-${n}`).hidden); }

/* ------------------------------------------------------------------ */
/* screens                                                             */
/* ------------------------------------------------------------------ */
const SCREENS = ['boot', 'title', 'setup', 'journey', 'learn', 'challenge', 'hosted', 'game'];

function showScreen(name) {
  SCREENS.forEach((s) => $(`#screen-${s}`).classList.toggle('active', s === name));
  if (name === 'game') $('#btn-roll').focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ */
/* settings: load/apply/build UI                                       */
/* ------------------------------------------------------------------ */
function applySettings() {
  const s = app.settings;
  const a = s.accessibility;
  document.body.classList.toggle('large-text', a.largeText);
  document.body.classList.toggle('high-contrast', a.highContrast);
  document.body.classList.toggle('reduced-motion', a.reducedMotion);
  document.body.classList.toggle('left-handed', a.leftHanded);
  document.body.classList.toggle('palette-cvd', a.palette === 'cvd');
  if (app.renderer) {
    app.renderer.setReducedMotion(a.reducedMotion);
    app.renderer.setPalette(a.palette);
    app.renderer.setQuality(resolveTier());
    app.renderer.setCameraMode(s.camera.mode);
  }
  if (app.audio) {
    for (const bus of ['music', 'effects', 'ambience', 'voice']) {
      app.audio.setVolume(bus, s.audio[bus]);
    }
    app.audio.setMuted(s.audio.muted);
  }
  document.documentElement.style.setProperty('--accent', themeById(s.theme).accentCss);
  document.documentElement.style.setProperty('--bg', themeById(s.theme).bgCss);
}

function resolveTier() {
  const t = app.settings.graphics.tier;
  if (t !== 'auto') return t;
  // mechanism-backed auto tier: cores + memory + DPR
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  const mobile = matchMedia('(pointer: coarse)').matches;
  if (mobile && (cores <= 4 || mem <= 3)) return 'low';
  if (cores >= 8 && mem >= 8) return 'high';
  return mobile ? 'low' : 'medium';
}

const DEFAULT_BINDINGS = {
  confirm: ['Space', 'Enter'], cancel: ['Escape'], pause: ['Escape', 'KeyP'],
  undo: ['KeyU'], hint: ['KeyH'], camera: ['KeyC'], board: ['KeyB'],
  next: ['ArrowRight', 'ArrowDown'], prev: ['ArrowLeft', 'ArrowUp'],
};

function bindings() {
  return { ...DEFAULT_BINDINGS, ...(app.settings.input.bindings || {}) };
}

function buildSettingsBody(tab) {
  const body = $('#settings-body');
  body.innerHTML = '';
  const s = app.settings;
  const save = () => { storeSettings(s); applySettings(); app.platform.track('settings_change', { tab }); };

  if (tab === 'audio') {
    for (const [bus, label] of [['music', 'Music'], ['effects', 'Effects'], ['ambience', 'Ambience'], ['voice', 'Voice cues']]) {
      const row = el('div', { class: 'field' });
      row.append(el('label', { class: 'field-label', for: `vol-${bus}`, text: label }));
      const wrap = el('div', { class: 'slider-row' });
      const slider = el('input', {
        type: 'range', id: `vol-${bus}`, min: 0, max: 1, step: 0.05, value: s.audio[bus],
        'aria-label': `${label} volume`,
      });
      const val = el('span', { text: `${Math.round(s.audio[bus] * 100)}%` });
      slider.addEventListener('input', () => {
        s.audio[bus] = Number(slider.value);
        val.textContent = `${Math.round(slider.value * 100)}%`;
        save();
        if (bus === 'effects') app.audio.event('select');
      });
      wrap.append(el('span', { class: 'muted', text: '' }), slider, val);
      wrap.firstChild.remove();
      row.append(wrap);
      body.append(row);
    }
    body.append(checkField('Mute all audio', s.audio.muted, (v) => { s.audio.muted = v; save(); }));
    body.append(checkField('Captions for meaningful audio', s.accessibility.captions, (v) => { s.accessibility.captions = v; save(); }));
  }

  if (tab === 'graphics') {
    body.append(segField('Quality tier', ['auto', 'low', 'medium', 'high'], s.graphics.tier, (v) => { s.graphics.tier = v; save(); },
      'Auto picks from device capability. Tiers change shadows, particles and render scale — never rules.'));
    body.append(segField('Camera', ['auto', 'top', 'low'], s.camera.mode, (v) => { s.camera.mode = v; save(); }));
    body.append(segField('Theme', THEMES.map((t) => t.id), s.theme, (v) => {
      s.theme = v; save();
      if (app.renderer) app.renderer.setTheme(themeById(v));
    }, 'Visual theme. Cosmetics never alter rules or hazards.'));
  }

  if (tab === 'controls') {
    const map = bindings();
    const list = el('div', {});
    const labels = {
      confirm: 'Confirm / roll', cancel: 'Cancel / back', pause: 'Pause', undo: 'Undo',
      hint: 'Hint', camera: 'Camera reset', board: 'Board state', next: 'Next target', prev: 'Previous target',
    };
    for (const [action, keys] of Object.entries(labels)) {
      const row = el('div', { class: 'field' });
      row.append(el('div', { class: 'field-label', text: labels[action] }));
      const kbdRow = el('div', { class: 'row' });
      for (const k of map[action] || []) kbdRow.append(el('kbd', { text: prettyKey(k) }));
      const re = el('button', { class: 'btn ghost', text: 'Remap' });
      re.addEventListener('click', () => {
        re.textContent = 'Press a key…';
        const once = (e) => {
          e.preventDefault();
          window.removeEventListener('keydown', once, true);
          s.input.bindings = { ...(s.input.bindings || {}), [action]: [e.code] };
          save(); buildSettingsBody('controls');
        };
        window.addEventListener('keydown', once, true);
      });
      kbdRow.append(re);
      row.append(kbdRow);
      list.append(row);
    }
    body.append(list);
    body.append(checkField('Left-handed controls', s.accessibility.leftHanded, (v) => { s.accessibility.leftHanded = v; save(); }));
    body.append(checkField('Hold to confirm (instead of toggle)', s.accessibility.holdToConfirm, (v) => { s.accessibility.holdToConfirm = v; save(); }));
    const reset = el('button', { class: 'btn ghost', text: 'Reset bindings to defaults' });
    reset.addEventListener('click', () => { s.input.bindings = null; save(); buildSettingsBody('controls'); });
    body.append(reset);
  }

  if (tab === 'access') {
    const a = s.accessibility;
    body.append(checkField('Reduced motion (no camera swoops, shake, or rapid particles)', a.reducedMotion, (v) => { a.reducedMotion = v; save(); }));
    body.append(checkField('High contrast', a.highContrast, (v) => { a.highContrast = v; save(); }));
    body.append(checkField('Larger text', a.largeText, (v) => { a.largeText = v; save(); }));
    body.append(segField('Color palette', ['standard', 'cvd'], a.palette, (v) => { a.palette = v; save(); },
      'The CVD palette uses blue/gold separation; player identity also uses shapes and labels.'));
    body.append(checkField('Timing assistance (longer AI pauses, slower banners)', a.timingAssist, (v) => { a.timingAssist = v; save(); }));
    body.append(checkField('Haptics (vibration on supported devices)', a.haptics, (v) => { a.haptics = v; save(); }));
    const replayT = el('button', { class: 'btn', text: 'Replay tutorial lessons' });
    replayT.addEventListener('click', () => { hideOverlay('settings'); showLearn(); });
    body.append(replayT);
    const consent = checkField('Share anonymous usage funnel (start/round-end/settings only)', s.consent.analytics, (v) => {
      s.consent.analytics = v; app.platform.setConsent(v); save();
    });
    body.append(consent);
  }
}

function checkField(label, value, onChange) {
  const id = `chk-${Math.random().toString(36).slice(2, 8)}`;
  const wrap = el('div', { class: 'field check' });
  const input = el('input', { type: 'checkbox', id });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.append(input, el('label', { for: id, text: label }));
  return wrap;
}

function segField(label, options, current, onChange, hint) {
  const wrap = el('div', { class: 'field' });
  wrap.append(el('div', { class: 'field-label', text: label }));
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  for (const opt of options) {
    const label = typeof opt === 'number' ? String(opt)
      : opt === 'cvd' ? 'CVD-safe'
      : opt[0].toUpperCase() + opt.slice(1);
    const b = el('button', { text: label, 'aria-pressed': String(opt === current) });
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onChange(opt);
    });
    seg.append(b);
  }
  wrap.append(seg);
  if (hint) wrap.append(el('p', { class: 'hint', text: hint }));
  return wrap;
}

function prettyKey(code) {
  return code.replace('Key', '').replace('Arrow', '').replace('Space', '␣ Space').replace('Escape', 'Esc');
}

function haptic(ms = 12) {
  if (app.settings.accessibility.haptics && navigator.vibrate) navigator.vibrate(ms);
}

/* ------------------------------------------------------------------ */
/* title + mode setup                                                  */
/* ------------------------------------------------------------------ */
function showTitle() {
  hideAllOverlays();
  setState(AppState.TITLE, 'show-title');
  showScreen('title');
  if (app.audio) { app.audio.setMusic('title'); }
  $('#profile-name').textContent = displayName();
  renderSyncStatus();
  const done = Object.keys(app.save.journey).length;
  $('#journey-sub').textContent = done ? `${done}/40 stages complete` : '40 festival stages';
  const today = dailyForDate(new Date(app.platform.now()));
  const rec = app.save.dailies[today.date];
  $('#daily-sub').textContent = rec ? `Today: ${rec.won ? 'won' : 'played'} · score ${rec.score}` : 'One shared race each day';
  if ($('#hosted-sub')) {
    $('#hosted-sub').textContent = app.platform?.hosted ? 'Coming soon to this build' : 'Rooms with friends';
  }
  // resume offer
  const snap = loadSnapshot();
  if (snap && snap.state && snap.state.phase !== 'over' && !app._resumeOffered) {
    app._resumeOffered = true;
    const btn = el('button', { class: 'btn', text: '↺ Resume saved game' });
    btn.addEventListener('click', () => { btn.remove(); resumeSnapshot(snap); });
    const play = $('#btn-play');
    play.parentNode.insertBefore(btn, play.nextSibling);
    setTimeout(() => btn.remove(), 30000);
  }
}

function resumeSnapshot(snap) {
  try {
    const def = snap.contentId ? findContent(snap.contentId) : null;
    // A restored lesson needs app.lesson (enterGameScreen reads its title) and
    // a restored stage needs session.content, or its goal/records are lost.
    app.lesson = snap.mode === 'learn' ? def : null;
    app.content = snap.mode === 'learn' ? null : def;
    app.session = Session.restore(snap, onSessionEvent, { content: app.content, lesson: app.lesson });
    app.mode = snap.mode;
    app.lastGameOpts = { mode: snap.mode, ruleset: snap.state.ruleset, seed: snap.envelope.seed,
      players: snap.state.players.map(p => ({ name: p.name, kind: p.kind, level: p.level })),
      ranked: snap.ranked, undoAllowed: snap.undoAllowed, content: app.content, lesson: app.lesson };
    app.capturedThisGame = 0;
    app.replayMode = false;
    setState(AppState.ACTIVE, 'resume-snapshot');
    enterGameScreen();
    syncAll();
    toast('Saved game restored.');
  } catch (e) {
    console.error(e);
    clearSnapshot();
    toast('Could not restore the saved game.', 'error');
  }
}

function findContent(id) {
  return JOURNEY.find((s) => s.id === id) || CHALLENGES.find((c) => c.id === id)
    || LESSONS.find((l) => l.id === id) || null;
}

/* ----- setup builders: one per mode, showing rules/duration/ranked ----- */
function showSetup(mode, content = null, lesson = null) {
  app.mode = mode; app.content = content; app.lesson = lesson;
  setState(AppState.SETUP, `setup-${mode}`);
  showScreen('setup');
  const body = $('#setup-body');
  body.innerHTML = '';
  $('#setup-h').textContent = content?.name || lesson?.title || ({
    practice: 'Practice Match', daily: 'Daily Circuit', journey: content?.name || 'Journey',
    challenge: content?.name || 'Challenge', learn: lesson?.title || 'Lesson', local: 'Local Table',
  })[mode] || 'Set up';

  const cfg = { players: 2, aiLevel: 2, humans: 1 };
  if (mode === 'practice') {
    body.append(segField('Players', [2, 3, 4], cfg.players, (v) => { cfg.players = v; renderSummary(); }));
    body.append(segField('AI difficulty', AI_LEVELS.map((l) => l.level), cfg.aiLevel, (v) => { cfg.aiLevel = v; renderSummary(); }));
    body.append(segField('Floats per player', [2, 3, 4], 4, (v) => { cfg.floats = v; renderSummary(); }));
    cfg.floats = 4;
    const variants = el('div', { class: 'field' });
    variants.append(el('div', { class: 'field-label', text: 'Rule variants' }));
    cfg.exactFinish = true; cfg.blockades = true; cfg.safeTrack = true;
    variants.append(checkField('Exact finish (overshoot is wasted)', true, (v) => { cfg.exactFinish = v; renderSummary(); }));
    variants.append(checkField('Processions (blockades)', true, (v) => { cfg.blockades = v; renderSummary(); }));
    variants.append(checkField('Lantern safe tiles', true, (v) => { cfg.safeTrack = v; renderSummary(); }));
    body.append(variants);
  }
  if (mode === 'local') {
    body.append(segField('Players at this table', [2, 3, 4], cfg.players, (v) => { cfg.players = v; renderSummary(); }));
    body.append(el('p', { class: 'hint', text: 'Pass-and-play: everyone shares this device. Undo is allowed between turns.' }));
  }

  const summary = el('div', { class: 'summary-card' });
  body.append(summary);
  function renderSummary() {
    const dur = mode === 'learn' ? '~2 min' : cfg.players === 2 ? '~6–10 min' : '~10–15 min';
    const ranked = mode === 'daily' || mode === 'journey' || mode === 'challenge';
    const rules = [];
    if (mode === 'practice') {
      rules.push(`${cfg.players} players`, `${AI_LEVELS.find((l) => l.level === cfg.aiLevel).name} AI`,
        `${cfg.floats} floats each`, cfg.exactFinish ? 'exact finish' : 'bounce finish',
        cfg.blockades ? 'processions on' : 'no processions', cfg.safeTrack ? 'lantern tiles' : 'dark circuit');
    } else if (content) {
      const r = content.ruleset;
      rules.push(`${r.players} players`, `${r.floats ?? 4} floats each`,
        r.exactFinish === false ? 'bounce finish' : 'exact finish',
        r.safeTrack === false ? 'no safe tiles' : 'lantern tiles',
        r.maxTurns ? `limit ${r.maxTurns} rounds` : 'no turn limit');
    } else if (mode === 'local') {
      rules.push(`${cfg.players} players`, 'standard rules');
    } else {
      rules.push('scripted lesson dice');
    }
    summary.innerHTML = `<b>Rules:</b> ${rules.join(' · ')}<br>` +
      `<b>Expected duration:</b> ${dur}<br>` +
      `<b>Ranked:</b> ${ranked ? 'yes — counts for records' : 'no — practice does not affect rating'}<br>` +
      `<b>Assists:</b> hints available${mode === 'practice' || mode === 'local' || mode === 'learn' ? ', undo allowed' : ''}`;
  }
  renderSummary();

  $('#setup-start').onclick = () => {
    if (mode === 'practice') {
      const players = [{ name: displayName(), kind: 'human' }];
      for (let i = 1; i < cfg.players; i++) players.push({ kind: 'ai', level: cfg.aiLevel, name: aiName(cfg.aiLevel, i - 1) });
      startGame({
        mode, players, seed: (Math.random() * 0xffffffff) >>> 0,
        ruleset: { players: cfg.players, floats: cfg.floats, exactFinish: cfg.exactFinish, blockades: cfg.blockades, safeTrack: cfg.safeTrack },
        ranked: false, undoAllowed: true,
      });
    } else if (mode === 'local') {
      const players = Array.from({ length: cfg.players }, (_, i) => ({ name: `Seat ${i + 1}`, kind: 'human' }));
      startGame({ mode, players, seed: (Math.random() * 0xffffffff) >>> 0, ruleset: { players: cfg.players }, ranked: false, undoAllowed: true });
    } else if (mode === 'learn') {
      startGame({
        mode, lesson, seed: lesson.ruleset.seed, ruleset: lesson.ruleset,
        players: [{ name: displayName(), kind: 'human' }, { kind: 'ai', level: 1, name: aiName(1, 0) }],
        ranked: false, undoAllowed: true,
      });
    } else {
      // journey / daily / challenge content-driven
      const def = content;
      const players = [{ name: displayName(), kind: 'human' }];
      for (const ai of def.ai) players.splice(ai.seat, 0, { kind: 'ai', level: ai.level, name: aiName(ai.level, ai.seat - 1) });
      players.sort((a, b) => 0); // seats are by array order already
      startGame({
        mode, content: def, seed: def.seed, ruleset: stageRuleset(def),
        players, ranked: mode !== 'practice',
        undoAllowed: false,
      });
    }
  };
  $('#setup-back').onclick = () => {
    if (mode === 'journey') showJourney();
    else if (mode === 'learn') showLearn();
    else if (mode === 'challenge') showChallenges();
    else showTitle();
  };
}

/* ----- journey map ----- */
function showJourney() {
  setState(AppState.MODE_SELECT, 'journey-map');
  showScreen('journey');
  const grid = $('#journey-grid');
  grid.innerHTML = '';
  const done = app.save.journey;
  const doneCount = Object.keys(done).length;
  $('#journey-progress-line').textContent =
    `${doneCount} of 40 stages complete · ${Object.values(done).reduce((s, r) => s + (r.stars || 0), 0)} stars`;
  for (const stage of JOURNEY) {
    const rec = done[stage.id];
    const unlocked = stage.index === 1 || done[JOURNEY[stage.index - 2]?.id];
    const cell = el('button', {
      class: `stage-cell${stage.mastery ? ' mastery' : ''}`, role: 'listitem',
      'aria-label': `Stage ${stage.index}: ${stage.name}${rec ? `, ${rec.stars} stars` : ''}${unlocked ? '' : ', locked'}`,
    });
    cell.append(
      el('span', { class: 'num', text: String(stage.index) }),
      el('span', { class: 'stars', text: rec ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : (unlocked ? '···' : '🔒') }),
      el('span', { class: 'sname', text: stage.name }),
    );
    if (!unlocked) cell.disabled = true;
    else cell.addEventListener('click', () => showSetup('journey', stage));
    grid.append(cell);
  }
}

/* ----- learn ----- */
function showLearn() {
  setState(AppState.MODE_SELECT, 'learn-list');
  showScreen('learn');
  const list = $('#lesson-list');
  list.innerHTML = '';
  for (const lesson of LESSONS) {
    const doneIt = !!app.save.lessons[lesson.id];
    const prevDone = lesson.order === 1 || app.save.lessons[LESSONS[lesson.order - 2].id];
    const item = el('button', { class: `card-item${doneIt ? ' done' : ''}`, role: 'listitem' });
    item.append(
      el('span', { class: 'ci-icon', text: doneIt ? '✅' : '📜' }),
      el('span', { class: 'ci-body' }),
      el('span', { class: 'ci-meta', text: `Lesson ${lesson.order}` }),
    );
    item.querySelector('.ci-body').append(
      el('div', { class: 'ci-title', text: lesson.title }),
      el('div', { class: 'ci-sub', text: lesson.intro }),
    );
    if (!prevDone && !doneIt) { item.disabled = true; item.querySelector('.ci-meta').textContent = '🔒'; }
    else item.addEventListener('click', () => showSetup('learn', null, lesson));
    list.append(item);
  }
}

/* ----- challenges ----- */
function showChallenges() {
  setState(AppState.MODE_SELECT, 'challenge-list');
  showScreen('challenge');
  const list = $('#challenge-list');
  list.innerHTML = '';
  for (const ch of CHALLENGES) {
    const best = app.save.leaderboards.best.find((b) => b.contentId === ch.id);
    const item = el('button', { class: 'card-item', role: 'listitem' });
    item.append(
      el('span', { class: 'ci-icon', text: '⚡' }),
      el('span', { class: 'ci-body' }),
      el('span', { class: 'ci-meta', text: best ? `best ${best.score}` : '' }),
    );
    item.querySelector('.ci-body').append(
      el('div', { class: 'ci-title', text: ch.name }),
      el('div', { class: 'ci-sub', text: ch.blurb }),
    );
    item.addEventListener('click', () => showSetup('challenge', ch));
    list.append(item);
  }
}

/* ----- daily ----- */
function showDaily() {
  const def = dailyForDate(new Date(app.platform.now()));
  showSetup('daily', def);
}

/* ------------------------------------------------------------------ */
/* overlays: achievements / boards / profile / help                    */
/* ------------------------------------------------------------------ */
function showAchievements() {
  const body = $('#ach-body');
  body.innerHTML = '';
  for (const a of ACHIEVEMENTS) {
    const got = app.save.achievements[a.key];
    const item = el('div', { class: `card-item${got ? ' done' : ''}`, role: 'listitem' });
    item.append(
      el('span', { class: 'ci-icon', text: got ? a.icon : '🔒' }),
      el('span', { class: 'ci-body' }),
      el('span', { class: 'ci-meta', text: got ? new Date(got).toLocaleDateString() : '' }),
    );
    item.querySelector('.ci-body').append(
      el('div', { class: 'ci-title', text: a.name }),
      el('div', { class: 'ci-sub', text: a.desc }),
    );
    body.append(item);
  }
  showOverlay('achievements');
}

function showBoards(board = 'daily') {
  $$('#overlay-boards .tab').forEach((t) => {
    const on = t.dataset.board === board;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  const body = $('#boards-body');
  body.innerHTML = '';
  const hosted = app.platform?.hosted;
  const rows = app.save.leaderboards[board === 'daily' ? 'daily' : 'best'];
  if (!rows.length) {
    body.append(el('p', { class: 'muted', text: board === 'daily'
      ? 'No daily results yet — play today’s Daily Circuit.'
      : 'No records yet — finish a journey stage, challenge or daily.' }));
  } else {
    const table = el('table', { class: 'result-table' });
    table.innerHTML = '<thead><tr><th>#</th><th>Where</th><th>Result</th><th class="num">Score</th><th class="num">Turns</th><th>Seed</th></tr></thead>';
    const tb = el('tbody', {});
    rows.slice(0, 20).forEach((r, i) => {
      const tr = el('tr', {});
      tr.append(
        el('td', { text: String(i + 1) }),
        el('td', { text: r.contentId || '—' }),
        el('td', { text: r.won ? 'Won' : 'Lost' }),
        el('td', { class: 'num', text: String(r.score) }),
        el('td', { class: 'num', text: String(r.turns) }),
        el('td', { class: 'num', text: String(r.seed).slice(0, 8) }),
      );
      tb.append(tr);
    });
    table.append(tb);
    body.append(table);
    body.append(el('p', { class: 'hint', text: hosted
      ? 'Personal bests — these records live on this device and sync with your account; they are never submitted as ranked scores. Each row keeps its ruleset, content version, seed and duration; impossible scores are rejected before they are recorded.'
      : 'Casual board — these records are stored on this device only and are not submitted or compared against other players. Each row keeps its ruleset, content version, seed and duration; impossible scores are rejected before they are recorded.' }));
  }
  // Read-only platform board (script-owned): shown when the host provides one.
  if (hosted) {
    const slot = el('div', {});
    slot.append(el('p', { class: 'muted', text: 'Loading the festival leaderboard…' }));
    body.append(slot);
    app.platform.fetchGlobalBoard().then((entries) => {
      if ($('#overlay-boards').hidden) return; // closed while fetching
      slot.innerHTML = '';
      if (!entries || !entries.length) {
        slot.append(el('p', { class: 'muted', text: 'No platform leaderboard for this board yet — personal bests above are the record.' }));
        return;
      }
      slot.append(el('h3', { text: 'Festival leaderboard' }));
      const table = el('table', { class: 'result-table' });
      table.innerHTML = '<thead><tr><th>#</th><th>Player</th><th class="num">Score</th></tr></thead>';
      const tb = el('tbody', {});
      for (const e of entries) {
        const tr = el('tr', {});
        tr.append(
          el('td', { text: String(e.rank) }),
          el('td', { text: e.name }),
          el('td', { class: 'num', text: String(e.score) }),
        );
        tb.append(tr);
      }
      table.append(tb);
      slot.append(table);
      slot.append(el('p', { class: 'hint', text: 'Ranked scores are owned by the platform — this build reads the board but cannot submit to it.' }));
    });
  }
  showOverlay('boards');
}

function showProfile() {
  const body = $('#profile-body');
  body.innerHTML = '';
  const p = app.save.profile;
  const st = app.save.stats;
  const hosted = app.platform?.hosted;
  const nameField = el('div', { class: 'field' });
  nameField.append(el('label', { class: 'field-label', for: 'prof-name', text: 'Display name' }));
  if (hosted) {
    // The account nickname comes from the platform profile; it is not editable here.
    nameField.append(el('div', { id: 'prof-name', class: 'field-label', text: displayName() }));
  } else {
    const input = el('input', { type: 'text', id: 'prof-name', value: p.name, maxlength: 20 });
    input.addEventListener('change', () => {
      p.name = input.value.trim().slice(0, 20) || 'Guest Envoy';
      persistSave();
      $('#profile-name').textContent = displayName();
      toast('Name saved.');
    });
    nameField.append(input);
  }
  body.append(nameField);
  const stats = el('div', { class: 'summary-card' });
  stats.innerHTML = `<b>Games:</b> ${st.gamesPlayed} · <b>Won:</b> ${st.gamesWon}<br>` +
    `<b>Captures:</b> ${st.captures} · <b>Floats crowned:</b> ${st.crowned}<br>` +
    `<b>Daily streak:</b> ${st.streakDays} day(s)<br>` +
    (hosted
      ? `<b>Account:</b> Signed in via the platform — progress syncs to your account (${SYNC_LABELS[app.platform.syncStatus] || '☁ synced'}). This device keeps an offline copy.`
      : `<b>Account:</b> Guest — progress is stored on this device. Sign-in arrives with the host shell; nothing is uploaded without it.`);
  body.append(stats);
  const wipe = el('button', { class: 'btn danger', text: 'Erase all local progress' });
  wipe.addEventListener('click', async () => {
    if (await confirmDialog('Erase all local progress, settings stay. This cannot be undone.')) {
      localStorage.removeItem('royal-circuit:save:v1');
      app.save = loadSave();
      if (hosted) app.platform.queueCloudSave(serializeSave(app.save)); // mirror the wipe
      toast('Progress erased.');
      hideOverlay('profile');
      showTitle();
    }
  });
  body.append(wipe);
  showOverlay('profile');
}

function showHelp() {
  const body = $('#help-body');
  body.innerHTML = '';
  const map = bindings();
  body.append(el('p', { text: 'Race four floats from your workshop around the Grand Circuit. A full lap earns the right to climb your Grand Approach — crown all four floats in the pavilion to win.' }));
  const cards = el('div', { class: 'help-cards' });
  const data = [
    ['🎲', 'Kindling', 'Roll a 6 to move a float from the workshop onto your start tile. A 6 also grants an encore roll — but three 6s in a row are overkindled and end your turn.'],
    ['🏮', 'Lantern tiles', 'Lit tiles (every 5th) are safe: floats of any color share them and no captures happen there.'],
    ['⚔️', 'Captures', 'Land exactly on a rival float on an ordinary tile to send it back to its workshop.'],
    ['🧱', 'Processions', 'Two of your floats on one ordinary tile form a wall: rivals can neither land on it nor pass it.'],
    ['👑', 'The Approach', 'After a full lap, floats climb their colored approach. The final crown needs an exact roll (unless bounce-back is on).'],
    ['⌨️', 'Controls', `${prettyKey(map.confirm[0])} roll/confirm · arrows switch float · ${prettyKey(map.undo[0])} undo · ${prettyKey(map.hint[0])} hint · ${prettyKey(map.camera[0])} camera · ${prettyKey(map.board[0])} board text · ${prettyKey(map.pause[0])} pause. Gamepad: ✕/A confirm, ○/B cancel, ☰ pause.`],
  ];
  for (const [icon, title, text] of data) {
    const c = el('div', { class: 'help-card' });
    c.append(el('div', { class: 'hc-icon', text: icon }), el('h3', { text: title }), el('p', { text }));
    cards.append(c);
  }
  body.append(cards);
  showOverlay('help');
}

/* ------------------------------------------------------------------ */
/* progression + achievements (idempotent unlocks)                     */
/* ------------------------------------------------------------------ */
function unlock(key) {
  if (app.save.achievements[key]) return false; // idempotent
  app.save.achievements[key] = new Date().toISOString();
  const def = ACHIEVEMENTS.find((a) => a.key === key);
  toast(`Achievement unlocked: ${def?.name || key}`, 'info', 5000);
  app.audio?.event('crown');
  return true;
}

function updateProgression(results) {
  const s = app.save;
  const st = s.stats;
  const mySeat = app.mode === 'hosted' ? (app.hosted?.seat ?? 0) : 0;
  st.gamesPlayed += 1;
  const me = results.rows.find((r) => r.seat === mySeat);
  const won = results.winner === mySeat;
  if (won) st.gamesWon += 1;
  st.captures += me?.captures ?? 0;
  st.crowned += me?.crowned ?? 0;

  // achievements
  if ((me?.crowned ?? 0) > 0 || st.crowned > 0) unlock('first_crown');
  if (won) unlock('first_victory');
  if (st.captures >= 10) unlock('capturer');
  if (won && app.capturedThisGame === 0 && results.mode !== 'learn') unlock('flawless');
  if (st.gamesPlayed >= 100) unlock('centurion');
  if (Object.keys(s.lessons).length >= LESSONS.length) unlock('scholar');
  const journeyDone = Object.keys(s.journey).length;
  if (journeyDone >= 20) unlock('journey_half');
  if (journeyDone >= 40) unlock('journey_complete');

  // journey stars: 1 complete + 1 under par + 1 no invalids
  if (results.mode === 'journey' && app.content && won) {
    const prev = s.journey[app.content.id] || { stars: 0 };
    let stars = 1;
    if (results.turns <= (app.content.par?.turns ?? Infinity)) stars += 1;
    if ((me?.invalid ?? 0) === 0) stars += 1;
    s.journey[app.content.id] = {
      stars: Math.max(prev.stars || 0, stars),
      bestTurns: Math.min(prev.bestTurns ?? Infinity, results.turns),
      completedAt: new Date().toISOString(),
    };
  }

  // daily record + streak
  if (results.mode === 'daily' && app.content) {
    const key = app.content.date;
    const score = me?.breakdown.total ?? 0;
    const prev = s.dailies[key];
    if (!prev || score > prev.score) {
      s.dailies[key] = { score, won, turns: results.turns };
    }
    const yesterday = new Date(app.platform.now() - 86400000);
    const yKey = dailyForDate(yesterday).date;
    if (!prev) {
      st.streakDays = s.dailies[yKey] ? st.streakDays + 1 : 1;
      st.lastDaily = key;
      if (st.streakDays >= 3) unlock('daily_streak_3');
    }
    pushBoard('daily', results, me, mySeat);
  }
  if ((results.mode === 'challenge' || results.mode === 'journey' || results.mode === 'daily')) {
    pushBoard('best', results, me, mySeat);
  }
  persistSave();
}

function pushBoard(board, results, me, mySeat = 0) {
  const entry = {
    contentId: results.contentId, won: results.winner === mySeat,
    score: me?.breakdown.total ?? 0, turns: results.turns,
    seed: results.seed, durationMs: results.elapsedMs,
    ruleset: app.session?.state.ruleset, version: 1, at: new Date().toISOString(),
  };
  if (entry.score < 0 || entry.score > 100000 || entry.turns <= 0) return; // reject impossible
  const list = app.save.leaderboards[board];
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.turns - b.turns);
  app.save.leaderboards[board] = list.slice(0, 50);
}

/* ------------------------------------------------------------------ */
/* game controller                                                     */
/* ------------------------------------------------------------------ */
let animChain = Promise.resolve();

function startGame(opts) {
  clearSnapshot();
  app.lastGameOpts = opts;
  app.session?.cancelPending();
  app.session = new Session({ ...opts, onEvent: onSessionEvent });
  app.capturedThisGame = 0;
  app.lessonStepIdx = 0;
  app.replayMode = false;
  setState(AppState.PREPARING, 'session-created');
  enterGameScreen();
  app.platform.track('start', { mode: opts.mode });
  if (app.audio) {
    app.audio.setMusic(themeById(app.settings.theme).musicMood === 'tense' ? 'tense' : 'calm');
    app.audio.setAmbience(true);
  }
  syncAll();
  countdownThenBegin();
}

function enterGameScreen() {
  hideAllOverlays();
  showScreen('game');
  buildHudPlayers();
  buildRailRules();
  const s = app.session;
  const obj = objectiveText();
  $('#hud-objective').textContent = obj;
  $('#rail-objective').textContent = obj;
  $('#hud-mode-name').textContent =
    app.mode === 'journey' ? `Journey ${app.content.index}` :
    app.mode === 'daily' ? 'Daily Circuit' :
    app.mode === 'challenge' ? app.content.name :
    app.mode === 'learn' ? app.lesson.title :
    app.mode === 'local' ? 'Local Table' :
    app.mode === 'hosted' ? `Room ${app.hosted?.code ?? ''}` : 'Practice';
  announce('objective', obj);
  $('#lesson-coach').hidden = app.mode !== 'learn';
  if (app.mode === 'learn') showLessonStep();
}

function objectiveText() {
  if (app.mode === 'learn') return app.lesson.steps[0]?.text || 'Follow the lesson.';
  if (app.content?.goal) {
    const g = app.content.goal;
    if (g.type === 'crown-first') return `Be first to crown ${g.count || 1} float(s).`;
    if (g.type === 'captures') return `First to ${g.count} captures wins the stage.`;
    if (g.type === 'captures-then-win') return `Win the race with at least ${g.count} captures.`;
    if (g.type === 'win-no-captures') return 'Win without capturing any rival float.';
  }
  const mt = app.session?.state.ruleset.maxTurns;
  return `Crown all your floats first.${mt ? ` Lantern schedule: ${mt} rounds.` : ''}`;
}

function buildRailRules() {
  const r = app.session.state.ruleset;
  const items = [
    r.exactFinish ? 'Exact finish at the crown' : 'Bounce-back finish',
    r.blockades ? 'Processions block rivals' : 'No processions',
    r.safeTrack ? 'Lantern tiles are safe' : 'No safe tiles',
    r.captures ? 'Captures on' : 'Captures off',
    r.maxTurns ? `${r.maxTurns}-round limit` : 'No turn limit',
  ];
  const ul = $('#rail-rules');
  ul.innerHTML = '';
  items.forEach((t) => ul.append(el('li', { text: t })));
}

function countdownThenBegin() {
  setState(AppState.COUNTDOWN, 'countdown');
  banner(`${currentName()} begins — roll!`, 1600);
  setState(AppState.ACTIVE, 'round-begin');
  updateFlow();
}

function currentName() {
  const p = app.session.currentPlayer;
  return p.kind === 'ai' ? p.name : (p.seat === 0 || app.mode === 'hosted' ? p.name : p.name);
}

/* ----- central event fan-out (session → audio/render/hud) ----- */
function onSessionEvent(events, state) {
  app._lastEvents = events;
  for (const e of events) {
    const sfx = { roll: 'roll', move: 'move', deploy: 'deploy', capture: 'capture', crown: 'crown', encore: 'encore', overkindled: 'overkindled', pass: 'pass', turn: 'turn', resign: 'lose', gameover: null, undo: 'undo' }[e.t];
    const mySeat = app.mode === 'hosted' ? (app.hosted?.seat ?? 0) : 0;
    if (e.t === 'gameover') sfxPlay(state.winner === mySeat ? 'win' : 'lose');
    else if (sfx) sfxPlay(sfx);
    if (e.t === 'capture' && e.seat === mySeat) app.capturedThisGame += 1;
    if (e.t === 'capture') haptic(30);
    if (e.t === 'roll') $('#die-face').textContent = DIE_GLYPHS[e.value - 1];
  }
  updateHudPlayers(state);
  animChain = animChain.then(() => animateAndSettle(events, state));
}

async function animateAndSettle(events, state) {
  app.inputLocked = true;
  if (app.state === AppState.ACTIVE) setState(AppState.RESOLVING, 'animate', 'session');
  try {
    if (app.renderer) await app.renderer.animateEvents(events, state);
  } catch (err) {
    console.error('render animation failed', err);
  }
  app.inputLocked = false;
  if (app.state === AppState.RESOLVING) setState(AppState.ACTIVE, 'settled', 'session');
  refreshAfterSettle(state);
}

function refreshAfterSettle(state) {
  updateHUD(state);
  if (app.session.isOver) { showResults(); return; }
  if (app.mode === 'learn') checkLessonProgress();
  updateFlow();
}

/** Enable the right inputs for the current legal-action set; drive AI. */
function updateFlow() {
  const s = app.session;
  if (!s || s.isOver) return;
  const acts = s.actions;
  const cur = s.currentPlayer;
  const isHuman = cur.kind !== 'ai';
  const myTurnHosted = app.mode !== 'hosted' || s.state.turnIndex === app.hosted?.seat;
  const canAct = isHuman && myTurnHosted && !app.inputLocked && !app.replayMode;

  // turn banner + live region
  const turnText = acts.type === 'roll'
    ? (canAct ? 'Your turn — roll!' : `${cur.name} to roll…`)
    : acts.type === 'pass'
      ? (canAct ? 'No moves — you must pass.' : `${cur.name} has no moves.`)
      : (canAct ? `Rolled ${acts.die} — choose a float.` : `${cur.name} is choosing…`);
  $('#rail-turn').textContent = turnText;
  announce('turn', `${cur.name}: ${turnText}`);

  // buttons
  $('#btn-roll').disabled = !(canAct && acts.type === 'roll');
  $('#btn-pass').hidden = !(acts.type === 'pass');
  $('#btn-pass').disabled = !canAct;
  $('#btn-undo').hidden = !(s.undoAllowed && s.history.length > 0);
  $('#btn-hint').disabled = !(canAct && acts.type === 'moves');

  // renderer hints + float picker
  if (app.renderer) {
    if (acts.type === 'moves' && canAct) {
      app.renderer.setMoveHints({ moves: acts.moves, canRoll: false, canPass: false, die: acts.die });
    } else if (acts.type === 'roll' && canAct) {
      app.renderer.setMoveHints({ moves: [], canRoll: true, canPass: false, die: null });
    } else {
      app.renderer.clearHints();
    }
  }
  if (acts.type === 'moves' && canAct) buildFloatPicker(acts.moves);
  else hideFloatPicker();

  // AI drive
  if (!isHuman && !app.replayMode) driveAIOnce();
}

const aiDriving = new WeakSet();
function driveAIOnce() {
  const session = app.session;
  if (!session || aiDriving.has(session) || app.state !== AppState.ACTIVE) return;
  aiDriving.add(session);
  const pace = app.settings.accessibility.timingAssist ? 1100 : 650;
  session.driveAI(pace).finally(() => {
    aiDriving.delete(session);
    if (app.session === session && app.state === AppState.ACTIVE && !session.isOver && !session.paused && session.currentPlayer.kind === 'ai') driveAIOnce();
  });
}

/* ----- float picker: DOM buttons aligned to projected 3D targets ----- */
let pickerRaf = 0;
function buildFloatPicker(moves) {
  const pk = $('#float-picker');
  pk.innerHTML = '';
  pk.hidden = false;
  const state = app.session.state;
  const seat = state.turnIndex;
  for (const m of moves) {
    const label = describeMove(state, seat, m);
    const b = el('button', { text: label, 'data-float': m.floatId });
    b.addEventListener('click', () => doMove(m.floatId));
    b.addEventListener('mouseenter', () => app.renderer?.setSelection({ seat, floatId: m.floatId }));
    b.addEventListener('focus', () => app.renderer?.setSelection({ seat, floatId: m.floatId }));
    pk.append(b);
  }
  positionPicker();
  cancelAnimationFrame(pickerRaf);
  const tick = () => {
    if (pk.hidden) return;
    positionPicker();
    pickerRaf = requestAnimationFrame(tick);
  };
  pickerRaf = requestAnimationFrame(tick);
  pk.querySelector('button')?.focus({ preventScroll: true });
}

function positionPicker() {
  const pk = $('#float-picker');
  if (!app.renderer || document.body.classList.contains('no-gl')) return;
  const state = app.session.state;
  const seat = state.turnIndex;
  for (const b of pk.querySelectorAll('button')) {
    const fid = Number(b.dataset.float);
    const p = state.players[seat].floats[fid];
    const pos = floatPos(state.ruleset, seat, p < 0 ? fid : p, fid, 1);
    const scr = app.renderer.projectToScreen(pos);
    if (scr.visible) {
      b.style.position = 'fixed';
      b.style.left = `${Math.round(scr.x - b.offsetWidth / 2)}px`;
      b.style.top = `${Math.round(scr.y - 52)}px`;
    }
  }
}

function hideFloatPicker() {
  $('#float-picker').hidden = true;
  cancelAnimationFrame(pickerRaf);
  app.renderer?.setSelection(null);
}

function describeMove(state, seat, m) {
  const n = m.floatId + 1;
  if (m.deploys) return `Float ${n}: kindle!`;
  if (m.crowns) return `Float ${n}: CROWN 👑`;
  if (m.captures.length) return `Float ${n}: capture!`;
  const cell = circuitCell(state.ruleset, seat, m.to);
  if (cell !== null && isSafeCell(state.ruleset, cell)) return `Float ${n}: to lantern tile`;
  return `Float ${n}: move ${state.die}`;
}

/* ----- player actions ----- */
function doRoll() {
  if (app.inputLocked || !app.session || app.session.isOver) return;
  const r = app.session.command('roll');
  if (!r.ok) rejectFeedback(r);
}

function doMove(floatId) {
  if (app.inputLocked || !app.session || app.session.isOver) return;
  hideFloatPicker();
  const r = app.session.command('move', { floatId });
  if (!r.ok) rejectFeedback(r);
}

function doPass() {
  if (app.inputLocked || !app.session) return;
  const r = app.session.command('pass');
  if (!r.ok) rejectFeedback(r);
  else {
    const acts = app.session.actions;
    toast('Passed — no legal moves.');
  }
}

function doUndo() {
  if (!app.session?.undoAllowed) return;
  if (app.session.undo()) {
    app.renderer?.skip();
    syncAll();
    toast('Undone.');
  }
}

function doHint() {
  const m = app.session?.hint();
  if (!m) return;
  sfxPlay('hint');
  const acts = app.session.actions;
  const desc = acts.type === 'moves' ? describeMove(app.session.state, app.session.state.turnIndex, m) : '';
  toast(`Hint: ${desc}`);
  announce('objective', `Hint: ${desc}`);
  app.renderer?.setSelection({ seat: app.session.state.turnIndex, floatId: m.floatId });
  const btn = $(`#float-picker button[data-float="${m.floatId}"]`);
  if (btn) { btn.focus(); }
}

function rejectFeedback(r) {
  sfxPlay('error');
  haptic(40);
  const text = r.errorText || REASON_TEXT[r.error] || 'Not allowed.';
  toast(text, 'error');
  announce('error', text);
}

function syncAll() {
  const st = app.session.state;
  app.renderer?.skip();
  app.renderer?.syncState(st);
  updateHUD(st);
  updateFlow();
}

function updateHUD(state) {
  updateHudPlayers(state);
  const me = state.players[app.mode === 'hosted' ? (app.hosted?.seat ?? 0) : 0];
  announce('score', `${me.name}: ${me.crowned} crowned, ${me.captures} captures.`);
  const ul = $('#rail-progress');
  ul.innerHTML = '';
  for (const p of state.players) {
    const li = el('li', {});
    li.append(el('span', { text: p.name }), el('span', { text: `♛ ${p.crowned}/${state.ruleset.floats} · ⚔ ${p.captures}` }));
    ul.append(li);
  }
}

function buildHudPlayers() {
  const wrap = $('#hud-players');
  wrap.innerHTML = '';
  for (const p of app.session.state.players) {
    const def = PLAYER_DEFS[p.color];
    const chip = el('div', { class: 'hud-chip', role: 'listitem', id: `chip-p${p.seat}` });
    chip.append(
      el('span', { class: `dot ${def.shape}`, style: `background:#${def.color.toString(16).padStart(6, '0')}`, 'aria-hidden': 'true' }),
      el('span', { text: p.name }),
      el('span', { class: 'crowns', text: `♛0` }),
    );
    wrap.append(chip);
  }
  updateHudPlayers(app.session.state);
}

function updateHudPlayers(state) {
  for (const p of state.players) {
    const chip = $(`#chip-p${p.seat}`);
    if (!chip) continue;
    chip.classList.toggle('active', p.seat === state.turnIndex && state.phase !== 'over');
    chip.querySelector('.crowns').textContent = `♛${p.crowned}`;
    chip.style.opacity = p.resigned ? 0.4 : 1;
  }
}

function banner(text, ms = 1400) {
  const b = $('#turn-banner');
  b.textContent = text;
  b.classList.add('show');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => b.classList.remove('show'), app.settings.accessibility.timingAssist ? ms * 1.6 : ms);
}

function sfxPlay(name) {
  if (!app.audio) return;
  app.audio.event(name);
  if (app.settings.accessibility.captions && EVENT_CAPTIONS[name]) {
    const c = $('#caption-line');
    c.textContent = `♪ ${EVENT_CAPTIONS[name]}`;
    c.classList.add('show');
    clearTimeout(sfxPlay._t);
    sfxPlay._t = setTimeout(() => c.classList.remove('show'), 1600);
  }
}

/* ------------------------------------------------------------------ */
/* lessons                                                             */
/* ------------------------------------------------------------------ */
function showLessonStep() {
  const step = app.lesson.steps[app.lessonStepIdx];
  if (!step) return;
  $('#lesson-coach').textContent = step.text;
  announce('objective', step.text);
  app.platform.track('tutorial_step', { lesson: app.lesson.order, step: app.lessonStepIdx });
}

function checkLessonProgress() {
  const step = app.lesson?.steps[app.lessonStepIdx];
  if (!step || !app._lastEvents) return;
  const evs = app._lastEvents;
  const match = {
    roll: () => evs.some((e) => e.t === 'roll' && e.seat === 0),
    deploy: () => evs.some((e) => e.t === 'deploy' && e.seat === 0),
    move: () => evs.some((e) => e.t === 'move' && e.seat === 0),
    capture: () => evs.some((e) => e.t === 'capture' && e.bySeat === 0),
    crown: () => evs.some((e) => e.t === 'crown' && e.seat === 0),
    complete: () => true,
  }[step.action];
  if (match && match()) {
    app.lessonStepIdx += 1;
    const next = app.lesson.steps[app.lessonStepIdx];
    if (next) {
      showLessonStep();
      if (next.action === 'complete') {
        // final card: complete the lesson shortly after showing it
        setTimeout(() => finishLesson(), app.settings.accessibility.timingAssist ? 4000 : 2400);
      }
    }
  }
}

function finishLesson() {
  if (!app.save.lessons[app.lesson.id]) {
    app.save.lessons[app.lesson.id] = { done: true, at: new Date().toISOString() };
    if (Object.keys(app.save.lessons).length >= LESSONS.length) unlock('scholar');
    persistSave();
  }
  showResults(true);
}

/* ------------------------------------------------------------------ */
/* results                                                             */
/* ------------------------------------------------------------------ */
function showResults(lessonOnly = false) {
  setState(AppState.RESULTS, lessonOnly ? 'lesson-complete' : 'game-over', 'session');
  hideFloatPicker();
  app.renderer?.clearHints();
  const s = app.session;
  const results = s.results();
  const before = new Set(Object.keys(app.save.achievements));
  // Once per match: watching a replay returns here with the real session, and
  // a second call would double-count stats, achievements and board entries.
  if (!app.replayMode && !s.progressionApplied) {
    s.progressionApplied = true;
    updateProgression(results);
  }
  const newAch = Object.keys(app.save.achievements).filter((k) => !before.has(k));

  const body = $('#results-body');
  body.innerHTML = '';
  const mySeat = app.mode === 'hosted' ? (app.hosted?.seat ?? 0) : 0;
  const won = results.winner === mySeat;
  const goal = s.goalStatus();

  const head = el('div', { class: 'result-head' });
  head.append(el('div', {
    class: 'big',
    text: lessonOnly ? 'Lesson Complete!' :
      app.mode === 'learn' ? 'Lesson over' :
      won ? '🏮 Victory!' : results.reason === 'turn-limit' ? 'The lanterns dim…' : 'Defeat',
  }));
  const sub = {
    'crown-sweep': `${results.rows.find((r) => r.seat === results.winner)?.name ?? ''} crowned every float.`,
    'crown-first': `${results.rows.find((r) => r.seat === results.winner)?.name ?? ''} reached the crown target first.`,
    'turn-limit': 'The turn limit was reached.',
    resign: 'A player resigned.', abandon: 'A player abandoned the match.',
  }[results.reason];
  if (sub && !lessonOnly) head.append(el('p', { class: 'muted', text: sub }));
  if (goal.label) {
    head.append(el('span', { class: `goal-chip ${goal.met ? 'met' : 'missed'}`, text: `${goal.met ? '✓' : '✗'} ${goal.label}` }));
  }
  body.append(head);

  if (!lessonOnly) {
    const table = el('table', { class: 'result-table' });
    table.innerHTML = '<thead><tr><th>Place</th><th>Player</th><th class="num">Crowned</th><th class="num">Captures</th><th class="num">Score</th></tr></thead>';
    const tb = el('tbody', {});
    for (const row of results.rows) {
      const tr = el('tr', { class: row.seat === results.winner ? 'winner' : '' });
      const bd = Object.entries(row.breakdown.parts)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `<span>${k} ${v > 0 ? '+' : ''}${v}</span>`).join('');
      tr.append(
        el('td', { text: `#${row.place}` }),
        el('td', { html: `${escapeHtml(row.name)}<div class="breakdown">${bd}</div>` }),
        el('td', { class: 'num', text: `${row.crowned}` }),
        el('td', { class: 'num', text: `${row.captures}` }),
        el('td', { class: 'num', text: `${row.breakdown.total}` }),
      );
      tb.append(tr);
    }
    table.append(tb);
    body.append(table);
    body.append(el('p', { class: 'hint', text: `Seed ${results.seed} · ${results.turns} turns · ${Math.round(results.elapsedMs / 1000)}s · ties break on objective, then invalid actions, then time.` }));
  }

  if (newAch.length) {
    const box = el('div', { class: 'summary-card' });
    box.innerHTML = `<b>Achievements unlocked:</b> ${newAch.map((k) => escapeHtml(ACHIEVEMENTS.find((a) => a.key === k)?.name || k)).join(', ')}`;
    body.append(box);
  }
  if (app.mode === 'journey' && app.content) {
    const rec = app.save.journey[app.content.id];
    if (rec) body.append(el('p', { class: 'muted', text: `Stage ${app.content.index}: ${'★'.repeat(rec.stars)}${'☆'.repeat(3 - rec.stars)} earned.` }));
  }

  // next recommended action
  const nextBtn = $('#results-next');
  if (app.mode === 'journey' && app.content && won && app.content.index < 40) {
    nextBtn.textContent = `Next: Stage ${app.content.index + 1}`;
    nextBtn.onclick = () => { hideOverlay('results'); showSetup('journey', JOURNEY[app.content.index]); };
  } else if (app.mode === 'learn') {
    const next = LESSONS[app.lesson.order]; // order is 1-based
    if (next) {
      nextBtn.textContent = `Next: ${next.title}`;
      nextBtn.onclick = () => { hideOverlay('results'); showSetup('learn', null, next); };
    } else {
      nextBtn.textContent = 'Back to title';
      nextBtn.onclick = () => { hideOverlay('results'); leaveToTitle(); };
    }
  } else {
    nextBtn.textContent = 'Back to title';
    nextBtn.onclick = () => { hideOverlay('results'); leaveToTitle(); };
  }
  $('#results-retry').onclick = () => { hideOverlay('results'); retryCurrent(); };
  $('#results-retry').style.display = app.mode === 'hosted' ? 'none' : '';
  $('#results-replay').style.display = (lessonOnly || app.mode === 'hosted') ? 'none' : '';
  $('#results-replay').onclick = () => { hideOverlay('results'); watchReplay(); };

  announce('results', `${won ? 'Victory' : 'Game over'}. ${sub || ''}`);
  app.platform.track('round_end', { mode: app.mode, won, turns: results.turns });
  setState(AppState.PROGRESSION, 'results-shown');
  showOverlay('results');
}

function retryCurrent() {
  app.platform.track('retry', { mode: app.mode });
  if (app.mode === 'learn') showSetup('learn', null, app.lesson);
  else if (app.mode === 'journey' || app.mode === 'challenge') showSetup(app.mode, app.content);
  else if (app.mode === 'daily') showDaily();
  else if (app.mode === 'local') showSetup('local');
  else showSetup('practice');
}

function leaveToTitle() {
  app.session?.cancelPending();
  app.session = null;
  app.hosted = null;
  app.platform.disconnect();
  if (app.audio) { app.audio.setMusic('title'); }
  showTitle();
}

/* ----- deterministic replay viewing ----- */
async function watchReplay() {
  const env = app.session.envelope;
  const check = Session.verifyReplay(env);
  if (!check.ok) { toast('Replay failed verification.', 'error'); return; }
  app.replayMode = true;
  const players = app.session.state.players.map((p) => ({ name: p.name, kind: 'ai', level: 1 }));
  const replay = new Session({
    mode: 'replay', ruleset: env.ruleset, seed: env.seed, players,
    ranked: false, undoAllowed: false, onEvent: onSessionEvent,
  });
  const real = app.session;
  app.session = replay;
  banner('Replay — Esc to exit', 2200);
  for (const c of env.commands) {
    if (!app.replayMode) break;
    if (c.type === 'undo-marker') continue;
    await new Promise((r) => setTimeout(r, 550));
    if (!app.replayMode) break;
    replay.command(c.type, c.floatId !== undefined ? { floatId: c.floatId } : {}, c.seat);
    await animChain;
  }
  app.replayMode = false;
  app.session = real;
  syncAll();
  showResults();
}

/* ------------------------------------------------------------------ */
/* board mirror (accessible navigable model)                           */
/* ------------------------------------------------------------------ */
function describeFloat(state, seat, p, idx) {
  if (p === -1) return `Float ${idx + 1}: in the workshop`;
  if (p === DONE) return `Float ${idx + 1}: crowned 👑`;
  if (p >= TRACK_LEN) return `Float ${idx + 1}: approach step ${p - TRACK_LEN + 1} of 4`;
  const cell = circuitCell(state.ruleset, seat, p);
  return `Float ${idx + 1}: circuit tile ${cell + 1}${isSafeCell(state.ruleset, cell) ? ' (lantern, safe)' : ''}`;
}

function openBoardState() {
  const st = app.session?.state;
  if (!st) return;
  const body = $('#bs-body');
  body.innerHTML = '';
  body.append(el('p', { text: st.phase === 'over'
    ? `Game over — ${st.players[st.winner]?.name ?? ''} wins (${st.reason}).`
    : `${st.players[st.turnIndex].name} to act${st.die ? `, die shows ${st.die}` : ', awaiting roll'}. Round ${st.round}.` }));
  for (const p of st.players) {
    body.append(el('h4', { text: `${p.name} — ${p.crowned}/${st.ruleset.floats} crowned, ${p.captures} captures${p.resigned ? ' (resigned)' : ''}` }));
    const ul = el('ul', {});
    p.floats.forEach((fp, i) => ul.append(el('li', { text: describeFloat(st, p.seat, fp, i) })));
    body.append(ul);
  }
  showOverlay('boardstate');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ */
/* pause / lifecycle                                                    */
/* ------------------------------------------------------------------ */
function pauseGame(reason = 'user') {
  if (!app.session || app.session.isOver) return;
  if (app.state !== AppState.ACTIVE && app.state !== AppState.RESOLVING) return;
  app.session.paused = true;
  app.session.cancelPending(); // drop the AI turn scheduled for right now
  setState(AppState.PAUSED, reason);
  app.renderer?.clearHints();
  showOverlay('pause');
  app.audio?.event('ui');
}

function resumeGame() {
  $('#overlay-pause').hidden = true; // direct: hideOverlay routes back here
  restoreFocus();
  if (!app.session) return;
  app.session.paused = false;
  setState(AppState.ACTIVE, 'resume');
  syncAll();
}

async function restartGame() {
  if (app.mode === 'hosted' || !app.lastGameOpts) return;
  $('#overlay-pause').hidden = true; // stay paused while the prompt is open
  if (await confirmDialog('Restart this match from the beginning?')) {
    startGame({ ...app.lastGameOpts });
  } else {
    showOverlay('pause');
  }
}

async function leaveGame() {
  $('#overlay-pause').hidden = true; // stay paused while the prompt is open
  if (app.mode === 'hosted') {
    if (await confirmDialog('Leave the room? Your seat is held for a reconnect while the room lives.')) {
      if (app.hosted?.code) app.platform.leaveRoom(app.hosted.code);
      leaveToTitle();
    } else showOverlay('pause');
    return;
  }
  const inProgress = app.session && !app.session.isOver;
  if (!inProgress || await confirmDialog('Leave the game? Solo progress is saved and can be resumed.')) {
    leaveToTitle();
  } else showOverlay('pause');
}

function onVisibility() {
  if (document.hidden && app.state === AppState.ACTIVE && app.mode !== 'hosted') {
    pauseGame('background'); // solo simulation pauses; hosted truth lives on the server
  }
}

/* ------------------------------------------------------------------ */
/* canvas pointer input: tap = pick, drag = camera orbit                */
/* ------------------------------------------------------------------ */
function bindCanvasInput() {
  const canvas = $('#gl');
  let down = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, lx: 0, ly: 0 };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 9) down.moved = true;
    if (down.moved && app.renderer?.orbit) {
      app.renderer.orbit(dx - down.lx, dy - down.ly);
      down.lx = dx; down.ly = dy;
    }
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!down) return;
    const wasTap = !down.moved && performance.now() - down.t < 600;
    down = null;
    if (wasTap) onCanvasTap(e.clientX, e.clientY);
  });
  canvas.addEventListener('pointercancel', () => { down = null; });
}

function onCanvasTap(x, y) {
  if (!app.renderer || !app.session || app.inputLocked || app.session.isOver) return;
  if (app.state !== AppState.ACTIVE) return;
  const hit = app.renderer.pick(x, y);
  if (!hit) return;
  const acts = app.session.actions;
  const seat = app.session.state.turnIndex;
  if (hit.kind === 'die') {
    if (acts.type === 'roll') doRoll();
    return;
  }
  if (hit.kind === 'float') {
    haptic(8);
    if (acts.type === 'moves' && hit.seat === seat) {
      if (acts.moves.some((m) => m.floatId === hit.floatId)) {
        doMove(hit.floatId);
      } else {
        rejectFeedback({ error: null, errorText: 'That float cannot use this roll.' });
      }
      return;
    }
    // inspect: select + describe any float
    app.renderer.setSelection({ seat: hit.seat, floatId: hit.floatId });
    const p = app.session.state.players[hit.seat].floats[hit.floatId];
    toast(`${app.session.state.players[hit.seat].name} — ${describeFloat(app.session.state, hit.seat, p, hit.floatId)}`);
  }
}

/* ------------------------------------------------------------------ */
/* keyboard                                                             */
/* ------------------------------------------------------------------ */
function onKeyDown(e) {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (anyOverlayOpen()) return; // overlays trap and handle their own keys
  const map = bindings();
  const hit = (a) => (map[a] || []).includes(e.code);

  if (hit('pause')) {
    e.preventDefault();
    if (app.state === AppState.ACTIVE || app.state === AppState.RESOLVING) pauseGame('key');
    return;
  }
  if (app.replayMode) {
    if (hit('cancel') || hit('confirm')) { e.preventDefault(); app.replayMode = false; }
    return;
  }
  if (app.state !== AppState.ACTIVE) return;

  if (hit('confirm')) { e.preventDefault(); onConfirmKey(); }
  else if (hit('cancel')) { e.preventDefault(); hideFloatPicker(); app.renderer?.setSelection(null); }
  else if (hit('undo')) { e.preventDefault(); doUndo(); }
  else if (hit('hint')) { e.preventDefault(); doHint(); }
  else if (hit('camera')) { e.preventDefault(); app.renderer?.resetCamera(); }
  else if (hit('board')) { e.preventDefault(); openBoardState(); }
  else if (hit('next')) { e.preventDefault(); cycleTargets(1); }
  else if (hit('prev')) { e.preventDefault(); cycleTargets(-1); }
}

function onConfirmKey() {
  const pk = $('#float-picker');
  if (!pk.hidden) {
    const focus = document.activeElement;
    const btn = focus && pk.contains(focus) ? focus : pk.querySelector('button');
    btn?.click();
    return;
  }
  if (!$('#btn-roll').disabled) { doRoll(); return; }
  if (!$('#btn-pass').hidden && !$('#btn-pass').disabled) doPass();
}

function cycleTargets(dir) {
  const pk = $('#float-picker');
  const btns = pk.hidden
    ? [$('#btn-roll')].filter((b) => !b.disabled)
    : [...pk.querySelectorAll('button')];
  if (!btns.length) return;
  const i = btns.indexOf(document.activeElement);
  const next = btns[(i + dir + btns.length) % btns.length] || btns[0];
  next.focus();
}

/* ------------------------------------------------------------------ */
/* gamepad: A confirm, B cancel, ☰ pause, d-pad/stick navigate          */
/* ------------------------------------------------------------------ */
function pollGamepad() {
  requestAnimationFrame(pollGamepad);
  if (!navigator.getGamepads) return;
  const pads = navigator.getGamepads();
  const gp = (app.gamepad.idx != null && pads[app.gamepad.idx])
    || [...pads].find(Boolean);
  if (!gp) return;
  app.gamepad.idx = gp.index;
  const pressed = gp.buttons.map((b) => b.pressed);
  const edge = (i) => pressed[i] && !app.gamepad.prev[i];
  if (edge(9)) { // ☰ start
    if (anyOverlayOpen()) { /* overlay owns focus */ }
    else if (app.state === AppState.ACTIVE) pauseGame('gamepad');
  }
  if (!anyOverlayOpen()) {
    if (app.replayMode) {
      if (edge(0) || edge(1)) app.replayMode = false;
    } else if (app.state === AppState.ACTIVE) {
      if (edge(0)) onConfirmKey();
      if (edge(1)) { hideFloatPicker(); app.renderer?.setSelection(null); }
      if (edge(2)) doUndo();
      if (edge(3)) doHint();
      if (edge(14)) cycleTargets(-1);
      if (edge(15)) cycleTargets(1);
      const ax = gp.axes[0] || 0;
      if (Math.abs(ax) > 0.6 && !app.gamepad.axisLatch) {
        cycleTargets(ax > 0 ? 1 : -1);
        app.gamepad.axisLatch = true;
      }
      if (Math.abs(ax) < 0.3) app.gamepad.axisLatch = false;
    }
  }
  app.gamepad.prev = pressed;
}

/* ------------------------------------------------------------------ */
/* hosted play: lobby + server-authoritative session                    */
/* ------------------------------------------------------------------ */
class HostedSession {
  constructor({ code, seat, snapshot }) {
    this.mode = 'hosted';
    this.content = null;
    this.lesson = null;
    this.ranked = false;
    this.undoAllowed = false;
    this.history = [];
    this.paused = false;
    this.code = code;
    this.seat = seat;
    this.state = snapshot;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.pendingTimer = null;
    this.envelope = null; // hosted replays come from the server log, not a local envelope
  }
  get snapshot() { return this.state; }
  get actions() { return legalActions(this.state); }
  get currentPlayer() { return this.state.players[this.state.turnIndex]; }
  get isOver() { return this.state.phase === 'over'; }

  /** The server is the only writer of shared state; commands are optimistic. */
  command(type, extra = {}) {
    const cmd = {
      id: `h:${this.state.tick}:${type}:${Math.random().toString(36).slice(2, 10)}`,
      tick: this.state.tick,
      type,
    };
    if (extra.floatId !== undefined) cmd.floatId = extra.floatId;
    app.platform.sendCommand(this.code, cmd).then((rep) => {
      if (!rep || rep.t !== 'rejected') return;
      if (rep.snapshot) this.applySnapshot(rep.snapshot, []); // stale-tick resync
      rejectFeedback({ error: rep.error });
    });
    return { ok: true };
  }

  applySnapshot(state, events) {
    this.state = state;
    if (this.isOver && !this.endedAt) this.endedAt = Date.now();
    onSessionEvent(events || [], state);
  }

  undo() { return false; }
  async driveAI() { /* every hosted seat is human; nothing to drive */ }
  cancelPending() { /* no local timers */ }
  hint() {
    const acts = this.actions;
    if (acts.type !== 'moves') return null;
    return hintMove(this.state, acts.moves, this.state.turnIndex);
  }
  elapsedMs() { return (this.endedAt || Date.now()) - this.startedAt; }
  results() {
    const ranked = rankPlayers(this.state);
    return {
      mode: 'hosted',
      contentId: null,
      winner: this.state.winner,
      reason: this.state.reason,
      turns: this.state.turnsPlayed,
      elapsedMs: this.elapsedMs(),
      rows: ranked.map((pl, i) => ({
        place: i + 1, seat: pl.seat, name: pl.name, kind: pl.kind,
        breakdown: scoreBreakdown(this.state, pl.seat),
        crowned: pl.crowned, captures: pl.captures, invalid: pl.invalid,
        resigned: pl.resigned,
      })),
      ranked: false,
      seed: 'server',
    };
  }
  goalStatus() { return { met: this.isOver && this.state.winner === this.seat, label: null }; }
}

function showHosted() {
  setState(AppState.MODE_SELECT, 'hosted-lobby');
  showScreen('hosted');
  renderHostedHome();
}

async function renderHostedHome(note = '') {
  const body = $('#hosted-body');
  body.innerHTML = '';
  if (app.platform.hosted) {
    // On-platform rooms are not migrated yet: the old own-server relay does not
    // exist here, so the entry point is disabled honestly instead of failing.
    body.append(el('p', { class: 'muted', text: 'Rooms with friends, run by an authoritative host.' }));
    body.append(el('div', { class: 'summary-card', html: '<b>Not available yet.</b> Online rooms on this platform build are still being migrated from the old host relay. Every solo mode — journey, daily, practice, lessons, challenges — is fully playable.' }));
    return;
  }
  body.append(el('p', { class: 'muted', text: 'Rooms run on this host: the server owns the dice, the rules and the results.' }));
  const status = el('p', { class: 'muted', text: note || 'Connecting…' });
  body.append(status);
  const ok = await app.platform.connect();
  if (app.hosted) return; // a room was joined while connecting
  if (!ok) {
    status.remove();
    body.append(el('div', { class: 'summary-card', html: '<b>Offline.</b> Hosted play needs the game server; this copy is served statically. Every solo mode works offline.' }));
    return;
  }
  status.textContent = note;

  // create form
  const cfg = { seats: 2, privacy: 'private' };
  const createCard = el('div', { class: 'summary-card' });
  createCard.append(el('h3', { text: 'Create a room' }));
  createCard.append(segField('Seats', [2, 3, 4], cfg.seats, (v) => { cfg.seats = v; }));
  createCard.append(segField('Privacy', ['private', 'public'], cfg.privacy, (v) => { cfg.privacy = v; }));
  const createBtn = el('button', { class: 'btn primary', text: 'Create room' });
  createBtn.addEventListener('click', async () => {
    createBtn.disabled = true;
    const rep = await app.platform.createRoom({ name: displayName(), seats: cfg.seats, privacy: cfg.privacy });
    createBtn.disabled = false;
    if (rep.t !== 'room') { toast(`Could not create room (${rep.error || 'error'}).`, 'error'); return; }
    enterLobby(rep);
  });
  createCard.append(createBtn);
  body.append(createCard);

  // join by code
  const joinCard = el('div', { class: 'summary-card' });
  joinCard.append(el('h3', { text: 'Join with a code' }));
  const row = el('div', { class: 'row' });
  const input = el('input', { type: 'text', maxlength: 4, placeholder: 'CODE', 'aria-label': 'Room code', style: 'text-transform:uppercase;width:7em' });
  const joinBtn = el('button', { class: 'btn', text: 'Join' });
  const doJoin = () => joinRoomByCode(input.value);
  joinBtn.addEventListener('click', doJoin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
  row.append(input, joinBtn);
  joinCard.append(row);
  body.append(joinCard);

  // public rooms
  const pubCard = el('div', { class: 'summary-card' });
  pubCard.append(el('h3', { text: 'Public rooms' }));
  const listBox = el('div', {});
  const refresh = el('button', { class: 'btn ghost', text: 'Refresh list' });
  refresh.addEventListener('click', async () => {
    listBox.innerHTML = '';
    const rep = await app.platform.listPublic();
    const rooms = rep.rooms || [];
    if (!rooms.length) { listBox.append(el('p', { class: 'muted', text: 'No open public rooms right now.' })); return; }
    for (const r of rooms) {
      const line = el('div', { class: 'row between' });
      const jb = el('button', { class: 'btn', text: 'Join' });
      jb.addEventListener('click', () => joinRoomByCode(r.code));
      line.append(el('span', { text: `${r.code} · ${r.players}/${r.seats} players` }), jb);
      listBox.append(line);
    }
  });
  pubCard.append(listBox, refresh);
  body.append(pubCard);
  refresh.click();
}

async function joinRoomByCode(code) {
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) { toast('Room codes are 4 letters/digits.', 'error'); return; }
  const rep = await app.platform.joinRoom(code, displayName());
  if (rep.t !== 'room') { toast(`Could not join (${rep.error || 'error'}).`, 'error'); return; }
  enterLobby(rep);
}

function enterLobby(rep) {
  app.hosted = {
    code: rep.room.code, seat: rep.you.seat, seatToken: rep.you.seatToken,
    players: rep.room.players, hostSeat: rep.room.hostSeat, seats: rep.room.seats,
  };
  renderLobby();
}

function renderLobby() {
  const h = app.hosted;
  if (!h) return;
  const body = $('#hosted-body');
  body.innerHTML = '';
  const codeLine = el('div', { class: 'summary-card' });
  codeLine.innerHTML = `<b>Room code:</b> <span style="font-size:1.6em;letter-spacing:.2em">${escapeHtml(h.code)}</span><br>` +
    `<span class="muted">Share the code with friends. Seats: ${h.seats}.</span>`;
  body.append(codeLine);
  const list = el('div', { class: 'card-list' });
  (h.players || []).forEach((p) => {
    const item = el('div', { class: 'card-item', role: 'listitem' });
    item.append(
      el('span', { class: 'ci-icon', text: p.connected ? '🏮' : '💤' }),
      el('span', { class: 'ci-body' }),
      el('span', { class: 'ci-meta', text: `${p.seat === h.hostSeat ? 'host' : ''}${p.seat === h.seat ? ' · you' : ''}` }),
    );
    item.querySelector('.ci-body').append(
      el('div', { class: 'ci-title', text: p.name }),
      el('div', { class: 'ci-sub', text: p.connected ? `Seat ${p.seat + 1} — ready` : 'disconnected' }),
    );
    list.append(item);
  });
  body.append(list);
  const row = el('div', { class: 'row end' });
  const leaveBtn = el('button', { class: 'btn ghost', text: 'Leave room' });
  leaveBtn.addEventListener('click', async () => {
    await app.platform.leaveRoom(h.code);
    app.hosted = null;
    renderHostedHome('Left the room.');
  });
  row.append(leaveBtn);
  if (h.seat === h.hostSeat) {
    const startBtn = el('button', { class: 'btn primary', text: 'Start game' });
    startBtn.disabled = (h.players || []).length < h.seats;
    startBtn.addEventListener('click', () => app.platform.startRoom(h.code));
    row.append(startBtn);
    if (startBtn.disabled) row.append(el('span', { class: 'muted', text: 'Waiting for every seat…' }));
  } else {
    row.append(el('span', { class: 'muted', text: 'The host starts the game.' }));
  }
  body.append(row);
}

function beginHosted(snapshot) {
  if (!app.hosted) return;
  app.session = new HostedSession({ code: app.hosted.code, seat: app.hosted.seat, snapshot });
  app.mode = 'hosted';
  app.content = null;
  app.lesson = null;
  app.capturedThisGame = 0;
  app.replayMode = false;
  setState(AppState.PREPARING, 'hosted-begin');
  enterGameScreen();
  if (app.audio) { app.audio.setMusic('tense'); app.audio.setAmbience(true); }
  app.platform.track('start', { mode: 'hosted' });
  syncAll();
  countdownThenBegin();
}

async function onHostedClosed() {
  if (!app.hosted) return;
  if (app.state === AppState.MODE_SELECT) {
    app.hosted = null;
    renderHostedHome('Connection closed.');
    return;
  }
  if (!(app.session instanceof HostedSession) || app.session.isOver || !app.hosted.seatToken) return;
  setState(AppState.RECONNECTING, 'ws-closed');
  banner('Reconnecting…', 2500);
  toast('Connection lost — reconnecting…', 'error');
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    if (!app.hosted) return;
    if (!await app.platform.connect()) continue;
    const rep = await app.platform.joinRoom(app.hosted.code, displayName(), app.hosted.seatToken);
    if (rep.t !== 'room') continue;
    if (rep.snapshot && app.session) {
      app.session.applySnapshot(rep.snapshot, []);
      const away = rep.away?.events?.length || 0;
      if (away) toast(`While you were away: ${away} event(s) played out.`);
    }
    setState(AppState.ACTIVE, 'reconnected');
    syncAll();
    toast('Reconnected.');
    return;
  }
  toast('Could not reconnect to the room.', 'error');
  leaveToTitle();
}

function bindPlatform() {
  app.platform.on('presence', (msg) => {
    if (!app.hosted) return;
    app.hosted.players = msg.players;
    app.hosted.hostSeat = msg.hostSeat;
    if (app.state === AppState.MODE_SELECT && !$('#screen-hosted').classList.contains('active')) return;
    if (app.state === AppState.MODE_SELECT) renderLobby();
  });
  app.platform.on('begin', (msg) => beginHosted(msg.snapshot));
  app.platform.on('applied', (msg) => {
    if (app.session instanceof HostedSession) app.session.applySnapshot(msg.snapshot, msg.events);
  });
  app.platform.on('result', (msg) => { if (app.hosted) app.hosted.results = msg.results; });
  app.platform.on('closed', () => onHostedClosed());
}

/* ------------------------------------------------------------------ */
/* DOM wiring                                                           */
/* ------------------------------------------------------------------ */
function openSettings(tab = 'audio') {
  $$('#overlay-settings .tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
  });
  buildSettingsBody(tab);
  showOverlay('settings');
}

function bindTitle() {
  $('#btn-play').addEventListener('click', () => { app.audio?.event('ui'); showSetup('practice'); });
  const modes = {
    daily: showDaily,
    journey: showJourney,
    learn: showLearn,
    practice: () => showSetup('practice'),
    challenge: showChallenges,
    hosted: showHosted,
  };
  $$('.mode-card').forEach((card) => {
    card.addEventListener('click', () => { app.audio?.event('ui'); modes[card.dataset.mode]?.(); });
  });
  $('#chip-profile').addEventListener('click', showProfile);
  $('#chip-achievements').addEventListener('click', showAchievements);
  $('#chip-leaderboards').addEventListener('click', () => showBoards('daily'));
  $('#chip-help').addEventListener('click', showHelp);
  $('#chip-settings').addEventListener('click', () => openSettings('audio'));
  $$('[data-nav="title"]').forEach((b) => b.addEventListener('click', showTitle));
}

function bindHud() {
  $('#btn-roll').addEventListener('click', doRoll);
  $('#btn-pass').addEventListener('click', doPass);
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-hint').addEventListener('click', doHint);
  $('#btn-board-state').addEventListener('click', openBoardState);
  $('#btn-pause').addEventListener('click', () => pauseGame('button'));
}

function bindOverlays() {
  $('#btn-resume').addEventListener('click', resumeGame);
  $('#btn-pause-settings').addEventListener('click', () => openSettings('audio'));
  $('#btn-pause-help').addEventListener('click', showHelp);
  $('#btn-restart').addEventListener('click', restartGame);
  $('#btn-leave').addEventListener('click', leaveGame);

  $$('#overlay-settings .tab').forEach((t) => {
    t.addEventListener('click', () => {
      $$('#overlay-settings .tab').forEach((x) => {
        x.classList.toggle('active', x === t);
        x.setAttribute('aria-selected', String(x === t));
      });
      buildSettingsBody(t.dataset.tab);
    });
  });
  $('#settings-close').addEventListener('click', () => hideOverlay('settings'));
  $('#help-close').addEventListener('click', () => hideOverlay('help'));
  $('#ach-close').addEventListener('click', () => hideOverlay('achievements'));
  $('#profile-close').addEventListener('click', () => hideOverlay('profile'));
  $('#bs-close').addEventListener('click', () => hideOverlay('boardstate'));
  $('#boards-close').addEventListener('click', () => hideOverlay('boards'));
  $$('#overlay-boards .tab').forEach((t) => {
    t.addEventListener('click', () => showBoards(t.dataset.board));
  });
  $('#confirm-yes').addEventListener('click', () => {
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(true); }
    $('#overlay-confirm').hidden = true;
    restoreFocus();
  });
  $('#confirm-no').addEventListener('click', () => hideOverlay('confirm'));
}

/* ------------------------------------------------------------------ */
/* init — the entry point bootstrap.js calls after capability detection */
/* ------------------------------------------------------------------ */
export function init({ platform, renderer, audio }) {
  app.platform = platform;
  app.renderer = renderer;
  app.audio = audio;
  app.save = loadSave();
  app.settings = loadSettings();
  platform.setConsent(app.settings.consent.analytics);

  bindTitle();
  bindHud();
  bindOverlays();
  bindCanvasInput();
  bindPlatform();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => app.renderer?.resize());
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('gamepadconnected', (e) => {
    app.gamepad.idx = e.gamepad.index;
    app.gamepad.prev = [];
    toast('Gamepad connected.');
  });
  requestAnimationFrame(pollGamepad);

  // WebAudio needs a user gesture; unlock once, then start the title music.
  const unlock = () => {
    if (!app.audio) return;
    app.audio.unlock();
    if (app.state === AppState.TITLE || app.state === AppState.PROFILE) app.audio.setMusic('title');
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  applySettings();
  if (app.renderer) app.renderer.setTheme(themeById(app.settings.theme));
  setState(AppState.PROFILE, 'profile-loaded');
  showTitle();
  applyPlatformIdentity(); // hosted: pull cloud save + account nickname, then refresh the title
}

export const UI = { init, AppState };
