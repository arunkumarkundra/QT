/**
 * QUEEN'S TUG — Sound
 *
 * Every sound is synthesised at runtime with WebAudio. No audio files, so the
 * game stays a handful of text files, works offline, and adds nothing to load
 * time. Browsers block audio until a user gesture, so the context is created
 * lazily on the first click and resumed if suspended.
 */

const SOUND_STORAGE_KEY = 'qt-muted';

const audio = {
  ctx: null,
  master: null,
  muted: false,
  ready: false,
};

function ensureContext() {
  if (audio.ctx) {
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return audio.ctx;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  audio.ctx = new Ctx();
  audio.master = audio.ctx.createGain();
  audio.master.gain.value = 0.32;
  audio.master.connect(audio.ctx.destination);
  audio.ready = true;
  return audio.ctx;
}

/** One shaped oscillator voice. */
function voice({ type = 'sine', from, to, start = 0, dur = 0.2, gain = 0.3, curve = 'exp' }) {
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to && to !== from) {
    if (curve === 'exp') osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
    else osc.frequency.linearRampToValueAtTime(to, t0 + dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.02, dur * 0.2));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(audio.master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** Filtered noise burst, for thuds and impacts. */
function noise({ start = 0, dur = 0.25, gain = 0.3, freq = 900, q = 1, type = 'lowpass' }) {
  const ctx = audio.ctx;
  const t0 = ctx.currentTime + start;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(audio.master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const RECIPES = {
  /** Dropping a coin onto a cell. Pitch rises with the stack height. */
  coinAdd(step = 0) {
    const base = 620 + Math.min(step, 9) * 42;
    voice({ type: 'triangle', from: base, to: base * 1.5, dur: 0.09, gain: 0.24 });
    voice({ type: 'sine', from: base * 2, to: base * 2.4, dur: 0.06, gain: 0.1, start: 0.01 });
  },
  /** Taking a coin back. */
  coinRemove() {
    voice({ type: 'triangle', from: 520, to: 300, dur: 0.11, gain: 0.2 });
  },
  /** Committing the bid. A decisive metal latch. */
  lock() {
    noise({ dur: 0.09, gain: 0.34, freq: 2400, type: 'bandpass', q: 1.4 });
    voice({ type: 'square', from: 260, to: 170, dur: 0.13, gain: 0.16, start: 0.02 });
  },
  /** Opposing stakes annihilating each other. */
  cancel() {
    voice({ type: 'sawtooth', from: 420, to: 120, dur: 0.34, gain: 0.13 });
    noise({ dur: 0.3, gain: 0.1, freq: 700 });
  },
  /** One cell of queen movement. */
  step(i = 0) {
    const base = 330 + (i % 4) * 28;
    voice({ type: 'sine', from: base, to: base * 1.3, dur: 0.11, gain: 0.17 });
    noise({ dur: 0.05, gain: 0.07, freq: 1800, type: 'highpass' });
  },
  /** The queen hitting the boundary. */
  wall() {
    noise({ dur: 0.36, gain: 0.42, freq: 260 });
    voice({ type: 'square', from: 130, to: 62, dur: 0.3, gain: 0.2 });
  },
  /** Nothing survived — the queen holds her ground. */
  noMove() {
    voice({ type: 'sine', from: 300, to: 240, dur: 0.26, gain: 0.13 });
  },
  /** Claiming a bonus stack. */
  bonus() {
    const notes = [660, 880, 1100, 1320];
    notes.forEach((f, i) => voice({ type: 'triangle', from: f, to: f, dur: 0.16, gain: 0.2, start: i * 0.062 }));
  },
  /** A rival locks in. Deliberately quiet. */
  rivalLock() {
    voice({ type: 'sine', from: 400, to: 400, dur: 0.05, gain: 0.07 });
  },
  /** Final five seconds. */
  tick() {
    voice({ type: 'square', from: 1150, to: 1150, dur: 0.035, gain: 0.1 });
  },
  /** A round begins. */
  roundStart() {
    voice({ type: 'sine', from: 500, to: 700, dur: 0.13, gain: 0.12 });
  },
  /** Somebody won. */
  victory() {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) =>
      voice({ type: 'triangle', from: f, to: f, dur: 0.44, gain: 0.24, start: i * 0.13 })
    );
    voice({ type: 'sine', from: 261, to: 261, dur: 1.3, gain: 0.14, start: 0.5 });
  },
  /** Generic interface press. */
  press() {
    voice({ type: 'sine', from: 460, to: 560, dur: 0.06, gain: 0.13 });
  },
  /** A rejected action. */
  deny() {
    voice({ type: 'square', from: 200, to: 140, dur: 0.16, gain: 0.15 });
  },
};

export const sound = {
  /** Call from a user gesture to unlock audio. */
  unlock() {
    ensureContext();
  },

  play(name, ...args) {
    if (audio.muted) return;
    if (!ensureContext()) return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    try {
      recipe(...args);
    } catch {
      /* audio must never break gameplay */
    }
  },

  isMuted() {
    return audio.muted;
  },

  setMuted(value) {
    audio.muted = !!value;
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, audio.muted ? '1' : '0');
    } catch {
      /* private mode */
    }
    return audio.muted;
  },

  toggle() {
    return this.setMuted(!audio.muted);
  },

  restorePreference() {
    try {
      audio.muted = localStorage.getItem(SOUND_STORAGE_KEY) === '1';
    } catch {
      audio.muted = false;
    }
    return audio.muted;
  },
};
