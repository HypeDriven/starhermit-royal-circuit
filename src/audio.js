/**
 * audio.js — procedural WebAudio engine with optional authored samples.
 *
 * Every sound is synthesized from oscillators, one shared noise buffer,
 * biquad filters and gain envelopes. If sfx/<name>.opus clips exist, each
 * mapped event prefers its clip (lazy-fetched and decoded on first play);
 * synthesis remains the fallback while clips load or are missing.
 * * The graph is:
 *
 *   voice -> envelope/filter -> stem or bus gain -> master -> destination
 *
 * Buses: music, effects, ambience, voice. Music is an adaptive loop of
 * layered stems (pad / pluck / drum / bell) that share one chord loop so
 * mood changes are seamless gain crossfades. All timing is scheduled on
 * ctx.currentTime through a lookahead scheduler — never per-note timers —
 * so patterns cannot drift. Cosmetic pitch/variant randomness draws from
 * seeded rng.js streams keyed `name:tick`, so replaying the same event
 * sequence reproduces the same sounds.
 *
 * Every entry point is a safe no-op while the context is locked
 * (pre-gesture), suspended, or disposed. Nothing here ever throws.
 */

import { createStream, nextFloat, nextInt, nextRange, pick } from './rng.js';

/** Short caption per event, for the captions accessibility feature. */
export const EVENT_CAPTIONS = {
  ui: 'soft paper tick',
  select: 'wooden tok',
  error: 'muted error thud',
  roll: 'die rattle',
  move: 'wooden steps',
  deploy: 'match strike and warm chime',
  capture: 'dramatic drum hit',
  crown: 'bright bell arpeggio',
  encore: 'rising sparkle',
  overkindled: 'sad slide and poof',
  pass: 'soft breath whoosh',
  turn: 'gentle paper slide',
  win: 'festival fanfare',
  lose: 'gentle minor cadence',
  hint: 'soft high ping',
  undo: 'reverse-tape slide',
};

const BUSES = ['music', 'effects', 'ambience', 'voice'];

/**
 * Optional authored one-shot samples (sfx/<basename>.opus), one per logical
 * event. Clips are lazy-fetched and decoded after the user-gesture unlock,
 * on the first play of their event. While a clip is loading — or if fetch/
 * decode fails or the file simply isn't there — the procedural SFX below
 * stays the fallback, so audio works with zero assets present.
 */
const EVENT_SAMPLES = {
  ui: 'paper-tick',
  select: 'wooden-tok',
  error: 'error-thud',
  roll: 'die-rattle',
  move: 'wooden-steps',
  deploy: 'match-chime',
  capture: 'taiko-hit',
  crown: 'bell-arpeggio',
  encore: 'sparkle-rise',
  overkindled: 'fizzle-poof',
  pass: 'breath-whoosh',
  turn: 'paper-slide',
  win: 'festival-fanfare',
  lose: 'minor-cadence',
  hint: 'soft-ping',
  undo: 'reverse-slide',
};

// ---------------------------------------------------------------------------
// Music theory data (C major pentatonic, shared by every mood)
// ---------------------------------------------------------------------------

const BPM = 76;
const BEAT = 60 / BPM;               // ~0.79s
const STEPS_PER_BAR = 8;             // 8th-note scheduler grid
const BARS_PER_LOOP = 4;
const LOOP_STEPS = STEPS_PER_BAR * BARS_PER_LOOP; // 32 steps ~= 12.6s loop
const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// One warm chord loop under all moods: C - Am - F - G.
const CHORDS = [
  [48, 55, 64], // C
  [45, 52, 60], // Am
  [41, 48, 57], // F
  [43, 50, 59], // G
];
const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79]; // A3..G5 pentatonic

// Per-mood stem levels and pattern switches. Stems crossfade, chords persist.
const MOODS = {
  off:     { pad: 0,    pluck: 0,    drum: 0,    bell: 0,    density: 0,    drumFast: false, octave: 0 },
  calm:    { pad: 0.5,  pluck: 0.32, drum: 0,    bell: 0,    density: 0.3,  drumFast: false, octave: 0 },
  bright:  { pad: 0.5,  pluck: 0.42, drum: 0.4,  bell: 0.22, density: 0.55, drumFast: false, octave: 0 },
  tense:   { pad: 0.55, pluck: 0.22, drum: 0.55, bell: 0,    density: 0.28, drumFast: true,  octave: -12 },
  title:   { pad: 0.55, pluck: 0.45, drum: 0.32, bell: 0.35, density: 0.5,  drumFast: false, octave: 0 },
  results: { pad: 0.5,  pluck: 0.4,  drum: 0.22, bell: 0.3,  density: 0.42, drumFast: false, octave: 0 },
};

