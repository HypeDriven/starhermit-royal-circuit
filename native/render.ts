// The lantern-lit pavilion on starhermit:scene, as the browser build's
// src/render.js drew it with three.js r160: the shared 40-tile circuit
// (two instanced tile meshes in alternating lacquer), the gold rims, the
// lantern posts with their gold inlay rings on the safe tiles, the central
// pavilion (dais, pillars, roof, crown lamp), the twelve perimeter lanterns
// with the festoon string lights between them, the per-seat workshop pads,
// start rings and coloured approach steps, the floats (base, body in the
// seat's shape, lamp top, selection ring), the die with its pip faces, the
// legal-move hint rings, the burst particles and the drifting lantern
// embers, under the starry sky dome. Presentation only: every view
// reconciles from the rules snapshot (syncState); animateEvents plays the
// events (die tumble, hops, captures, crowns, bursts, shake) and always lands
// on the exact end state; skip() settles at once.
//
// Port notes:
// - three.js r160 (physically based lights): colours and intensities as
//   written (engine.minor 29 follows three r155+ light units).
// - render.js passed the renderer to RoomEnvironment (r160 → the
//   900-candela room) and set scene.environment; in the engine the
//   scene environment ignores per-material envMapIntensity, so every lit
//   material carries the environment as its own envMap at its old intensity.
// - The old composer (RenderPass in half floats → GTAO → UnrealBloom 0.42 /
//   0.4 / 0.92 → OutputPass with ACES at exposure 1.12 → the display-space
//   grade + vignette → SMAA / FXAA) is the runtime's renderer.ao / bloom /
//   grade / antialias; Low draws straight to the canvas with MSAA.
// - The sky dome's GLSL is WGSL; the procedural canvases are OffscreenCanvas
//   (starhermit:canvas) with the same drawing.
// - The key light keeps render.js's fitted orthographic shadow box, bias and
//   normalBias; bloom strength is squared for r185's UnrealBloomPass.
// - Tweens advance on the runtime's fixed steps (step()), so the event
//   playback, and with it every AI turn's pacing, is the same on every
//   machine and in play scripts.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Euler, Fog, Group, HemisphereLight, InstancedMesh, LineBasicMaterial,
  LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera,
  PMREMGenerator, PointLight, Points, PointsMaterial, Quaternion, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace,
  ShaderMaterial, SphereGeometry, TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Object3D, type OrthographicCamera, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { Layout, Rules, type GameEvent, type Move, type State, type Theme } from "./game.ts";
import { MOTE_MAX, PARTICLE_MAX, moteCount, particleCap, type Look } from "./quality.ts";

const { RING_RADIUS, TILE_SIZE, WORKSHOP_RADIUS } = Layout;
const { TRACK_LEN, DONE, SAFE_CELLS, PLAYER_DEFS } = Rules;
/** Okabe–Ito colour-blind-safe player palette (blue/gold separation). */
const CVD_COLORS = [0x0072b2, 0xe69f00, 0x56b4e9, 0xcc79a7];
const PI = Math.PI;
type Pos = { x: number; y: number; z: number };
export interface Hit { kind: "float" | "die" | "cell"; seat?: number; floatId?: number; cell?: number }

// ---------------------------------------------------------------- procedural textures (render.js, same drawing)
type Ctx = OffscreenCanvasRenderingContext2D;
function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** `size` is the authored canvas size the drawing uses; `px` the preset's texture budget it is drawn into. */
function canvasTex(size: number, paint: (g: Ctx, n: number) => void, { repeat = 1, px = size } = {}): CanvasTexture {
  const c = new OffscreenCanvas(px, px);
  const g = c.getContext("2d")! as Ctx;
  g.scale(px / size, px / size);
  paint(g, size);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}
