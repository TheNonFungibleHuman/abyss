/* ==========================================================================
   glsl.js — GLSL fragments shared between strata.

   Plain GLSL ES 1.00 template strings (three's ShaderMaterial prepends the
   precision qualifier, the matrix uniforms and the built-in attributes, so
   none of those are declared again here).
   ========================================================================== */

/**
 * The uniforms every stratum material is given. `makeMaterial()` prepends this
 * to both shader stages, so a shader can always reference them and must never
 * declare them again — a duplicate declaration is a compile error.
 */
export const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform float uSunFade;
`;

/** 2D rotation matrix. Its own snippet so non-noise shaders can use it too. */
export const ROT2 = /* glsl */ `
mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}
`;

/** Hashes, value noise, fBm, domain warping, fresnel. */
export const NOISE = /* glsl */ `
${ROT2}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/* Trilinear value noise. Cheap, smooth, and plenty for cloud/terrain shapes. */
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);

  float n000 = hash13(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));

  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}

/* Five octaves, no arguments: keeps every call site loop-free and portable. */
float fbm(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amp * vnoise(p);
    p = p * 2.03 + vec3(11.3, 7.7, 5.1);
    amp *= 0.5;
  }
  return sum;
}

/* Three octaves — for effects where a full fBm is wasted work. */
float fbm3o(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 3; i++) {
    sum += amp * vnoise(p);
    p = p * 2.07 + vec3(3.1, 9.4, 1.7);
    amp *= 0.5;
  }
  return sum;
}

/* Ridged variant: sharp creases, good for cloud edges and plasma filaments. */
float ridged(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0);
    sum += amp * n * n;
    p = p * 2.11 + vec3(5.2, 1.3, 9.7);
    amp *= 0.5;
  }
  return sum;
}

float fresnel(vec3 n, vec3 v, float power) {
  return pow(1.0 - clamp(dot(normalize(n), normalize(v)), 0.0, 1.0), power);
}
`;

/** Animated caustics: bright ridges between drifting cellular features. */
export const CAUSTICS = /* glsl */ `
float causticLayer(vec2 p, float time) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float d1 = 1e5;
  float d2 = 1e5;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec3 h = hash33(vec3(g + o, 7.13));
      vec2 pos = o + h.xy + 0.55 * vec2(
        sin(time * 0.42 + 6.2831 * h.x),
        cos(time * 0.37 + 6.2831 * h.y)
      );
      float d = length(pos - f);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

/* Two scales of the cell pattern; 1.0 at the bright filaments, 0 elsewhere. */
float caustics(vec2 uv, float time, float scale) {
  float a = causticLayer(uv * scale, time);
  float b = causticLayer(uv * scale * 1.9 + 4.7, time * 1.31);
  float k = min(a, b);
  return clamp(1.0 - k * 2.6, 0.0, 1.0);
}
`;

/** Cheap 3-tap-free dithering hash for the grain in the grade pass. */
export const DITHER = /* glsl */ `
float ditherHash(vec2 uv, float t) {
  return fract(sin(dot(uv + vec2(t * 0.0041, t * 0.0027), vec2(12.9898, 78.233))) * 43758.5453);
}
`;

/**
 * Fog, applied by hand rather than through three's fog chunks.
 *
 * Two reasons: it works identically for additive and opaque materials (three's
 * fog blends towards the fog colour, which on an additive particle *adds*
 * light instead of removing it), and it gives the strata one shared naming
 * convention — `uFogColor`, `uFogDensity`, `uFade` — that the World can drive
 * in a single pass over its materials.
 *
 * `uFade` is a per-stratum cross-dissolve: at 0 the surface is fully
 * transparent, so a stratum can be dissolved out without popping.
 */
export const FOG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uFade;

vec3 applyFog(vec3 color, float dist) {
  float d = uFogDensity * dist;
  return mix(color, uFogColor, clamp(1.0 - exp(-d * d), 0.0, 1.0));
}
`;
