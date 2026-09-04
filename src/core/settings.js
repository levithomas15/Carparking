/**
 * Persisted user settings + graphics quality presets.
 *
 * Quality presets drive every expensive knob in the renderer so the same
 * scene can run on a phone and on a desktop GPU. `auto` benchmarks the
 * device at boot and then keeps nudging the render scale at runtime.
 */
import { Emitter, clamp } from './util.js';

const KEY = 'apex.settings.v1';

export const PRESETS = {
  low: {
    name: 'NIEDRIG',
    pixelRatio: 1.0,
    renderScale: 0.72,
    shadows: false,
    shadowSize: 1024,
    bloom: true,
    bloomStrength: 0.26,
    smaa: false,
    motionBlur: false,
    depthOfField: false,
    grain: false,
    chromatic: false,
    envRes: 128,
    dynamicEnv: false,
    envUpdateInterval: 0,
    reflectiveGround: false,
    particles: 0.35,
    drawDistance: 620,
    anisotropy: 2,
    cityDensity: 0.45,
    grassBlades: 0,
    lightsAtNight: 6,
  },
  medium: {
    name: 'MITTEL',
    pixelRatio: 1.5,
    renderScale: 0.88,
    shadows: true,
    shadowSize: 1024,
    bloom: true,
    bloomStrength: 0.32,
    smaa: false,
    motionBlur: true,
    depthOfField: false,
    grain: true,
    chromatic: true,
    envRes: 128,
    dynamicEnv: true,
    envUpdateInterval: 12,
    reflectiveGround: false,
    particles: 0.7,
    drawDistance: 900,
    anisotropy: 4,
    cityDensity: 0.7,
    grassBlades: 0,
    lightsAtNight: 14,
  },
  high: {
    name: 'HOCH',
    pixelRatio: 2.0,
    renderScale: 1.0,
    shadows: true,
    shadowSize: 2048,
    bloom: true,
    bloomStrength: 0.38,
    smaa: true,
    motionBlur: true,
    depthOfField: true,
    grain: true,
    chromatic: true,
    envRes: 256,
    dynamicEnv: true,
    envUpdateInterval: 6,
    reflectiveGround: true,
    particles: 1.0,
    drawDistance: 1400,
    anisotropy: 8,
    cityDensity: 1.0,
    grassBlades: 0,
    lightsAtNight: 26,
  },
  ultra: {
    name: 'ULTRA',
    pixelRatio: 2.5,
    renderScale: 1.0,
    shadows: true,
    shadowSize: 4096,
    bloom: true,
    bloomStrength: 0.44,
    smaa: true,
    motionBlur: true,
    depthOfField: true,
    grain: true,
    chromatic: true,
    envRes: 256,
    dynamicEnv: true,
    envUpdateInterval: 3,
    reflectiveGround: true,
    particles: 1.5,
    drawDistance: 2200,
    anisotropy: 16,
    cityDensity: 1.0,
    grassBlades: 0,
    lightsAtNight: 40,
  },
};

const DEFAULTS = {
  quality: 'auto',        // auto | low | medium | high | ultra
  steering: 'wheel',      // wheel | tilt | buttons
  camera: 'chase',        // chase | hood | cockpit | orbit | cinematic
  transmission: 'auto',   // auto | manual
  assistABS: true,
  assistTC: true,
  assistESC: false,
  steerSensitivity: 1.0,
  fov: 68,
  volumeMaster: 0.85,
  volumeEngine: 1.0,
  timeOfDay: 0.34,        // 0..1 across a full day; 0.34 ≈ late morning
  dynamicTime: false,
  weather: 'clear',       // clear | wet | dusk | night
  car: 0,
  paint: {},
  rim: {},
  haptics: true,
  showFps: false,
  bestLap: {},
};

class Settings extends Emitter {
  constructor() {
    super();
    this.data = { ...DEFAULTS };
    this.load();
    this._autoTier = null;
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...DEFAULTS, ...parsed, paint: { ...parsed.paint }, rim: { ...parsed.rim }, bestLap: { ...parsed.bestLap } };
      }
    } catch { /* private mode / disabled storage — defaults are fine */ }
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    if (this.data[k] === v) return;
    this.data[k] = v;
    this.save();
    this.emit('change', k, v);
    this.emit(`change:${k}`, v);
  }

  /** Benchmarks the device once and caches the resulting tier. */
  detectTier(renderer) {
    if (this._autoTier) return this._autoTier;
    let score = 2; // medium baseline
    try {
      const gl = renderer.getContext();
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '') || '';
      const g = String(gpu).toLowerCase();
      const cores = navigator.hardwareConcurrency || 4;
      const mem = navigator.deviceMemory || 4;
      const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

      if (/apple (a1[7-9]|m[1-9])|adreno \(tm\) 7[3-9]|adreno \(tm\) 8|immortalis|rtx|radeon rx [67]/.test(g)) score = 4;
      else if (/apple (a1[3-6])|adreno \(tm\) [67]|mali-g[7-9]|geforce|radeon|intel arc/.test(g)) score = 3;
      else if (/adreno \(tm\) [45]|mali-g[3-6]|powervr|intel\(r\) (uhd|hd)/.test(g)) score = 2;
      else if (/swiftshader|llvmpipe|software/.test(g)) score = 1;

      if (cores <= 4 && mobile) score -= 0.5;
      if (mem <= 3) score -= 0.5;
      if (!mobile && cores >= 8) score += 0.5;
      if (Math.max(screen.width, screen.height) * devicePixelRatio > 2600) score -= 0.25;
    } catch { /* fall back to medium */ }

    const idx = clamp(Math.round(score), 1, 4);
    this._autoTier = ['low', 'low', 'medium', 'high', 'ultra'][idx];
    return this._autoTier;
  }

  /** Effective preset object (resolves `auto`). */
  preset(renderer) {
    const q = this.data.quality;
    const key = q === 'auto' ? (this._autoTier || (renderer ? this.detectTier(renderer) : 'medium')) : q;
    return { key, ...PRESETS[key] };
  }

  paintFor(carId, fallback) {
    return this.data.paint[carId] ?? fallback;
  }
  setPaint(carId, idx) {
    this.data.paint[carId] = idx;
    this.save();
    this.emit('change:paint', carId, idx);
  }
  rimFor(carId, fallback = 0) {
    return this.data.rim[carId] ?? fallback;
  }
  setRim(carId, idx) {
    this.data.rim[carId] = idx;
    this.save();
    this.emit('change:rim', carId, idx);
  }
  bestLapFor(carId) { return this.data.bestLap[carId] ?? Infinity; }
  setBestLap(carId, t) {
    if (t < this.bestLapFor(carId)) { this.data.bestLap[carId] = t; this.save(); return true; }
    return false;
  }
}

export const settings = new Settings();
