// The look per graphics level: the browser build's four presets and budgets
// (src/gfx.js TABLE / BUDGETS, each tuned to hold 60 FPS on the weakest GPU
// its Auto gave it) keyed by the runtime's quality tier (frame().quality),
// with the burst pool and the lantern embers scaled within the tier by the
// level (frame().levelIndex, at most 1.5×), as the browser build scaled them
// by its hardware level. The runtime owns the rest of what the old Graphics
// panel did: Auto and the level choice, render scale and the pixel-ratio cap,
// adaptive resolution, the frame-rate limit and the FPS readout. The old
// panel's per-effect overrides are not offered (the runtime's Options choose
// a level).
import type { QualityTier } from "starhermit:engine";
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
  bloomRes: number;
  aoRes: number;
}
export interface Look {
  preset: QualityTier;
  shadows: 0 | 1024 | 2048 | 4096;
  ao: "off" | "on" | "high";
  bloom: boolean;
  grade: boolean;
  antialias: AntialiasMode;
  reflections: boolean;
  /** Procedural tile, wood and flagstone textures, the starry sky dome and the festoon lights. */
  detailed: boolean;
  particles: "low" | "high";
  animated: boolean;
  budget: Budget;
}

/** gfx.js TABLE. */
const TABLE: Record<QualityTier, Omit<Look, "preset" | "budget">> = {
  low: { shadows: 0, ao: "off", bloom: false, grade: false, antialias: "msaa", reflections: false, detailed: false, particles: "low", animated: false },
  balanced: { shadows: 1024, ao: "off", bloom: true, grade: true, antialias: "fxaa", reflections: true, detailed: true, particles: "high", animated: true },
  high: { shadows: 2048, ao: "on", bloom: true, grade: true, antialias: "smaa", reflections: true, detailed: true, particles: "high", animated: true },
  ultra: { shadows: 4096, ao: "high", bloom: true, grade: true, antialias: "msaa", reflections: true, detailed: true, particles: "high", animated: true },
};
/** gfx.js BUDGETS. */
const BUDGETS: Record<QualityTier, Budget> = {
  low: { material: "lambert", texture: 128, segments: 0.5, particles: 80, motes: 30, bloomRes: 0.5, aoRes: 0.5 },
  balanced: { material: "standard", texture: 256, segments: 0.75, particles: 120, motes: 50, bloomRes: 0.5, aoRes: 0.5 },
  high: { material: "physical", texture: 256, segments: 1, particles: 160, motes: 70, bloomRes: 0.5, aoRes: 0.5 },
  ultra: { material: "physical", texture: 512, segments: 1.5, particles: 240, motes: 100, bloomRes: 1, aoRes: 1 },
};
/** The first level index of each tier. */
const TIER_FLOOR: Record<QualityTier, number> = { low: 0, balanced: 2, high: 4, ultra: 7 };
export const PARTICLE_MAX = 360;
export const MOTE_MAX = 150;

/** The look for a quality tier at a level index (0 … 9). */
export function lookFor(preset: QualityTier, levelIndex: number): Look {
  const b = { ...BUDGETS[preset] };
  const k = Math.min(1.5, Math.pow(1.25, Math.max(0, levelIndex - TIER_FLOOR[preset])));
  b.particles = Math.min(PARTICLE_MAX, Math.round(b.particles * k));
  b.motes = Math.min(MOTE_MAX, Math.round(b.motes * k));
  return { preset, ...TABLE[preset], budget: b };
}
/** gfx.js particleCap: the live burst pool. */
export function particleCap(l: Look): number { return l.particles === "high" ? l.budget.particles : Math.round(l.budget.particles / 4); }
/** gfx.js moteCount: the drawn embers. */
export function moteCount(l: Look): number { return l.particles === "high" && l.animated ? l.budget.motes : 0; }
