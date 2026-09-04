/**
 * Input: a real draggable steering wheel for touch, plus keyboard, gamepad
 * and device-tilt. The wheel tracks the angle of the finger around its own
 * centre — grab it anywhere on the rim and it turns with your thumb, exactly
 * like the physical thing, rather than mapping an absolute screen position.
 */
import { clamp, clamp01, damp, angleDelta, vibrate, $, TAU } from '../core/util.js';
import { settings } from '../core/settings.js';

const MAX_WHEEL_ANGLE = Math.PI * 1.05;   // ±189° lock to lock (per side)

export class Input {
  constructor() {
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.shiftUp = false;
    this.shiftDown = false;
    this.manual = false;

    this._keys = new Set();
    this._keySteer = 0;
    this._wheelAngle = 0;
    this._wheelGrab = null;
    this._tiltZero = null;
    this._tilt = 0;
    this._padIndex = null;
    this._lastShiftUp = false;
    this._lastShiftDown = false;

    this.pedalGas = 0;
    this.pedalBrake = 0;
    this.mode = settings.get('steering');
    this.sensitivity = settings.get('steerSensitivity');

    this.actions = {
      reset: false, camera: false, horn: false, pause: false, lights: false,
    };
    this._pulse = {};

    this.bindDom();
    this.bindKeyboard();
    this.bindTilt();
  }

  /* ── DOM: wheel, pedals, aux buttons ─────────────────── */

