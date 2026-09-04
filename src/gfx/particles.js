/**
 * GPU-friendly particle pools: tyre smoke, dust, sparks and skid marks.
 * One InstancedMesh per effect, recycled from a free list — no allocation
 * once the pools are warm.
 */
import * as THREE from 'three';
import { clamp01, lerp, makeRng, TAU } from '../core/util.js';
import { smokeSprite, radialSprite } from './textures.js';

class Pool {
  constructor(scene, material, geometry, count) {
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.frustumCulled = false;
    this.mesh.count = count;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.parts = [];
    for (let i = 0; i < count; i++) {
      this.parts.push({
        alive: false, life: 0, maxLife: 1,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        size: 1, growth: 1, spin: 0, rot: 0, opacity: 1,
        color: new THREE.Color(1, 1, 1),
      });
    }
    this.cursor = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    scene.add(this.mesh);
  }

  spawn() {
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[(this.cursor + i) % this.parts.length];
      if (!p.alive) {
        this.cursor = (this.cursor + i + 1) % this.parts.length;
        p.alive = true;
        return p;
      }
    }
    // all busy: steal the oldest
    const p = this.parts[this.cursor];
    this.cursor = (this.cursor + 1) % this.parts.length;
    return p;
  }

  update(dt, camera, drag = 1.6, gravity = 0) {
    const m = this._m;
    const q = this._q;
    const s = this._s;
    const camQ = camera.quaternion;
    let any = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (!p.alive) { this.mesh.setMatrixAt(i, this._hidden); continue; }
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        this.mesh.setMatrixAt(i, this._hidden);
        any = true;
        continue;
      }
      const t = p.life / p.maxLife;
      p.vel.multiplyScalar(1 - Math.min(1, drag * dt));
      p.vel.y += gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.rot += p.spin * dt;

      const size = p.size * lerp(1, p.growth, t);
      q.copy(camQ);
      const spin = this._spinQ ||= new THREE.Quaternion();
      spin.setFromAxisAngle(FORWARD, p.rot);
      q.multiply(spin);
      s.set(size, size, size);
      m.compose(p.pos, q, s);
      this.mesh.setMatrixAt(i, m);
      const fade = Math.sin(Math.PI * clamp01(t)) * p.opacity;
      this.mesh.instanceColor.setXYZ(i, p.color.r * fade, p.color.g * fade, p.color.b * fade);
      any = true;
    }
    if (any) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
  }
}

const FORWARD = new THREE.Vector3(0, 0, 1);

