/**
 * Procedural engine audio.
 *
 * No samples: the exhaust note is synthesised from the firing frequency and a
 * harmonic stack shaped to the engine's cylinder count, which is why the V10
 * and the V12 sound like different engines rather than the same buzz at a
 * different pitch. Load, overrun crackle, transmission whine, tyre scrub and
 * wind are layered on top.
 */
import { clamp, clamp01, lerp, damp } from '../core/util.js';
import { settings } from '../core/settings.js';

const noiseBufferCache = new Map();

function makeNoiseBuffer(ctx, seconds = 2.4) {
  const key = `${ctx.sampleRate}:${seconds}`;
  if (noiseBufferCache.has(key)) return noiseBufferCache.get(key);
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    // lightly pinked so it reads as air rather than hiss
    b0 = 0.99765 * b0 + w * 0.0990460;
    b1 = 0.96300 * b1 + w * 0.2965164;
    b2 = 0.57000 * b2 + w * 1.0526913;
    d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22;
  }
  noiseBufferCache.set(key, buf);
  return buf;
}

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    this.voices = [];
    this._rpm = 900;
    this._load = 0;
    this._crackle = 0;
    this._lastThrottle = 0;
    this._muted = false;
  }

  /** Must be called from a user gesture on iOS/Safari. */
  async init(carAudioSpec) {
    if (this.ctx) { await this.resume(); this.configure(carAudioSpec); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = new AC({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = settings.get('volumeMaster');
    // a gentle limiter keeps the mix from clipping when everything piles in
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.16;
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = settings.get('volumeEngine');
    this.engineBus.connect(this.master);

    /* ── exhaust: a stack of detuned saw/square partials ── */
    this.partials = [];
    for (let i = 0; i < 7; i++) {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : i < 3 ? 'square' : 'sawtooth';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(this.engineBus);
      osc.start();
      this.partials.push({ osc, gain, mult: 1, level: 0 });
    }

    /* ── intake / combustion noise ── */
    this.noiseSrc = ctx.createBufferSource();
    this.noiseSrc.buffer = makeNoiseBuffer(ctx);
    this.noiseSrc.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 420;
    this.noiseFilter.Q.value = 0.8;
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    this.noiseSrc.connect(this.noiseFilter);
    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.engineBus);
    this.noiseSrc.start();

    /* ── body resonance shaping the whole engine bus ── */
    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'peaking';
    this.bodyFilter.frequency.value = 180;
    this.bodyFilter.Q.value = 1.1;
    this.bodyFilter.gain.value = 6;
    this.lowShelf = ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 120;
    this.lowShelf.gain.value = 4;

    /* ── transmission whine ── */
    this.whineOsc = ctx.createOscillator();
    this.whineOsc.type = 'triangle';
    this.whineGain = ctx.createGain();
    this.whineGain.gain.value = 0;
    this.whineOsc.connect(this.whineGain);
    this.whineGain.connect(this.engineBus);
    this.whineOsc.start();

    /* ── wind ── */
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = makeNoiseBuffer(ctx, 3.1);
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 900;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    /* ── tyre scrub ── */
    this.skidSrc = ctx.createBufferSource();
    this.skidSrc.buffer = makeNoiseBuffer(ctx, 1.9);
    this.skidSrc.loop = true;
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = 'bandpass';
    this.skidFilter.frequency.value = 1750;
    this.skidFilter.Q.value = 4.5;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    this.skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(this.master);
    this.skidSrc.start();

    /* ── rumble (kerbs, gravel) ── */
    this.rumbleSrc = ctx.createBufferSource();
    this.rumbleSrc.buffer = makeNoiseBuffer(ctx, 1.3);
    this.rumbleSrc.loop = true;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 260;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSrc.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    this.rumbleSrc.start();

    this.ready = true;
    this.configure(carAudioSpec);
    await this.resume();
  }

  configure(spec) {
    if (!this.ready || !spec) return;
    this.spec = spec;
    this.cylinders = spec.cylinders;
    const h = spec.firingHarmonics;
    // V12s are dominated by even orders; V10s carry a strong half-order wail
    const levels = spec.character === 'v12'
      ? [1.00, 0.62, 0.46, 0.30, 0.22, 0.13, 0.08]
      : spec.character === 'v10-race'
        ? [0.92, 0.70, 0.54, 0.42, 0.30, 0.20, 0.14]
        : [0.95, 0.66, 0.50, 0.34, 0.26, 0.16, 0.10];
    this.partials.forEach((p, i) => {
      p.mult = h[i] ?? (i + 1);
      p.level = levels[i] ?? 0.06;
    });
    this.bodyFilter.frequency.value = spec.character === 'v12' ? 148 : 196;
  }

  async resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* blocked until a gesture */ }
    }
  }

  suspend() { this.ctx?.suspend?.().catch(() => {}); }

  setMuted(m) {
    this._muted = m;
    if (this.master) this.master.gain.value = m ? 0 : settings.get('volumeMaster');
  }

  setVolumes() {
    if (!this.ready) return;
    this.master.gain.value = this._muted ? 0 : settings.get('volumeMaster');
    this.engineBus.gain.value = settings.get('volumeEngine');
  }

  /**
   * @param {object} s  {
   *   rpm, redline, throttle, load, speed, gearShift, skid, surfaceRumble,
   *   limiter, gear
   * }
   */
  update(dt, s) {
    if (!this.ready || !this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const smooth = (param, value, tc = 0.05) => {
      param.setTargetAtTime(value, t, tc);
    };

    this._rpm = damp(this._rpm, s.rpm, 22, dt);
    const rpm = this._rpm;
    const rev = clamp01(rpm / s.redline);

    // firing frequency: one power stroke per two revolutions per cylinder
    const base = (rpm / 60) * (this.cylinders / 2);
    const throttle = clamp01(s.throttle);
    this._load = damp(this._load, throttle, 9, dt);

    for (const p of this.partials) {
      const f = clamp(base * p.mult, 18, 7800);
      smooth(p.osc.frequency, f, 0.028);
      // higher orders only really speak under load and at revs
      const orderBias = p.mult <= 2 ? 1 : lerp(0.35, 1.15, this._load) * lerp(0.5, 1.1, rev);
      const g = p.level * orderBias * lerp(0.34, 1.0, this._load) * 0.11;
      smooth(p.gain.gain, s.muteEngine ? 0 : g, 0.035);
    }

    // intake roar tracks revs; on overrun it becomes exhaust decel rasp
    smooth(this.noiseFilter.frequency, lerp(320, 2600, rev), 0.06);
    smooth(this.noiseGain.gain, s.muteEngine ? 0 : lerp(0.012, 0.085, this._load) * lerp(0.5, 1.25, rev), 0.05);

    // off-throttle crackle
    const lift = this._lastThrottle - throttle;
    if (lift > 0.30 && rev > 0.45) this._crackle = 1;
    this._lastThrottle = throttle;
    if (this._crackle > 0) {
      this._crackle = Math.max(0, this._crackle - dt * 2.4);
      const pop = Math.random() < 0.30 ? this._crackle * 0.22 : 0;
      if (pop > 0) {
        this.noiseGain.gain.cancelScheduledValues(t);
        this.noiseGain.gain.setValueAtTime(pop, t);
        this.noiseGain.gain.setTargetAtTime(0.02, t + 0.008, 0.03);
      }
    }

    // rev limiter chops the whole bus
    smooth(this.engineBus.gain, (s.limiter ? 0.35 : 1) * settings.get('volumeEngine'), 0.012);

    // transmission whine rises with road speed and gear
    const whineF = clamp(60 + s.speed * (s.gear ? 20 - s.gear * 1.6 : 16), 60, 3400);
    smooth(this.whineOsc.frequency, whineF, 0.05);
    smooth(this.whineGain.gain, s.muteEngine ? 0 : clamp01(s.speed / 26) * 0.010, 0.08);

    // wind noise
    smooth(this.windFilter.frequency, clamp(320 + s.speed * 26, 320, 5200), 0.1);
    smooth(this.windGain.gain, clamp01((s.speed - 6) / 70) * 0.085, 0.12);

    // tyre scrub
    const skid = clamp01(s.skid);
    smooth(this.skidFilter.frequency, lerp(1250, 2350, skid), 0.06);
    smooth(this.skidGain.gain, Math.pow(skid, 1.3) * 0.16 * clamp01(s.speed / 8), 0.045);

    // surface rumble
    smooth(this.rumbleFilter.frequency, lerp(120, 420, clamp01(s.speed / 50)), 0.1);
    smooth(this.rumbleGain.gain, clamp01(s.surfaceRumble) * clamp01(s.speed / 12) * 0.13, 0.06);
  }

  /** One-shot transient for gear changes, impacts and the horn. */
  blip(kind, strength = 1) {
    if (!this.ready || this._muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(this.master);

    if (kind === 'shift') {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.06);
      g.gain.setValueAtTime(0.10 * strength, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      o.connect(g); o.start(t); o.stop(t + 0.1);
    } else if (kind === 'impact') {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(ctx, 0.6);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(1800, t);
      f.frequency.exponentialRampToValueAtTime(140, t + 0.28);
      g.gain.setValueAtTime(clamp01(strength) * 0.55, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
      src.connect(f); f.connect(g); src.start(t); src.stop(t + 0.4);
    } else if (kind === 'horn') {
      for (const [f0, lvl] of [[440, 0.09], [554, 0.07], [880, 0.03]]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f0;
        const gg = ctx.createGain();
        gg.gain.setValueAtTime(0, t);
        gg.gain.linearRampToValueAtTime(lvl, t + 0.02);
        gg.gain.setValueAtTime(lvl, t + 0.34);
        gg.gain.exponentialRampToValueAtTime(0.001, t + 0.46);
        o.connect(gg); gg.connect(this.master);
        o.start(t); o.stop(t + 0.5);
      }
      return;
    } else if (kind === 'start') {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(60, t);
      o.frequency.linearRampToValueAtTime(190, t + 0.55);
      g.gain.setValueAtTime(0.10, t);
      g.gain.setValueAtTime(0.14, t + 0.5);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      o.connect(g); o.start(t); o.stop(t + 0.95);
    } else if (kind === 'ui') {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1320, t + 0.05);
      g.gain.setValueAtTime(0.05, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      o.connect(g); o.start(t); o.stop(t + 0.14);
    } else if (kind === 'beep') {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = strength > 1 ? 1046 : 660;
      g.gain.setValueAtTime(0.07, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
      o.connect(g); o.start(t); o.stop(t + 0.26);
    }
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* already closed */ }
    this.ready = false;
  }
}
