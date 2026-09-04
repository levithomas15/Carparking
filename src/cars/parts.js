/**
 * Reusable car hardware: wheels, brakes, lamps, mirrors, aero and cabin.
 * Everything returns geometry or a Group so a car definition can compose
 * parts without repeating the trigonometry.
 */
import * as THREE from 'three';
import {
  sweepProfile, aerofoilProfile, rectProfile, circleProfile, roundedBox, mergeGeometries,
} from './loft.js';
import * as M from '../gfx/materials.js';
import { TAU, lerp } from '../core/util.js';

/* ══════════════════════════ wheels ══════════════════════════ */

/** Revolved tyre carcass: bead → sidewall bulge → shoulder → tread. */
function tyreGeometry(rimR, tyreR, width, segments = 40) {
  const hw = width / 2;
  const bulge = (tyreR - rimR) * 0.22;
  const pts = [
    new THREE.Vector2(rimR * 0.995, -hw * 0.98),
    new THREE.Vector2(rimR + (tyreR - rimR) * 0.30 + bulge * 0.5, -hw * 1.02),
    new THREE.Vector2(rimR + (tyreR - rimR) * 0.66 + bulge, -hw * 0.98),
    new THREE.Vector2(tyreR * 0.985, -hw * 0.86),
    new THREE.Vector2(tyreR, -hw * 0.70),
    new THREE.Vector2(tyreR, 0),
    new THREE.Vector2(tyreR, hw * 0.70),
    new THREE.Vector2(tyreR * 0.985, hw * 0.86),
    new THREE.Vector2(rimR + (tyreR - rimR) * 0.66 + bulge, hw * 0.98),
    new THREE.Vector2(rimR + (tyreR - rimR) * 0.30 + bulge * 0.5, hw * 1.02),
    new THREE.Vector2(rimR * 0.995, hw * 0.98),
  ];
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateZ(Math.PI / 2);        // spin axis Y → X
  return g;
}

/** Rim barrel + outer lip. */
function barrelGeometry(rimR, width, segments = 36) {
  const hw = width / 2;
  const pts = [
    new THREE.Vector2(rimR * 0.985, -hw * 0.98),
    new THREE.Vector2(rimR * 0.93, -hw * 0.86),
    new THREE.Vector2(rimR * 0.80, -hw * 0.42),
    new THREE.Vector2(rimR * 0.80, hw * 0.30),
    new THREE.Vector2(rimR * 0.90, hw * 0.72),
    new THREE.Vector2(rimR * 0.985, hw * 0.90),
    new THREE.Vector2(rimR * 1.0, hw * 0.99),
  ];
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** One spoke: a tapered slab swept from the hub out to the rim. */
function spokeGeometry(innerR, outerR, wInner, wOuter, thick, dish, twist) {
  const path = [];
  const steps = 7;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const r = lerp(innerR, outerR, t);
    const ang = twist * t;
    path.push({
      x: lerp(dish * 0.55, -dish * 0.35, t),   // dish toward the outer face
      y: Math.cos(ang) * r,
      z: Math.sin(ang) * r,
      scaleX: lerp(1, thick / thick, t),
      scaleY: lerp(wInner, wOuter, Math.pow(t, 0.7)) / wInner,
    });
  }
  const prof = rectProfile(thick, wInner, thick * 0.32, 2);
  return sweepProfile(prof, path, { closed: true, cap: true });
}

const RIM_STYLES = [
  { name: 'Giano', spokes: 5, twin: true, twist: 0.16, wInner: 0.062, wOuter: 0.105, thick: 0.055, dish: 0.07 },
  { name: 'Loge',  spokes: 10, twin: false, twist: 0.30, wInner: 0.030, wOuter: 0.052, thick: 0.045, dish: 0.09 },
  { name: 'Turbine', spokes: 7, twin: false, twist: 0.52, wInner: 0.085, wOuter: 0.150, thick: 0.038, dish: 0.10 },
];

/**
 * Build one complete wheel. The returned group's local +X is the outboard
 * direction; the caller mirrors it for the left-hand side.
 */
