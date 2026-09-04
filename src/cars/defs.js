/**
 * The three cars.
 *
 * Each definition carries the body cross-sections, the wheel geometry, the
 * material patches that place glass / carbon / trim on the lofted surface,
 * and the physical data the simulation drives. Bodywork is an original
 * interpretation built from primitives — this is a fan project, not a
 * licensed reproduction.
 */
import * as THREE from 'three';
import { SLOT, registerLamp, tube } from './model.js';
import {
  rearWing, frontSplitter, diffuser, exhaustTips, wingMirror,
  lightBar, lampPanel, projectorLamp, meshPanel, louvres,
} from './parts.js';
import * as M from '../gfx/materials.js';
import { roundedBox, sweepProfile, rectProfile, surfacePoint, surfaceNormal } from './loft.js';
import { TAU } from '../core/util.js';

/**
 * Station shorthand.
 * z, halfWidth, bottomWidth, beltWidth, topWidth, floorY, shoulderY, beltY, topY
 */
const S = (z, hw, bw, blw, tw, fy, sy, bly, ty, extra = {}) => ({
  z, halfWidth: hw, bottomWidth: bw, beltWidth: blw, topWidth: tw,
  floorY: fy, shoulderY: sy, beltY: bly, topY: ty, ...extra,
});

/* ═══════════════════════════════════════════════════════════════
   1 · LAMBORGHINI HURACÁN EVO
   Mid-engined 5.2 V10, all-wheel drive, rear-wheel steering.
   ═══════════════════════════════════════════════════════════════ */

const HURACAN_STATIONS = [
  //  z       hw     bw     beltW  topW   floorY shldY  beltY  topY
  S( 2.315, 0.560, 0.380, 0.510, 0.360, 0.250, 0.330, 0.430, 0.480, { lowerN: 2.4, sideN: 2.6, upperN: 2.2, linSide: 0.5 }),
  S( 2.280, 0.780, 0.520, 0.720, 0.520, 0.175, 0.345, 0.470, 0.545, { lowerN: 2.8, sideN: 3.0, upperN: 2.2, linSide: 0.6 }),
  S( 2.200, 0.868, 0.590, 0.815, 0.610, 0.135, 0.370, 0.512, 0.598, { lowerN: 3.2, sideN: 3.4, upperN: 2.3 }),
  S( 2.060, 0.920, 0.630, 0.872, 0.672, 0.118, 0.400, 0.552, 0.645, { lowerN: 3.4, sideN: 3.8, upperN: 2.4 }),
  S( 1.880, 0.947, 0.645, 0.898, 0.702, 0.112, 0.432, 0.596, 0.700, { lowerN: 3.6, sideN: 4.0, upperN: 2.5 }),
  S( 1.640, 0.958, 0.640, 0.905, 0.706, 0.135, 0.468, 0.632, 0.748, { lowerN: 3.6, sideN: 4.0, upperN: 2.6 }),
  S( 1.310, 0.962, 0.618, 0.906, 0.700, 0.185, 0.500, 0.664, 0.786, { lowerN: 3.6, sideN: 4.0, upperN: 2.6 }),
  S( 1.030, 0.940, 0.638, 0.888, 0.686, 0.165, 0.516, 0.690, 0.818, { lowerN: 3.4, sideN: 4.0, upperN: 2.6 }),
  S( 0.760, 0.928, 0.658, 0.882, 0.664, 0.152, 0.528, 0.712, 0.848, { lowerN: 3.2, sideN: 4.0, upperN: 2.4 }),
  S( 0.520, 0.926, 0.672, 0.882, 0.590, 0.148, 0.538, 0.740, 0.905, { lowerN: 3.2, sideN: 4.2, upperN: 2.0, linUpper: 0.45 }),
  S( 0.260, 0.932, 0.678, 0.888, 0.470, 0.146, 0.550, 0.768, 1.035, { lowerN: 3.2, sideN: 4.2, upperN: 1.8, linUpper: 0.50 }),
  S( 0.000, 0.940, 0.680, 0.898, 0.396, 0.146, 0.560, 0.788, 1.128, { lowerN: 3.2, sideN: 4.2, upperN: 1.8, linUpper: 0.44 }),
  S(-0.260, 0.945, 0.680, 0.902, 0.372, 0.150, 0.568, 0.798, 1.165, { lowerN: 3.2, sideN: 4.2, upperN: 1.9, linUpper: 0.34 }),
  S(-0.560, 0.949, 0.680, 0.905, 0.388, 0.162, 0.572, 0.800, 1.128, { lowerN: 3.2, sideN: 4.2, upperN: 1.9, linUpper: 0.36 }),
  S(-0.860, 0.955, 0.670, 0.906, 0.462, 0.176, 0.570, 0.788, 1.035, { lowerN: 3.3, sideN: 4.1, upperN: 2.0, linUpper: 0.42 }),
  S(-1.120, 0.960, 0.646, 0.905, 0.570, 0.194, 0.558, 0.768, 0.962, { lowerN: 3.5, sideN: 4.0, upperN: 2.3 }),
  S(-1.310, 0.962, 0.622, 0.902, 0.630, 0.206, 0.545, 0.752, 0.928, { lowerN: 3.6, sideN: 3.9, upperN: 2.5 }),
  S(-1.680, 0.948, 0.640, 0.884, 0.690, 0.190, 0.518, 0.722, 0.884, { lowerN: 3.5, sideN: 3.7, upperN: 2.7 }),
  S(-1.980, 0.916, 0.628, 0.858, 0.672, 0.196, 0.484, 0.684, 0.842, { lowerN: 3.3, sideN: 3.4, upperN: 2.6 }),
  S(-2.180, 0.842, 0.560, 0.780, 0.600, 0.216, 0.442, 0.622, 0.780, { lowerN: 2.9, sideN: 3.0, upperN: 2.3 }),
  S(-2.240, 0.640, 0.410, 0.580, 0.420, 0.260, 0.418, 0.560, 0.700, { lowerN: 2.4, sideN: 2.5, upperN: 2.1, linSide: 0.5 }),
];

