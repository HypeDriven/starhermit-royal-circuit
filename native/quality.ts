// The look per graphics level. The engine owns its effects through
// levelSettings(): shadows and their map size, AO, bloom, grade and
// anti-aliasing come from the frame's level. The game keeps its art per quality
// tier (frame().quality): shading, textures, curve detail, reflections and
// particles, with the burst pool and the lantern embers scaled within the tier
// by the level's particle budget (at most 1.5×). The runtime owns the rest of
// what the old Graphics panel did: Auto and the level choice, render scale and
// the pixel-ratio cap, adaptive resolution, the frame-rate limit and the FPS
// readout.
import { levelSettings, type GraphicsLevel, type LevelSettings, type QualityTier } from "starhermit:engine";
import type { AntialiasMode } from "starhermit:scene";

export interface Budget {
  /** Tile, float, die and board shading: Lambert (Low), Standard (Balanced), clear-coated Physical (High, Ultra). */
  material: "lambert" | "standard" | "physical";
  /** Wood and flagstone texture size (tile lacquer: half; Surface detail on). */
  texture: number;
  /** Curve detail as a share of the authored meshes. */
  segments: number;
  /** Burst pool at Particles "high" (low: a quarter). */
  particles: number;
  /** Lantern embers (Particles high, ambience animated). */
  motes: number;
}
export interface Look {
  preset: QualityTier;
  /** The level's shadow map size (0 = off). */
  shadows: number;
  ao: { resolution: number; samples: number; denoiseSamples: number } | null;
  /** The level's bloom resolution (null = off). */
  bloom: number | null;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Procedural tile, wood and flagstone textures, the starry sky dome and the festoon lights. */
  detailed: boolean;
  particles: "low" | "high";
  animated: boolean;
  budget: Budget;
}

type Art = Pick<Look, "reflections" | "detailed" | "particles" | "animated">;
/** gfx.js TABLE's art. */
const ART: Record<QualityTier, Art> = {
  low: { reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { reflections: true, detailed: true, particles: "high", animated: true },
  high: { reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { reflections: true, detailed: true, particles: "high", animated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, segments: 0.5, particles: 80, motes: 30 },
  balanced: { material: "standard", texture: 256, segments: 0.75, particles: 120, motes: 50 },
  high: { material: "physical", texture: 256, segments: 1, particles: 160, motes: 70 },
  ultra: { material: "physical", texture: 512, segments: 1.5, particles: 240, motes: 100 },
};
/** The level each tier's budgets were tuned at. */
const ANCHOR: Record<QualityTier, GraphicsLevel> = { low: "quantum", balanced: "molecular", high: "terrestrial", ultra: "galactic" };
export const PARTICLE_MAX = 360;
export const MOTE_MAX = 150;

/** The look for a graphics level's settings (plain data, compared by applyLook). */
export function lookFor(s: LevelSettings = levelSettings()): Look {
  const preset = s.quality;
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, s.particles / levelSettings(ANCHOR[preset]).particles);
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return {
    preset, ...ART[preset],
    shadows: s.shadows ? s.shadowMapSize : 0,
    ao: s.ao && { resolution: s.ao.resolution, samples: s.ao.samples, denoiseSamples: s.ao.denoiseSamples },
    bloom: s.bloom ? s.bloom.resolution : null,
    grade: s.grade,
    antialias: s.antialias,
    budget: b,
  };
}
/** gfx.js particleCap: the live burst pool. */
export function particleCap(l: Look): number { return l.particles === "high" ? l.budget.particles : Math.round(l.budget.particles / 4); }
/** gfx.js moteCount: the drawn embers. */
export function moteCount(l: Look): number { return l.particles === "high" && l.animated ? l.budget.motes : 0; }
