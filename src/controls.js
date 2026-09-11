/* ==========================================================================
   controls.js — how the user drives the descent.

   The scroll position of the document *is* the progress: no wheel hijacking,
   no virtual scroll, nothing to fight. That keeps trackpads, touch, keyboard
   (arrows, page keys, home/end), the scrollbar and screen-reader navigation
   all working, and it is why the descent is verifiable by any tool that can
   call `window.scrollTo`.

   On top of that: a small pointer-driven look offset, and a slow idle drift
   so the camera never sits perfectly still.
   ========================================================================== */

import { clamp01 } from './timeline.js';

const LOOK_YAW = 3.4;      /* degrees at full deflection */
const LOOK_PITCH = 2.4;
const LOOK_TAU = 0.55;     /* seconds to catch up */
const IDLE_AFTER = 2.6;    /* seconds of stillness before the drift starts */

export class Controls {
  constructor({ reducedMotion = false } = {}) {
    this.reducedMotion = reducedMotion;
    this.enabled = true;

    this.targetProgress = 0;
    this.look = { yaw: 0, pitch: 0 };
    this._lookTarget = { yaw: 0, pitch: 0 };

    this._idle = 0;
    this._idleClock = 0;
    this._maxScroll = 1;

    this._listeners = { firstMove: [] };

    this._onScroll = () => this._readScroll();
    this._onPointer = (e) => this._onPointerMove(e);
    this._onBlur = () => this._zeroLook();

    window.addEventListener('scroll', this._onScroll, { passive: true });
    window.addEventListener('pointermove', this._onPointer, { passive: true });
    window.addEventListener('resize', this._onScroll, { passive: true });
    window.addEventListener('blur', this._onBlur);
  }

  onFirstMove(cb) { this._listeners.firstMove.push(cb); }

  measure() {
    this._maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    this._readScroll();
  }

  _readScroll() {
    this.measureIfNeeded();
    const p = clamp01(window.scrollY / this._maxScroll);
    if (p > 0.002 && !this._moved) {
      this._moved = true;
      for (const cb of this._listeners.firstMove) cb();
    }
    this.targetProgress = p;
  }

  measureIfNeeded() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    if (Math.abs(max - this._maxScroll) > 1) this._maxScroll = max;
  }

  _onPointerMove(e) {
    if (!this.enabled || this.reducedMotion) return;
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = (e.clientY / window.innerHeight) * 2 - 1;
    this._lookTarget.yaw = -nx * LOOK_YAW;
    this._lookTarget.pitch = -ny * LOOK_PITCH;
    this._idle = 0;
  }

  _zeroLook() {
    this._lookTarget.yaw = 0;
    this._lookTarget.pitch = 0;
  }

  update(dt) {
    const k = 1 - Math.exp(-dt / LOOK_TAU);

    if (!this.reducedMotion) {
      /* Idle drift: after a few still seconds the camera starts to breathe. */
      this._idle += dt;
      this._idleClock += dt;
      if (this._idle > IDLE_AFTER) {
        const ramp = Math.min(1, (this._idle - IDLE_AFTER) / 3.5);
        this._lookTarget.yaw = Math.sin(this._idleClock * 0.17) * 1.5 * ramp;
        this._lookTarget.pitch = Math.sin(this._idleClock * 0.11 + 1.7) * 0.9 * ramp;
      }
    }

    this.look.yaw += (this._lookTarget.yaw - this.look.yaw) * k;
    this.look.pitch += (this._lookTarget.pitch - this.look.pitch) * k;
  }

  /** True once the user has scrolled at all. */
  get hasMoved() { return !!this._moved; }

  dispose() {
    window.removeEventListener('scroll', this._onScroll);
    window.removeEventListener('pointermove', this._onPointer);
    window.removeEventListener('resize', this._onScroll);
    window.removeEventListener('blur', this._onBlur);
  }
}
