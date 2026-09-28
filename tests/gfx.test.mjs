/**
 * Unit tests for the graphics quality model (src/gfx.js) and its strings.
 * Run: node --test tests/gfx.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, describe, migrateGraphics,
} from '../src/gfx.js';
import { GFX_STRINGS, gfxStrings } from '../src/gfxstrings.js';

test('detectPreset maps GPU strings to tiers', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)'), 'low');
  assert.equal(detectPreset('llvmpipe (LLVM 15.0.7, 256 bits)'), 'low');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0)'), 'high');
  assert.equal(detectPreset('Apple M2'), 'high');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)'), 'balanced');
  assert.equal(detectPreset('Adreno (TM) 650'), 'balanced');
  assert.equal(detectPreset(''), 'balanced');
});

test('detectPreset caps touch/mobile devices at balanced', () => {
  assert.equal(detectPreset('Apple M1', { mobile: true }), 'balanced');
  assert.equal(detectPreset('SwiftShader', { mobile: true }), 'low');
});

test('resolve: auto uses the detected preset', () => {
  const r = resolve({ preset: 'auto' }, 'low');
  assert.equal(r.preset, 'low');
  assert.equal(r.auto, true);
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, false, 'Low renders without post-processing');
  assert.equal(r.dprCap, 1);
});

test('resolve: explicit preset rows', () => {
  const hi = resolve({ preset: 'high' }, 'low');
  assert.equal(hi.auto, false);
  assert.equal(hi.shadows, 'medium');
  assert.equal(hi.antialias, 'smaa');
  assert.equal(hi.post, true);
  const ul = resolve({ preset: 'ultra' }, 'low');
  assert.equal(ul.ao, 'high');
  assert.equal(ul.scale, 1.25);
});

test('resolve: overrides win over the preset, invalid overrides are ignored', () => {
  const r = resolve({ preset: 'low', bloom: 'on', shadows: 'bogus' }, 'low');
  assert.equal(r.bloom, 'on');
  assert.equal(r.shadows, 'off');
  assert.equal(r.post, true);
});

test('resolve: render scale is clamped to 50–200 %', () => {
  assert.equal(resolve({ preset: 'high', render_scale: 5 }).renderScale, 2);
  assert.equal(resolve({ preset: 'high', render_scale: 0.1 }).renderScale, 0.5);
  assert.equal(resolve({ preset: 'ultra', render_scale: 0.5 }).scale, 0.625);
  assert.equal(resolve({}).renderScale, 1);
});

test('resolve: adaptive defaults on, fps readout defaults off', () => {
  const r = resolve({}, 'balanced');
  assert.equal(r.adaptive, true);
  assert.equal(r.showFps, false);
  assert.equal(resolve({ adaptive: false, show_fps: true }).adaptive, false);
});

test('choosePreset clears per-category overrides', () => {
  const saved = { preset: 'low', bloom: 'on', ao: 'high', render_scale: 1.5, adaptive: false };
  const next = choosePreset(saved, 'high');
  assert.equal(next.preset, 'high');
  for (const cat of Object.keys(CATEGORIES)) assert.equal(next[cat], undefined);
  assert.equal(next.render_scale, 1.5, 'non-category settings are kept');
  assert.equal(next.adaptive, false);
  assert.equal(choosePreset(saved, 'nonsense').preset, 'auto');
});

test('presetTier and describe', () => {
  assert.equal(presetTier('balanced', 'shadows'), 'low');
  assert.equal(presetTier('nope', 'shadows'), undefined);
  for (const p of PRESETS) for (const [cat, tiers] of Object.entries(CATEGORIES)) {
    assert.ok(tiers.includes(presetTier(p, cat)), `${p}.${cat}`);
  }
  const d = describe(resolve({ preset: 'high' }), [1280, 800]);
  assert.match(d, /2048² shadows/);
  assert.match(d, /SMAA/);
  assert.match(d, /1280×800 px/);
});

test('migrateGraphics converts the legacy tier setting', () => {
  assert.equal(migrateGraphics({ tier: 'medium', renderScale: 1 }).preset, 'balanced');
  assert.equal(migrateGraphics({ tier: 'high' }).preset, 'high');
  assert.equal(migrateGraphics({ tier: 'auto' }).preset, 'auto');
  assert.equal(migrateGraphics(undefined).preset, 'auto');
  assert.equal(migrateGraphics({ preset: 'ultra', bloom: 'off' }).bloom, 'off');
});

test('graphics strings exist for every locale and category', () => {
  const locales = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];
  const en = GFX_STRINGS['en-US'];
  for (const loc of locales) {
    const L = GFX_STRINGS[loc];
    assert.ok(L, loc);
    for (const k of Object.keys(en)) assert.ok(L[k], `${loc}.${k}`);
    for (const cat of Object.keys(CATEGORIES)) assert.ok(L.cats[cat], `${loc}.cats.${cat}`);
    for (const tiers of Object.values(CATEGORIES)) for (const t of tiers) assert.ok(L.tiers[t], `${loc}.tiers.${t}`);
    for (const p of PRESETS) assert.ok(L.presets[p], `${loc}.presets.${p}`);
    assert.match(L.auto, /\{tier\}/);
    assert.match(L.fromPreset, /\{tier\}/);
  }
  assert.equal(gfxStrings('de').quality, 'Qualität');
  assert.equal(gfxStrings('es-MX'), GFX_STRINGS['es-419']);
  assert.equal(gfxStrings('es-ES'), GFX_STRINGS['es-ES']);
  assert.equal(gfxStrings('en-AU'), GFX_STRINGS['en-GB']);
  assert.equal(gfxStrings('xx-YY'), GFX_STRINGS['en-US']);
});
