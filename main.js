/* ==========================================================================
   ABYSS — main.js

   Boot, wire, and drive. The order matters and is deliberate:

     detect WebGL  ->  build world  ->  build the post chain  ->  precompile
     ->  warm frames  ->  hand over to the user

   Once running, one frame is: read scroll -> advance the timeline -> place
   the camera -> update the world -> grade and post-process -> update the HUD.
   The timeline is the only thing that knows where we are; everything else
   asks it.
   ========================================================================== */

import * as THREE from 'three';
import { Timeline, STRATA, MAX_METERS, depthAt } from './src/timeline.js';
import { World } from './src/world/index.js';
import { PostFX } from './src/postfx.js';
import { Controls } from './src/controls.js';
import { Hud } from './src/hud.js';
import { Ambience } from './src/audio.js';
import { QualityManager, detectTier, tierById } from './src/quality.js';

/* ------------------------------ url options ----------------------------- */
/* ?quality=high|medium|low   force a tier (also disables auto-degrade)
   ?t=0.42                    start already at a depth, for stills and probes
   ?debug=1                   overlay live renderer stats                      */
const params = new URLSearchParams(location.search);
const forcedQuality = params.get('quality');
const startT = params.get('t') !== null ? Number(params.get('t')) : null;
const debug = params.get('debug') === '1';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const errors = [];
let debugEl = null;
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- hud ---------------------------------- */

const hud = new Hud({
  onEnter: () => enter(),
  onSound: () => toggleSound(),
  onQuality: (id) => {
    if (id === 'auto') quality.setAuto();
    else quality.setManual(tierById(id));
    hud.setQuality(id);
  },
  onResurface: () => {
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  },
});

/* -------------------------------- webgl --------------------------------- */

function detectWebGL() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return { ok: false, reason: 'no context' };
    const lose = gl.getExtension('WEBGL_lose_context');
    lose?.loseContext();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const support = detectWebGL();
if (!support.ok) {
  hud.fail(
    'This browser will not give the page a WebGL context, and the entire descent '
    + 'is rendered by your graphics hardware in real time. Try a current desktop '
    + 'Chrome, Edge, Firefox or Safari with hardware acceleration enabled.'
  );
  window.__abyss = { ready: false, reason: support.reason };
  throw new Error(`WebGL unavailable: ${support.reason}`);
}

/* ------------------------------- renderer ------------------------------- */

const canvas = document.getElementById('scene');
const initialQuality = forcedQuality ? tierById(forcedQuality) : detectTier();

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,               /* MSAA happens on the composer's target */
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, initialQuality.dpr));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = true;
/* Stats are accumulated across the whole frame by hand, because the composer
   calls render() once per pass and would otherwise leave `info.render`
   describing only its final full-screen quad. */
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#01030a');

const camera = new THREE.PerspectiveCamera(
  52,
  window.innerWidth / window.innerHeight,
  0.5,
  6000
);
camera.rotation.order = 'YXZ';

/* --------------------------- boot, step by step ------------------------- */

hud.setSound(true);
hud.boot(6, 'Booting');

await nextFrame();

const timeline = new Timeline({ reducedMotion });
const world = new World({ scene, quality: initialQuality });

hud.boot(34, 'Filling the water column');
await nextFrame();

let postfx = new PostFX({
  renderer,
  scene,
  camera,
  quality: initialQuality,
  width: window.innerWidth,
  height: window.innerHeight,
  pixelRatio: renderer.getPixelRatio(),
});

hud.boot(56, 'Linking the effects');
await nextFrame();

/* Compile every stratum, not just the ones on screen: a shader compiling at
   the moment a stratum fades in is a visible stall. */
{
  const wasVisible = world.layers.map((l) => l.group.visible);
  for (const layer of world.layers) layer.group.visible = true;
  renderer.compile(scene, camera);
  world.layers.forEach((layer, i) => { layer.group.visible = wasVisible[i]; });
}

hud.boot(78, 'Compiling shaders');
await nextFrame();
await sleep(60);

hud.boot(90, 'Balancing the light');

/* Place the camera and run one full world update before warming up, so the
   warm-up frames draw the real opening shot rather than a default state with
   every stratum visible. */
{
  const cam = timeline.camera;
  camera.position.set(cam.x, cam.y, cam.z);
  camera.rotation.set(
    THREE.MathUtils.degToRad(cam.pitch),
    THREE.MathUtils.degToRad(cam.yaw),
    THREE.MathUtils.degToRad(cam.roll),
    'YXZ'
  );
  camera.fov = cam.fov;
  camera.updateProjectionMatrix();
  world.update({
    time: 0,
    t: timeline.progress,
    pixelRatio: renderer.getPixelRatio(),
    camera,
    timeline,
  });
}

/* Warm frames: first-touch uploads, buffer allocation, and the shader cache
   all happen here rather than on the user's first look around. */
for (let i = 0; i < 5; i++) {
  renderer.render(scene, camera);
  await nextFrame();
}

/* ------------------------------- controls ------------------------------- */

const controls = new Controls({ reducedMotion });
controls.onFirstMove(() => hud.dismissHint());

const quality = new QualityManager({
  initial: initialQuality,
  onChange: (tier) => applyQuality(tier),
});
if (forcedQuality) quality.setManual(tierById(forcedQuality));

const audio = new Ambience();
let soundWanted = true;

async function toggleSound() {
  if (audio.isOn) {
    await audio.disable();
    soundWanted = false;
    hud.setSound(false);
  } else {
    const ok = await audio.enable();
    soundWanted = ok;
    hud.setSound(ok);
  }
}

