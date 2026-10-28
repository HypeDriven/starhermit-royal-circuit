// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, the adaptive music
// (the shared C–Am–F–G loop at 76 BPM: a slow sine/triangle chord pad, a
// seeded pentatonic pluck melody regenerated each loop, kick and shaker, bell
// accents; the moods title, calm and tense set the stems' levels, the
// melody's density and tense drops an octave with a doubled drum pattern) and
// the pavilion ambience (a low-passed noise wash breathing at 0.09 Hz with
// seeded distant wind-chime plinks). The browser build ran the music and the
// ambience live (oscillators and noise on a lookahead scheduler); here each
// mood is rendered once into a clip of two loops (the melodies of loops 0
// and 1, the stems mixed at the mood's levels) and the ambience into a
// 30-second clip, a note or a slice a frame (createClip), and looped on the
// music bus — the runtime has no ambience bus; the ambience plays at the old
// ambience-to-music bus ratio (0.6 / 0.7). Mood changes crossfade over 1.4 s
// as the stems did. The oscillator fallbacks audio.js played while a sample
// decoded are not ported (a live synthesis graph makes clip loads fail on the
// web runtime): a clip still loading is silent. The runtime's Options own the
// volumes, the mute and the voice limit. Clips load once the mixer runs
// (natively at once, in a browser after the first press), one at a time.
import { context, createClip, loadClip, play as playClip, type AudioClip, type Sound } from "starhermit:audio";
import * as rng from "../src/rng.js";

const R = rng as unknown as {
  createStream(seed: string | number): { s: number }; nextFloat(st: { s: number }): number; nextInt(st: { s: number }, n: number): number;
  nextRange(st: { s: number }, a: number, b: number): number; pick<T>(st: { s: number }, arr: T[]): T;
};

/** audio.js EVENT_SAMPLES: one authored clip per logical event. */
const EVENT_SAMPLES: Record<string, string> = {
  ui: "paper-tick", select: "wooden-tok", error: "error-thud", roll: "die-rattle", move: "wooden-steps", deploy: "match-chime",
  capture: "taiko-hit", crown: "bell-arpeggio", encore: "sparkle-rise", overkindled: "fizzle-poof", pass: "breath-whoosh",
  turn: "paper-slide", win: "festival-fanfare", lose: "minor-cadence", hint: "soft-ping", undo: "reverse-slide",
};
/** audio.js EVENT_CAPTIONS: the captions accessibility feature. */
export const EVENT_CAPTIONS: Record<string, string> = {
  ui: "soft paper tick", select: "wooden tok", error: "muted error thud", roll: "die rattle", move: "wooden steps",
  deploy: "match strike and warm chime", capture: "dramatic drum hit", crown: "bright bell arpeggio", encore: "rising sparkle",
  overkindled: "sad slide and poof", pass: "soft breath whoosh", turn: "gentle paper slide", win: "festival fanfare",
  lose: "gentle minor cadence", hint: "soft high ping", undo: "reverse-tape slide",
};
const clips = new Map<string, AudioClip>();
const queue: string[] = [];
let loading = false;
let wantClips = false;
let suspended = false;

