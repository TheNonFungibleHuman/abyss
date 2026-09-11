/* ==========================================================================
   verify.mjs — headless verification for ABYSS.

   Serves the project, launches Chrome with software WebGL, drives it over the
   DevTools Protocol, and checks the things that are easy to get wrong: that the
   scroll position, the timeline, the depth readout, the stratum rail and the
   visible layers all agree; that no point on the way down leaves the screen
   empty; that depth never goes backwards; and that the forced-quality and
   no-WebGL paths behave.

     node tools/verify.mjs              full run; writes pictures into tools/
     node tools/verify.mjs --quick      checks only, no pictures
     node tools/verify.mjs --mobile     the whole run at 390x844
     node tools/verify.mjs --shots="0.5:sea,1:abyss-core"

   Chrome reports a graphics-card program that fails to compile through the
   console, not as an exception. A run can therefore look healthy while most of
   the scene is invisible, so console errors are counted as failures.
   ========================================================================== */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

/* ------------------------------- options -------------------------------- */

const QUICK = process.argv.includes('--quick');
const MOBILE = process.argv.includes('--mobile');
const SHOTS_ARG = process.argv.find((a) => a.startsWith('--shots='));
const SHOTS = SHOTS_ARG
  ? SHOTS_ARG.slice('--shots='.length).split(',').map((s) => {
      const [t, name] = s.split(':');
      return { t: Number(t), name: name ?? String(t) };
    })
  : null;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const PORT = 8700 + Math.floor(Math.random() * 400);

const CHROME = process.env.CHROME
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WIN_W = MOBILE ? 390 : 1440;
const WIN_H = MOBILE ? 844 : 900;

/* A fresh profile and port per run: a surviving Chrome from an earlier run
   would otherwise be the browser we attach to, at the wrong window size. */
const PROFILE = join(tmpdir(), `abyss-verify-${PORT}-${Date.now()}`);

/* The walk stops: every tenth of the way down, so each stratum is entered and
   left, and the boundaries are sampled from both sides. */
const STOPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

/* ------------------------------- results -------------------------------- */

let passed = 0;
let failed = 0;

function check(ok, label, detail = '') {
  if (ok) { passed++; console.log(`   \u2713 ${label}${detail ? `   ${detail}` : ''}`); }
  else { failed++; console.log(`   \u2717 ${label}${detail ? `   ${detail}` : ''}`); }
}

function section(name) { console.log(`\n\u2500\u2500 ${name}`); }

/* ------------------------------ static server ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    /* An unanswered favicon request is a console error in Chrome, which would
       read as a page failure. Answer it silently. */
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    let filePath = join(ROOT, decodeURIComponent(url.pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if ((await stat(filePath).catch(() => null))?.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, r));
const ORIGIN = `http://127.0.0.1:${PORT}/`;

/* --------------------------------- chrome -------------------------------- */

console.log(`ABYSS verification \u2014 ${WIN_W}x${WIN_H} \u2014 ${ORIGIN}`);
rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT + 1000}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--hide-scrollbars',
  `--window-size=${WIN_W},${WIN_H}`,
  '--force-device-scale-factor=1',
  ORIGIN,
], { stdio: 'ignore' });

const DEVTOOLS = `http://127.0.0.1:${PORT + 1000}`;

