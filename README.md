# ABYSS

An interactive 3D descent from space to the bottom of an ocean, driven entirely
by scrolling. The fall is 10,916 metres long and passes through five stages: low
orbit, a cloud layer you drop straight through, a sunlit sea surface seen from
below, the dark middle depths, and finally a warm glowing core.

Everything in the picture is made by code while it runs. There are no image
files, no 3D models, no video and no sound files. The continents, the light
patterns in the water, the shafts of sunlight, the glowing core and the entire
soundtrack are all calculated on the machine that is viewing it. The only
outside library is three.js, fetched from the internet when the page loads.

```
0 m ──────── I   Orbit        7,000 stars, a planet turning below you
1,240 m ──── II  Cloud deck   the weather, from the inside
4,180 m ──── III Sunlit sea   the surface closes above you; light arrives in shafts
7,640 m ──── IV  Twilight     the red is gone; drifting particles, glowing life
10,916 m ─── V   Abyss        embers, cold rock, and a core that is warm
```

---

## Running it

You need a static web server. The page uses modern browser features that need a
real address, so opening `index.html` straight from disk will not work.

```bash
npx --yes serve -l 8080 .      # or: python -m http.server 8080
# → http://localhost:8080
```

You need a browser with WebGL, modern JavaScript modules, and support for import
maps (any current Chrome, Edge, Firefox or Safari). Without WebGL the page
shows a written description of the descent instead of a broken black rectangle.

### How you move through it

You scroll. That is the only control. Nothing takes over your scroll wheel, so
trackpads, touch screens, the scrollbar, the arrow keys, `Page Up` and
`Page Down`, `Home` and `End`, and screen-reader navigation all work. Any tool
that can tell the browser to scroll can drive the whole experience.

### Settings you can put in the address

| Add to the address | What it does |
| --- | --- |
| `?quality=high`, `?quality=medium`, `?quality=low` | Forces a quality level and turns off the automatic fallback |
| `?t=0.42` | Starts already at that depth — 0 is orbit, 1 is the core |
| `?debug=1` | Shows frame rate, draw calls, triangle count and current stage |
| `?enter=1` | Skips the starting screen — used by the test harness |

For example: `http://localhost:8080/?t=0.5&debug=1`

---

## How it works

### One number drives everything

The scroll position **is** the depth. `src/timeline.js` reads it, smooths it
over about 170 milliseconds, and from that single number works out:

- where the camera is, which way it faces, which way it is rolled, and how wide
  its view is — each as a smooth curve through eleven evenly spaced points;
- the colour and thickness of the haze;
- every adjustment to the finished picture — glow, edge colour-split, corner
  darkening, grain, sunlight shafts, heat distortion, colour tint and exposure;
- the depth reading on the screen, which stage you are in, and every fade from
  one stage to the next.

Because there is exactly one source of truth, the on-screen reading, the picture
and the sound cannot disagree about where you are. The automated check confirms
that at eleven points on the way down.

### Files

```
index.html            drawing surface, starting screen, on-screen text, error panel
styles.css            all of the interface styling
main.js               start-up, the render loop, wiring, debug readout
package.json          no dependencies; `npm start` runs a static server
src/
  timeline.js         the choreography: stages, camera path, haze, grade  ← start here
  particles.js        one particle system on the graphics card, reused by every stage
  glsl.js             shared graphics-card code: random noise, haze, colour handling
  postfx.js           the extra passes and the custom grade pass
  controls.js         reading the scroll, pointer look, idle drift
  quality.js          three quality levels and the automatic step down
  audio.js            generated sound (browser audio, no files)
  hud.js              starting screen, depth readout, progress rail, captions, end card
  world/
    layer.js          the base every stage is built from
    index.js          assembles the stages, owns the fade schedule
    sun.js            the light, drawn as a flat shape that faces the camera
    orbit.js          I    star dome, star field, planet, atmosphere
    deck.js           II   the cloud sheets and the vapour between them
    sea.js            III  the surface, the light patterns, the shafts, bubbles
    twilight.js       IV   drifting particles, glowing life, dark shapes
    abyss.js          V    the glowing core, its halo, embers, cold rock
tools/verify.mjs      the automated check, run in headless Chrome
```

