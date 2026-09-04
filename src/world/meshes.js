/**
 * Visual geometry for the world: terrain shell, road ribbon, kerbs, armco,
 * city blocks, street furniture and the start gantry. Split out from the
 * simulation-facing part of `World` so the physics file stays readable.
 */
import * as THREE from 'three';
import { World, SURF } from './world.js';
import { clamp01, lerp, makeRng, TAU } from '../core/util.js';
import { asphaltMaps, groundMaps, facadeAtlas } from '../gfx/textures.js';
import * as M from '../gfx/materials.js';

/* ── terrain shell ─────────────────────────────────────── */

World.prototype.buildTerrainMesh = function buildTerrainMesh() {
  const step = this.preset.key === 'low' ? 14 : 9;
  const N = Math.floor(this.extent / step);
  const geo = new THREE.PlaneGeometry(this.extent, this.extent, N, N);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const y = this.rawHeight(x, z);
    pos.setY(i, y - 0.10);
    const t = this.typeAt(x, z);
    // tint by surface and altitude so the terrain does not read as one flat green
    const alt = clamp01((y + 10) / 70);
    if (t === SURF.ASPHALT || t === SURF.PLAZA) c.setRGB(0.05, 0.055, 0.062);
    else if (t === SURF.SHOULDER) c.setRGB(0.20, 0.20, 0.185);
    else c.setRGB(lerp(0.30, 0.46, alt), lerp(0.38, 0.44, alt), lerp(0.19, 0.29, alt));
    const n = (Math.sin(x * 0.13) + Math.cos(z * 0.11)) * 0.035;
    colors[i * 3] = clamp01(c.r + n);
    colors[i * 3 + 1] = clamp01(c.g + n);
    colors[i * 3 + 2] = clamp01(c.b + n * 0.5);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const gm = groundMaps(512);
  for (const t of Object.values(gm)) { t.repeat.set(150, 150); t.anisotropy = 4; }
  const mat = new THREE.MeshStandardMaterial({
    map: gm.map, normalMap: gm.normalMap,
    vertexColors: true, roughness: 0.95, metalness: 0.0,
    envMapIntensity: 0.75,
  });
  mat.normalScale = new THREE.Vector2(0.6, 0.6);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  this.terrainMesh = mesh;
  this.root.add(mesh);
};

/* ── road ribbon ───────────────────────────────────────── */

