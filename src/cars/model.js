/**
 * Turns a declarative car definition into a renderable model: lofted body
 * with material groups, wheels, lamps, aero and interior, plus the runtime
 * hooks the simulation needs (wheel spin, steering, light states, paint).
 */
import * as THREE from 'three';
import { buildLoft, mergeGeometries, sweepProfile, circleProfile, surfacePoint } from './loft.js';
import { buildWheel, buildInterior } from './parts.js';
import * as M from '../gfx/materials.js';
import { blobShadow } from '../gfx/textures.js';
import { clamp01, lerp, damp, TAU } from '../core/util.js';

/** Material slot order used by every body loft. */
export const SLOT = { PAINT: 0, GLASS: 1, TRIM: 2, CARBON: 3 };

/** Wheel-well shell so you cannot see through the arch openings. */
function archLiner(arch, wheelX, wheelWidth, sideSign, bodyHalfWidth) {
  const seg = 18;
  const pos = [];
  const idx = [];
  const inner = sideSign * (arch.innerX - 0.03);
  // never poke out past the fender: the liner is a well, not a flare
  const outer = sideSign * Math.min(wheelX + wheelWidth * 0.55, bodyHalfWidth - 0.006);
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI * (i / seg);
    const y = arch.y + Math.sin(a) * arch.r * 0.985;
    const z = arch.z - Math.cos(a) * arch.r * 0.985;
    pos.push(inner, y, z, outer, y, z);
  }
  for (let i = 0; i < seg; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    if (sideSign > 0) idx.push(a, c, b, b, c, d);
    else idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class CarModel {
  constructor(def, opts = {}) {
    this.def = def;
    this.group = new THREE.Group();
    this.group.name = def.id;

    const paintIdx = opts.paint ?? 0;
    const rimIdx = opts.rim ?? def.defaultRim ?? 0;
    const quality = opts.quality ?? 1;

    /* ── body ─────────────────────────────────────────────── */
    const paint = def.paints[paintIdx % def.paints.length];
    this.paintMaterial = paint.satin
      ? M.satinPaint(paint.color, paint.roughness ?? 0.42)
      : M.carPaint({
          color: paint.color,
          metalness: paint.metalness ?? 0.48,
          roughness: paint.roughness ?? 0.26,
          pearl: paint.pearl ?? 0,
          flake: paint.flake ?? 0.6,
          clearcoat: paint.clearcoat ?? 1.0,
        });

    this.glassMaterial = M.glass({ tint: def.glassTint ?? 0x0b1119, opacity: def.glassOpacity ?? 0.55 });
    this.trimMaterial = M.matteBlack(0.68, 0x0b0d11);
    this.carbonMaterial = M.carbonFibre({ scale: 2.0 });

    const bodyGeo = buildLoft({
      stations: def.stations,
      ringSegments: quality > 0.7 ? 36 : 24,
      zSegments: quality > 0.7 ? 118 : 70,
      arches: def.arches,
      patches: def.patches,
      materials: 4,
    });

    this.body = new THREE.Mesh(bodyGeo, [
      this.paintMaterial, this.glassMaterial, this.trimMaterial, this.carbonMaterial,
    ]);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.body.name = 'body';
    this.group.add(this.body);

    /* ── wheel wells ──────────────────────────────────────── */
    const linerGeos = [];
    for (const a of def.arches) {
      const front = a.z > 0;
      const wx = front ? def.wheels.frontX : def.wheels.rearX;
      const ww = front ? def.wheels.frontW : def.wheels.rearW;
      const bw = surfacePoint(def.stations, a.z, 0.34).x;
      for (const s of [1, -1]) linerGeos.push(archLiner(a, wx, ww, s, bw));
    }
    if (linerGeos.length) {
      const liner = new THREE.Mesh(
        mergeGeometries(linerGeos),
        M.matteBlack(0.96, 0x05060a)
      );
      liner.material.side = THREE.DoubleSide;
      liner.name = 'archLiners';
      this.group.add(liner);
      for (const gg of linerGeos) gg.dispose();
    }

    /* ── wheels ───────────────────────────────────────────── */
    const W = def.wheels;
    this.wheels = [];
    const rimSpec = def.rims?.[rimIdx % (def.rims?.length || 1)] ?? {};
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const side = i % 2 === 0 ? 1 : -1;     // 0/2 = right(+x), 1/3 = left
      const w = buildWheel({
        rimR: front ? W.frontRimR : W.rearRimR,
        tyreR: front ? W.frontR : W.rearR,
        width: front ? W.frontW : W.rearW,
        style: rimSpec.style ?? rimIdx,
        rimColor: rimSpec.color ?? 0x191b1f,
        rimMetal: rimSpec.metalness ?? 1.0,
        rimRough: rimSpec.roughness ?? 0.24,
        caliperColor: def.caliperColor ?? 0xd8341f,
        lod: quality,
      });
      const holder = new THREE.Group();     // steering pivot
      holder.add(w);
      if (side < 0) w.scale.x = -1;
      holder.position.set(
        side * (front ? W.frontX : W.rearX),
        front ? W.frontR : W.rearR,
        front ? W.frontZ : W.rearZ
      );
      holder.userData = { front, side, wheel: w, spin: w.userData.spin, brake: w.userData.brake };
      this.group.add(holder);
      this.wheels.push(holder);
    }

    /* ── extra parts ──────────────────────────────────────── */
    this.lamps = { head: [], tail: [], brake: [], reverse: [], indicator: [] };
    this.headSpots = [];

    if (def.interior !== false) {
      this.interior = buildInterior(def.interiorOpts ?? {});
      this.group.add(this.interior);
    }

    if (def.parts) def.parts(this, THREE);

    /* ── cheap contact shadow (always on, even when shadows are off) ── */
    const blob = new THREE.Mesh(
      new THREE.PlaneGeometry(def.length * 0.96, def.width * 1.5),
      new THREE.MeshBasicMaterial({
        alphaMap: blobShadow(), transparent: true, opacity: 0.55,
        depthWrite: false, color: 0x000000, toneMapped: false,
        blending: THREE.NormalBlending,
      })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.015;
    blob.renderOrder = -5;
    this.contactShadow = blob;
    this.group.add(blob);

    /* ── headlight spot lights (night driving) ── */
    if (def.headlightSpots !== false) {
      for (const s of [-1, 1]) {
        const spot = new THREE.SpotLight(0xf2f7ff, 0, 92, 0.44, 0.42, 1.35);
        spot.position.set(s * (def.width * 0.32), 0.66, def.length * 0.44);
        spot.target.position.set(s * (def.width * 0.30), -0.20, def.length * 0.44 + 26);
        spot.castShadow = false;
        this.group.add(spot);
        this.group.add(spot.target);
        this.headSpots.push(spot);
      }
    }

    /* ── state ── */
    this.state = {
      steer: 0, wheelSpin: [0, 0, 0, 0], suspension: [0, 0, 0, 0],
      brake: 0, reverse: false, headlights: false, indicator: 0, hazard: false,
      discHeat: [0, 0, 0, 0],
    };
    this._blink = 0;
    this._discMats = this.wheels.map((h) => h.userData.wheel.userData.disc.material);
  }

  /* ── appearance ── */

  setPaint(index) {
    const p = this.def.paints[index % this.def.paints.length];
    this.paintMaterial.color.set(p.color);
    this.paintMaterial.metalness = p.metalness ?? 0.48;
    this.paintMaterial.roughness = p.roughness ?? 0.26;
    if ('iridescence' in this.paintMaterial) this.paintMaterial.iridescence = p.pearl ?? 0;
    this.paintMaterial.needsUpdate = true;
    this.paintIndex = index;
  }

  /* ── per-frame ── */

  /**
   * @param {number} dt
   * @param {object} s  { steer, wheelOmega[4], suspension[4], brake, reverse,
   *                      headlights, indicator, speed }
   */
  update(dt, s) {
    const st = this.state;

    // steering knuckles
    st.steer = damp(st.steer, s.steer ?? 0, 18, dt);
    const maxSteer = this.def.maxSteerVisual ?? 0.55;
    this.wheels[0].rotation.y = st.steer * maxSteer;
    this.wheels[1].rotation.y = st.steer * maxSteer;

    // wheel rotation + suspension travel
    for (let i = 0; i < 4; i++) {
      const omega = s.wheelOmega?.[i] ?? 0;
      st.wheelSpin[i] += omega * dt;
      const holder = this.wheels[i];
      holder.userData.spin.rotation.x = st.wheelSpin[i];
      const susp = s.suspension?.[i] ?? 0;
      const front = i < 2;
      holder.position.y = (front ? this.def.wheels.frontR : this.def.wheels.rearR) + susp;

      // glowing discs under heavy braking
      const heat = st.discHeat[i];
      const target = clamp01((s.brake ?? 0) * clamp01((s.speed ?? 0) / 34) * 1.25);
      st.discHeat[i] = damp(heat, target, target > heat ? 0.8 : 0.25, dt);
      const m = this._discMats[i];
      if (m) {
        if (!m.emissive) m.emissive = new THREE.Color();
        m.emissive.setRGB(st.discHeat[i] * 1.6, st.discHeat[i] * 0.28, st.discHeat[i] * 0.05);
        m.emissiveIntensity = st.discHeat[i] * 1.4;
      }
    }

    // steering wheel in the cabin
    if (this.interior?.userData.steeringWheel) {
      this.interior.userData.steeringWheel.rotation.z = -st.steer * 2.6;
    }

    // lamp states
    const head = s.headlights ?? false;
    if (head !== st.headlights) {
      st.headlights = head;
      for (const l of this.lamps.head) l.material.emissiveIntensity = head ? (l.userData.power ?? 3.4) : 0.06;
      for (const spot of this.headSpots) spot.intensity = head ? 34 : 0;
    }
    const brakeOn = (s.brake ?? 0) > 0.06;
    for (const l of this.lamps.tail) {
      l.material.emissiveIntensity = head ? 1.5 : 0.35;
    }
    for (const l of this.lamps.brake) {
      l.material.emissiveIntensity = brakeOn ? 5.2 : (head ? 1.4 : 0.22);
    }
    for (const l of this.lamps.reverse) {
      l.material.emissiveIntensity = s.reverse ? 3.6 : 0.05;
    }

    // indicators / hazards
    const ind = s.indicator ?? 0;
    this._blink += dt;
    const on = (this._blink % 0.86) < 0.44;
    for (const l of this.lamps.indicator) {
      const match = ind === 0 ? false : (ind < 0 ? l.userData.side < 0 : l.userData.side > 0);
      l.material.emissiveIntensity = (match && on) ? 5.0 : 0.04;
    }

    // contact shadow fades as the car leaves the ground
    const lift = Math.min(...(s.suspension ?? [0, 0, 0, 0]));
    this.contactShadow.material.opacity = 0.62 * clamp01(1 - lift * 3.2);
  }

  /** Fold the model into a compact bounding description for the physics. */
  get dimensions() {
    return {
      length: this.def.length, width: this.def.width, height: this.def.height,
      wheelbase: this.def.wheels.frontZ - this.def.wheels.rearZ,
      trackFront: this.def.wheels.frontX * 2,
      trackRear: this.def.wheels.rearX * 2,
    };
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
      }
    });
  }
}

/* ── helpers shared by the car definitions ── */

/** Emissive lamp registered with the model so it responds to light state. */
export function registerLamp(model, mesh, kind, side = 0, power = 3.4) {
  mesh.userData.side = side;
  mesh.userData.power = power;
  model.lamps[kind].push(mesh);
  return mesh;
}

/** Tube swept along a polyline — roll hoops, fins, snorkels. */
export function tube(points, radius, mat, seg = 10) {
  const path = points.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
  const geo = sweepProfile(circleProfile(radius, seg), path, { closed: true, cap: true });
  return new THREE.Mesh(geo, mat);
}

export { lerp, clamp01, TAU };