async function browserWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${DEVTOOLS}/json/list`);
      const page = (await r.json()).find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

let id = 0;
const pending = new Map();
const errors = [];

function fmtArg(a) {
  if (a == null) return String(a);
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  return a.description ?? a.type;
}

function handleEvent(msg) {
  const { method, params } = msg;
  if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    errors.push('UNCAUGHT: ' + (d.exception?.description ?? d.text));
  }
  if (method === 'Log.entryAdded' && params.entry.level === 'error') {
    errors.push(`[error] ${params.entry.text}` + (params.entry.url ? ` (${params.entry.url})` : ''));
  }
}

const wsUrl = await browserWs();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, { resolve, reject });
  ws.send(JSON.stringify({ id: myId, method, params }));
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  handleEvent(msg);
});

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

/* ------------------------------- helpers --------------------------------- */

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result.value;
}

async function waitFor(expression, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evaluate(expression)) return true; } catch { /* context swapping */ }
    await sleep(200);
  }
  return false;
}

async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor("document.readyState === 'complete'", 30000);
}

async function capture(path) {
  const cap = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path, Buffer.from(cap.data, 'base64'));
}

const PROBE = `(() => {
  const a = window.__abyss;
  if (!a || !a.ready) return null;
  const t = a.timeline.progress;
  let railCurrent = -1;
  const rail = document.querySelectorAll('#rail li');
  rail.forEach((li, i) => { if (li.classList.contains('is-current')) railCurrent = i; });
  let expectIndex = 0;
  a.strata.forEach((s, i) => { if (t >= s.from) expectIndex = i; });
  const c = document.getElementById('scene');
  return JSON.stringify({
    progress: t,
    depth: a.timeline.depth,
    depthAt: a.depthAt(t),
    stratumIndex: a.timeline.stratumIndex,
    stratumId: a.timeline.stratum.id,
    expectIndex,
    depthText: document.getElementById('depthNum').textContent.replace(/,/g, ''),
    railCurrent,
    railCount: rail.length,
    strataCount: a.strata.length,
    visibleLayers: a.world.layers.filter((l) => l.group.visible).length,
    captionsOn: document.querySelectorAll('#captions p.is-on').length,
    canvas: { w: c.width, h: c.height },
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  });
})()`;

async function readProbe() {
  const raw = await evaluate(PROBE);
  return raw ? JSON.parse(raw) : null;
}

/* Drive the descent the way the page says it can be driven: scroll the
   document. The app derives progress from the scroll position, so setting a
   value on the timeline directly would be overwritten by the next scroll
   event. Smooth scrolling is suppressed so each position is reached at once.

   Under software rendering a frame can take more than a second, and the
   smoothed progress only advances when a frame runs. So wait for the value to
   settle rather than assuming a delay is long enough. */
async function goTo(t) {
  await evaluate(`(() => {
    const el = document.documentElement;
    const prev = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    const max = Math.max(1, el.scrollHeight - innerHeight);
    window.scrollTo(0, max * ${t});
    el.style.scrollBehavior = prev;
    window.__abyss.controls.measure();
    return 'ok';
  })()`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const p = await evaluate('window.__abyss.timeline.progress');
    if (Math.abs(p - t) <= 0.01) return;
    await sleep(250);
  }
}

async function finish() {
  console.log('\n================ result ================');
  console.log(`${passed}/${passed + failed} checks passed`);
  console.log(failed ? 'FAIL' : 'PASS');
  ws.close();
  chrome.kill();
  await sleep(600);
  spawn('taskkill', ['/F', '/PID', String(chrome.pid), '/T'], { stdio: 'ignore' });
  await sleep(400);
  server.close();
  process.exit(failed ? 1 : 0);
}

/* =========================================================================
   1. boot
   ========================================================================= */

section('boot: the module, the canvas, the loop');

await goto(`${ORIGIN}?enter=1`);
const booted = await waitFor('window.__abyssStarted === true && window.__abyss && window.__abyss.ready === true');
check(booted, 'the descent reports ready');

if (!booted) {
  console.log('\nThe page never came up; nothing else can be checked.');
  ws.close();
  chrome.kill();
  spawn('taskkill', ['/F', '/PID', String(chrome.pid), '/T'], { stdio: 'ignore' });
  process.exit(1);
}

await sleep(1200);

const boot = await readProbe();
check(!!boot, 'the timeline is exposed for tooling');
check(
  await evaluate("document.getElementById('gate').classList.contains('is-gone')"),
  'the gate has lifted'
);
check(
  await evaluate("document.getElementById('hud').hidden === false"),
  'the HUD is up'
);
check(
  await evaluate("(() => { const c = document.getElementById('scene'); const gl = c.getContext('webgl2') || c.getContext('webgl'); return !!gl && !gl.isContextLost(); })()"),
  'the canvas is a live WebGL surface'
);
check(
  !!(await evaluate('window.__abyss.three && window.__abyss.three.REVISION')),
  'three.js loaded from the CDN',
  `r${await evaluate('window.__abyss.three.REVISION')}`
);
check(boot.railCount === boot.strataCount && boot.railCount === 5, 'the rail has one entry per stratum', `${boot.railCount}`);
check(boot.visibleLayers >= 1, 'at least one layer is visible at the top', `${boot.visibleLayers}`);

const bootErrors = errors.length;
check(bootErrors === 0, 'boot: nothing failed in the console', bootErrors ? errors.slice(0, 4).join(' | ') : '');

/* --shots= stops here: boot, then capture the named positions. A short art
   pass rather than the full check. */
if (SHOTS) {
  mkdirSync(TOOLS, { recursive: true });
  for (const { t, name } of SHOTS) {
    await goTo(t);
    await capture(join(TOOLS, `shot-${name}.png`));
    console.log(`   \u2713 captured ${name} at t=${t}`);
  }
  await finish();
}

/* =========================================================================
   2. the descent
   ========================================================================= */

section('the descent: scroll, timeline, readout and rail all agree');

if (!QUICK) mkdirSync(TOOLS, { recursive: true });

let lastDepth = -Infinity;
let monotonic = true;
const walk = [];

for (const t of STOPS) {
  await goTo(t);
  const s = await readProbe();
  walk.push(s);

  const label = `t=${t.toFixed(1)}`;
  const okProgress = Math.abs(s.progress - t) <= 0.01;
  const okDepth = Math.abs(s.depth - s.depthAt) <= 1;
  const okStratum = s.stratumIndex === s.expectIndex;
  const okRail = s.railCurrent === s.stratumIndex;
  const okReadout = s.depthText === String(Math.round(s.depth));
  const okLayers = s.visibleLayers >= 1;

  if (s.depth < lastDepth - 0.5) monotonic = false;
  lastDepth = s.depth;

  check(
    okProgress && okDepth && okStratum && okRail && okReadout && okLayers,
    `${label} — everything agrees`,
    `${s.stratumId}, ${Math.round(s.depth)} m, ${s.visibleLayers} layer(s)` +
      (okProgress ? '' : ` | progress ${s.progress.toFixed(3)}`)
  );

  if (!QUICK) {
    const pct = String(Math.round(t * 100)).padStart(3, '0');
    await capture(join(TOOLS, `03-${pct}-${s.stratumId}.png`));
  }
}

check(monotonic, 'depth never goes backwards on the way down');

/* Every stratum must have its caption up at its own midpoint, and the layers
   must not all be hidden there either. */
section('every stratum is populated at its midpoint');

const strata = JSON.parse(await evaluate('JSON.stringify(window.__abyss.strata.map((s) => ({ from: s.from, to: s.to, id: s.id })))'));

for (const s of strata) {
  const mid = (s.from + s.to) / 2;
  await goTo(mid);
  const p = await readProbe();
  const captionOn = await evaluate(
    `document.querySelectorAll('#captions p.is-on').length > 0`
  );
  check(
    captionOn && p.visibleLayers >= 1,
    `${s.id}: caption up and something on screen`,
    `${p.visibleLayers} layer(s)`
  );
}

/* =========================================================================
   4. forced quality
   ========================================================================= */

section('the forced quality path');

await goto(`${ORIGIN}?enter=1&quality=low`);
await waitFor('window.__abyssStarted === true');
await sleep(800);
const low = await evaluate(
  "JSON.stringify({ id: window.__abyss.quality.current.id, dpr: window.__abyss.renderer.getPixelRatio() })"
);
const lowState = JSON.parse(low);
check(lowState.id === 'low', 'the low tier is applied', lowState.id);
check(lowState.dpr <= 1.001, 'the low tier caps the pixel ratio at 1x', `${lowState.dpr}x`);

/* =========================================================================
   5. phone layout
   ========================================================================= */

if (MOBILE) {
  section('phone: the canvas and the HUD fit the screen');
  await goto(`${ORIGIN}?enter=1`);
  await waitFor('window.__abyssStarted === true');
  await sleep(1000);
  const p = await readProbe();
  const ratio = p.viewport.dpr;
  const fitsCanvas = Math.abs(p.canvas.w - Math.floor(p.viewport.w * ratio)) <= 2
    && Math.abs(p.canvas.h - Math.floor(p.viewport.h * ratio)) <= 2;
  check(fitsCanvas, 'the canvas matches the phone viewport at the tier ratio', `${p.canvas.w}x${p.canvas.h} at ${ratio}x`);
  check(
    await evaluate("(() => { const r = document.getElementById('rail').getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top >= -2 && r.bottom <= innerHeight + 2; })()"),
    'the rail stays inside the phone viewport'
  );
}

/* =========================================================================
   6. no WebGL
   ========================================================================= */

section('no WebGL: a written fallback, not a blank canvas');

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: "HTMLCanvasElement.prototype.getContext = function () { return null; };",
});
await goto(ORIGIN);
await sleep(2500);

const fallbackPainted = await evaluate(`(() => {
  const f = document.getElementById('fallback');
  if (!f) return false;
  const cs = getComputedStyle(f);
  const b = f.getBoundingClientRect();
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.5
    && b.width > 0 && b.height > 0;
})()`);
check(fallbackPainted, 'the fallback panel is actually painted');
check(
  await evaluate("window.__abyss && window.__abyss.ready === false"),
  'the page does not claim to have started'
);
check(
  await evaluate("document.getElementById('gate').classList.contains('is-gone')"),
  'the gate does not sit in front of the fallback'
);
check(errors.length > 0, 'the failure is reported rather than swallowed', `${errors.length} reported`);

/* =========================================================================
   done
   ========================================================================= */

await finish();