World.prototype.buildRoadMesh = function buildRoadMesh() {
  const S = this.samples;
  const n = S.length;
  const halfW = this.trackWidth / 2;
  const LAT = 8;                          // lateral divisions
  const positions = [];
  const uvs = [];
  const indices = [];

  const stride = this.preset.key === 'low' ? 2 : 1;
  const rows = [];
  for (let i = 0; i < n; i += stride) rows.push(S[i]);
  rows.push(S[0]);

  for (let r = 0; r < rows.length; r++) {
    const s = rows[r];
    for (let j = 0; j <= LAT; j++) {
      const f = j / LAT;
      const lateral = lerp(-halfW, halfW, f);
      const bankY = lateral * Math.sin(s.bank);
      // slight crown so water would run off — reads as a real road surface
      const crown = -Math.pow(Math.abs(lateral) / halfW, 2) * 0.055;
      positions.push(
        s.pos.x + s.lat.x * lateral,
        s.pos.y + bankY + crown + 0.012,
        s.pos.z + s.lat.z * lateral
      );
      uvs.push(f * 3.4, s.s / 2.6);
    }
  }
  const W = LAT + 1;
  for (let r = 0; r < rows.length - 1; r++) {
    for (let j = 0; j < LAT; j++) {
      const a = r * W + j, b = a + 1, c = (r + 1) * W + j + 1, d = (r + 1) * W + j;
      indices.push(a, b, c, a, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const am = asphaltMaps(512);
  for (const t of Object.values(am)) { t.repeat.set(1, 1); t.anisotropy = 8; }
  const mat = new THREE.MeshPhysicalMaterial({
    map: am.map, normalMap: am.normalMap, roughnessMap: am.roughnessMap,
    roughness: 1.0, metalness: 0.0, envMapIntensity: 0.7,
    clearcoat: 0.0,
  });
  mat.normalScale = new THREE.Vector2(0.34, 0.34);
  this.roadMaterial = mat;

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'road';
  this.roadMesh = mesh;
  this.root.add(mesh);

  this.buildRoadLines(rows, halfW);
  this.buildPlazaMesh();
};

World.prototype.buildRoadLines = function buildRoadLines(rows, halfW) {
  const mk = (offset, width, color, emissive = 0) => {
    const positions = [];
    const indices = [];
    for (let r = 0; r < rows.length; r++) {
      const s = rows[r];
      for (const side of [-1, 1]) {
        const lateral = offset + side * width * 0.5;
        const bankY = lateral * Math.sin(s.bank);
        positions.push(
          s.pos.x + s.lat.x * lateral,
          s.pos.y + bankY + 0.026,
          s.pos.z + s.lat.z * lateral
        );
      }
    }
    for (let r = 0; r < rows.length - 1; r++) {
      const a = r * 2, b = a + 1, c = a + 3, d = a + 2;
      indices.push(a, b, c, a, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({
      color, roughness: 0.62, metalness: 0.0,
      emissive: new THREE.Color(color).multiplyScalar(emissive),
      envMapIntensity: 0.5,
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = false;
    return mesh;
  };
  this.root.add(mk(-halfW + 0.28, 0.16, 0xf2f4f7, 0.06));
  this.root.add(mk(halfW - 0.28, 0.16, 0xf2f4f7, 0.06));
};

World.prototype.buildPlazaMesh = function buildPlazaMesh() {
  const P = this.plaza;
  const geo = new THREE.PlaneGeometry(P.w, P.d, 12, 12);
  geo.rotateX(-Math.PI / 2);
  const am = asphaltMaps(512);
  const mat = new THREE.MeshPhysicalMaterial({
    map: am.map, normalMap: am.normalMap, roughnessMap: am.roughnessMap,
    roughness: 0.96, metalness: 0.0, envMapIntensity: 0.75,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(P.x, P.y + 0.012, P.z);
  mesh.receiveShadow = true;
  this.root.add(mesh);

  // painted drift circles and parking bays
  const paint = new THREE.MeshStandardMaterial({
    color: 0xdfe4ea, roughness: 0.7, transparent: true, opacity: 0.85, depthWrite: false,
  });
  for (const [cx, cz, r] of [[-38, -28, 22], [34, 30, 26], [0, 0, 34]]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - 0.16, r, 72), paint);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(P.x + cx, P.y + 0.022, P.z + cz);
    ring.renderOrder = 1;
    this.root.add(ring);
  }
  const bay = new THREE.PlaneGeometry(0.14, 5.2);
  bay.rotateX(-Math.PI / 2);
  const bays = new THREE.InstancedMesh(bay, paint, 26);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < 26; i++) {
    const row = i < 13 ? 0 : 1;
    const k = i % 13;
    m4.makeTranslation(P.x - P.w / 2 + 12 + k * 3.0, P.y + 0.022, P.z - P.d / 2 + 10 + row * 12);
    bays.setMatrixAt(i, m4);
  }
  bays.instanceMatrix.needsUpdate = true;
  this.root.add(bays);
};

/* ── kerbs ─────────────────────────────────────────────── */

World.prototype.buildKerbs = function buildKerbs() {
  const S = this.samples;
  const halfW = this.trackWidth / 2;
  const red = [];
  const white = [];
  const runs = [];

  // find corner stretches worth kerbing
  let run = null;
  for (let i = 0; i < S.length; i++) {
    const k = S[i].curvature;
    if (Math.abs(k) > 0.0022) {
      if (!run) run = { start: i, sign: Math.sign(k) };
      run.end = i;
    } else if (run) {
      if (run.end - run.start > 12) runs.push(run);
      run = null;
    }
  }
  if (run && run.end - run.start > 12) runs.push(run);

  const push = (arr, s, inner, from, to) => {
    const base = arr.length / 3;
    for (const t of [from, to]) {
      for (const off of [0, 1]) {
        const lateral = inner * (halfW + 0.05 + off * 1.15);
        const y = s[t].pos.y + lateral * Math.sin(s[t].bank) + (off ? 0.085 : 0.02);
        arr.push(
          s[t].pos.x + s[t].lat.x * lateral, y,
          s[t].pos.z + s[t].lat.z * lateral
        );
      }
    }
    return base;
  };

  const redIdx = [], whiteIdx = [];
  for (const r of runs) {
    for (const inner of [-1, 1]) {
      for (let i = r.start; i < r.end; i += 4) {
        const j = Math.min(r.end, i + 4);
        const stripe = ((i / 4) | 0) % 2 === 0;
        const arr = stripe ? red : white;
        const idx = stripe ? redIdx : whiteIdx;
        const b = push(arr, S, inner, i, j);
        if (inner > 0) idx.push(b, b + 1, b + 3, b, b + 3, b + 2);
        else idx.push(b, b + 3, b + 1, b, b + 2, b + 3);
      }
    }
  }

  const mk = (arr, idx, color) => {
    if (!arr.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.66, metalness: 0.0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    this.root.add(mesh);
  };
  mk(red, redIdx, 0xd0342c);
  mk(white, whiteIdx, 0xeceff2);
  this.kerbRuns = runs;
};

/* ── armco barriers ────────────────────────────────────── */

World.prototype.buildBarriers = function buildBarriers() {
  const S = this.samples;
  const halfW = this.trackWidth / 2;
  const offset = halfW + 9.5;
  const railGeo = [];
  const railIdx = [];
  const postPos = [];
  const step = 3;

  for (const side of [-1, 1]) {
    let prev = null, prevX = 0, prevZ = 0, prevY = 0;
    for (let i = 0; i <= S.length; i += step) {
      const s = S[i % S.length];
      const lateral = side * offset;
      const x = s.pos.x + s.lat.x * lateral;
      const z = s.pos.z + s.lat.z * lateral;
      const y = this.rawHeight(x, z);
      const base = railGeo.length / 3;
      railGeo.push(x, y + 0.52, z, x, y + 0.94, z);
      if (prev !== null) {
        // two-sided rail: drivers hit it from either face
        railIdx.push(prev, prev + 1, base + 1, prev, base + 1, base);
        railIdx.push(prev, base + 1, prev + 1, prev, base, base + 1);
        this.barriers.push({
          a: { x: prevX, z: prevZ }, b: { x, z },
          bottom: Math.min(prevY, y) - 0.5, top: Math.max(prevY, y) + 1.4,
          thickness: 0.22,
        });
      }
      if (i % (step * 3) === 0) postPos.push([x, y, z]);
      prev = base;
      prevX = x; prevZ = z; prevY = y;
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(railGeo, 3));
  g.setIndex(railIdx);
  g.computeVertexNormals();
  const rail = new THREE.Mesh(g, M.metal({ color: 0x9aa1aa, roughness: 0.42, metalness: 0.9, env: 1.0 }));
  rail.castShadow = false;
  rail.receiveShadow = true;
  rail.name = 'armco';
  this.root.add(rail);

  const postGeo = new THREE.BoxGeometry(0.12, 1.0, 0.12);
  const posts = new THREE.InstancedMesh(postGeo, M.metal({ color: 0x6d747d, roughness: 0.6, metalness: 0.8 }), postPos.length);
  const m4 = new THREE.Matrix4();
  postPos.forEach((p, i) => {
    m4.makeTranslation(p[0], p[1] + 0.5, p[2]);
    posts.setMatrixAt(i, m4);
  });
  posts.instanceMatrix.needsUpdate = true;
  posts.castShadow = true;
  this.root.add(posts);
};

/* ── city district ─────────────────────────────────────── */

World.prototype.buildCity = function buildCity() {
  const rng = makeRng(this.seed + 4242);
  const atlas = facadeAtlas(512, this.seed + 7);
  const density = this.preset.cityDensity;

  const mat = new THREE.MeshStandardMaterial({
    map: atlas.map,
    emissiveMap: atlas.emissiveMap,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 0.0,
    roughness: 0.72, metalness: 0.10,
    envMapIntensity: 0.6,
  });
  this.cityMaterial = mat;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  // remap UVs so each face samples one column of the facade atlas
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.25, uv.getY(i));
  uv.needsUpdate = true;

  const slots = [];
  const districts = [
    { x: -430, z: 300, w: 300, d: 260, tall: 1.0 },
    { x: 470, z: -260, w: 260, d: 240, tall: 0.7 },
    { x: -120, z: -430, w: 280, d: 180, tall: 0.5 },
  ];
  for (const D of districts) {
    const cols = Math.round(D.w / 46), rows = Math.round(D.d / 46);
    for (let cx = 0; cx < cols; cx++) {
      for (let cz = 0; cz < rows; cz++) {
        if (rng() > density) continue;
        const x = D.x - D.w / 2 + (cx + 0.5) * (D.w / cols) + rng.range(-5, 5);
        const z = D.z - D.d / 2 + (cz + 0.5) * (D.d / rows) + rng.range(-5, 5);
        const near = this.trackProgress(x, z);
        if (near.distance < 46) continue;             // keep the circuit clear
        const w = rng.range(16, 32), d = rng.range(16, 30);
        const h = rng.range(16, 74) * D.tall + 8;
        const y = this.rawHeight(x, z);
        slots.push({ x, y, z, w, d, h, style: rng.int(0, atlas.styles - 1) });
      }
    }
  }

  if (!slots.length) return;
  const inst = new THREE.InstancedMesh(geo, mat, slots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  slots.forEach((s, i) => {
    pos.set(s.x, s.y + s.h / 2 - 1, s.z);
    scl.set(s.w, s.h, s.d);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.round(rng() * 4) * Math.PI / 2);
    m4.compose(pos, q, scl);
    inst.setMatrixAt(i, m4);
    this.boxes.push({ x: s.x, y: s.y + s.h / 2, z: s.z, hw: s.w / 2, hd: s.d / 2, hh: s.h / 2 });
  });
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.name = 'city';
  this.cityMesh = inst;
  this.root.add(inst);
};

/* ── street furniture ──────────────────────────────────── */

World.prototype.buildProps = function buildProps() {
  const rng = makeRng(this.seed + 99);
  const S = this.samples;
  const halfW = this.trackWidth / 2;

  /* street lights along the circuit */
  const lightSlots = [];
  const spacing = Math.max(10, Math.round(S.length / 46));
  for (let i = 0; i < S.length; i += spacing) {
    const s = S[i];
    const side = (i / spacing) % 2 === 0 ? 1 : -1;
    const lateral = side * (halfW + 5.2);
    const x = s.pos.x + s.lat.x * lateral;
    const z = s.pos.z + s.lat.z * lateral;
    lightSlots.push({ x, y: this.rawHeight(x, z), z, side, tan: s.tan });
  }

  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 8.2, 8);
  poleGeo.translate(0, 4.1, 0);
  const armGeo = new THREE.BoxGeometry(1.9, 0.13, 0.16);
  armGeo.translate(0.95, 8.15, 0);
  const headGeo = new THREE.BoxGeometry(0.72, 0.13, 0.34);
  headGeo.translate(1.85, 8.02, 0);

  const poleMat = M.metal({ color: 0x4a5058, roughness: 0.6, metalness: 0.75 });
  const lampMat = M.lightLens({ color: 0xffd9a0, power: 0.0, rough: 0.3 });
  this.streetLampMaterial = lampMat;

  const poles = new THREE.InstancedMesh(poleGeo, poleMat, lightSlots.length);
  const arms = new THREE.InstancedMesh(armGeo, poleMat, lightSlots.length);
  const heads = new THREE.InstancedMesh(headGeo, lampMat, lightSlots.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const mirror = new THREE.Vector3(-1, 1, 1);

  lightSlots.forEach((L, i) => {
    const ang = Math.atan2(L.tan.x, L.tan.z);
    q.setFromAxisAngle(up, ang + (L.side > 0 ? Math.PI : 0));
    p.set(L.x, L.y, L.z);
    m4.compose(p, q, L.side > 0 ? one : one);
    poles.setMatrixAt(i, m4);
    arms.setMatrixAt(i, m4);
    heads.setMatrixAt(i, m4);
    void mirror;
  });
  for (const m of [poles, arms, heads]) { m.instanceMatrix.needsUpdate = true; m.castShadow = false; }
  poles.castShadow = true;
  this.root.add(poles, arms, heads);
  this.lampSlots = lightSlots;

  /* pines on the hillsides */
  const treeCount = Math.round(520 * this.preset.cityDensity);
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.2, 6);
  trunkGeo.translate(0, 1.1, 0);
  const crownGeo = new THREE.ConeGeometry(1.7, 6.2, 8);
  crownGeo.translate(0, 4.6, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2b1f, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x1f3d22, roughness: 0.92, envMapIntensity: 0.4 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount);
  let placed = 0;
  for (let guard = 0; guard < treeCount * 14 && placed < treeCount; guard++) {
    const x = rng.range(-this.half + 40, this.half - 40);
    const z = rng.range(-this.half + 40, this.half - 40);
    const near = this.trackProgress(x, z);
    if (near.distance < 34) continue;
    if (this.typeAt(x, z) !== SURF.GRASS) continue;
    const y = this.rawHeight(x, z);
    if (y < -6) continue;
    const s = rng.range(0.7, 1.6);
    q.setFromAxisAngle(up, rng() * TAU);
    p.set(x, y - 0.2, z);
    m4.compose(p, q, new THREE.Vector3(s, s * rng.range(0.85, 1.3), s));
    trunks.setMatrixAt(placed, m4);
    crowns.setMatrixAt(placed, m4);
    placed++;
  }
  trunks.count = crowns.count = placed;
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  crowns.castShadow = true;
  this.root.add(trunks, crowns);

  /* traffic cones scattered over the plaza */
  const coneGeo = new THREE.ConeGeometry(0.20, 0.62, 10);
  coneGeo.translate(0, 0.31, 0);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a1f, roughness: 0.7, emissive: 0x2a0a00 });
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, 60);
  const P = this.plaza;
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU * 3;
    const r = 20 + (i % 3) * 16;
    p.set(P.x + Math.cos(a) * r, P.y, P.z + Math.sin(a) * r * 0.8);
    m4.compose(p, new THREE.Quaternion(), one);
    cones.setMatrixAt(i, m4);
  }
  cones.instanceMatrix.needsUpdate = true;
  this.root.add(cones);
};

/* ── start / finish gantry ─────────────────────────────── */

World.prototype.buildStartGantry = function buildStartGantry() {
  const s = this.samples[0];
  const g = new THREE.Group();
  const halfW = this.trackWidth / 2 + 2.2;
  const steel = M.metal({ color: 0x3d434b, roughness: 0.5, metalness: 0.85 });

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.4, 0.5), steel);
    leg.position.set(side * halfW, 3.7, 0);
    leg.castShadow = true;
    g.add(leg);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(halfW * 2 + 0.5, 1.15, 0.65), steel);
  beam.position.y = 7.4;
  beam.castShadow = true;
  g.add(beam);

  const banner = new THREE.Mesh(
    new THREE.PlaneGeometry(halfW * 1.7, 0.85),
    new THREE.MeshStandardMaterial({
      color: 0x0d1016, roughness: 0.6,
      emissive: new THREE.Color(0xff8a2b), emissiveIntensity: 0.55,
    })
  );
  banner.position.set(0, 7.4, 0.36);
  g.add(banner);

  // start lights
  const bulbGeo = new THREE.SphereGeometry(0.16, 12, 8);
  this.startLights = [];
  for (let i = 0; i < 5; i++) {
    const bulb = new THREE.Mesh(bulbGeo, M.lightLens({ color: 0xff2418, power: 0.02 }));
    bulb.position.set((i - 2) * 0.62, 6.55, 0.42);
    g.add(bulb);
    this.startLights.push(bulb);
  }

  // start line
  const lineGeo = new THREE.PlaneGeometry(this.trackWidth, 0.8, 1, 1);
  lineGeo.rotateX(-Math.PI / 2);
  const line = new THREE.Mesh(lineGeo, new THREE.MeshStandardMaterial({
    color: 0xf0f3f6, roughness: 0.65, transparent: true, opacity: 0.9, depthWrite: false,
  }));
  line.position.y = 0.03;
  line.renderOrder = 2;
  g.add(line);

  const ang = Math.atan2(s.tan.x, s.tan.z);
  g.position.copy(s.pos);
  g.rotation.y = ang;
  this.root.add(g);
  this.gantry = g;
};