### What you see in the world

**The planet** is drawn by a program that runs for every pixel: continents, ice
at the poles, a moving cloud layer, a bright glint off the open ocean, warm city
lights on the night side, and a soft bright edge around the whole planet.

**The cloud deck** is 46 real sheets of geometry, each pushed out of shape, with
light catching the side that faces the sun. Because the layers are real
geometry, they slide past each other as you fall between them.

**The sea surface** from below carries two moving fields of light patterns — the
kind you see on the underside of water — a bright glint on the sun's side, and a
change of behaviour with angle: looking straight up you see through the surface,
and at a shallow angle it turns into a mirror.

**The shafts of sunlight** are flat shapes, wider at the bottom, with random
noise eating into their edges, brightest on the sun's side of the descent.

**The core** at the bottom is glowing, ridged material with a bright edge and
embers rising off it.

### After the world is drawn

Five passes run over the finished picture:

1. **A glow pass** that spreads bright areas outward.
2. **A grade pass**, written for this project, that runs while the colours are
   still in their raw brightness. This is what lets the sunlight shafts pick out
   the truly bright parts of the picture, and lets the depth tint darken the
   shadows without losing the highlights. It also pulls the red and blue apart
   near the edges, bends the picture with rising heat, and applies the colour
   tint.
3. **An output pass.**
4. **A finish pass**, which runs *after* the brightness has been squeezed down
   to what a screen can show. Darkening the corners and adding film grain belong
   here. Fine grain of about four hundredths added to a normal picture value
   looks like grain; added to a near-black raw value it turns the darkness into
   noise.

### Sound

The soundtrack is built while the page runs: four slightly detuned tones, soft
filtered noise, a rare distant ping, and a low swell underneath. A reverb is
generated rather than loaded from a file.

How deep you are controls how muffled the sound is, how loud the wash is, how
much reverb is added, and the pitch of the low drone — it falls by a minor third
by the time you reach the core. Sound can only start after a click, because
browsers require it. The starting screen has a button for it, and it can be
switched off there or in the on-screen controls. If the sound cannot start,
nothing else is affected.

---

## Changing the descent

Almost everything you would want to change lives in `src/timeline.js`:

| Want to change | Where to look |
| --- | --- |
| Where a stage begins, its name, its text | `STRATA` |
| How the camera falls, sways, tilts and widens | `CAMERA` (eleven keys for each, at `t = 0, 0.1, … 1.0`) |
| How thick the water is at each depth | `FOG` |
| Glow, edge colour-split, corner darkening, grain, shafts, heat, tint | `GRADE` |
| Which stage is on screen when | `FADE` in `src/world/index.js` |

Particle counts, colours and movement are the options at the bottom of each file
in `src/world/`. The graphics-card numbers — light-pattern size, cloud density,
the core — are at the top of those same files.

Two conventions worth knowing before you change a graphics-card program:

1. **The direction to the sun points from a surface toward the light.** So the
   amount of light a surface receives is always the same simple calculation.
   The sun shape itself sits 900 units along that direction.
2. **Haze is applied by hand**, using a shared helper from `src/glsl.js`, not by
   three.js. Three's built-in haze blends toward the haze colour, which on a
   particle that adds light to the picture *adds* light instead of removing it.
   So every material carries its own haze colour, thickness and fade, and the
   world writes them for every material once per frame.

---

## Performance

| Level | Sharpness | Particles | Glow size | Sunlight samples |
| --- | --- | --- | --- | --- |
| high | up to 2× | 100% | half size | 16 |
| medium | up to 1.5× | 62% | 42% size | 11 |
| low | 1× | 34% | 30% size | 7 |

The level is chosen from the device when the page loads. After that, a manager
watches the middle frame time and steps **down** one level if the machine cannot
hold about 42 frames per second. It never steps back up, because switching
between levels is worse than running one level low.