const HURACAN_PATCHES = [
  // flat underbody is never painted
  { u0: 0.00, u1: 1.00, v0: 0.000, v1: 0.092, mat: SLOT.TRIM },
  // front lip and lower bumper intakes
  { u0: 0.00, u1: 0.070, v0: 0.088, v1: 0.235, mat: SLOT.CARBON },
  { u0: 0.030, u1: 0.150, v0: 0.100, v1: 0.290, mat: SLOT.TRIM },
  { u0: 0.000, u1: 0.048, v0: 0.235, v1: 0.560, mat: SLOT.CARBON },
  // rocker sills
  { u0: 0.275, u1: 0.740, v0: 0.088, v1: 0.178, mat: SLOT.CARBON },
  // greenhouse
  { u0: 0.470, u1: 0.588, v0: 0.600, v1: 1.000, mat: SLOT.GLASS },   // windscreen
  { u0: 0.545, u1: 0.688, v0: 0.598, v1: 0.856, mat: SLOT.GLASS },   // side glass
  { u0: 0.652, u1: 0.738, v0: 0.660, v1: 1.000, mat: SLOT.GLASS },   // rear screen
  // side intakes ahead of the rear wheels: carbon surround, dark mouth
  { u0: 0.680, u1: 0.790, v0: 0.170, v1: 0.500, mat: SLOT.CARBON },
  { u0: 0.700, u1: 0.772, v0: 0.215, v1: 0.440, mat: SLOT.TRIM },
  // engine deck louvres
  { u0: 0.772, u1: 0.880, v0: 0.872, v1: 1.000, mat: SLOT.TRIM },
  // rear fascia
  { u0: 0.898, u1: 1.000, v0: 0.088, v1: 0.420, mat: SLOT.TRIM },
];

const HURACAN_WHEELS = {
  frontX: 0.834, frontZ: 1.31, frontR: 0.330, frontRimR: 0.254, frontW: 0.245,
  rearX: 0.810, rearZ: -1.31, rearR: 0.345, rearRimR: 0.254, rearW: 0.305,
};

const HURACAN_ARCHES = [
  { z: 1.31, y: 0.318, r: 0.386, innerX: 0.702, blend: 0.045, squash: 0.96 },
  { z: -1.31, y: 0.330, r: 0.406, innerX: 0.688, blend: 0.045, squash: 0.96 },
];

/**
 * Attach a point to the body: returns the world position sitting `out`
 * metres proud of the panel at (z, v) on side `side`.
 */
function onBody(stations, arches, z, v, side = 1, out = 0.012) {
  const p = surfacePoint(stations, z, v, arches);
  const n = surfaceNormal(stations, z, v);
  return {
    x: side * (p.x + n.x * out),
    y: p.y + n.y * out,
    z: p.z,
    nx: n.x, ny: n.y,
  };
}

/** The Y-shaped daytime running signature, mirrored to both sides. */
function addYSignature(model, stations, arches, { z, vHi, vLo, vIn, vOut, color, power, kind, side }) {
  const A = onBody(stations, arches, z, vOut, side, 0.010);
  const B = onBody(stations, arches, z + 0.075, (vOut + vIn) * 0.5, side, 0.012);
  const C = onBody(stations, arches, z + 0.095, vIn, side, 0.012);
  const D = onBody(stations, arches, z + 0.055, vLo, side, 0.012);
  const E = onBody(stations, arches, z, vHi, side, 0.010);

  const arm = lightBar([[A.x, A.y, A.z], [B.x, B.y, B.z], [C.x, C.y, C.z]],
    { w: 0.026, h: 0.030, color, power });
  const stem = lightBar([[B.x, B.y, B.z], [(B.x + D.x) * 0.5, (B.y + D.y) * 0.5 - 0.01, (B.z + D.z) * 0.5], [D.x, D.y, D.z]],
    { w: 0.024, h: 0.028, color, power });
  const upper = lightBar([[E.x, E.y, E.z], [(E.x + C.x) * 0.5 + side * 0.03, (E.y + C.y) * 0.5 + 0.018, (E.z + C.z) * 0.5 + 0.02], [C.x, C.y, C.z]],
    { w: 0.022, h: 0.024, color, power: power * 0.85 });

  for (const m of [arm, stem, upper]) {
    registerLamp(model, m, kind, side, power);
    model.group.add(m);
  }
}

