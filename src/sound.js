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
  themeBus: null,
  pending: [],
  /**
   * Safari will not let an AudioContext created OUTSIDE a user gesture reach
   * the `running` state, and once it has handed back a permanently-suspended
   * context there is no way to rescue it. So construction is gated: nothing is
   * created until `noteGesture()` has been called from a real input event.
   */
  gestureSeen: false,
  /** The title theme wants to be playing; start it the moment we are able. */
  themeWanted: false,
};

/**
 * Called from real input handlers only. This is what unlocks construction.
 * Safe and cheap to call on every gesture, which is exactly how it is wired.
 */
function noteGesture() {
  audio.gestureSeen = true;
}

/** Fire everything that was queued while the hardware was asleep. */
function flushPending() {
  if (!audio.ctx || audio.ctx.state !== 'running' || !audio.pending.length) return;
  const queued = audio.pending.splice(0, audio.pending.length);
  for (const [name, args] of queued) {
    try {
      RECIPES[name]?.(...args);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The context woke up. Anything that was waiting on it goes now.
 *
 * This callback is the whole fix for Safari. `resume()` is asynchronous, and
 * Safari returns a context in `suspended` (or, after a phone call or a tab
 * switch, `interrupted`) even when it is created inside a gesture. Code that
 * checks `ctx.state === 'running'` immediately after calling `resume()` always
 * loses that race, which is why the first click produced no sound and the
 * theme never began. Reacting to `statechange` instead of guessing removes the
 * race entirely.
 */
function onContextRunning() {
  if (!audio.ctx || audio.ctx.state !== 'running') return;
  flushPending();
  if (audio.themeWanted && !audio.muted && !themePlaying) startThemeNow();
}

function ensureContext() {
  if (!audio.ctx) {
    // No gesture yet: refuse to construct. A context built at page load is a
    // context Safari will never let us use.
    if (!audio.gestureSeen) return null;
    const Ctx = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!Ctx) return null;
    try {
      audio.ctx = new Ctx();
    } catch {
      return null;
    }
    audio.master = audio.ctx.createGain();
    audio.master.gain.value = 0.55;
    audio.master.connect(audio.ctx.destination);
    // Music gets its own bus. Muting has to silence notes that were already
    // scheduled, which is only possible if they share a gain node.
    audio.themeBus = audio.ctx.createGain();
    audio.themeBus.gain.value = 1;
    audio.themeBus.connect(audio.master);
    audio.ready = true;

    try {
      audio.ctx.onstatechange = onContextRunning;
      audio.ctx.addEventListener?.('statechange', onContextRunning);
    } catch {
      /* older engines: the resume().then path below still covers us */
    }

    /**
     * A one-sample buffer started INSIDE the gesture that created the context
     * is what convinces iOS the page may make noise. Waiting for the context to
     * report `running` first guaranteed this never happened during the opening
     * click: a freshly built context is always suspended, so the kick ran later
     * from a statechange callback, which is not a gesture. That is why the first
     * click on Safari was silent and the second was the first one heard.
     */
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
    

  // 'suspended' is the autoplay lock; 'interrupted' is Safari after a call,
  // an alarm, or a background tab. Both are cured by resume().
  if (audio.ctx.state !== 'running') {
    try {
      const resumed = audio.ctx.resume();
      if (resumed && typeof resumed.then === 'function') {
        resumed.then(onContextRunning, () => {});
      }
    } catch {
      /* nothing more we can do */
    }
  }

  flushPending();

  
  

  return audio.ctx;
}

/** One shaped oscillator voice. */
function voice({ type = 'sine', from, to, start = 0, dur = 0.2, gain = 0.3, curve = 'exp', dest = null }) {
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
  g.connect(dest || audio.master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

/** Filtered noise burst, for thuds and impacts. */
function noise({ start = 0, dur = 0.25, gain = 0.3, freq = 900, q = 1, type = 'lowpass', dest = null }) {
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
  g.connect(dest || audio.master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** A struck metal note with a body — the base of most regal sounds. */
/**
 * A struck metal note. The upper partials carry most of the audible weight on
 * laptop speakers, which reproduce almost nothing below ~200 Hz, so they are
 * mixed deliberately loud relative to the fundamental.
 */
function bell({ freq, start = 0, dur = 1.1, gain = 0.34, detune = 1.004, dest = null }) {
  voice({ type: 'triangle', from: freq, to: freq, start, dur, gain, dest });
  voice({ type: 'sine', from: freq * detune, to: freq * detune, start, dur: dur * 0.9, gain: gain * 0.6, dest });
  voice({ type: 'sine', from: freq * 2.01, to: freq * 2.01, start, dur: dur * 0.5, gain: gain * 0.5, dest });
  voice({ type: 'sine', from: freq * 2.98, to: freq * 2.98, start, dur: dur * 0.3, gain: gain * 0.3, dest });
  voice({ type: 'sine', from: freq * 4.02, to: freq * 4.02, start, dur: dur * 0.16, gain: gain * 0.16, dest });
}

/** Metal-on-metal chink, for coins. */
function chink({ freq = 2100, start = 0, gain = 0.3 }) {
  noise({ start, dur: 0.05, gain: gain * 0.9, freq, type: 'bandpass', q: 8 });
  voice({ type: 'triangle', from: freq, to: freq * 0.82, start, dur: 0.09, gain: gain * 0.5 });
  voice({ type: 'sine', from: freq * 1.51, to: freq * 1.4, start: start + 0.008, dur: 0.07, gain: gain * 0.3 });
}

/* ------------------------------------------------------------------ *
 * Title theme
 *
 * A short processional in D minor — the key of ceremony and intrigue — that
 * loops under the start screen. Built from the same bell voice as the game
 * sounds so the whole thing feels of a piece. Written out as note data rather
 * than a recording: it costs nothing to ship and never needs decoding.
 * ------------------------------------------------------------------ */

const NOTE = {
  D3: 146.8, A3: 220.0, B3: 246.9, D4: 293.7, E4: 329.6, Fs4: 370.0,
  G4: 392.0, A4: 440.0, B4: 493.9, Cs5: 554.4, D5: 587.3, E5: 659.3,
  Fs5: 740.0, G5: 784.0, A5: 880.0, B5: 987.8, D6: 1174.7,
};

/**
 * A coronation processional in D major. Dotted, brass-style fanfare figures
 * over a stately bass — the sound of a court announcing itself rather than
 * plotting in the dark. [beat, frequency, beats-long, level]
 */
const THEME_MELODY = [
  // fanfare call
  [0, NOTE.D5, 0.75, 0.30], [0.75, NOTE.D5, 0.25, 0.22],
  [1, NOTE.Fs5, 1, 0.30], [2, NOTE.A5, 1.5, 0.32], [3.5, NOTE.G5, 0.5, 0.22],
  [4, NOTE.Fs5, 1, 0.28], [5, NOTE.E5, 1, 0.26], [6, NOTE.D5, 2, 0.30],
  // answering phrase, a step lower and gentler
  [8, NOTE.A4, 0.75, 0.26], [8.75, NOTE.B4, 0.25, 0.2],
  [9, NOTE.Cs5, 1, 0.28], [10, NOTE.D5, 1.5, 0.3], [11.5, NOTE.E5, 0.5, 0.22],
  [12, NOTE.Fs5, 1, 0.3], [13, NOTE.E5, 1, 0.26],
  [14, NOTE.D5, 2, 0.34],
];

/** Sustained roots: D — G — A — D. A plain, ceremonial cadence. */
const THEME_BASS = [
  [0, NOTE.D3, 4, 0.22], [4, NOTE.G4 / 2, 4, 0.22],
  [8, NOTE.A3, 4, 0.22], [12, NOTE.D3, 4, 0.24],
];

/** High bells answering the fanfare, like distant tower chimes. */
const THEME_CHIME = [
  [2.5, NOTE.D6, 1.5, 0.13], [6.5, NOTE.A5, 1.5, 0.12],
  [10.5, NOTE.Fs5, 1, 0.11], [14.5, NOTE.D6, 2, 0.16],
];

const BEAT = 0.50; // seconds — a measured, ceremonial tread
const THEME_BEATS = 16;

let themeTimer = null;
let themePlaying = false;
let themeStartedAt = 0;

/** Flatten the three parts into one time-ordered list of notes. */
const THEME_NOTES = [
  ...THEME_MELODY.map(([b, f, l, g]) => ({ b, f, l: l * 1.5, g: g * 0.7, kind: 'bell' })),
  ...THEME_BASS.map(([b, f, l, g]) => ({ b, f, l, g, kind: 'bass' })),
  ...THEME_CHIME.map(([b, f, l, g]) => ({ b, f, l: l * 2, g, kind: 'bell' })),
].sort((x, y) => x.b - y.b);

/**
 * Schedule only the notes falling inside a short lookahead window, then come
 * back for more. Scheduling the whole loop at once was why muting the music
 * had no effect until the phrase finished — the notes were already committed.
 */
function themeTick() {
  if (!themePlaying || audio.muted || !audio.ctx) return;
  const ctx = audio.ctx;
  const LOOKAHEAD = 0.55;
  const loopLen = THEME_BEATS * BEAT;

  const from = ctx.currentTime - themeStartedAt;
  const to = from + LOOKAHEAD;

  for (const n of THEME_NOTES) {
    for (let loop = 0; loop < 3; loop++) {
      const at = n.b * BEAT + loop * loopLen;
      if (at < from || at >= to) continue;
      const start = themeStartedAt + at - ctx.currentTime;
      if (start < 0) continue;
      if (n.kind === 'bell') {
        bell({ freq: n.f, start, dur: n.l * BEAT, gain: n.g, dest: audio.themeBus });
      } else {
        voice({ type: 'triangle', from: n.f, to: n.f, start, dur: n.l * BEAT, gain: n.g, dest: audio.themeBus });
        voice({ type: 'sine', from: n.f * 2, to: n.f * 2, start, dur: n.l * BEAT * 0.7, gain: n.g * 0.5, dest: audio.themeBus });
      }
    }
  }

  // Roll the clock back a loop so the phrase repeats seamlessly.
  if (from > loopLen) themeStartedAt += loopLen;

  themeTimer = setTimeout(themeTick, 220);
}

const RECIPES = {
  /**
   * A coin struck onto a stone table. Real coins ring high and short, with a
   * touch of scatter — the pitch lifts as the stack grows.
   */
  coinAdd(step = 0) {
    const f = 1950 + Math.min(step, 8) * 70;
    chink({ freq: f, gain: 0.34 });
    chink({ freq: f * 1.28, start: 0.035, gain: 0.16 });
    voice({ type: 'sine', from: 190, to: 150, dur: 0.07, gain: 0.09 });
  },

  /** Sliding a coin back off the table. */
  coinRemove() {
    noise({ dur: 0.12, gain: 0.22, freq: 1500, type: 'bandpass', q: 3 });
    voice({ type: 'triangle', from: 900, to: 520, dur: 0.13, gain: 0.22 });
  },

  /** Committing. A heavy iron bolt driven home. */
  lock() {
    noise({ dur: 0.07, gain: 0.45, freq: 900, type: 'lowpass' });
    voice({ type: 'square', from: 320, to: 150, dur: 0.17, gain: 0.26 });
    bell({ freq: 392, dur: 0.75, gain: 0.26, start: 0.04 });
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
    bell({ freq: 293.7, dur: 0.95, gain: 0.3 });
    bell({ freq: 311.1, dur: 0.9, gain: 0.27, start: 0.02 });
    noise({ dur: 0.3, gain: 0.1, freq: 400 });
  },

  /** The queen is moving. A rising open fifth: the tug succeeded. */
  moveStart() {
    bell({ freq: 392.0, dur: 0.5, gain: 0.3 });
    bell({ freq: 587.3, dur: 0.6, gain: 0.28, start: 0.09 });
  },

  /** One measured footfall on stone. */
  step(i = 0) {
    const base = 320 + (i % 3) * 22;
    voice({ type: 'triangle', from: base, to: base * 0.86, dur: 0.14, gain: 0.26 });
    noise({ dur: 0.07, gain: 0.16, freq: 1400, type: 'bandpass', q: 1.5 });
  },

  /** The queen arriving after a successful pull. */
  moveEnd() {
    bell({ freq: 659.3, dur: 0.7, gain: 0.3 });
    bell({ freq: 987.8, dur: 0.85, gain: 0.24, start: 0.07 });
  },

  /** Stone against stone: the boundary. */
  wall() {
    noise({ dur: 0.45, gain: 0.55, freq: 600, type: 'lowpass' });
    voice({ type: 'square', from: 220, to: 90, dur: 0.34, gain: 0.3 });
    bell({ freq: 220, dur: 0.5, gain: 0.2, start: 0.03 });
  },

  /** Treasure claimed. A bright cascade over a held root. */
  bonus() {
    [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => chink({ freq: f * 2, start: i * 0.07, gain: 0.26 }));
    bell({ freq: 523.3, dur: 1.2, gain: 0.3, start: 0.05 });
    bell({ freq: 784.0, dur: 1.0, gain: 0.24, start: 0.22 });
  },

  /** A rival commits. Barely there on purpose. */
  rivalLock() {
    voice({ type: 'triangle', from: 440, to: 400, dur: 0.08, gain: 0.12 });
  },

  /** Final seconds. A courtroom clock. */
  tick() {
    noise({ dur: 0.045, gain: 0.34, freq: 2400, type: 'bandpass', q: 4 });
    voice({ type: 'square', from: 1400, to: 1200, dur: 0.05, gain: 0.16 });
  },

  /** A new round opens. */
  roundStart() {
    bell({ freq: 523.3, dur: 0.45, gain: 0.22 });
  },

  /** The game begins. A short fanfare on an open fifth. */
  gameStart() {
    bell({ freq: 392.0, dur: 0.9, gain: 0.32 });
    bell({ freq: 523.3, dur: 0.9, gain: 0.3, start: 0.13 });
    bell({ freq: 784.0, dur: 1.5, gain: 0.3, start: 0.26 });
  },

  /** Victory. A full major cadence with a low bell under it. */
  victory() {
    // Rising fanfare, then a held major chord with a bright cascade over it.
    [392.0, 523.3, 659.3, 784.0].forEach((f, i) =>
      bell({ freq: f, dur: 0.7, gain: 0.34, start: i * 0.13 })
    );
    [523.3, 659.3, 784.0, 1046.5].forEach((f) =>
      bell({ freq: f, dur: 2.6, gain: 0.3, start: 0.56 })
    );
    [1046.5, 1318.5, 1568.0, 2093.0].forEach((f, i) =>
      chink({ freq: f, start: 0.62 + i * 0.09, gain: 0.24 })
    );
    voice({ type: 'triangle', from: 261.6, to: 261.6, start: 0.56, dur: 2.8, gain: 0.22 });
  },

  /** A player took a seat. */
  join() {
    bell({ freq: 587.3, dur: 0.5, gain: 0.28 });
    bell({ freq: 880, dur: 0.6, gain: 0.24, start: 0.08 });
  },

  /** Interface press. */
  press() {
    voice({ type: 'triangle', from: 523, to: 659, dur: 0.08, gain: 0.18 });
  },

  /** Rejected. */
  deny() {
    voice({ type: 'square', from: 320, to: 190, dur: 0.18, gain: 0.24 });
  },
};

/** Actually begin the processional. Only ever called on a running context. */
function startThemeNow() {
  const ctx = audio.ctx;
  if (!ctx || ctx.state !== 'running' || audio.muted || themePlaying) return;
  themePlaying = true;
  themeStartedAt = ctx.currentTime + 0.12;
  if (audio.themeBus) audio.themeBus.gain.setValueAtTime(1, ctx.currentTime);
  themeTick();
}

export const sound = {
  /**
   * Ask for the looping title theme. Safe to call repeatedly, including before
   * any gesture has happened: the request is remembered and honoured the
   * instant the context reports `running`, so the very first tap starts the
   * music even on Safari, where `resume()` resolves a beat later.
   */
  startTheme() {
    audio.themeWanted = true;
    if (audio.muted || themePlaying) return;
    const ctx = ensureContext();
    if (!ctx) return; // no gesture yet — onContextRunning will pick this up
    startThemeNow();
  },

  /** Silences the music immediately, including notes already scheduled. */
  stopTheme() {
    audio.themeWanted = false;
    themePlaying = false;
    if (themeTimer) clearTimeout(themeTimer);
    themeTimer = null;
    if (audio.themeBus && audio.ctx) {
      try {
        const now = audio.ctx.currentTime;
        const g = audio.themeBus.gain;
        g.cancelScheduledValues?.(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(0.0001, now + 0.06);
      } catch {
        // Older engines lack some AutomationRate methods; fall back to a
        // hard cut, which is still better than letting the phrase play out.
        try {
          audio.themeBus.gain.value = 0.0001;
        } catch {
          /* give up silently */
        }
      }
    }
  },

  isThemePlaying() {
    return themePlaying;
  },

  /**
   * Call from any user gesture. This is the ONLY thing that permits the audio
   * context to be constructed, so it must be wired to real input events and
   * never called speculatively at page load.
   */
  unlock() {
    noteGesture();
    return !!ensureContext();
  },

  /**
   * Safari suspends audio when the tab is hidden, when a call arrives, or when
   * the screen locks, and does not always resume it on return. Call this from
   * `visibilitychange` / `focus` / `pageshow` to nudge it awake again.
   */
  resumeIfInterrupted() {
    if (!audio.ctx || audio.muted) return;
    if (audio.ctx.state === 'running') return;
    try {
      const r = audio.ctx.resume();
      if (r && typeof r.then === 'function') r.then(onContextRunning, () => {});
    } catch {
      /* ignore */
    }
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
    // Not awake yet: hold it and fire once the context reports running.
    if (ctx.state !== 'running') {
      if (audio.pending.length < 12) audio.pending.push([name, args]);
      return;
    }
    try {
      recipe(...args);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('sound failed:', name, err);
    }
  },

  isMuted() {
    return audio.muted;
  },

  setMuted(value) {
    audio.muted = !!value;
    if (audio.muted) this.stopTheme();
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
