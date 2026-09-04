/**
 * Small math / helper library shared across the simulator.
 * Everything here is allocation-free where it matters (called per frame).
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, clamp01(invLerp(a, b, v)));
export const sign = (v) => (v < 0 ? -1 : v > 0 ? 1 : 0);

export function smoothstep(a, b, v) {
  const t = clamp01(invLerp(a, b, v));
  return t * t * (3 - 2 * t);
}

export function smootherstep(a, b, v) {
  const t = clamp01(invLerp(a, b, v));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Frame-rate independent exponential approach. `rate` = how fast, in 1/s. */
export function damp(current, target, rate, dt) {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

/** Move `current` toward `target` at most `maxDelta`. */
export function approach(current, target, maxDelta) {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Shortest signed angular difference, result in (-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Deterministic 32-bit PRNG (mulberry32) so worlds regenerate identically. */
export function makeRng(seed = 1337) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rng()) ;
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  return rng;
}

/** 2D value noise with smooth interpolation — used for terrain & textures. */
export function makeNoise2D(seed = 7) {
  const perm = new Uint8Array(512);
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return x - y;
      case 2: return -x + y;
      case 3: return -x - y;
      case 4: return x * 1.414;
      case 5: return -x * 1.414;
      case 6: return y * 1.414;
      default: return -y * 1.414;
    }
  };

  return function noise(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  };
}

/** Fractal brownian motion over a noise function. */
export function fbm(noise, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Catmull–Rom interpolation of a scalar sequence (uniform parametrisation). */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/** Sample a closed or open array of numbers as a Catmull–Rom spline. */
export function sampleSpline(arr, t, closed = false) {
  const n = arr.length;
  if (n === 0) return 0;
  if (n === 1) return arr[0];
  const f = closed ? t * n : t * (n - 1);
  let i = Math.floor(f);
  const frac = f - i;
  const at = (k) => {
    if (closed) return arr[((k % n) + n) % n];
    return arr[clamp(k, 0, n - 1)];
  };
  return catmullRom(at(i - 1), at(i), at(i + 1), at(i + 2), frac);
}

/** Format seconds as m:ss.hh */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '—:—.—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const h = Math.floor((sec * 100) % 100);
  return `${m}:${s.toString().padStart(2, '0')}.${h.toString().padStart(2, '0')}`;
}

export function formatDelta(sec) {
  if (!isFinite(sec)) return '';
  const s = sec >= 0 ? '+' : '-';
  const a = Math.abs(sec);
  return `${s}${a.toFixed(2)}`;
}

/** Minimal event emitter. */
export class Emitter {
  constructor() { this._m = new Map(); }
  on(evt, fn) {
    if (!this._m.has(evt)) this._m.set(evt, new Set());
    this._m.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._m.get(evt)?.delete(fn); }
  emit(evt, ...args) {
    const s = this._m.get(evt);
    if (!s) return;
    for (const fn of s) { try { fn(...args); } catch (e) { console.error(e); } }
  }
}

/** Rolling average used for the adaptive-resolution frame timer. */
export class RollingMean {
  constructor(n = 30, initial = 16.7) {
    this.buf = new Float32Array(n).fill(initial);
    this.i = 0; this.n = n;
    this.sum = initial * n;
  }
  push(v) {
    this.sum -= this.buf[this.i];
    this.buf[this.i] = v;
    this.sum += v;
    this.i = (this.i + 1) % this.n;
    return this.sum / this.n;
  }
  get mean() { return this.sum / this.n; }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const isTouchDevice = () =>
  (typeof window !== 'undefined') &&
  (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}
