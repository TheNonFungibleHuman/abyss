/* ==========================================================================
   orbit.js — stratum I: the nebula dome, the starfield, and the planet.

   Everything here is procedural: the planet is a sphere whose continents,
   clouds, ice caps and night-side city lights are all fBm evaluated in the
   fragment shader, and the starfield is one instanced point cloud.
   ========================================================================== */

import * as THREE from 'three';
import { NOISE, FOG } from '../glsl.js';
import { Layer, SUN_DIR, makeMaterial } from './layer.js';
import { ParticleField } from '../particles.js';

const PLANET_CENTER = new THREE.Vector3(0, -380, -320);
const PLANET_RADIUS = 230;

/* ------------------------------- sky dome ------------------------------- */

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = normalize(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DOME_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uNebulaA;
uniform vec3 uNebulaB;

varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);

  vec3 col = mix(uHorizon, uZenith, pow(up, 0.85));

  /* Two drifting cloud systems, the second one denser and warmer, so the
     sky reads as depth rather than as a gradient. */
  float c1 = fbm3o(d * 2.4 + vec3(0.0, 0.0, uTime * 0.004));
  float c2 = fbm3o(d * 5.7 + vec3(uTime * 0.006, 3.1, 0.0));
  col += uNebulaA * pow(max(c1 - 0.32, 0.0), 1.6) * 0.55;
  col += uNebulaB * pow(max(c2 - 0.46, 0.0), 2.0) * 0.35;

  /* A faint galactic band across the sky. */
  float band = exp(-pow(d.y * 5.5, 2.0));
  col += uNebulaA * band * (0.10 + 0.22 * c1) * 0.22;

  /* Daylight bleeding in from the sun's side of the sky. */
  float sd = max(dot(d, uSunDir), 0.0);
  col += vec3(0.36, 0.44, 0.62) * pow(sd, 8.0) * 0.14 * uSunFade;
  col += vec3(0.12, 0.18, 0.30) * pow(sd, 2.2) * 0.03 * uSunFade;

  gl_FragColor = vec4(col, uFade);
}
`;

/* -------------------------------- planet -------------------------------- */

const PLANET_VERT = /* glsl */ `
varying vec3 vWorldPos;
varying vec3 vNormalW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const PLANET_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uCenter;
uniform float uRadius;
uniform vec3 uOceanDeep;
uniform vec3 uOceanShallow;
uniform vec3 uLandLow;
uniform vec3 uLandHigh;
uniform vec3 uIce;

varying vec3 vWorldPos;
varying vec3 vNormalW;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 d = normalize(vWorldPos - uCenter);

  float dist = distance(cameraPosition, vWorldPos);

  /* ---- surface ---- */
  float h = fbm(d * 3.1 + 11.3);
  float detail = fbm3o(d * 12.0);
  float land = smoothstep(0.470, 0.545, h + detail * 0.08);
  float shade = smoothstep(0.30, 0.95, h + detail * 0.30);

  vec3 ocean = mix(uOceanDeep, uOceanShallow, detail);
  vec3 ground = mix(uLandLow, uLandHigh, shade);
  vec3 albedo = mix(ocean, ground, land);

  float capLat = abs(d.y);
  float ice = smoothstep(0.74, 0.93, capLat - detail * 0.05);
  albedo = mix(albedo, uIce, ice);

  /* ---- weather ---- */
  float cA = fbm(d * 5.2 + vec3(uTime * 0.0035, 0.0, 0.0));
  float cB = fbm3o(d * 1.9 + 4.4);
  float cloud = smoothstep(0.50, 0.76, cA) * smoothstep(0.34, 0.60, cB);
  albedo = mix(albedo, vec3(0.80, 0.85, 0.92), cloud * 0.8);

  /* ---- lighting ---- */
  float ndl = dot(N, uSunDir);
  float day = smoothstep(-0.10, 0.34, ndl);

  vec3 col = albedo * (0.03 + 0.80 * day);

  /* Specular glint off the open ocean. */
  float spec = pow(max(dot(reflect(-uSunDir, N), V), 0.0), 48.0);
  col += vec3(1.0, 0.95, 0.86) * spec * (1.0 - land) * 0.55 * day;

  /* Night side: city lights, only where there is land and no ice. */
  float night = 1.0 - day;
  float cities = step(0.70, fbm3o(d * 52.0)) * land * (1.0 - ice) * (1.0 - cloud);
  col += vec3(1.0, 0.60, 0.24) * cities * night * 0.85;

  /* ---- atmosphere ---- */
  float rim = fresnel(N, V, 3.0);
  float litLimb = smoothstep(-0.55, 0.55, ndl);
  col += vec3(0.26, 0.55, 1.0) * rim * litLimb * 0.42;
  col += vec3(0.10, 0.22, 0.45) * rim * 0.10;

  col = applyFog(col, dist);
  gl_FragColor = vec4(col, uFade);
}
`;

/* ----------------------------- atmosphere halo --------------------------- */

const HALO_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const HALO_FRAG = /* glsl */ `
${FOG}