export function buildWheel({
  rimR = 0.245, tyreR = 0.345, width = 0.31,
  style = 0, rimColor = 0x1a1c20, rimMetal = 1.0, rimRough = 0.22,
  caliperColor = 0xd8341f, discR = null, lod = 1,
} = {}) {
  const g = new THREE.Group();
  const S = RIM_STYLES[style % RIM_STYLES.length];
  const seg = lod > 0.5 ? 40 : 22;

  const tyre = new THREE.Mesh(tyreGeometry(rimR, tyreR, width, seg), M.tyreRubber());
  tyre.castShadow = true;
  g.add(tyre);

  const rimMat = M.metal({ color: rimColor, metalness: rimMetal, roughness: rimRough, env: 1.5 });

  const parts = [barrelGeometry(rimR, width, Math.max(18, seg - 6))];
  const spokeCount = S.spokes * (S.twin ? 2 : 1);
  for (let i = 0; i < S.spokes; i++) {
    const base = (i / S.spokes) * TAU;
    const offsets = S.twin ? [-0.11, 0.11] : [0];
    for (const o of offsets) {
      const sg = spokeGeometry(rimR * 0.30, rimR * 0.985, S.wInner, S.wOuter, S.thick, S.dish, S.twist);
      sg.rotateX(base + o);
      parts.push(sg);
    }
  }
  // hub barrel + face
  const hub = new THREE.CylinderGeometry(rimR * 0.30, rimR * 0.26, width * 0.52, 18);
  hub.rotateZ(Math.PI / 2);
  hub.translate(width * 0.06, 0, 0);
  parts.push(hub);

  const rim = new THREE.Mesh(mergeGeometries(parts), rimMat);
  rim.castShadow = true;
  g.add(rim);
  for (const pgeo of parts) pgeo.dispose?.();

  // centre lock nut
  const nut = new THREE.Mesh(
    new THREE.CylinderGeometry(rimR * 0.14, rimR * 0.16, 0.05, 6),
    M.metal({ color: 0xb08d3a, roughness: 0.3, env: 1.4 })
  );
  nut.rotation.z = Math.PI / 2;
  nut.position.x = width * 0.34;
  g.add(nut);

  // carbon-ceramic disc + caliper live on a non-spinning child
  const stat = new THREE.Group();
  stat.name = 'brake';
  const dR = discR ?? rimR * 0.86;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(dR, dR, 0.026, 30, 1, false), M.brakeDisc());
  disc.rotation.z = Math.PI / 2;
  disc.position.x = -width * 0.06;
  stat.add(disc);

  const bell = new THREE.Mesh(
    new THREE.CylinderGeometry(dR * 0.46, dR * 0.42, width * 0.30, 16),
    M.metal({ color: 0x55585d, roughness: 0.45 })
  );
  bell.rotation.z = Math.PI / 2;
  bell.position.x = -width * 0.02;
  stat.add(bell);

  const cal = new THREE.Mesh(
    roundedBox(0.075, 0.10, 0.235, 0.02, 2),
    M.metal({ color: caliperColor, metalness: 0.55, roughness: 0.30, env: 1.0 })
  );
  cal.position.set(-width * 0.06, dR * 0.74, -0.02);
  cal.rotation.x = 0.22;
  cal.castShadow = true;
  stat.add(cal);

  g.add(stat);
  g.userData.spin = rim;
  g.userData.tyre = tyre;
  g.userData.brake = stat;
  g.userData.disc = disc;
  g.userData.radius = tyreR;
  g.userData.spokeCount = spokeCount;
  return g;
}

/* ══════════════════════════ lamps ══════════════════════════ */

/**
 * Extruded light bar following a polyline — used for LED daytime running
 * signatures (the Y of a Lamborghini, the strip of a Zonda).
 */
export function lightBar(points, { w = 0.028, h = 0.032, color = 0xdff0ff, power = 3.2 } = {}) {
  const path = points.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
  const geo = sweepProfile(rectProfile(w, h, w * 0.4, 2), path, { closed: true, cap: true });
  const mesh = new THREE.Mesh(geo, M.lightLens({ color, power }));
  mesh.userData.emissive = true;
  return mesh;
}