/** Asks for the clips; they load once the mixer runs (see update). */
export function loadSfx(): void { wantClips = true; }
/** audio.js event(): the event's clip on the effects bus. */
export function event(name: string): void {
  if (suspended) return;
  const file = EVENT_SAMPLES[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { clips.delete(file); if (!queue.includes(file)) queue.push(file); }
}

// -- synthesis (audio.js tone / noiseHit / bell, rendered into buffers) ----------------------------
const RATE = 22050;
const BPM = 76, BEAT = 60 / BPM, STEP = BEAT / 2, LOOP_STEPS = 32;
const LOOP_N = Math.round(LOOP_STEPS * STEP * RATE);
const CHORDS = [[48, 55, 64], [45, 52, 60], [41, 48, 57], [43, 50, 59]];
const PENTA = [57, 60, 62, 64, 67, 69, 72, 74, 76, 79];
const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
type Mood = "title" | "calm" | "tense";
const MOODS: Record<Mood, { pad: number; pluck: number; drum: number; bell: number; density: number; drumFast: boolean; octave: number }> = {
  calm: { pad: 0.5, pluck: 0.32, drum: 0, bell: 0, density: 0.3, drumFast: false, octave: 0 },
  tense: { pad: 0.55, pluck: 0.22, drum: 0.55, bell: 0, density: 0.28, drumFast: true, octave: -12 },
  title: { pad: 0.55, pluck: 0.45, drum: 0.32, bell: 0.35, density: 0.5, drumFast: false, octave: 0 },
};

const SINE_N = 4096;
const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((i / SINE_N) * 2 * Math.PI);
/** An enveloped oscillator note (linear attack from 0.0001, exponential decay to 0.0001), wrapping round the buffer. */
function tone(buf: Float32Array, t0: number, o: { type: "sine" | "triangle"; freq: number; freqEnd?: number; attack: number; decay: number; gain: number }, part = 0, parts = 1): void {
  const n = buf.length;
  const attack = Math.max(0.001, o.attack);
  const len = Math.round((attack + o.decay) * RATE);
  const aN = Math.max(1, Math.round(attack * RATE));
  const start = Math.round(t0 * RATE);
  const fall = Math.pow(0.0001 / o.gain, 1 / Math.max(1, len - aN));
  const sweep = o.freqEnd && o.freqEnd > 0 ? Math.pow(o.freqEnd / o.freq, 1 / len) : 1;
  // a slice of the note (part of parts; slices need no frequency sweep): its envelope and phase where it starts
  const i0 = Math.floor((len * part) / parts), i1 = Math.floor((len * (part + 1)) / parts);
  let f = o.freq, ph = parts > 1 ? ((o.freq * i0) / RATE) % 1 : 0, env = o.gain * Math.pow(fall, Math.max(0, i0 - aN));
  for (let i = i0; i < i1; i++) {
    let e: number;
    if (i < aN) e = 0.0001 + (o.gain - 0.0001) * (i / aN);
    else { e = env; env *= fall; }
    const w = o.type === "sine" ? SINE[(ph * SINE_N) | 0]! : 1 - 4 * Math.abs(ph - 0.5);
    const j = (start + i) % n;
    buf[j] = buf[j]! + w * e;
    ph += f / RATE;
    if (ph >= 1) ph -= 1;
    f *= sweep;
  }
}
/** Bell-ish partial stack. */
function bell(buf: Float32Array, t: number, freq: number, gain: number, decay: number): void {
  tone(buf, t, { type: "sine", freq, attack: 0.003, decay, gain });
  tone(buf, t, { type: "sine", freq: freq * 2.4, attack: 0.003, decay: decay * 0.5, gain: gain * 0.35 });
}
/** A biquad (RBJ cookbook) over a sample stream. */
function biquad(type: "bandpass" | "lowpass", freq: number, q: number): (x: number) => number {
  const w = (2 * Math.PI * freq) / RATE, cw = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === "lowpass") { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; } else { b0 = al; b1 = 0; b2 = -al; }
  const a0 = 1 + al, a1 = -2 * cw, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}
const noiseSt = R.createStream("audio:noise");
/** A filtered noise burst (shaker). */
function noiseHit(buf: Float32Array, t0: number, o: { attack: number; decay: number; gain: number; freq: number; q: number }): void {
  const n = buf.length;
  const len = Math.round((o.attack + o.decay) * RATE), aN = Math.max(1, Math.round(o.attack * RATE));
  const start = Math.round(t0 * RATE);
  const filt = biquad("bandpass", Math.min(o.freq, RATE * 0.45), o.q);
  const fall = Math.pow(0.0001 / o.gain, 1 / Math.max(1, len - aN));
  let env = o.gain;
  for (let i = 0; i < len; i++) {
    let e: number;
    if (i < aN) e = 0.0001 + (o.gain - 0.0001) * (i / aN);
    else { e = env; env *= fall; }
    const j = (start + i) % n;
    buf[j] = buf[j]! + filt(R.nextFloat(noiseSt) * 2 - 1) * e;
  }
}

