// Sound, as the browser build's src/audio.js: the authored one-shots
// (sfx/<name>.opus, sfx/manifest.json) per game event, the adaptive music
// (the shared C–Am–F–G loop at 76 BPM: a slow sine/triangle chord pad, a
// seeded pentatonic pluck melody regenerated each loop, kick and shaker, bell
// accents; the moods title, calm and tense set the stems' levels, the
// melody's density and tense drops an octave with a doubled drum pattern) and
// the pavilion ambience (a low-passed noise wash breathing at 0.09 Hz with
// seeded distant wind-chime plinks). The browser build ran the music and the
// ambience live; here the engine's offline audio context renders each mood once
// into a clip of two loops (the melodies of loops 0 and 1, the stems at the
// mood's levels) and the ambience into a 30-second clip, and they loop on the
// music bus: the runtime has no ambience bus; the ambience plays at the old
// ambience-to-music bus ratio (0.6 / 0.7). Mood changes crossfade over 1.4 s
// as the stems did. The oscillator fallbacks audio.js played while a sample
// decoded are not ported: a clip still loading is silent. The runtime's Options
// own the volumes, the mute and the voice limit. Clips all load at start.
import { OfflineAudioContext, context, createClip, loadClip, play as playClip, type AudioBuffer, type AudioClip, type AudioNode, type GainNode, type Sound } from "starhermit:audio";
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
let suspended = false;

/** Loads every clip at once and starts the renders (onStart). */
export function loadSfx(): void {
  for (const name of new Set(Object.values(EVENT_SAMPLES))) {
    loadClip(`sfx/${name}.opus`).then((c) => { clips.set(name, c); }, (e: unknown) => console.warn(`sfx ${name}: ${e instanceof Error ? e.message : String(e)}`));
  }
  void (async () => { // one mood at a time: the title's first, as it plays first
    for (const m of ["title", "calm", "tense"] as Mood[]) {
      try { moodClips[m] = await renderMood(m); } catch (e) { console.warn(`audio: ${String(e)}`); }
    }
  })();
  renderAmbience().then((c) => { ambClip = c; }, (e: unknown) => console.warn(`audio: ${String(e)}`));
}
/** audio.js event(): the event's clip on the effects bus. */
export function event(name: string): void {
  if (suspended) return;
  const file = EVENT_SAMPLES[name];
  if (!file) return;
  const clip = clips.get(file);
  if (!clip) return;
  try { playClip(clip, { bus: "effects" }); } catch { /* the mixer is full this frame: skip it */ }
}

// -- synthesis (audio.js tone / noiseHit / bell, rendered by the offline context) -----------------
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

type Off = OfflineAudioContext;
/** An enveloped oscillator note (linear attack from 0.0001, exponential decay to 0.0001). */
function tone(off: Off, out: AudioNode, t0: number, o: { type: "sine" | "triangle"; freq: number; freqEnd?: number; attack: number; decay: number; gain: number }): void {
  const attack = Math.max(0.001, o.attack), end = t0 + attack + o.decay;
  const g = off.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, end);
  const osc = off.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.freqEnd && o.freqEnd > 0) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, end);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(end);
}
/** Bell-ish partial stack. */
function bell(off: Off, out: AudioNode, t: number, freq: number, gain: number, decay: number): void {
  tone(off, out, t, { type: "sine", freq, attack: 0.003, decay, gain });
  tone(off, out, t, { type: "sine", freq: freq * 2.4, attack: 0.003, decay: decay * 0.5, gain: gain * 0.35 });
}
/** The render with what ran past `length` samples wrapped to the start. */
function wrapped(r: Float32Array, length: number): Float32Array {
  const out = r.slice(0, length);
  for (let i = length; i < r.length; i++) out[i % length]! += r[i]!;
  return out;
}
const level = (off: Off, gain: number): GainNode => { const g = off.createGain(); g.gain.value = gain; g.connect(off.destination); return g; };

