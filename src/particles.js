/* ==========================================================================
   particles.js — one GPU particle system, reused by every stratum.

   Nothing animates on the CPU: each particle carries a random seed and its
   motion (rising, swirling around the column, wandering, twinkling) is
   evaluated in the vertex shader from `uTime`. A field of 6,000 drifting
   specks therefore costs one draw call and zero per-frame JavaScript.
   ========================================================================== */

import * as THREE from 'three';
import { ROT2 } from './glsl.js';

const VERT = /* glsl */ `
${ROT2}

attribute vec3 aSeed;    /* four random values per particle, 0..1 */
attribute float aScale;
attribute float aTint;

uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uRefDist;
uniform float uSpan;          /* vertical wrap range, in world units */
uniform float uRise;          /* units/second, +up / -down */
uniform float uSwirl;         /* radians/second around the column axis */
uniform float uWander;        /* lateral wander amplitude, world units */
uniform float uTwinkle;
uniform float uTwinkleSpeed;
uniform float uMaxSize;

varying float vTint;
varying float vTwinkle;
varying float vDepth;

void main() {
  vec3 p = position;

  /* Wrap a continuously drifting column so a finite buffer reads as endless. */
  if (abs(uRise) > 0.00001) {
    float speed = uRise * (0.35 + aSeed.x * 1.35);
    p.y = mod(p.y + uTime * speed + uSpan * 0.5, uSpan) - uSpan * 0.5;
  }

  if (abs(uSwirl) > 0.00001) {
    float a = uSwirl * uTime * (0.4 + aSeed.y * 1.2);
    p.xz = rot2(a * 0.6 + aSeed.z * 6.2831) * p.xz;
  }

  if (uWander > 0.0) {
    p.x += sin(uTime * 0.13 + aSeed.y * 6.2831) * uWander;
    p.z += cos(uTime * 0.10 + aSeed.z * 6.2831) * uWander;
    p.y += sin(uTime * 0.17 + aSeed.x * 6.2831) * uWander * 0.5;
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  float dist = max(-mv.z, 0.001);
  float size = uSize * aScale * uPixelRatio * (uRefDist / dist);
  gl_PointSize = clamp(size, 0.7, uMaxSize * uPixelRatio);

  vTint = aTint;
  vDepth = dist;
  vTwinkle = mix(
    1.0,
    0.45 + 0.55 * sin(uTime * uTwinkleSpeed + aSeed.x * 43.0 + aSeed.y * 17.0),
    uTwinkle
  );
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
uniform float uSoft;          /* 0 = hard disc, 1 = fully soft falloff */
uniform float uFogDensity;
uniform float uAdditive;      /* 1 = additive field, 0 = normal blend */

varying float vTint;
varying float vTwinkle;
varying float vDepth;

void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float alpha = 1.0 - smoothstep(mix(0.55, 0.0, uSoft), 1.0, d);
  if (alpha <= 0.002) discard;

  float fog = exp(-pow(uFogDensity * vDepth, 2.0));

  vec3 color = mix(uColorA, uColorB, vTint) * vTwinkle;
  float opacity = alpha * uOpacity * vTwinkle;

  /* Deep water eats colour; normal-blended fields must lose alpha instead,
     or distant specks fade into grey mush instead of disappearing. */
  if (uAdditive > 0.5) {
    color *= fog;
  } else {
    opacity *= fog;
  }

  gl_FragColor = vec4(color, opacity);
}
`;

function rand(min, max) { return min + Math.random() * (max - min); }

