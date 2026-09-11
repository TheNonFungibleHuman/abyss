/* ==========================================================================
   deck.js — stratum II: the cloud deck.

   A stack of horizontal sheets rather than a volume: they are cheap, they
   give real parallax as the camera falls between them, and because each sheet
   is its own mesh three sorts them back-to-front for correct blending. Each
   sheet is displaced by fBm in the vertex shader and its underside is lit by
   a billow term plus a silver lining around the sun's azimuth.
   ========================================================================== */

import * as THREE from 'three';
import { NOISE, FOG } from '../glsl.js';
import { Layer, makeMaterial } from './layer.js';
import { ParticleField } from '../particles.js';

const SHEETS = 46;
const TOP_Y = -140;
const BOTTOM_Y = -540;
const SPREAD = 460;           /* half-width of each sheet */

const VERT = /* glsl */ `
${NOISE}

varying vec3 vWorldPos;

void main() {
  vec3 p = position;
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;

  /* Undulate the sheet so it reads as vapour, not as a plane. */
  float n = fbm3o(vec3(wp.xz * 0.0095, uTime * 0.035));
  float n2 = vnoise(vec3(wp.xz * 0.03, uTime * 0.11));
  p.y += (n - 0.5) * 30.0 + (n2 - 0.5) * 6.0;

  vec4 wpos = modelMatrix * vec4(p, 1.0);
  vWorldPos = wpos.xyz;
  gl_Position = projectionMatrix * viewMatrix * wpos;
}
`;

const FRAG = /* glsl */ `
${NOISE}
${FOG}

uniform vec3 uShadow;
uniform vec3 uLit;
uniform vec3 uLining;
uniform float uDensity;
uniform float uStackTop;
uniform float uStackBottom;

varying vec3 vWorldPos;

void main() {
  vec3 wp = vWorldPos;
  float wy = wp.y;

  /* Vertical envelope: thin at the top of the deck so the sky shows through,
     thin at the bottom so it dissolves into the sea rather than ending. */
  float edge = smoothstep(uStackBottom, uStackBottom + 90.0, wy)
             * (1.0 - smoothstep(uStackTop - 62.0, uStackTop, wy));
  if (edge <= 0.001) discard;

  /* Cloud body: one broad shape, one finer one, drifting slowly. */
  float broad = fbm(vec3(wp.xz * 0.0026, wy * 0.006 + uTime * 0.008));
  float fine = fbm3o(vec3(wp.xz * 0.011, wy * 0.02 - uTime * 0.02));
  float d = broad * 0.78 + fine * 0.35;
  d = smoothstep(0.46, 0.80, d);

  vec3 V = normalize(cameraPosition - wp);
  float dist = distance(cameraPosition, wp);

  /* Grazing angles look through more vapour, which is what finally makes the
     deck close over the camera as it falls in. */
  float grazing = clamp(1.0 / max(abs(V.y), 0.16), 1.0, 5.6);
  float alpha = d * edge * uDensity * 0.55 * grazing;
  alpha = clamp(alpha, 0.0, 0.96);

  /* Billow shading: bright where the surface faces up towards the light. */
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0001));
  vec2 toFrag = normalize(wp.xz - cameraPosition.xz + vec2(0.0001));
  float sunAzimuth = max(dot(sunFlat.xz, toFrag), 0.0);

  float sunUp = clamp(uSunDir.y, 0.0, 1.0);
  float billow = pow(sunUp, 1.4) * (0.30 + 0.70 * d);
  float lining = pow(sunAzimuth, 3.0) * pow(1.0 - abs(d - 0.62) * 2.4, 3.0);

  vec3 col = mix(uShadow, uLit, clamp(billow, 0.0, 1.0));
  col += uLining * max(lining, 0.0) * 0.85;
  /* A little bounce from the water far below. */
  col += vec3(0.05, 0.10, 0.16) * (1.0 - d) * 0.4;

  col *= mix(1.0, uSunFade, 0.55);
  col = applyFog(col, dist);

  gl_FragColor = vec4(col, alpha * uFade);
}
`;

export class DeckLayer extends Layer {
  constructor({ quality }) {
    super('deck', { range: [0.12, 0.46], quality });

    this.material = this.registerMaterial(makeMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uShadow: { value: new THREE.Color('#3a4a63') },
        uLit: { value: new THREE.Color('#ffe4c2') },
        uLining: { value: new THREE.Color('#ffcf9b') },
        uDensity: { value: 1 },
        uStackTop: { value: TOP_Y },
        uStackBottom: { value: BOTTOM_Y },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    }));

    const geo = new THREE.PlaneGeometry(SPREAD * 2, SPREAD * 2, 28, 28);
    geo.rotateX(-Math.PI / 2);
    this.geometry = geo;

    this.slabs = [];
    const gap = (TOP_Y - BOTTOM_Y) / (SHEETS - 1);
    for (let i = 0; i < SHEETS; i++) {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.position.set(0, TOP_Y - gap * i, 0);
      mesh.userData.phase = Math.random() * Math.PI * 2;
      mesh.userData.drift = 18 + Math.random() * 34;
      mesh.frustumCulled = true;
      this.slabs.push(mesh);
      this.group.add(mesh);
    }

    /* Sparse vapour drifting with the camera, for depth between the sheets. */
    this.mist = this.registerField(new ParticleField({
      count: Math.round(1100 * quality.particleScale),
      shape: 'column',
      extent: { radius: 300, span: 420 },
      size: [3, 14],
      colorA: [0.55, 0.68, 0.85],
      colorB: [1.0, 0.92, 0.82],
      blending: 'additive',
      opacity: 0.10,
      rise: -3.5,
      wander: 6,
      twinkle: 0.25,
      twinkleSpeed: 0.7,
      soft: 1.0,
      refDist: 90,
      maxSize: 60,
      fogInfluence: 0.5,
    }));
    this.mist.object3D.position.set(0, (TOP_Y + BOTTOM_Y) * 0.5, 0);
    this.group.add(this.mist.object3D);
  }

  update(ctx) {
    const t = ctx.time;
    /* Sheets slide past one another horizontally, which is what sells the
       stack as a moving volume instead of a rigid accordion. */
    for (const slab of this.slabs) {
      const { phase, drift } = slab.userData;
      slab.position.x = Math.sin(t * 0.021 + phase) * drift;
      slab.position.z = Math.cos(t * 0.017 + phase * 1.7) * drift * 0.8;
    }
    this.mist.object3D.position.x = ctx.camera.position.x;
    this.mist.object3D.position.z = ctx.camera.position.z;
  }
}