function huracanCommonParts(model, opts = {}) {
  const g = model.group;
  const def = model.def;
  const ST = def.stations, AR = def.arches;
  const carbon = M.carbonFibre({ scale: 2.2 });

  /* headlamps, sitting on the fender shoulder */
  for (const s of [-1, 1]) {
    addYSignature(model, ST, AR, {
      z: 2.02, vHi: 0.475, vLo: 0.235, vIn: 0.30, vOut: 0.43,
      color: 0xdfeeff, power: 3.6, kind: 'head', side: s,
    });
    const seat = onBody(ST, AR, 2.02, 0.36, s, -0.02);
    const housing = new THREE.Mesh(roundedBox(0.30, 0.19, 0.14, 0.05, 2), M.reflectorHousing());
    housing.position.set(seat.x, seat.y, seat.z + 0.02);
    housing.rotation.y = -s * 0.26;
    housing.rotation.x = -0.16;
    g.add(housing);

    const lensAt = onBody(ST, AR, 2.05, 0.355, s, 0.005);
    const proj = projectorLamp({ r: 0.046, depth: 0.06, power: 2.2 });
    proj.position.set(lensAt.x, lensAt.y, lensAt.z);
    proj.rotation.y = -s * 0.24;
    registerLamp(model, proj.userData.core, 'head', s, 3.0);
    g.add(proj);
  }

  /* tail lamps — hexagonal Y clusters on the rear fascia */
  for (const s of [-1, 1]) {
    const mk = (z, v, len) => {
      const a = onBody(ST, AR, z, v, s, 0.010);
      return [a.x, a.y, a.z - len];
    };
    const yA = lightBar([mk(-2.02, 0.46, 0.01), mk(-2.05, 0.40, 0.0), mk(-2.09, 0.335, 0.0)],
      { w: 0.030, h: 0.034, color: 0xff2a10, power: 2.0 });
    const yB = lightBar([mk(-2.02, 0.26, 0.01), mk(-2.05, 0.315, 0.0), mk(-2.09, 0.335, 0.0)],
      { w: 0.030, h: 0.034, color: 0xff2a10, power: 2.0 });
    const yStem = lightBar([mk(-2.05, 0.40, 0.0), mk(-2.06, 0.36, 0.0), mk(-2.05, 0.315, 0.0)],
      { w: 0.026, h: 0.030, color: 0xff2a10, power: 2.0 });
    for (const m of [yA, yB, yStem]) {
      registerLamp(model, m, 'brake', s, 2.0);
      g.add(m);
    }

    const hs = onBody(ST, AR, -2.05, 0.36, s, -0.015);
    const housing = new THREE.Mesh(roundedBox(0.34, 0.20, 0.06, 0.03, 2), M.reflectorHousing());
    housing.position.set(hs.x, hs.y, hs.z);
    housing.rotation.y = s * 0.24;
    g.add(housing);

    const ip = onBody(ST, AR, -2.10, 0.30, s, 0.012);
    const ind = lampPanel(0.13, 0.045, { color: 0xff8a12, power: 0.04 });
    ind.position.set(ip.x, ip.y, ip.z);
    ind.rotation.y = s * 0.34;
    registerLamp(model, ind, 'indicator', s, 5.0);
    g.add(ind);

    const rp = onBody(ST, AR, -2.15, 0.20, s * 0.42, 0.012);
    const rev = lampPanel(0.10, 0.040, { color: 0xf4f8ff, power: 0.05 });
    rev.position.set(rp.x, rp.y, rp.z);
    registerLamp(model, rev, 'reverse', s, 3.6);
    g.add(rev);
  }

  /* third brake light on the trailing edge of the deck */
  const tp = surfacePoint(ST, -1.96, 0.94);
  const third = lampPanel(0.28, 0.026, { color: 0xff2a10, power: 0.2 });
  third.position.set(0, tp.y + 0.012, tp.z);
  registerLamp(model, third, 'brake', 0, 4.4);
  g.add(third);

  /* mirrors on the door shoulder */
  for (const s of [-1, 1]) {
    const mp = onBody(ST, AR, 0.62, 0.545, s, 0.015);
    const m = wingMirror({ side: s, carbon: true });
    m.position.set(mp.x, mp.y, mp.z);
    g.add(m);
  }

  /* side intake meshes */
  for (const s of [-1, 1]) {
    const sp = onBody(ST, AR, -0.92, 0.32, s, -0.045);
    const grille = meshPanel(0.40, 0.22, { cells: 8, depth: 0.02 });
    grille.position.set(sp.x, sp.y, sp.z);
    grille.rotation.y = s * (Math.PI / 2 - 0.14);
    g.add(grille);

    const fp = onBody(ST, AR, 2.16, 0.18, s * 0.62, -0.03);
    const front = meshPanel(0.34, 0.15, { cells: 7, depth: 0.02 });
    front.position.set(fp.x, fp.y, fp.z);
    front.rotation.y = s * 0.10;
    g.add(front);
  }

  /* engine deck louvres, sunk into the cover */
  const dp = surfacePoint(ST, -1.36, 0.94);
  const deck = louvres(0.62, 0.22, 0.24, 5, 0.40, carbon);
  deck.position.set(0, dp.y - 0.018, dp.z);
  deck.rotation.x = 0.14;
  g.add(deck);

  /* aero + exhaust */
  const sp0 = surfacePoint(ST, 2.20, 0.05);
  g.add(frontSplitter({ width: 1.72, depth: 0.22, y: sp0.y - 0.014, z: 2.16, strakes: 3, material: carbon }));
  g.add(diffuser({ width: 1.52, length: 0.50, y: 0.155, z: -2.02, fins: 5, rise: 0.18, material: carbon }));
  if (opts.exhaust !== false) {
    const ep = surfacePoint(ST, -2.06, 0.26);
    g.add(exhaustTips({ count: 2, spacing: 0.28, r: 0.056, y: ep.y + 0.10, z: -2.10, hex: true, length: 0.15 }));
  }

  /* rear plate recess */
  const pp = surfacePoint(ST, -2.12, 0.155);
  const plate = new THREE.Mesh(roundedBox(0.32, 0.10, 0.02, 0.01, 1), M.matteBlack(0.6, 0x111318));
  plate.position.set(0, pp.y, pp.z + 0.01);
  g.add(plate);
}

