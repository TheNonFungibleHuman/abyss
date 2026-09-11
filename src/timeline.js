/* ==========================================================================
   timeline.js — the choreography.

   One number drives everything: `progress` (0 → 1), read from the document
   scroll position. From it this module derives the camera transform, the
   fog, the colour grade, the depth readout and which stratum is on screen.
   Nothing else in the project owns "where we are", which is what keeps the
   HUD, the audio and the picture from disagreeing with each other.
   ========================================================================== */

import * as THREE from 'three';

export const MAX_METERS = 10916;

/* The five strata, top to bottom. `from`/`to` are progress ranges; `meters`
   is the landmark depth printed on the rail (and hit exactly at `from`). */
export const STRATA = [
  {
    id: 'orbit',
    numeral: 'I',
    name: 'Orbit',
    note: 'Terminator · 0 m',
    from: 0.00,
    to: 0.19,
    meters: 0,
    caption: 'Seven thousand stars, and one planet turning slowly beneath you. From up here the weather is only a rumour of white.',
  },
  {
    id: 'deck',
    numeral: 'II',
    name: 'Cloud deck',
    note: 'Inside the weather',
    from: 0.19,
    to: 0.38,
    meters: 1240,
    caption: 'You fall straight into the weather. It is warm, and it is loud, and it does not care in the least that you are here.',
  },
  {
    id: 'sea',
    numeral: 'III',
    name: 'Sunlit sea',
    note: 'Photic zone · 4,180 m',
    from: 0.38,
    to: 0.58,
    meters: 4180,
    caption: 'The surface closes above you like a door. Light arrives in <em>shafts</em> now; everything else is blue, and then less than blue.',
  },
  {
    id: 'twilight',
    numeral: 'IV',
    name: 'Twilight',
    note: 'Disphotic zone · 7,640 m',
    from: 0.58,
    to: 0.80,
    meters: 7640,
    caption: 'Below two hundred metres the red is gone. Below a thousand, light is something you remember rather than see.',
  },
  {
    id: 'abyss',
    numeral: 'V',
    name: 'Abyss',
    note: 'The water column ends',
    from: 0.80,
    to: 1.00,
    meters: 10240,
    caption: 'Nothing down here is warm except the rock. This is the bottom of the water column: <em>10,916 metres</em>.',
  },
];

export const STRATUM_INDEX = Object.fromEntries(STRATA.map((s, i) => [s.id, i]));

/* ------------------------------ sampling -------------------------------- */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

/**
 * Sample a series of evenly spaced values with a Catmull-Rom spline.
 * Even spacing is what lets this stay a dozen lines instead of a spline
 * solver, and it is why the camera path is authored as fixed-length arrays.
 */
export function sampleSeries(values, t) {
  const n = values.length;
  const last = n - 1;
  const x = clamp01(t) * last;
  const i = Math.min(Math.floor(x), last - 1);
  const k = x - i;
  const p0 = values[Math.max(i - 1, 0)];
  const p1 = values[i];
  const p2 = values[i + 1];
  const p3 = values[Math.min(i + 2, last)];
  const k2 = k * k;
  const k3 = k2 * k;
  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * k +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * k2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * k3
  );
}

/** Sample irregularly spaced `{ t, v }` keys, smoothed between neighbours. */
export function sampleKeys(keys, t) {
  if (t <= keys[0].t) return keys[0].v;
  const lastKey = keys[keys.length - 1];
  if (t >= lastKey.t) return lastKey.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = smoothstep(a.t, b.t, t);
      return a.v + (b.v - a.v) * k;
    }
  }
  return lastKey.v;
}

/** Same, for colours. Keys must be `{ t, v: THREE.Color }`. */
const _cA = new THREE.Color();
const _cB = new THREE.Color();
export function sampleColorKeys(keys, t, out) {
  const target = out ?? new THREE.Color();
  if (t <= keys[0].t) return target.copy(keys[0].v);
  const lastKey = keys[keys.length - 1];
  if (t >= lastKey.t) return target.copy(lastKey.v);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = smoothstep(a.t, b.t, t);
      return target.copy(_cA.copy(a.v)).lerp(_cB.copy(b.v), k);
    }
  }
  return target.copy(lastKey.v);
}

/* ------------------------------ the path -------------------------------- */

/* Camera path. Eleven evenly spaced keys, t = i/10.
   y      — how far down the world we are (world units, ~1 unit ≈ 1 m of sink)
   x, z   — a slow lateral sway so the fall never feels like an elevator
   pitch  — degrees, negative looks down
   yaw    — degrees, the drift of the gaze
   roll   — degrees, the horizon tilting
   fov    — widens as we sink, which reads as acceleration */