/** Projector-style headlamp: dark housing + lens + emissive core. */
export function projectorLamp({ r = 0.062, depth = 0.09, color = 0xf4f8ff, power = 2.4 } = {}) {
  const g = new THREE.Group();
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 1.18, r * 0.86, depth, 18, 1, true),
    M.reflectorHousing()
  );
  housing.rotation.x = Math.PI / 2;
  g.add(housing);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12, 0, TAU, 0, Math.PI * 0.42), M.glass({ tint: 0xbfd8ff, opacity: 0.5 }));
  lens.rotation.x = -Math.PI / 2;
  lens.position.z = depth * 0.42;
  g.add(lens);
  const core = new THREE.Mesh(new THREE.CircleGeometry(r * 0.72, 18), M.lightLens({ color, power }));
  core.position.z = depth * 0.18;
  core.userData.emissive = true;
  g.add(core);
  g.userData.core = core;
  return g;
}

/** Flat emissive panel used for tail lights and side markers. */
export function lampPanel(w, h, { color = 0xff2418, power = 2.0, bevel = 0.012 } = {}) {
  const geo = roundedBox(w, h, 0.03, bevel, 2);
  const mesh = new THREE.Mesh(geo, M.lightLens({ color, power, rough: 0.14 }));
  mesh.userData.emissive = true;
  return mesh;
}

/* ══════════════════════════ mirrors ══════════════════════════ */

export function wingMirror({ side = 1, stalk = 0.14, housing = [0.13, 0.07, 0.055], carbon = true } = {}) {
  const g = new THREE.Group();
  const arm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.014, 0.019, stalk, 8),
    carbon ? M.carbonFibre({ scale: 3 }) : M.matteBlack(0.4)
  );
  arm.rotation.z = -side * 0.62;
  arm.position.set(side * stalk * 0.28, stalk * 0.24, 0);
  g.add(arm);

  const cap = new THREE.Mesh(
    roundedBox(housing[0], housing[1], housing[2], 0.022, 3),
    carbon ? M.carbonFibre({ scale: 4 }) : M.matteBlack(0.35)
  );
  cap.position.set(side * stalk * 0.62, stalk * 0.52, 0);
  cap.rotation.y = -side * 0.16;
  cap.castShadow = true;
  g.add(cap);

  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(housing[0] * 0.78, housing[1] * 0.66),
    M.metal({ color: 0x9fb2c6, roughness: 0.05, env: 2.2 })
  );
  glass.position.set(side * (stalk * 0.62 - 0.005), stalk * 0.52, housing[2] * 0.52);
  glass.rotation.y = -side * 0.16;
  g.add(glass);
  return g;
}

/* ══════════════════════════ aero ══════════════════════════ */

/**
 * Rear wing. `swanNeck` mounts the supports on top of the aerofoil, the way
 * a track-focused car does it to keep the low-pressure surface clean.
 */
export function rearWing({
  span = 1.62, chord = 0.30, thickness = 0.09, camber = 0.055,
  aoa = -0.16, y = 1.02, z = -2.0, riser = 0.30, swanNeck = true,
  endplateH = 0.30, endplateL = 0.42, material = null, gurney = true,
} = {}) {
  const g = new THREE.Group();
  const mat = material || M.carbonFibre({ scale: 2.2 });

  const prof = aerofoilProfile(chord, thickness, camber, 16);
  const path = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const x = lerp(-span / 2, span / 2, t);
    // slight sweep + tip taper
    path.push({ x, y: 0, z: Math.abs(x) * 0.035, scaleX: 1, scaleY: lerp(1, 0.94, Math.abs(t - 0.5) * 2) });
  }
  const blade = new THREE.Mesh(sweepProfile(prof, path.map((p) => ({ x: p.z, y: p.y, z: p.x, scaleX: p.scaleX, scaleY: p.scaleY })), { closed: true, cap: true }), mat);
  blade.rotation.y = Math.PI / 2;
  blade.rotation.x = aoa;
  blade.castShadow = true;
  const bladeHolder = new THREE.Group();
  bladeHolder.add(blade);
  bladeHolder.position.set(0, y, z);
  g.add(bladeHolder);
  g.userData.blade = bladeHolder;

  if (gurney) {
    const gur = new THREE.Mesh(new THREE.BoxGeometry(span * 0.98, 0.022, 0.008), mat);
    gur.position.set(0, y + Math.sin(-aoa) * chord * 0.5 + thickness * chord * 0.5, z - chord * 0.48);
    g.add(gur);
  }

  for (const s of [-1, 1]) {
    const plate = new THREE.Mesh(roundedBox(0.016, endplateH, endplateL, 0.01, 2), mat);
    plate.position.set(s * span / 2, y - 0.02, z + 0.02);
    plate.castShadow = true;
    g.add(plate);

    const support = new THREE.Mesh(
      roundedBox(0.030, riser, 0.10, 0.012, 2),
      mat
    );
    support.position.set(s * span * 0.24, y + (swanNeck ? riser * 0.5 : -riser * 0.5), z + chord * 0.12);
    support.rotation.x = swanNeck ? 0.10 : -0.10;
    support.castShadow = true;
    g.add(support);

    if (swanNeck) {
      const hook = new THREE.Mesh(roundedBox(0.030, 0.10, 0.16, 0.012, 2), mat);
      hook.position.set(s * span * 0.24, y + riser * 0.98, z + chord * 0.05);
      hook.rotation.x = 0.5;
      g.add(hook);
    }
  }
  return g;
}

