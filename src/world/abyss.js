/* ==========================================================================
   abyss.js — stratum V: the core.

   The bottom of the water column. Everything here is emissive rather than
   lit — a plasma sphere wrapped in a soft aura, embers coming off it, and
   cold rock catching a rim of its heat.
   ========================================================================== */

import * as THREE from 'three';
import { NOISE, FOG } from '../glsl.js';
import { Layer, makeMaterial } from './layer.js';
import { ParticleField } from '../particles.js';

const CORE_CENTER = new THREE.Vector3(0, -1230, -300);
const CORE_RADIUS = 72;

/* --------------------------------- core --------------------------------- */

const CORE_VERT = /* glsl */ `
varying vec3 vNormalW;
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const CORE_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uCenter;
uniform vec3 uCool;
uniform vec3 uHot;
uniform float uIntensity;

varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 d = normalize(vWorldPos - uCenter);

  /* Slow convection: ridged noise for filaments, plain fBm for the bulk.
     Skewed hard towards the cool end so the surface reads as hot filaments in
     cooling crust, rather than as one uniformly pale ball. */
  float fil = ridged(d * 3.4 + vec3(0.0, uTime * 0.05, 0.0));
  float bulk = fbm3o(d * 7.5 - vec3(uTime * 0.03, 0.0, uTime * 0.02));
  float heat = clamp(fil * 0.62 + bulk * 0.30, 0.0, 1.0);
  heat = pow(heat, 2.0);

  float breathe = 0.88 + 0.12 * sin(uTime * 0.42);

  vec3 col = mix(uCool, uHot, heat);
  /* The limb is where the plasma is seen edge-on, so it burns brighter. */
  col += uHot * fresnel(N, V, 2.6) * 0.9;
  col *= uIntensity * breathe;

  gl_FragColor = vec4(col, uFade);
}
`;

/* --------------------------------- aura --------------------------------- */

const AURA_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const AURA_FRAG = /* glsl */ `
${FOG}

uniform vec3 uColor;
uniform float uIntensity;
uniform float uCoreFrac;   /* core radius as a fraction of this quad's half-size */

varying vec2 vUv;

void main() {
  float r = length(vUv - 0.5) * 2.0;

  /* Nothing in front of the core. The aura is a ring around the core's
     silhouette, not a disc behind it: without this hole the glow is added on
     top of the plasma and turns it into a flat tan ball. */
  float outside = smoothstep(uCoreFrac * 0.90, uCoreFrac * 1.30, r);
  float halo = pow(max(0.0, 1.0 - r), 2.6);

  float energy = halo * outside * uIntensity
               * (0.92 + 0.08 * sin(uTime * 0.42));
  gl_FragColor = vec4(uColor * energy, uFade);
}
`;

/* --------------------------------- rock --------------------------------- */

const ROCK_VERT = /* glsl */ `
${NOISE}

uniform float uWobble;

varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec3 p = position;
  float n = fbm3o(p * 1.6);
  p += normalize(position) * (n - 0.5) * uWobble;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const ROCK_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uCenter;
uniform vec3 uRock;
uniform vec3 uWarm;

varying vec3 vNormalW;
varying vec3 vWorldPos;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);

  /* Lit by the core, not by the sun: the light direction is simply the
     direction from the core to this fragment. */
  vec3 L = normalize(vWorldPos - uCenter);
  float lit = smoothstep(-0.25, 0.75, dot(N, L));

  vec3 col = uRock * (0.05 + lit * 0.55);
  col += uWarm * pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), 1.7) * lit * 0.9;

  col = applyFog(col, distance(cameraPosition, vWorldPos));
  gl_FragColor = vec4(col, uFade);
}
`;

