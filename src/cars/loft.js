/**
 * Cross-section lofting.
 *
 * A car body is described as a series of *stations* along Z. Each station is
 * a handful of scalars (width, floor height, roof height, shoulder line,
 * corner sharpness) rather than raw vertices, so the shapes stay editable and
 * the surface between stations is a Catmull–Rom spline — which is what makes
 * the result read as a smooth panel instead of a faceted box.
 *
 * On top of that:
 *   • wheel arches are cut by lifting the lower body onto an arc,
 *   • glass / trim / carbon regions are tagged in (station, ring) parameter
 *     space and emitted as separate geometry groups, so one mesh renders the
 *     whole body with four materials and four draw calls.
 */
import * as THREE from 'three';
import { catmullRom, clamp, clamp01, lerp, smoothstep } from '../core/util.js';

/** Default station shape — every field is optional in a car definition. */
const STATION_DEFAULTS = {
  z: 0,
  halfWidth: 0.9,     // widest half-width of the section (at the shoulder)
  bottomWidth: 0.6,   // half-width of the flat floor
  beltWidth: 0.78,    // half-width at the belt line (door top / deck edge)
  topWidth: 0.5,      // half-width of the flat top (roof / hood / deck)
  floorY: 0.12,       // underside height
  shoulderY: 0.55,    // height of the widest point
  beltY: 0.80,        // height of the belt line
  topY: 1.0,          // top surface height
  lowerN: 2.6,        // superellipse exponent, floor edge → shoulder
  sideN: 3.4,         // shoulder → belt (the door surface; high = crisp)
  upperN: 2.2,        // belt → top edge (the greenhouse)
  linLower: 0.15,     // 0 = pure superellipse, 1 = straight line
  linSide: 0.72,
  linUpper: 0.20,
  fFloor: 0.085,      // ring fractions; the remainder is the flat top
  fLower: 0.255,
  fSide: 0.235,
  fUpper: 0.285,
};

function mixStations(a, b, c, d, t) {
  const out = {};
  for (const k of Object.keys(STATION_DEFAULTS)) {
    out[k] = catmullRom(a[k], b[k], c[k], d[k], t);
  }
  return out;
}

function fillStation(s) {
  const out = { ...STATION_DEFAULTS, ...s };
  // Derive the belt line when a definition does not state one explicitly.
  if (s.beltY === undefined) out.beltY = lerp(out.shoulderY, out.topY, 0.55);
  if (s.beltWidth === undefined) out.beltWidth = lerp(out.topWidth, out.halfWidth, 0.55);
  return out;
}

/**
 * Half-section outline. v runs 0 → 1 from the bottom centreline, out around
 * the side, over the top, back to the top centreline.
 */
function sectionPoint(S, v, out) {
  const { fFloor, fLower, fSide, fUpper } = S;
  const fTop = Math.max(0.02, 1 - fFloor - fLower - fSide - fUpper);

  let x, y;
  if (v <= fFloor) {
    // flat underside
    const t = fFloor <= 0 ? 1 : v / fFloor;
    x = S.bottomWidth * t;
    y = S.floorY;
  } else if (v <= fFloor + fLower) {
    // lower flank: floor edge bulges out to the shoulder
    const t = (v - fFloor) / fLower;
    const u = t * Math.PI * 0.5;
    const p = 2 / Math.max(0.4, S.lowerN);
    const ex = Math.pow(Math.sin(u), p);
    const ey = 1 - Math.pow(Math.cos(u), p);
    x = lerp(S.bottomWidth, S.halfWidth, lerp(ex, t, S.linLower));
    y = lerp(S.floorY, S.shoulderY, lerp(ey, t, S.linLower));
  } else if (v <= fFloor + fLower + fSide) {
    // door surface: shoulder → belt line, close to straight for a crisp flank
    const t = (v - fFloor - fLower) / fSide;
    const u = t * Math.PI * 0.5;
    const p = 2 / Math.max(0.4, S.sideN);
    const ex = 1 - Math.pow(Math.cos(u), p);
    const ey = Math.pow(Math.sin(u), p);
    x = lerp(S.halfWidth, S.beltWidth, lerp(ex, t, S.linSide));
    y = lerp(S.shoulderY, S.beltY, lerp(ey, t, S.linSide));
  } else if (v <= fFloor + fLower + fSide + fUpper) {
    // greenhouse: belt line → roof edge
    const t = (v - fFloor - fLower - fSide) / fUpper;
    const u = t * Math.PI * 0.5;
    const p = 2 / Math.max(0.4, S.upperN);
    const ex = 1 - Math.pow(Math.cos(u), p);
    const ey = Math.pow(Math.sin(u), p);
    x = lerp(S.beltWidth, S.topWidth, lerp(ex, t, S.linUpper));
    y = lerp(S.beltY, S.topY, lerp(ey, t, S.linUpper));
  } else {
    // flat top
    const t = clamp01((v - fFloor - fLower - fSide - fUpper) / fTop);
    x = S.topWidth * (1 - t);
    y = S.topY;
  }
  out.x = x; out.y = y;
  return out;
}