/** Lacquered tile: bright field, darker bevel edge and a fine gold-line inlay. */
function tileTexture(px: number): CanvasTexture {
  return canvasTex(128, (g, n) => {
    const rnd = seededRand(7);
    g.fillStyle = "#d8d4de";
    g.fillRect(0, 0, n, n);
    for (let i = 0; i < 700; i++) {
      const v = 205 + Math.floor(rnd() * 40);
      g.fillStyle = `rgba(${v},${v},${v + 6},0.35)`;
      g.fillRect(rnd() * n, rnd() * n, 2, 2);
    }
    const grd = g.createLinearGradient(0, 0, 0, n);
    grd.addColorStop(0, "rgba(255,255,255,0.18)");
    grd.addColorStop(1, "rgba(0,0,0,0.12)");
    g.fillStyle = grd;
    g.fillRect(0, 0, n, n);
    g.strokeStyle = "rgba(40,30,50,0.55)";
    g.lineWidth = 8;
    g.strokeRect(4, 4, n - 8, n - 8);
    g.strokeStyle = "rgba(255,236,190,0.75)";
    g.lineWidth = 2;
    g.strokeRect(14, 14, n - 28, n - 28);
  }, { px });
}
function woodTexture(px: number): CanvasTexture {
  return canvasTex(256, (g, n) => {
    const rnd = seededRand(11);
    g.fillStyle = "#d9cfc6";
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
  }, { repeat: 3, px });
}
/** Plaza flagstones for the pavilion floor. */
function stoneTexture(px: number): CanvasTexture {
  return canvasTex(256, (g, n) => {
    const rnd = seededRand(23);
    g.fillStyle = "#8f8a98";
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
  }, { repeat: 9, px });
}
/** Soft round sprite for particles and embers. */
function spriteTexture(): CanvasTexture {
  return canvasTex(64, (g, n) => {
    const grd = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.8)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.fillRect(0, 0, n, n);
  });
}
/** One die face: pips on bone. */
function pipTexture(value: number): CanvasTexture {
  const c = new OffscreenCanvas(128, 128);
  const g = c.getContext("2d")! as Ctx;
  g.fillStyle = "#f5efe2";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#33240f";
  const spots: Record<number, number[][]> = {
    1: [[0.5, 0.5]],
    2: [[0.28, 0.28], [0.72, 0.72]],
    3: [[0.26, 0.26], [0.5, 0.5], [0.74, 0.74]],
    4: [[0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7]],
    5: [[0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72]],
    6: [[0.3, 0.26], [0.7, 0.26], [0.3, 0.5], [0.7, 0.5], [0.3, 0.74], [0.7, 0.74]],
  };
  for (const [x, y] of spots[value]!) {
    g.beginPath();
    g.arc(x! * 128, y! * 128, 13, 0, PI * 2);
    g.fill();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
// Textures are cached by kind and size: a quality change reuses what it already painted.
const texCache = new Map<string, CanvasTexture>();
function cachedTex(key: string, make: () => CanvasTexture): CanvasTexture {
  let t = texCache.get(key);
  if (!t) { t = make(); texCache.set(key, t); }
  return t;
}

// ---------------------------------------------------------------- sky dome (render.js skyMat, in WGSL)
const skyUniforms = {
  uTop: { value: new Color(0x07060f) },
  uHorizon: { value: new Color(0x1a1430) },
  uTime: { value: 0 },
};
const SKY_FRAGMENT = `
fn hash3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn fragment(f: Fragment) -> vec4f {
  let dir = normalize(f.world);
  let h = clamp(dir.y, 0.0, 1.0);
  var c = mix(uniforms.uHorizon, uniforms.uTop, pow(h, 0.55));
  let cell = floor(dir * 180.0);
  let s = hash3(cell);
  let tw = 0.65 + 0.35 * sin(uniforms.uTime * 1.3 + s * 40.0);
  c = c + vec3f(1.0, 0.95, 0.85) * step(0.9965, s) * smoothstep(0.08, 0.4, h) * tw * 0.9;
  return vec4f(c, 1.0);
}`;

// ---------------------------------------------------------------- camera and lights
const CAMERA_VIEWS: Record<string, { dist: number; height: number }> = {
  auto: { dist: 21, height: 16 },
  top: { dist: 2, height: 36 },
  low: { dist: 23, height: 7 },
};
const camera = new PerspectiveCamera(42, 1, 0.1, 200);
const raycaster = new Raycaster();
const ndc = new Vector2();
const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// one dominant key (shadow caster), soft hemisphere fill, warm pavilion point (r160 intensities)
const hemi = new HemisphereLight(0x8880b0, 0x1a1426, 0.55);
const key = new DirectionalLight(0xfff1d6, 1.35);
key.position.set(14, 24, 10);
// shadow frustum fitted to the board + perimeter lanterns (radius ~19), as render.js
{
  const SHADOW_R = WORKSHOP_RADIUS + 5.4;
  const cam = key.shadow.camera as OrthographicCamera;
  cam.left = -SHADOW_R; cam.right = SHADOW_R; cam.top = SHADOW_R; cam.bottom = -SHADOW_R; cam.near = 8; cam.far = 62;
  cam.updateProjectionMatrix();
}
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
const pavilionLight = new PointLight(0xffb347, 30, 26, 1.8);
pavilionLight.position.set(0, 4.2, 0);
scene.add(hemi, key, key.target);

// ---------------------------------------------------------------- state
let look: Look | null = null;
let theme: Theme | null = null;
let palette: "standard" | "cvd" = "standard";
let reducedMotion = false;
let envTex: Texture | null = null;
let root: Group | null = null;
let disposables: { dispose(): void }[] = [];
let time = 0;
let ambientTime = 0;
let shake = 0;
let lastState: State | null = null;
let rulesetKey = "";
let selection: { seat: number; floatId: number } | null = null;
let hintMoves: Move[] = [];
let hintRoll = false;
let win = { w: 0, h: 0 };
let fitKey = "";
const cam = { az: 0, dist: CAMERA_VIEWS.auto!.dist, height: CAMERA_VIEWS.auto!.height, mode: "auto" };
const camTarget = { az: 0, dist: cam.dist, height: cam.height };

interface FloatView { group: Group; body: Mesh; ring: Mesh; seat: number; floatId: number }
interface Tween { t: number; dur: number; update: (k: number) => void; done?: () => void; resolve: () => void }
const tweens = new Set<Tween>();
const floatViews = new Map<string, FloatView>();

// Scene objects rebuilt with the look (null until build()).
let M: Record<string, Material> = {};
let playerMats: Material[] = [];
let playerLaneMats: Material[] = [];
let dieMats: Material[] = [];
let G: Record<string, BufferGeometry> = {};
let floatGeos: Record<string, BufferGeometry> = {};
let sky: Mesh | null = null;
let festoon: Group | null = null;
let tilesA: InstancedMesh | null = null, tilesB: InstancedMesh | null = null;
let lanternLamps: Mesh[] = [];
let playerBoard: Group | null = null;
let floatsRoot: Group | null = null;
let die: Mesh | null = null;
let hintRings: Mesh[] = [];
let particles: Points | null = null, pGeo: BufferGeometry | null = null;
let motes: Points | null = null, mGeo: BufferGeometry | null = null;
const pPos = new Float32Array(PARTICLE_MAX * 3);
const pCol = new Float32Array(PARTICLE_MAX * 3);
let pLive: { i: number; vx: number; vy: number; vz: number; life: number }[] = [];
let pFree: number[] = [];
const mPos = new Float32Array(MOTE_MAX * 3);
const mSeed: { a: number; r: number; y: number; sp: number; ph: number }[] = [];
{
  const mRand = seededRand(99);
  for (let i = 0; i < MOTE_MAX; i++) {
    const a = mRand() * PI * 2;
    const r = 3 + mRand() * (WORKSHOP_RADIUS + 3);
    mSeed.push({ a, r, y: mRand() * 6, sp: 0.25 + mRand() * 0.45, ph: mRand() * 10 });
  }
}
// rotation bringing each value's face to the top (+y); BoxGeometry material order: +x, -x, +y, -y, +z, -z
const DIE_ROT: Record<number, Euler> = {
  1: new Euler(0, 0, 0),
  6: new Euler(PI, 0, 0),
  3: new Euler(0, 0, PI / 2),
  4: new Euler(0, 0, -PI / 2),
  2: new Euler(-PI / 2, 0, 0),
  5: new Euler(PI / 2, 0, 0),
};

function track<T extends { dispose(): void }>(o: T): T { disposables.push(o); return o; }

function environmentTexture(): Texture | null {
  if (!envTex) {
    try {
      const pm = new PMREMGenerator(renderer);
      envTex = pm.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      pm.dispose();
    } catch (e) { console.warn(`environment: ${String(e)}`); }
  }
  return envTex;
}

interface Surface {
  color: number; roughness?: number; metalness?: number; clearcoat?: number; clearcoatRoughness?: number; envMapIntensity?: number;
  emissive?: number; emissiveIntensity?: number; map?: Texture | null; transparent?: boolean; opacity?: number;
}
/**
 * render.js shadeAs: the preset budget's shading for a lit surface — Lambert (Low), Standard (Balanced) or
 * Physical (High, Ultra); clear-coated surfaces step down, plain Standard ones become Lambert on Low only.
 */
function surface(p: Surface, authored: "standard" | "physical"): Material {
  const tier = look!.budget.material;
  const want = Math.min(tier === "lambert" ? 0 : tier === "standard" ? 1 : 2, authored === "physical" ? 2 : 1);
  const base: Record<string, unknown> = { color: p.color };
  if (p.emissive !== undefined) { base.emissive = p.emissive; base.emissiveIntensity = p.emissiveIntensity ?? 1; }
  if (p.map) base.map = p.map;
  if (p.transparent) { base.transparent = true; base.opacity = p.opacity ?? 1; }
  if (want === 0) return track(new MeshLambertMaterial(base));
  const env = look!.reflections ? environmentTexture() : null;
  const pbr: Record<string, unknown> = { ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0 };
  if (env) { pbr.envMap = env; pbr.envMapIntensity = p.envMapIntensity ?? 1; }
  if (want === 1) return track(new MeshStandardMaterial(pbr));
  return track(new MeshPhysicalMaterial({ ...pbr, clearcoat: p.clearcoat ?? 0, clearcoatRoughness: p.clearcoatRoughness ?? 0 }));
}

function playerColor(seat: number): number { return palette === "cvd" ? CVD_COLORS[seat]! : PLAYER_DEFS[seat]!.color; }

// ---------------------------------------------------------------- build
/** Builds the whole pavilion for the current look, theme and palette (render.js createRenderer + applyBudget). */
function build(): void {
  if (!look || !theme) return;
  skip();
  if (root) scene.remove(root);
  for (const d of disposables) { try { d.dispose(); } catch { /* gone */ } }
  disposables = [];
  floatViews.clear();
  rulesetKey = "";
  root = new Group();
  scene.add(root);
  const th = theme;
  const b = look.budget;
  const detailed = look.detailed;
  const tex = {
    tile: cachedTex(`tile${b.texture / 2}`, () => tileTexture(b.texture / 2)),
    wood: cachedTex(`wood${b.texture}`, () => woodTexture(b.texture)),
    stone: cachedTex(`stone${b.texture}`, () => stoneTexture(b.texture)),
    sprite: cachedTex("sprite", spriteTexture),
  };
  const refl = look.reflections;
  M = {
    ground: surface({ color: th.ground, roughness: 0.92, envMapIntensity: 0.04, map: detailed ? tex.stone : null }, "standard"),
    wood: surface({ color: th.boardWood, roughness: 0.72, envMapIntensity: 0.1, map: detailed ? tex.wood : null }, "standard"),
    trim: surface({ color: th.boardTrim, roughness: refl ? 0.36 : 0.4, metalness: refl ? 0.7 : 0.5, envMapIntensity: 0.4 }, "standard"),
    tileA: surface({ color: th.tileA, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.1, map: detailed ? tex.tile : null }, "physical"),
    tileB: surface({ color: th.tileB, roughness: 0.62, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 0.1, map: detailed ? tex.tile : null }, "physical"),
    lantern: surface({ color: th.lantern, emissive: th.lanternEmissive, emissiveIntensity: 1.6, roughness: 0.5 }, "standard"),
    post: surface({ color: 0x2c2033, roughness: 0.8, envMapIntensity: 0.1 }, "standard"),
    ghost: track(new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false })),
    bulbs: track(new MeshBasicMaterial({ color: 0xffffff })),
    wire: track(new LineBasicMaterial({ color: 0x1a1420, transparent: true, opacity: 0.8 })),
  };
  playerMats = [0, 1, 2, 3].map((s) => surface({
    color: playerColor(s), roughness: 0.4, metalness: 0.1, emissive: playerColor(s), emissiveIntensity: 0.12,
    clearcoat: 0.5, clearcoatRoughness: 0.4, envMapIntensity: 0.22,
  }, "physical"));
  playerLaneMats = [0, 1, 2, 3].map((s) => surface({ color: playerColor(s), roughness: 0.55, transparent: true, opacity: 0.88, envMapIntensity: 0.12 }, "standard"));
  dieMats = [3, 4, 1, 6, 2, 5].map((v) => surface({
    color: 0xffffff, map: cachedTex(`pip${v}`, () => pipTexture(v)), roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.2, envMapIntensity: 0.25,
  }, "physical"));

  // curved geometry at the preset's segment share (k × the authored segment counts)
  const k = b.segments;
  const seg = (n: number, min = 3): number => Math.max(min, Math.round(n * k));
  G = {
    sky: track(new SphereGeometry(95, seg(32, 12), seg(16, 8))),
    rimIn: track(new TorusGeometry(RING_RADIUS - 0.95, 0.11, seg(8, 4), seg(96, 24))),
    rimOut: track(new TorusGeometry(RING_RADIUS + 0.95, 0.11, seg(8, 4), seg(96, 24))),
    rimEdge: track(new TorusGeometry(WORKSHOP_RADIUS + 2.2, 0.11, seg(8, 4), seg(96, 24))),
    dais: track(new CylinderGeometry(2.3, 2.6, 0.55, seg(32, 12))),
    lanternBall: track(new SphereGeometry(0.3, seg(14, 8), seg(12, 6))),
    ring: track(new RingGeometry(0.5, 0.78, seg(32, 12))),
    safeInlay: track(new RingGeometry(0.46, 0.56, seg(28, 12))),
    floatBase: track(new CylinderGeometry(0.52, 0.58, 0.14, seg(20, 8))),
    ground: track(new CircleGeometry(30, seg(64, 24))),
    boardBase: track(new CylinderGeometry(WORKSHOP_RADIUS + 2.2, WORKSHOP_RADIUS + 2.6, 0.5, seg(72, 24))),
    tile: track(new BoxGeometry(TILE_SIZE, 0.24, 1.7)),
    step: track(new BoxGeometry(1.15, 0.16, 1.15)),
    pad: track(new BoxGeometry(2.9, 0.18, 2.9)),
    pillar: track(new CylinderGeometry(0.14, 0.14, 2.6, 10)),
    roof: track(new ConeGeometry(3.1, 1.6, 8)),
    lanternPost: track(new CylinderGeometry(0.06, 0.06, 1.5, 6)),
    die: track(new BoxGeometry(0.9, 0.9, 0.9)),
    bulb: track(new SphereGeometry(0.075, 8, 6)),
  };
  floatGeos = {
    round: track(new SphereGeometry(0.44, seg(24, 10), seg(18, 8))),
    square: track(new BoxGeometry(0.72, 0.72, 0.72)),
    tri: track(new ConeGeometry(0.5, 0.95, 3)),
    hex: track(new CylinderGeometry(0.46, 0.46, 0.55, 6)),
  };

  const envLayer = new Group(), gameLayer = new Group(), ghostLayer = new Group(), fxLayer = new Group();
  root.add(envLayer, gameLayer, ghostLayer, fxLayer);
  envLayer.add(pavilionLight);

  // sky dome: theme gradient + faint stars (detailed only; plain uses the flat background)
  const skyMat = track(new ShaderMaterial({ uniforms: skyUniforms, fragmentShader: SKY_FRAGMENT, side: BackSide, depthWrite: false, fog: false }));
  sky = new Mesh(G.sky!, skyMat);
  sky.renderOrder = -1;
  sky.frustumCulled = false;
  sky.noAO = true;
  sky.visible = detailed;
  envLayer.add(sky);

  // ground + board base + gold rims framing the circuit
  const ground = new Mesh(G.ground!, M.ground!);
  ground.rotation.x = -PI / 2;
  ground.position.y = -0.32;
  ground.receiveShadow = true;
  const boardBase = new Mesh(G.boardBase!, M.wood!);
  boardBase.position.y = -0.26;
  boardBase.receiveShadow = true;
  for (const g of [G.rimIn!, G.rimOut!, G.rimEdge!]) {
    const rim = new Mesh(g, M.trim!);
    rim.rotation.x = PI / 2;
    rim.receiveShadow = true;
    envLayer.add(rim);
  }
  envLayer.add(ground, boardBase);

  // circuit tiles: two instanced meshes (alternating colours)
  const cellsA: number[] = [], cellsB: number[] = [];
  for (let c = 0; c < TRACK_LEN; c++) (c % 2 === 0 ? cellsA : cellsB).push(c);
  const buildTiles = (cells: number[], mat: Material): InstancedMesh => {
    const mesh = new InstancedMesh(G.tile!, mat, cells.length);
    const m4 = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), one = new Vector3(1, 1, 1);
    cells.forEach((cell, i) => {
      const p = Layout.circuitPos(cell, -0.1);
      q.setFromAxisAngle(up, -p.angle + PI / 2);
      m4.compose(new Vector3(p.x, p.y, p.z), q, one);
      mesh.setMatrixAt(i, m4);
    });
    mesh.receiveShadow = true;
    mesh.userData.cells = cells;
    gameLayer.add(mesh);
    return mesh;
  };
  tilesA = buildTiles(cellsA, M.tileA!);
  tilesB = buildTiles(cellsB, M.tileB!);

  // lantern posts on safe cells, with a gold inlay ring on the tile
  lanternLamps = [];
  for (const cell of SAFE_CELLS) {
    const p = Layout.circuitPos(cell);
    const post = new Mesh(G.lanternPost!, M.post!);
    post.position.set(p.x, 0.75, p.z);
    post.castShadow = true;
    const lamp = new Mesh(G.lanternBall!, M.lantern!);
    lamp.position.set(p.x, 1.62, p.z);
    lamp.scale.set(1, 1.2, 1);
    lamp.userData.baseY = 1.62;
    lamp.userData.phase = cell * 0.7;
    lanternLamps.push(lamp);
    const inlay = new Mesh(G.safeInlay!, M.trim!);
    inlay.rotation.x = -PI / 2;
    inlay.position.set(p.x, 0.035, p.z);
    envLayer.add(post, lamp, inlay);
  }

  // centre pavilion: dais + pillars + roof + crown lamp
  const dais = new Mesh(G.dais!, M.trim!);
  dais.position.y = 0.27;
  dais.receiveShadow = true;
  envLayer.add(dais);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * PI * 2 + PI / 4;
    const pillar = new Mesh(G.pillar!, M.wood!);
    pillar.position.set(Math.cos(a) * 2.4, 1.85, Math.sin(a) * 2.4);
    pillar.castShadow = true;
    envLayer.add(pillar);
  }
  const roof = new Mesh(G.roof!, M.trim!);
  roof.position.y = 3.9;
  roof.castShadow = true;
  envLayer.add(roof);
  const crownLamp = new Mesh(G.lanternBall!, M.lantern!);
  crownLamp.position.y = 3.1;
  crownLamp.scale.set(1, 1.2, 1);
  envLayer.add(crownLamp);

  // decorative perimeter lantern posts (instanced) + festoon string lights
  const PERIM_N = 12, PERIM_R = WORKSHOP_RADIUS + 4.6;
  const perimAngle = (i: number): number => (i / PERIM_N) * PI * 2 + PI / 12;
  {
    const posts = new InstancedMesh(G.lanternPost!, M.post!, PERIM_N);
    const lamps = new InstancedMesh(G.lanternBall!, M.lantern!, PERIM_N);
    const m4 = new Matrix4();
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
  festoon = new Group();
  {
    const PER = 9; // bulbs per span
    const bulbs = new InstancedMesh(G.bulb!, M.bulbs!, PERIM_N * PER);
    const pal = [[3.2, 2.2, 1.0], [3.0, 0.9, 0.7], [1.0, 2.6, 2.2], [3.0, 1.3, 2.2], [2.8, 2.6, 1.2]].map(([r, g, bb]) => new Color(r!, g!, bb!));
    const wirePts: Vector3[] = [];
    const m4 = new Matrix4();
    let n = 0;
    for (let i = 0; i < PERIM_N; i++) {
      const a0 = perimAngle(i), a1 = perimAngle(i + 1);
      const p0 = new Vector3(Math.cos(a0) * PERIM_R, 2.5, Math.sin(a0) * PERIM_R);
      const p1 = new Vector3(Math.cos(a1) * PERIM_R, 2.5, Math.sin(a1) * PERIM_R);
      const segs = 16;
      for (let s = 0; s < segs; s++) {
        const t = s / segs, t2 = (s + 1) / segs;
        const v = p0.clone().lerp(p1, t); v.y -= Math.sin(t * PI) * 0.7;
        const w = p0.clone().lerp(p1, t2); w.y -= Math.sin(t2 * PI) * 0.7;
        wirePts.push(v, w);
      }
      for (let bi = 0; bi < PER; bi++) {
        const t = (bi + 0.5) / PER;
        const v = p0.clone().lerp(p1, t);
        v.y -= Math.sin(t * PI) * 0.7 + 0.1;
        m4.makeTranslation(v.x, v.y, v.z);
        bulbs.setMatrixAt(n, m4);
        bulbs.setColorAt(n, pal[n % pal.length]!);
        n++;
      }
    }
    const wire = new LineSegments(track(new BufferGeometry().setFromPoints(wirePts)), M.wire as LineBasicMaterial);
    wire.noAO = true;
    bulbs.noAO = true;
    festoon.add(wire, bulbs);
    festoon.visible = detailed;
    envLayer.add(festoon);
  }

  // player-dependent board pieces, rebuilt when the ruleset shape changes
  playerBoard = new Group();
  gameLayer.add(playerBoard);
  floatsRoot = new Group();
  gameLayer.add(floatsRoot);

  // die
  const dieMesh = new Mesh(G.die!, dieMats) as unknown as Mesh;
  dieMesh.castShadow = true;
  dieMesh.visible = false;
  gameLayer.add(dieMesh);
  die = dieMesh;

  // hint rings (ghost layer)
  hintRings = [];
  for (let i = 0; i < 4; i++) {
    const ring = new Mesh(G.ring!, track((M.ghost as MeshBasicMaterial).clone()));
    ring.rotation.x = -PI / 2;
    ring.visible = false;
    ring.noAO = true;
    ghostLayer.add(ring);
    hintRings.push(ring);
  }

  // particle pool (never raycast)
  pGeo = track(new BufferGeometry());
  pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
  pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
  pLive = [];
  pFree = [];
  for (let i = PARTICLE_MAX - 1; i >= 0; i--) { pFree.push(i); pPos[i * 3 + 1] = -999; }
  particles = new Points(pGeo, track(new PointsMaterial({
    size: 0.26, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, map: tex.sprite, alphaTest: 0.02,
  })));
  particles.frustumCulled = false;
  particles.noAO = true;
  fxLayer.add(particles);

  // ambient lantern embers drifting up around the circuit (additive)
  for (let i = 0; i < MOTE_MAX; i++) {
    const m = mSeed[i]!;
    mPos[i * 3] = Math.cos(m.a) * m.r; mPos[i * 3 + 1] = m.y; mPos[i * 3 + 2] = Math.sin(m.a) * m.r;
  }
  mGeo = track(new BufferGeometry());
  mGeo.setAttribute("position", new BufferAttribute(mPos, 3));
  mGeo.setDrawRange(0, moteCount(look));
  motes = new Points(mGeo, track(new PointsMaterial({
    size: 0.22, color: new Color(2.4, 1.5, 0.6), map: tex.sprite, transparent: true, opacity: 0.8, depthWrite: false, blending: AdditiveBlending,
  })));
  motes.frustumCulled = false;
  motes.noAO = true;
  motes.visible = moteCount(look) > 0;
  fxLayer.add(motes);

  applyThemeColors();
  if (lastState) syncState(lastState);
}

