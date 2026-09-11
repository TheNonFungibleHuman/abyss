/* ==========================================================================
   sun.js — the light source, as a camera-facing billboard.

   Its world position is fixed at SUN_DIR * 900: at the start of the descent
   it sits at the top-right edge of frame, and as the camera sinks it climbs
   out of the frustum by itself. That is exactly the behaviour the light
   shafts want — no manual animation involved.
   ========================================================================== */

import * as THREE from 'three';
import { FOG } from '../glsl.js';
import { SUN_DIR, makeMaterial } from './layer.js';

const DISTANCE = 900;
const SIZE = 260;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
${FOG}

uniform vec3 uCore;
uniform vec3 uGlow;
uniform float uIntensity;

varying vec2 vUv;

void main() {
  vec2 p = vUv - 0.5;
  float r = length(p) * 2.0;

  float disc = smoothstep(1.0, 0.0, r * 4.4);
  float halo = pow(max(0.0, 1.0 - r), 3.0);
  float streakH = pow(max(0.0, 1.0 - abs(p.y) * 11.0), 2.0)
                * pow(max(0.0, 1.0 - abs(p.x) * 2.05), 2.0);
  float streakV = pow(max(0.0, 1.0 - abs(p.x) * 16.0), 2.0)
                * pow(max(0.0, 1.0 - abs(p.y) * 2.4), 2.0);

  float energy = uIntensity * uSunFade;
  vec3 color = uCore * disc * 2.2
             + uGlow * halo * 0.30
             + uGlow * (streakH * 0.22 + streakV * 0.08);

  float alpha = clamp(disc + halo * 0.75 + streakH * 0.4 + streakV * 0.18, 0.0, 1.0);

  /* Additive: the colour carries the energy, alpha carries only the shape. */
  gl_FragColor = vec4(color * energy, alpha);
}
`;

export class Sun {
  constructor() {
    this.material = makeMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCore: { value: new THREE.Color('#fff4e2') },
        uGlow: { value: new THREE.Color('#9cc8ff') },
        uIntensity: { value: 1 },
        uSunFade: { value: 1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.scale.setScalar(SIZE);
    this.mesh.position.copy(SUN_DIR).multiplyScalar(DISTANCE);
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;

    /* Projected screen position of the sun, for the shaft pass. */
    this.screen = new THREE.Vector2(0.5, 1.3);
    this._v = new THREE.Vector3();
  }

  get object3D() { return this.mesh; }

  update(camera, sunFade, time) {
    this.material.uniforms.uSunFade.value = sunFade;
    /* Billboard without a sprite: match the camera's orientation exactly. */
    this.mesh.quaternion.copy(camera.quaternion);

    this._v.copy(camera.position).addScaledVector(SUN_DIR, DISTANCE);
    this._v.project(camera);
    this.screen.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
    void time;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