/**
 * Wheel-arch cut: lifts body vertices that fall inside an arch onto the arch
 * arc, which opens a wheel well and leaves a fender lip around it.
 */
function applyArches(x, y, z, arches) {
  let ny = y;
  for (const a of arches) {
    const dz = z - a.z;
    if (Math.abs(dz) >= a.r) continue;
    // A narrow blend keeps the arch edge crisp: the panel drops almost
    // vertically into the well instead of funnelling into it.
    const blend = a.blend ?? 0.05;
    const side = smoothstep(a.innerX, a.innerX + blend, Math.abs(x));
    if (side <= 0) continue;
    const arcY = a.y + Math.sqrt(Math.max(0, a.r * a.r - dz * dz)) * (a.squash ?? 1);
    if (ny < arcY) ny = lerp(ny, arcY, side);
  }
  return ny;
}

/**
 * @param {object} opts
 * @param {Array}  opts.stations   ordered nose → tail
 * @param {number} opts.ringSegments   samples per half-section
 * @param {number} opts.zSegments      resampled sections along the body
 * @param {Array}  opts.arches         [{ z, y, r, innerX, squash }]
 * @param {Array}  opts.patches        [{ u0, u1, v0, v1, mat, mirror }]
 * @param {number} opts.materials      how many material slots to emit
 * @returns {THREE.BufferGeometry}
 */
export function buildLoft(opts) {
  const {
    stations: rawStations,
    ringSegments = 34,
    zSegments = 110,
    arches = [],
    patches = [],
    materials = 4,
    capFront = true,
    capRear = true,
    smoothAngle = 42,
  } = opts;

  const St = rawStations.map(fillStation);
  const n = St.length;
  const at = (i) => St[clamp(i, 0, n - 1)];

  const H = ringSegments + 1;           // points across one half, both ends on the centreline
  const RING = 2 * H - 2;               // full closed ring
  const ROWS = zSegments + 1;

  const positions = new Float32Array(ROWS * RING * 3);
  const uvs = new Float32Array(ROWS * RING * 2);
  const rowU = new Float32Array(ROWS);
  const rowZ = new Float32Array(ROWS);

  const p = { x: 0, y: 0 };
  let vi = 0, ti = 0;

  for (let r = 0; r < ROWS; r++) {
    const u = r / zSegments;
    rowU[r] = u;

    // spline the station parameters
    const f = u * (n - 1);
    const i = Math.min(n - 2, Math.floor(f));
    const t = f - i;
    const S = mixStations(at(i - 1), at(i), at(i + 1), at(i + 2), t);
    rowZ[r] = S.z;

    for (let k = 0; k < RING; k++) {
      // map ring index → half parameter v, mirroring the second half
      let v, mirror;
      if (k < H) { v = k / ringSegments; mirror = false; }
      else { v = (RING - k) / ringSegments; mirror = true; }

      sectionPoint(S, v, p);
      let x = mirror ? -p.x : p.x;
      const y = applyArches(x, p.y, S.z, arches);

      positions[vi] = x;
      positions[vi + 1] = y;
      positions[vi + 2] = S.z;
      vi += 3;

      uvs[ti] = u;
      uvs[ti + 1] = mirror ? 1 - v * 0.5 : v * 0.5;
      ti += 2;
    }
  }

  /* ── material lookup in (u, v) parameter space ── */
  const matAt = (u, v, mirrored) => {
    for (let i = patches.length - 1; i >= 0; i--) {
      const q = patches[i];
      if (q.side === 'left' && !mirrored) continue;
      if (q.side === 'right' && mirrored) continue;
      if (u >= q.u0 && u <= q.u1 && v >= q.v0 && v <= q.v1) return q.mat;
    }
    return 0;
  };

  /* ── triangles bucketed by material ── */
  const buckets = Array.from({ length: materials }, () => []);

  for (let r = 0; r < ROWS - 1; r++) {
    const u = (rowU[r] + rowU[r + 1]) * 0.5;
    const a0 = r * RING;
    const b0 = (r + 1) * RING;
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      const kMid = k + 0.5;
      const mirrored = kMid >= H - 0.5;
      const v = mirrored ? (RING - kMid) / ringSegments : kMid / ringSegments;
      const m = clamp(matAt(u, v, mirrored), 0, materials - 1);
      const A = a0 + k, B = a0 + k2, C = b0 + k2, D = b0 + k;
      // Rings advance toward -Z while the ring index advances +X at the
      // floor, so this winding is the one that puts normals outward.
      buckets[m].push(A, C, B, A, D, C);
    }
  }

  /* ── end caps: fan each terminal ring to its centroid ── */
  const extra = [];
  const addCap = (row, flip) => {
    const base = row * RING;
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < RING; k++) {
      cx += positions[(base + k) * 3];
      cy += positions[(base + k) * 3 + 1];
      cz += positions[(base + k) * 3 + 2];
    }
    cx /= RING; cy /= RING; cz /= RING;
    const centerIndex = ROWS * RING + extra.length / 5;
    extra.push(cx, cy, cz, row === 0 ? 0 : 1, 0.5);
    for (let k = 0; k < RING; k++) {
      const k2 = (k + 1) % RING;
      if (flip) buckets[0].push(centerIndex, base + k, base + k2);
      else buckets[0].push(centerIndex, base + k2, base + k);
    }
  };
  if (capFront) addCap(0, true);
  if (capRear) addCap(ROWS - 1, false);

  /* ── assemble ── */
  const extraCount = extra.length / 5;
  const posArr = new Float32Array((ROWS * RING + extraCount) * 3);
  const uvArr = new Float32Array((ROWS * RING + extraCount) * 2);
  posArr.set(positions, 0);
  uvArr.set(uvs, 0);
  for (let i = 0; i < extraCount; i++) {
    posArr[(ROWS * RING + i) * 3] = extra[i * 5];
    posArr[(ROWS * RING + i) * 3 + 1] = extra[i * 5 + 1];
    posArr[(ROWS * RING + i) * 3 + 2] = extra[i * 5 + 2];
    uvArr[(ROWS * RING + i) * 2] = extra[i * 5 + 3];
    uvArr[(ROWS * RING + i) * 2 + 1] = extra[i * 5 + 4];
  }

  const total = buckets.reduce((s, b) => s + b.length, 0);
  const IndexArray = (ROWS * RING + extraCount) > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(total);
  const geo = new THREE.BufferGeometry();
  let off = 0;
  for (let m = 0; m < materials; m++) {
    const b = buckets[m];
    if (!b.length) continue;
    indices.set(b, off);
    geo.addGroup(off, b.length, m);
    off += b.length;
  }

  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  void smoothAngle;
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/* ═══════════════════════ helper geometry ═══════════════════════ */