export const HURACAN_EVO = {
  id: 'huracan-evo',
  maker: 'LAMBORGHINI',
  model: 'HURACÁN EVO',
  tagline: 'V10 · 5.2 L · ALLRAD',
  blurb: 'Der naturally aspirated V10 dreht bis 8 500/min und schiebt über alle vier Räder.',
  length: 4.52, width: 1.924, height: 1.165,
  stations: HURACAN_STATIONS,
  patches: HURACAN_PATCHES,
  arches: HURACAN_ARCHES,
  wheels: HURACAN_WHEELS,
  caliperColor: 0xd8341f,
  glassTint: 0x070c13, glassOpacity: 0.84,
  interiorOpts: { width: 1.42, seatX: 0.36, dashZ: 0.42, seatZ: -0.16, floorY: 0.30, accent: 0xff6a2b },
  defaultRim: 0,
  rims: [
    { style: 0, color: 0x1c1e23, roughness: 0.24, metalness: 1.0, label: 'GIANO NERO' },
    { style: 1, color: 0xb9bec6, roughness: 0.16, metalness: 1.0, label: 'LOGE ARGENTO' },
    { style: 2, color: 0x30241a, roughness: 0.30, metalness: 1.0, label: 'TURBINE BRONZE' },
  ],
  paints: [
    { name: 'Arancio Borealis', color: 0xff5a09, metalness: 0.55, roughness: 0.22, flake: 0.8 },
    { name: 'Verde Mantis', color: 0x7ad018, metalness: 0.42, roughness: 0.24, flake: 0.5 },
    { name: 'Blu Cepheus', color: 0x0f4fd8, metalness: 0.58, roughness: 0.20, flake: 0.9, pearl: 0.25 },
    { name: 'Grigio Titans', color: 0x5e646c, metalness: 0.78, roughness: 0.24, flake: 1.0 },
    { name: 'Bianco Monocerus', color: 0xe9ecef, metalness: 0.20, roughness: 0.26, flake: 0.3 },
    { name: 'Nero Noctis', color: 0x0d0f13, metalness: 0.60, roughness: 0.20, flake: 0.7 },
    { name: 'Giallo Inti', color: 0xffc400, metalness: 0.40, roughness: 0.22, flake: 0.6 },
  ],
  parts(model) { huracanCommonParts(model); },
  ratings: { power: 0.82, handling: 0.83, brakes: 0.84, aero: 0.55 },
  phys: {
    mass: 1550, cgHeight: 0.44, cgBias: 0.43,   // 43 % front
    inertiaYaw: 2100,
    drivetrain: 'awd', rearBias: 0.72,
    idleRpm: 950, redline: 8500, limiter: 8700,
    peakTorque: 600, peakTorqueRpm: 6500, peakPowerRpm: 8000, peakPowerKw: 470,
    gears: [3.13, 2.17, 1.55, 1.19, 0.94, 0.78, 0.65], finalDrive: 3.92, reverse: 2.90,
    shiftTime: 0.09, clutchTime: 0.14,
    dragCd: 0.36, frontalArea: 1.95, liftFront: -0.14, liftRear: -0.28,
    brakeTorqueFront: 3900, brakeTorqueRear: 2100,
    tyreGripFront: 1.62, tyreGripRear: 1.70,
    steerMaxDeg: 30, steerSpeedFalloff: 0.62, rearSteer: 0.14,
    springFront: 62000, springRear: 70000, damperFront: 5200, damperRear: 5800,
    travel: 0.115, rideHeight: 0.105,
    arbFront: 14000, arbRear: 11000,
    engineInertia: 0.24, engineBrake: 26,
    topSpeed: 90.3,
  },
  ui: { power: 640, accel: 2.9, topSpeed: 325, mass: 1422 },
  audio: { cylinders: 10, firingHarmonics: [1, 2, 2.5, 3, 5, 7.5, 10], character: 'v10', idleTone: 0.55 },
};

/* ═══════════════════════════════════════════════════════════════
   2 · PAGANI ZONDA HP BARCHETTA
   Three cars built. 7.3 V12, open top, dorsal fin, covered rear wheels.
   ═══════════════════════════════════════════════════════════════ */

const ZONDA_STATIONS = [
  //  z       hw     bw     beltW  topW   floorY shldY  beltY  topY
  S( 2.255, 0.530, 0.350, 0.480, 0.330, 0.265, 0.345, 0.440, 0.500, { lowerN: 2.2, sideN: 2.3, upperN: 2.0, linSide: 0.45 }),
  S( 2.215, 0.760, 0.500, 0.700, 0.500, 0.185, 0.355, 0.478, 0.560, { lowerN: 2.4, sideN: 2.5, upperN: 2.0, linSide: 0.5 }),
  S( 2.130, 0.878, 0.570, 0.815, 0.585, 0.140, 0.380, 0.520, 0.618, { lowerN: 2.6, sideN: 2.8, upperN: 2.0 }),
  S( 1.980, 0.958, 0.610, 0.888, 0.640, 0.125, 0.408, 0.560, 0.672, { lowerN: 2.8, sideN: 3.0, upperN: 2.1 }),
  S( 1.780, 1.006, 0.628, 0.932, 0.672, 0.122, 0.440, 0.600, 0.726, { lowerN: 3.0, sideN: 3.2, upperN: 2.1 }),
  S( 1.520, 1.026, 0.622, 0.950, 0.678, 0.142, 0.472, 0.638, 0.776, { lowerN: 3.0, sideN: 3.2, upperN: 2.2 }),
  S( 1.260, 1.028, 0.604, 0.952, 0.668, 0.192, 0.500, 0.668, 0.812, { lowerN: 3.0, sideN: 3.2, upperN: 2.2 }),
  S( 0.980, 0.998, 0.624, 0.928, 0.632, 0.172, 0.514, 0.694, 0.848, { lowerN: 2.9, sideN: 3.2, upperN: 2.1 }),
  S( 0.700, 0.962, 0.646, 0.902, 0.582, 0.156, 0.524, 0.716, 0.872, { lowerN: 2.8, sideN: 3.3, upperN: 2.0 }),
  // open cockpit: the deck drops into a tub between the roll hoops
  S( 0.400, 0.958, 0.662, 0.906, 0.610, 0.154, 0.532, 0.740, 0.826, { lowerN: 2.8, sideN: 3.4, upperN: 2.8, linUpper: 0.65 }),
  S( 0.080, 0.972, 0.666, 0.922, 0.640, 0.154, 0.542, 0.748, 0.792, { lowerN: 2.8, sideN: 3.5, upperN: 3.2, linUpper: 0.75 }),
  S(-0.240, 0.994, 0.664, 0.942, 0.630, 0.164, 0.552, 0.756, 0.822, { lowerN: 2.9, sideN: 3.5, upperN: 3.0, linUpper: 0.65 }),
  S(-0.560, 1.014, 0.660, 0.958, 0.580, 0.176, 0.558, 0.780, 0.926, { lowerN: 3.0, sideN: 3.4, upperN: 2.3 }),
  S(-0.900, 1.026, 0.644, 0.966, 0.596, 0.188, 0.554, 0.780, 0.958, { lowerN: 3.1, sideN: 3.3, upperN: 2.2 }),
  S(-1.260, 1.028, 0.620, 0.960, 0.648, 0.206, 0.536, 0.752, 0.918, { lowerN: 3.2, sideN: 3.2, upperN: 2.4 }),
  S(-1.620, 1.004, 0.628, 0.936, 0.690, 0.196, 0.508, 0.720, 0.868, { lowerN: 3.2, sideN: 3.1, upperN: 2.6 }),
  S(-1.940, 0.948, 0.606, 0.878, 0.660, 0.204, 0.474, 0.678, 0.822, { lowerN: 3.0, sideN: 2.9, upperN: 2.5 }),
  S(-2.160, 0.848, 0.540, 0.782, 0.588, 0.226, 0.440, 0.620, 0.766, { lowerN: 2.7, sideN: 2.7, upperN: 2.2 }),
  S(-2.220, 0.620, 0.380, 0.556, 0.400, 0.276, 0.418, 0.556, 0.690, { lowerN: 2.2, sideN: 2.3, upperN: 2.0, linSide: 0.45 }),
];

