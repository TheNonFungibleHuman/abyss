/* ==========================================================================
   quality.js — three tiers, and the machinery to fall back a tier on its own.

   `particleScale` is a *build-time* multiplier: it decides how big the point
   buffers are. `particles` is the fraction of that buffer to draw at runtime,
   which is how a tier change costs nothing but a drawRange update. Both are
   relative to the high tier, so the rule is simply: a descent that starts at a
   lower tier can never gain particles by being upgraded mid-flight.
   ========================================================================== */

export const TIERS = {
  high: {
    id: 'high',
    dpr: 2,
    particleScale: 1.0,
    particles: 1.0,
    bloomScale: 0.5,
    shaftTaps: 16,
  },
  medium: {
    id: 'medium',
    dpr: 1.5,
    particleScale: 0.62,
    particles: 0.62,
    bloomScale: 0.42,
    shaftTaps: 11,
  },
  low: {
    id: 'low',
    dpr: 1,
    particleScale: 0.34,
    particles: 0.34,
    bloomScale: 0.3,
    shaftTaps: 7,
  },
};

export const TIER_ORDER = ['low', 'medium', 'high'];

export function tierById(id) {
  return TIERS[id] ?? TIERS.medium;
}

/** Best guess for this device, before a single frame has been measured. */
export function detectTier() {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = navigator.deviceMemory ?? 8;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;

  if (coarse || small) return cores >= 6 && memory >= 4 ? TIERS.medium : TIERS.low;
  if (cores <= 4 || memory <= 4) return TIERS.medium;
  return TIERS.high;
}

/**
 * Watches frame times and steps down a tier when the machine cannot hold the
 * frame rate. It only ever steps *down*: oscillating between tiers is far
 * more objectionable than running one tier low.
 *
 * The decision is made over a wall-clock window rather than a fixed number of
 * frames. A frame count cannot work here: the slower the machine, the longer
 * it takes to collect the samples that prove it is slow, which is exactly
 * backwards. A sparse sample count inside the window is itself the signal.
 */
export class QualityManager {
  constructor({ initial, onChange }) {
    this.onChange = onChange;
    this.current = initial;
    this.auto = true;
    this.degraded = false;

    this._samples = [];
    this._window = 0;
    this._grace = 0;
    this.windowSeconds = 1.6;
  }

  setManual(tier) {
    this.auto = false;
    this._apply(tier);
  }

  setAuto() {
    this.auto = true;
  }

  /** @param {number} dt frame time in seconds, unclamped by the caller */
  note(dt) {
    if (!this.auto || this.degraded) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    /* Ignore the opening moments: first-touch uploads and shader compilation
       make the first frames unrepresentative, and a wrong downgrade here is
       permanent. */
    this._grace += dt;
    if (this._grace < 1.0) return;

    this._samples.push(Math.min(dt, 5));
    this._window += Math.min(dt, 5);
    if (this._window < this.windowSeconds) return;

    const n = this._samples.length;
    const measured = n / this._window;                 /* frames per second */
    const sorted = this._samples.slice().sort((a, b) => a - b);
    const median = 1 / Math.max(sorted[Math.floor(n / 2)], 1e-4);

    this._samples.length = 0;
    this._window = 0;

    /* Enough samples for the median to mean something; otherwise trust the
       raw rate, which for a handful of frames is all there is. */
    const fps = n >= 18 ? Math.min(median, measured) : measured;

    const next = fps < 26 ? 'low' : fps < 42 ? 'medium' : null;
    if (next && TIER_ORDER.indexOf(next) < TIER_ORDER.indexOf(this.current.id)) {
      this.degraded = true;
      this.lastFps = fps;
      this._apply(TIERS[next]);
    }
  }

  _apply(tier) {
    if (tier.id === this.current.id) return;
    this.current = tier;
    this.onChange?.(tier);
  }
}