uniform vec3 uColor;

varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  /* Rendered from the inside of a slightly larger sphere: the grazing
     fragments near the limb are the ones that glow. */
  float rim = pow(1.0 - abs(dot(N, V)), 2.6);
  float lit = smoothstep(-0.5, 0.65, dot(N, uSunDir));
  float energy = rim * (0.10 + lit) * 0.30;
  gl_FragColor = vec4(uColor * energy, energy * uFade);
}
`;

/* --------------------------------- layer -------------------------------- */

export class OrbitLayer extends Layer {
  constructor({ quality }) {
    super('orbit', { range: [0, 0.30], quality });

    /* The dome and the stars are, for all practical purposes, infinitely far
       away, so they ride a sub-group that follows the camera. The planet is
       in world space and stays put — that distinction is the whole reason
       this sub-group exists. */
    this.sky = new THREE.Group();
    this.group.add(this.sky);

    /* --- sky dome --- */
    this.domeMaterial = this.registerMaterial(makeMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: {
        uZenith: { value: new THREE.Color('#01030a') },
        uHorizon: { value: new THREE.Color('#0a1730') },
        uNebulaA: { value: new THREE.Color('#2b3f78') },
        uNebulaB: { value: new THREE.Color('#5b2c5e') },
      },
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    }));
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1600, 40, 26), this.domeMaterial);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.sky.add(this.dome);

    /* --- starfield: a dim dense shell plus a few bright anchors --- */
    this.stars = this.registerField(new ParticleField({
      count: Math.round(6200 * quality.particleScale),
      shape: 'shell',
      extent: { radius: 1250, thickness: 0.55 },
      size: [0.9, 3.4],
      colorA: [0.62, 0.76, 1.0],
      colorB: [1.0, 1.0, 1.0],
      blending: 'additive',
      twinkle: 0.85,
      twinkleSpeed: 1.7,
      soft: 0.75,
      refDist: 760,
      maxSize: 26,
      fogInfluence: 0.35,
      opacity: 0.95,
    }));
    this.sky.add(this.stars.object3D);

    this.brightStars = this.registerField(new ParticleField({
      count: Math.round(560 * quality.particleScale),
      shape: 'shell',
      extent: { radius: 1250, thickness: 0.5 },
      size: [2.4, 6.2],
      colorA: [0.85, 0.92, 1.0],
      colorB: [1.0, 0.94, 0.86],
      blending: 'additive',
      twinkle: 0.6,
      twinkleSpeed: 0.9,
      soft: 0.9,
      refDist: 760,
      maxSize: 40,
      fogInfluence: 0.35,
      opacity: 0.9,
    }));
    this.sky.add(this.brightStars.object3D);

    /* --- planet --- */
    this.planetMaterial = this.registerMaterial(makeMaterial({
      vertexShader: PLANET_VERT,
      fragmentShader: PLANET_FRAG,
      uniforms: {
        uCenter: { value: PLANET_CENTER.clone() },
        uRadius: { value: PLANET_RADIUS },
        uOceanDeep: { value: new THREE.Color('#04101f') },
        uOceanShallow: { value: new THREE.Color('#0d3c66') },
        uLandLow: { value: new THREE.Color('#1b2415') },
        uLandHigh: { value: new THREE.Color('#5c5335') },
        uIce: { value: new THREE.Color('#c3d3e2') },
      },
      transparent: true,
      depthWrite: true,
    }));
    this.planet = new THREE.Mesh(new THREE.SphereGeometry(PLANET_RADIUS, 96, 64), this.planetMaterial);
    this.planet.position.copy(PLANET_CENTER);
    this.group.add(this.planet);

    this.haloMaterial = this.registerMaterial(makeMaterial({
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: { uColor: { value: new THREE.Color('#4f8fd8') } },
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    }));
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(PLANET_RADIUS * 1.06, 64, 44), this.haloMaterial);
    this.halo.position.copy(PLANET_CENTER);
    this.group.add(this.halo);
  }

  update(ctx) {
    /* Pin the sky to the camera, minus a couple of percent so the descent
       still reads as movement. The planet is untouched: it is real geometry
       at a real distance, and the camera flies past it. */
    const p = ctx.camera.position;
    this.sky.position.set(p.x * 0.98, p.y * 0.98, p.z * 0.98);
  }
}