const ZONDA_PATCHES = [
  { u0: 0.00, u1: 1.00, v0: 0.000, v1: 0.092, mat: SLOT.TRIM },
  // exposed carbon lower body — the Zonda's signature
  { u0: 0.00, u1: 0.068, v0: 0.088, v1: 0.260, mat: SLOT.CARBON },
  { u0: 0.062, u1: 0.170, v0: 0.090, v1: 0.300, mat: SLOT.TRIM },
  { u0: 0.250, u1: 0.760, v0: 0.088, v1: 0.190, mat: SLOT.CARBON },
  // open cockpit tub
  { u0: 0.478, u1: 0.640, v0: 0.640, v1: 1.000, mat: SLOT.TRIM },
  { u0: 0.452, u1: 0.482, v0: 0.720, v1: 1.000, mat: SLOT.GLASS },
  // glass over the V12
  { u0: 0.688, u1: 0.782, v0: 0.868, v1: 1.000, mat: SLOT.GLASS },
  { u0: 0.670, u1: 0.798, v0: 0.180, v1: 0.480, mat: SLOT.CARBON },
  { u0: 0.690, u1: 0.780, v0: 0.220, v1: 0.430, mat: SLOT.TRIM },
  { u0: 0.882, u1: 1.000, v0: 0.088, v1: 0.400, mat: SLOT.CARBON },
];

const ZONDA_WHEELS = {
  frontX: 0.870, frontZ: 1.26, frontR: 0.335, frontRimR: 0.242, frontW: 0.255,
  rearX: 0.845, rearZ: -1.26, rearR: 0.360, rearRimR: 0.254, rearW: 0.345,
};

const ZONDA_ARCHES = [
  { z: 1.26, y: 0.322, r: 0.392, innerX: 0.736, blend: 0.045, squash: 0.96 },
  // the Barchetta's rear wheels sit under body spats: a much shallower cut
  { z: -1.26, y: 0.352, r: 0.346, innerX: 0.740, blend: 0.05, squash: 0.94 },
];