/** One stem of a render: its own context (a context holds a bounded number of nodes), at the mood's level, wrapped round the buffer. */
async function stem(length: number, tail: number, gain: number, build: (off: Off, out: GainNode) => void): Promise<AudioBuffer> {
  const off = new OfflineAudioContext(1, length + Math.round(tail * RATE), RATE);
  build(off, level(off, gain));
  const data = wrapped((await off.startRendering()).getChannelData(0), length);
  const b = context.createBuffer(1, length, RATE);
  b.copyToChannel(data, 0);
  return b;
}
/** The stems as audio.js scheduled them on the 8th-note grid, mixed into two loops of a mood at its levels. */
async function renderMood(mood: Mood): Promise<AudioClip> {
  const cfg = MOODS[mood];
  const length = 2 * LOOP_N;
  const pad = await stem(LOOP_N, BEAT * 4 + 2.4, cfg.pad, (off, out) => {
    for (let bar = 0; bar < 4; bar++) {
      const t = bar * 8 * STEP;
      for (const m of CHORDS[bar]!) {
        const f = midiHz(m + cfg.octave);
        tone(off, out, t, { type: "sine", freq: f, attack: 1.0, decay: BEAT * 4 + 1.2, gain: 0.045 });
        tone(off, out, t, { type: "triangle", freq: f * 1.003, attack: 1.2, decay: BEAT * 4 + 1.0, gain: 0.022 });
      }
    }
  });
  const pluck = await stem(length, 0.5, cfg.pluck, (off, out) => {
    for (let loop = 0; loop < 2; loop++) {
      // makeMelody(mood, loop): a seeded 32-step pentatonic melody with stepwise motion
      const st = R.createStream(`music:${mood}:${loop}`);
      let idx = R.nextInt(st, PENTA.length);
      for (let i = 0; i < LOOP_STEPS; i++) {
        if (R.nextFloat(st) >= cfg.density) continue;
        idx = Math.max(0, Math.min(PENTA.length - 1, idx + R.nextRange(st, -2, 2)));
        const f = midiHz(PENTA[idx]! + Math.min(0, cfg.octave));
        const t = (loop * LOOP_STEPS + i) * STEP;
        tone(off, out, t, { type: "triangle", freq: f, attack: 0.004, decay: 0.28, gain: 0.16 });
        tone(off, out, t, { type: "sine", freq: f * 2, attack: 0.004, decay: 0.14, gain: 0.04 });
      }
    }
  });
  const parts = [pad, pluck];
  if (cfg.drum > 0) parts.push(await stem(length, 0.5, cfg.drum, (off, out) => {
    // the shaker: one noise through a band-pass, its gain following each hit
    const noise = off.createNoise({ seed: 0x5ca1, seconds: 2 });
    const bp = off.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 6200;
    bp.Q.value = 20 * Math.log10(1.2); // the engine's Q is in dB, as Web Audio's
    const hits = off.createGain();
    hits.gain.setValueAtTime(0, 0);
    noise.connect(bp).connect(hits).connect(out);
    noise.start();
    const peak = cfg.drumFast ? 0.09 : 0.05;
    for (let step = 0; step < 2 * LOOP_STEPS; step++) {
      const t = step * STEP, sIn = step % 8;
      if ((cfg.drumFast ? [0, 2, 4, 6] : [0, 4]).includes(sIn)) tone(off, out, t, { type: "sine", freq: 120, freqEnd: 45, attack: 0.002, decay: 0.16, gain: 0.5 });
      if (cfg.drumFast || sIn % 2 === 1) {
        hits.gain.setValueAtTime(0.0001, t);
        hits.gain.linearRampToValueAtTime(peak, t + 0.001);
        hits.gain.exponentialRampToValueAtTime(0.0001, t + 0.036);
      }
    }
  }));
  if (cfg.bell > 0) parts.push(await stem(length, 2, cfg.bell, (off, out) => {
    for (let step = 0; step < 2 * LOOP_STEPS; step++) {
      const ls = step % LOOP_STEPS;
      if (ls !== 0 && ls !== 20) continue;
      bell(off, out, step * STEP, midiHz(CHORDS[Math.floor(step / 8) % 4]![2]! + 12), 0.09, 1.6);
    }
  }));
  // the mix (the pad's one loop looped), natively
  const mix = new OfflineAudioContext(1, length, RATE);
  for (const b of parts) {
    const src = mix.createBufferSource();
    src.buffer = b;
    src.loop = b === pad;
    src.connect(mix.destination);
    src.start();
  }
  return createClip([(await mix.startRendering()).getChannelData(0)], RATE);
}

// audio.js startAmbience + scheduleChime: noise low-passed at 480 Hz at 0.05 with a 0.02 swell at 0.09 Hz,
// and a seeded plink (E6 G6 A6 C7, 0.035) every 2.6–8.2 s.
const AMB_SECONDS = 30;
async function renderAmbience(): Promise<AudioClip> {
  const settle = 0.25, length = AMB_SECONDS * RATE;
  const off = new OfflineAudioContext(1, Math.round((settle + AMB_SECONDS + 2) * RATE), RATE);
  const noise = off.createNoise({ seed: 0xa3b1, seconds: AMB_SECONDS });
  const lp = off.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 480;
  lp.Q.value = 20 * Math.log10(0.707);
  const g = off.createGain();
  // the swell, three whole cycles in the loop
  const swell = (t: number): number => 0.05 + 0.02 * Math.sin(2 * Math.PI * (3 / AMB_SECONDS) * t);
  g.gain.setValueAtTime(swell(0), 0);
  for (let t = 0.25; t <= settle + AMB_SECONDS + 2; t += 0.25) g.gain.linearRampToValueAtTime(swell(t - settle), t);
  noise.connect(lp).connect(g).connect(off.destination);
  noise.start();
  const chimes = level(off, 1);
  const chime = R.createStream("ambience:chimes");
  let t = R.nextRange(chime, 2600, 8200) / 1000;
  while (t < AMB_SECONDS - 0.1) {
    bell(off, chimes, settle + t, R.pick(chime, [1318.5, 1568, 1760, 2093]), 0.035, 1.8);
    t += R.nextRange(chime, 2600, 8200) / 1000;
  }
  const r = (await off.startRendering()).getChannelData(0);
  const start = Math.round(settle * RATE);
  const out = r.slice(start, start + length);
  return createClip([out], RATE);
}

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

/** Each frame once the mixer runs: follow the mood, then the ambience. */
export function update(): void {
  if (context.state !== "running") return;
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
  if (ambWanted && ambClip && !ambVoice) {
    try { ambVoice = playClip(ambClip, { bus: "music", gain: suspended ? 0 : AMB_GAIN, loop: true }); } catch { ambVoice = null; }
  }
}
/** Stops a faded-out loop after its fade. */
function setTimeoutStop(s: Sound): void { setTimeout(() => { try { s.stop(); } catch { /* gone */ } }, (MUSIC_FADE + 0.2) * 1000); }