export class Effects {
  constructor(scene, preset) {
    this.scene = scene;
    this.preset = preset;
    this.rng = makeRng(4711);
    const scale = preset.particles;

    const quad = new THREE.PlaneGeometry(1, 1);

    const smokeMat = new THREE.MeshBasicMaterial({
      map: smokeSprite(), transparent: true, depthWrite: false,
      blending: THREE.NormalBlending, opacity: 0.5, toneMapped: false,
      vertexColors: true, side: THREE.DoubleSide,
    });
    this.smoke = new Pool(scene, smokeMat, quad, Math.max(24, Math.round(200 * scale)));

    const dustMat = smokeMat.clone();
    dustMat.opacity = 0.42;
    this.dust = new Pool(scene, dustMat, quad, Math.max(16, Math.round(120 * scale)));

    const sparkMat = new THREE.MeshBasicMaterial({
      map: radialSprite(64), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, vertexColors: true,
    });
    this.sparks = new Pool(scene, sparkMat, quad, Math.max(20, Math.round(140 * scale)));

    /* skid marks: a long ribbon written in place */
    this.markCapacity = Math.max(200, Math.round(900 * scale));
    this.markGeo = new THREE.BufferGeometry();
    this.markPos = new Float32Array(this.markCapacity * 6 * 3);
    this.markAlpha = new Float32Array(this.markCapacity * 6);
    this.markGeo.setAttribute('position', new THREE.BufferAttribute(this.markPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.markGeo.setAttribute('aAlpha', new THREE.BufferAttribute(this.markAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.markGeo.setDrawRange(0, 0);
    this.markMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      uniforms: { uColor: { value: new THREE.Color(0x0a0a0c) } },
      vertexShader: `
        attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vA;
        void main(){ if (vA <= 0.003) discard; gl_FragColor = vec4(uColor, vA * 0.62); }`,
    });
    this.markMesh = new THREE.Mesh(this.markGeo, this.markMat);
    this.markMesh.frustumCulled = false;
    this.markMesh.renderOrder = 1;
    scene.add(this.markMesh);
    this.markHead = 0;
    this.markCount = 0;
    this._lastMark = [null, null, null, null];
  }

  /** Tyre smoke from a spinning or sliding wheel. */
  emitSmoke(pos, vel, amount, surface = 'asphalt') {
    const n = Math.round(amount);
    for (let i = 0; i < n; i++) {
      const p = (surface === 'grass' || surface === 'sand' ? this.dust : this.smoke).spawn();
      p.life = 0;
      p.maxLife = this.rng.range(0.9, 2.0);
      p.pos.copy(pos);
      p.pos.x += this.rng.range(-0.16, 0.16);
      p.pos.z += this.rng.range(-0.16, 0.16);
      p.pos.y += this.rng.range(0.02, 0.16);
      p.vel.copy(vel).multiplyScalar(this.rng.range(0.12, 0.34));
      p.vel.x += this.rng.range(-0.6, 0.6);
      p.vel.z += this.rng.range(-0.6, 0.6);
      p.vel.y += this.rng.range(0.5, 1.7);
      p.size = this.rng.range(0.42, 0.85);
      p.growth = this.rng.range(3.4, 6.0);
      p.spin = this.rng.range(-1.1, 1.1);
      p.rot = this.rng.range(0, TAU);
      p.opacity = surface === 'grass' ? 0.55 : 0.42;
      if (surface === 'grass') p.color.setRGB(0.30, 0.27, 0.16);
      else if (surface === 'sand') p.color.setRGB(0.55, 0.46, 0.30);
      else p.color.setRGB(0.72, 0.73, 0.76);
    }
  }

  /** Sparks when the floor grounds out or the car scrapes a barrier. */
  emitSparks(pos, dir, amount) {
    for (let i = 0; i < amount; i++) {
      const p = this.sparks.spawn();
      p.life = 0;
      p.maxLife = this.rng.range(0.24, 0.62);
      p.pos.copy(pos);
      p.vel.copy(dir).multiplyScalar(this.rng.range(1.5, 7));
      p.vel.x += this.rng.range(-2.4, 2.4);
      p.vel.y += this.rng.range(0.6, 3.4);
      p.vel.z += this.rng.range(-2.4, 2.4);
      p.size = this.rng.range(0.05, 0.16);
      p.growth = 0.35;
      p.spin = 0;
      p.opacity = 1;
      p.color.setRGB(1.0, this.rng.range(0.45, 0.8), this.rng.range(0.05, 0.25));
    }
  }

  /** Append one quad of rubber under a wheel. */
  addSkidMark(wheelIndex, contact, right, width, alpha) {
    const last = this._lastMark[wheelIndex];
    const a1 = contact.clone().addScaledVector(right, width * 0.5);
    const a2 = contact.clone().addScaledVector(right, -width * 0.5);
    a1.y += 0.012; a2.y += 0.012;
    if (last) {
      const i = this.markHead * 18;
      const ai = this.markHead * 6;
      const v = [last.a1, last.a2, a2, last.a1, a2, a1];
      for (let k = 0; k < 6; k++) {
        this.markPos[i + k * 3] = v[k].x;
        this.markPos[i + k * 3 + 1] = v[k].y;
        this.markPos[i + k * 3 + 2] = v[k].z;
      }
      const av = [last.alpha, last.alpha, alpha, last.alpha, alpha, alpha];
      for (let k = 0; k < 6; k++) this.markAlpha[ai + k] = av[k];
      this.markHead = (this.markHead + 1) % this.markCapacity;
      this.markCount = Math.min(this.markCount + 1, this.markCapacity);
      this.markGeo.attributes.position.needsUpdate = true;
      this.markGeo.attributes.aAlpha.needsUpdate = true;
      this.markGeo.setDrawRange(0, this.markCapacity * 6);
    }
    this._lastMark[wheelIndex] = { a1, a2, alpha };
  }

  breakSkid(wheelIndex) { this._lastMark[wheelIndex] = null; }

  update(dt, camera) {
    this.smoke.update(dt, camera, 1.15, 0.55);
    this.dust.update(dt, camera, 1.6, 0.25);
    this.sparks.update(dt, camera, 2.2, -9.0);
  }

  clearMarks() {
    this.markAlpha.fill(0);
    this.markGeo.attributes.aAlpha.needsUpdate = true;
    this.markHead = 0;
    this.markCount = 0;
    this._lastMark = [null, null, null, null];
  }
}