export const ZONDA_HP_BARCHETTA = {
  id: 'zonda-hp-barchetta',
  maker: 'PAGANI',
  model: 'ZONDA HP BARCHETTA',
  tagline: 'V12 · 7.3 L · 3 EXEMPLARE',
  blurb: 'Drei Stück gebaut. Offener Roadster, Dorsalfinne, freiliegendes Karbon, 7,3-Liter-V12.',
  length: 4.44, width: 2.056, height: 1.141,
  stations: ZONDA_STATIONS,
  patches: ZONDA_PATCHES,
  arches: ZONDA_ARCHES,
  wheels: ZONDA_WHEELS,
  caliperColor: 0xc8c8cc,
  glassTint: 0x080f18, glassOpacity: 0.78,
  interiorOpts: {
    width: 1.36, seatX: 0.34, dashZ: 0.46, seatZ: -0.12, floorY: 0.28,
    trimColor: 0x2a1f16, accent: 0xc9a227, wheelR: 0.155,
  },
  defaultRim: 1,
  rims: [
    { style: 1, color: 0xcfd4da, roughness: 0.14, metalness: 1.0, label: 'MONOLITICO' },
    { style: 2, color: 0x8d7134, roughness: 0.26, metalness: 1.0, label: 'ORO' },
    { style: 0, color: 0x15171b, roughness: 0.28, metalness: 1.0, label: 'NOTTE' },
  ],
  paints: [
    { name: 'Carbonio Blu', color: 0x14202f, metalness: 0.70, roughness: 0.18, flake: 0.9, pearl: 0.30 },
    { name: 'Argento Vivo', color: 0xb6bcc4, metalness: 0.86, roughness: 0.16, flake: 1.0 },
    { name: 'Rosso Dubai', color: 0xb3121b, metalness: 0.52, roughness: 0.20, flake: 0.8 },
    { name: 'Bianco Benny', color: 0xeef1f4, metalness: 0.22, roughness: 0.24, flake: 0.3 },
    { name: 'Verde Mercurio', color: 0x0f7a5a, metalness: 0.62, roughness: 0.20, flake: 0.8, pearl: 0.35 },
    { name: 'Nero Ossidiana', color: 0x0a0c10, metalness: 0.66, roughness: 0.17, flake: 0.6 },
  ],
  ratings: { power: 0.95, handling: 0.79, brakes: 0.82, aero: 0.62 },
  parts(model) {
    const g = model.group;
    const carbon = M.carbonFibre({ scale: 1.8 });
    const titan = M.metal({ color: 0xa9a29b, roughness: 0.30, env: 1.5 });

    /* round quad headlamps */
    for (const s of [-1, 1]) {
      const pod = new THREE.Mesh(roundedBox(0.34, 0.15, 0.10, 0.05, 2), M.reflectorHousing());
      pod.position.set(s * 0.60, 0.645, 1.905);
      pod.rotation.y = -s * 0.22;
      g.add(pod);
      for (let i = 0; i < 2; i++) {
        const lamp = projectorLamp({ r: 0.058 - i * 0.010, depth: 0.075, power: 3.4 });
        lamp.position.set(s * (0.50 + i * 0.145), 0.648, 1.955 - i * 0.012);
        lamp.rotation.y = -s * 0.20;
        registerLamp(model, lamp.userData.core, 'head', s, 3.6);
        g.add(lamp);
      }
      const drl = lightBar([
        [s * 0.40, 0.560, 1.930], [s * 0.62, 0.548, 1.940], [s * 0.80, 0.560, 1.905],
      ], { w: 0.020, h: 0.022, color: 0xe8f2ff, power: 2.4 });
      registerLamp(model, drl, 'head', s, 2.4);
      g.add(drl);
    }

    /* round tail lamps, three per side */
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.052, 0.014, 8, 18),
          titan
        );
        ring.position.set(s * (0.34 + i * 0.155), 0.755, -2.055);
        ring.rotation.y = s * 0.12;
        g.add(ring);
        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(0.048, 18),
          M.lightLens({ color: i === 2 ? 0xff8a12 : 0xff2410, power: 0.4 })
        );
        disc.position.set(s * (0.34 + i * 0.155), 0.755, -2.048);
        disc.rotation.y = s * 0.12 + Math.PI;
        disc.userData.emissive = true;
        registerLamp(model, disc, i === 2 ? 'indicator' : 'brake', s, i === 2 ? 5.0 : 2.4);
        g.add(disc);
      }
    }

    /* dorsal fin — the Barchetta's defining line */
    const finShape = new THREE.Shape();
    finShape.moveTo(-0.55, 0);
    finShape.lineTo(0.62, 0);
    finShape.quadraticCurveTo(0.50, 0.30, 0.12, 0.345);
    finShape.quadraticCurveTo(-0.28, 0.36, -0.55, 0.08);
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, {
      depth: 0.045, bevelEnabled: true, bevelSize: 0.012, bevelThickness: 0.010, bevelSegments: 2,
    });
    finGeo.rotateY(Math.PI / 2);
    const fin = new THREE.Mesh(finGeo, carbon);
    fin.position.set(0.022, 0.90, -0.62);
    fin.castShadow = true;
    g.add(fin);

    /* twin roll hoops behind the seats */
    for (const s of [-1, 1]) {
      const hoop = tube([
        [s * 0.42, 0.80, -0.20], [s * 0.40, 1.02, -0.30], [s * 0.30, 1.06, -0.42], [s * 0.16, 0.96, -0.50],
      ], 0.030, carbon, 10);
      g.add(hoop);
    }

    /* wind deflector */
    const defl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.60, 0.62, 0.20, 24, 1, true, Math.PI * 0.72, Math.PI * 0.56),
      M.glass({ tint: 0x9fb6cc, opacity: 0.30 })
    );
    defl.position.set(0, 0.88, 0.34);
    defl.rotation.x = 0.30;
    g.add(defl);

    /* rear wheel spats */
    for (const s of [-1, 1]) {
      const spat = new THREE.Mesh(
        new THREE.SphereGeometry(0.40, 20, 12, 0, TAU, 0, Math.PI * 0.42),
        model.paintMaterial
      );
      spat.scale.set(0.30, 1, 1.0);
      spat.rotation.z = -s * Math.PI / 2;
      spat.position.set(s * 1.010, 0.360, -1.26);
      spat.castShadow = true;
      g.add(spat);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(0.40, 0.020, 8, 22, Math.PI), carbon);
      lip.position.set(s * 1.016, 0.360, -1.26);
      lip.rotation.y = Math.PI / 2;
      g.add(lip);
    }

    /* mirrors on tall carbon stalks */
    for (const s of [-1, 1]) {
      const m = wingMirror({ side: s, stalk: 0.17, housing: [0.115, 0.062, 0.05], carbon: true });
      m.position.set(s * 0.86, 0.74, 0.62);
      g.add(m);
    }

    /* quad centre exhaust */
    g.add(exhaustTips({ count: 2, spacing: 0.155, r: 0.062, y: 0.585, z: -2.09, length: 0.20 }));
    g.add(exhaustTips({ count: 2, spacing: 0.155, r: 0.050, y: 0.700, z: -2.075, length: 0.17 }));
    const shield = new THREE.Mesh(roundedBox(0.42, 0.30, 0.05, 0.03, 2), carbon);
    shield.position.set(0, 0.64, -2.02);
    g.add(shield);

    /* aero */
    g.add(frontSplitter({ width: 1.94, depth: 0.40, y: 0.115, z: 1.98, strakes: 4, material: carbon }));
    g.add(diffuser({ width: 1.70, length: 0.70, y: 0.135, z: -2.02, fins: 6, rise: 0.28, material: carbon }));
    g.add(rearWing({
      span: 1.32, chord: 0.24, thickness: 0.10, camber: 0.05, aoa: -0.20,
      y: 1.045, z: -1.86, riser: 0.20, swanNeck: false, endplateH: 0.20, endplateL: 0.30,
      material: carbon, gurney: false,
    }));

    /* side skirts / canards */
    for (const s of [-1, 1]) {
      const canard = new THREE.Mesh(roundedBox(0.30, 0.016, 0.14, 0.008, 1), carbon);
      canard.position.set(s * 0.86, 0.44, 1.80);
      canard.rotation.z = s * 0.22;
      canard.rotation.y = -s * 0.14;
      g.add(canard);
    }
  },
  phys: {
    mass: 1330, cgHeight: 0.42, cgBias: 0.44,
    inertiaYaw: 1950,
    drivetrain: 'rwd', rearBias: 1.0,
    idleRpm: 800, redline: 6800, limiter: 7000,
    peakTorque: 780, peakTorqueRpm: 5800, peakPowerRpm: 6200, peakPowerKw: 590,
    gears: [2.92, 1.94, 1.42, 1.09, 0.87, 0.72], finalDrive: 3.42, reverse: 2.70,
    shiftTime: 0.13, clutchTime: 0.20,
    dragCd: 0.35, frontalArea: 1.98, liftFront: -0.16, liftRear: -0.34,
    brakeTorqueFront: 3700, brakeTorqueRear: 2000,
    tyreGripFront: 1.58, tyreGripRear: 1.72,
    steerMaxDeg: 31, steerSpeedFalloff: 0.60, rearSteer: 0,
    springFront: 58000, springRear: 66000, damperFront: 4900, damperRear: 5500,
    travel: 0.12, rideHeight: 0.10,
    arbFront: 12500, arbRear: 10000,
    engineInertia: 0.34, engineBrake: 34,
    topSpeed: 97.2,
  },
  ui: { power: 802, accel: 3.0, topSpeed: 350, mass: 1250 },
  audio: { cylinders: 12, firingHarmonics: [1, 2, 3, 4.5, 6, 9, 12], character: 'v12', idleTone: 0.42 },
};

