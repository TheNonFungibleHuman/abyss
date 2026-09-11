/* ==========================================================================
   audio.js — the sound of going down.

   No audio files: everything is generated with WebAudio. Three drone
   oscillators, a filtered noise wash, a sparse distant ping, and a sub-bass
   swell that only arrives near the core. Depth drives the filter, the pitches
   and the reverb, so the mix closes in exactly as the picture does.

   Browsers will not start an AudioContext without a gesture, so nothing is
   created until `enable()` is called from a click. Everything is wrapped:
   if audio cannot start on this machine, the descent is unaffected.
   ========================================================================== */

const A = 55;               /* base drone pitch, Hz */

/** Depths → audio targets. Sampled with the same keys as the rest of the app. */
const CUTOFF = [
  { t: 0.00, v: 5200 },
  { t: 0.19, v: 1500 },
  { t: 0.38, v: 950 },
  { t: 0.58, v: 420 },
  { t: 0.80, v: 300 },
  { t: 1.00, v: 240 },
];
const WASH = [
  { t: 0.00, v: 0.05 },
  { t: 0.19, v: 0.20 },
  { t: 0.38, v: 0.13 },
  { t: 0.58, v: 0.16 },
  { t: 0.80, v: 0.11 },
  { t: 1.00, v: 0.07 },
];
const SUB = [
  { t: 0.00, v: 0.0 },
  { t: 0.55, v: 0.0 },
  { t: 0.80, v: 0.10 },
  { t: 1.00, v: 0.30 },
];
const VERB = [
  { t: 0.00, v: 0.10 },
  { t: 0.19, v: 0.22 },
  { t: 0.38, v: 0.34 },
  { t: 0.58, v: 0.42 },
  { t: 0.80, v: 0.55 },
  { t: 1.00, v: 0.62 },
];

function sample(keys, t) {
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const k = (t - a.t) / (b.t - a.t || 1);
      const s = k * k * (3 - 2 * k);
      return a.v + (b.v - a.v) * s;
    }
  }
  return last.v;
}

function noiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    /* Brown-ish noise: closer to moving water than white noise is. */
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  return buffer;
}

function impulseResponse(ctx, seconds, decay) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const n = i / length;
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - n, decay);
    }
  }
  return buffer;
}

export class Ambience {
  constructor() {
    this.enabled = false;
    this.failed = false;
    this.ctx = null;
    this._progress = 0;
    this._pingTimer = null;
    this._targets = { cutoff: 5200, wash: 0.05, sub: 0, verb: 0.1 };
  }

  get isOn() { return this.enabled; }

