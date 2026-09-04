/**
 * Driving HUD: rev arc, speed, gear, shift lights, lap timing, drift scoring,
 * assist flags and the minimap. All DOM/SVG so it stays razor sharp on a
 * high-DPI phone without costing fill rate.
 */
import { $, clamp, clamp01, lerp, formatTime, formatDelta, vibrate } from '../core/util.js';
import { settings } from '../core/settings.js';
import { CAMERA_LABELS } from '../gfx/camera.js';

const ARC_LEN = 490;          // matches the dasharray in the stylesheet
const ARC_SWEEP = 0.75;       // fraction of the circle the gauge covers

export class HUD {
  constructor() {
    this.revArc = $('#rev-arc');
    this.speedVal = $('#speed-val');
    this.gearVal = $('#gear-val');
    this.shiftLights = $('#shift-lights');
    this.lapNum = $('#lap-num');
    this.lapTime = $('#lap-time');
    this.lapBest = $('#lap-best');
    this.lapDelta = $('#lap-delta');
    this.driftBox = $('#drift-box');
    this.driftScore = $('#drift-score');
    this.driftMult = $('#drift-mult');
    this.driftFill = $('#drift-fill');
    this.toast = $('#toast');
    this.flags = {
      abs: $('#flag-abs'), tc: $('#flag-tc'), esc: $('#flag-esc'), hb: $('#flag-hb'),
    };
    this.minimap = $('#minimap');
    this.mmCtx = this.minimap?.getContext('2d');

    this._shiftEls = [];
    if (this.shiftLights) {
      for (let i = 0; i < 7; i++) {
        const i2 = document.createElement('i');
        this.shiftLights.appendChild(i2);
        this._shiftEls.push(i2);
      }
    }
    this.buildTicks();

    this._displaySpeed = 0;
    this._displayRev = 0;
    this._toastTimer = 0;
    this._mmPath = null;
    this._lastGear = '';
  }