/* ── runtime ───────────────────────────────────────────── */

World.prototype.setNight = function setNight(nightAmount, renderer) {
  if (this.cityMaterial) this.cityMaterial.emissiveIntensity = nightAmount * 1.35;
  if (this.streetLampMaterial) {
    this.streetLampMaterial.emissiveIntensity = nightAmount * 4.2;
  }
  // real point lights only near the player, and only as many as the preset allows
  const want = Math.round(this.preset.lightsAtNight * clamp01(nightAmount));
  if (!this._pointPool) this._pointPool = [];
  while (this._pointPool.length < want) {
    const l = new THREE.PointLight(0xffd9a0, 0, 44, 1.8);
    l.castShadow = false;
    this.root.add(l);
    this._pointPool.push(l);
  }
  for (let i = 0; i < this._pointPool.length; i++) {
    this._pointPool[i].visible = i < want;
  }
  this._nightAmount = nightAmount;
  void renderer;
};

/** Move the pooled street lights to the nearest lamp posts each frame. */
World.prototype.updateLights = function updateLights(cameraPos) {
  const pool = this._pointPool;
  if (!pool || !pool.length || !this.lampSlots || !this._nightAmount) return;
  const want = pool.filter((l) => l.visible).length;
  if (!want) return;
  const near = [];
  for (const L of this.lampSlots) {
    const d = (L.x - cameraPos.x) ** 2 + (L.z - cameraPos.z) ** 2;
    if (d < 210 * 210) near.push({ L, d });
  }
  near.sort((a, b) => a.d - b.d);
  let i = 0;
  for (const l of pool) {
    if (!l.visible) continue;
    const n = near[i++];
    if (!n) { l.intensity = 0; continue; }
    const ang = Math.atan2(n.L.tan.x, n.L.tan.z) + (n.L.side > 0 ? Math.PI : 0);
    l.position.set(
      n.L.x + Math.cos(-ang) * 1.85, n.L.y + 8.0, n.L.z + Math.sin(-ang) * 1.85
    );
    l.intensity = 44 * this._nightAmount * clamp01(1 - Math.sqrt(n.d) / 210);
  }
};

/** Where a car should be placed for a standing start. */
World.prototype.gridSlot = function gridSlot(index = 0) {
  const back = 14 + index * 8;
  const n = this.samples.length;
  const si = ((Math.round(this.startSample - back / 2) % n) + n) % n;
  const s = this.samples[si];
  const lateral = (index % 2 === 0 ? -1 : 1) * 3.0;
  return {
    x: s.pos.x + s.lat.x * lateral,
    z: s.pos.z + s.lat.z * lateral,
    y: s.pos.y,
    heading: Math.atan2(s.tan.x, s.tan.z),
  };
};

export { World, SURF };