  /** Must be called from a user gesture. Resolves true if sound is running. */
  async enable() {
    if (this.enabled) return true;
    if (this.failed) return false;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('no AudioContext');

      if (!this.ctx) this._build(new Ctx());
      if (this.ctx.state === 'suspended') {
        /* `resume()` can hang rather than reject on a machine with no audio
           device (headless browsers, some Linux containers). Racing it keeps
           the promise chain moving and the button honest. */
        const resumed = await Promise.race([
          this.ctx.resume().then(() => true, () => false),
          new Promise((r) => setTimeout(() => r(false), 2000)),
        ]);
        if (!resumed && this.ctx.state !== 'running') {
          throw new Error('audio context would not resume');
        }
      }
      if (this.ctx.state !== 'running') throw new Error(`state ${this.ctx.state}`);

      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), now);
      this.master.gain.linearRampToValueAtTime(0.9, now + 2.5);

      this.enabled = true;
      this._schedulePing();
      return true;
    } catch (err) {
      this.failed = true;
      this.enabled = false;
      /* Not fatal: the descent is a visual experience that happens to have
         sound, not the other way round. */
      console.warn('[abyss] audio unavailable:', err.message);
      return false;
    }
  }

  async disable() {
    if (!this.ctx || !this.enabled) { this.enabled = false; return; }
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setValueAtTime(this.master.gain.value, now);
    this.master.gain.linearRampToValueAtTime(0.0001, now + 1.2);
    this.enabled = false;
    if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null; }
    /* Leave the graph running but silent; tearing it down risks a click on
       the next enable, and an idle graph costs nothing measurable. */
  }

  _build(ctx) {
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.0001;

    this.convolver = ctx.createConvolver();
    this.convolver.buffer = impulseResponse(ctx, 3.2, 2.6);

    this.dry = ctx.createGain();
    this.dry.gain.value = 1;
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.1;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 5200;
    this.filter.Q.value = 0.7;

    this.filter.connect(this.dry);
    this.filter.connect(this.wet);
    this.wet.connect(this.convolver);
    this.convolver.connect(this.master);
    this.dry.connect(this.master);
    this.master.connect(ctx.destination);

    /* --- drone: three oscillators, slightly detuned --- */
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.24;
    this.droneGain.connect(this.filter);

    this.osc = [];
    const specs = [
      { type: 'sine', mult: 1, gain: 0.6, detune: -6 },
      { type: 'sine', mult: 1, gain: 0.4, detune: 7 },
      { type: 'triangle', mult: 1.5, gain: 0.16, detune: 3 },
      { type: 'sine', mult: 2, gain: 0.07, detune: -3 },
    ];
    for (const spec of specs) {
      const osc = ctx.createOscillator();
      osc.type = spec.type;
      osc.frequency.value = A * spec.mult;
      osc.detune.value = spec.detune;

      const g = ctx.createGain();
      g.gain.value = spec.gain;
      osc.connect(g);
      g.connect(this.droneGain);
      osc.start();

      /* A slow, irrational-rate drift keeps the drone from ever sounding
         static without introducing a recognisable pattern. */
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.017 + Math.random() * 0.031;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 1.6 + Math.random() * 2.4;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start();

      this.osc.push({ osc, base: A * spec.mult, gain: g });
    }

    /* --- wash: filtered brown noise --- */
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuffer(ctx, 4);
    this.noise.loop = true;

    this.washFilter = ctx.createBiquadFilter();
    this.washFilter.type = 'bandpass';
    this.washFilter.frequency.value = 420;
    this.washFilter.Q.value = 0.6;

    this.washGain = ctx.createGain();
    this.washGain.gain.value = 0.05;

    this.noise.connect(this.washFilter);
    this.washFilter.connect(this.washGain);
    this.washGain.connect(this.filter);
    this.noise.start();

    /* --- sub: a swell that only exists near the bottom --- */
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = 31;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.master);   /* bypasses the lowpass: it is already low */
    this.sub.start();
  }

  /** Called every frame with the smoothed progress. */
  setProgress(t) {
    if (!this.ctx || !this.enabled) return;
    const p = Math.max(0, Math.min(1, t));

    /* Only touch AudioParams when the target moves meaningfully. */
    if (Math.abs(p - this._progress) < 0.0015) return;
    this._progress = p;

    const now = this.ctx.currentTime;
    const glide = 0.35;

    const cutoff = sample(CUTOFF, p);
    const wash = sample(WASH, p);
    const sub = sample(SUB, p);
    const verb = sample(VERB, p);

    this.filter.frequency.setTargetAtTime(cutoff, now, glide);
    this.washGain.gain.setTargetAtTime(wash, now, glide);
    this.subGain.gain.setTargetAtTime(sub, now, glide);
    this.wet.gain.setTargetAtTime(verb, now, glide);
    this.washFilter.frequency.setTargetAtTime(260 + 900 * (1 - p), now, glide);

    /* The drone sinks with the descent: a minor third down by the core. */
    for (const entry of this.osc) {
      entry.osc.frequency.setTargetAtTime(entry.base * (1 - 0.30 * p), now, glide + 0.4);
    }
  }

  _schedulePing() {
    if (!this.enabled) return;
    const delay = 4000 + Math.random() * 9000;
    this._pingTimer = setTimeout(() => {
      this._ping();
      this._schedulePing();
    }, delay);
  }

  _ping() {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;

    const now = ctx.currentTime + 0.02;
    const pitch = 220 * Math.pow(2, Math.floor(Math.random() * 5) / 12) * (Math.random() < 0.5 ? 1 : 2);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = pitch;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);

    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 2 - 1;

    osc.connect(gain);
    if (pan) { gain.connect(pan); pan.connect(this.filter); } else { gain.connect(this.filter); }

    osc.start(now);
    osc.stop(now + 2.8);
  }

  dispose() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ctx = null;
    this.enabled = false;
  }
}
