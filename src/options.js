/**
 * options.js — the game's own options on the StarHermit engine (pure, shared
 * with the node tests).
 *
 * The browser build's Settings panel had four tabs. The runtime's Options now
 * own the volumes, mute, graphics quality (presets, render scale, frame-rate
 * limit), key bindings, language, reduced motion, high contrast, larger text
 * and vibration. What stays the game's own (engine `settings`, synced with
 * the account): sound captions, the camera view, the visual theme, the player
 * colour palette, timing assistance and the left-handed tray.
 *
 * readLegacySettings() maps the browser build's per-player settings KV groups
 * (audio, graphics, accessibility, camera, theme, tutorial, consent — the
 * values its platform.js mirrored) onto these options.
 */

export const CAMERA_MODES = Object.freeze(['auto', 'top', 'low']);
export const PALETTES = Object.freeze(['standard', 'cvd']);
export const THEME_IDS = Object.freeze(['lantern-pavilion', 'jade-garden', 'ember-court', 'moonlight-dock', 'blossom-fete']);

export const DEFAULT_OPTIONS = Object.freeze({
  captions: true,
  camera: 'auto',
  theme: 'lantern-pavilion',
  palette: 'standard',
  timingAssist: false,
  leftHanded: false,
});
export const OPTION_KEYS = Object.freeze(Object.keys(DEFAULT_OPTIONS));
/** The browser build's settings KV groups (removed from the account once read). */
export const BROWSER_KEYS = Object.freeze(['audio', 'graphics', 'accessibility', 'camera', 'theme', 'tutorial', 'consent', 'input']);

/** The valid options in `raw` (unknown keys and bad values dropped). */
export function pickOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['captions', 'timingAssist', 'leftHanded']) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  if (CAMERA_MODES.includes(raw.camera)) out.camera = raw.camera;
  if (THEME_IDS.includes(raw.theme)) out.theme = raw.theme;
  if (PALETTES.includes(raw.palette)) out.palette = raw.palette;
  return out;
}

/** The browser build's settings KV ({ group: value }) → the game's options it set. */
export function readLegacySettings(kv) {
  const src = kv && typeof kv === 'object' ? kv : {};
  const a = src.accessibility && typeof src.accessibility === 'object' ? src.accessibility : {};
  const cam = src.camera && typeof src.camera === 'object' ? src.camera.mode : undefined;
  return pickOptions({
    captions: a.captions,
    timingAssist: a.timingAssist,
    leftHanded: a.leftHanded,
    palette: a.palette,
    camera: cam,
    theme: src.theme,
  });
}
