/* ==========================================================================
   layer.js — the contract every stratum implements.

   A stratum is a THREE.Group plus a list of materials and particle fields,
   all of which share the four uniforms the World drives globally
   (`uTime`, `uFogColor`, `uFogDensity`, `uSunDir`/`uSunFade`) and the one it
   drives locally (`uFade`, the cross-dissolve).
   ========================================================================== */

import * as THREE from 'three';
import { COMMON } from '../glsl.js';

/**
 * World-space unit vector from a surface *towards* the light. One convention
 * everywhere: `dot(N, uSunDir)` is the Lambert term, and the sun billboard
 * lives at `SUN_DIR * 900`.
 *
 * It sits low and to the right on purpose: that puts the planet's terminator
 * (and its lit crescent) across the frame at the start of the descent.
 */
export const SUN_DIR = new THREE.Vector3(0.66, 0.30, -0.69).normalize();

/** Shared uniform block, so the World can update any material generically. */
export function baseUniforms(extra = {}) {
  return Object.assign({
    uTime: { value: 0 },
    uFogColor: { value: new THREE.Color('#0a1226') },
    uFogDensity: { value: 0 },
    uFade: { value: 1 },
    uSunDir: { value: SUN_DIR.clone() },
    uSunFade: { value: 1 },
  }, extra);
}

export function makeMaterial(o) {
  const {
    vertexShader,
    fragmentShader,
    uniforms = {},
    transparent = true,
    side = THREE.FrontSide,
    blending = THREE.NormalBlending,
    depthWrite = true,
    depthTest = true,
  } = o;

  return new THREE.ShaderMaterial({
    vertexShader: COMMON + vertexShader,
    fragmentShader: COMMON + fragmentShader,
    uniforms: baseUniforms(uniforms),
    transparent,
    side,
    blending,
    depthWrite,
    depthTest,
  });
}

export class Layer {
  constructor(id, { range = [0, 1], quality = null } = {}) {
    this.id = id;
    this.range = range;              /* [from, to] progress range for fading */
    this.group = new THREE.Group();
    this.group.name = `stratum:${id}`;
    this.materials = [];
    this.fields = [];
    this.fade = 1;
    /* Point buffers are allocated at the tier the descent started in. Draw
       fractions are therefore relative to that, not to the high tier, or a
       machine that starts low and is later *upgraded* would end up with fewer
       particles than when it began. */
    this.buildScale = quality?.particleScale ?? 1;
  }

  registerMaterial(m) { this.materials.push(m); return m; }
  registerField(f) { this.fields.push(f); return f; }

  /** Cross-dissolve the whole stratum. Cheap: a few uniform writes. */
  setFade(v) {
    const f = Math.max(0, Math.min(1, v));
    if (f === this.fade) return;
    this.fade = f;
    this.group.visible = f > 0.012;
    for (const m of this.materials) {
      const u = m.uniforms.uFade;
      if (u) u.value = f;
    }
    for (const field of this.fields) field.setOpacity(f);
  }

  /** Quality tiers dial particle buffers and shader cost. */
  setQuality(q) {
    const fraction = Math.min(1, q.particles / (this.buildScale || 1));
    for (const field of this.fields) field.setDrawFraction(fraction);
  }

  /* eslint-disable-next-line no-unused-vars */
  update(ctx) {}

  /* eslint-disable-next-line no-unused-vars */
  resize(width, height) {}

  dispose() {
    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    for (const field of this.fields) field.dispose();
  }
}

/* ------------------------------ geometry -------------------------------- */

/**
 * A horizontal sheet, subdivided so the vertex shader has something to bend.
 * Used for the cloud slabs and the sea surface.
 */
export function sheetGeometry(size, segments = 1) {
  const geo = new THREE.PlaneGeometry(size, size, segments, segments);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * A tapered vertical shaft: a quad that is wide at the top and narrow at the
 * bottom, tapering to nothing. Used for the light shafts under the surface.
 */
export function shaftGeometry(topWidth, bottomWidth, height, bend = 0.18) {
  const geo = new THREE.BufferGeometry();
  const hw0 = topWidth * 0.5;
  const hw1 = bottomWidth * 0.5;
  const h = height;
  const positions = new Float32Array([
    -hw0, 0, 0,
    hw0, 0, 0,
    hw1 + bend * hw1, -h, bend * h,
    -hw1 - bend * hw1, -h, bend * h,
  ]);
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeVertexNormals();
  return geo;
}
