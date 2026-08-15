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
  kicked: false,
};

/**
 * Browsers refuse to start audio until a real user gesture, and Safari in
 * particular will hand back a context stuck in "suspended" or "interrupted"
 * that silently swallows everything scheduled on it. So: create on demand,
 * resume on EVERY call, and kick the hardware awake with a silent buffer the
 * first time. Cheap, and it removes an entire class of "no sound" bug.
 */
function ensureContext() {
  if (!audio.ctx) {
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return null;
    try {
      audio.ctx = new Ctx();
    } catch {
      return null;
    }
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.38;
    audio.master.connect(audio.ctx.destination);
    audio.ready = true;
  }

  if (audio.ctx.state !== 'running') {
    try {
      const resumed = audio.ctx.resume();
      if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {});
    } catch {
      /* nothing more we can do */
    }
  }

  if (!audio.kicked) {
    audio.kicked = true;
    try {
      const buf = audio.ctx.createBuffer(1, 1, audio.ctx.sampleRate);
      const src = audio.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(audio.ctx.destination);
      src.start(0);
    } catch {
      /* harmless */
    }
  }

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

/** A struck metal note with a body — the base of most regal sounds. */
function bell({ freq, start = 0, dur = 1.1, gain = 0.22, detune = 1.004 }) {
  voice({ type: 'sine', from: freq, to: freq, start, dur, gain });
  voice({ type: 'sine', from: freq * detune, to: freq * detune, start, dur: dur * 0.9, gain: gain * 0.55 });
  voice({ type: 'sine', from: freq * 2.01, to: freq * 2.01, start, dur: dur * 0.45, gain: gain * 0.28 });
  voice({ type: 'sine', from: freq * 2.98, to: freq * 2.98, start, dur: dur * 0.25, gain: gain * 0.14 });
}

/** Metal-on-metal chink, for coins. */
function chink({ freq = 2100, start = 0, gain = 0.2 }) {
  noise({ start, dur: 0.05, gain: gain * 0.9, freq, type: 'bandpass', q: 8 });
  voice({ type: 'triangle', from: freq, to: freq * 0.82, start, dur: 0.09, gain: gain * 0.5 });
  voice({ type: 'sine', from: freq * 1.51, to: freq * 1.4, start: start + 0.008, dur: 0.07, gain: gain * 0.3 });
}