export function createAudio() {
  let ctx = null;               // null until unlock() (first user gesture)
  let master = null;
  let buses = null;
  let noiseBuf = null;
  let disposed = false;
  let muted = false;
  let tick = 0;                 // event counter feeding seeded variants
  const volumes = { music: 0.7, effects: 0.9, ambience: 0.6, voice: 0.8 };
  const live = new Set();       // { src, nodes } entries, for leak-free cleanup
  const sampleCache = new Map(); // event -> AudioBuffer | 'loading' | 'failed'

  // Music state
  const stems = {};             // pad / pluck / drum / bell gain nodes
  let mood = 'off';
  let schedId = null;
  let nextTime = 0;
  let stepIdx = 0;
  let loopCount = 0;
  let melody = null;

  // Ambience state
  let ambOn = false;
  let ambKind = 'pavilion';
  let ambWash = null;           // { src, lfo, filt, gain }
  let chimeTimer = null;
  const chimeSt = createStream('ambience:chimes');

  /** Deterministic per-event variant stream: same sequence -> same sound. */
  function variantStream(name) {
    tick += 1;
    return createStream('audio:' + name + ':' + tick);
  }

  /** Track a source + its chain so ended/disposed voices are disconnected. */
  function track(src, nodes) {
    const entry = { src, nodes };
    live.add(entry);
    src.onended = () => {
      live.delete(entry);
      for (const n of [src, ...nodes]) { try { n.disconnect(); } catch (e) { /* already gone */ } }
    };
  }

  /** Smooth a gain/AudioParam toward v over dur seconds, click-free. */
  function ramp(param, v, dur = 0.06) {
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(v, now + dur);
  }

  /** Gain node with an attack/decay envelope, connected to `out`. */
  function envGain(out, t, attack, peak, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + Math.max(0.001, attack));
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(out);
    return g;
  }

  /** Generic enveloped oscillator blip. */
  function tone(out, { t, type = 'sine', freq, freqEnd = 0, attack = 0.005, decay = 0.15, gain = 0.2 }) {
    const dur = attack + decay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd > 0) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = envGain(out, t, attack, gain, decay);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
    track(o, [g]);
  }

  /** Generic enveloped, filtered noise burst from the shared buffer. */
  function noiseHit(out, { t, attack = 0.002, decay = 0.08, gain = 0.15, type = 'bandpass', freq = 2000, freqEnd = 0, q = 1 }) {
    const dur = attack + decay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd > 0) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = envGain(out, t, attack, gain, decay);
    src.connect(f);
    f.connect(g);
    src.start(t);
    src.stop(t + dur + 0.05);
    track(src, [f, g]);
  }

  /** Bell-ish partial stack, shared by crown/encore/music bell stem. */
  function bell(out, t, freq, gain = 0.12, decay = 0.9) {
    tone(out, { t, type: 'sine', freq, attack: 0.003, decay, gain });
    tone(out, { t, type: 'sine', freq: freq * 2.4, attack: 0.003, decay: decay * 0.5, gain: gain * 0.35 });
  }

  /** Shared 2s white-noise buffer (deterministic, from a seeded stream). */
  function makeNoise() {
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const st = createStream('audio:noise');
    for (let i = 0; i < len; i++) d[i] = nextFloat(st) * 2 - 1;
    return buf;
  }

  // -------------------------------------------------------------------------
  // Sound effects — one function per logical event
  // -------------------------------------------------------------------------

  const SFX = {
    // soft paper tick
    ui(t, o, st, out) {
      noiseHit(out, { t, attack: 0.001, decay: 0.035, gain: 0.07, freq: 2600, q: 2.5 });
    },
    // wooden tok
    select(t, o, st, out) {
      tone(out, { t, type: 'sine', freq: 780, freqEnd: 720, attack: 0.002, decay: 0.07, gain: 0.22 });
      noiseHit(out, { t, attack: 0.001, decay: 0.02, gain: 0.08, freq: 1500, q: 1.5 });
    },
    // dull muted thud, descending minor third, quiet
    error(t, o, st, out) {
      tone(out, { t, type: 'triangle', freq: 196, attack: 0.004, decay: 0.09, gain: 0.13 });
      tone(out, { t: t + 0.1, type: 'triangle', freq: 155.6, attack: 0.004, decay: 0.22, gain: 0.11 });
    },
    // die rattle: 3 seeded noise bursts + final tok
    roll(t, o, st, out) {
      for (let i = 0; i < 3; i++) {
        noiseHit(out, { t: t + i * 0.09, attack: 0.002, decay: 0.045, gain: 0.13, freq: nextRange(st, 1200, 2600), q: 3 });
      }
      tone(out, { t: t + 0.29, type: 'sine', freq: nextRange(st, 620, 760), attack: 0.002, decay: 0.08, gain: 0.2 });
    },
    // wooden step hop: 1-3 quick ascending toks (opts.steps overrides)
    move(t, o, st, out) {
      const n = Math.max(1, Math.min(3, o.steps ?? nextRange(st, 1, 3)));
      const base = 480 + nextInt(st, 60);
      for (let i = 0; i < n; i++) {
        const tt = t + i * 0.075;
        tone(out, { t: tt, type: 'sine', freq: base * (1 + i * 0.16), attack: 0.002, decay: 0.06, gain: 0.16 });
        noiseHit(out, { t: tt, attack: 0.001, decay: 0.015, gain: 0.05, freq: 1300, q: 1.5 });
      }
    },
    // match-strike + warm kindling chime
    deploy(t, o, st, out) {
      noiseHit(out, { t, attack: 0.004, decay: 0.13, gain: 0.14, freq: 900, freqEnd: 2600, q: 1.2 });
      const f = pick(st, [587.3, 659.3, 784]); // D5 / E5 / G5
      tone(out, { t: t + 0.1, type: 'sine', freq: f, attack: 0.005, decay: 0.7, gain: 0.1 });
      tone(out, { t: t + 0.1, type: 'sine', freq: f * 2, attack: 0.005, decay: 0.45, gain: 0.04 });
    },
    // taiko-ish hit: sine drop 180->60Hz + noise slap + low thump
    capture(t, o, st, out) {
      tone(out, { t, type: 'sine', freq: 180, freqEnd: 60, attack: 0.003, decay: 0.4, gain: 0.5 });
      noiseHit(out, { t, attack: 0.001, decay: 0.05, gain: 0.22, freq: 800, q: 0.9 });
      noiseHit(out, { t: t + 0.01, attack: 0.004, decay: 0.3, gain: 0.18, type: 'lowpass', freq: 260 });
    },
    // bright bell arpeggio, 4 pentatonic notes
    crown(t, o, st, out) {
      [659.3, 784, 880, 1046.5].forEach((f, i) => bell(out, t + i * 0.09, f, 0.11));
    },
    // rising fifth sparkle
    encore(t, o, st, out) {
      bell(out, t, 784, 0.1, 0.6);            // G5
      bell(out, t + 0.12, 1174.7, 0.12, 0.9); // D6
      noiseHit(out, { t: t + 0.12, attack: 0.02, decay: 0.25, gain: 0.03, freq: 6200, q: 1 });
    },
    // descending sad slide + poof
    overkindled(t, o, st, out) {
      tone(out, { t, type: 'sine', freq: 420, freqEnd: 140, attack: 0.01, decay: 0.5, gain: 0.13 });
      noiseHit(out, { t: t + 0.32, attack: 0.01, decay: 0.22, gain: 0.12, type: 'lowpass', freq: 420 });
    },
    // soft breath whoosh
    pass(t, o, st, out) {
      noiseHit(out, { t, attack: 0.09, decay: 0.3, gain: 0.07, freq: 500, freqEnd: 1300, q: 0.7 });
    },
    // gentle paper slide
    turn(t, o, st, out) {
      noiseHit(out, { t, attack: 0.04, decay: 0.16, gain: 0.055, freq: 1900, freqEnd: 1100, q: 1.1 });
    },
    // festival fanfare: ~2.5s pentatonic major phrase, layered plucks + bell
    win(t, o, st, out) {
      const seq = [
        [523.3, 0], [659.3, 0.16], [784, 0.32],
        [880, 0.48], [1046.5, 0.64], [1318.5, 0.92],
      ];
      for (const [f, dt] of seq) {
        tone(out, { t: t + dt, type: 'triangle', freq: f, attack: 0.004, decay: 0.3, gain: 0.15 });
        bell(out, t + dt, f, 0.06, dt >= 0.9 ? 1.4 : 0.7);
      }
      for (const f of [261.6, 392]) { // warm pad swell underneath
        tone(out, { t, type: 'sine', freq: f, attack: 0.35, decay: 1.9, gain: 0.05 });
      }
    },
    // gentle minor cadence, not punishing
    lose(t, o, st, out) {
      const seq = [[329.6, 0], [261.6, 0.34], [220, 0.68]]; // E4 C4 A3
      for (const [f, dt] of seq) {
        tone(out, { t: t + dt, type: 'triangle', freq: f, attack: 0.01, decay: 0.65, gain: 0.11 });
        tone(out, { t: t + dt, type: 'sine', freq: f / 2, attack: 0.02, decay: 0.7, gain: 0.05 });
      }
    },
    // soft high ping
    hint(t, o, st, out) {
      tone(out, { t, type: 'sine', freq: 1568, attack: 0.003, decay: 0.45, gain: 0.07 });
      tone(out, { t, type: 'sine', freq: 3136, attack: 0.003, decay: 0.2, gain: 0.02 });
    },
    // reverse-tape-ish rising slide
    undo(t, o, st, out) {
      tone(out, { t, type: 'sine', freq: 240, freqEnd: 880, attack: 0.015, decay: 0.28, gain: 0.07 });
      noiseHit(out, { t, attack: 0.1, decay: 0.18, gain: 0.045, freq: 500, freqEnd: 2600, q: 1.4 });
    },
  };

  // -------------------------------------------------------------------------
  // Authored samples — lazy fetch/decode/cache of sfx/<name>.opus per event
  // -------------------------------------------------------------------------

  /** Kick off a one-time fetch+decode for an event's clip. Never throws. */
  function loadSample(name) {
    if (sampleCache.has(name) || !ctx || typeof fetch !== 'function') return;
    sampleCache.set(name, 'loading');
    fetch('sfx/' + EVENT_SAMPLES[name] + '.opus')
      .then((r) => {
        if (!r.ok) throw new Error('sfx http ' + r.status);
        return r.arrayBuffer();
      })
      .then((ab) => (ctx ? ctx.decodeAudioData(ab) : Promise.reject(new Error('ctx gone'))))
      .then((buf) => sampleCache.set(name, buf))
      .catch(() => sampleCache.set(name, 'failed')); // synthesis stays the fallback
  }

  /** Play a decoded clip once through the effects bus (inherits volume/mute). */
  function playSample(buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(buses.effects);
    src.start();
    track(src, []);
  }

  // -------------------------------------------------------------------------
  // Adaptive music — lookahead scheduler over layered stems
  // -------------------------------------------------------------------------

  /** Seeded 32-step pentatonic melody with stepwise motion, one per loop. */
  function makeMelody(moodName, n) {
    const cfg = MOODS[moodName] || MOODS.calm;
    const st = createStream('music:' + moodName + ':' + n);
    const out = new Array(LOOP_STEPS).fill(null);
    let idx = nextInt(st, PENTA.length);
    for (let i = 0; i < LOOP_STEPS; i++) {
      if (nextFloat(st) < cfg.density) {
        idx = Math.max(0, Math.min(PENTA.length - 1, idx + nextRange(st, -2, 2)));
        out[i] = PENTA[idx];
      }
    }
    return out;
  }

  function kick(out, t) {
    tone(out, { t, type: 'sine', freq: 120, freqEnd: 45, attack: 0.002, decay: 0.16, gain: 0.5 });
  }

  function shaker(out, t, gain) {
    noiseHit(out, { t, attack: 0.001, decay: 0.035, gain, freq: 6200, q: 1.2 });
  }

  /** Schedule one 8th-note step of the shared chord loop onto the stems. */
  function scheduleStep(step, t) {
    const cfg = MOODS[mood] || MOODS.off;
    const bar = Math.floor(step / STEPS_PER_BAR) % BARS_PER_LOOP;
    const s = step % STEPS_PER_BAR;
    const loopStep = step % LOOP_STEPS;

    if (loopStep === 0) { // new loop: regenerate the seeded melody
      melody = makeMelody(mood, loopCount);
      loopCount += 1;
    }

    if (s === 0) { // pad: slow, overlapping chord tones at each bar start
      for (const m of CHORDS[bar]) {
        const f = midiHz(m + cfg.octave);
        tone(stems.pad, { t, type: 'sine', freq: f, attack: 1.0, decay: BEAT * 4 + 1.2, gain: 0.045 });
        tone(stems.pad, { t, type: 'triangle', freq: f * 1.003, attack: 1.2, decay: BEAT * 4 + 1.0, gain: 0.022 });
      }
    }

    const note = melody && melody[loopStep]; // pluck melody
    if (note) {
      const f = midiHz(note + Math.min(0, cfg.octave));
      tone(stems.pluck, { t, type: 'triangle', freq: f, attack: 0.004, decay: 0.28, gain: 0.16 });
      tone(stems.pluck, { t, type: 'sine', freq: f * 2, attack: 0.004, decay: 0.14, gain: 0.04 });
    }

    if (cfg.drum > 0) { // sparse drum; tense doubles the pattern
      const kicks = cfg.drumFast ? [0, 2, 4, 6] : [0, 4];
      if (kicks.includes(s)) kick(stems.drum, t);
      if (cfg.drumFast || s % 2 === 1) shaker(stems.drum, t, cfg.drumFast ? 0.09 : 0.05);
    }

    if (cfg.bell > 0 && (loopStep === 0 || loopStep === 20)) { // sparse accents
      bell(stems.bell, t, midiHz(CHORDS[bar][2] + 12), 0.09, 1.6);
    }
  }

  /** Lookahead tick: schedule every step due within the next 0.3s. */
  function schedTick() {
    if (!ctx) return;
    if (ctx.state !== 'running') { // suspended: hold position, resume cleanly
      nextTime = ctx.currentTime + 0.15;
      return;
    }
    if (nextTime < ctx.currentTime - 0.5) nextTime = ctx.currentTime + 0.1; // snap after long stalls
    while (nextTime < ctx.currentTime + 0.3) {
      scheduleStep(stepIdx, nextTime);
      nextTime += BEAT / 2;
      stepIdx += 1;
    }
  }

  function startScheduler() {
    if (schedId != null || !ctx) return;
    nextTime = ctx.currentTime + 0.15;
    stepIdx = 0;
    loopCount = 0;
    melody = null;
    schedId = setInterval(schedTick, 90);
  }

  function stopScheduler() {
    if (schedId != null) { clearInterval(schedId); schedId = null; }
  }

  // -------------------------------------------------------------------------
  // Ambience — quiet filtered wash + seeded distant wind-chime plinks
  // -------------------------------------------------------------------------

  function startAmbience() {
    if (ambWash || !ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = ambKind === 'night' ? 260 : ambKind === 'garden' ? 900 : 480;
    const g = ctx.createGain();
    g.gain.value = 0.05; // quiet wash
    const lfo = ctx.createOscillator(); // slow swell so the wash breathes
    lfo.frequency.value = 0.09;
    const lg = ctx.createGain();
    lg.gain.value = 0.02;
    lfo.connect(lg);
    lg.connect(g.gain);
    src.connect(filt);
    filt.connect(g);
    g.connect(buses.ambience);
    src.start();
    lfo.start();
    ambWash = { src, lfo, filt, gain: g };
  }

  function stopAmbience() {
    if (chimeTimer) { clearTimeout(chimeTimer); chimeTimer = null; }
    if (!ambWash || !ctx) return;
    const { src, lfo, filt, gain } = ambWash;
    ambWash = null;
    try {
      ramp(gain.gain, 0.0001, 0.4);
      const stopAt = ctx.currentTime + 0.5;
      src.stop(stopAt);
      lfo.stop(stopAt);
    } catch (e) { /* already stopped */ }
    src.onended = () => {
      for (const n of [src, lfo, filt, gain]) { try { n.disconnect(); } catch (e) { /* gone */ } }
    };
  }

  /** Recursively schedule the next seeded chime plink while ambience is on. */
  function scheduleChime() {
    if (!ambOn || !ctx || chimeTimer) return;
    const delay = nextRange(chimeSt, 2600, 8200);
    chimeTimer = setTimeout(() => {
      chimeTimer = null;
      if (ambOn && ctx && ctx.state === 'running') {
        const f = pick(chimeSt, [1318.5, 1568, 1760, 2093]); // E6 G6 A6 C7
        bell(buses.ambience, ctx.currentTime + 0.02, f, 0.035, 1.8);
      }
      scheduleChime();
    }, delay);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Create/resume the AudioContext. Callable from any gesture, idempotent. */
  function unlock() {
    if (disposed) return;
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return; // no WebAudio available: stay a silent no-op device
    try { ctx = new AC(); } catch (e) { ctx = null; return; }

    noiseBuf = makeNoise();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 1;
    master.connect(ctx.destination);
    buses = {};
    for (const k of BUSES) {
      const g = ctx.createGain();
      g.gain.value = volumes[k];
      g.connect(master);
      buses[k] = g;
    }
    for (const k of ['pad', 'pluck', 'drum', 'bell']) {
      const g = ctx.createGain();
      g.gain.value = 0; // stems fade in via setMusic crossfades
      g.connect(buses.music);
      stems[k] = g;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    // Apply anything requested while locked.
    if (mood !== 'off') {
      const m = mood;
      mood = 'off'; // force setMusic to treat it as a real transition
      setMusic(m);
    }
    if (ambOn) {
      startAmbience();
      scheduleChime();
    }
  }

  function suspend() {
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  function resume() {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /** Stop everything and release the context. The object is dead afterwards. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    stopScheduler();
    if (chimeTimer) { clearTimeout(chimeTimer); chimeTimer = null; }
    for (const e of live) {
      try { e.src.onended = null; e.src.stop(); } catch (err) { /* stopped */ }
      for (const n of [e.src, ...e.nodes]) { try { n.disconnect(); } catch (err) { /* gone */ } }
    }
    live.clear();
    if (ambWash) {
      try { ambWash.src.stop(); ambWash.lfo.stop(); } catch (e) { /* stopped */ }
      ambWash = null;
    }
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  /** Set a bus volume 0..1 with a smooth ramp. Unknown buses are ignored. */
  function setVolume(bus, v) {
    if (disposed || !BUSES.includes(bus)) return;
    const val = Math.max(0, Math.min(1, Number(v) || 0));
    volumes[bus] = val;
    if (ctx && buses) ramp(buses[bus].gain, val, 0.06);
  }

  function getVolume(bus) {
    return BUSES.includes(bus) ? volumes[bus] : 0;
  }

  /** Master mute, applied near-instantly (10ms ramp to avoid clicks). */
  function setMuted(b) {
    if (disposed) return;
    muted = !!b;
    if (ctx && master) ramp(master.gain, muted ? 0 : 1, 0.012);
  }

  /** Play the SFX mapped to a logical event. Silent no-op when locked. */
  function event(name, opts) {
    if (!ctx || disposed || ctx.state !== 'running') return;
    const fn = SFX[name];
    if (!fn) return;
    try {
      if (name in EVENT_SAMPLES) {
        const st = sampleCache.get(name);
        if (st instanceof AudioBuffer) { // decoded: sample replaces synthesis
          playSample(st);
          return;
        }
        if (st === undefined) loadSample(name); // first play: start fetching
        // 'loading' / 'failed' / just started: synthesis covers this play
      }
      fn(ctx.currentTime + 0.02, opts || {}, variantStream(name), buses.effects);
    } catch (e) { /* audio must never crash the game */ }
  }

  /** Switch the adaptive music mood; stems crossfade over the shared loop. */
  function setMusic(m) {
    if (disposed || !(m in MOODS) || m === mood) return;
    mood = m;
    if (!ctx) return; // pending; unlock() applies it
    const cfg = MOODS[m];
    for (const k of ['pad', 'pluck', 'drum', 'bell']) ramp(stems[k].gain, cfg[k], 1.4);
    if (m === 'off') stopScheduler();
    else startScheduler();
  }

  /** Toggle the pavilion ambience. kind: 'pavilion' | 'night' | 'garden'. */
  function setAmbience(on, kind) {
    if (disposed) return;
    ambOn = !!on;
    if (kind) ambKind = String(kind);
    if (!ctx) return; // pending; unlock() applies it
    if (ambOn) {
      startAmbience();
      scheduleChime();
    } else {
      stopAmbience();
    }
  }

  return {
    unlock, suspend, resume, dispose,
    setVolume, getVolume, setMuted,
    event, setMusic, setAmbience,
  };
}
