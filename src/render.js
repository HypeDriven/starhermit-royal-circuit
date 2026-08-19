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
import {
  TRACK_LEN, DONE, SAFE_CELLS, PLAYER_DEFS, startCell,
} from './rules.js';
import {
  RING_RADIUS, TILE_SIZE, WORKSHOP_RADIUS, circuitPos, floatPos, diePos,
  cellAngle,
} from './boardlayout.js';

/* Okabe–Ito color-blind-safe player palette (blue/gold separation). */
const CVD_COLORS = [0x0072b2, 0xe69f00, 0x56b4e9, 0xcc79a7];

const QUALITY = {
  low: { dpr: 1, shadow: 0, particles: 40 },
  medium: { dpr: 1.5, shadow: 1024, particles: 90 },
  high: { dpr: 2, shadow: 2048, particles: 160 },
};

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

  const R = {
    canvas, renderer, scene, camera,
    theme: opts.theme || null,
    reducedMotion: !!opts.reducedMotion,
    quality: QUALITY[opts.quality] ? opts.quality : 'medium',
    palette: opts.palette === 'cvd' ? 'cvd' : 'standard',
    state: null,
    rulesetKey: '',
    tweens: new Set(),
    ready: false,
    disposed: false,
    fps: 60,
    lastT: 0,
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

  /* ---------------------------------------------------------------- */
  /* materials + shared geometry                                       */
  /* ---------------------------------------------------------------- */
  const M = {
    ground: new THREE.MeshStandardMaterial({ color: 0x241c3a, roughness: 0.95 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5a3b2a, roughness: 0.8 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xc9973f, roughness: 0.4, metalness: 0.5 }),
    tileA: new THREE.MeshStandardMaterial({ color: 0x3a2c50, roughness: 0.85 }),
    tileB: new THREE.MeshStandardMaterial({ color: 0x443456, roughness: 0.85 }),
    lantern: new THREE.MeshStandardMaterial({
      color: 0xffb347, emissive: 0xff9a2e, emissiveIntensity: 1.6, roughness: 0.5,
    }),
    post: new THREE.MeshStandardMaterial({ color: 0x2c2033, roughness: 0.9 }),
    die: new THREE.MeshStandardMaterial({ color: 0xf5efe2, roughness: 0.35 }),
    ghost: new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
    }),
  };
  const playerMats = PLAYER_DEFS.map((d) => new THREE.MeshStandardMaterial({
    color: d.color, roughness: 0.45, metalness: 0.1, emissive: d.color, emissiveIntensity: 0.12,
  }));
  const playerLaneMats = PLAYER_DEFS.map((d) => new THREE.MeshStandardMaterial({
    color: d.color, roughness: 0.7, transparent: true, opacity: 0.85,
  }));

  const G = {
    tile: new THREE.BoxGeometry(TILE_SIZE, 0.22, 1.7),
    step: new THREE.BoxGeometry(1.15, 0.16, 1.15),
    pad: new THREE.BoxGeometry(2.9, 0.18, 2.9),
    dais: new THREE.CylinderGeometry(2.3, 2.6, 0.55, 24),
    pillar: new THREE.CylinderGeometry(0.14, 0.14, 2.6, 8),
    roof: new THREE.ConeGeometry(3.1, 1.6, 8),
    lanternBall: new THREE.SphereGeometry(0.3, 12, 10),
    lanternPost: new THREE.CylinderGeometry(0.06, 0.06, 1.5, 6),
    ring: new THREE.RingGeometry(0.5, 0.78, 32),
    float: {
      round: new THREE.SphereGeometry(0.44, 18, 14),
      square: new THREE.BoxGeometry(0.72, 0.72, 0.72),
      tri: new THREE.ConeGeometry(0.5, 0.95, 3),
      hex: new THREE.CylinderGeometry(0.46, 0.46, 0.55, 6),
    },
    floatBase: new THREE.CylinderGeometry(0.52, 0.58, 0.14, 16),
    die: new THREE.BoxGeometry(0.9, 0.9, 0.9),
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
  key.shadow.camera.left = key.shadow.camera.bottom = -18;
  key.shadow.camera.right = key.shadow.camera.top = 18;
  key.shadow.bias = -0.0004;
  const pavilionLight = new THREE.PointLight(0xffb347, 30, 26, 1.8);
  pavilionLight.position.set(0, 4.2, 0);
  envLayer.add(hemi, key, pavilionLight);

  // ground + board base
  const ground = new THREE.Mesh(new THREE.CircleGeometry(30, 48), M.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.32;
  ground.receiveShadow = true;
  const boardBase = new THREE.Mesh(
    new THREE.CylinderGeometry(WORKSHOP_RADIUS + 2.2, WORKSHOP_RADIUS + 2.6, 0.5, 48), M.wood);
  boardBase.position.y = -0.26;
  boardBase.receiveShadow = true;
  const ringTrim = new THREE.Mesh(new THREE.TorusGeometry(RING_RADIUS, 1.05, 8, 64), M.trim);
  ringTrim.rotation.x = Math.PI / 2;
  ringTrim.position.y = -0.08;
  envLayer.add(ground, boardBase, ringTrim);

  // circuit tiles: two instanced meshes (alternating colors)
  const cellsA = [], cellsB = [];
  for (let c = 0; c < TRACK_LEN; c++) (c % 2 === 0 ? cellsA : cellsB).push(c);
  function buildTileMesh(cells, mat) {
    const mesh = new THREE.InstancedMesh(G.tile, mat, cells.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    cells.forEach((cell, i) => {
      const p = circuitPos(cell, -0.11);
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

  // lantern posts on safe cells
  for (const cell of SAFE_CELLS) {
    const p = circuitPos(cell);
    const post = new THREE.Mesh(G.lanternPost, M.post);
    post.position.set(p.x, 0.75, p.z);
    const lamp = new THREE.Mesh(G.lanternBall, M.lantern);
    lamp.position.set(p.x, 1.62, p.z);
    post.castShadow = true;
    envLayer.add(post, lamp);
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
  envLayer.add(crownLamp);

  // decorative perimeter lantern posts (instanced)
  {
    const n = 12;
    const posts = new THREE.InstancedMesh(G.lanternPost, M.post, n);
    const lamps = new THREE.InstancedMesh(G.lanternBall, M.lantern, n);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.PI / 12;
      const r = WORKSHOP_RADIUS + 4.6;
      const s = 1.6;
      m4.makeTranslation(Math.cos(a) * r, 1.2, Math.sin(a) * r);
      posts.setMatrixAt(i, m4);
      m4.makeTranslation(Math.cos(a) * r, 2.1 * s * 0.75, Math.sin(a) * r);
      lamps.setMatrixAt(i, m4);
    }
    envLayer.add(posts, lamps);
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
    (v) => new THREE.MeshStandardMaterial({ map: pipTexture(v), roughness: 0.35 }));
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
  const MAXP = QUALITY.high.particles;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(MAXP * 3);
  const pCol = new Float32Array(MAXP * 3);
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const particles = new THREE.Points(pGeo, new THREE.PointsMaterial({
    size: 0.2, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false,
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
    const cap = QUALITY[R.quality].particles;
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
  }

  function setQuality(q) {
    if (!QUALITY[q]) return;
    R.quality = q;
    const def = QUALITY[q];
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, def.dpr));
    renderer.shadowMap.enabled = def.shadow > 0;
    key.castShadow = def.shadow > 0;
    if (def.shadow > 0) key.shadow.mapSize.set(def.shadow, def.shadow);
    if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    resize();
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

  function setCameraMode(mode) {
    if (!CAMERA_VIEWS[mode]) mode = 'auto';
    R.cam.mode = mode;
    const v = CAMERA_VIEWS[mode];
    R.camTarget.dist = v.dist;
    R.camTarget.height = v.height;
    if (R.reducedMotion) { R.cam.dist = v.dist; R.cam.height = v.height; }
  }

  function resetCamera() {
    R.camTarget.az = 0;
    setCameraMode(R.cam.mode);
    if (R.reducedMotion) { R.cam.az = 0; }
  }

  /** Pointer-drag camera orbit (delta in CSS px). */
  function orbit(dx, dy) {
    R.camTarget.az += dx * 0.005;
    R.camTarget.height = Math.min(34, Math.max(4, R.camTarget.height - dy * 0.04));
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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
  }

  function loop(t) {
    if (R.disposed) return;
    R.raf = requestAnimationFrame(loop);
    if (document.hidden) { R.lastT = t; return; } // paused while backgrounded
    const dt = Math.min(0.05, R.lastT ? (t - R.lastT) / 1000 : 0.016);
    R.lastT = t;
    if (dt > 0) R.fps = R.fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

    stepTweens(dt);
    updateParticles(dt);
    updateCamera(dt);

    // hint pulse + selection bob
    if (R.hintRoll && die.visible && !R.reducedMotion) {
      die.scale.setScalar(1 + Math.sin(t / 220) * 0.07);
    }
    hintRings.forEach((ring, i) => {
      if (ring.visible && !R.reducedMotion) ring.scale.setScalar(1 + Math.sin(t / 260 + i) * 0.08);
    });
    pavilionLight.intensity = 30 + Math.sin(t / 900) * 4;

    renderer.render(scene, camera);
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
  setQuality(R.quality);
  window.addEventListener('resize', resize);
  resize();
  R.raf = requestAnimationFrame(loop);

  return {
    setTheme, setQuality, setReducedMotion, setPalette,
    syncState, animateEvents, skip,
    setMoveHints, clearHints, setSelection,
    pick, projectToScreen,
    setCameraMode, resetCamera, orbit,
    resize, dispose, stats,
  };
}