export class ParticleField {
  /**
   * @param {object} o
   * @param {number} o.count            how many particles to allocate
   * @param {'column'|'box'|'shell'} o.shape
   * @param {object} o.extent           column: {radius, span}; box: {x,y,z}; shell: {radius, thickness}
   * @param {number[]} o.size           [min, max] base point size
   * @param {[number,number,number]} o.colorA
   * @param {[number,number,number]} o.colorB
   * @param {'additive'|'normal'} o.blending
   */
  constructor(o) {
    const opts = Object.assign({
      count: 2000,
      shape: 'column',
      extent: { radius: 100, span: 200 },
      size: [0.5, 2.2],
      colorA: [0.6, 0.8, 1.0],
      colorB: [1.0, 1.0, 1.0],
      blending: 'additive',
      opacity: 1,
      rise: 0,
      swirl: 0,
      wander: 0,
      twinkle: 0.6,
      twinkleSpeed: 2.0,
      soft: 0.85,
      refDist: 120,
      maxSize: 42,
      fogInfluence: 0.55,
    }, o);

    this.opts = opts;
    this.count = opts.count;

    const position = new Float32Array(opts.count * 3);
    const aSeed = new Float32Array(opts.count * 3);
    const aScale = new Float32Array(opts.count);
    const aTint = new Float32Array(opts.count);

    for (let i = 0; i < opts.count; i++) {
      const i3 = i * 3;
      let x = 0, y = 0, z = 0;

      if (opts.shape === 'shell') {
        /* Even-ish distribution over a sphere shell. */
        const u = Math.random() * 2 - 1;
        const theta = Math.random() * Math.PI * 2;
        const r = opts.extent.radius * (1 - Math.random() * (opts.extent.thickness ?? 0.35));
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        x = r * s * Math.cos(theta);
        y = r * u;
        z = r * s * Math.sin(theta);
      } else if (opts.shape === 'box') {
        x = rand(-opts.extent.x, opts.extent.x);
        y = rand(-opts.extent.y, opts.extent.y);
        z = rand(-opts.extent.z, opts.extent.z);
      } else {
        /* column: uniform-ish disc cross-section, evenly spread vertically */
        const r = opts.extent.radius * Math.sqrt(Math.random());
        const theta = Math.random() * Math.PI * 2;
        x = r * Math.cos(theta);
        y = rand(-opts.extent.span * 0.5, opts.extent.span * 0.5);
        z = r * Math.sin(theta);
      }

      position[i3] = x;
      position[i3 + 1] = y;
      position[i3 + 2] = z;

      aSeed[i3] = Math.random();
      aSeed[i3 + 1] = Math.random();
      aSeed[i3 + 2] = Math.random();

      aScale[i] = rand(opts.size[0], opts.size[1]);
      /* Bias tints toward the dim end: a few bright particles read better
         than a uniform field of identical dots. */
      aTint[i] = Math.pow(Math.random(), 1.7);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 3));
    geometry.setAttribute('aScale', new THREE.BufferAttribute(aScale, 1));
    geometry.setAttribute('aTint', new THREE.BufferAttribute(aTint, 1));
    /* Static bounds: the shader moves particles, so three cannot know them.
       A generous sphere keeps frustum culling from popping fields out. */
    geometry.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(0, 0, 0),
      Math.max(opts.extent.radius ?? 0, opts.extent.x ?? 0, opts.extent.z ?? 0, 1) * 2 +
      (opts.extent.span ?? opts.extent.y ?? 0)
    );

    this.uniforms = {
      uTime: { value: 0 },
      uSize: { value: 2 },
      uPixelRatio: { value: 1 },
      uRefDist: { value: opts.refDist },
      uSpan: { value: opts.extent.span ?? opts.extent.y ?? 100 },
      uRise: { value: opts.rise },
      uSwirl: { value: opts.swirl },
      uWander: { value: opts.wander },
      uTwinkle: { value: opts.twinkle },
      uTwinkleSpeed: { value: opts.twinkleSpeed },
      uMaxSize: { value: opts.maxSize },
      uColorA: { value: new THREE.Color(...opts.colorA) },
      uColorB: { value: new THREE.Color(...opts.colorB) },
      uOpacity: { value: opts.opacity },
      uSoft: { value: opts.soft },
      uFogDensity: { value: 0 },
      uAdditive: { value: opts.blending === 'additive' ? 1 : 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: opts.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = true;
    this.points.matrixAutoUpdate = true;

    this.baseOpacity = opts.opacity;
    this.geometry = geometry;
  }

  get object3D() { return this.points; }

  /** External fade, multiplied into whatever the field's own opacity is. */
  setOpacity(v) { this.uniforms.uOpacity.value = this.baseOpacity * v; }

  /** Fraction of the buffer to draw — the cheap dial for quality tiers. */
  setDrawFraction(f) {
    const n = Math.max(1, Math.floor(this.count * f));
    this.geometry.setDrawRange(0, n);
  }

  update({ time, fogDensity, pixelRatio }) {
    this.uniforms.uTime.value = time;
    this.uniforms.uPixelRatio.value = pixelRatio;
    /* Fields only take a fraction of the scene fog: full strength would erase
       the very particles that are meant to suggest depth. */
    this.uniforms.uFogDensity.value = fogDensity * this.opts.fogInfluence;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