  buildTicks() {
    const g = $('#tickmarks');
    if (!g) return;
    const cx = 130, cy = 130, r0 = 96, r1 = 112;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const a = t * ARC_SWEEP * Math.PI * 2;
      const major = i % 5 === 0;
      const rr0 = major ? r0 - 4 : r0;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx + Math.cos(a) * rr0);
      line.setAttribute('y1', cy + Math.sin(a) * rr0);
      line.setAttribute('x2', cx + Math.cos(a) * r1);
      line.setAttribute('y2', cy + Math.sin(a) * r1);
      line.setAttribute('class', `${major ? 'major' : ''} ${t > 0.86 ? 'red' : ''}`.trim());
      g.appendChild(line);
    }
  }

  /** Draw the circuit outline once; the car dot moves every frame. */
  prepareMinimap(world) {
    if (!this.mmCtx || !world) return;
    const pts = world.samples.map((s) => s.pos);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const pad = 12;
    const W = this.minimap.width, H = this.minimap.height;
    const sx = (W - pad * 2) / (maxX - minX);
    const sz = (H - pad * 2) / (maxZ - minZ);
    const s = Math.min(sx, sz);
    this._mm = {
      s, minX, minZ,
      ox: pad + ((W - pad * 2) - (maxX - minX) * s) / 2,
      oz: pad + ((H - pad * 2) - (maxZ - minZ) * s) / 2,
      pts,
    };
    this._mmPath = new Path2D();
    pts.forEach((p, i) => {
      const x = this._mm.ox + (p.x - minX) * s;
      const y = this._mm.oz + (p.z - minZ) * s;
      if (i === 0) this._mmPath.moveTo(x, y); else this._mmPath.lineTo(x, y);
    });
    this._mmPath.closePath();
  }

  drawMinimap(carPos, heading) {
    const c = this.mmCtx;
    if (!c || !this._mm) return;
    const { minX, minZ, s, ox, oz } = this._mm;
    c.clearRect(0, 0, this.minimap.width, this.minimap.height);
    c.lineJoin = 'round';
    c.strokeStyle = 'rgba(255,255,255,0.16)';
    c.lineWidth = 9;
    c.stroke(this._mmPath);
    c.strokeStyle = 'rgba(120,200,255,0.55)';
    c.lineWidth = 2.2;
    c.stroke(this._mmPath);

    const x = ox + (carPos.x - minX) * s;
    const y = oz + (carPos.z - minZ) * s;
    c.save();
    c.translate(x, y);
    c.rotate(-heading + Math.PI);
    c.beginPath();
    c.moveTo(0, -7); c.lineTo(5, 6); c.lineTo(0, 3); c.lineTo(-5, 6);
    c.closePath();
    const g = c.createLinearGradient(0, -7, 0, 6);
    g.addColorStop(0, '#ffd166');
    g.addColorStop(1, '#ff2d55');
    c.fillStyle = g;
    c.fill();
    c.restore();
  }

  showToast(text, big = false, hold = 1.6) {
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.classList.toggle('big', big);
    this.toast.classList.add('show');
    this._toastTimer = hold;
  }

  update(dt, s) {
    /* speed + revs */
    this._displaySpeed = lerp(this._displaySpeed, s.speedKmh, 1 - Math.exp(-16 * dt));
    this._displayRev = lerp(this._displayRev, s.rpmNorm, 1 - Math.exp(-24 * dt));

    if (this.speedVal) this.speedVal.textContent = Math.round(Math.max(0, this._displaySpeed));
    if (this.revArc) {
      const frac = clamp01(this._displayRev) * ARC_SWEEP;
      this.revArc.style.strokeDashoffset = String(ARC_LEN * (1 - frac));
    }
    if (this.gearVal && s.gear !== this._lastGear) {
      this.gearVal.textContent = s.gear;
      this._lastGear = s.gear;
    }
    if (this.gearVal) this.gearVal.classList.toggle('red', this._displayRev > 0.92);

    /* shift lights */
    const lit = clamp01((this._displayRev - 0.60) / 0.38);
    for (let i = 0; i < this._shiftEls.length; i++) {
      const on = lit * this._shiftEls.length > i + 0.001;
      const el = this._shiftEls[i];
      el.className = '';
      if (!on) continue;
      el.classList.add(i < 3 ? 'on1' : i < 5 ? 'on2' : 'on3');
    }
    if (this._displayRev > 0.965 && this.shiftLights) {
      const blink = Math.floor(performance.now() / 70) % 2 === 0;
      for (const el of this._shiftEls) el.className = blink ? 'on3' : '';
    }

    /* assists */
    this.flags.abs?.classList.toggle('on', s.abs);
    this.flags.abs?.classList.toggle('act', s.absActive);
    this.flags.tc?.classList.toggle('on', s.tc);
    this.flags.tc?.classList.toggle('act', s.tcActive);
    this.flags.esc?.classList.toggle('on', s.esc);
    this.flags.esc?.classList.toggle('act', s.escActive);
    this.flags.hb?.classList.toggle('act', s.handbrake > 0.1);

    /* lap timing */
    if (this.lapTime) this.lapTime.textContent = formatTime(s.lapTime);
    if (this.lapNum) this.lapNum.textContent = String(s.lap);
    if (this.lapBest) this.lapBest.textContent = `BEST ${formatTime(s.bestLap)}`;
    if (this.lapDelta) {
      if (s.delta === null || s.delta === undefined) {
        this.lapDelta.textContent = '';
      } else {
        this.lapDelta.textContent = formatDelta(s.delta);
        this.lapDelta.classList.toggle('pos', s.delta > 0);
        this.lapDelta.classList.toggle('neg', s.delta <= 0);
      }
    }

    /* drift scoring */
    if (this.driftBox) {
      this.driftBox.classList.toggle('on', s.driftActive || s.driftBanked > 0);
      if (this.driftScore) this.driftScore.textContent = Math.round(s.driftScore).toLocaleString('de-DE');
      if (this.driftMult) this.driftMult.textContent = `x${s.driftMult.toFixed(1)}`;
      if (this.driftFill) this.driftFill.style.width = `${clamp01(s.driftHold) * 100}%`;
    }

    /* minimap */
    if (s.carPos) this.drawMinimap(s.carPos, s.heading);

    /* toast */
    if (this._toastTimer > 0) {
      this._toastTimer -= dt;
      if (this._toastTimer <= 0) this.toast?.classList.remove('show');
    }
  }

  cameraToast(mode) {
    this.showToast(CAMERA_LABELS[mode] || mode, false, 1.1);
  }
}

