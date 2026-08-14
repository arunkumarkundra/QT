/**
 * QUEEN'S TUG — Seeded randomness (Spec §17)
 *
 * The RNG cursor is stored *inside* authoritative game state, not in a module
 * closure. That means a GameState can be cloned, serialized, replayed or
 * rewound and it will produce exactly the same future random sequence. Bugs
 * and disputed games are therefore reproducible from `seed` alone.
 */

/** Hash an arbitrary string into a 32-bit integer seed. */
export function hashSeed(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Bind an RNG to a state-like object carrying a numeric `rngState` field.
 * Every draw advances `holder.rngState`, so randomness is part of game state.
 */
export function rngFor(holder) {
  return {
    next() {
      holder.rngState = (holder.rngState + 0x6d2b79f5) | 0;
      let t = holder.rngState;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Integer in [0, n). */
    int(n) {
      return Math.floor(this.next() * n);
    },
    /** Integer in [lo, hi] inclusive. */
    range(lo, hi) {
      return lo + this.int(hi - lo + 1);
    },
    pick(arr) {
      return arr[this.int(arr.length)];
    },
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = this.int(i + 1);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
  };
}

/** A standalone RNG for non-authoritative uses (AI jitter, UI flourishes). */
export function standaloneRng(seed) {
  const holder = { rngState: hashSeed(seed) | 0 };
  return rngFor(holder);
}

/** Human-friendly game number, e.g. "QT-7F3K91". */
export function makeGameNumber(rng) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[rng.int(alphabet.length)];
  return `QT-${out}`;
}
