/**
 * Vehicle dynamics.
 *
 * A rigid body with four independent suspension struts. Each strut raycasts
 * down onto the world surface, produces a normal load, and that load drives a
 * combined-slip tyre model on the friction circle. Engine torque reaches the
 * wheels through a torque curve, a gearbox and a differential; aero adds drag
 * and downforce. Everything integrates at a fixed 240 Hz so the handling does
 * not change with frame rate.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, sign, smoothstep } from '../core/util.js';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 8;

/* Tyre curve: rises to 1.0 at normalised slip 1, then falls away — the
   falloff is what makes a car breakaway progressively instead of snapping. */
function tyreCurve(s, tailBlend = 0.36) {
  const base = (2 * s) / (1 + s * s);
  if (s <= 1) return base;
  return lerp(base, 1, tailBlend * clamp01((s - 1) / 2));
}

class Wheel {
  constructor(cfg) {
    Object.assign(this, cfg);
    this.compression = 0;
    this.prevCompression = 0;
    this.omega = 0;
    this.load = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.grounded = false;
    this.surface = 'asphalt';
    this.grip = 1;
    this.contact = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.fx = 0; this.fy = 0;
    this.steer = 0;
    this.slipSpeed = 0;
    this.suspLen = this.restLen;
    this.skid = 0;
    this.lockedBrake = 0;
  }
}

export class Vehicle {
  /**
   * @param {object} spec  the `phys` block from a car definition
   * @param {object} dims  { wheelbase, trackFront, trackRear, frontR, rearR }
   * @param {object} world object exposing surfaceAt(x, z) and collide(...)
   */
  constructor(spec, dims, world) {
    this.spec = spec;
    this.dims = dims;
    this.world = world;

    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();

    this.mass = spec.mass;
    const L = dims.wheelbase, W = (dims.trackFront + dims.trackRear) / 2, H = 1.2;
    this.inertia = new THREE.Vector3(
      this.mass * (L * L + H * H) / 12 * 0.85,   // pitch about X
      spec.inertiaYaw || this.mass * (L * L + W * W) / 12 * 0.80,
      this.mass * (W * W + H * H) / 12 * 0.95    // roll about Z
    );
    this.invInertia = new THREE.Vector3(1 / this.inertia.x, 1 / this.inertia.y, 1 / this.inertia.z);

    // Longitudinal CoG placement from the static weight split.
    const rearFraction = 1 - spec.cgBias;
    this.aFront = L * rearFraction;
    this.aRear = L * spec.cgBias;
    this.cgHeight = spec.cgHeight;
    this.cgZ = dims.frontZ - this.aFront;   // CoG in model space

    const restLen = 0.30;
    const staticFront = (this.mass * GRAVITY * spec.cgBias * 0.5) / spec.springFront;
    const staticRear = (this.mass * GRAVITY * rearFraction * 0.5) / spec.springRear;

    this.wheels = [];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? 1 : -1;
      const R = front ? dims.frontR : dims.rearR;
      const stat = front ? staticFront : staticRear;
      this.wheels.push(new Wheel({
        index: i, front, side, radius: R,
        hardpoint: new THREE.Vector3(
          side * (front ? dims.trackFront : dims.trackRear) * 0.5,
          R - this.cgHeight + restLen - stat,
          front ? this.aFront : -this.aRear
        ),
        restLen,
        spring: front ? spec.springFront : spec.springRear,
        damper: front ? spec.damperFront : spec.damperRear,
        travel: spec.travel,
        maxGrip: front ? spec.tyreGripFront : spec.tyreGripRear,
        brakeTorque: front ? spec.brakeTorqueFront : spec.brakeTorqueRear,
        inertiaW: front ? 1.3 : 1.6,
        width: front ? 0.245 : 0.31,
        staticLoad: this.mass * GRAVITY * (front ? spec.cgBias : rearFraction) * 0.5,
      }));
    }

    /* drivetrain */
    this.gear = 1;              // 0 = reverse, 1..n forward, -1 = neutral
    this.gearIndex = 0;         // index into spec.gears
    this.rpm = spec.idleRpm;
    this.engineOmega = (spec.idleRpm * Math.PI) / 30;
    this.shiftTimer = 0;
    this.clutch = 0;
    this.throttleOut = 0;
    this.reverse = false;

