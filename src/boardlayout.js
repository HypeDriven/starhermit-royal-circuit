/**
 * boardlayout.js — the single shared layout model.
 *
 * Both the Three.js scene and the DOM overlay compute positions from these
 * functions, so HTML labels align exactly with projected 3D targets.
 * Pure math, no rendering dependencies. Units are world units; the circuit
 * ring has radius RING_RADIUS.
 */

import { TRACK_LEN, APPROACH_LEN, startCell } from './rules.js';

export const RING_RADIUS = 10;
export const TILE_SIZE = 1.34;        // circuit tile width
export const APPROACH_STEP = 1.5;     // approach lane spacing toward center
export const WORKSHOP_RADIUS = RING_RADIUS + 3.4;
export const BOARD_Y = 0;             // board surface height

/** Angle of circuit cell c (cell 0 at -90°, i.e. nearest the default camera). */
export function cellAngle(c) {
  return -Math.PI / 2 + ((c % TRACK_LEN) / TRACK_LEN) * Math.PI * 2;
}

/** World position of a circuit cell center. */
export function circuitPos(cell, y = BOARD_Y) {
  const a = cellAngle(cell);
  return { x: Math.cos(a) * RING_RADIUS, y, z: Math.sin(a) * RING_RADIUS, angle: a };
}

/** World position of approach lane step i (0..3) for a seat, heading to center. */
export function approachPos(ruleset, seat, step, y = BOARD_Y) {
  const start = startCell(ruleset, seat);
  const a = cellAngle(start);
  const r = RING_RADIUS - APPROACH_STEP * (step + 1);
  return { x: Math.cos(a) * r, y, z: Math.sin(a) * r, angle: a };
}

/** Crown (finish) position at the pavilion heart. */
export function crownPos(seat = 0, y = BOARD_Y) {
  // small per-seat offset so crowned floats fan out around the dais
  const a = -Math.PI / 2 + seat * (Math.PI / 2) + Math.PI / 8;
  return { x: Math.cos(a) * 1.1, y: y + 0.55, z: Math.sin(a) * 1.1, angle: a };
}

/** Workshop (home) pad position for float index i of a seat. */
export function workshopPos(ruleset, seat, index, y = BOARD_Y) {
  const start = startCell(ruleset, seat);
  const a = cellAngle(start);
  const cx = Math.cos(a) * WORKSHOP_RADIUS;
  const cz = Math.sin(a) * WORKSHOP_RADIUS;
  // 2x2 grid oriented tangentially
  const tx = -Math.sin(a), tz = Math.cos(a); // tangent
  const rx = Math.cos(a), rz = Math.sin(a);  // radial
  const gx = (index % 2) - 0.5, gz = Math.floor(index / 2) - 0.5;
  const s = 1.05;
  return {
    x: cx + tx * gx * s + rx * gz * s,
    y,
    z: cz + tz * gx * s + rz * gz * s,
    angle: a,
  };
}

/**
 * World position for a float in any zone. Stacked floats on the same cell
 * get a deterministic small offset so all remain visible/pickable.
 */
export function floatPos(ruleset, seat, progress, stackIndex = 0, stackSize = 1, y = BOARD_Y) {
  let base;
  if (progress < 0) base = workshopPos(ruleset, seat, stackIndex, y);
  else if (progress < TRACK_LEN) base = circuitPos((startCell(ruleset, seat) + progress) % TRACK_LEN, y);
  else if (progress < TRACK_LEN + APPROACH_LEN) base = approachPos(ruleset, seat, progress - TRACK_LEN, y);
  else base = crownPos(seat, y);
  if (progress >= 0 && progress < TRACK_LEN + APPROACH_LEN && stackSize > 1) {
    // fan stacked floats around the cell center
    const a = (stackIndex / stackSize) * Math.PI * 2;
    const r = 0.34;
    base = { ...base, x: base.x + Math.cos(a) * r, z: base.z + Math.sin(a) * r };
  }
  return base;
}

/** Die display position: in front of the acting seat's workshop. */
export function diePos(ruleset, seat, y = BOARD_Y) {
  const start = startCell(ruleset, seat);
  const a = cellAngle(start);
  const r = RING_RADIUS + 1.9;
  return { x: Math.cos(a) * r, y: y + 0.5, z: Math.sin(a) * r, angle: a };
}