/** Front splitter with vertical strakes. */
export function frontSplitter({ width = 1.86, depth = 0.42, y = 0.10, z = 2.05, strakes = 4, material = null } = {}) {
  const g = new THREE.Group();
  const mat = material || M.carbonFibre({ scale: 2.6 });
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw * 0.86, depth);
  shape.quadraticCurveTo(0, depth * 1.32, -hw * 0.86, depth);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.026, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.006, bevelSegments: 1 });
  geo.rotateX(-Math.PI / 2);
  const plate = new THREE.Mesh(geo, mat);
  plate.position.set(0, y, z);
  plate.castShadow = true;
  plate.receiveShadow = true;
  g.add(plate);

  for (let i = 0; i < strakes; i++) {
    for (const s of [-1, 1]) {
      const t = (i + 1) / (strakes + 1);
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, depth * 0.7), mat);
      fin.position.set(s * hw * t * 0.9, y + 0.035, z + depth * 0.42);
      fin.rotation.y = s * 0.10;
      g.add(fin);
    }
  }
  return g;
}

/** Rear diffuser: an upswept floor with vertical fins. */
export function diffuser({ width = 1.62, length = 0.62, y = 0.11, z = -2.05, fins = 5, rise = 0.20, material = null } = {}) {
  const g = new THREE.Group();
  const mat = material || M.carbonFibre({ scale: 2.6 });
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(length, rise);
  shape.lineTo(length, rise + 0.026);
  shape.lineTo(0, 0.026);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(Math.PI / 2);
  const floor = new THREE.Mesh(geo, mat);
  floor.position.set(0, y, z);
  floor.rotation.y = Math.PI;
  g.add(floor);

  for (let i = 0; i <= fins; i++) {
    const t = i / fins;
    const x = lerp(-width / 2, width / 2, t) * 0.94;
    const shape2 = new THREE.Shape();
    shape2.moveTo(0, 0);
    shape2.lineTo(length, rise);
    shape2.lineTo(length, rise + 0.10);
    shape2.lineTo(0, 0.09);
    shape2.closePath();
    const fg = new THREE.ExtrudeGeometry(shape2, { depth: 0.014, bevelEnabled: false });
    fg.rotateY(Math.PI / 2);
    const fin = new THREE.Mesh(fg, mat);
    fin.position.set(x, y, z);
    fin.rotation.y = Math.PI;
    g.add(fin);
  }
  return g;
}

/* ══════════════════════════ exhaust ══════════════════════════ */

export function exhaustTips({ count = 2, spacing = 0.18, r = 0.055, y = 0.44, z = -2.06, hex = false, length = 0.20 } = {}) {
  const g = new THREE.Group();
  const mat = M.heatedTitanium();
  const inner = M.matteBlack(0.9, 0x050607);
  for (let i = 0; i < count; i++) {
    const x = (i - (count - 1) / 2) * spacing;
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r * 0.94, length, hex ? 6 : 18, 1, true),
      mat
    );
    tube.rotation.x = Math.PI / 2;
    tube.position.set(x, y, z + length * 0.5);
    g.add(tube);
    const cap = new THREE.Mesh(new THREE.CircleGeometry(r * 0.92, hex ? 6 : 18), inner);
    cap.position.set(x, y, z + 0.005);
    cap.rotation.y = Math.PI;
    g.add(cap);
  }
  return g;
}