const CAMERA = {
  y:     [0, -70, -170, -262, -360, -470, -582, -702, -842, -1000, -1150],
  x:     [0, 12, 7, -9, -4, 10, 5, -7, 3, 8, 0],
  z:     [46, 36, 24, 12, 2, -8, -18, -28, -20, -10, 2],
  pitch: [-16, -15, -13, -11, -6, 2, 6, 4, -2, -13, -16],
  yaw:   [0, 1.6, -1.2, 1.1, -1.6, 1.2, -1.0, 1.3, -0.9, 0.7, 0],
  roll:  [0, 0.5, 0.9, 0.6, -0.5, -1.0, -0.5, 0.7, 0.9, 0.4, 0],
  fov:   [52, 54, 56, 58, 60, 62, 63, 64, 65, 66, 68],
};

/* Fog. Deep water eats light mostly by distance, so exponential-squared
   fog keyed to depth does most of the "we are going down" work for free. */
const FOG = [
  { t: 0.00, v: new THREE.Color('#0a1226'), d: 0.00055 },
  { t: 0.19, v: new THREE.Color('#33506e'), d: 0.0026 },
  { t: 0.38, v: new THREE.Color('#14455e'), d: 0.0034 },
  { t: 0.58, v: new THREE.Color('#07203a'), d: 0.0044 },
  { t: 0.80, v: new THREE.Color('#03080f'), d: 0.0056 },
  { t: 1.00, v: new THREE.Color('#01030a'), d: 0.0062 },
];

/* Colour grade, per depth. These feed the post chain (see postfx.js). Bloom,
   aberration, shafts, warp and tint run in linear HDR space; vignette and
   grain run after tone mapping, so their values are display-referred. */
const GRADE = {
  bloom:      [{ t: 0.00, v: 0.55 }, { t: 0.19, v: 0.85 }, { t: 0.38, v: 0.70 }, { t: 0.58, v: 0.60 }, { t: 0.80, v: 0.72 }, { t: 1.00, v: 1.05 }],
  aberration: [{ t: 0.00, v: 0.35 }, { t: 0.19, v: 0.55 }, { t: 0.38, v: 0.80 }, { t: 0.58, v: 1.25 }, { t: 0.80, v: 1.80 }, { t: 1.00, v: 2.60 }],
  vignette:   [{ t: 0.00, v: 0.25 }, { t: 0.19, v: 0.32 }, { t: 0.38, v: 0.40 }, { t: 0.58, v: 0.55 }, { t: 0.80, v: 0.70 }, { t: 1.00, v: 0.80 }],
  grain:      [{ t: 0.00, v: 0.020 }, { t: 0.19, v: 0.026 }, { t: 0.38, v: 0.032 }, { t: 0.58, v: 0.042 }, { t: 0.80, v: 0.055 }, { t: 1.00, v: 0.065 }],
  shafts:     [{ t: 0.00, v: 0.00 }, { t: 0.19, v: 1.10 }, { t: 0.38, v: 0.95 }, { t: 0.58, v: 0.18 }, { t: 0.80, v: 0.00 }, { t: 1.00, v: 0.00 }],
  warp:       [{ t: 0.00, v: 0.00 }, { t: 0.19, v: 0.10 }, { t: 0.38, v: 0.14 }, { t: 0.58, v: 0.20 }, { t: 0.80, v: 0.38 }, { t: 1.00, v: 0.95 }],
  tintAmount: [{ t: 0.00, v: 0.05 }, { t: 0.19, v: 0.10 }, { t: 0.38, v: 0.13 }, { t: 0.58, v: 0.20 }, { t: 0.80, v: 0.27 }, { t: 1.00, v: 0.30 }],
  tint: [
    { t: 0.00, v: new THREE.Color('#12203f') },
    { t: 0.19, v: new THREE.Color('#3d6d8c') },
    { t: 0.38, v: new THREE.Color('#1c6c8e') },
    { t: 0.58, v: new THREE.Color('#123a5e') },
    { t: 0.80, v: new THREE.Color('#0a1a30') },
    { t: 1.00, v: new THREE.Color('#2a1206') },
  ],
  exposure:   [{ t: 0.00, v: 1.05 }, { t: 0.19, v: 1.08 }, { t: 0.38, v: 1.02 }, { t: 0.58, v: 0.98 }, { t: 0.80, v: 0.95 }, { t: 1.00, v: 1.10 }],
  /* How present the sun (and the sky it lights) still is. */
  sun:        [{ t: 0.00, v: 1.00 }, { t: 0.19, v: 1.00 }, { t: 0.38, v: 0.75 }, { t: 0.58, v: 0.25 }, { t: 0.80, v: 0.00 }, { t: 1.00, v: 0.00 }],
};