function rebuildPlayerBoard(state: State): void {
  if (!playerBoard) return;
  while (playerBoard.children.length) playerBoard.remove(playerBoard.children[playerBoard.children.length - 1]!);
  const rs = state.ruleset;
  for (let seat = 0; seat < rs.players; seat++) {
    const a = Layout.cellAngle(Rules.startCell(rs, seat));
    const pad = new Mesh(G.pad!, M.wood!);
    pad.position.set(Math.cos(a) * WORKSHOP_RADIUS, -0.09, Math.sin(a) * WORKSHOP_RADIUS);
    pad.receiveShadow = true;
    const padTrim = new Mesh(G.step!, playerLaneMats[seat]!);
    padTrim.scale.set(2.2, 0.4, 2.2);
    padTrim.position.set(Math.cos(a) * WORKSHOP_RADIUS, 0.02, Math.sin(a) * WORKSHOP_RADIUS);
    playerBoard.add(pad, padTrim);
    const sp = Layout.circuitPos(Rules.startCell(rs, seat), 0.06);
    const marker = new Mesh(G.ring!, playerLaneMats[seat]!);
    marker.rotation.x = -PI / 2;
    marker.position.set(sp.x, sp.y, sp.z);
    playerBoard.add(marker);
    for (let s = 0; s < 4; s++) {
      const r = RING_RADIUS - 1.5 * (s + 1);
      const step = new Mesh(G.step!, playerLaneMats[seat]!);
      step.position.set(Math.cos(a) * r, -0.05, Math.sin(a) * r);
      step.receiveShadow = true;
      playerBoard.add(step);
    }
  }
}

