/**
 * Camera rig.
 *
 * The chase camera is a spring-damper that trails the car and leans into the
 * direction the car is actually travelling, not just where it points — which
 * is what makes a slide read as a slide from behind the wheel.
 */
import * as THREE from 'three';
import { clamp, clamp01, lerp, damp, smoothstep } from '../core/util.js';

export const CAMERA_MODES = ['chase', 'chase-far', 'hood', 'cockpit', 'orbit', 'cinematic'];
export const CAMERA_LABELS = {
  chase: 'VERFOLGER', 'chase-far': 'WEIT', hood: 'HAUBE',
  cockpit: 'COCKPIT', orbit: 'ORBIT', cinematic: 'KINO',
};

export class CameraRig {
  constructor(camera, opts = {}) {
    this.camera = camera;
    this.mode = opts.mode || 'chase';
    this.baseFov = opts.fov ?? 68;

    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);

    this._desired = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._shake = 0;
    this._shakeSeed = Math.random() * 1000;
    this._orbitAngle = 0;
    this._cineTimer = 0;
    this._cineIndex = 0;
    this._roll = 0;
    this._fov = this.baseFov;
    this._initialised = false;
  }

  setMode(m) {
    this.mode = m;
    this._initialised = false;
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
    return this.mode;
  }

  addShake(amount) { this._shake = Math.min(1.4, this._shake + amount); }

  /**
   * @param {number} dt
   * @param {object} v   the Vehicle
   * @param {object} car car model definition (for dimensions)
   * @param {object} world surface provider, used to keep the camera above ground
   */
  update(dt, v, car, world) {
    const speedT = clamp01(v.speed / 78);
    const q = v.quaternion;

    const fwd = this._tmp.set(0, 0, 1).applyQuaternion(q);
    const right = this._tmp2.set(1, 0, 0).applyQuaternion(q);
    const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(q);

    // blend the car's nose direction with its actual travel direction
    const travel = v.speed > 3 ? v.velocity.clone().setY(0).normalize() : fwd.clone().setY(0).normalize();
    const blend = smoothstep(2, 16, v.speed) * 0.55;
    const aim = fwd.clone().setY(0).normalize().lerp(travel, blend).normalize();

    switch (this.mode) {
      case 'chase':
      case 'chase-far': {
        const far = this.mode === 'chase-far';
        const dist = (far ? 9.4 : 6.6) + speedT * (far ? 3.0 : 2.2);
        const height = (far ? 3.5 : 2.35) + speedT * 0.55;
        this._desired.copy(v.position)
          .addScaledVector(aim, -dist)
          .addScaledVector(this.up, height);
        this._desiredLook.copy(v.position)
          .addScaledVector(aim, 5.4 + speedT * 5.0)
          .addScaledVector(this.up, 0.55);
        // camera trails harder at speed so it feels planted
        this.follow(dt, lerp(6.5, 3.4, speedT), lerp(9, 6.2, speedT));
        this._roll = damp(this._roll, -v.driftAngle * 0.16 - v.roll * 0.30, 5, dt);
        this._fov = damp(this._fov, this.baseFov + speedT * 20 + clamp01(v.longG) * 3, 3.6, dt);
        break;
      }

      case 'hood': {
        const p = this._tmp.set(0, 0.98, 0.55).applyQuaternion(q).add(v.position);
        this._desired.copy(p);
        this._desiredLook.copy(v.position)
          .addScaledVector(fwd, 22).addScaledVector(this.up, 0.9);
        this.follow(dt, 26, 22);
        this._roll = damp(this._roll, -v.roll * 0.85, 9, dt);
        this._fov = damp(this._fov, this.baseFov - 4 + speedT * 22, 4, dt);
        break;
      }

      case 'cockpit': {
        const seat = this._tmp.set(0.34, 0.92, -0.05).applyQuaternion(q).add(v.position);
        this._desired.copy(seat);
        // the driver's head leans with lateral load
        const lean = clamp(-v.lateralG * 0.11, -0.16, 0.16);
        this._desiredLook.copy(v.position)
          .addScaledVector(fwd, 16)
          .addScaledVector(right, lean * 22)
          .addScaledVector(this.up, 0.86);
        this.follow(dt, 34, 20);
        this._roll = damp(this._roll, -v.roll * 1.0 + lean * 0.5, 10, dt);
        this._fov = damp(this._fov, this.baseFov - 6 + speedT * 18, 4, dt);
        break;
      }

      case 'orbit': {
        this._orbitAngle += dt * 0.24;
        const r = 9.5;
        this._desired.set(
          v.position.x + Math.cos(this._orbitAngle) * r,
          v.position.y + 3.1,
          v.position.z + Math.sin(this._orbitAngle) * r
        );
        this._desiredLook.copy(v.position).addScaledVector(this.up, 0.35);
        this.follow(dt, 7, 9);
        this._roll = damp(this._roll, 0, 4, dt);
        this._fov = damp(this._fov, this.baseFov - 12, 3, dt);
        break;
      }

      case 'cinematic': {
        this._cineTimer -= dt;
        if (this._cineTimer <= 0 || !this._initialised) {
          this._cineTimer = 4.4;
          this._cineIndex = (this._cineIndex + 1) % 4;
          const angles = [2.2, -1.4, 0.6, -2.6];
          const dists = [14, 9, 18, 11];
          const heights = [1.2, 4.2, 0.7, 2.6];
          const a = angles[this._cineIndex];
          this._anchor = new THREE.Vector3(
            v.position.x + Math.cos(a) * dists[this._cineIndex],
            v.position.y + heights[this._cineIndex],
            v.position.z + Math.sin(a) * dists[this._cineIndex]
          );
          if (world) {
            const surf = world.surfaceAt(this._anchor.x, this._anchor.z);
            this._anchor.y = Math.max(this._anchor.y, surf.y + 0.8);
          }
          this.pos.copy(this._anchor);
        }
        // a slow dolly makes the fixed cameras feel hand-held rather than static
        this._anchor.addScaledVector(aim, dt * v.speed * 0.06);
        this._desired.copy(this._anchor);
        this._desiredLook.copy(v.position);
        this.follow(dt, 2.4, 7);
        this._roll = damp(this._roll, 0, 3, dt);
        this._fov = damp(this._fov, 34 + speedT * 12, 2.5, dt);
        break;
      }
      default: break;
    }

    /* keep the camera out of the scenery */
    if (world && this.mode !== 'cockpit' && this.mode !== 'hood') {
      const surf = world.surfaceAt(this.pos.x, this.pos.z);
      const minY = surf.y + 0.85;
      if (this.pos.y < minY) this.pos.y = damp(this.pos.y, minY, 22, dt);
    }

    /* impact and kerb shake */
    this._shake = damp(this._shake, 0, 5.5, dt);
    const bump = v.airborne ? 0 : clamp01(v.wheelSlipAvg * 0.5) * 0.10;
    const amp = (this._shake * 0.34 + bump) * (this.mode === 'cockpit' ? 1.4 : 1);
    if (amp > 0.0005) {
      const t = performance.now() * 0.001 + this._shakeSeed;
      this.pos.x += Math.sin(t * 47.3) * amp * 0.30;
      this.pos.y += Math.sin(t * 39.1 + 1.7) * amp * 0.24;
      this.pos.z += Math.cos(t * 43.7 + 0.6) * amp * 0.30;
    }

    this.camera.position.copy(this.pos);
    this.camera.up.set(Math.sin(this._roll), Math.cos(this._roll), 0)
      .applyQuaternion(this._q.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        this._tmp.copy(this.look).sub(this.pos).normalize()
      ));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);
    if (Math.abs(this._roll) > 0.0005) this.camera.rotateZ(this._roll);

    if (Math.abs(this.camera.fov - this._fov) > 0.02) {
      this.camera.fov = this._fov;
      this.camera.updateProjectionMatrix();
    }
    void car; void upv;
    this._initialised = true;
  }

  follow(dt, posRate, lookRate) {
    if (!this._initialised) {
      this.pos.copy(this._desired);
      this.look.copy(this._desiredLook);
      return;
    }
    this.pos.x = damp(this.pos.x, this._desired.x, posRate, dt);
    this.pos.y = damp(this.pos.y, this._desired.y, posRate * 1.25, dt);
    this.pos.z = damp(this.pos.z, this._desired.z, posRate, dt);
    this.look.x = damp(this.look.x, this._desiredLook.x, lookRate, dt);
    this.look.y = damp(this.look.y, this._desiredLook.y, lookRate, dt);
    this.look.z = damp(this.look.z, this._desiredLook.z, lookRate, dt);
  }

  snapTo(v) {
    this._initialised = false;
    this.pos.copy(v.position).add(new THREE.Vector3(0, 3, -8));
    this.look.copy(v.position);
  }
}
