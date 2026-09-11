/* ==========================================================================
   sea.js — stratum III: the surface, and what is under it.

   The camera crosses the waterline around t = 0.44 and spends the rest of the
   stratum below it, so the surface is authored to be read from underneath: a
   ceiling of caustics with the sun's azimuth burning through it, hanging
   light shafts, and a rising column of bubbles.
   ========================================================================== */

import * as THREE from 'three';
import { NOISE, CAUSTICS, FOG } from '../glsl.js';
import { Layer, SUN_DIR, makeMaterial, shaftGeometry } from './layer.js';
import { ParticleField } from '../particles.js';

const SURFACE_Y = -430;
const SURFACE_SIZE = 2600;

/* ------------------------------- surface -------------------------------- */

const SURFACE_VERT = /* glsl */ `
${NOISE}

varying vec3 vWorldPos;

void main() {
  vec3 p = position;
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;

  /* A long swell plus a fine chop. Kept modest: the interesting detail is in
     the caustics, not in the silhouette. */
  float swell = sin(wp.x * 0.018 + uTime * 0.55) * 3.4
              + sin(wp.z * 0.023 - uTime * 0.42) * 2.8
              + sin((wp.x + wp.z) * 0.011 + uTime * 0.31) * 4.2;
  float chop = (vnoise(vec3(wp.xz * 0.06, uTime * 0.5)) - 0.5) * 3.0;
  p.y += swell + chop;

  vec4 wpos = modelMatrix * vec4(p, 1.0);
  vWorldPos = wpos.xyz;
  gl_Position = projectionMatrix * viewMatrix * wpos;
}
`;

const SURFACE_FRAG = /* glsl */ `
${NOISE}
${CAUSTICS}
${FOG}

uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uGlint;

varying vec3 vWorldPos;

void main() {
  vec3 wp = vWorldPos;
  vec3 V = normalize(cameraPosition - wp);
  float dist = distance(cameraPosition, wp);

  /* --- caustics, in two scales, sliding across the ceiling --- */
  float c1 = caustics(wp.xz * 0.7, uTime * 0.35, 0.22);
  float c2 = caustics(wp.xz * 0.22 + 31.0, uTime * 0.22, 0.10);
  float caus = clamp(c1 * 0.75 + c2 * 0.55, 0.0, 1.4);

  /* --- how much of the sky is coming through this bit of surface --- */
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0001));
  vec2 toFrag = normalize(wp.xz - cameraPosition.xz + vec2(0.0001));
  float sunAzimuth = max(dot(sunFlat.xz, toFrag), 0.0);

  float upward = clamp(abs(V.y), 0.0, 1.0);
  /* Looking straight up you see through the window; at grazing angles the
     surface turns into a mirror and the water below goes dark. */
  float window = pow(upward, 0.55);

  float glint = pow(sunAzimuth, 3.2) * (0.55 + 0.45 * window);

  vec3 col = mix(uDeep, uShallow, window * 0.6);
  col += uShallow * caus * (0.35 + 0.65 * window) * 0.75;
  col += uGlint * glint * (0.20 + 0.45 * uSunFade);

  /* A faint rim of reflected light along the horizon line where the surface
     runs away from the camera. */
  col += uShallow * (1.0 - upward) * 0.06;

  col = applyFog(col, dist);
  gl_FragColor = vec4(col, uFade);
}
`;

/* ------------------------------ light shafts ----------------------------- */

const SHAFT_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vec3 p = position;
  /* Sway the beam slightly along its length. */
  p.x += sin(uTime * 0.25 + uv.y * 3.0) * uv.y * 1.6;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHAFT_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uColor;
uniform vec3 uColorDeep;
uniform float uStrength;
uniform float uPhase;

varying vec2 vUv;
varying vec3 vWorldPos;

