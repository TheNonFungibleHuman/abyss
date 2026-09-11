/* ==========================================================================
   twilight.js — stratum IV: the disphotic zone.

   Almost no light, so the picture is carried by three things: dense marine
   snow for a sense of scale, a few bioluminescent specks that flash, and the
   silhouettes of large soft bodies drifting through, lit only on their rims.
   ========================================================================== */

import * as THREE from 'three';
import { NOISE, FOG } from '../glsl.js';
import { Layer, makeMaterial } from './layer.js';
import { ParticleField } from '../particles.js';

const BODY_VERT = /* glsl */ `
${NOISE}

uniform float uWobble;

varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vShape;

void main() {
  vec3 p = position;

  /* Grow the body organically: displacement along the normal, driven by fBm
     in object space, breathing slowly. */
  float n = fbm3o(p * 0.9 + vec3(0.0, uTime * 0.05, 0.0));
  p += normalize(position) * (n - 0.5) * uWobble;

  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorldPos = wp.xyz;
  vNormalW = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vShape = n;

  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BODY_FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uRim;
uniform vec3 uBody;
uniform float uRimPower;
uniform float uGlow;

varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vShape;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float dist = distance(cameraPosition, vWorldPos);

  /* Backlit silhouette: the body stays near-black and the rim catches what
     little light is left, roughly from the direction of the surface. */
  float rim = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uRimPower);
  float fromAbove = clamp(N.y * 0.5 + 0.5, 0.0, 1.0);
  float pulse = 0.75 + 0.25 * sin(uTime * 0.7 + vShape * 24.0);

  vec3 col = uBody * (0.25 + 0.5 * fromAbove);
  col += uRim * rim * (0.35 + 0.65 * fromAbove) * uGlow * pulse * uSunFade;

  col = applyFog(col, dist);
  gl_FragColor = vec4(col, uFade);
}
`;

export class TwilightLayer extends Layer {
  constructor({ quality }) {
    super('twilight', { range: [0.52, 0.90], quality });

    /* --- marine snow --- */
    this.snow = this.registerField(new ParticleField({
      count: Math.round(7000 * quality.particleScale),
      shape: 'column',
      extent: { radius: 200, span: 380 },
      size: [0.6, 2.6],
      colorA: [0.42, 0.56, 0.68],
      colorB: [0.94, 0.98, 1.0],
      blending: 'normal',
      opacity: 0.5,
      rise: -1.6,
      wander: 1.6,
      twinkle: 0.35,
      twinkleSpeed: 0.6,
      soft: 1.0,
      refDist: 90,
      maxSize: 12,
      fogInfluence: 0.8,
    }));
    this.group.add(this.snow.object3D);

    /* --- bioluminescence: few, bright, flashing --- */
    this.glow = this.registerField(new ParticleField({
      count: Math.round(340 * quality.particleScale),
      shape: 'column',
      extent: { radius: 185, span: 340 },
      size: [3.0, 9.0],
      colorA: [0.18, 0.85, 1.0],
      colorB: [0.85, 0.45, 1.0],
      blending: 'additive',
      opacity: 0.85,
      rise: -0.6,
      swirl: 0.02,
      wander: 4.0,
      twinkle: 1.0,
      twinkleSpeed: 1.3,
      soft: 1.0,
      refDist: 120,
      maxSize: 46,
      fogInfluence: 0.5,
    }));
    this.group.add(this.glow.object3D);

    /* --- drifting bodies --- */
    this.bodyMaterial = this.registerMaterial(makeMaterial({
      vertexShader: BODY_VERT,
      fragmentShader: BODY_FRAG,
      uniforms: {
        uRim: { value: new THREE.Color('#5fb6d8') },
        uBody: { value: new THREE.Color('#040a12') },
        uRimPower: { value: 2.4 },
        uGlow: { value: 0.55 },
        uWobble: { value: 0.55 },
      },
      transparent: true,
      depthWrite: true,
      depthTest: true,
    }));

    this.bodies = [];
    const count = quality.tier === 'low' ? 7 : 12;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 90 + Math.random() * 300;
      const size = 16 + Math.random() * 42;
      const geo = Math.random() < 0.55
        ? new THREE.IcosahedronGeometry(size, 3)
        : new THREE.SphereGeometry(size, 20, 14);

      const mesh = new THREE.Mesh(geo, this.bodyMaterial);
      mesh.position.set(
        Math.cos(angle) * radius,
        -560 - Math.random() * 300,
        Math.sin(angle) * radius
      );
      mesh.userData.rise = 1.4 + Math.random() * 2.6;
      mesh.userData.spin = (Math.random() - 0.5) * 0.05;
      mesh.userData.phase = Math.random() * Math.PI * 2;
      mesh.userData.baseY = mesh.position.y;
      mesh.userData.baseX = mesh.position.x;
      this.bodies.push(mesh);
      this.group.add(mesh);
    }
  }

  update(ctx) {
    const p = ctx.camera.position;
    this.snow.object3D.position.set(p.x, p.y, p.z);
    this.glow.object3D.position.set(p.x, p.y, p.z);

    for (const body of this.bodies) {
      const { spin, phase, baseY, baseX, rise } = body.userData;
      /* Bounded oscillations rather than accumulating drift: nothing pops,
         and a body is in the same place whether or not frames were skipped. */
      body.position.y = baseY + Math.sin(ctx.time * 0.055 * rise + phase) * 95;
      body.position.x = baseX + Math.sin(ctx.time * 0.031 + phase * 1.7) * 22;
      body.rotation.y = phase + ctx.time * spin;
      body.rotation.x = phase * 0.5 + ctx.time * spin * 0.6;
    }
    void p;
  }
}
