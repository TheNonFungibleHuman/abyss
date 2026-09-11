/* ==========================================================================
   world/index.js — the world.

   Owns the five strata, the sun, and the two things that must be true for
   every material in the project:

     1. fog, sun and time uniforms are written in one pass, so no stratum can
        drift out of sync with the timeline;
     2. strata cross-dissolve on a single schedule, so the camera is never
        alone between two layers.
   ========================================================================== */

import * as THREE from 'three';
import { Sun } from './sun.js';
import { OrbitLayer } from './orbit.js';
import { DeckLayer } from './deck.js';
import { SeaLayer } from './sea.js';
import { TwilightLayer } from './twilight.js';
import { AbyssLayer } from './abyss.js';
import { smoothstep } from '../timeline.js';

/**
 * Cross-dissolve schedule, in progress units. Overlap is deliberate: each
 * stratum fades in while the previous one is still fading out.
 *
 * A degenerate window (`[a, a]`) means "instant" — used to have the first
 * stratum already on screen at t = 0, and the last one never leave.
 */
const FADE = {
  orbit:    { in: [0.00, 0.00], out: [0.21, 0.30] },
  deck:     { in: [0.13, 0.21], out: [0.37, 0.46] },
  sea:      { in: [0.33, 0.41], out: [0.57, 0.67] },
  twilight: { in: [0.53, 0.61], out: [0.79, 0.89] },
  abyss:    { in: [0.75, 0.83], out: [1.00, 1.00] },
};

function fadeAt(w, t) {
  const fin = w.in[1] <= w.in[0]
    ? (t >= w.in[0] ? 1 : 0)
    : smoothstep(w.in[0], w.in[1], t);
  const fout = w.out[1] <= w.out[0]
    ? 1
    : 1 - smoothstep(w.out[0], w.out[1], t);
  return Math.min(fin, fout);
}

export class World {
  constructor({ scene, quality }) {
    this.scene = scene;
    this.layers = [];
    this.materials = [];
    this.fields = [];

    this.sun = new Sun();
    scene.add(this.sun.object3D);

    this.layers.push(
      new OrbitLayer({ quality }),
      new DeckLayer({ quality }),
      new SeaLayer({ quality }),
      new TwilightLayer({ quality }),
      new AbyssLayer({ quality })
    );

    for (const layer of this.layers) {
      scene.add(layer.group);
      this.materials.push(...layer.materials);
      this.fields.push(...layer.fields);
    }

    /* Apply the starting tier's draw fractions explicitly, so the buffers'
     * initial state is the tier's state rather than "whatever drawRange
     * defaults to". */
    this.setQuality(quality);

    /* Put the strata in their 0 m state before anything is drawn: the warm-up
     * frames happen before the first tick, and without this every stratum
     * would be visible for them. */
    this.applyFades(0);

    this.sunScreen = this.sun.screen;
  }

  /** Cross-dissolve every stratum for a given progress. */
  applyFades(t) {
    for (const layer of this.layers) layer.setFade(fadeAt(FADE[layer.id], t));
  }

  /**
   * @param {object} ctx
   * @param {number} ctx.time       seconds since the descent began
   * @param {number} ctx.t          smoothed progress, 0..1
   * @param {number} ctx.pixelRatio renderer pixel ratio
   * @param {object} ctx.camera     the live camera
   * @param {object} ctx.timeline   the timeline (for fog + sun fade)
   */
  update(ctx) {
    const { time, t, pixelRatio, camera, timeline } = ctx;
    const fog = timeline.fog;

    for (const m of this.materials) {
      const u = m.uniforms;
      u.uTime.value = time;
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density;
      u.uSunFade.value = timeline.sunFade;
    }

    for (const field of this.fields) {
      field.update({ time, fogDensity: fog.density, pixelRatio });
    }

    /* Fades first, so a stratum that becomes visible this frame also gets its
       update this frame. */
    this.applyFades(t);

    for (const layer of this.layers) {
      if (layer.group.visible) layer.update(ctx);
    }

    this.sun.update(camera, timeline.sunFade, time);
  }

  setQuality(quality) {
    for (const layer of this.layers) layer.setQuality(quality);
  }

  dispose() {
    for (const layer of this.layers) layer.dispose();
    this.sun.dispose();
  }
}