function makeFloatView(seat: number, floatId: number): FloatView {
  const def = PLAYER_DEFS[seat]!;
  const group = new Group();
  const base = new Mesh(G.floatBase!, M.trim!);
  base.position.y = 0.07;
  const body = new Mesh(floatGeos[def.shape] || floatGeos.round!, playerMats[seat]!);
  body.position.y = def.shape === "round" ? 0.58 : 0.55;
  body.castShadow = true;
  const lampTop = new Mesh(G.lanternBall!, M.lantern!);
  lampTop.scale.setScalar(0.45);
  lampTop.position.y = 1.12;
  const ring = new Mesh(G.ring!, track((M.ghost as MeshBasicMaterial).clone()));
  ring.rotation.x = -PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  ring.noAO = true;
  group.add(base, body, lampTop, ring);
  group.userData.pick = { kind: "float", seat, floatId };
  floatsRoot!.add(group);
  return { group, body, ring, seat, floatId };
}

/** World placement of every float, with deterministic stack fanning (render.js computePlacements). */
function computePlacements(state: State): { seat: number; fid: number; p: number; pos: Pos }[] {
  const groups = new Map<string, { seat: number; fid: number; p: number }[]>();
  state.players.forEach((pl, seat) => {
    pl.floats.forEach((p, fid) => {
      let k: string;
      if (p < 0) k = `w${seat}:${fid}`;
      else if (p < TRACK_LEN) k = `c${(Rules.startCell(state.ruleset, seat) + p) % TRACK_LEN}`;
      else if (p < DONE) k = `a${seat}:${p}`;
      else k = `k${seat}:${fid}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push({ seat, fid, p });
    });
  });
  const out: { seat: number; fid: number; p: number; pos: Pos }[] = [];
  for (const arr of groups.values()) {
    arr.sort((x, y) => x.seat - y.seat || x.fid - y.fid);
    arr.forEach((f, i) => {
      let pos: Pos;
      if (f.p < 0) pos = Layout.floatPos(state.ruleset, f.seat, f.p, f.fid, 1);
      else if (f.p >= DONE) {
        const base = Layout.floatPos(state.ruleset, f.seat, f.p, i, arr.length);
        const fa = (f.fid / Math.max(1, state.ruleset.floats)) * PI * 2;
        pos = { x: base.x + Math.cos(fa) * 0.42, y: base.y, z: base.z + Math.sin(fa) * 0.42 };
      } else pos = Layout.floatPos(state.ruleset, f.seat, f.p, i, arr.length);
      out.push({ ...f, pos });
    });
  }
  return out;
}

// ---------------------------------------------------------------- particles
function burst(pos: Pos, colorHex: number, n = 18, speed = 3.2): void {
  if (reducedMotion || !look || !pGeo) return;
  const col = new Color(colorHex);
  const cap = particleCap(look);
  for (let k = 0; k < n && pFree.length; k++) {
    const i = pFree.pop()!;
    if (i >= cap) continue;
    const a = Math.random() * PI * 2;
    const up = Math.random() * 0.9 + 0.35;
    pLive.push({ i, vx: Math.cos(a) * speed * Math.random(), vy: up * speed, vz: Math.sin(a) * speed * Math.random(), life: 0.9 + Math.random() * 0.5 });
    pPos[i * 3] = pos.x; pPos[i * 3 + 1] = pos.y + 0.3; pPos[i * 3 + 2] = pos.z;
    pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
  }
  pGeo.getAttribute("position")!.needsUpdate = true;
  pGeo.getAttribute("color")!.needsUpdate = true;
}
function updateParticles(dt: number): void {
  if (!pLive.length || !pGeo) return;
  for (let k = pLive.length - 1; k >= 0; k--) {
    const p = pLive[k]!;
    p.life -= dt;
    if (p.life <= 0) {
      pPos[p.i * 3 + 1] = -999;
      pFree.push(p.i);
      pLive.splice(k, 1);
      continue;
    }
    p.vy -= 7 * dt;
    pPos[p.i * 3] += p.vx * dt;
    pPos[p.i * 3 + 1] = Math.max(0.05, pPos[p.i * 3 + 1]! + p.vy * dt);
    pPos[p.i * 3 + 2] += p.vz * dt;
  }
  pGeo.getAttribute("position")!.needsUpdate = true;
}
function updateMotes(dt: number): void {
  if (!motes || !mGeo || !motes.visible || reducedMotion) return;
  const n = look ? moteCount(look) : 0;
  for (let i = 0; i < n; i++) {
    const m = mSeed[i]!;
    m.y += m.sp * dt;
    if (m.y > 7) m.y = 0.2;
    m.a += dt * 0.03;
    const wob = Math.sin(ambientTime * 0.9 + m.ph) * 0.35;
    mPos[i * 3] = Math.cos(m.a) * (m.r + wob);
    mPos[i * 3 + 1] = m.y;
    mPos[i * 3 + 2] = Math.sin(m.a) * (m.r + wob);
  }
  mGeo.getAttribute("position")!.needsUpdate = true;
}

// ---------------------------------------------------------------- tweens (advanced on fixed steps)
function tween(dur: number, update: (k: number) => void, done?: () => void): Promise<void> {
  return new Promise((resolve) => { tweens.add({ t: 0, dur: Math.max(dur, 0.001), update, done, resolve }); });
}
/** One fixed step of the event playback (1/60 s). */
export function step(dt: number): void {
  for (const tw of [...tweens]) {
    tw.t += dt;
    const k = Math.min(1, tw.t / tw.dur);
    tw.update(k);
    if (k >= 1) {
      tweens.delete(tw);
      tw.done?.();
      tw.resolve();
    }
  }
  updateParticles(dt);
}
/** Settle every running tween instantly into its end state. */
export function skip(): void {
  for (const tw of [...tweens]) {
    tweens.delete(tw);
    try { tw.update(1); tw.done?.(); } catch (e) { console.warn(`tween settle failed: ${String(e)}`); }
    tw.resolve();
  }
  shake = 0;
}
export function busy(): boolean { return tweens.size > 0; }

function moveFloatAnim(view: FloatView, from: Pos, to: Pos, hop = 0.9): Promise<void> {
  const dur = reducedMotion ? 0.12 : 0.34;
  return tween(dur, (k) => {
    const e = easeInOut(k);
    view.group.position.set(
      from.x + (to.x - from.x) * e,
      (from.y || 0) + ((to.y || 0) - (from.y || 0)) * e + (reducedMotion ? 0 : Math.sin(k * PI) * hop),
      from.z + (to.z - from.z) * e,
    );
  });
}
const posOf = (o: Object3D): Pos => ({ x: o.position.x, y: o.position.y, z: o.position.z });

// ---------------------------------------------------------------- event playback
/** Plays the events, then lands on the exact deterministic end state. */
export async function animateEvents(events: GameEvent[], state: State): Promise<void> {
  for (const e of events) {
    if (e.t === "roll") await animRoll(e, state);
    else if (e.t === "move") await animMove(e, state);
    else if (e.t === "deploy") animDeploy(e);
    else if (e.t === "capture") await animCapture(e, state);
    else if (e.t === "crown") await animCrown(e, state);
    else if (e.t === "encore" && die) burst(posOf(die), 0xfff0a8, 14, 2.4);
    else if (e.t === "overkindled" && die) { burst(posOf(die), 0x666677, 22, 1.8); shake = 0.25; }
    else if (e.t === "gameover" && e.winner != null && state.players[e.winner]) burst({ x: 0, y: 1.2, z: 0 }, playerColor(e.winner), 60, 4.5);
  }
  syncState(state);
}
function animRoll(e: GameEvent, state: State): Promise<void> {
  if (!die) return Promise.resolve();
  const d = die;
  const p = Layout.diePos(state.ruleset, e.seat ?? 0);
  d.position.set(p.x, p.y, p.z);
  d.visible = true;
  const target = new Quaternion().setFromEuler(DIE_ROT[e.value ?? 1] || DIE_ROT[1]!);
  const start = d.quaternion.clone();
  const axis = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
  const spins = reducedMotion ? 0 : PI * (2 + Math.random() * 2);
  const tmp = new Quaternion();
  return tween(reducedMotion ? 0.18 : 0.7, (k) => {
    const e2 = easeOut(k);
    d.quaternion.slerpQuaternions(start, target, e2);
    tmp.setFromAxisAngle(axis, (1 - e2) * spins);
    d.quaternion.premultiply(tmp);
    d.position.y = p.y + (reducedMotion ? 0 : Math.sin(k * PI) * 1.1);
  }, () => { d.position.y = p.y; });
}
function animMove(e: GameEvent, state: State): Promise<void> {
  const view = floatViews.get(`${e.seat}:${e.floatId}`);
  if (!view) return Promise.resolve();
  const p = state.players[e.seat!]!.floats[e.floatId!]!;
  const to = Layout.floatPos(state.ruleset, e.seat!, p < 0 ? e.floatId! : p, 0, 1);
  return moveFloatAnim(view, posOf(view.group), to);
}
function animDeploy(e: GameEvent): void {
  const view = floatViews.get(`${e.seat}:${e.floatId}`);
  if (!view || reducedMotion) return;
  const s0 = 0.4;
  view.group.scale.setScalar(s0);
  void tween(0.25, (k) => view.group.scale.setScalar(s0 + (1 - s0) * easeOut(k)));
}
function animCapture(e: GameEvent, state: State): Promise<void> {
  const view = floatViews.get(`${e.seat}:${e.floatId}`);
  if (!view) return Promise.resolve();
  const to = Layout.floatPos(state.ruleset, e.seat!, -1, e.floatId!, 1);
  shake = Math.max(shake, reducedMotion ? 0 : 0.35);
  return moveFloatAnim(view, posOf(view.group), to, 1.6);
}
function animCrown(e: GameEvent, state: State): Promise<void> {
  const view = floatViews.get(`${e.seat}:${e.floatId}`);
  if (!view) return Promise.resolve();
  const to = Layout.floatPos(state.ruleset, e.seat!, DONE, 0, 1);
  burst({ x: to.x, y: to.y + 0.4, z: to.z }, playerColor(e.seat!), 24, 3);
  return moveFloatAnim(view, posOf(view.group), to, 1.4);
}

// ---------------------------------------------------------------- state reconciliation (idempotent)
export function syncState(state: State | null): void {
  if (!state) return;
  lastState = state;
  if (!root) return;
  const k = JSON.stringify([state.ruleset.players, state.ruleset.floats, state.ruleset.safeTrack]);
  if (k !== rulesetKey) { rulesetKey = k; rebuildPlayerBoard(state); }
  const seen = new Set<string>();
  for (const f of computePlacements(state)) {
    const id = `${f.seat}:${f.fid}`;
    seen.add(id);
    let view = floatViews.get(id);
    if (!view) { view = makeFloatView(f.seat, f.fid); floatViews.set(id, view); }
    if (!tweens.size) view.group.position.set(f.pos.x, f.pos.y, f.pos.z);
    const selected = !!selection && selection.seat === f.seat && selection.floatId === f.fid;
    view.ring.visible = selected;
    view.body.material = playerMats[f.seat]!;
    view.group.position.y = f.pos.y + (selected ? 0.3 : 0);
  }
  for (const [id, view] of [...floatViews]) {
    if (!seen.has(id)) { floatsRoot?.remove(view.group); floatViews.delete(id); }
  }
  if (die) {
    if (state.die != null && state.phase !== "over") {
      const p = Layout.diePos(state.ruleset, state.turnIndex);
      die.position.set(p.x, p.y, p.z);
      if (!tweens.size) die.quaternion.setFromEuler(DIE_ROT[state.die] || DIE_ROT[1]!);
      die.visible = true;
    } else die.visible = false;
  }
  hintRings.forEach((ring, i) => {
    if (!hintMoves[i]) { ring.visible = false; return; }
    (ring.material as MeshBasicMaterial).color.setHex(playerColor(state.turnIndex));
  });
}

// ---------------------------------------------------------------- public settings
function applyThemeColors(): void {
  const th = theme;
  if (!th) return;
  scene.background = new Color(th.sky);
  if (!scene.fog) scene.fog = new Fog(th.fog, 34, 78);
  else scene.fog.color.setHex(th.fog);
  pavilionLight.color.setHex(th.lantern);
  skyUniforms.uHorizon.value.setHex(th.fog);
  skyUniforms.uTop.value.setHex(th.sky).multiplyScalar(0.45);
}
/** The visual theme (content.js THEMES): board, lanterns, sky and fog colours. */
export function setTheme(next: Theme): void {
  if (theme && theme.id === next.id) return;
  theme = next;
  build();
}
/** The look for the runtime's quality tier (native/quality.ts). */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  // UnrealBloomPass(0.42, 0.4, 0.92): only lanterns, festoon bulbs and bright highlights bloom.
  // r160 page: its UnrealBloomPass exactly (model "r160", strength as written).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.42, radius: 0.4, threshold: 0.92, resolution: next.budget.bloomRes } : null;
  // GTAOPass: radius 0.9, distance exponent 1.5, thickness 1.5, 16 / 8 samples and the denoise per tier; blend 0.75.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.9, distanceExponent: 1.5, thickness: 1.5, scale: 1,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader after OutputPass (display space): a 0.22 smoothstep S-curve (contrastCurve "s"),
  // saturation 1.1, cool shadows / warm highlights by a smoothstep of luma from 0.25 to 0.85, a 0.26
  // vignette from 0.38 to 0.9 (x stretched 1.1) and the s * 0.98 + 0.015 lift (levels).
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.22, saturation: 1.1, split: [0.25, 0.85], shadows: [0.97, 0.98, 1.04], highlights: [1.04, 1.0, 0.95],
    levels: [0.98, 0.015],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  build();
}
export function setPalette(name: "standard" | "cvd"): void {
  if (name === palette) return;
  palette = name;
  build();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setMoveHints(moves: Move[], canRoll: boolean, dieValue: number | null): void {
  hintMoves = moves;
  hintRoll = canRoll;
  const state = lastState;
  hintRings.forEach((ring, i) => {
    const m = moves[i];
    if (!m || !state) { ring.visible = false; return; }
    const pos = Layout.floatPos(state.ruleset, state.turnIndex, m.to < 0 ? m.floatId : m.to, 0, 1);
    ring.position.set(pos.x, 0.14, pos.z);
    (ring.material as MeshBasicMaterial).color.setHex(playerColor(state.turnIndex));
    ring.visible = true;
  });
  if (dieValue != null && state && die) {
    const p = Layout.diePos(state.ruleset, state.turnIndex);
    die.position.set(p.x, p.y, p.z);
    die.quaternion.setFromEuler(DIE_ROT[dieValue] || DIE_ROT[1]!);
    die.visible = true;
  }
}
export function clearHints(): void {
  hintMoves = [];
  hintRoll = false;
  for (const ring of hintRings) ring.visible = false;
  die?.scale.setScalar(1);
}
export function setSelection(sel: { seat: number; floatId: number } | null): void {
  if (selection?.seat === sel?.seat && selection?.floatId === sel?.floatId) return;
  selection = sel;
  if (lastState) syncState(lastState);
}
export function playerColorOf(seat: number): number { return playerColor(seat); }

/** What is under a window point: a float, the die or a circuit tile. */
export function pick(x: number, y: number): Hit | null {
  if (!floatsRoot || !die || !tilesA || !tilesB) return null;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects([floatsRoot, die, tilesA, tilesB], true);
  for (const h of hits) {
    const o = h.object;
    if (o === tilesA || o === tilesB) {
      const cell = (o.userData.cells as number[])[h.instanceId ?? -1];
      if (cell !== undefined) return { kind: "cell", cell };
      continue;
    }
    let n: Object3D | null = o;
    while (n && !n.userData.pick) n = n.parent;
    if (n && n.userData.pick) {
      const pk = n.userData.pick as Hit;
      if (pk.kind === "die" && !die.visible) continue;
      return pk;
    }
    if (o === die && die.visible) return { kind: "die" };
  }
  return null;
}
/** A world point in window pixels, and whether it is in front of the camera and on screen. */
export function projectToScreen(pos: Pos): { x: number; y: number; visible: boolean } {
  const v = new Vector3(pos.x, pos.y ?? 0, pos.z).project(camera);
  return {
    x: ((v.x + 1) / 2) * win.w,
    y: ((1 - v.y) / 2) * win.h,
    visible: v.z > -1 && v.z < 1 && v.x > -1.05 && v.x < 1.05 && v.y > -1.05 && v.y < 1.05,
  };
}

// ---------------------------------------------------------------- camera
/** Scales the authored view so the whole board projects inside the window with the HUD and tray bands free. */
function fitScale(view: { dist: number; height: number }): number {
  const probe = new PerspectiveCamera(camera.fov, camera.aspect || 1, 0.1, 400);
  const pts: Vector3[] = [];
  const r = WORKSHOP_RADIUS + 1.2;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * PI * 2;
    pts.push(new Vector3(Math.cos(a) * r, 0, Math.sin(a) * r), new Vector3(Math.cos(a) * r, 1.6, Math.sin(a) * r));
  }
  const yMax = 0.72, yMin = -0.82, xLim = 0.94;
  const v = new Vector3();
  let k = 1;
  for (let i = 0; i < 12; i++) {
    probe.position.set(Math.sin(camTarget.az) * view.dist * k, view.height * k, -Math.cos(camTarget.az) * view.dist * k);
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
export function setCameraMode(mode: string): void {
  if (!CAMERA_VIEWS[mode]) mode = "auto";
  cam.mode = mode;
  const v = CAMERA_VIEWS[mode]!;
  const k = fitScale(v);
  camTarget.dist = v.dist * k;
  camTarget.height = v.height * k;
  if (reducedMotion) { cam.dist = camTarget.dist; cam.height = camTarget.height; }
}
export function resetCamera(): void {
  camTarget.az = 0;
  setCameraMode(cam.mode);
  if (reducedMotion) cam.az = 0;
}
/** Pointer-drag orbit (delta in logical px). */
export function orbit(dx: number, dy: number): void {
  camTarget.az += dx * 0.005;
  const minH = Math.max(6, camTarget.dist * 0.35), maxH = Math.max(minH + 1, camTarget.dist * 1.6);
  camTarget.height = Math.min(maxH, Math.max(minH, camTarget.height - dy * 0.04));
}
export function setActive(on: boolean): void { renderer.camera = on ? camera : null; }

function updateCamera(dt: number): void {
  const k = reducedMotion ? 1 : Math.min(1, dt * 6);
  cam.az += (camTarget.az - cam.az) * k;
  cam.dist += (camTarget.dist - cam.dist) * k;
  cam.height += (camTarget.height - cam.height) * k;
  let sx = 0, sz = 0;
  if (shake > 0) {
    shake = Math.max(0, shake - dt);
    sx = (Math.random() - 0.5) * shake * 0.5;
    sz = (Math.random() - 0.5) * shake * 0.5;
  }
  camera.position.set(Math.sin(cam.az) * cam.dist + sx, cam.height, -Math.cos(cam.az) * cam.dist + sz);
  camera.lookAt(0, 0, 0);
  // fog tracks the fitted distance so a far-fitted (portrait) camera never fogs the board itself out
  if (scene.fog && scene.fog instanceof Fog) {
    const camLen = Math.hypot(cam.dist, cam.height);
    scene.fog.near = camLen + WORKSHOP_RADIUS * 0.6;
    scene.fog.far = camLen + WORKSHOP_RADIUS * 3.2;
  }
}

/** Each frame: the window size (refits the camera), camera smoothing, ambience, hint pulses. */
export function update(dt: number, w: number, h: number): void {
  dt = Math.min(0.05, Math.max(0, dt));
  time += dt;
  if (w > 0 && h > 0) {
    const fk = `${w}x${h}`;
    if (fk !== fitKey) {
      fitKey = fk;
      win = { w, h };
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      setCameraMode(cam.mode);
      if (!time || time < 0.1) { cam.dist = camTarget.dist; cam.height = camTarget.height; }
    }
  }
  const animated = !!look && look.animated && !reducedMotion;
  if (animated) ambientTime += dt;
  updateMotes(dt);
  updateCamera(dt);
  if (die && hintRoll && die.visible && !reducedMotion) die.scale.setScalar(1 + Math.sin((time * 1000) / 220) * 0.07);
  hintRings.forEach((ring, i) => { if (ring.visible && !reducedMotion) ring.scale.setScalar(1 + Math.sin((time * 1000) / 260 + i) * 0.08); });
  const lantern = M.lantern as MeshStandardMaterial | undefined;
  if (animated) {
    pavilionLight.intensity = (30 + Math.sin(ambientTime * 1.1) * 3 + Math.sin(ambientTime * 3.7) * 1.2);
    if (lantern) lantern.emissiveIntensity = 1.6 + Math.sin(ambientTime * 2.3) * 0.12 + Math.sin(ambientTime * 5.1) * 0.06;
    for (const lamp of lanternLamps) lamp.position.y = (lamp.userData.baseY as number) + Math.sin(ambientTime * 1.4 + (lamp.userData.phase as number)) * 0.04;
    skyUniforms.uTime.value = ambientTime;
  } else {
    pavilionLight.intensity = 30;
    if (lantern) lantern.emissiveIntensity = 1.6;
  }
}