/* ══════════════════════════ cabin ══════════════════════════ */

/** Racing bucket seat built from three swept slabs. */
function bucketSeat(mat) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(roundedBox(0.46, 0.10, 0.50, 0.05, 2), mat);
  base.position.set(0, 0, 0.02);
  g.add(base);
  const back = new THREE.Mesh(roundedBox(0.44, 0.72, 0.11, 0.05, 2), mat);
  back.position.set(0, 0.36, -0.24);
  back.rotation.x = 0.20;
  g.add(back);
  for (const s of [-1, 1]) {
    const bolster = new THREE.Mesh(roundedBox(0.075, 0.60, 0.16, 0.035, 2), mat);
    bolster.position.set(s * 0.20, 0.30, -0.16);
    bolster.rotation.x = 0.20;
    bolster.rotation.z = -s * 0.06;
    g.add(bolster);
    const thigh = new THREE.Mesh(roundedBox(0.08, 0.09, 0.44, 0.035, 2), mat);
    thigh.position.set(s * 0.20, 0.05, 0.04);
    g.add(thigh);
  }
  const head = new THREE.Mesh(roundedBox(0.30, 0.20, 0.10, 0.045, 2), mat);
  head.position.set(0, 0.80, -0.31);
  head.rotation.x = 0.20;
  g.add(head);
  return g;
}

/** Cabin interior: dash, wheel, seats, tunnel. Visible through the glass. */
export function buildInterior({
  width = 1.5, seatX = 0.36, dashZ = 0.45, seatZ = -0.20, floorY = 0.30,
  wheelR = 0.16, trimColor = 0x14161b, accent = 0xff6a2b, cage = false,
} = {}) {
  const g = new THREE.Group();
  const suede = M.alcantara(trimColor);
  const carbon = M.carbonFibre({ scale: 5 });
  const black = M.matteBlack(0.8, 0x0a0c10);

  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.03, 1.5), black);
  floor.position.set(0, floorY, seatZ);
  g.add(floor);

  const dash = new THREE.Mesh(roundedBox(width * 0.96, 0.30, 0.34, 0.06, 2), suede);
  dash.position.set(0, floorY + 0.42, dashZ);
  dash.rotation.x = -0.20;
  g.add(dash);

  const binnacle = new THREE.Mesh(roundedBox(0.34, 0.16, 0.10, 0.03, 2), black);
  binnacle.position.set(seatX, floorY + 0.55, dashZ - 0.12);
  binnacle.rotation.x = -0.30;
  g.add(binnacle);
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.28, 0.12),
    M.lightLens({ color: 0x2b7fff, power: 0.9, rough: 0.3 })
  );
  screen.position.set(seatX, floorY + 0.565, dashZ - 0.165);
  screen.rotation.x = -0.30 - Math.PI / 2 + Math.PI / 2;
  screen.rotation.x = -1.87;
  screen.userData.emissive = true;
  g.add(screen);

  // steering wheel — flat-bottomed, carbon spokes, suede rim
  const wheel = new THREE.Group();
  const rimGeo = new THREE.TorusGeometry(wheelR, 0.021, 8, 28, Math.PI * 1.62);
  const rim = new THREE.Mesh(rimGeo, suede);
  rim.rotation.z = Math.PI * 0.19;
  wheel.add(rim);
  const flat = new THREE.Mesh(new THREE.BoxGeometry(wheelR * 1.34, 0.038, 0.030), suede);
  flat.position.y = -wheelR * 0.86;
  wheel.add(flat);
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i / 3) * TAU + 0.5;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(wheelR * 0.9, 0.030, 0.018), carbon);
    spoke.position.set(Math.cos(a) * wheelR * 0.46, Math.sin(a) * wheelR * 0.46, 0);
    spoke.rotation.z = a;
    wheel.add(spoke);
  }
  const boss = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.05, 14), black);
  boss.rotation.x = Math.PI / 2;
  wheel.add(boss);
  const marker = new THREE.Mesh(new THREE.BoxGeometry(0.030, 0.026, 0.016), M.lightLens({ color: accent, power: 1.2 }));
  marker.position.set(0, wheelR, 0.012);
  wheel.add(marker);
  wheel.position.set(seatX, floorY + 0.46, dashZ - 0.30);
  wheel.rotation.x = -0.38;
  g.add(wheel);
  g.userData.steeringWheel = wheel;

  for (const s of [-1, 1]) {
    const seat = bucketSeat(suede);
    seat.position.set(s * seatX * (s > 0 ? 1 : 1), floorY + 0.03, seatZ - 0.10);
    seat.scale.setScalar(0.92);
    g.add(seat);
    for (const belt of [-1, 1]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.012),
        M.matteBlack(0.9, belt > 0 ? accent : 0x1a1c22));
      strap.position.set(s * seatX + belt * 0.12, floorY + 0.42, seatZ - 0.30);
      strap.rotation.z = -belt * 0.20;
      strap.rotation.x = 0.16;
      g.add(strap);
    }
  }

  const tunnel = new THREE.Mesh(roundedBox(0.26, 0.22, 1.0, 0.05, 2), carbon);
  tunnel.position.set(0, floorY + 0.14, seatZ);
  g.add(tunnel);

  if (cage) {
    const tubeMat = M.metal({ color: 0xc23a2a, roughness: 0.36, metalness: 0.7 });
    const prof = circleProfile(0.028, 10);
    const hoop = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const a = Math.PI * t;
      hoop.push({ x: Math.cos(a) * width * 0.44, y: floorY + Math.sin(a) * 0.86, z: seatZ - 0.42 });
    }
    g.add(new THREE.Mesh(sweepProfile(prof, hoop, { closed: true, cap: true }), tubeMat));
    for (const s of [-1, 1]) {
      const brace = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        brace.push({ x: s * width * 0.42, y: floorY + lerp(0.80, 0.06, t), z: seatZ - lerp(0.46, 1.30, t) });
      }
      g.add(new THREE.Mesh(sweepProfile(prof, brace, { closed: true, cap: true }), tubeMat));
    }
  }

  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
  return g;
}

