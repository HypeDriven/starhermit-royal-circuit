/**
 * render.js — Three.js renderer for Royal Circuit.
 *
 * A festive circular board in a lantern-lit pavilion: shared 40-tile
 * circuit ring, per-seat workshops, colored approach lanes and a central
 * pavilion dais. Presentation only — every visual reconciles from the
 * immutable rules snapshot; no rules logic lives here.
 *
 * - One shared layout model with the DOM overlay (boardlayout.js), so DOM
 *   labels align exactly with projected 3D targets.
 * - Scene graph is layered: environment / gameplay / selection+ghosts /
 *   effects / UI anchors. Raycasts run only against explicit pick lists;
 *   cosmetic particles never intercept.
 * - animateEvents() is cosmetic playback over an event queue and always
 *   settles into the exact deterministic end state (syncState). skip()
 *   settles instantly.
 * - The render loop pauses when document.hidden.
 */

import * as THREE from '../vendor/three.module.js';
// Post-processing + IBL addons vendored from three@0.160.1 (same revision as
// the core build); their bare 'three' imports resolve via index.html's importmap.
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { GTAOPass } from '../vendor/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from '../vendor/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from '../vendor/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from '../vendor/addons/environments/RoomEnvironment.js';
import {
  detectPreset, resolve as resolveGfx, describe as describeGfx,
  SHADOW_MAP, PARTICLE_CAP, MOTES,
} from './gfx.js';
import {
  TRACK_LEN, DONE, SAFE_CELLS, PLAYER_DEFS, startCell,
} from './rules.js';
import {
  RING_RADIUS, TILE_SIZE, WORKSHOP_RADIUS, circuitPos, floatPos, diePos,
  cellAngle,
} from './boardlayout.js';

/* Okabe–Ito color-blind-safe player palette (blue/gold separation). */
const CVD_COLORS = [0x0072b2, 0xe69f00, 0x56b4e9, 0xcc79a7];

// Colour grade + vignette, applied after OutputPass (display-space in/out):
// gentle S-curve contrast, a touch of saturation, warm highlights.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.97, 0.98, 1.04), vec3(1.04, 1.0, 0.95), smoothstep(0.25, 0.85, l));
      s = s * 0.98 + 0.015;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/* ---- procedural textures (deterministic; greyscale so theme colours tint them) ---- */
function seededRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTex(size, draw, { repeat = 1, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

// Lacquered tile: bright field, darker bevel edge and a fine gold-line inlay.
function tileTexture() {
  return canvasTex(128, (g, n) => {
    const rnd = seededRand(7);
    g.fillStyle = '#d8d4de';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 700; i++) {
      const v = 205 + Math.floor(rnd() * 40);
      g.fillStyle = `rgba(${v},${v},${v + 6},0.35)`;
      g.fillRect(rnd() * n, rnd() * n, 2, 2);
    }
    const grd = g.createLinearGradient(0, 0, 0, n);
    grd.addColorStop(0, 'rgba(255,255,255,0.18)');
    grd.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = grd;
    g.fillRect(0, 0, n, n);
    g.strokeStyle = 'rgba(40,30,50,0.55)';
    g.lineWidth = 8;
    g.strokeRect(4, 4, n - 8, n - 8);
    g.strokeStyle = 'rgba(255,236,190,0.75)';
    g.lineWidth = 2;
    g.strokeRect(14, 14, n - 28, n - 28);
  });
}

function woodTexture() {
  return canvasTex(256, (g, n) => {
    const rnd = seededRand(11);
    g.fillStyle = '#d9cfc6';
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 90; i++) {
      const y = rnd() * n;
      const v = 150 + Math.floor(rnd() * 70);
      g.strokeStyle = `rgba(${v},${v - 12},${v - 24},${0.25 + rnd() * 0.35})`;
      g.lineWidth = 0.6 + rnd() * 2.2;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= n; x += 16) g.lineTo(x, y + Math.sin(x / 40 + i) * 3 + (rnd() - 0.5) * 2);
      g.stroke();
    }
  }, { repeat: 3 });
}

// Plaza flagstones for the pavilion floor.
function stoneTexture() {
  return canvasTex(256, (g, n) => {
    const rnd = seededRand(23);
    g.fillStyle = '#8f8a98';
    g.fillRect(0, 0, n, n);
    const cells = 4, s = n / cells;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const v = 170 + Math.floor(rnd() * 50);
        g.fillStyle = `rgb(${v},${v - 4},${v + 8})`;
        const off = (y % 2) * s * 0.5;
        g.fillRect(((x * s + off) % n) + 3, y * s + 3, s - 6, s - 6);
        if (off) g.fillRect(-s + off + 3, y * s + 3, s - 6, s - 6);
      }
    }
    for (let i = 0; i < 1600; i++) {
      const v = Math.floor(rnd() * 255);
      g.fillStyle = `rgba(${v},${v},${v},0.06)`;
      g.fillRect(rnd() * n, rnd() * n, 2, 2);
    }
  }, { repeat: 9 });
}

// Soft round sprite for particles and motes.
function spriteTexture() {
  return canvasTex(64, (g, n) => {
    const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, n, n);
  });
}