// The stems as audio.js scheduled them on the 8th-note grid; the jobs render one note each (a frame).
const padBuf: Record<string, Float32Array> = { "0": new Float32Array(LOOP_N), "-12": new Float32Array(LOOP_N) };
const moodStem = (): Record<string, Float32Array> => ({ pluck: new Float32Array(2 * LOOP_N), drum: new Float32Array(2 * LOOP_N), bell: new Float32Array(2 * LOOP_N) });
const stems: Record<Mood, Record<string, Float32Array>> = { title: moodStem(), calm: moodStem(), tense: moodStem() };
const mixes: Partial<Record<Mood, Float32Array>> = {};
const jobs: (() => void)[] = [];
function planPad(oct: number): void {
  const buf = padBuf[String(oct)]!;
  for (let bar = 0; bar < 4; bar++) {
    const t = bar * 8 * STEP;
    for (const m of CHORDS[bar]!) {
      const f = midiHz(m + oct);
      for (let k = 0; k < 12; k++) {
        jobs.push(() => tone(buf, t, { type: "sine", freq: f, attack: 1.0, decay: BEAT * 4 + 1.2, gain: 0.045 }, k, 12));
        jobs.push(() => tone(buf, t, { type: "triangle", freq: f * 1.003, attack: 1.2, decay: BEAT * 4 + 1.0, gain: 0.022 }, k, 12));
      }
    }
  }
}
function planMood(mood: Mood): void {
  const cfg = MOODS[mood];
  const s = stems[mood];
  for (let loop = 0; loop < 2; loop++) {
    // makeMelody(mood, loop): a seeded 32-step pentatonic melody with stepwise motion
    const st = R.createStream(`music:${mood}:${loop}`);
    let idx = R.nextInt(st, PENTA.length);
    for (let i = 0; i < LOOP_STEPS; i++) {
      if (R.nextFloat(st) >= cfg.density) continue;
      idx = Math.max(0, Math.min(PENTA.length - 1, idx + R.nextRange(st, -2, 2)));
      const f = midiHz(PENTA[idx]! + Math.min(0, cfg.octave));
      const t = (loop * LOOP_STEPS + i) * STEP;
      jobs.push(() => {
        tone(s.pluck!, t, { type: "triangle", freq: f, attack: 0.004, decay: 0.28, gain: 0.16 });
        tone(s.pluck!, t, { type: "sine", freq: f * 2, attack: 0.004, decay: 0.14, gain: 0.04 });
      });
    }
  }
  if (cfg.drum > 0) {
    for (let q = 0; q < 2 * LOOP_STEPS; q += 8) jobs.push(() => {
      for (let step = q; step < q + 8; step++) {
        const t = step * STEP, sIn = step % 8;
        const kicks = cfg.drumFast ? [0, 2, 4, 6] : [0, 4];
        if (kicks.includes(sIn)) tone(s.drum!, t, { type: "sine", freq: 120, freqEnd: 45, attack: 0.002, decay: 0.16, gain: 0.5 });
        if (cfg.drumFast || sIn % 2 === 1) noiseHit(s.drum!, t, { attack: 0.001, decay: 0.035, gain: cfg.drumFast ? 0.09 : 0.05, freq: 6200, q: 1.2 });
      }
    });
  }
  if (cfg.bell > 0) {
    jobs.push(() => {
      for (let step = 0; step < 2 * LOOP_STEPS; step++) {
        const ls = step % LOOP_STEPS;
        if (ls !== 0 && ls !== 20) continue;
        const bar = Math.floor(step / 8) % 4;
        bell(s.bell!, step * STEP, midiHz(CHORDS[bar]![2]! + 12), 0.09, 1.6);
      }
    });
  }
  // the mix: two loops of the pad plus the stems at the mood's levels, in slices
  const out = new Float32Array(2 * LOOP_N);
  const pad = padBuf[String(cfg.octave)]!;
  const SLICE = 60000;
  for (let a = 0; a < out.length; a += SLICE) {
    const from = a;
    jobs.push(() => {
      const to = Math.min(out.length, from + SLICE);
      for (let i = from; i < to; i++) {
        out[i] = pad[i % LOOP_N]! * cfg.pad + s.pluck![i]! * cfg.pluck + s.drum![i]! * cfg.drum + s.bell![i]! * cfg.bell;
      }
    });
  }
  jobs.push(() => { mixes[mood] = out; });
}