/* ══════════════════════════ misc ══════════════════════════ */

/** Honeycomb-ish mesh panel used to blank off intakes and grilles. */
export function meshPanel(w, h, { cells = 7, depth = 0.02 } = {}) {
  const geos = [];
  const cw = w / cells;
  const rows = Math.max(2, Math.round(h / cw));
  const ch = h / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cells; c++) {
      const off = (r % 2) * cw * 0.5;
      const x = -w / 2 + cw * (c + 0.5) + off;
      if (x > w / 2) continue;
      const y = -h / 2 + ch * (r + 0.5);
      const bar = new THREE.BoxGeometry(cw * 0.16, ch * 0.92, depth);
      bar.translate(x, y, 0);
      geos.push(bar);
    }
  }
  for (let r = 0; r <= rows; r++) {
    const bar = new THREE.BoxGeometry(w, ch * 0.14, depth * 0.8);
    bar.translate(0, -h / 2 + ch * r, 0);
    geos.push(bar);
  }
  const merged = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  const m = new THREE.Mesh(merged, M.grilleMesh());
  return m;
}

/** Vent louvres — a stack of thin angled slats. */
export function louvres(w, h, d, count = 5, angle = 0.5, mat = null) {
  const geos = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const slat = new THREE.BoxGeometry(w, 0.012, d);
    slat.rotateX(angle);
    slat.translate(0, (t - 0.5) * h, 0);
    geos.push(slat);
  }
  const merged = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  return new THREE.Mesh(merged, mat || M.matteBlack(0.5));
}

/** Number-plate style badge plate. */
export function badgePlate(w = 0.30, h = 0.10, color = 0x0a0c10) {
  const m = new THREE.Mesh(roundedBox(w, h, 0.012, 0.01, 1), M.matteBlack(0.5, color));
  return m;
}