/* ── lap timing + drift scoring ────────────────────────── */

export class RaceState {
  constructor(world, carId) {
    this.world = world;
    this.carId = carId;
    this.lap = 1;
    this.lapTime = 0;
    this.bestLap = settings.bestLapFor(carId);
    this.lastLap = Infinity;
    this.delta = null;
    this.sectorTimes = [];
    this._prevT = 0;
    this._armed = false;
    this._splits = new Array(20).fill(null);
    this._bestSplits = null;

    this.driftScore = 0;
    this.driftBanked = 0;
    this.driftMult = 1;
    this.driftHold = 0;
    this.driftActive = false;
    this._driftTimer = 0;
    this._driftCool = 0;
    this.totalDrift = 0;
    this.topSpeed = 0;
  }

  reset() {
    this.lap = 1; this.lapTime = 0; this.delta = null;
    this._armed = false; this._splits.fill(null);
    this.driftScore = 0; this.driftBanked = 0; this.driftMult = 1; this.driftHold = 0;
  }

  update(dt, v) {
    this.lapTime += dt;
    this.topSpeed = Math.max(this.topSpeed, v.speedKmh);

    const prog = this.world.trackProgress(v.position.x, v.position.z);
    const t = prog.t;

    // arm the line once the car is past the first third of the lap
    if (t > 0.35 && t < 0.75) this._armed = true;
    if (this._armed && this._prevT > 0.9 && t < 0.12 && prog.distance < 40) {
      this.completeLap();
    }

    // live delta against the best lap's splits
    const seg = Math.min(19, Math.floor(t * 20));
    if (this._splits[seg] === null) this._splits[seg] = this.lapTime;
    if (this._bestSplits && this._bestSplits[seg] !== null && this._bestSplits[seg] !== undefined) {
      this.delta = this.lapTime - this._bestSplits[seg];
    }
    this._prevT = t;

    this.updateDrift(dt, v);
  }

  completeLap() {
    const time = this.lapTime;
    this.lastLap = time;
    if (time < this.bestLap) {
      this.bestLap = time;
      settings.setBestLap(this.carId, time);
      this._bestSplits = this._splits.slice();
      this.newBest = true;
    } else {
      this.newBest = false;
    }
    this.lap++;
    this.lapTime = 0;
    this._splits.fill(null);
    this._armed = false;
    this.onLap?.(time, this.newBest);
  }

  updateDrift(dt, v) {
    const angle = Math.abs(v.driftAngle);
    const speedOk = v.speed > 9;
    const sliding = angle > 0.18 && speedOk && v.onGroundCount >= 3;

    if (sliding) {
      this._driftTimer += dt;
      this._driftCool = 1.1;
      this.driftActive = true;
      const quality = clamp01((angle - 0.16) / 0.62) * clamp01(v.speed / 26);
      this.driftScore += quality * v.speed * dt * 9;
      this.driftMult = clamp(1 + this._driftTimer * 0.36, 1, 6);
      this.driftHold = clamp01(this._driftTimer / 4.5);
    } else if (this._driftCool > 0) {
      this._driftCool -= dt;
      if (this._driftCool <= 0) {
        this.driftBanked += Math.round(this.driftScore * this.driftMult);
        this.totalDrift += Math.round(this.driftScore * this.driftMult);
        this.onDriftBank?.(Math.round(this.driftScore * this.driftMult), this.driftMult);
        this.driftScore = 0;
        this.driftMult = 1;
        this._driftTimer = 0;
        this.driftHold = 0;
        this.driftActive = false;
      }
    } else {
      this.driftActive = false;
    }
  }

  get displayScore() { return this.driftBanked + this.driftScore * this.driftMult; }
}

export { vibrate };