/** Rounded box built from a subdivided cube pushed onto a superellipsoid. */
export function roundedBox(w, h, d, radius = 0.06, seg = 3) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const pos = g.attributes.position;
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const r = Math.min(radius, hw, hh, hd);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = clamp(v.x, -(hw - r), hw - r);
    const cy = clamp(v.y, -(hh - r), hh - r);
    const cz = clamp(v.z, -(hd - r), hd - r);
    const dx = v.x - cx, dy = v.y - cy, dz = v.z - cz;
    const len = Math.hypot(dx, dy, dz) || 1;
    pos.setXYZ(i, cx + (dx / len) * r, cy + (dy / len) * r, cz + (dz / len) * r);
  }
  g.computeVertexNormals();
  return g;
}

/**
 * Sweep a 2D profile along a list of 3D stations — used for wings, splitters,
 * diffuser fins and roll-cage tubes.
 */
export function sweepProfile(profile, path, { closed = false, cap = true } = {}) {
  const P = profile.length;
  const N = path.length;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  const up = new THREE.Vector3(0, 1, 0);
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();

  for (let i = 0; i < N; i++) {
    const cur = path[i];
    const nxt = path[Math.min(N - 1, i + 1)];
    const prv = path[Math.max(0, i - 1)];
    tangent.set(nxt.x - prv.x, nxt.y - prv.y, nxt.z - prv.z).normalize();
    if (tangent.lengthSq() < 1e-6) tangent.set(0, 0, 1);
    binormal.crossVectors(up, tangent);
    if (binormal.lengthSq() < 1e-6) binormal.set(1, 0, 0);
    binormal.normalize();
    normal.crossVectors(tangent, binormal).normalize();

    const sx = cur.scaleX ?? 1;
    const sy = cur.scaleY ?? 1;
    for (let j = 0; j < P; j++) {
      const pp = profile[j];
      positions.push(
        cur.x + binormal.x * pp.x * sx + normal.x * pp.y * sy,
        cur.y + binormal.y * pp.x * sx + normal.y * pp.y * sy,
        cur.z + binormal.z * pp.x * sx + normal.z * pp.y * sy
      );
      normals.push(0, 0, 0);
      uvs.push(i / (N - 1), j / (P - 1));
    }
  }

  const wrap = closed ? P : P - 1;
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < wrap; j++) {
      const j2 = (j + 1) % P;
      const a = i * P + j, b = i * P + j2, c = (i + 1) * P + j2, d = (i + 1) * P + j;
      indices.push(a, b, c, a, c, d);
    }
  }

  if (cap && closed) {
    for (const [row, flip] of [[0, true], [N - 1, false]]) {
      const base = row * P;
      const ci = positions.length / 3;
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < P; j++) {
        cx += positions[(base + j) * 3];
        cy += positions[(base + j) * 3 + 1];
        cz += positions[(base + j) * 3 + 2];
      }
      positions.push(cx / P, cy / P, cz / P);
      normals.push(0, 0, 0);
      uvs.push(row / (N - 1), 0.5);
      for (let j = 0; j < P; j++) {
        const j2 = (j + 1) % P;
        if (flip) indices.push(ci, base + j2, base + j);
        else indices.push(ci, base + j, base + j2);
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  void normals;
  return g;
}

/** A closed aerofoil outline (NACA-ish) for wings and splitter blades. */
export function aerofoilProfile(chord = 1, thickness = 0.12, camber = 0.03, samples = 20) {
  const pts = [];
  const yt = (x) => 5 * thickness * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);
  const yc = (x) => camber * (x < 0.4 ? (2 * 0.4 * x - x * x) / 0.16 : ((1 - 2 * 0.4) + 2 * 0.4 * x - x * x) / 0.36);
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    pts.push({ x: (x - 0.5) * chord, y: (yc(x) + yt(x)) * chord });
  }
  for (let i = samples - 1; i > 0; i--) {
    const x = i / samples;
    pts.push({ x: (x - 0.5) * chord, y: (yc(x) - yt(x)) * chord });
  }
  return pts;
}