const RECIPES = {
  /**
   * A coin struck onto a stone table. Real coins ring high and short, with a
   * touch of scatter — the pitch lifts as the stack grows.
   */
  coinAdd(step = 0) {
    const f = 1950 + Math.min(step, 8) * 70;
    chink({ freq: f, gain: 0.22 });
    chink({ freq: f * 1.28, start: 0.035, gain: 0.1 });
    voice({ type: 'sine', from: 190, to: 150, dur: 0.07, gain: 0.09 });
  },

  /** Sliding a coin back off the table. */
  coinRemove() {
    noise({ dur: 0.11, gain: 0.13, freq: 1500, type: 'bandpass', q: 3 });
    voice({ type: 'triangle', from: 900, to: 520, dur: 0.12, gain: 0.13 });
  },

  /** Committing. A heavy iron bolt driven home. */
  lock() {
    noise({ dur: 0.06, gain: 0.3, freq: 320, type: 'lowpass' });
    voice({ type: 'square', from: 150, to: 88, dur: 0.16, gain: 0.16 });
    bell({ freq: 196, dur: 0.7, gain: 0.11, start: 0.04 });
  },

  /** The moment stakes are counted. A low council-chamber swell. */
  cancel() {
    voice({ type: 'sawtooth', from: 118, to: 92, dur: 0.55, gain: 0.09 });
    voice({ type: 'sine', from: 236, to: 184, dur: 0.5, gain: 0.07 });
    noise({ dur: 0.45, gain: 0.05, freq: 500 });
  },

  /**
   * Nothing survived. A hollow, unresolved minor second — deliberately
   * unsatisfying, so a stalemate never feels like progress.
   */
  noMove() {
    bell({ freq: 146.8, dur: 0.9, gain: 0.15 });
    bell({ freq: 155.6, dur: 0.85, gain: 0.13, start: 0.02 });
    noise({ dur: 0.3, gain: 0.05, freq: 300 });
  },

  /** The queen is moving. A rising open fifth: the tug succeeded. */
  moveStart() {
    bell({ freq: 261.6, dur: 0.5, gain: 0.16 });
    bell({ freq: 392.0, dur: 0.6, gain: 0.14, start: 0.09 });
  },

  /** One measured footfall on stone. */
  step(i = 0) {
    const base = 320 + (i % 3) * 22;
    voice({ type: 'sine', from: base, to: base * 0.86, dur: 0.13, gain: 0.13 });
    noise({ dur: 0.06, gain: 0.06, freq: 900, type: 'bandpass', q: 1.5 });
  },

  /** The queen arriving after a successful pull. */
  moveEnd() {
    bell({ freq: 523.3, dur: 0.7, gain: 0.15 });
    bell({ freq: 659.3, dur: 0.8, gain: 0.11, start: 0.06 });
  },

  /** Stone against stone: the boundary. */
  wall() {
    noise({ dur: 0.45, gain: 0.4, freq: 190, type: 'lowpass' });
    voice({ type: 'square', from: 96, to: 48, dur: 0.34, gain: 0.17 });
    bell({ freq: 110, dur: 0.5, gain: 0.09, start: 0.03 });
  },

  /** Treasure claimed. A bright cascade over a held root. */
  bonus() {
    [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => chink({ freq: f * 2, start: i * 0.07, gain: 0.16 }));
    bell({ freq: 523.3, dur: 1.2, gain: 0.16, start: 0.05 });
    bell({ freq: 784.0, dur: 1.0, gain: 0.12, start: 0.22 });
  },

  /** A rival commits. Barely there on purpose. */
  rivalLock() {
    voice({ type: 'sine', from: 220, to: 200, dur: 0.07, gain: 0.05 });
  },

  /** Final seconds. A courtroom clock. */
  tick() {
    noise({ dur: 0.03, gain: 0.09, freq: 2600, type: 'bandpass', q: 6 });
  },

  /** A new round opens. */
  roundStart() {
    bell({ freq: 392.0, dur: 0.5, gain: 0.1 });
  },

  /** The game begins. A short fanfare on an open fifth. */
  gameStart() {
    bell({ freq: 261.6, dur: 0.9, gain: 0.17 });
    bell({ freq: 392.0, dur: 0.9, gain: 0.15, start: 0.13 });
    bell({ freq: 523.3, dur: 1.4, gain: 0.16, start: 0.26 });
  },

  /** Victory. A full major cadence with a low bell under it. */
  victory() {
    [523.3, 659.3, 784.0, 1046.5].forEach((f, i) =>
      bell({ freq: f, dur: 1.5, gain: 0.19, start: i * 0.16 })
    );
    bell({ freq: 130.8, dur: 2.4, gain: 0.14, start: 0.5 });
    bell({ freq: 196.0, dur: 2.2, gain: 0.1, start: 0.55 });
  },

  /** A player took a seat. */
  join() {
    bell({ freq: 440, dur: 0.5, gain: 0.13 });
    bell({ freq: 660, dur: 0.6, gain: 0.1, start: 0.08 });
  },

  /** Interface press. */
  press() {
    voice({ type: 'sine', from: 330, to: 392, dur: 0.07, gain: 0.1 });
  },

  /** Rejected. */
  deny() {
    voice({ type: 'square', from: 160, to: 112, dur: 0.17, gain: 0.13 });
  },
};

export const sound = {
  /** Call from any user gesture. Safe and cheap to call repeatedly. */
  unlock() {
    return !!ensureContext();
  },

  /** True once the hardware is actually running. */
  isRunning() {
    return !!audio.ctx && audio.ctx.state === 'running';
  },

  play(name, ...args) {
    if (audio.muted) return;
    const ctx = ensureContext();
    if (!ctx) return;
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