function gpuName(renderer) {
  try {
    const gl = renderer.getContext();
    // Firefox exposes the unmasked name directly and warns on the extension.
    const ext = /firefox/i.test(navigator.userAgent) ? null : gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch {
    return '';
  }
}

const CAMERA_VIEWS = {
  auto: { dist: 21, height: 16 },
  top: { dist: 2, height: 36 },
  low: { dist: 23, height: 7 },
};

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export function createRenderer(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  const mobile = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const gpu = gpuName(renderer);

  const R = {
    canvas, renderer, scene, camera,
    theme: opts.theme || null,
    reducedMotion: !!opts.reducedMotion,
    gpu,
    detected: detectPreset(gpu, { mobile }),
    q: null,                 // resolved graphics settings (gfx.js)
    composer: null,
    gradePass: null,
    postKey: null,
    postFailed: false,
    size: [0, 0],
    pixelRatio: 1,
    adaptiveScale: 1,
    frames: [],
    palette: opts.palette === 'cvd' ? 'cvd' : 'standard',
    state: null,
    rulesetKey: '',
    tweens: new Set(),
    ready: false,
    disposed: false,
    fps: 60,
    lastT: 0,
    time: 0,
    raf: 0,
    selection: null,
    hintMoves: [],
    hintRoll: false,
    shake: 0,
    cam: { az: 0, dist: CAMERA_VIEWS.auto.dist, height: CAMERA_VIEWS.auto.height, mode: 'auto' },
    camTarget: { az: 0, dist: CAMERA_VIEWS.auto.dist, height: CAMERA_VIEWS.auto.height },
    floatViews: new Map(), // 'seat:floatId' -> view
    pickables: [],
    ray: new THREE.Raycaster(),
  };
  const prefersReduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const motionOff = () => R.reducedMotion || !!prefersReduced?.matches;

  /* ---------------------------------------------------------------- */
  /* materials + shared geometry                                       */
  /* ---------------------------------------------------------------- */
  const TEX = {
    tile: tileTexture(), wood: woodTexture(), stone: stoneTexture(), sprite: spriteTexture(),
  };
  const M = {
    ground: new THREE.MeshStandardMaterial({ color: 0x241c3a, roughness: 0.92, envMapIntensity: 0.04 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5a3b2a, roughness: 0.72, envMapIntensity: 0.1 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xc9973f, roughness: 0.34, metalness: 0.5, envMapIntensity: 0.4 }),
    tileA: new THREE.MeshPhysicalMaterial({
      color: 0x3a2c50, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.1,
    }),
    tileB: new THREE.MeshPhysicalMaterial({
      color: 0x443456, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.1,
    }),
    lantern: new THREE.MeshStandardMaterial({
      color: 0xffb347, emissive: 0xff9a2e, emissiveIntensity: 1.6, roughness: 0.5,
    }),
    post: new THREE.MeshStandardMaterial({ color: 0x2c2033, roughness: 0.8, envMapIntensity: 0.1 }),
    die: new THREE.MeshStandardMaterial({ color: 0xf5efe2, roughness: 0.35 }),
    ghost: new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    }),
    bulbs: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    wire: new THREE.LineBasicMaterial({ color: 0x1a1420, transparent: true, opacity: 0.8 }),
  };
  const playerMats = PLAYER_DEFS.map((d) => new THREE.MeshPhysicalMaterial({
    color: d.color, roughness: 0.4, metalness: 0.1, emissive: d.color, emissiveIntensity: 0.12,
    clearcoat: 0.5, clearcoatRoughness: 0.4, envMapIntensity: 0.22,
  }));
  const playerLaneMats = PLAYER_DEFS.map((d) => new THREE.MeshStandardMaterial({
    color: d.color, roughness: 0.55, transparent: true, opacity: 0.88, envMapIntensity: 0.12,
  }));

  const G = {
    tile: new THREE.BoxGeometry(TILE_SIZE, 0.24, 1.7),
    step: new THREE.BoxGeometry(1.15, 0.16, 1.15),
    pad: new THREE.BoxGeometry(2.9, 0.18, 2.9),
    dais: new THREE.CylinderGeometry(2.3, 2.6, 0.55, 32),
    pillar: new THREE.CylinderGeometry(0.14, 0.14, 2.6, 10),
    roof: new THREE.ConeGeometry(3.1, 1.6, 8),
    lanternBall: new THREE.SphereGeometry(0.3, 14, 12),
    lanternPost: new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6),
    ring: new THREE.RingGeometry(0.5, 0.78, 32),
    safeInlay: new THREE.RingGeometry(0.46, 0.56, 28),
    rim: (r) => new THREE.TorusGeometry(r, 0.11, 8, 96),
    float: {
      round: new THREE.SphereGeometry(0.44, 24, 18),
      square: new THREE.BoxGeometry(0.72, 0.72, 0.72),
      tri: new THREE.ConeGeometry(0.5, 0.95, 3),
      hex: new THREE.CylinderGeometry(0.46, 0.46, 0.55, 6),
    },
    floatBase: new THREE.CylinderGeometry(0.52, 0.58, 0.14, 20),
    die: new THREE.BoxGeometry(0.9, 0.9, 0.9),
    bulb: new THREE.SphereGeometry(0.075, 8, 6),
  };

  /* ---------------------------------------------------------------- */
  /* scene layers                                                      */
  /* ---------------------------------------------------------------- */
  const envLayer = new THREE.Group(); envLayer.name = 'environment';
  const gameLayer = new THREE.Group(); gameLayer.name = 'gameplay';
  const ghostLayer = new THREE.Group(); ghostLayer.name = 'selection-ghosts';
  const fxLayer = new THREE.Group(); fxLayer.name = 'effects';
  scene.add(envLayer, gameLayer, ghostLayer, fxLayer);

  // lights: one dominant key, soft hemisphere fill, warm pavilion point
  const hemi = new THREE.HemisphereLight(0x8880b0, 0x1a1426, 0.55);
  const key = new THREE.DirectionalLight(0xfff1d6, 1.35);
  key.position.set(14, 24, 10);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  // shadow frustum fitted to the board + perimeter lanterns (radius ~19)
  const SHADOW_R = WORKSHOP_RADIUS + 5.4;
  Object.assign(key.shadow.camera, {
    left: -SHADOW_R, right: SHADOW_R, top: SHADOW_R, bottom: -SHADOW_R, near: 8, far: 62,
  });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  const pavilionLight = new THREE.PointLight(0xffb347, 30, 26, 1.8);
  pavilionLight.position.set(0, 4.2, 0);
  envLayer.add(hemi, key, pavilionLight);

  // image-based lighting (reflections on lacquer, gold trim and floats)
  let envTex = null;
  function environmentMap() {
    if (!envTex) {
      const pm = new THREE.PMREMGenerator(renderer);
      envTex = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      pm.dispose();
    }
    return envTex;
  }

  // sky dome: theme gradient + faint stars (detailed only; plain uses the flat background)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x07060f) },
      uHorizon: { value: new THREE.Color(0x1a1430) },
      uTime: { value: 0 },
    },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uHorizon; uniform float uTime;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(uHorizon, uTop, pow(h, 0.55));
        vec3 cell = floor(vDir * 180.0);
        float s = hash(cell);
        float tw = 0.65 + 0.35 * sin(uTime * 1.3 + s * 40.0);
        c += vec3(1.0, 0.95, 0.85) * step(0.9965, s) * smoothstep(0.08, 0.4, h) * tw * 0.9;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(95, 32, 16), skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.raycast = () => {};
  envLayer.add(sky);

  // ground + board base
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 64), M.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.32;
  ground.receiveShadow = true;
  const boardBase = new THREE.Mesh(
    new THREE.CylinderGeometry(WORKSHOP_RADIUS + 2.2, WORKSHOP_RADIUS + 2.6, 0.5, 72), M.wood);
  boardBase.position.y = -0.26;
  boardBase.receiveShadow = true;
  // gold rims framing the circuit (the tiles themselves stay fully visible)
  const rimIn = new THREE.Mesh(G.rim(RING_RADIUS - 0.95), M.trim);
  const rimOut = new THREE.Mesh(G.rim(RING_RADIUS + 0.95), M.trim);
  const rimEdge = new THREE.Mesh(G.rim(WORKSHOP_RADIUS + 2.2), M.trim);
  for (const rim of [rimIn, rimOut, rimEdge]) {
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.0;
    rim.receiveShadow = true;
    envLayer.add(rim);
  }
  envLayer.add(ground, boardBase);

  // circuit tiles: two instanced meshes (alternating colors)
  const cellsA = [], cellsB = [];
  for (let c = 0; c < TRACK_LEN; c++) (c % 2 === 0 ? cellsA : cellsB).push(c);
  function buildTileMesh(cells, mat) {
    const mesh = new THREE.InstancedMesh(G.tile, mat, cells.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    cells.forEach((cell, i) => {
      const p = circuitPos(cell, -0.1);
      q.setFromAxisAngle(up, -p.angle + Math.PI / 2);
      m4.compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1));
      mesh.setMatrixAt(i, m4);
    });
    mesh.receiveShadow = true;
    mesh.userData.cells = cells;
    gameLayer.add(mesh);
    return mesh;
  }
  const tilesA = buildTileMesh(cellsA, M.tileA);
  const tilesB = buildTileMesh(cellsB, M.tileB);

  // lantern posts on safe cells, with a gold inlay ring on the tile
  const lanternLamps = [];
  for (const cell of SAFE_CELLS) {
    const p = circuitPos(cell);
    const post = new THREE.Mesh(G.lanternPost, M.post);
    post.position.set(p.x, 0.75, p.z);
    const lamp = new THREE.Mesh(G.lanternBall, M.lantern);
    lamp.position.set(p.x, 1.62, p.z);
    lamp.scale.set(1, 1.2, 1);
    lamp.userData.baseY = 1.62;
    lamp.userData.phase = cell * 0.7;
    lanternLamps.push(lamp);
    const inlay = new THREE.Mesh(G.safeInlay, M.trim);
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.set(p.x, 0.035, p.z);
    inlay.raycast = () => {};
    post.castShadow = true;
    envLayer.add(post, lamp, inlay);
  }

  // center pavilion: dais + pillars + roof
  const dais = new THREE.Mesh(G.dais, M.trim);
  dais.position.y = 0.27;
  dais.receiveShadow = true;
  envLayer.add(dais);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const pillar = new THREE.Mesh(G.pillar, M.wood);
    pillar.position.set(Math.cos(a) * 2.4, 1.85, Math.sin(a) * 2.4);
    pillar.castShadow = true;
    envLayer.add(pillar);
  }
  const roof = new THREE.Mesh(G.roof, M.trim);
  roof.position.y = 3.9;
  roof.castShadow = true;
  envLayer.add(roof);
  const crownLamp = new THREE.Mesh(G.lanternBall, M.lantern);
  crownLamp.position.y = 3.1;
  crownLamp.scale.set(1, 1.2, 1);
  envLayer.add(crownLamp);

  // decorative perimeter lantern posts (instanced) + festoon string lights
  const PERIM_N = 12, PERIM_R = WORKSHOP_RADIUS + 4.6;
  const perimAngle = (i) => (i / PERIM_N) * Math.PI * 2 + Math.PI / 12;
  {
    const posts = new THREE.InstancedMesh(G.lanternPost, M.post, PERIM_N);
    const lamps = new THREE.InstancedMesh(G.lanternBall, M.lantern, PERIM_N);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < PERIM_N; i++) {
      const a = perimAngle(i);
      m4.makeTranslation(Math.cos(a) * PERIM_R, 1.2, Math.sin(a) * PERIM_R);
      posts.setMatrixAt(i, m4);
      m4.makeScale(1, 1.2, 1).setPosition(Math.cos(a) * PERIM_R, 2.2, Math.sin(a) * PERIM_R);
      lamps.setMatrixAt(i, m4);
    }
    posts.castShadow = true;
    envLayer.add(posts, lamps);
  }
  const festoon = new THREE.Group();
  festoon.name = 'festoon';
  {
    const PER = 9; // bulbs per span
    const bulbs = new THREE.InstancedMesh(G.bulb, M.bulbs, PERIM_N * PER);
    const palette = [[3.2, 2.2, 1.0], [3.0, 0.9, 0.7], [1.0, 2.6, 2.2], [3.0, 1.3, 2.2], [2.8, 2.6, 1.2]]
      .map(([r, g, b]) => new THREE.Color(r, g, b));
    const wirePts = [];
    const m4 = new THREE.Matrix4();
    let k = 0;
    for (let i = 0; i < PERIM_N; i++) {
      const a0 = perimAngle(i), a1 = perimAngle(i + 1);
      const p0 = new THREE.Vector3(Math.cos(a0) * PERIM_R, 2.5, Math.sin(a0) * PERIM_R);
      const p1 = new THREE.Vector3(Math.cos(a1) * PERIM_R, 2.5, Math.sin(a1) * PERIM_R);
      const seg = 16;
      for (let s = 0; s <= seg; s++) {
        const t = s / seg;
        const v = p0.clone().lerp(p1, t);
        v.y -= Math.sin(t * Math.PI) * 0.7;
        wirePts.push(v);
        if (s < seg) {
          const t2 = (s + 1) / seg;
          const w = p0.clone().lerp(p1, t2);
          w.y -= Math.sin(t2 * Math.PI) * 0.7;
          wirePts.push(w);
        }
      }
      for (let b = 0; b < PER; b++) {
        const t = (b + 0.5) / PER;
        const v = p0.clone().lerp(p1, t);
        v.y -= Math.sin(t * Math.PI) * 0.7 + 0.1;
        m4.makeTranslation(v.x, v.y, v.z);
        bulbs.setMatrixAt(k, m4);
        bulbs.setColorAt(k, palette[k % palette.length]);
        k++;
      }
    }
    const wire = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(wirePts), M.wire);
    wire.raycast = () => {};
    bulbs.raycast = () => {};
    festoon.add(wire, bulbs);
    envLayer.add(festoon);
  }

  // player-dependent board pieces, rebuilt when the ruleset shape changes
  const playerBoard = new THREE.Group();
  gameLayer.add(playerBoard);

  function rebuildPlayerBoard(state) {
    while (playerBoard.children.length) {
      const c = playerBoard.children.pop();
      playerBoard.remove(c);
    }
    const rs = state.ruleset;
    for (let seat = 0; seat < rs.players; seat++) {
      // workshop pad
      const a = cellAngle(startCell(rs, seat));
      const pad = new THREE.Mesh(G.pad, M.wood);
      pad.position.set(Math.cos(a) * WORKSHOP_RADIUS, -0.09, Math.sin(a) * WORKSHOP_RADIUS);
      pad.receiveShadow = true;
      const padTrim = new THREE.Mesh(G.step, playerLaneMats[seat]);
      padTrim.scale.set(2.2, 0.4, 2.2);
      padTrim.position.set(Math.cos(a) * WORKSHOP_RADIUS, 0.02, Math.sin(a) * WORKSHOP_RADIUS);
      playerBoard.add(pad, padTrim);
      // start-tile marker
      const sp = circuitPos(startCell(rs, seat), 0.06);
      const marker = new THREE.Mesh(G.ring, playerLaneMats[seat]);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(sp.x, sp.y, sp.z);
      playerBoard.add(marker);
      // approach lane steps
      for (let s = 0; s < 4; s++) {
        const r = RING_RADIUS - 1.5 * (s + 1);
        const step = new THREE.Mesh(G.step, playerLaneMats[seat]);
        step.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
        step.receiveShadow = true;
        playerBoard.add(step);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* floats                                                            */
  /* ---------------------------------------------------------------- */
  const floatsRoot = new THREE.Group();
  gameLayer.add(floatsRoot);

  function makeFloatView(seat, floatId) {
    const def = PLAYER_DEFS[seat];
    const group = new THREE.Group();
    const base = new THREE.Mesh(G.floatBase, M.trim);
    base.position.y = 0.07;
    const body = new THREE.Mesh(G.float[def.shape] || G.float.round, playerMats[seat]);
    body.position.y = def.shape === 'round' ? 0.58 : 0.55;
    body.castShadow = true;
    const lampTop = new THREE.Mesh(G.lanternBall, M.lantern);
    lampTop.scale.setScalar(0.45);
    lampTop.position.y = 1.12;
    const ring = new THREE.Mesh(G.ring, M.ghost.clone());
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    ring.visible = false;
    group.add(base, body, lampTop, ring);
    group.userData.pick = { kind: 'float', seat, floatId };
    group.userData.ring = ring;
    group.userData.body = body;
    floatsRoot.add(group);
    return { group, body, ring, seat, floatId, lifted: false };
  }

  function playerColor(seat) {
    return R.palette === 'cvd' ? CVD_COLORS[seat] : PLAYER_DEFS[seat].color;
  }

  function applyPalette() {
    playerMats.forEach((m, seat) => {
      m.color.setHex(playerColor(seat));
      m.emissive.setHex(playerColor(seat));
    });
    playerLaneMats.forEach((m, seat) => m.color.setHex(playerColor(seat)));
  }

  /** World placement of every float, with deterministic stack fanning. */
  function computePlacements(state) {
    const groups = new Map();
    state.players.forEach((pl, seat) => {
      pl.floats.forEach((p, fid) => {
        let key;
        if (p < 0) key = `w${seat}:${fid}`;
        else if (p < TRACK_LEN) key = `c${(startCell(state.ruleset, seat) + p) % TRACK_LEN}`;
        else if (p < DONE) key = `a${seat}:${p}`;
        else key = `k${seat}:${fid}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ seat, fid, p });
      });
    });
    const out = [];
    for (const arr of groups.values()) {
      arr.sort((x, y) => x.seat - y.seat || x.fid - y.fid);
      arr.forEach((f, i) => {
        let pos;
        if (f.p < 0) {
          pos = floatPos(state.ruleset, f.seat, f.p, f.fid, 1); // workshop grid uses float index
        } else if (f.p >= DONE) {
          pos = floatPos(state.ruleset, f.seat, f.p, i, arr.length);
          const fa = (f.fid / Math.max(1, state.ruleset.floats)) * Math.PI * 2;
          pos = { ...pos, x: pos.x + Math.cos(fa) * 0.42, z: pos.z + Math.sin(fa) * 0.42 };
        } else {
          pos = floatPos(state.ruleset, f.seat, f.p, i, arr.length);
        }
        out.push({ ...f, pos });
      });
    }
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* die (canvas pip textures, one per face)                           */
  /* ---------------------------------------------------------------- */
  function pipTexture(value) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#f5efe2';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#33240f';
    const spots = {
      1: [[0.5, 0.5]],
      2: [[0.28, 0.28], [0.72, 0.72]],
      3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
      4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
      5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
      6: [[0.3, 0.26], [0.7, 0.26], [0.3, 0.5], [0.7, 0.5], [0.3, 0.74], [0.7, 0.74]],
    }[value];
    for (const [x, y] of spots) {
      g.beginPath();
      g.arc(x * 128, y * 128, 13, 0, Math.PI * 2);
      g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z
  const dieMats = [3, 4, 1, 6, 2, 5].map(
    (v) => new THREE.MeshPhysicalMaterial({
      map: pipTexture(v), roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2, envMapIntensity: 0.25,
    }));
  const die = new THREE.Mesh(G.die, dieMats);
  die.castShadow = true;
  die.visible = false;
  die.userData.pick = { kind: 'die' };
  gameLayer.add(die);
  // rotation bringing each value's face to the top (+y)
  const DIE_ROT = {
    1: new THREE.Euler(0, 0, 0),
    6: new THREE.Euler(Math.PI, 0, 0),
    3: new THREE.Euler(0, 0, Math.PI / 2),
    4: new THREE.Euler(0, 0, -Math.PI / 2),
    2: new THREE.Euler(-Math.PI / 2, 0, 0),
    5: new THREE.Euler(Math.PI / 2, 0, 0),
  };

  /* ---------------------------------------------------------------- */
  /* hints + selection (ghost layer)                                   */
  /* ---------------------------------------------------------------- */
  const hintRings = [];
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(G.ring, M.ghost.clone());
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ghostLayer.add(ring);
    hintRings.push(ring);
  }

  /* ---------------------------------------------------------------- */
  /* particle pool (fx layer; never raycast)                           */
  /* ---------------------------------------------------------------- */
  const MAXP = PARTICLE_CAP.high;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(MAXP * 3);
  const pCol = new Float32Array(MAXP * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.26, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
    map: TEX.sprite, alphaTest: 0.02,
  }));
  particles.raycast = () => {}; // cosmetic: never intercepts raycasts
  particles.frustumCulled = false;
  fxLayer.add(particles);
  const pLive = []; // {i, vx, vy, vz, life}
  let pFree = [];
  for (let i = MAXP - 1; i >= 0; i--) { pFree.push(i); pPos[i * 3 + 1] = -999; }

  function burst(pos, colorHex, n = 18, speed = 3.2) {
    if (R.reducedMotion) return;
    const col = new THREE.Color(colorHex);
    const cap = PARTICLE_CAP[R.q?.particles] || PARTICLE_CAP.low;
    for (let k = 0; k < n && pFree.length; k++) {
      const i = pFree.pop();
      if (i >= cap) continue;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.35;
      pLive.push({
        i,
        vx: Math.cos(a) * speed * Math.random(),
        vy: up * speed,
        vz: Math.sin(a) * speed * Math.random(),
        life: 0.9 + Math.random() * 0.5,
      });
      pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y + 0.3; pPos[i * 3 + 2] = pos.z;
      pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  function updateParticles(dt) {
    if (!pLive.length) return;
    for (let k = pLive.length - 1; k >= 0; k--) {
      const p = pLive[k];
      p.life -= dt;
      if (p.life <= 0) {
        pPos[p.i * 3 + 1] = -999;
        pFree.push(p.i);
        pLive.splice(k, 1);
        continue;
      }
      p.vy -= 7 * dt;
      pPos[p.i * 3] += p.vx * dt;
      pPos[p.i * 3 + 1] = Math.max(0.05, pPos[p.i * 3 + 1] + p.vy * dt);
      pPos[p.i * 3 + 2] += p.vz * dt;
    }
    pGeo.attributes.position.needsUpdate = true;
  }

  // ambient lantern motes: warm embers drifting up around the circuit
  // (cosmetic, additive, never raycast; frozen with reduced motion)
  const MAXM = MOTES.high;
  const mGeo = new THREE.BufferGeometry();
  const mPos = new Float32Array(MAXM * 3);
  const mSeed = [];
  const mRand = seededRand(99);
  for (let i = 0; i < MAXM; i++) {
    const a = mRand() * Math.PI * 2;
    const r = 3 + mRand() * (WORKSHOP_RADIUS + 3);
    mSeed.push({ a, r, y: mRand() * 6, sp: 0.25 + mRand() * 0.45, ph: mRand() * 10 });
    mPos[i * 3] = Math.cos(a) * r; mPos[i * 3 + 1] = mSeed[i].y; mPos[i * 3 + 2] = Math.sin(a) * r;
  }
  mGeo.setAttribute('position', new THREE.BufferAttribute(mPos, 3));
  const motes = new THREE.Points(mGeo, new THREE.PointsMaterial({
    size: 0.22, color: new THREE.Color(2.4, 1.5, 0.6), map: TEX.sprite, transparent: true,
    opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  motes.raycast = () => {};
  motes.frustumCulled = false;
  motes.visible = false;
  fxLayer.add(motes);

  function updateMotes(dt) {
    if (!motes.visible || motionOff()) return;
    const n = mGeo.drawRange.count;
    for (let i = 0; i < n; i++) {
      const m = mSeed[i];
      m.y += m.sp * dt;
      if (m.y > 7) m.y = 0.2;
      m.a += dt * 0.03;
      const wob = Math.sin(R.time * 0.9 + m.ph) * 0.35;
      mPos[i * 3] = Math.cos(m.a) * (m.r + wob);
      mPos[i * 3 + 1] = m.y;
      mPos[i * 3 + 2] = Math.sin(m.a) * (m.r + wob);
    }
    mGeo.attributes.position.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- */
  /* tween engine                                                      */
  /* ---------------------------------------------------------------- */
  function tween(dur, update, done) {
    return new Promise((resolve) => {
      R.tweens.add({ t: 0, dur: Math.max(dur, 0.001), update, done, resolve });
    });
  }

  function stepTweens(dt) {
    for (const tw of [...R.tweens]) {
      tw.t += dt;
      const k = Math.min(1, tw.t / tw.dur);
      tw.update(k);
      if (k >= 1) {
        R.tweens.delete(tw);
        if (tw.done) tw.done();
        tw.resolve();
      }
    }
  }

  /** Settle every running tween instantly into its end state. */
  function skip() {
    for (const tw of [...R.tweens]) {
      R.tweens.delete(tw);
      try {
        tw.update(1);
        if (tw.done) tw.done();
      } catch (e) { console.error('tween settle failed', e); }
      tw.resolve();
    }
    R.shake = 0;
  }

  function moveFloatAnim(view, fromPos, toPos, hop = 0.9) {
    const dur = R.reducedMotion ? 0.12 : 0.34;
    return tween(dur, (k) => {
      const e = easeInOut(k);
      view.group.position.set(
        fromPos.x + (toPos.x - fromPos.x) * e,
        (fromPos.y || 0) + ((toPos.y || 0) - (fromPos.y || 0)) * e
          + (R.reducedMotion ? 0 : Math.sin(k * Math.PI) * hop),
        fromPos.z + (toPos.z - fromPos.z) * e,
      );
    });
  }

  /* ---------------------------------------------------------------- */
  /* event playback                                                    */
   /* ---------------------------------------------------------------- */
  async function animateEvents(events, state) {
    for (const e of events) {
      if (e.t === 'roll') await animRoll(e, state);
      else if (e.t === 'move') await animMove(e, state);
      else if (e.t === 'deploy') animDeploy(e);
      else if (e.t === 'capture') await animCapture(e, state);
      else if (e.t === 'crown') await animCrown(e, state);
      else if (e.t === 'encore') burst(die.position, 0xfff0a8, 14, 2.4);
      else if (e.t === 'overkindled') { burst(die.position, 0x666677, 22, 1.8); R.shake = 0.25; }
      else if (e.t === 'gameover') {
        const w = state.players[e.winner];
        if (w) burst(new THREE.Vector3(0, 1.2, 0), playerColor(e.winner), 60, 4.5);
      }
    }
    syncState(state); // always land on the exact deterministic end state
  }

  function animRoll(e, state) {
    const p = diePos(state.ruleset, e.seat);
    die.position.set(p.x, p.y, p.z);
    die.visible = true;
    const target = new THREE.Quaternion().setFromEuler(DIE_ROT[e.value] || DIE_ROT[1]);
    const start = die.quaternion.clone();
    const spinAxis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const spins = R.reducedMotion ? 0 : Math.PI * (2 + Math.random() * 2);
    const tmp = new THREE.Quaternion();
    return tween(R.reducedMotion ? 0.18 : 0.7, (k) => {
      const e2 = easeOut(k);
      die.quaternion.slerpQuaternions(start, target, e2);
      tmp.setFromAxisAngle(spinAxis, (1 - e2) * spins);
      die.quaternion.premultiply(tmp);
      die.position.y = p.y + (R.reducedMotion ? 0 : Math.sin(k * Math.PI) * 1.1);
    }, () => { die.position.y = p.y; });
  }

  function animMove(e, state) {
    const view = R.floatViews.get(`${e.seat}:${e.floatId}`);
    if (!view) return Promise.resolve();
    const from = { ...view.group.position };
    // target from the pre-capture snapshot is resolved by the final syncState;
    // here we tween toward the moved float's landing cell.
    const pl = state.players[e.seat];
    const p = pl.floats[e.floatId];
    const to = floatPos(state.ruleset, e.seat, p < 0 ? e.floatId : p, 0, 1);
    return moveFloatAnim(view, from, to);
  }

  function animDeploy(e) {
    const view = R.floatViews.get(`${e.seat}:${e.floatId}`);
    if (!view || R.reducedMotion) return;
    const s0 = 0.4;
    view.group.scale.setScalar(s0);
    tween(0.25, (k) => view.group.scale.setScalar(s0 + (1 - s0) * easeOut(k)));
  }

  function animCapture(e, state) {
    const view = R.floatViews.get(`${e.seat}:${e.floatId}`);
    if (!view) return Promise.resolve();
    const from = { ...view.group.position };
    const to = floatPos(state.ruleset, e.seat, -1, e.floatId, 1);
    R.shake = Math.max(R.shake, R.reducedMotion ? 0 : 0.35);
    return moveFloatAnim(view, from, to, 1.6);
  }

  function animCrown(e, state) {
    const view = R.floatViews.get(`${e.seat}:${e.floatId}`);
    if (!view) return Promise.resolve();
    const from = { ...view.group.position };
    const to = floatPos(state.ruleset, e.seat, DONE, 0, 1);
    burst(new THREE.Vector3(to.x, to.y + 0.4, to.z), playerColor(e.seat), 24, 3);
    return moveFloatAnim(view, from, to, 1.4);
  }

  /* ---------------------------------------------------------------- */
  /* state reconciliation (idempotent)                                 */
  /* ---------------------------------------------------------------- */
  function syncState(state) {
    if (!state) return;
    const keyOf = JSON.stringify([state.ruleset.players, state.ruleset.floats, state.ruleset.safeTrack]);
    if (keyOf !== R.rulesetKey) {
      R.rulesetKey = keyOf;
      rebuildPlayerBoard(state);
    }
    R.state = state;

    const seen = new Set();
    for (const f of computePlacements(state)) {
      const id = `${f.seat}:${f.fid}`;
      seen.add(id);
      let view = R.floatViews.get(id);
      if (!view) {
        view = makeFloatView(f.seat, f.fid);
        R.floatViews.set(id, view);
      }
      if (!R.tweens.size) view.group.position.set(f.pos.x, f.pos.y, f.pos.z);
      const selected = R.selection && R.selection.seat === f.seat && R.selection.floatId === f.fid;
      view.ring.visible = !!selected;
      view.body.material = playerMats[f.seat];
      const targetY = f.pos.y;
      view.group.position.y = targetY + (selected ? 0.3 : 0);
    }
    for (const [id, view] of [...R.floatViews]) {
      if (!seen.has(id)) {
        floatsRoot.remove(view.group);
        R.floatViews.delete(id);
      }
    }

    // die mirrors the snapshot
    if (state.die != null && state.phase !== 'over') {
      const p = diePos(state.ruleset, state.turnIndex);
      die.position.set(p.x, p.y, p.z);
      if (!R.tweens.size) die.quaternion.setFromEuler(DIE_ROT[state.die] || DIE_ROT[1]);
      die.visible = true;
    } else {
      die.visible = false;
    }
    refreshHintRingColors(state);
  }

  function refreshHintRingColors(state) {
    hintRings.forEach((ring, i) => {
      const m = R.hintMoves[i];
      if (!m) { ring.visible = false; return; }
      ring.material.color.setHex(playerColor(state.turnIndex));
    });
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */
  function setTheme(themeDef) {
    if (!themeDef) return;
    R.theme = themeDef;
    scene.background = new THREE.Color(themeDef.sky);
    scene.fog = new THREE.Fog(themeDef.fog, 34, 78);
    M.ground.color.setHex(themeDef.ground);
    M.wood.color.setHex(themeDef.boardWood);
    M.trim.color.setHex(themeDef.boardTrim);
    M.tileA.color.setHex(themeDef.tileA);
    M.tileB.color.setHex(themeDef.tileB);
    M.lantern.color.setHex(themeDef.lantern);
    M.lantern.emissive.setHex(themeDef.lanternEmissive);
    pavilionLight.color.setHex(themeDef.lantern);
    skyMat.uniforms.uHorizon.value.setHex(themeDef.fog);
    skyMat.uniforms.uTop.value.setHex(themeDef.sky).multiplyScalar(0.45);
  }

  /* ---------------------------------------------------------------- */
  /* graphics settings (gfx.js model), applied live                    */
  /* ---------------------------------------------------------------- */
  const shadowMats = () => [
    M.ground, M.wood, M.trim, M.tileA, M.tileB, M.post, ...playerMats, ...playerLaneMats, ...dieMats,
  ];

  /** Apply saved graphics settings ({ preset, render_scale, <category>, ... }). */
  function setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === R.gfxJson) return; // unrelated settings changed
    R.gfxJson = json;
    const g = resolveGfx(saved || {}, R.detected);
    R.q = g;
    canvas.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxPreset = g.preset;

    // shadows
    const size = SHADOW_MAP[g.shadows];
    const wasOn = renderer.shadowMap.enabled;
    renderer.shadowMap.enabled = size > 0;
    key.castShadow = size > 0;
    if (size > 0 && key.shadow.mapSize.x !== size) {
      key.shadow.mapSize.set(size, size);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    if (wasOn !== size > 0) for (const m of shadowMats()) m.needsUpdate = true;

    // reflections (image-based lighting)
    scene.environment = g.reflections === 'on' ? environmentMap() : null;
    M.trim.metalness = g.reflections === 'on' ? 0.7 : 0.5;
    M.trim.roughness = g.reflections === 'on' ? 0.36 : 0.4;

    // surface detail: procedural textures, sky dome, festoon lights
    const detailed = g.detail === 'detailed';
    const setMap = (m, t) => { if (m.map !== t) { m.map = t; m.needsUpdate = true; } };
    setMap(M.tileA, detailed ? TEX.tile : null);
    setMap(M.tileB, detailed ? TEX.tile : null);
    setMap(M.wood, detailed ? TEX.wood : null);
    setMap(M.ground, detailed ? TEX.stone : null);
    sky.visible = detailed;
    festoon.visible = detailed;

    // particles + ambient motion
    mGeo.setDrawRange(0, g.ambience === 'animated' ? MOTES[g.particles] : 0);
    motes.visible = g.ambience === 'animated' && MOTES[g.particles] > 0;

    // adaptive resolution restarts; post chain rebuilds on the next frame
    R.adaptiveScale = 1;
    R.frames = [];
    R.postKey = null;
    R.postFailed = false;
    fpsVisible(g.showFps);
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers and cost. */
  function graphicsInfo() {
    const px = [Math.round(R.size[0] * R.pixelRatio), Math.round(R.size[1] * R.pixelRatio)];
    return {
      gpu: R.gpu || 'unknown GPU',
      detected: R.detected,
      resolved: R.q,
      summary: describeGfx(R.q, px),
      pixels: px,
      fps: Math.round(R.fps || 0),
      adaptiveScale: Math.round(R.adaptiveScale * 100) / 100,
      postFailed: !!R.postFailed,
    };
  }

  function fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  function postKey(w, h) {
    const g = R.q;
    return g.post ? [g.ao, g.bloom, g.grade, g.antialias, w, h, R.pixelRatio].join('|') : 'none';
  }

  function disposeComposer() {
    if (!R.composer) return;
    for (const pass of R.composer.passes) pass.dispose?.();
    R.composer.dispose();
    R.composer = null;
    R.gradePass = null;
  }

  function buildPost(w, h) {
    const g = R.q;
    disposeComposer();
    if (!g.post || R.postFailed) return;
    const pw = Math.max(1, Math.round(w * R.pixelRatio)), ph = Math.max(1, Math.round(h * R.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(renderer, target);
      composer.setPixelRatio(R.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(scene, camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(scene, camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        const hi = g.ao === 'high';
        ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1.0, samples: hi ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // high threshold: only lanterns, festoon bulbs and bright highlights bloom
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.4, 0.92));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') {
        R.gradePass = new ShaderPass(GradeShader);
        composer.addPass(R.gradePass);
      }
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      R.composer = composer;
    } catch {
      // post-processing is an enhancement: render directly (the panel says so)
      R.postFailed = true;
      disposeComposer();
    }
  }

  // Adaptive resolution: average ~90 frames; step down when slow, back up when fast.
  function adapt(dtMs) {
    const f = R.frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(1000 / avg)} fps · ${Math.round(R.pixelRatio * 100) / 100}×`;
    if (!R.q.adaptive) return false;
    const before = R.adaptiveScale;
    if (avg > 26) R.adaptiveScale = Math.max(0.6, R.adaptiveScale - 0.1);
    else if (avg < 14 && R.adaptiveScale < 1) R.adaptiveScale = Math.min(1, R.adaptiveScale + 0.05);
    return before !== R.adaptiveScale;
  }

  /** Legacy tier names (low/medium/high) map onto presets. */
  function setQuality(q) {
    setGraphics({ preset: q === 'medium' ? 'balanced' : q });
  }

  function setReducedMotion(b) {
    R.reducedMotion = !!b;
  }

  function setPalette(name) {
    R.palette = name === 'cvd' ? 'cvd' : 'standard';
    applyPalette();
  }

  function setMoveHints({ moves = [], canRoll = false, die: dieValue = null } = {}) {
    R.hintMoves = moves;
    R.hintRoll = !!canRoll;
    const state = R.state;
    hintRings.forEach((ring, i) => {
      const m = moves[i];
      if (!m || !state) { ring.visible = false; return; }
      const pos = floatPos(state.ruleset, state.turnIndex, m.to < 0 ? m.floatId : m.to, 0, 1);
      ring.position.set(pos.x, 0.14, pos.z);
      ring.material.color.setHex(playerColor(state.turnIndex));
      ring.visible = true;
    });
    if (dieValue != null && state) {
      const p = diePos(state.ruleset, state.turnIndex);
      die.position.set(p.x, p.y, p.z);
      die.quaternion.setFromEuler(DIE_ROT[dieValue] || DIE_ROT[1]);
      die.visible = true;
    }
  }

  function clearHints() {
    R.hintMoves = [];
    R.hintRoll = false;
    hintRings.forEach((ring) => { ring.visible = false; });
    die.scale.setScalar(1);
  }

  function setSelection(sel) {
    R.selection = sel;
    if (R.state) syncState(R.state);
  }

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    R.ray.setFromCamera(ndc, camera);
    const hits = R.ray.intersectObjects([floatsRoot, die, tilesA, tilesB], true);
    for (const h of hits) {
      const o = h.object;
      if (o === tilesA || o === tilesB) {
        const cell = o.userData.cells[h.instanceId];
        if (cell !== undefined) return { kind: 'cell', cell };
        continue;
      }
      let n = o;
      while (n && !n.userData.pick) n = n.parent;
      if (n && n.userData.pick) {
        if (n.userData.pick.kind === 'die' && !die.visible) continue;
        return n.userData.pick;
      }
    }
    return null;
  }

  function projectToScreen(pos) {
    const rect = canvas.getBoundingClientRect();
    const v = new THREE.Vector3(pos.x, pos.y ?? 0, pos.z).project(camera);
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
      visible: v.z > -1 && v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05,
    };
  }

  // Scale the authored view so the whole board (ring, approach lanes and
  // workshops, plus float height) projects inside the canvas with a margin
  // for the top HUD and bottom tray, at any aspect ratio.
  function fitScale(view) {
    const probe = new THREE.PerspectiveCamera(camera.fov, camera.aspect || 1, 0.1, 400);
    const pts = [];
    const r = WORKSHOP_RADIUS + 1.2;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      pts.push(new THREE.Vector3(Math.cos(a) * r, 1.6, Math.sin(a) * r));
    }
    const yMax = 0.72, yMin = -0.82, xLim = 0.94; // top HUD / bottom tray bands
    const v = new THREE.Vector3();
    let k = 1;
    for (let i = 0; i < 12; i++) {
      probe.position.set(Math.sin(R.camTarget.az) * view.dist * k, view.height * k, -Math.cos(R.camTarget.az) * view.dist * k);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld();
      probe.updateProjectionMatrix();
      let over = 0;
      for (const p of pts) {
        v.copy(p).project(probe);
        over = Math.max(over, Math.abs(v.x) / xLim, v.y / yMax, -v.y / -yMin);
      }
      if (over <= 1) break;
      k *= Math.min(1.5, over + 0.01);
    }
    return k;
  }

  function setCameraMode(mode) {
    if (!CAMERA_VIEWS[mode]) mode = 'auto';
    R.cam.mode = mode;
    const v = CAMERA_VIEWS[mode];
    const k = fitScale(v);
    R.camTarget.dist = v.dist * k;
    R.camTarget.height = v.height * k;
    if (R.reducedMotion) { R.cam.dist = R.camTarget.dist; R.cam.height = R.camTarget.height; }
  }

  function resetCamera() {
    R.camTarget.az = 0;
    setCameraMode(R.cam.mode);
    if (R.reducedMotion) { R.cam.az = 0; }
  }

  /** Pointer-drag camera orbit (delta in CSS px). */
  function orbit(dx, dy) {
    R.camTarget.az += dx * 0.005;
    // pitch stays between a readable low angle and top-down; distance is kept
    // at the fitted value so the board never leaves the frame
    const minH = Math.max(6, R.camTarget.dist * 0.35), maxH = Math.max(minH + 1, R.camTarget.dist * 1.6);
    R.camTarget.height = Math.min(maxH, Math.max(minH, R.camTarget.height - dy * 0.04));
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    R.size = [w, h];
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    setCameraMode(R.cam.mode || 'auto'); // refit for the new aspect
  }

  function stats() {
    return {
      drawCalls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      fps: Math.round(R.fps),
    };
  }

  function dispose() {
    if (R.disposed) return;
    R.disposed = true;
    cancelAnimationFrame(R.raf);
    skip();
    disposeComposer();
    envTex?.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (m.map) m.map.dispose();
        m.dispose();
      }
    });
    renderer.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* frame loop (pauses when the document is hidden)                   */
  /* ---------------------------------------------------------------- */
  function updateCamera(dt) {
    const k = R.reducedMotion ? 1 : Math.min(1, dt * 6);
    R.cam.az += (R.camTarget.az - R.cam.az) * k;
    R.cam.dist += (R.camTarget.dist - R.cam.dist) * k;
    R.cam.height += (R.camTarget.height - R.cam.height) * k;
    let sx = 0, sz = 0;
    if (R.shake > 0) {
      R.shake = Math.max(0, R.shake - dt);
      sx = (Math.random() - 0.5) * R.shake * 0.5;
      sz = (Math.random() - 0.5) * R.shake * 0.5;
    }
    camera.position.set(
      Math.sin(R.cam.az) * R.cam.dist + sx,
      R.cam.height,
      -Math.cos(R.cam.az) * R.cam.dist + sz,
    );
    camera.lookAt(0, 0, 0);
    // fog tracks the fitted distance so a far-fitted (portrait) camera never
    // fogs the board itself out
    if (scene.fog) {
      const camLen = Math.hypot(R.cam.dist, R.cam.height);
      scene.fog.near = camLen + WORKSHOP_RADIUS * 0.6;
      scene.fog.far = camLen + WORKSHOP_RADIUS * 3.2;
    }
  }

  function loop(t) {
    if (R.disposed) return;
    R.raf = requestAnimationFrame(loop);
    if (document.hidden) { R.lastT = t; return; } // paused while backgrounded
    const dt = Math.min(0.05, R.lastT ? (t - R.lastT) / 1000 : 0.016);
    const rawMs = R.lastT ? Math.min(250, t - R.lastT) : 16;
    R.lastT = t;
    if (dt > 0) R.fps = R.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;
    const still = motionOff();
    const animated = R.q.ambience === 'animated' && !still;
    if (animated) R.time += dt;

    stepTweens(dt);
    updateParticles(dt);
    updateMotes(dt);
    updateCamera(dt);

    // hint pulse + selection bob
    if (R.hintRoll && die.visible && !R.reducedMotion) {
      die.scale.setScalar(1 + Math.sin(t / 220) * 0.07);
    }
    hintRings.forEach((ring, i) => {
      if (ring.visible && !R.reducedMotion) ring.scale.setScalar(1 + Math.sin(t / 260 + i) * 0.08);
    });
    if (animated) {
      // gentle lantern shimmer and sway
      pavilionLight.intensity = 30 + Math.sin(R.time * 1.1) * 3 + Math.sin(R.time * 3.7) * 1.2;
      M.lantern.emissiveIntensity = 1.6 + Math.sin(R.time * 2.3) * 0.12 + Math.sin(R.time * 5.1) * 0.06;
      for (const lamp of lanternLamps) {
        lamp.position.y = lamp.userData.baseY + Math.sin(R.time * 1.4 + lamp.userData.phase) * 0.04;
      }
      skyMat.uniforms.uTime.value = R.time;
    } else {
      pavilionLight.intensity = 30;
      M.lantern.emissiveIntensity = 1.6;
    }

    // pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale
    const rescale = adapt(rawMs);
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, R.q.dprCap) * R.q.scale * R.adaptiveScale;
    if (w !== R.size[0] || h !== R.size[1] || ratio !== R.pixelRatio || rescale) {
      R.pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
      if (w !== R.size[0] || h !== R.size[1]) resize();
      else renderer.setSize(w, h, false);
    }
    const pk = postKey(w, h);
    if (pk !== R.postKey) {
      R.postKey = pk;
      buildPost(w, h);
    }
    if (R.composer) {
      try {
        R.composer.render(dt);
      } catch {
        R.postFailed = true;
        disposeComposer();
        renderer.render(scene, camera);
      }
    } else {
      renderer.render(scene, camera);
    }
    if (!R.ready) {
      R.ready = true;
      if (opts.onReady) opts.onReady();
    }
  }

  // init
  setTheme(R.theme || {
    sky: 0x141026, fog: 0x1a1430, ground: 0x241c3a, boardWood: 0x5a3b2a,
    boardTrim: 0xc9973f, tileA: 0x3a2c50, tileB: 0x443456,
    lantern: 0xffb347, lanternEmissive: 0xff9a2e,
  });
  applyPalette();
  setGraphics(opts.graphics || {});
  window.addEventListener('resize', resize);
  resize();
  R.raf = requestAnimationFrame(loop);

  return {
    setTheme, setQuality, setGraphics, graphicsInfo, setReducedMotion, setPalette,
    syncState, animateEvents, skip,
    setMoveHints, clearHints, setSelection,
    pick, projectToScreen,
    setCameraMode, resetCamera, orbit,
    resize, dispose, stats,
  };
}