/** Simple rounded-rectangle profile for tubes and trim strips. */
export function rectProfile(w, h, r = 0, seg = 3) {
  if (r <= 0) {
    return [{ x: -w / 2, y: -h / 2 }, { x: w / 2, y: -h / 2 }, { x: w / 2, y: h / 2 }, { x: -w / 2, y: h / 2 }];
  }
  const pts = [];
  const corners = [
    [w / 2 - r, -h / 2 + r, -Math.PI / 2],
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
  }
  return pts;
}

/** Circular profile for exhaust tips and roll bars. */
export function circleProfile(radius, seg = 16) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * radius, y: Math.sin(a) * radius });
  }
  return pts;
}

/** Merge a list of geometries that all use the same material. */
export function mergeGeometries(list) {
  let vCount = 0, iCount = 0;
  for (const g of list) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const IndexArray = vCount > 65535 ? Uint32Array : Uint16Array;
  const idx = new IndexArray(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const gp = g.attributes.position;
    const gn = g.attributes.normal;
    const gu = g.attributes.uv;
    pos.set(gp.array.subarray(0, gp.count * 3), vo * 3);
    if (gn) nor.set(gn.array.subarray(0, gn.count * 3), vo * 3);
    if (gu) uv.set(gu.array.subarray(0, gu.count * 2), vo * 2);
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < gp.count; i++) idx[io + i] = i + vo;
      io += gp.count;
    }
    vo += gp.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* ═══════════════════ surface queries ═══════════════════ */

/** Spline the station parameters at normalised position u ∈ [0,1]. */
export function stationAtU(stations, u) {
  const St = stations.map(fillStation);
  const n = St.length;
  const at = (i) => St[clamp(i, 0, n - 1)];
  const f = clamp01(u) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  return mixStations(at(i - 1), at(i), at(i + 1), at(i + 2), f - i);
}

/** Find the u whose splined station sits at world z (stations run +z → −z). */
export function uAtZ(stations, z) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) * 0.5;
    if (stationAtU(stations, mid).z > z) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Point on the body surface at world z and ring parameter v.
 * Lets a car definition bolt lamps and mirrors onto the actual panel
 * instead of guessing coordinates that end up floating in mid-air.
 */
export function surfacePoint(stations, z, v, arches = null) {
  const S = stationAtU(stations, uAtZ(stations, z));
  const p = { x: 0, y: 0 };
  sectionPoint(S, clamp01(v), p);
  const y = arches ? applyArches(p.x, p.y, S.z, arches) : p.y;
  return { x: p.x, y, z: S.z, station: S };
}

/** Outward surface normal in the section plane, for orienting attachments. */
export function surfaceNormal(stations, z, v, eps = 0.012) {
  const a = surfacePoint(stations, z, Math.max(0, v - eps));
  const b = surfacePoint(stations, z, Math.min(1, v + eps));
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dy / len, y: -dx / len };
}