/* ═══════════════════════════════════════════════════════════════
   3 · LAMBORGHINI HURACÁN STO
   Rear drive, one-piece cofango, roof snorkel, swan-neck wing.
   ═══════════════════════════════════════════════════════════════ */

const STO_STATIONS = HURACAN_STATIONS.map((st, i) => {
  const c = { ...st };
  // lower nose, wider arches, taller engine deck to clear the roof snorkel
  if (i <= 4) { c.floorY = st.floorY - 0.012; c.topY = st.topY - 0.020; c.beltY = st.beltY - 0.014; }
  if (i === 5) { c.halfWidth = 0.978; c.beltWidth = 0.918; }
  if (i === 13) { c.halfWidth = 0.982; c.beltWidth = 0.916; }
  if (i >= 11 && i <= 13) { c.topY = st.topY + 0.015; }
  return c;
});

const STO_PATCHES = [
  { u0: 0.00, u1: 1.00, v0: 0.000, v1: 0.092, mat: SLOT.TRIM },
  // the cofango is one carbon clamshell over the whole nose
  { u0: 0.00, u1: 0.080, v0: 0.088, v1: 0.360, mat: SLOT.CARBON },
  { u0: 0.055, u1: 0.170, v0: 0.090, v1: 0.310, mat: SLOT.TRIM },
  { u0: 0.255, u1: 0.400, v0: 0.876, v1: 1.000, mat: SLOT.CARBON },  // bonnet vent
  { u0: 0.265, u1: 0.752, v0: 0.088, v1: 0.196, mat: SLOT.CARBON },  // sills
  { u0: 0.470, u1: 0.588, v0: 0.600, v1: 1.000, mat: SLOT.GLASS },
  { u0: 0.545, u1: 0.688, v0: 0.598, v1: 0.856, mat: SLOT.GLASS },
  { u0: 0.652, u1: 0.745, v0: 0.700, v1: 1.000, mat: SLOT.CARBON },  // solid engine lid
  { u0: 0.678, u1: 0.796, v0: 0.170, v1: 0.510, mat: SLOT.CARBON },
  { u0: 0.698, u1: 0.778, v0: 0.215, v1: 0.450, mat: SLOT.TRIM },
  { u0: 0.766, u1: 0.882, v0: 0.868, v1: 1.000, mat: SLOT.TRIM },
  { u0: 0.892, u1: 1.000, v0: 0.088, v1: 0.440, mat: SLOT.CARBON },
];