export class AbyssLayer extends Layer {
  constructor({ quality }) {
    super('abyss', { range: [0.74, 1.0], quality });

    /* --- plasma core --- */
    this.coreMaterial = this.registerMaterial(makeMaterial({
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      uniforms: {
        uCenter: { value: CORE_CENTER.clone() },
        uCool: { value: new THREE.Color('#3a0a01') },
        uHot: { value: new THREE.Color('#ffb066') },
        uIntensity: { value: 0.85 },
      },
      transparent: true,
      depthWrite: true,
    }));

    const coreSegs = quality.tier === 'high' ? 96 : 48;
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(CORE_RADIUS, coreSegs, coreSegs * 0.66),
      this.coreMaterial
    );
    this.core.position.copy(CORE_CENTER);
    this.group.add(this.core);

    /* --- aura, as a camera-facing billboard --- */
    this.auraMaterial = this.registerMaterial(makeMaterial({
      vertexShader: AURA_VERT,
      fragmentShader: AURA_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color('#ff9a45') },
        uIntensity: { value: 0.75 },
        uCoreFrac: { value: 0.5 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    }));
    this.aura = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.auraMaterial);
    this.aura.scale.setScalar(CORE_RADIUS * 4);
    this.aura.position.copy(CORE_CENTER);
    this.aura.renderOrder = 5;
    this.group.add(this.aura);

    /* --- embers --- */
    this.embers = this.registerField(new ParticleField({
      count: Math.round(1500 * quality.particleScale),
      shape: 'column',
      extent: { radius: 300, span: 620 },
      size: [1.2, 5.0],
      colorA: [1.0, 0.42, 0.12],
      colorB: [1.0, 0.89, 0.68],
      blending: 'additive',
      opacity: 0.5,
      rise: 6,
      swirl: 0.015,
      wander: 5,
      twinkle: 0.55,
      twinkleSpeed: 1.1,
      soft: 0.95,
      refDist: 90,
      maxSize: 30,
      fogInfluence: 0.45,
    }));
    this.embers.object3D.position.copy(CORE_CENTER);
    this.group.add(this.embers.object3D);

    /* --- cold rock, lit only by the core --- */
    this.rockMaterial = this.registerMaterial(makeMaterial({
      vertexShader: ROCK_VERT,
      fragmentShader: ROCK_FRAG,
      uniforms: {
        uCenter: { value: CORE_CENTER.clone() },
        uRock: { value: new THREE.Color('#1b1a1c') },
        uWarm: { value: new THREE.Color('#ff7a2e') },
        uWobble: { value: 0.34 },
      },
      transparent: true,
      depthWrite: true,
    }));

    this.rocks = [];
    const rocks = quality.tier === 'low' ? 4 : 7;
    for (let i = 0; i < rocks; i++) {
      const size = 18 + Math.random() * 46;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 2), this.rockMaterial);
      /* Two of the seven are pulled round to the sides of the core, close
         enough to its z plane that they overlap the glow: dark shapes against
         the light, which is the shot that says "the rock is warm". The rest
         sit strictly behind and below, where they add depth without ever
         crossing the camera-to-core line. */
      const silhouette = i < 2;
      mesh.position.set(
        (i % 2 === 0 ? -1 : 1) * (silhouette ? 95 + Math.random() * 42 : 110 + Math.random() * 320),
        CORE_CENTER.y + (silhouette ? -20 + Math.random() * 92 : -30 - Math.random() * 190),
        CORE_CENTER.z - (silhouette ? 4 + Math.random() * 36 : 40 + Math.random() * 320)
      );
      mesh.userData.spin = (Math.random() - 0.5) * 0.012;
      mesh.userData.phase = Math.random() * Math.PI * 2;
      this.rocks.push(mesh);
      this.group.add(mesh);
    }
  }

  update(ctx) {
    this.aura.quaternion.copy(ctx.camera.quaternion);
    this.embers.object3D.position.y = CORE_CENTER.y;
    for (const rock of this.rocks) {
      rock.rotation.y = rock.userData.phase + ctx.time * rock.userData.spin;
    }
  }
}