void main() {
  float across = 1.0 - abs(vUv.x - 0.5) * 2.0;
  across = pow(max(across, 0.0), 1.7);

  /* Brightest at the surface, gone before the beam ends. */
  float along = pow(clamp(1.0 - vUv.y, 0.0, 1.0), 1.5);

  float flicker = 0.72 + 0.28 * sin(uTime * 0.6 + uPhase)
                       + 0.12 * sin(uTime * 1.7 + uPhase * 2.3);
  float breaks = 0.55 + 0.65 * fbm3o(vec3(vUv * vec2(2.2, 5.0), uTime * 0.09 + uPhase));

  float dist = distance(cameraPosition, vWorldPos);
  float fog = exp(-pow(uFogDensity * dist, 2.0));

  float energy = across * along * flicker * breaks * uStrength * uSunFade * fog;

  vec3 col = mix(uColorDeep, uColor, clamp(vUv.y * 1.4, 0.0, 1.0));

  /* Additive, so the colour carries the whole contribution and alpha only
     carries the cross-dissolve. */
  gl_FragColor = vec4(col * energy, uFade);
}
`;

export class SeaLayer extends Layer {
  constructor({ quality }) {
    super('sea', { range: [0.32, 0.68], quality });

    /* --- the surface --- */
    this.surfaceMaterial = this.registerMaterial(makeMaterial({
      vertexShader: SURFACE_VERT,
      fragmentShader: SURFACE_FRAG,
      uniforms: {
        uDeep: { value: new THREE.Color('#03182c') },
        uShallow: { value: new THREE.Color('#2f9ec4') },
        uGlint: { value: new THREE.Color('#ffeacb') },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
    }));

    const segs = quality.tier === 'high' ? 110 : quality.tier === 'medium' ? 72 : 44;
    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(SURFACE_SIZE, SURFACE_SIZE, segs, segs),
      this.surfaceMaterial
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = SURFACE_Y;
    this.group.add(surface);

    /* --- shafts: one material each, so each can carry its own strength --- */
    this.shafts = [];
    const shaftCount = Math.round(18 * Math.min(1, quality.particleScale + 0.25));
    for (let i = 0; i < shaftCount; i++) {
      const angle = (i / shaftCount) * Math.PI * 2 + Math.random() * 0.5;
      const radius = 40 + Math.random() * 300;
      const px = Math.cos(angle) * radius;
      const pz = Math.sin(angle) * radius;

      /* Brighter when the beam is on the sun's side of the descent. */
      const toShaft = new THREE.Vector2(px, pz).normalize();
      const toSun = new THREE.Vector2(SUN_DIR.x, SUN_DIR.z).normalize();
      const facing = Math.max(toShaft.dot(toSun), 0);
      const strength = 0.10 + 0.55 * Math.pow(facing, 2.2) + Math.random() * 0.10;

      const material = this.registerMaterial(makeMaterial({
        vertexShader: SHAFT_VERT,
        fragmentShader: SHAFT_FRAG,
        uniforms: {
          uColor: { value: new THREE.Color('#dff2ff') },
          uColorDeep: { value: new THREE.Color('#2f88b8') },
          uStrength: { value: strength },
          uPhase: { value: Math.random() * 10 },
        },
        transparent: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
      }));

      const length = 260 + Math.random() * 240;
      const mesh = new THREE.Mesh(
        shaftGeometry(16 + Math.random() * 26, 40 + Math.random() * 60, length),
        material
      );
      mesh.position.set(px, SURFACE_Y - 4, pz);
      mesh.rotation.y = Math.random() * Math.PI;
      mesh.rotation.z = (Math.random() - 0.5) * 0.16;
      mesh.userData.drift = 0.2 + Math.random() * 0.5;
      mesh.userData.phase = Math.random() * Math.PI * 2;
      mesh.userData.baseRoll = mesh.rotation.z;
      this.shafts.push(mesh);
      this.group.add(mesh);
    }

    /* --- bubbles, rising past the camera --- */
    this.bubbles = this.registerField(new ParticleField({
      count: Math.round(640 * quality.particleScale),
      shape: 'column',
      extent: { radius: 190, span: 520 },
      size: [1.4, 4.6],
      colorA: [0.30, 0.68, 0.85],
      colorB: [0.92, 0.99, 1.0],
      blending: 'additive',
      opacity: 0.5,
      rise: 9,
      wander: 3.2,
      twinkle: 0.18,
      twinkleSpeed: 1.4,
      soft: 0.95,
      refDist: 70,
      maxSize: 26,
      fogInfluence: 0.45,
    }));
    this.bubbles.object3D.position.y = -560;
    this.group.add(this.bubbles.object3D);

    /* --- suspended matter: gives the water a body, not just a ceiling --- */
    this.silt = this.registerField(new ParticleField({
      count: Math.round(1700 * quality.particleScale),
      shape: 'column',
      extent: { radius: 260, span: 520 },
      size: [0.7, 2.4],
      colorA: [0.34, 0.52, 0.62],
      colorB: [0.80, 0.92, 0.95],
      blending: 'normal',
      opacity: 0.45,
      rise: -1.4,
      wander: 2.0,
      twinkle: 0.3,
      twinkleSpeed: 0.8,
      soft: 1.0,
      refDist: 80,
      maxSize: 14,
      fogInfluence: 0.85,
    }));
    this.silt.object3D.position.y = -600;
    this.group.add(this.silt.object3D);
  }

  update(ctx) {
    const p = ctx.camera.position;
    this.bubbles.object3D.position.x = p.x;
    this.bubbles.object3D.position.z = p.z;
    this.silt.object3D.position.x = p.x;
    this.silt.object3D.position.z = p.z;

    for (const shaft of this.shafts) {
      shaft.rotation.z = shaft.userData.baseRoll
        + Math.sin(ctx.time * 0.2 + shaft.userData.phase) * 0.02;
    }
  }
}
