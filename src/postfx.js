/* ==========================================================================
   postfx.js — the look, after the geometry.

   Chain: RenderPass -> UnrealBloomPass -> GradePass -> OutputPass -> FinishPass.

   The split matters. GradePass runs in linear HDR space, before tone mapping,
   which is where the light shafts can threshold on real luminance. FinishPass
   runs *after* tone mapping and colour conversion, in display space, which is
   where vignette and grain belong: an additive grain of ±0.04 is film grain on
   a display-referred value, but applied to linear HDR it is catastrophic in
   the shadows — on the abyss, where the frame is nearly black with one small
   plasma glow, it turns the whole picture into noise.
   ========================================================================== */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { NOISE, DITHER } from './glsl.js';

const MAX_TAPS = 16;

const GRADE_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const GRADE_FRAG = /* glsl */ `
${NOISE}
${DITHER}

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform vec2 uSunScreen;
uniform float uTime;
uniform float uTaps;

uniform float uAberration;
uniform float uShafts;
uniform float uWarp;
uniform float uTintAmount;
uniform vec3 uTint;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);

  /* ---- heat and pressure: a little lens deformation, deepening as we sink */
  if (uWarp > 0.001) {
    vec2 wobble = vec2(
      sin(uv.y * 41.0 + uTime * 0.95) * 0.55 + sin(uv.y * 13.0 - uTime * 0.37),
      cos(uv.x * 37.0 - uTime * 0.83) * 0.55 + cos(uv.x * 17.0 + uTime * 0.31)
    );
    uv += wobble * uWarp * 0.0038;
  }

  /* ---- chromatic aberration, radial ---- */
  float k = uAberration * 0.00095 * (0.35 + r2 * 1.9);
  vec3 col;
  col.r = texture2D(tDiffuse, uv + c * k).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - c * k).b;

  /* ---- light shafts: radial march towards the sun ---- */
  if (uShafts > 0.001) {
    vec2 source = clamp(uSunScreen, vec2(-0.35), vec2(1.35));
    vec2 step_ = (source - uv) / max(uTaps, 1.0);
    vec2 p = uv;
    float atten = 1.0;
    vec3 shafts = vec3(0.0);
    float weight = 0.0;

    for (int i = 0; i < ${MAX_TAPS}; i++) {
      if (float(i) >= uTaps) break;
      p += step_;
      vec3 s = texture2D(tDiffuse, clamp(p, vec2(0.0), vec2(1.0))).rgb;
      float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
      /* Only genuinely bright things cast shafts. */
      float contrib = max(lum - 0.85, 0.0);
      shafts += s * contrib * atten;
      weight += atten;
      atten *= 0.94;
    }

    shafts /= max(weight, 0.0001);
    col += shafts * uShafts * 0.9;
  }

  /* ---- depth wash: shadows go to the stratum's colour, highlights survive -- */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, uTint * (0.22 + lum * 1.55), uTintAmount);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * Display-space finishing. Runs last, on values that have already been tone
 * mapped and converted to sRGB.
 */
const FINISH_FRAG = /* glsl */ `
${DITHER}

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform float uTime;
uniform float uVignette;
uniform float uGrain;

varying vec2 vUv;

void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  vec2 c = vUv - 0.5;

  /* ---- vignette: a lens falloff, in the same space the eye reads it in ---- */
  float vig = pow(1.0 - smoothstep(0.30, 1.16, length(c) * 1.42), 1.30);
  col *= mix(1.0, vig, uVignette);

  /* ---- grain: film, weighted into the shadows ---- */
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float g = ditherHash(vUv * uResolution, uTime * 61.0) - 0.5;
  col += g * uGrain * (0.35 + 0.65 * (1.0 - clamp(lum, 0.0, 1.0)));

  gl_FragColor = vec4(col, 1.0);
}
`;

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSunScreen: { value: new THREE.Vector2(0.5, 1.2) },
    uTime: { value: 0 },
    uTaps: { value: MAX_TAPS },
    uAberration: { value: 0.35 },
    uShafts: { value: 0 },
    uWarp: { value: 0 },
    uTintAmount: { value: 0.05 },
    uTint: { value: new THREE.Color('#12203f') },
  },
  vertexShader: GRADE_VERT,
  fragmentShader: GRADE_FRAG,
};

const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uVignette: { value: 0.3 },
    uGrain: { value: 0.03 },
  },
  vertexShader: GRADE_VERT,
  fragmentShader: FINISH_FRAG,
};

export class PostFX {
  constructor({ renderer, scene, camera, quality, width, height, pixelRatio }) {
    this.renderer = renderer;
    this.quality = quality;

    this.composer = new EffectComposer(renderer);
    this.composer.setPixelRatio(pixelRatio);

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(width * pixelRatio, height * pixelRatio),
      0.6,    /* strength — driven per frame by the timeline */
      0.75,   /* radius */
      0.85    /* threshold: only real highlights bloom */
    );
    this.composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    this.grade.material.uniforms.uTaps.value = quality.shaftTaps;
    this.composer.addPass(this.grade);

    this.output = new OutputPass();
    this.composer.addPass(this.output);

    /* Last, and therefore the pass that reaches the screen. */
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);

    this.setSize(width, height, pixelRatio);
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    /* Bloom at a fraction of the canvas: imperceptible at these strengths and
       the single biggest win on weaker GPUs. */
    const bs = this.quality.bloomScale;
    this.bloom.setSize(width * pixelRatio * bs, height * pixelRatio * bs);

    const px = new THREE.Vector2(width * pixelRatio, height * pixelRatio);
    this.grade.material.uniforms.uResolution.value.copy(px);
    this.grade.material.uniforms.uTaps.value = this.quality.shaftTaps;
    this.finish.material.uniforms.uResolution.value.copy(px);
  }

  setQuality(quality) {
    this.quality = quality;
    this.grade.material.uniforms.uTaps.value = quality.shaftTaps;
  }

  render({ time, grade, sunScreen }) {
    const u = this.grade.material.uniforms;
    u.uTime.value = time;
    u.uAberration.value = grade.aberration;
    u.uShafts.value = grade.shafts;
    u.uWarp.value = grade.warp;
    u.uTintAmount.value = grade.tintAmount;
    u.uTint.value.copy(grade.tint);
    u.uSunScreen.value.copy(sunScreen);

    const f = this.finish.material.uniforms;
    f.uTime.value = time;
    f.uVignette.value = grade.vignette;
    f.uGrain.value = grade.grain;

    this.bloom.strength = grade.bloom;
    this.renderer.toneMappingExposure = grade.exposure;
    this.composer.render();
  }

  dispose() {
    this.composer.dispose?.();
    this.renderPass.dispose?.();
    this.bloom.dispose?.();
    this.grade.dispose?.();
    this.output.dispose?.();
    this.finish.dispose?.();
  }
}
