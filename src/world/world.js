/**
 * The world: a closed mountain circuit cut into procedural terrain, with a
 * city district, a drift plaza, barriers, lighting and props.
 *
 * Everything the physics needs is answered from one rasterised attribute grid
 * (height / surface type / nearest track sample), so a surface query is a
 * bilinear fetch instead of a mesh raycast.
 */
import * as THREE from 'three';
import {
  clamp, clamp01, lerp, makeRng, makeNoise2D, fbm, TAU, smoothstep,
} from '../core/util.js';

const SURF = { GRASS: 0, ASPHALT: 1, KERB: 2, SHOULDER: 3, SAND: 4, PLAZA: 5 };
const SURF_GRIP = [0.56, 1.0, 0.94, 0.86, 0.44, 0.98];
const SURF_ROUGH = [0.7, 0.03, 0.55, 0.22, 0.9, 0.02];

export class World {
  constructor(preset, opts = {}) {
    this.preset = preset;
    this.root = new THREE.Group();
    this.root.name = 'world';

    this.extent = 1700;                 // metres across, centred on the origin
    this.cell = 4;
    this.gridN = Math.round(this.extent / this.cell);
    this.half = this.extent / 2;

    this.height = new Float32Array(this.gridN * this.gridN);
    this.type = new Uint8Array(this.gridN * this.gridN);
    this.nearest = new Int32Array(this.gridN * this.gridN).fill(-1);

    this.trackWidth = opts.trackWidth ?? 13.5;
    this.seed = opts.seed ?? 20260904;
    this.rng = makeRng(this.seed);
    this.noise = makeNoise2D(this.seed);
    this.noise2 = makeNoise2D(this.seed + 991);

    this.samples = [];                  // dense centreline samples
    this.trackLength = 0;
    this.barriers = [];                 // { a, b, n, len } wall segments
    this.boxes = [];                    // building AABBs
    this._segGrid = null;
    this.nightLights = [];
    this._surfOut = { y: 0, normal: new THREE.Vector3(0, 1, 0), grip: 1, roughness: 0, type: 'asphalt' };
    this._tmp = new THREE.Vector3();
  }

  /* ═══════════════ generation ═══════════════ */

  build() {
    this.buildCentreline();
    this.buildTerrainField();
    this.stampTrack();
    this.stampPlaza();
    this.smoothField(2);
    this.buildTerrainMesh();
    this.buildRoadMesh();
    this.buildKerbs();
    this.buildBarriers();
    this.buildCity();
    this.buildProps();
    this.buildStartGantry();
    this.buildSegmentIndex();
    return this;
  }