let entered = false;

function enter() {
  if (entered) return;
  entered = true;

  if (soundWanted) audio.enable().then((ok) => hud.setSound(ok));

  hud.enter();
  controls.measure();

  /* ?t= pins the descent at a depth. The document has to be scrollable first,
     which is why this happens after the gate has lifted. */
  if (startT !== null && Number.isFinite(startT)) {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo(0, max * Math.max(0, Math.min(1, startT)));
    controls.measure();
  }
}

/* --------------------------------- loop --------------------------------- */

function frame(now) {
  /* Two frame times: the simulation is clamped so a stall cannot teleport the
     descent, but the quality manager must see the real number or it would
     over-report the frame rate exactly when the machine is struggling, which
     is the one moment it matters. */
  const rawDt = Math.max(0.0005, (now - frame.last) / 1000);
  const dt = Math.min(0.2, rawDt);
  frame.last = now;
  renderer.info.reset();

  if (!entered) {
    /* Behind the gate the world idles rather than froze: the entrance has
       something to reveal. */
    controls.measureIfNeeded();
  } else {
    timeline.target = controls.targetProgress;
  }

  timeline.update(dt);
  controls.update(dt);

  const cam = timeline.camera;
  camera.position.set(cam.x, cam.y, cam.z);
  camera.rotation.set(
    THREE.MathUtils.degToRad(cam.pitch + controls.look.pitch),
    THREE.MathUtils.degToRad(cam.yaw + controls.look.yaw),
    THREE.MathUtils.degToRad(cam.roll),
    'YXZ'
  );
  if (Math.abs(camera.fov - cam.fov) > 0.01) {
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
  }

  world.update({
    time: timeline.time,
    t: timeline.progress,
    pixelRatio: renderer.getPixelRatio(),
    camera,
    timeline,
  });

  postfx.render({
    time: timeline.time,
    grade: timeline.grade,
    sunScreen: world.sunScreen,
  });

  audio.setProgress(timeline.progress);
  quality.note(rawDt);

  /* Every frame, not on a timer: the readout is a handful of DOM writes that
     only happen when a value actually changes, and throttling it was enough
     to make the displayed depth disagree with the camera by a few metres. */
  if (entered) {
    hud.update({
      t: timeline.progress,
      depth: timeline.depth,
      stratumIndex: timeline.stratumIndex,
    });
  }

  if (debug && debugEl) {
    debugEl.textContent = [
      `${(1 / dt).toFixed(0)} fps`,
      `t ${timeline.progress.toFixed(3)}`,
      `${Math.round(timeline.depth)} m`,
      `${timeline.stratum.id} · ${initialQuality.id}${quality.current.id !== initialQuality.id ? `→${quality.current.id}` : ''}`,
      `${renderer.info.render.calls} calls`,
      `${(renderer.info.render.triangles / 1000).toFixed(0)}k tris`,
    ].join('   ');
  }
}
frame.last = performance.now();

/* ------------------------------- resize etc ----------------------------- */

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  postfx.setSize(w, h, renderer.getPixelRatio());
  controls.measure();
}

function applyQuality(tier) {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, tier.dpr));
  world.setQuality(tier);
  postfx.setQuality(tier);
  hud.setQuality(tier.id);
  resize();
}

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(resize, 140);
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  renderer.setAnimationLoop(null);
  hud.showFallback(
    'Render context lost',
    'The graphics context was taken away mid-descent — usually a driver reset or '
    + 'too many GPU-heavy tabs. Reload to fall again; your place is not kept.'
  );
});
canvas.addEventListener('webglcontextrestored', () => window.location.reload());

/* A hidden tab pauses rAF; on the way back, drop the accumulated gap so the
   descent resumes where it was instead of jumping. */
document.addEventListener('visibilitychange', () => {
  frame.last = performance.now();
});

/* -------------------------------- start --------------------------------- */

if (startT !== null && Number.isFinite(startT)) {
  timeline.jumpTo(startT);
  controls.targetProgress = Math.max(0, Math.min(1, startT));
}

if (debug) {
  debugEl = document.createElement('div');
  debugEl.className = 'debug';
  debugEl.setAttribute('aria-hidden', 'true');
  document.body.append(debugEl);
}

renderer.setAnimationLoop(frame);
hud.ready();

/* An error before the first user interaction is fatal enough to be worth
   saying out loud; after that, the descent carries on. */
window.addEventListener('error', (event) => {
  errors.push(event.message);
  if (!entered) {
    hud.showFallback('Something failed to start', String(event.message));
  }
});

if (params.get('enter') === '1') enter();

/* ------------------------------ introspection --------------------------- */

window.__abyss = {
  ready: true,
  three: THREE,
  renderer,
  scene,
  camera,
  world,
  timeline,
  postfx,
  controls,
  hud,
  audio,
  quality,
  errors,
  params: Object.fromEntries(params.entries()),
  /** The choreography, exposed so tooling can cross-check the plumbing. */
  strata: STRATA,
  depthAt,
  /** Snap the descent to a progress value — used by the verification harness. */
  jump(t) {
    const p = Math.max(0, Math.min(1, t));
    timeline.jumpTo(p);
    controls.targetProgress = p;
  },
  enter,
  resize,
};
window.__abyssStarted = true;

console.info(
  `[abyss] ready — five strata, ${MAX_METERS.toLocaleString('en-US')} m, `
  + `${STRATA.length} layers, quality "${initialQuality.id}"${initialQuality.id !== 'high' ? ' (auto-detected)' : ''}`
);