// audio.js startAmbience + scheduleChime: noise low-passed at 480 Hz at 0.05 with a 0.02 swell at 0.09 Hz,
// and a seeded plink (E6 G6 A6 C7, 0.035) every 2.6–8.2 s.
const AMB_SECONDS = 30;
const AMB_N = AMB_SECONDS * RATE;
const amb = new Float32Array(AMB_N);
let ambReady = false;
function planAmbience(): void {
  const lp = biquad("lowpass", 480, 0.707);
  const st = R.createStream("audio:ambience-wash");
  const SLICE = 50000;
  // twice round so the filter's state joins the loop seamlessly
  for (let a = 0; a < 2 * AMB_N; a += SLICE) {
    const from = a;
    jobs.push(() => {
      const to = Math.min(2 * AMB_N, from + SLICE);
      for (let i = from; i < to; i++) {
        const y = lp(R.nextFloat(st) * 2 - 1);
        if (i >= AMB_N) {
          const t = (i - AMB_N) / RATE;
          amb[i - AMB_N] = y * (0.05 + 0.02 * Math.sin(2 * Math.PI * (3 / AMB_SECONDS) * t));
        }
      }
    });
  }
  jobs.push(() => {
    const chime = R.createStream("ambience:chimes");
    let t = R.nextRange(chime, 2600, 8200) / 1000;
    while (t < AMB_SECONDS - 0.1) {
      bell(amb, t, R.pick(chime, [1318.5, 1568, 1760, 2093]), 0.035, 1.8);
      t += R.nextRange(chime, 2600, 8200) / 1000;
    }
    ambReady = true;
  });
}
planPad(0);
planMood("title");
planAmbience();
planPad(-12);
planMood("calm");
planMood("tense");

// -- playback ---------------------------------------------------------------------------------
const MUSIC_FADE = 1.4;
/** The ambience bus sat at 0.6 against music's 0.7. */
const AMB_GAIN = 0.6 / 0.7;
let mood: Mood | "off" = "off";
const moodClips: Partial<Record<Mood, AudioClip>> = {};
let moodVoice: { mood: Mood; sound: Sound } | null = null;
let ambClip: AudioClip | null = null;
let ambVoice: Sound | null = null;
let ambWanted = false;
/** audio.js setMusic: title, calm or tense (bright played as calm before; results was never chosen). */
export function setMusic(m: Mood): void { mood = m; }
/** audio.js setAmbience(true): the pavilion wash from the first match on. */
export function setAmbience(on: boolean): void { ambWanted = on; }
/** A hidden window and the pause panel silence the loops. */
export function setSuspended(on: boolean): void {
  if (on === suspended) return;
  suspended = on;
  try {
    moodVoice?.sound.fade(on ? 0 : 1, 0.2);
    ambVoice?.fade(on ? 0 : AMB_GAIN, 0.2);
  } catch { /* gone */ }
}

/** Each frame: the clips once the mixer runs (one at a time), a synthesis job, then the loops. */
export function update(): void {
  if (jobs.length) {
    try { jobs.shift()!(); } catch (e) { console.warn(`audio render: ${String(e)}`); }
  }
  if (context.state !== "running") return;
  if (wantClips) {
    wantClips = false;
    for (const n of Object.values(EVENT_SAMPLES)) if (!queue.includes(n)) queue.push(n);
  }
  if (!loading && queue.length) {
    const name = queue.shift()!;
    if (!clips.has(name)) {
      loading = true;
      loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); loading = false; }, (e: unknown) => {
        console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`);
        loading = false;
      });
    }
    return;
  }
  if (loading) return;
  // one clip operation a frame: make a ready mix, then follow the mood, then the ambience
  for (const m of ["title", "calm", "tense"] as Mood[]) {
    const buf = mixes[m];
    if (buf && !moodClips[m]) {
      try { moodClips[m] = createClip([buf], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); delete mixes[m]; }
      return;
    }
  }
  if (mood !== "off" && moodVoice?.mood !== mood && moodClips[mood]) {
    try {
      moodVoice?.sound.fade(0, MUSIC_FADE);
      const old = moodVoice?.sound;
      if (old) setTimeoutStop(old);
      const sound = playClip(moodClips[mood]!, { bus: "music", gain: 0, loop: true });
      sound.fade(suspended ? 0 : 1, MUSIC_FADE);
      moodVoice = { mood, sound };
    } catch { /* retried next frame */ }
    return;
  }
  if (ambReady && !ambClip) {
    try { ambClip = createClip([amb], RATE); } catch (e) { console.warn(`audio: ${String(e)}`); ambReady = false; }
    return;
  }
  if (ambWanted && ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
}
/** Stops a faded-out loop after its fade. */
function setTimeoutStop(s: Sound): void { setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, (MUSIC_FADE + 0.2) * 1000); }