Particle counts are set when the descent starts, so a machine that starts low
cannot gain particles later. Similarly, the shapes of the geometry are fixed at
load. Almost no work is done on the main processor while the scene runs: the
particles move themselves, the clouds and water patterns live on the graphics
card, and changing level only changes how many of them are drawn.

---

## Accessibility

- Scrolling is the browser's own, and there is no key handling anywhere in the
  app, so wheel, trackpad, touch, the scrollbar, `Page Up` and `Page Down`, and
  `Home` and `End` all work without the page needing to know about them.
- A hidden live region announces each stage as you enter it. It announces the
  stage name, not the depth, because a reading that changes every frame cannot
  be used.
- If the visitor has asked their system to reduce motion, the sideways sway, the
  roll and the widening of the view are damped, and the pointer look and the
  idle drift are switched off. The descent still works.
- The starting screen, the sound control and the quality control are real
  buttons, a properly labelled dropdown, and a labelled progress bar.
- Without WebGL, the fallback describes what the descent would have shown.

---

## Checking it

```bash
node tools/verify.mjs            # full run; writes pictures into tools/
node tools/verify.mjs --quick    # checks only, no pictures
node tools/verify.mjs --mobile   # the whole thing at phone size, 390×844

# only start, enter, then capture these positions — a shorter art pass
node tools/verify.mjs --shots="0.5:sea,1:abyss-core"
```

The check starts a small server for this folder, opens headless Chrome with
software 3D rendering, drives the browser directly, and reports every console
error and uncaught crash. Chrome reports a graphics-card program that fails to
compile through the console rather than as a crash, so a run can otherwise look
healthy while most of the scene is invisible. That is why console errors count
as failures.

It then checks four things:

1. **Start-up.** The script runs, the gate has lifted, the HUD is up, the canvas
   is a live WebGL surface, the library loaded, the rail has one entry per
   stage, and nothing failed in the console.
2. **The descent.** It scrolls to eleven positions down the page, one tenth
   apart, and at each one confirms that the scroll position, the smoothed progress, the
   depth, the value the depth curve returns, the stage index, the highlighted
   rail entry, the number printed on screen and the visible layers all agree.
   It also confirms that depth never goes backwards.
3. **Every stage is populated.** At each stage's midpoint, its caption must be
   up and at least one layer must be visible — no point on the way down may
   leave the screen empty.
4. **The awkward paths.** A forced low quality level must be applied and must cap
   screen sharpness; with `--mobile`, the canvas must match a 390×844 screen and
   the rail must stay inside it; and with WebGL removed before the page loads,
   the fallback panel must actually be painted, the gate must not sit in front
   of it, and the page must not claim to have started.

The check reaches into the page through `window.__abyss`, which the app exposes
for exactly this purpose. It is not a public interface.

The no-WebGL check asks the browser what is really on screen and where, rather
than reading a stored flag. That matters here: the error panel was once painted
over the whole experience while the flag still said it was hidden, because a
page style rule overrode the browser's built-in rule for hidden elements.

Pictures are drawn by software, so they are correct but slow. The frame rate
under software rendering says nothing about a real graphics card.

---

## Known limits

- **The frame rate under software rendering is not meaningful.** The check runs
  without a real graphics card on purpose. On a real one, the scene is a few
  hundred thousand triangles plus a glow pass.
- **A quality change at run time cannot add particles or rebuild geometry** that
  was not created at load.
- **The sunlight shafts are an approximation of the screen, not of the space.**
  They read the finished picture rather than a map of what is blocking the light.
- **There is no use of the phone's rotation sensor to look around.** It would
  need a permission prompt, which does not fit an experience that starts on a
  button.
- **The sound is on by default rather than off.** The starting screen's button
  begins it on the first click, which is what browsers require. If the sound
  system cannot start — in a headless browser, or on a machine with no output
  device — the code says so in the console and switches the button back off.
  The sound has not been verified by listening on a real device.

MIT.
