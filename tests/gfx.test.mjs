/**
 * Unit tests for the graphics quality model (src/gfx.js) and its strings.
 * Run: node --test tests/gfx.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PRESETS, CATEGORIES, detectPreset, resolve, presetTier, choosePreset, describe, migrateGraphics,
  detectLevel, presetForLevel, budgetFor, particleCap, moteCount, LEVELS, BUDGETS, PARTICLE_MAX, MOTE_MAX,
} from '../src/gfx.js';
// src/gpu-level.js is a classic script in the page (window.StarHermitGpu); evaluate it the same way here.
new Function('window', 'module', readFileSync(new URL('../src/gpu-level.js', import.meta.url), 'utf8'))(globalThis, undefined);
import { GFX_STRINGS, gfxStrings } from '../src/gfxstrings.js';

const DESK = { cores: 8, memoryGb: 8 };
const PHONE = { mobile: true, cores: 8, memoryGb: 8 };

test('hardware level picks the Auto preset (Low 0, Balanced 4, High 10, Ultra 17)', () => {
  assert.equal(detectPreset('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', DESK), 'low');
  assert.equal(detectLevel('llvmpipe (LLVM 15.0.7, 256 bits)', DESK), 0);
  assert.equal(detectPreset('', DESK), 'low', 'no WebGL');
  assert.equal(detectPreset('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)', DESK), 'low');
  assert.equal(detectPreset('ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)', DESK), 'balanced');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)', DESK), 'high');
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  assert.equal(detectLevel('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 20);
  assert.equal(detectPreset('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0)', DESK), 'ultra');
  for (const [p, lv] of Object.entries(LEVELS)) assert.equal(presetForLevel(lv), p);
  assert.equal(presetForLevel(3), 'low');
  assert.equal(presetForLevel(16), 'high');
});

test('phones and tablets are Balanced at most; software GPUs stay Low', () => {
  assert.equal(detectPreset('Adreno (TM) 740', PHONE), 'balanced');
  assert.ok(detectLevel('Adreno (TM) 740', PHONE) <= 9);
  assert.equal(detectPreset('Apple M2', PHONE), 'balanced');
  assert.equal(detectPreset('SwiftShader', PHONE), 'low');
});

test('per-preset budgets are explicit, grow from Low to Ultra and scale with the level', () => {
  const keys = ['material', 'texture', 'segments', 'particles', 'motes', 'bloomRes', 'aoRes'];
  for (const p of PRESETS) for (const k of keys) assert.ok(BUDGETS[p][k] != null, `${p}.${k}`);
  for (let i = 1; i < PRESETS.length; i++) for (const k of keys) {
    if (typeof BUDGETS.low[k] === 'number') assert.ok(BUDGETS[PRESETS[i]][k] >= BUDGETS[PRESETS[i - 1]][k], `${PRESETS[i]}.${k}`);
  }
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].material), ['lambert', 'standard', 'physical', 'physical']);
  assert.deepEqual(PRESETS.map((p) => BUDGETS[p].bloomRes), [0.5, 0.5, 0.5, 1], 'half-res bloom below Ultra');
  assert.deepEqual(resolve({ preset: 'high' }, 'low', 10).budget, BUDGETS.high, 'floor level = the tuned budget');
  assert.deepEqual(resolve({ preset: 'ultra' }, 'low', 0).budget, resolve({ preset: 'ultra' }, 'ultra', 17).budget);
  assert.ok(budgetFor('balanced', 9).motes > budgetFor('balanced', 4).motes, 'counts scale up within the preset');
  assert.ok(budgetFor('ultra', 20).particles <= PARTICLE_MAX && budgetFor('ultra', 20).motes <= MOTE_MAX);
  assert.equal(resolve({}, 'low', 0).budget.material, 'lambert', 'headless SwiftShader: Low, Lambert');
  assert.equal(particleCap(resolve({ preset: 'high' }, 'low', 10)), 160, 'High keeps the authored 160-spark pool');
  assert.equal(particleCap(resolve({ preset: 'low' }, 'low', 0)), 20, 'Low: a quarter of its pool');
  assert.equal(moteCount(resolve({ preset: 'low' }, 'low', 0)), 0, 'Low: no ember motes');
  assert.equal(moteCount(resolve({ preset: 'high' }, 'low', 10)), 70);
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