    /* assists */
    this.abs = true; this.tc = true; this.esc = false;
    this.absActive = false; this.tcActive = false; this.escActive = false;

    /* derived state for the renderer / HUD */
    this.speed = 0;
    this.speedKmh = 0;
    this.lateralG = 0;
    this.longG = 0;
    this.driftAngle = 0;
    this.airborne = false;
    this.onGroundCount = 0;
    this.wheelSlipAvg = 0;
    this.impact = 0;
    this.odometer = 0;

    /* scratch vectors — kept off the hot path's allocator */
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._force = new THREE.Vector3();
    this._torque = new THREE.Vector3();
    this._prevVel = new THREE.Vector3();
    this._accum = 0;

    this.controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0, shiftUp: false, shiftDown: false, manual: false };
  }

  /* ── setup ───────────────────────────────────────────── */

  reset(x, z, heading = 0, y = null) {
    // Always drop onto the rasterised surface: a banked road sits well below
    // the centreline height a grid slot reports, and spawning even 20 cm high
    // puts every wheel past full droop.
    const surf = this.world.surfaceAt(x, z);
    const groundY = Number.isFinite(y) ? Math.min(y, surf.y) : surf.y;
    this.position.set(x, groundY + this.cgHeight + 0.005, z);
    this.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
    for (const w of this.wheels) {
      w.omega = 0; w.compression = 0; w.prevCompression = 0;
      w.suspLen = w.restLen; w.skid = 0; w.slipRatio = 0; w.slipAngle = 0;
    }
    this.gearIndex = 0;
    this.reverse = false;
    this.engineOmega = (this.spec.idleRpm * Math.PI) / 30;
    this.rpm = this.spec.idleRpm;
    this.speed = 0;
    this.impact = 0;
  }

  /* ── engine ──────────────────────────────────────────── */

  /** Normalised torque shape across the rev range. */
  torqueAt(rpm) {
    const s = this.spec;
    const idle = s.idleRpm;
    if (rpm < idle * 0.4) return 0;
    const powerTorque = (s.peakPowerKw * 1000) / (s.peakPowerRpm * Math.PI / 30);
    const kPower = powerTorque / s.peakTorque;

    let f;
    if (rpm <= s.peakTorqueRpm) {
      const t = clamp01((rpm - idle * 0.5) / (s.peakTorqueRpm - idle * 0.5));
      f = lerp(0.52, 1.0, Math.sin(t * Math.PI * 0.5));
    } else if (rpm <= s.peakPowerRpm) {
      const t = clamp01((rpm - s.peakTorqueRpm) / Math.max(1, s.peakPowerRpm - s.peakTorqueRpm));
      f = lerp(1.0, kPower, smoothstep(0, 1, t));
    } else {
      const t = clamp01((rpm - s.peakPowerRpm) / Math.max(1, s.redline - s.peakPowerRpm));
      f = lerp(kPower, kPower * 0.80, t);
    }
    return s.peakTorque * f;
  }

  get gearRatio() {
    if (this.reverse) return -this.spec.reverse;
    return this.spec.gears[this.gearIndex];
  }

  get totalRatio() { return this.gearRatio * this.spec.finalDrive; }

  autoShift(dt) {
    const s = this.spec;
    const c = this.controls;
    this.shiftTimer -= dt;

    if (c.manual) {
      if (c.shiftUp && this.shiftTimer <= 0) {
        if (this.reverse) { this.reverse = false; this.gearIndex = 0; this.shiftTimer = s.shiftTime; }
        else if (this.gearIndex < s.gears.length - 1) { this.gearIndex++; this.shiftTimer = s.shiftTime; }
      }
      if (c.shiftDown && this.shiftTimer <= 0) {
        if (this.gearIndex > 0) { this.gearIndex--; this.shiftTimer = s.shiftTime; }
        else if (this.speed < 1.5) { this.reverse = true; this.shiftTimer = s.shiftTime; }
      }
      return;
    }

    // automatic: reverse when asked to brake while nearly stopped
    if (this.speed < 0.8 && c.brake > 0.5 && c.throttle < 0.05 && !this.reverse && this.forwardSpeed < 0.4) {
      this.reverse = true; this.gearIndex = 0; this.shiftTimer = 0.25; return;
    }
    if (this.reverse && c.throttle > 0.5 && this.forwardSpeed > -0.4) {
      this.reverse = false; this.gearIndex = 0; this.shiftTimer = 0.25; return;
    }
    if (this.reverse || this.shiftTimer > 0) return;

    const upAt = lerp(s.redline * 0.66, s.redline * 0.955, clamp01(c.throttle * 1.2));
    const downAt = lerp(s.redline * 0.22, s.redline * 0.44, clamp01(c.throttle * 1.4));

    if (this.rpm > upAt && this.gearIndex < s.gears.length - 1) {
      this.gearIndex++;
      this.shiftTimer = s.shiftTime + 0.34;          // lockout stops hunting
    } else if (this.rpm < downAt && this.gearIndex > 0) {
      // Only drop a gear if the lower one would not immediately bounce off the
      // upshift point again — that round trip is what makes a box hunt.
      const nextRpm = this.rpm * (s.gears[this.gearIndex - 1] / s.gears[this.gearIndex]);
      if (nextRpm < upAt * 0.94) {
        this.gearIndex--;
        this.shiftTimer = s.shiftTime + 0.28;
      }
    }
  }

  /* ── main integration ────────────────────────────────── */

  update(dt, controls) {
    Object.assign(this.controls, controls);
    this._accum += Math.min(dt, 0.1);
    let steps = 0;
    while (this._accum >= SUBSTEP && steps < MAX_SUBSTEPS) {
      this.step(SUBSTEP);
      this._accum -= SUBSTEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._accum = 0;
    this.postUpdate(dt);
  }

  step(dt) {
    const s = this.spec;
    const c = this.controls;

    this._force.set(0, -this.mass * GRAVITY, 0);
    this._torque.set(0, 0, 0);

    const rot = this.quaternion;
    const fwd = this._v.set(0, 0, 1).applyQuaternion(rot);
    const up = this._v2.set(0, 1, 0).applyQuaternion(rot);
    this.forwardSpeed = this.velocity.dot(fwd);
    this.speed = this.velocity.length();

    /* ── steering ── */
    const speedFactor = 1 / (1 + Math.max(0, this.speed) * s.steerSpeedFalloff / 26);
    const maxSteer = s.steerMaxDeg * Math.PI / 180;
    this.steerAngle = c.steer * maxSteer * lerp(1, speedFactor, 0.86);
    const rearSteerAngle = -this.steerAngle * s.rearSteer * smoothstep(0, 24, this.speed)
      + this.steerAngle * s.rearSteer * smoothstep(26, 60, this.speed) * 2;

    this.autoShift(dt);

    /* ── suspension + tyres ── */
    let groundedCount = 0;
    let slipSum = 0;
    const compressions = [0, 0, 0, 0];

    for (const w of this.wheels) {
      w.steer = w.front ? this.steerAngle : rearSteerAngle;

      // world hardpoint
      const hp = this._v3.copy(w.hardpoint).applyQuaternion(rot).add(this.position);
      const down = this.tmpDown ||= new THREE.Vector3();
      down.set(0, -1, 0).applyQuaternion(rot);

      const surf = this.world.surfaceAt(hp.x, hp.z);
      const denom = Math.max(0.25, -down.y);
      let len = (hp.y - surf.y - w.radius) / denom;

      w.grounded = len < w.restLen;
      if (w.grounded) {
        len = Math.max(-0.02, len);
        w.compression = clamp(w.restLen - len, 0, w.restLen);
        groundedCount++;
      } else {
        w.compression = 0;
        len = w.restLen;
      }
      w.suspLen = len;
      compressions[w.index] = w.compression;

      const wheelCenter = this.tmpWC ||= new THREE.Vector3();
      wheelCenter.copy(down).multiplyScalar(len).add(hp);
      w.contact.copy(wheelCenter).addScaledVector(surf.normal, -w.radius);
      w.normal.copy(surf.normal);
      w.surface = surf.type;
      w.grip = surf.grip;
      w.roughness = surf.roughness || 0;
    }

    // anti-roll bars couple the two wheels on an axle
    const arbF = (compressions[0] - compressions[1]) * s.arbFront;
    const arbR = (compressions[2] - compressions[3]) * s.arbRear;

    for (const w of this.wheels) {
      if (!w.grounded) {
        w.load = 0;
        w.prevCompression = w.compression;
        // free-spinning wheel slowly decays
        w.omega -= sign(w.omega) * Math.min(Math.abs(w.omega), 2 * dt);
        continue;
      }
      const vel = (w.compression - w.prevCompression) / dt;
      w.prevCompression = w.compression;

      let Fz = w.spring * w.compression + w.damper * vel;
      Fz += w.front ? (w.side > 0 ? -arbF : arbF) : (w.side > 0 ? -arbR : arbR);
      // progressive bump stop
      if (w.compression > w.travel) Fz += (w.compression - w.travel) * w.spring * 9;
      Fz = clamp(Fz, 0, w.staticLoad * 7);
      w.load = Fz;

      const fN = this.tmpN ||= new THREE.Vector3();
      fN.copy(w.normal).multiplyScalar(Fz);
      this._force.add(fN);
      const r = this.tmpR ||= new THREE.Vector3();
      r.copy(w.contact).sub(this.position);
      const tq = this.tmpT ||= new THREE.Vector3();
      this.addTorque(tq.crossVectors(r, fN));
    }

    /* ── aero ── */
    const v2 = this.speed * this.speed;
    if (v2 > 0.01) {
      const q = 0.5 * AIR_DENSITY * s.frontalArea * v2;
      const drag = this.tmpD ||= new THREE.Vector3();
      drag.copy(this.velocity).normalize().multiplyScalar(-q * s.dragCd);
      this._force.add(drag);

      // Downforce is applied at the axle lines, so the resulting pitch
      // couple comes out of the cross product rather than a hand-written term.
      const dfF = -q * s.liftFront;
      const dfR = -q * s.liftRear;
      const dfVec = this.tmpDF ||= new THREE.Vector3();
      const dfPos = this.tmpDP ||= new THREE.Vector3();
      dfVec.set(0, -dfF, 0);
      dfPos.set(0, 0, this.aFront);
      this.addForceAt(dfPos, dfVec);
      dfVec.set(0, -dfR, 0);
      dfPos.set(0, 0, -this.aRear);
      this.addForceAt(dfPos, dfVec);
    }

    /* ── drivetrain ── */
    this.applyDrivetrain(dt);

    /* ── tyre forces ── */
    for (const w of this.wheels) {
      if (!w.grounded || w.load <= 0) { w.fx = 0; w.fy = 0; w.skid = damp(w.skid, 0, 6, dt); continue; }

      const rot2 = this.quaternion;
      const wf = this.tmpWF ||= new THREE.Vector3();
      wf.set(Math.sin(w.steer), 0, Math.cos(w.steer)).applyQuaternion(rot2);
      // project onto the contact plane
      wf.addScaledVector(w.normal, -wf.dot(w.normal)).normalize();
      const wr = this.tmpWR ||= new THREE.Vector3();
      wr.crossVectors(w.normal, wf).normalize().multiplyScalar(-1);
      w.forward.copy(wf); w.right.copy(wr);

      const rc = this.tmpRC ||= new THREE.Vector3();
      rc.copy(w.contact).sub(this.position);
      const vc = this.tmpVC ||= new THREE.Vector3();
      vc.copy(this.angularVelocity).cross(rc).add(this.velocity);

      const vLong = vc.dot(wf);
      const vLat = vc.dot(wr);
      const ref = Math.max(Math.abs(vLong), 2.2);

      const kappa = (w.omega * w.radius - vLong) / ref;
      const alpha = Math.atan2(vLat, ref);
      w.slipRatio = kappa;
      w.slipAngle = alpha;

      const kPeak = 0.135;
      const aPeak = 0.155;
      const sx = kappa / kPeak;
      const sy = Math.tan(alpha) / aPeak;
      const sMag = Math.hypot(sx, sy);

      // load sensitivity: grip per newton falls as the tyre is loaded up
      const loadRatio = w.load / Math.max(1, w.staticLoad);
      const mu = w.maxGrip * w.grip * (1 - 0.14 * (loadRatio - 1));
      const F = mu * w.load * tyreCurve(Math.max(sMag, 1e-5));

      let fx = sMag > 1e-5 ? (F * sx) / sMag : 0;
      let fy = sMag > 1e-5 ? (-F * sy) / sMag : 0;

      w.fx = fx; w.fy = fy;
      w.slipSpeed = Math.hypot(kappa * ref, vLat);
      const skidTarget = clamp01((sMag - 1.05) * 0.9);
      w.skid = damp(w.skid, skidTarget, skidTarget > w.skid ? 14 : 5, dt);
      slipSum += skidTarget;

      const f = this.tmpF ||= new THREE.Vector3();
      f.copy(wf).multiplyScalar(fx).addScaledVector(wr, fy);
      this._force.add(f);
      const tq = this.tmpTT ||= new THREE.Vector3();
      tq.copy(rc).cross(f);
      this.addTorque(tq);

      // reaction on the wheel
      w.omega -= (fx * w.radius / w.inertiaW) * dt;
    }

    this.onGroundCount = groundedCount;
    this.airborne = groundedCount === 0;
    this.wheelSlipAvg = slipSum / 4;

    /* ── rolling resistance + surface drag ── */
    if (groundedCount > 0 && this.speed > 0.05) {
      let rr = 0;
      for (const w of this.wheels) if (w.grounded) rr += w.load * (0.014 + (w.surface === 'grass' ? 0.10 : w.surface === 'sand' ? 0.16 : 0));
      const dragV = this.tmpRR ||= new THREE.Vector3();
      dragV.copy(this.velocity).normalize().multiplyScalar(-rr);
      this._force.add(dragV);
    }

    /* ── integrate ── */
    const invM = 1 / this.mass;
    this.velocity.addScaledVector(this._force, invM * dt);

    // Rotate the torque into body space so the (diagonal) inertia tensor is
    // valid, integrate there, then rotate the result back out.
    const invQ = this._iq ||= new THREE.Quaternion();
    invQ.copy(this.quaternion).invert();
    const bt = this._bt ||= new THREE.Vector3();
    bt.copy(this._torque).applyQuaternion(invQ);
    bt.set(bt.x * this.invInertia.x, bt.y * this.invInertia.y, bt.z * this.invInertia.z);
    bt.applyQuaternion(this.quaternion);
    this.angularVelocity.addScaledVector(bt, dt);

    // light damping stops substep-scale oscillation without numbing the car
    this.angularVelocity.multiplyScalar(1 - 0.42 * dt);

    this.position.addScaledVector(this.velocity, dt);

    const wq = this._q.set(
      this.angularVelocity.x * dt * 0.5,
      this.angularVelocity.y * dt * 0.5,
      this.angularVelocity.z * dt * 0.5,
      0
    );
    wq.multiply(this.quaternion);
    this.quaternion.x += wq.x; this.quaternion.y += wq.y;
    this.quaternion.z += wq.z; this.quaternion.w += wq.w;
    this.quaternion.normalize();

    this.resolveCollisions(dt);
    this.keepAboveGround();
  }

  addTorque(v) { this._torque.add(v); }

  /** Apply a world-space force at a body-local offset from the CoG. */
  addForceAt(localOffset, force) {
    this._force.add(force);
    const r = this._far ||= new THREE.Vector3();
    const t = this._fat ||= new THREE.Vector3();
    r.copy(localOffset).applyQuaternion(this.quaternion);
    this._torque.add(t.crossVectors(r, force));
  }

  applyDrivetrain(dt) {
    const s = this.spec;
    const c = this.controls;

    const driven = s.drivetrain === 'awd'
      ? this.wheels
      : s.drivetrain === 'fwd' ? [this.wheels[0], this.wheels[1]] : [this.wheels[2], this.wheels[3]];

    // driveshaft speed from the driven wheels (open diff with a locking bias)
    let wsum = 0;
    for (const w of driven) wsum += w.omega;
    const wAvg = wsum / driven.length;

    const ratio = this.totalRatio;
    const kinematicOmega = Math.abs(wAvg * ratio);
    const idleOmega = (s.idleRpm * Math.PI) / 30;
    const limiterOmega = (s.limiter * Math.PI) / 30;

    // Clutch. Off the line it slips: the engine flares to a launch speed and
    // still passes most of the torque, otherwise the car could never move —
    // engagement driven purely by road speed deadlocks at a standstill.
    const lockSpeed = 4.0;
    const speedLock = clamp01(Math.abs(this.forwardSpeed) / lockSpeed);
    this.clutch = this.shiftTimer > 0 ? 0.10 : Math.max(speedLock, c.throttle * 0.92);

    const launchRpm = lerp(s.idleRpm, s.peakTorqueRpm * 0.62, clamp01(c.throttle));
    const launchOmega = (launchRpm * Math.PI) / 30;
    this.engineOmega = Math.max(kinematicOmega, lerp(launchOmega, idleOmega, speedLock));
    this.engineOmega = clamp(this.engineOmega, idleOmega * 0.85, limiterOmega);
    this.rpm = (this.engineOmega * 30) / Math.PI;

    // rev limiter cut
    let throttle = c.throttle;
    this.limiterCut = false;
    if (this.rpm > s.redline * 0.995) {
      const over = clamp01((this.rpm - s.redline * 0.995) / Math.max(1, s.limiter - s.redline * 0.995));
      if (Math.sin(performance.now() * 0.09) < over * 2 - 1) { throttle *= 0.06; this.limiterCut = true; }
    }

    let engineTorque = this.torqueAt(this.rpm) * throttle;
    // engine braking on a closed throttle
    engineTorque -= s.engineBrake * (1 - throttle) * clamp01(this.rpm / s.redline);

    // traction control trims torque when the driven wheels light up
    this.tcActive = false;
    if (this.tc && throttle > 0.05) {
      let worst = 0;
      for (const w of driven) worst = Math.max(worst, w.slipRatio);
      // Trim, don't strangle: cutting almost all torque at the first hint of
      // slip makes every launch feel broken rather than controlled.
      if (worst > 0.26) {
        const cut = clamp01((worst - 0.26) / 0.55);
        engineTorque *= 1 - cut * 0.68;
        this.tcActive = cut > 0.15;
      }
    }
    this.throttleOut = throttle;
    this.engineTorque = engineTorque;

    const shaftTorque = engineTorque * ratio * 0.92 * this.clutch;
    // A wheel in the air has nothing to slow it, so cap it just past the speed
    // the current gear could ever produce; otherwise landings explode.
    const omegaCap = Math.abs(limiterOmega / Math.max(0.35, Math.abs(ratio))) + 40;

    // split across axles, then across the wheels with a limited-slip bias
    const rearShare = s.drivetrain === 'awd' ? s.rearBias : (s.drivetrain === 'rwd' ? 1 : 0);
    for (const w of this.wheels) {
      const axleShare = w.front ? (1 - rearShare) : rearShare;
      if (axleShare <= 0) continue;
      const pair = w.front ? [this.wheels[0], this.wheels[1]] : [this.wheels[2], this.wheels[3]];
      const other = pair[0] === w ? pair[1] : pair[0];
      // LSD: send more torque to the slower wheel
      const bias = clamp(0.5 + (Math.abs(other.omega) - Math.abs(w.omega)) * 0.045, 0.18, 0.82);
      const t = shaftTorque * axleShare * bias;
      w.omega += (t / w.inertiaW) * dt;
      w.omega = clamp(w.omega, -omegaCap, omegaCap);
    }

    /* brakes */
    const brakeInput = c.brake;
    this.absActive = false;
    for (const w of this.wheels) {
      let bt = brakeInput * w.brakeTorque;
      if (!w.front) bt += c.handbrake * w.brakeTorque * 2.1;

      if (this.abs && brakeInput > 0.05 && w.grounded && this.speed > 3) {
        if (w.slipRatio < -0.16) {
          const rel = clamp01((-w.slipRatio - 0.16) / 0.25);
          bt *= 1 - rel * 0.88;
          this.absActive = true;
        }
      }
      if (bt > 0) {
        const dw = (bt / w.inertiaW) * dt;
        if (Math.abs(w.omega) <= dw) w.omega = 0;
        else w.omega -= sign(w.omega) * dw;
      }
      w.lockedBrake = bt;
    }

    /* electronic stability: brake the outside wheel to kill oversteer */
    this.escActive = false;
    if (this.esc && this.speed > 6 && this.onGroundCount > 2) {
      const yawRate = this.angularVelocity.y;
      const targetYaw = (this.forwardSpeed / Math.max(2, this.dims.wheelbase)) * Math.tan(this.steerAngle);
      const err = yawRate - targetYaw;
      if (Math.abs(err) > 0.16) {
        const corr = clamp(Math.abs(err) * 0.55, 0, 0.75);
        const w = err > 0 ? this.wheels[1] : this.wheels[0];   // brake the outside front
        const bt = corr * w.brakeTorque;
        const dw = (bt / w.inertiaW) * dt;
        if (Math.abs(w.omega) <= dw) w.omega = 0; else w.omega -= sign(w.omega) * dw;
        this.escActive = true;
      }
    }
  }

  /** Push the body out of static world colliders and kill the inward velocity. */
  resolveCollisions(dt) {
    if (!this.world.collide) return;
    const probes = this.probes ||= [
      new THREE.Vector3(0, 0, this.aFront + 0.55),
      new THREE.Vector3(0, 0, -this.aRear - 0.55),
      new THREE.Vector3(0.86, 0, 0.5),
      new THREE.Vector3(-0.86, 0, 0.5),
      new THREE.Vector3(0.86, 0, -0.7),
      new THREE.Vector3(-0.86, 0, -0.7),
    ];
    const p = this.tmpP ||= new THREE.Vector3();
    for (const local of probes) {
      p.copy(local).applyQuaternion(this.quaternion).add(this.position);
      const hit = this.world.collide(p, 0.36);
      if (!hit) continue;
      this.position.addScaledVector(hit.normal, hit.depth * 0.85);
      const vn = this.velocity.dot(hit.normal);
      if (vn < 0) {
        const impulse = -vn * (1 + 0.18);
        this.velocity.addScaledVector(hit.normal, impulse);
        this.impact = Math.max(this.impact, Math.min(1, -vn / 16));
        // scrubbing along a wall bleeds speed and yaws the car
        const r = this.tmpCR ||= new THREE.Vector3();
        r.copy(p).sub(this.position);
        this.angularVelocity.y += (r.x * hit.normal.z - r.z * hit.normal.x) * impulse * 0.020;
        this.velocity.multiplyScalar(1 - clamp01(-vn / 40) * 0.30);
      }
      void dt;
    }
  }

  /** Never let the chassis sink through the surface, even on a hard landing. */
  keepAboveGround() {
    const surf = this.world.surfaceAt(this.position.x, this.position.z);
    const minY = surf.y + this.cgHeight * 0.42;
    if (this.position.y < minY) {
      this.position.y = minY;
      if (this.velocity.y < 0) this.velocity.y *= -0.15;
    }
    if (this.position.y > surf.y + 60) this.position.y = surf.y + 60;
  }

  postUpdate(dt) {
    this.speed = this.velocity.length();
    this.speedKmh = this.speed * 3.6;

    const fwd = this._v.set(0, 0, 1).applyQuaternion(this.quaternion);
    const right = this._v2.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.forwardSpeed = this.velocity.dot(fwd);

    const acc = this._v3.copy(this.velocity).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    this.longG = acc.dot(fwd) / GRAVITY;
    this.lateralG = acc.dot(right) / GRAVITY;
    this._prevVel.copy(this.velocity);

    const lateral = this.velocity.dot(right);
    this.driftAngle = this.speed > 2.4 ? Math.atan2(lateral, Math.abs(this.forwardSpeed)) : 0;

    this.impact = damp(this.impact, 0, 5, dt);
    this.odometer += this.speed * dt;

    // pitch / roll of the body, for the camera and HUD
    const upv = this._v.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.roll = Math.atan2(upv.x, upv.y);
    this.pitch = Math.asin(clamp(-fwd.y, -1, 1));
  }

  /* ── outputs for the model + audio ── */

  get wheelOmegas() { return this.wheels.map((w) => w.omega); }
  get suspensionOffsets() {
    // Wheel centre height in model space, minus its resting height.
    return this.wheels.map((w) =>
      clamp((w.hardpoint.y + this.cgHeight - w.suspLen) - w.radius, -0.16, 0.16));
  }
  get skidAmounts() { return this.wheels.map((w) => w.skid); }
  get gearLabel() {
    if (this.reverse) return 'R';
    if (this.speed < 0.4 && this.controls.throttle < 0.05) return this.controls.manual ? String(this.gearIndex + 1) : 'N';
    return String(this.gearIndex + 1);
  }
  get rpmNorm() { return clamp01(this.rpm / this.spec.redline); }

  /** Place the visual model: the body origin sits under the CoG. */
  syncModel(group, cgZ = this.cgZ) {
    group.quaternion.copy(this.quaternion);
    const off = this._v.set(0, -this.cgHeight, -cgZ).applyQuaternion(this.quaternion);
    group.position.copy(this.position).add(off);
  }
}