  bindDom() {
    const zone = $('#wheel-zone');
    const wheel = $('#wheel');
    this.wheelEl = wheel;
    this.wheelZone = zone;

    if (zone) {
      const rect = () => zone.getBoundingClientRect();
      const angleOf = (cx, cy) => {
        const r = rect();
        return Math.atan2(cy - (r.top + r.height / 2), cx - (r.left + r.width / 2));
      };

      const down = (e) => {
        const t = e.changedTouches ? e.changedTouches[0] : e;
        this._wheelGrab = { id: t.identifier ?? 'mouse', last: angleOf(t.clientX, t.clientY) };
        zone.classList.add('grabbed');
        e.preventDefault();
      };
      const move = (e) => {
        if (!this._wheelGrab) return;
        const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
        for (const t of list) {
          if ((t.identifier ?? 'mouse') !== this._wheelGrab.id) continue;
          const a = angleOf(t.clientX, t.clientY);
          const d = angleDelta(this._wheelGrab.last, a);
          this._wheelGrab.last = a;
          const prev = this._wheelAngle;
          this._wheelAngle = clamp(this._wheelAngle + d, -MAX_WHEEL_ANGLE, MAX_WHEEL_ANGLE);
          // a light tick at full lock
          if (Math.abs(this._wheelAngle) >= MAX_WHEEL_ANGLE - 1e-3 && Math.abs(prev) < MAX_WHEEL_ANGLE - 1e-3) {
            if (settings.get('haptics')) vibrate(12);
          }
        }
        e.preventDefault();
      };
      const up = (e) => {
        if (!this._wheelGrab) return;
        const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
        for (const t of list) {
          if ((t.identifier ?? 'mouse') === this._wheelGrab.id) {
            this._wheelGrab = null;
            zone.classList.remove('grabbed');
          }
        }
      };

      zone.addEventListener('touchstart', down, { passive: false });
      zone.addEventListener('touchmove', move, { passive: false });
      zone.addEventListener('touchend', up, { passive: false });
      zone.addEventListener('touchcancel', up, { passive: false });
      zone.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') down(e); });
      addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e); });
      addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') up(e); });
    }

    this.bindPedal($('#pedal-gas'), (v) => { this.pedalGas = v; });
    this.bindPedal($('#pedal-brake'), (v) => { this.pedalBrake = v; });
    this.bindHold($('#btn-handbrake'), (v) => { this.handbrake = v ? 1 : 0; });
    this.bindTap($('#btn-shift-up'), () => { this._pulse.shiftUp = true; });
    this.bindTap($('#btn-shift-dn'), () => { this._pulse.shiftDown = true; });
    this.bindTap($('#btn-reset'), () => { this.actions.reset = true; });
    this.bindTap($('#btn-cam'), () => { this.actions.camera = true; });
    this.bindTap($('#btn-horn'), () => { this.actions.horn = true; });
  }

  /**
   * Pedals are pressure-ish: holding longer ramps to full, and dragging up
   * the pedal face gives finer control than a plain on/off button.
   */
  bindPedal(el, set) {
    if (!el) return;
    let active = null;
    const fill = el.querySelector('.pedal-fill');
    const apply = (v) => {
      set(v);
      if (fill) fill.style.height = `${v * 100}%`;
      el.classList.toggle('on', v > 0.02);
    };
    const posValue = (clientY) => {
      const r = el.getBoundingClientRect();
      return clamp01(1 - (clientY - r.top) / r.height);
    };
    const down = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      active = t.identifier ?? 'mouse';
      el._target = Math.max(0.55, posValue(t.clientY));
      apply(el._target);
      if (settings.get('haptics')) vibrate(8);
      e.preventDefault();
    };
    const move = (e) => {
      if (active === null) return;
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        if ((t.identifier ?? 'mouse') !== active) continue;
        el._target = posValue(t.clientY);
        apply(el._target);
      }
      e.preventDefault();
    };
    const up = (e) => {
      if (active === null) return;
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        if ((t.identifier ?? 'mouse') !== active) continue;
        active = null;
        el._target = 0;
        apply(0);
      }
    };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') down(e); });
    addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e); });
    addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') up(e); });
    el._apply = apply;
  }

  bindHold(el, set) {
    if (!el) return;
    const on = (e) => { set(true); el.classList.add('on'); e.preventDefault(); };
    const off = () => { set(false); el.classList.remove('on'); };
    el.addEventListener('touchstart', on, { passive: false });
    el.addEventListener('touchend', off);
    el.addEventListener('touchcancel', off);
    el.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') on(e); });
    addEventListener('pointerup', off);
  }

  bindTap(el, fn) {
    if (!el) return;
    const go = (e) => {
      fn();
      if (settings.get('haptics')) vibrate(10);
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('touchstart', go, { passive: false });
    el.addEventListener('click', (e) => { if (!e.detail || e.pointerType !== 'touch') go(e); });
  }

  /* ── keyboard ────────────────────────────────────────── */

  bindKeyboard() {
    const map = {
      ArrowLeft: 'left', KeyA: 'left',
      ArrowRight: 'right', KeyD: 'right',
      ArrowUp: 'gas', KeyW: 'gas',
      ArrowDown: 'brake', KeyS: 'brake',
      Space: 'handbrake',
      ShiftLeft: 'up', ShiftRight: 'up', KeyE: 'up',
      ControlLeft: 'down', KeyQ: 'down',
      KeyR: 'reset', KeyC: 'camera', KeyH: 'horn', KeyL: 'lights',
      Escape: 'pause', KeyP: 'pause',
    };
    addEventListener('keydown', (e) => {
      const a = map[e.code];
      if (!a) return;
      if (!this._keys.has(a)) {
        if (a === 'up') this._pulse.shiftUp = true;
        if (a === 'down') this._pulse.shiftDown = true;
        if (a === 'reset') this.actions.reset = true;
        if (a === 'camera') this.actions.camera = true;
        if (a === 'horn') this.actions.horn = true;
        if (a === 'lights') this.actions.lights = true;
        if (a === 'pause') this.actions.pause = true;
      }
      this._keys.add(a);
      if (a !== 'pause') e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      const a = map[e.code];
      if (a) this._keys.delete(a);
    });
    addEventListener('blur', () => this._keys.clear());
  }

  /* ── device tilt ─────────────────────────────────────── */

  bindTilt() {
    this._onOrient = (e) => {
      if (e.gamma === null || e.gamma === undefined) return;
      // portrait vs landscape: use whichever axis is the "roll" of the device
      const landscape = Math.abs(screen.orientation?.angle ?? 0) === 90;
      const raw = landscape ? (e.beta ?? 0) * Math.sign(screen.orientation?.angle || 90) : (e.gamma ?? 0);
      if (this._tiltZero === null) this._tiltZero = raw;
      this._tilt = clamp((raw - this._tiltZero) / 26, -1, 1);
    };
    addEventListener('deviceorientation', this._onOrient, { passive: true });
  }

  /** iOS needs an explicit permission grant, triggered from a user gesture. */
  async requestTilt() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      try { return (await D.requestPermission()) === 'granted'; } catch { return false; }
    }
    return true;
  }

  recentreTilt() { this._tiltZero = null; }

  /* ── gamepad ─────────────────────────────────────────── */

  pollGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (p && p.connected && p.axes.length >= 2) return p;
    }
    return null;
  }

  /* ── per-frame ───────────────────────────────────────── */

  update(dt) {
    this.mode = settings.get('steering');
    this.sensitivity = settings.get('steerSensitivity');
    this.manual = settings.get('transmission') === 'manual';

    const kLeft = this._keys.has('left') ? 1 : 0;
    const kRight = this._keys.has('right') ? 1 : 0;
    const kSteerTarget = kRight - kLeft;
    // keyboard steering ramps in and snaps back so it is drivable without an axis
    const rate = kSteerTarget === 0 ? 9.5 : 4.2;
    this._keySteer = damp(this._keySteer, kSteerTarget, rate, dt);

    const pad = this.pollGamepad();
    let padSteer = 0, padGas = 0, padBrake = 0, padHand = 0;
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.09 ? 0 : (v - Math.sign(v) * 0.09) / 0.91);
      padSteer = dz(pad.axes[0] ?? 0);
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      padGas = rt;
      padBrake = lt;
      padHand = pad.buttons[0]?.pressed ? 1 : 0;
      if (pad.buttons[5]?.pressed && !this._lastShiftUp) this._pulse.shiftUp = true;
      if (pad.buttons[4]?.pressed && !this._lastShiftDown) this._pulse.shiftDown = true;
      this._lastShiftUp = !!pad.buttons[5]?.pressed;
      this._lastShiftDown = !!pad.buttons[4]?.pressed;
      if (pad.buttons[3]?.pressed) this.actions.reset = true;
      if (pad.buttons[2]?.pressed) this.actions.camera = true;
    }

    /* wheel self-centres when nobody is holding it */
    if (!this._wheelGrab && this.mode === 'wheel') {
      const back = 6.5 + Math.abs(this._wheelAngle) * 2.4;
      this._wheelAngle = damp(this._wheelAngle, 0, back, dt);
      if (Math.abs(this._wheelAngle) < 0.004) this._wheelAngle = 0;
    }

    let touchSteer = 0;
    if (this.mode === 'wheel') touchSteer = this._wheelAngle / MAX_WHEEL_ANGLE;
    else if (this.mode === 'tilt') touchSteer = this._tilt;

    // strongest source wins so the player can mix wheel, keys and pad freely
    const candidates = [touchSteer, this._keySteer, padSteer];
    let steer = 0;
    for (const c of candidates) if (Math.abs(c) > Math.abs(steer)) steer = c;

    // a mild expo curve gives fine control near centre without losing full lock
    const expo = 0.30;
    const shaped = steer * (1 - expo) + Math.pow(Math.abs(steer), 2.1) * Math.sign(steer) * expo;
    this.steer = clamp(shaped * this.sensitivity, -1, 1);

    this.throttle = Math.max(this.pedalGas, this._keys.has('gas') ? 1 : 0, padGas);
    this.brake = Math.max(this.pedalBrake, this._keys.has('brake') ? 1 : 0, padBrake);
    this.handbrake = Math.max(this.handbrake, this._keys.has('handbrake') ? 1 : 0, padHand);
    if (!this._keys.has('handbrake') && !padHand && !document.querySelector('#btn-handbrake.on')) {
      this.handbrake = 0;
    }

    this.shiftUp = !!this._pulse.shiftUp;
    this.shiftDown = !!this._pulse.shiftDown;
    this._pulse.shiftUp = false;
    this._pulse.shiftDown = false;

    if (this.wheelEl) {
      this.wheelEl.style.transform = `rotate(${(this._wheelAngle * 180) / Math.PI}deg)`;
    }
  }

  /** Read and clear a one-shot action. */
  consume(name) {
    const v = this.actions[name];
    this.actions[name] = false;
    return v;
  }

  get wheelAngle() { return this._wheelAngle; }

  /** Drive the wheel graphic from elsewhere (replays, AI demo). */
  setWheelAngle(a) { this._wheelAngle = clamp(a, -MAX_WHEEL_ANGLE, MAX_WHEEL_ANGLE); }
}

export { MAX_WHEEL_ANGLE, TAU };