  /** A star-shaped closed loop: varied corners, guaranteed not to cross itself. */
  buildCentreline() {
    const CP = 30;
    const ctrl = [];
    for (let i = 0; i < CP; i++) {
      const a = (i / CP) * TAU;
      const r = 268 * (1
        + 0.34 * Math.sin(3 * a + 0.42)
        + 0.17 * Math.sin(5 * a + 1.73)
        - 0.11 * Math.cos(2 * a - 0.6)
        + 0.06 * Math.sin(7 * a + 3.1));
      const y = 15.5 * Math.sin(2 * a + 0.7) + 7.5 * Math.sin(4 * a + 2.2) - 3 * Math.cos(a);
      ctrl.push(new THREE.Vector3(Math.cos(a) * r * 1.28, y, Math.sin(a) * r));
    }
    this.controlPoints = ctrl;
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal', 0.5);
    this.curve = curve;

    const approxLen = curve.getLength();
    const count = Math.max(600, Math.round(approxLen / 2.0));
    const pts = curve.getSpacedPoints(count);
    this.trackLength = approxLen;

    // tangents, normals and banking from local curvature
    const n = pts.length - 1;             // last point duplicates the first
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const pPrev = pts[(i - 1 + n) % n];
      const pNext = pts[(i + 1) % n];
      const tan = new THREE.Vector3().subVectors(pNext, pPrev).normalize();
      const lat = new THREE.Vector3(-tan.z, 0, tan.x).normalize();

      // signed curvature in the XZ plane
      const d1x = pNext.x - p.x, d1z = pNext.z - p.z;
      const d0x = p.x - pPrev.x, d0z = p.z - pPrev.z;
      const cross = d0x * d1z - d0z * d1x;
      const segLen = Math.hypot(d0x, d0z) || 1;
      const curvature = cross / (segLen * segLen * segLen + 1e-6);

      this.samples.push({
        i,
        pos: p,
        tan,
        lat,
        curvature,
        bank: clamp(curvature * 320, -0.16, 0.16),
        s: (i / n) * approxLen,
        t: i / n,
      });
    }
    // smooth banking so it eases in and out of corners
    for (let pass = 0; pass < 6; pass++) {
      const b = this.samples.map((v) => v.bank);
      for (let i = 0; i < this.samples.length; i++) {
        const a = b[(i - 1 + b.length) % b.length];
        const c = b[(i + 1) % b.length];
        this.samples[i].bank = (a + c + b[i] * 2) / 4;
      }
    }
    this.startSample = 0;
    this.startPos = this.samples[0].pos.clone();
    this.startDir = this.samples[0].tan.clone();
  }

  idx(ix, iz) { return iz * this.gridN + ix; }
  worldToGrid(x) { return (x + this.half) / this.cell; }
  gridToWorld(i) { return i * this.cell - this.half; }

  buildTerrainField() {
    const { gridN } = this;
    for (let iz = 0; iz < gridN; iz++) {
      for (let ix = 0; ix < gridN; ix++) {
        const x = this.gridToWorld(ix);
        const z = this.gridToWorld(iz);
        const r = Math.hypot(x / 1.28, z);
        // hills swell outside the circuit and settle inside it
        const outside = smoothstep(230, 520, r);
        const inside = 1 - smoothstep(60, 200, r);
        let h = fbm(this.noise, x / 420, z / 420, 5, 2.1, 0.52) * 34;
        h += fbm(this.noise2, x / 95, z / 95, 3, 2.3, 0.5) * 4.5;
        h = h * (0.30 + outside * 1.35) - inside * 5;
        h += outside * outside * 46;
        this.height[this.idx(ix, iz)] = h;
        this.type[this.idx(ix, iz)] = SURF.GRASS;
      }
    }
  }

  /** Burn the track corridor into the height field. */
  stampTrack() {
    const halfW = this.trackWidth / 2;
    const shoulder = 7.5;
    const blend = 22;
    const reach = halfW + shoulder + blend;
    const cellsReach = Math.ceil(reach / this.cell);

    for (const sm of this.samples) {
      const cx = this.worldToGrid(sm.pos.x);
      const cz = this.worldToGrid(sm.pos.z);
      const i0 = Math.max(0, Math.floor(cx - cellsReach));
      const i1 = Math.min(this.gridN - 1, Math.ceil(cx + cellsReach));
      const j0 = Math.max(0, Math.floor(cz - cellsReach));
      const j1 = Math.min(this.gridN - 1, Math.ceil(cz + cellsReach));

      for (let iz = j0; iz <= j1; iz++) {
        for (let ix = i0; ix <= i1; ix++) {
          const x = this.gridToWorld(ix);
          const z = this.gridToWorld(iz);
          const dx = x - sm.pos.x, dz = z - sm.pos.z;
          const along = dx * sm.tan.x + dz * sm.tan.z;
          if (Math.abs(along) > this.cell * 1.6) continue;   // only the local slab
          const lateral = dx * sm.lat.x + dz * sm.lat.z;
          const d = Math.abs(lateral);
          if (d > reach) continue;

          const k = this.idx(ix, iz);
          if (this.nearest[k] < 0 || d < this._nearestDist(k, x, z)) this.nearest[k] = sm.i;

          const roadY = sm.pos.y + lateral * Math.sin(sm.bank);
          if (d <= halfW) {
            this.height[k] = roadY;
            this.type[k] = SURF.ASPHALT;
          } else if (d <= halfW + shoulder) {
            const t = (d - halfW) / shoulder;
            this.height[k] = roadY - t * 0.09;
            if (this.type[k] !== SURF.ASPHALT) this.type[k] = SURF.SHOULDER;
          } else {
            const t = smoothstep(0, 1, (d - halfW - shoulder) / blend);
            const terrain = this.height[k];
            this.height[k] = lerp(roadY - 0.10, terrain, t);
            if (this.type[k] === SURF.GRASS && t < 0.4) this.type[k] = SURF.SHOULDER;
          }
        }
      }
    }

    // widen the nearest-sample field so lap logic works off the racing line too
    for (const sm of this.samples) {
      const cellsWide = Math.ceil(70 / this.cell);
      const cx = Math.round(this.worldToGrid(sm.pos.x));
      const cz = Math.round(this.worldToGrid(sm.pos.z));
      for (let iz = Math.max(0, cz - cellsWide); iz <= Math.min(this.gridN - 1, cz + cellsWide); iz++) {
        for (let ix = Math.max(0, cx - cellsWide); ix <= Math.min(this.gridN - 1, cx + cellsWide); ix++) {
          const k = this.idx(ix, iz);
          if (this.nearest[k] >= 0) continue;
          this.nearest[k] = sm.i;
        }
      }
    }
  }

  _nearestDist(k, x, z) {
    const s = this.samples[this.nearest[k]];
    if (!s) return Infinity;
    return Math.hypot(x - s.pos.x, z - s.pos.z);
  }

  /** A flat asphalt plaza inside the loop for drifting and parking practice. */
  stampPlaza() {
    this.plaza = { x: 40, z: -30, w: 190, d: 160, y: 0 };
    const P = this.plaza;
    let sumY = 0, n = 0;
    for (const sm of this.samples) { sumY += sm.pos.y; n++; }
    P.y = sumY / n - 8;

    const i0 = Math.max(0, Math.floor(this.worldToGrid(P.x - P.w / 2 - 26)));
    const i1 = Math.min(this.gridN - 1, Math.ceil(this.worldToGrid(P.x + P.w / 2 + 26)));
    const j0 = Math.max(0, Math.floor(this.worldToGrid(P.z - P.d / 2 - 26)));
    const j1 = Math.min(this.gridN - 1, Math.ceil(this.worldToGrid(P.z + P.d / 2 + 26)));
    for (let iz = j0; iz <= j1; iz++) {
      for (let ix = i0; ix <= i1; ix++) {
        const x = this.gridToWorld(ix), z = this.gridToWorld(iz);
        const dx = Math.abs(x - P.x) - P.w / 2;
        const dz = Math.abs(z - P.z) - P.d / 2;
        const d = Math.max(dx, dz);
        const k = this.idx(ix, iz);
        if (d <= 0) {
          this.height[k] = P.y;
          this.type[k] = SURF.PLAZA;
        } else if (d < 26) {
          const t = smoothstep(0, 1, d / 26);
          this.height[k] = lerp(P.y, this.height[k], t);
        }
      }
    }

    // an access ribbon from the plaza out to the circuit
    const link = this.samples[Math.floor(this.samples.length * 0.5)];
    this.plazaLink = link;
    const steps = 90;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = lerp(P.x + P.w / 2 - 6, link.pos.x, smoothstep(0, 1, t));
      const z = lerp(P.z, link.pos.z, smoothstep(0, 1, t));
      const y = lerp(P.y, link.pos.y, smoothstep(0, 1, t));
      const w = 9;
      const c = Math.ceil((w + 10) / this.cell);
      const gx = Math.round(this.worldToGrid(x)), gz = Math.round(this.worldToGrid(z));
      for (let jz = Math.max(0, gz - c); jz <= Math.min(this.gridN - 1, gz + c); jz++) {
        for (let jx = Math.max(0, gx - c); jx <= Math.min(this.gridN - 1, gx + c); jx++) {
          const d = Math.hypot(this.gridToWorld(jx) - x, this.gridToWorld(jz) - z);
          const k = this.idx(jx, jz);
          if (d <= w) {
            this.height[k] = y;
            if (this.type[k] === SURF.GRASS) this.type[k] = SURF.PLAZA;
          } else if (d < w + 10) {
            const s2 = smoothstep(0, 1, (d - w) / 10);
            this.height[k] = lerp(y, this.height[k], s2);
          }
        }
      }
    }
  }

  /** Box-blur the terrain outside the driving surfaces to kill stair-stepping. */
  smoothField(passes = 1) {
    const { gridN } = this;
    const tmp = new Float32Array(this.height.length);
    for (let p = 0; p < passes; p++) {
      tmp.set(this.height);
      for (let iz = 1; iz < gridN - 1; iz++) {
        for (let ix = 1; ix < gridN - 1; ix++) {
          const k = this.idx(ix, iz);
          if (this.type[k] === SURF.ASPHALT || this.type[k] === SURF.PLAZA) continue;
          this.height[k] = (
            tmp[k] * 4 +
            tmp[k - 1] + tmp[k + 1] + tmp[k - gridN] + tmp[k + gridN]
          ) / 8;
        }
      }
    }
  }

  /* ═══════════════ surface queries ═══════════════ */

  rawHeight(x, z) {
    const gx = clamp(this.worldToGrid(x), 0, this.gridN - 1.001);
    const gz = clamp(this.worldToGrid(z), 0, this.gridN - 1.001);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const h00 = this.height[this.idx(ix, iz)];
    const h10 = this.height[this.idx(ix + 1, iz)];
    const h01 = this.height[this.idx(ix, iz + 1)];
    const h11 = this.height[this.idx(ix + 1, iz + 1)];
    return lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz);
  }

  typeAt(x, z) {
    const ix = clamp(Math.round(this.worldToGrid(x)), 0, this.gridN - 1);
    const iz = clamp(Math.round(this.worldToGrid(z)), 0, this.gridN - 1);
    return this.type[this.idx(ix, iz)];
  }

  /** Height, normal, grip and surface class at a world position. */
  surfaceAt(x, z) {
    const out = this._surfOut;
    const y = this.rawHeight(x, z);
    const e = this.cell;
    const hx = this.rawHeight(x + e, z) - this.rawHeight(x - e, z);
    const hz = this.rawHeight(x, z + e) - this.rawHeight(x, z - e);
    out.normal.set(-hx, 2 * e, -hz).normalize();
    out.y = y;
    const t = this.typeAt(x, z);
    out.grip = SURF_GRIP[t];
    out.roughness = SURF_ROUGH[t];
    out.type = t === SURF.GRASS ? 'grass' : t === SURF.SAND ? 'sand' : t === SURF.KERB ? 'kerb' : 'asphalt';
    out.surfIndex = t;
    return out;
  }

  /** Track position: normalised lap progress plus signed lateral offset. */
  trackProgress(x, z) {
    const ix = clamp(Math.round(this.worldToGrid(x)), 0, this.gridN - 1);
    const iz = clamp(Math.round(this.worldToGrid(z)), 0, this.gridN - 1);
    let si = this.nearest[this.idx(ix, iz)];
    if (si < 0) si = 0;
    // refine over the neighbouring samples
    let best = si, bestD = Infinity;
    const n = this.samples.length;
    for (let d = -6; d <= 6; d++) {
      const j = ((si + d) % n + n) % n;
      const s = this.samples[j];
      const dd = (s.pos.x - x) ** 2 + (s.pos.z - z) ** 2;
      if (dd < bestD) { bestD = dd; best = j; }
    }
    const s = this.samples[best];
    const dx = x - s.pos.x, dz = z - s.pos.z;
    return {
      index: best,
      t: s.t,
      lateral: dx * s.lat.x + dz * s.lat.z,
      dir: s.tan,
      sample: s,
      distance: Math.sqrt(bestD),
    };
  }

  /* ═══════════════ collision ═══════════════ */

  buildSegmentIndex() {
    const cellSize = 24;
    const grid = new Map();
    const key = (ix, iz) => `${ix},${iz}`;
    const add = (ix, iz, item) => {
      const k = key(ix, iz);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(item);
    };
    for (const seg of this.barriers) {
      const minX = Math.min(seg.a.x, seg.b.x), maxX = Math.max(seg.a.x, seg.b.x);
      const minZ = Math.min(seg.a.z, seg.b.z), maxZ = Math.max(seg.a.z, seg.b.z);
      for (let ix = Math.floor(minX / cellSize) - 1; ix <= Math.floor(maxX / cellSize) + 1; ix++) {
        for (let iz = Math.floor(minZ / cellSize) - 1; iz <= Math.floor(maxZ / cellSize) + 1; iz++) {
          add(ix, iz, { seg });
        }
      }
    }
    for (const b of this.boxes) {
      for (let ix = Math.floor((b.x - b.hw) / cellSize) - 1; ix <= Math.floor((b.x + b.hw) / cellSize) + 1; ix++) {
        for (let iz = Math.floor((b.z - b.hd) / cellSize) - 1; iz <= Math.floor((b.z + b.hd) / cellSize) + 1; iz++) {
          add(ix, iz, { box: b });
        }
      }
    }
    this._segGrid = { grid, cellSize, key };
  }

  collide(point, radius = 0.35) {
    const G = this._segGrid;
    if (!G) return null;
    const ix = Math.floor(point.x / G.cellSize);
    const iz = Math.floor(point.z / G.cellSize);
    const bucket = G.grid.get(G.key(ix, iz));
    if (!bucket) return null;

    let bestDepth = 0, bestNx = 0, bestNz = 0;
    for (const item of bucket) {
      if (item.seg) {
        const s = item.seg;
        if (point.y > s.top || point.y < s.bottom) continue;
        const abx = s.b.x - s.a.x, abz = s.b.z - s.a.z;
        const apx = point.x - s.a.x, apz = point.z - s.a.z;
        const len2 = abx * abx + abz * abz || 1;
        const t = clamp01((apx * abx + apz * abz) / len2);
        const cx = s.a.x + abx * t, cz = s.a.z + abz * t;
        const dx = point.x - cx, dz = point.z - cz;
        const d = Math.hypot(dx, dz);
        const depth = radius + s.thickness - d;
        if (depth > bestDepth) {
          bestDepth = depth;
          const inv = d > 1e-5 ? 1 / d : 0;
          bestNx = dx * inv; bestNz = dz * inv;
        }
      } else {
        const b = item.box;
        if (point.y > b.y + b.hh || point.y < b.y - b.hh) continue;
        const dx = point.x - b.x, dz = point.z - b.z;
        const ox = b.hw + radius - Math.abs(dx);
        const oz = b.hd + radius - Math.abs(dz);
        if (ox <= 0 || oz <= 0) continue;
        if (ox < oz) {
          if (ox > bestDepth) { bestDepth = ox; bestNx = Math.sign(dx) || 1; bestNz = 0; }
        } else if (oz > bestDepth) { bestDepth = oz; bestNx = 0; bestNz = Math.sign(dz) || 1; }
      }
    }
    if (bestDepth <= 0) return null;
    this._tmp.set(bestNx, 0, bestNz);
    if (this._tmp.lengthSq() < 1e-6) return null;
    return { normal: this._tmp, depth: bestDepth };
  }

  dispose() {
    this.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
  }
}

export { SURF };