/* Depth gauge: piecewise through the strata landmarks so the readout can
   never disagree with the numbers printed on the rail — plus a final key at
   the bottom, without which the gauge would freeze on the last landmark
   (10,240 m) for the whole final stratum and never reach the floor. */
const DEPTH_KEYS = [
  ...STRATA.map((s) => ({ t: s.from, v: s.meters })),
  { t: 1, v: MAX_METERS },
];

export function depthAt(t) {
  return sampleKeys(DEPTH_KEYS, clamp01(t));
}

/** Opacity of a stratum's caption, given progress. */
export function captionOpacity(stratum, t) {
  const span = stratum.to - stratum.from;
  const inAt = stratum.from + span * 0.16;
  const outAt = stratum.to - span * 0.14;
  /* The opening line is up before the gate lifts, so the first stratum does
     not fade in from nothing. */
  if (t < inAt) return stratum.from === 0 ? 1 : 0;
  if (t > outAt) return 1 - smoothstep(outAt, stratum.to + span * 0.06, t);
  return 1;
}

export function stratumAt(t) {
  const p = clamp01(t);
  for (let i = STRATA.length - 1; i >= 0; i--) {
    if (p >= STRATA[i].from) return i;
  }
  return 0;
}

/* ------------------------------ the object ------------------------------ */

/** Time constant for the exponential smoothing of progress, in seconds. */
const TAU_PROGRESS = 0.17;

export class Timeline {
  constructor({ reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.motionScale = reducedMotion ? 0.3 : 1;

    this.target = 0;
    this.progress = 0;
    this.depth = 0;
    this.stratumIndex = 0;
    this.local = 0;                /* progress within the current stratum */
    this.time = 0;

    /* Base transform (look offsets are added by the caller). */
    this.camera = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0, fov: 52 };
    this.fog = { color: new THREE.Color('#0a1226'), density: 0.00055, a: 0.00055, b: 0.0026 };
    this.grade = {
      bloom: 0.85, aberration: 0.35, vignette: 0.3, grain: 0.03,
      shafts: 0, warp: 0, tintAmount: 0.05, exposure: 1,
      tint: new THREE.Color('#12203f'),
    };
    this.sunFade = 1;

    this._sample(0);
  }

  /** Jump straight to a progress value, skipping the smoothing. */
  jumpTo(p) {
    this.target = clamp01(p);
    this.progress = this.target;
    this._sample(this.progress);
  }

  /** Snap the smoothed value onto the target (used for stills/probes). */
  settle() {
    this.progress = this.target;
    this._sample(this.progress);
  }

  update(dt) {
    this.time += dt;

    /* Exponential smoothing in wall-clock time: identical behaviour at 10 fps
       and at 144 fps, which matters both for feel and for deterministic
       screenshots. */
    const k = 1 - Math.exp(-dt / TAU_PROGRESS);
    this.progress += (this.target - this.progress) * k;
    if (Math.abs(this.target - this.progress) < 1e-5) this.progress = this.target;

    this._sample(this.progress);
  }

  _sample(p) {
    const m = this.motionScale;
    const cam = this.camera;
    cam.x = sampleSeries(CAMERA.x, p) * m;
    cam.y = sampleSeries(CAMERA.y, p);
    cam.z = sampleSeries(CAMERA.z, p) * m;
    cam.pitch = sampleSeries(CAMERA.pitch, p) * m;
    cam.yaw = sampleSeries(CAMERA.yaw, p) * m;
    cam.roll = sampleSeries(CAMERA.roll, p) * m;
    cam.fov = 52 + (sampleSeries(CAMERA.fov, p) - 52) * m;

    const density = sampleKeys(FOG.map((f) => ({ t: f.t, v: f.d })), p);
    sampleColorKeys(FOG, p, this.fog.color);
    this.fog.density = density;

    const g = this.grade;
    g.bloom = sampleKeys(GRADE.bloom, p);
    g.aberration = sampleKeys(GRADE.aberration, p);
    g.vignette = sampleKeys(GRADE.vignette, p);
    g.grain = sampleKeys(GRADE.grain, p);
    g.shafts = sampleKeys(GRADE.shafts, p);
    g.warp = sampleKeys(GRADE.warp, p);
    g.tintAmount = sampleKeys(GRADE.tintAmount, p);
    g.exposure = sampleKeys(GRADE.exposure, p);
    sampleColorKeys(GRADE.tint, p, g.tint);

    this.sunFade = sampleKeys(GRADE.sun, p);

    this.depth = depthAt(p);
    this.stratumIndex = stratumAt(p);
    const s = STRATA[this.stratumIndex];
    this.local = clamp01((p - s.from) / (s.to - s.from || 1e-6));
  }

  get stratum() { return STRATA[this.stratumIndex]; }
}

export { smoothstep, clamp01 };