export const HURACAN_STO = {
  id: 'huracan-sto',
  maker: 'LAMBORGHINI',
  model: 'HURACÁN STO',
  tagline: 'V10 · 5.2 L · HECKANTRIEB',
  blurb: 'Straßenzugelassener Rennwagen: Cofango, Dachschnorchel, Schwanenhals-Flügel, Heckantrieb.',
  length: 4.549, width: 1.945, height: 1.220,
  stations: STO_STATIONS,
  patches: STO_PATCHES,
  arches: [
    { z: 1.31, y: 0.320, r: 0.392, innerX: 0.706, blend: 0.045, squash: 0.96 },
    { z: -1.31, y: 0.336, r: 0.414, innerX: 0.694, blend: 0.045, squash: 0.96 },
  ],
  wheels: {
    frontX: 0.842, frontZ: 1.31, frontR: 0.332, frontRimR: 0.254, frontW: 0.245,
    rearX: 0.822, rearZ: -1.31, rearR: 0.350, rearRimR: 0.254, rearW: 0.315,
  },
  caliperColor: 0xe2b60c,
  glassTint: 0x070c13, glassOpacity: 0.84,
  interiorOpts: {
    width: 1.42, seatX: 0.36, dashZ: 0.42, seatZ: -0.16, floorY: 0.30,
    trimColor: 0x101318, accent: 0x2bd4ff, cage: true,
  },
  defaultRim: 2,
  rims: [
    { style: 2, color: 0x14161a, roughness: 0.34, metalness: 0.9, label: 'STO MAGNESIO' },
    { style: 0, color: 0xd4a017, roughness: 0.22, metalness: 1.0, label: 'ORO ELIOS' },
    { style: 1, color: 0xa8adb4, roughness: 0.18, metalness: 1.0, label: 'ARGENTO' },
  ],
  paints: [
    { name: 'Blu Laufey', color: 0x1638b8, metalness: 0.56, roughness: 0.22, flake: 0.9 },
    { name: 'Arancio California', color: 0xff7a00, metalness: 0.40, roughness: 0.24, flake: 0.5 },
    { name: 'Verde Citrea', color: 0xa8e60a, metalness: 0.36, roughness: 0.26, flake: 0.4 },
    { name: 'Bianco Asopo', color: 0xf1f4f7, metalness: 0.20, roughness: 0.26, flake: 0.3 },
    { name: 'Grigio Lynx', color: 0x4a5058, metalness: 0.74, roughness: 0.26, flake: 1.0 },
    { name: 'Rosso Mars', color: 0xc2110f, metalness: 0.50, roughness: 0.22, flake: 0.7 },
    { name: 'Nero Helene', color: 0x0b0d11, metalness: 0.62, roughness: 0.19, flake: 0.6 },
  ],
  ratings: { power: 0.82, handling: 0.94, brakes: 0.95, aero: 0.97 },
  parts(model) {
    huracanCommonParts(model, { exhaust: false });
    const g = model.group;
    const carbon = M.carbonFibre({ scale: 1.9 });

    /* roof snorkel feeding the airbox */
    const snorkPath = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      snorkPath.push({
        x: 0,
        y: 1.152 - Math.pow(t, 1.7) * 0.10,
        z: -0.10 - t * 1.02,
        scaleX: 1 - t * 0.18,
        scaleY: 1 + t * 0.28,
      });
    }
    const snork = new THREE.Mesh(
      sweepProfile(rectProfile(0.30, 0.085, 0.035, 3), snorkPath, { closed: true, cap: true }),
      carbon
    );
    snork.castShadow = true;
    g.add(snork);
    const intake = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.075), M.matteBlack(0.95, 0x030406));
    intake.position.set(0, 1.152, -0.09);
    g.add(intake);

    /* shark fin along the engine cover */
    const finShape = new THREE.Shape();
    finShape.moveTo(-0.62, 0);
    finShape.lineTo(0.42, 0);
    finShape.quadraticCurveTo(0.30, 0.20, -0.06, 0.235);
    finShape.quadraticCurveTo(-0.42, 0.24, -0.62, 0.06);
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, {
      depth: 0.038, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.008, bevelSegments: 1,
    });
    finGeo.rotateY(Math.PI / 2);
    const fin = new THREE.Mesh(finGeo, carbon);
    fin.position.set(0.019, 0.985, -1.34);
    fin.castShadow = true;
    g.add(fin);

    /* swan-neck rear wing */
    g.add(rearWing({
      span: 1.66, chord: 0.32, thickness: 0.095, camber: 0.06, aoa: -0.24,
      y: 1.145, z: -1.99, riser: 0.30, swanNeck: true,
      endplateH: 0.34, endplateL: 0.46, material: carbon, gurney: true,
    }));

    /* cofango bonnet duct */
    const duct = new THREE.Mesh(roundedBox(0.62, 0.05, 0.44, 0.03, 2), M.matteBlack(0.95, 0x05070a));
    duct.position.set(0, 0.815, 1.32);
    duct.rotation.x = -0.10;
    g.add(duct);
    const ductLip = new THREE.Mesh(roundedBox(0.70, 0.035, 0.09, 0.015, 2), carbon);
    ductLip.position.set(0, 0.845, 1.10);
    g.add(ductLip);

    /* dive planes */
    for (const s of [-1, 1]) {
      for (let i = 0; i < 2; i++) {
        const plane = new THREE.Mesh(roundedBox(0.24, 0.014, 0.13, 0.007, 1), carbon);
        plane.position.set(s * 0.90, 0.40 + i * 0.10, 1.86 - i * 0.05);
        plane.rotation.z = s * 0.26;
        plane.rotation.y = -s * 0.10;
        g.add(plane);
      }
    }

    /* single centre exhaust exit, high mounted */
    g.add(exhaustTips({ count: 2, spacing: 0.17, r: 0.062, y: 0.655, z: -2.055, hex: true, length: 0.17 }));

    /* rear crash-structure vents */
    for (const s of [-1, 1]) {
      const vent = meshPanel(0.26, 0.14, { cells: 5, depth: 0.018 });
      vent.position.set(s * 0.60, 0.44, -2.06);
      g.add(vent);
    }

    /* tow hook */
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.014, 8, 14), M.metal({ color: 0xe2b60c, roughness: 0.3 }));
    hook.position.set(0.62, 0.36, 2.07);
    hook.rotation.y = Math.PI / 2;
    g.add(hook);
  },
  phys: {
    mass: 1450, cgHeight: 0.41, cgBias: 0.41,
    inertiaYaw: 1980,
    drivetrain: 'rwd', rearBias: 1.0,
    idleRpm: 1000, redline: 8500, limiter: 8700,
    peakTorque: 565, peakTorqueRpm: 6500, peakPowerRpm: 8000, peakPowerKw: 470,
    gears: [3.13, 2.17, 1.55, 1.19, 0.94, 0.78, 0.65], finalDrive: 4.05, reverse: 2.90,
    shiftTime: 0.07, clutchTime: 0.11,
    dragCd: 0.39, frontalArea: 1.96, liftFront: -0.46, liftRear: -0.88,
    brakeTorqueFront: 4400, brakeTorqueRear: 2400,
    tyreGripFront: 1.78, tyreGripRear: 1.86,
    steerMaxDeg: 32, steerSpeedFalloff: 0.66, rearSteer: 0.16,
    springFront: 78000, springRear: 88000, damperFront: 6400, damperRear: 7000,
    travel: 0.095, rideHeight: 0.095,
    arbFront: 19000, arbRear: 15000,
    engineInertia: 0.21, engineBrake: 30,
    topSpeed: 86.1,
  },
  ui: { power: 640, accel: 3.0, topSpeed: 310, mass: 1339 },
  audio: { cylinders: 10, firingHarmonics: [1, 2, 2.5, 3, 5, 7.5, 10], character: 'v10-race', idleTone: 0.62 },
};

export const CARS = [HURACAN_EVO, ZONDA_HP_BARCHETTA, HURACAN_STO];
export default CARS;
