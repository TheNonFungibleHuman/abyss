/* ==========================================================================
   hud.js — the interface layer's only JavaScript.

   Owns: the entry gate and its progress bar, the depth readout, the strata
   rail, the captions, the hint, the end card, and the screen-reader
   narration. Everything it prints comes from the timeline, so the numbers on
   screen and the numbers in the picture are the same numbers.
   ========================================================================== */

import { STRATA, captionOpacity } from './timeline.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

export class Hud {
  constructor({
    onEnter, onSound, onQuality, onResurface,
  } = {}) {
    this.onEnter = onEnter;
    this.onSound = onSound;
    this.onQuality = onQuality;
    this.onResurface = onResurface;

    this.el = {
      gate: document.getElementById('gate'),
      gateBar: document.getElementById('gateBar'),
      gateFill: document.querySelector('#gateBar i'),
      gateStatus: document.getElementById('gateStatus'),
      enter: document.getElementById('enterBtn'),
      gateSound: document.getElementById('gateSoundBtn'),
      hud: document.getElementById('hud'),
      rail: document.getElementById('rail'),
      depthNum: document.getElementById('depthNum'),
      depthFill: document.getElementById('depthFill'),
      numeral: document.getElementById('stratumNumeral'),
      name: document.getElementById('stratumName'),
      note: document.getElementById('stratumNote'),
      brandStratum: document.getElementById('brandStratum'),
      captions: document.getElementById('captions'),
      hint: document.getElementById('hint'),
      endcard: document.getElementById('endcard'),
      resurface: document.getElementById('resurfaceBtn'),
      sound: document.getElementById('soundBtn'),
      quality: document.getElementById('qualitySel'),
      live: document.getElementById('live'),
      fallback: document.getElementById('fallback'),
      fallbackTitle: document.getElementById('fallbackTitle'),
      fallbackBody: document.getElementById('fallbackBody'),
    };

    this._lastDepth = -1;
    this._lastStratum = -1;
    this._railItems = [];
    this._captionEls = [];
    this._announced = -1;

    this._buildRail();
    this._bind();

    /* Unhidden up front, kept invisible by CSS: an element that goes from
       display:none straight to visible cannot animate. */
    this.el.endcard.hidden = false;
  }

  /* ------------------------------- build ------------------------------- */

  _buildRail() {
    for (const s of STRATA) {
      const li = document.createElement('li');
      const name = document.createElement('b');
      name.textContent = s.name;
      const meters = document.createElement('em');
      meters.textContent = `${fmt(s.meters)} m`;
      li.append(name, meters);
      this.el.rail.append(li);
      this._railItems.push(li);

      const p = document.createElement('p');
      p.innerHTML = s.caption;
      this.el.captions.append(p);
      this._captionEls.push(p);
    }
  }

  _bind() {
    this.el.enter?.addEventListener('click', () => this.onEnter?.());
    this.el.gateSound?.addEventListener('click', () => this.onSound?.());
    this.el.sound?.addEventListener('click', () => this.onSound?.());
    this.el.resurface?.addEventListener('click', () => this.onResurface?.());
    this.el.quality?.addEventListener('change', (e) => this.onQuality?.(e.target.value));
  }

  /* -------------------------------- gate -------------------------------- */

  boot(pct, message) {
    const v = Math.max(0, Math.min(100, pct));
    this.el.gateFill.style.width = `${v}%`;
    this.el.gateBar.setAttribute('aria-valuenow', String(Math.round(v)));
    if (message) this.el.gateStatus.textContent = message;
  }

  ready() {
    this.boot(100, 'Ready');
    this.el.enter.disabled = false;
    this.el.enter.focus({ preventScroll: true });
  }

  fail(message) {
    this.boot(0, 'Cannot render here');
    this.el.enter.disabled = true;
    this.showFallback('WebGL unavailable', message);
  }

  showFallback(title, body) {
    if (title) this.el.fallbackTitle.textContent = title;
    if (body) this.el.fallbackBody.textContent = body;
    this.el.fallback.hidden = false;
    this.el.gate.classList.add('is-gone');
    document.documentElement.classList.remove('is-booting');
  }

  enter() {
    this.el.gate.classList.add('is-gone');
    this.el.hud.hidden = false;
    /* One frame later, so the transition has something to animate from. */
    requestAnimationFrame(() => this.el.hud.classList.add('is-on'));
    document.documentElement.classList.remove('is-booting');
  }

  /* ------------------------------ per frame ----------------------------- */

  update({ t, depth, stratumIndex }) {
    const depthRounded = Math.round(depth);
    if (depthRounded !== this._lastDepth) {
      this._lastDepth = depthRounded;
      this.el.depthNum.textContent = fmt(depthRounded);
      this.el.depthFill.style.width = `${(t * 100).toFixed(2)}%`;
    }

    if (stratumIndex !== this._lastStratum) {
      this._applyStratum(stratumIndex);
      this._lastStratum = stratumIndex;
    }

    for (let i = 0; i < this._captionEls.length; i++) {
      const o = captionOpacity(STRATA[i], t);
      const el = this._captionEls[i];
      el.style.opacity = o.toFixed(3);
      el.classList.toggle('is-on', o > 0.02);
    }

    const showEnd = t > 0.945;
    if (showEnd !== this._endShown) {
      this._endShown = showEnd;
      this.el.endcard.classList.toggle('is-on', showEnd);
    }
  }

  _applyStratum(index) {
    const s = STRATA[index];
    this.el.numeral.textContent = s.numeral;
    this.el.name.textContent = s.name;
    this.el.note.textContent = s.note;
    this.el.brandStratum.textContent = s.name;

    for (let i = 0; i < this._railItems.length; i++) {
      const li = this._railItems[i];
      li.classList.toggle('is-current', i === index);
      li.classList.toggle('is-past', i < index);
    }

    /* Announce the stratum, not the depth: a live region that updates every
       frame is unusable. */
    if (index !== this._announced) {
      this._announced = index;
      this.el.live.textContent = `${s.numeral}. ${s.name}. ${s.note}.`;
    }
  }

  dismissHint() {
    this.el.hint?.classList.add('is-off');
  }

  setSound(on) {
    for (const el of [this.el.sound, this.el.gateSound]) {
      if (!el) continue;
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (el === this.el.gateSound) el.textContent = on ? 'Sound on' : 'Sound off';
    }
  }

  setQuality(id) {
    if (this.el.quality && this.el.quality.value !== id) this.el.quality.value = id;
  }
}
