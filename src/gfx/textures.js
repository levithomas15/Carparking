/**
 * Every texture in APEX is generated procedurally on a 2D canvas at boot.
 * No binary assets means the whole simulator is a few hundred KB and works
 * offline, while still giving the PBR pipeline real albedo / normal /
 * roughness maps to chew on.
 */
import * as THREE from 'three';
import { makeNoise2D, fbm, clamp01, lerp, makeRng, TAU } from '../core/util.js';

const cache = new Map();

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(cv, { repeat = 1, srgb = false, aniso = 8, mips = true } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Sobel-derive a tangent-space normal map from a height canvas. */
function heightToNormal(heightCanvas, strength = 2.0) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const H = (x, y) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = H(x - 1, y - 1), t = H(x, y - 1), tr = H(x + 1, y - 1);
      const l = H(x - 1, y), r = H(x + 1, y);
      const bl = H(x - 1, y + 1), b = H(x, y + 1), br = H(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength, ny = -dy * strength, nz = 1.0;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/* ─────────────────────────── asphalt ─────────────────────────── */

function asphaltHeight(size = 512, seed = 11) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n1 = makeNoise2D(seed);
  const n2 = makeNoise2D(seed + 91);
  const rng = makeRng(seed + 5);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // coarse aggregate + fine grain
      let h = fbm(n1, u * 26, v * 26, 4, 2.1, 0.55) * 0.5 + 0.5;
      const grain = fbm(n2, u * 120, v * 120, 3, 2.3, 0.5) * 0.5 + 0.5;
      h = h * 0.62 + grain * 0.38;
      // scattered chip stones
      const stone = fbm(n2, u * 44 + 13, v * 44 - 7, 2, 2, 0.5) * 0.5 + 0.5;
      if (stone > 0.68) h += (stone - 0.68) * 1.6;
      h = clamp01(h);
      const i = (y * size + x) * 4;
      const c = h * 255;
      d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // hairline cracks
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = 'rgba(40,40,40,0.55)';
  for (let k = 0; k < 9; k++) {
    ctx.lineWidth = rng.range(0.6, 1.8);
    ctx.beginPath();
    let px = rng() * size, py = rng() * size, ang = rng() * TAU;
    ctx.moveTo(px, py);
    for (let s = 0; s < 26; s++) {
      ang += rng.range(-0.6, 0.6);
      px += Math.cos(ang) * 9; py += Math.sin(ang) * 9;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  return cv;
}

export function asphaltMaps(size = 512) {
  if (cache.has('asphalt')) return cache.get('asphalt');
  const h = asphaltHeight(size);
  const hc = h.getContext('2d', { willReadFrequently: true });
  const src = hc.getImageData(0, 0, size, size).data;

  // albedo: dark grey tinted by height, with subtle blue-grey variance
  const alb = canvas(size);
  const actx = alb.getContext('2d', { willReadFrequently: true });
  const aimg = actx.createImageData(size, size);
  const ad = aimg.data;
  // roughness: rougher in the pits, polished on the high spots (worn stones)
  const rgh = canvas(size);
  const rctx = rgh.getContext('2d', { willReadFrequently: true });
  const rimg = rctx.createImageData(size, size);
  const rd = rimg.data;

  const nTint = makeNoise2D(303);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const hv = src[i] / 255;
      const tint = fbm(nTint, x / size * 7, y / size * 7, 3) * 0.5 + 0.5;
      const base = lerp(0.055, 0.155, hv * hv) * lerp(0.86, 1.18, tint);
      ad[i] = base * 255 * 1.0;
      ad[i + 1] = base * 255 * 1.02;
      ad[i + 2] = base * 255 * 1.12;
      ad[i + 3] = 255;
      const r = lerp(0.94, 0.55, Math.pow(hv, 2.2)) * lerp(0.92, 1.06, tint);
      rd[i] = rd[i + 1] = rd[i + 2] = clamp01(r) * 255;
      rd[i + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  const nrm = heightToNormal(h, 1.6);
  const maps = {
    map: toTexture(alb, { srgb: true }),
    normalMap: toTexture(nrm),
    roughnessMap: toTexture(rgh),
  };
  cache.set('asphalt', maps);
  return maps;
}

/* ───────────────────────── carbon fibre ──────────────────────── */

function carbonHeight(size = 256, tile = 16) {
  const cv = canvas(size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const cell = size / tile;      // one weave cell
  const strand = cell / 2;

  for (let ty = 0; ty < tile; ty++) {
    for (let tx = 0; tx < tile; tx++) {
      const over = ((tx + ty) & 1) === 0;   // 2x2 twill look
      const x0 = tx * cell, y0 = ty * cell;
      const g = over
        ? ctx.createLinearGradient(x0, y0, x0 + cell, y0)
        : ctx.createLinearGradient(x0, y0, x0, y0 + cell);
      g.addColorStop(0, '#4a4a4a');
      g.addColorStop(0.5, '#e8e8e8');
      g.addColorStop(1, '#4a4a4a');
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, cell, cell);
      // fine filament striations across each strand
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (let s = 1; s < 6; s++) {
        if (over) { ctx.moveTo(x0, y0 + s * cell / 6); ctx.lineTo(x0 + cell, y0 + s * cell / 6); }
        else { ctx.moveTo(x0 + s * cell / 6, y0); ctx.lineTo(x0 + s * cell / 6, y0 + cell); }
      }
      ctx.stroke();
      ctx.restore();
      void strand;
    }
  }
  return cv;
}

export function carbonMaps(size = 256) {
  if (cache.has('carbon')) return cache.get('carbon');
  const h = carbonHeight(size);
  const src = h.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;

  const alb = canvas(size);
  const actx = alb.getContext('2d', { willReadFrequently: true });
  const aimg = actx.createImageData(size, size);
  const ad = aimg.data;
  const rgh = canvas(size);
  const rctx = rgh.getContext('2d', { willReadFrequently: true });
  const rimg = rctx.createImageData(size, size);
  const rd = rimg.data;

  for (let i = 0; i < src.length; i += 4) {
    const hv = src[i] / 255;
    const c = lerp(0.012, 0.10, Math.pow(hv, 1.5));
    ad[i] = c * 255 * 1.0;
    ad[i + 1] = c * 255 * 1.03;
    ad[i + 2] = c * 255 * 1.14;
    ad[i + 3] = 255;
    const r = lerp(0.42, 0.16, hv);
    rd[i] = rd[i + 1] = rd[i + 2] = r * 255;
    rd[i + 3] = 255;
  }
  actx.putImageData(aimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);

  const maps = {
    map: toTexture(alb, { srgb: true }),
    normalMap: toTexture(heightToNormal(h, 1.1)),
    roughnessMap: toTexture(rgh),
  };
  cache.set('carbon', maps);
  return maps;
}

/* ──────────────────── metallic paint flake ───────────────────── */

/** Very fine sparkle normal — what sells "metallic" under a clearcoat. */
export function flakeNormal(size = 512, density = 0.16) {
  if (cache.has('flake')) return cache.get('flake');
  const h = canvas(size);
  const ctx = h.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const rng = makeRng(4242);
  const n = Math.floor(size * size * density * 0.02);
  for (let i = 0; i < n; i++) {
    const x = rng() * size, y = rng() * size;
    const r = rng.range(0.6, 1.9);
    const v = rng() < 0.5 ? 0 : 255;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${v},${v},${v},0.85)`);
    g.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  const t = toTexture(heightToNormal(h, 0.55), { repeat: 1 });
  cache.set('flake', t);
  return t;
}

/* ───────────────────────── tyre tread ────────────────────────── */

export function tyreMaps(size = 256) {
  if (cache.has('tyre')) return cache.get('tyre');
  // u wraps around the circumference, v runs across the tread width
  const h = canvas(size);
  const ctx = h.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#b4b4b4';
  ctx.fillRect(0, 0, size, size);

  // four circumferential grooves
  ctx.fillStyle = '#2a2a2a';
  const grooves = [0.18, 0.40, 0.60, 0.82];
  for (const g of grooves) ctx.fillRect(0, g * size - size * 0.030, size, size * 0.060);

  // angled sipes across the shoulder blocks
  ctx.strokeStyle = '#3c3c3c';
  ctx.lineWidth = size * 0.018;
  for (let i = 0; i < 34; i++) {
    const x = (i / 34) * size;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x + size * 0.09, size * 0.19);
    ctx.moveTo(x + size * 0.03, size * 0.81); ctx.lineTo(x + size * 0.12, size);
    ctx.stroke();
  }
  // sidewall darkening at the extremes
  const sg = ctx.createLinearGradient(0, 0, 0, size);
  sg.addColorStop(0, 'rgba(90,90,90,0.9)');
  sg.addColorStop(0.10, 'rgba(0,0,0,0)');
  sg.addColorStop(0.90, 'rgba(0,0,0,0)');
  sg.addColorStop(1, 'rgba(90,90,90,0.9)');
  ctx.fillStyle = sg;
  ctx.fillRect(0, 0, size, size);

  const rgh = canvas(size);
  const rc = rgh.getContext('2d', { willReadFrequently: true });
  rc.fillStyle = '#e0e0e0';
  rc.fillRect(0, 0, size, size);
  rc.fillStyle = '#f4f4f4';
  for (const g of grooves) rc.fillRect(0, g * size - size * 0.030, size, size * 0.060);

  const maps = {
    normalMap: toTexture(heightToNormal(h, 2.4)),
    roughnessMap: toTexture(rgh),
  };
  cache.set('tyre', maps);
  return maps;
}

/* ───────────────────── brake disc (drilled) ──────────────────── */

export function brakeDiscMaps(size = 512) {
  if (cache.has('disc')) return cache.get('disc');
  const h = canvas(size);
  const ctx = h.getContext('2d', { willReadFrequently: true });
  const c = size / 2;
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, size, size);

  // machined turning grooves
  ctx.strokeStyle = 'rgba(150,150,150,0.5)';
  for (let r = size * 0.16; r < c; r += 1.6) {
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = `rgba(${140 + ((r | 0) % 3) * 22},${140 + ((r | 0) % 3) * 22},${140 + ((r | 0) % 3) * 22},0.55)`;
    ctx.beginPath(); ctx.arc(c, c, r, 0, TAU); ctx.stroke();
  }
  // cross-drilled holes in two rings
  ctx.fillStyle = '#101010';
  for (const [ring, count] of [[0.78, 22], [0.60, 18], [0.43, 14]]) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + ring * 3.1;
      const x = c + Math.cos(a) * c * ring;
      const y = c + Math.sin(a) * c * ring;
      ctx.beginPath(); ctx.arc(x, y, size * 0.016, 0, TAU); ctx.fill();
    }
  }
  // slot grooves
  ctx.strokeStyle = '#2a2a2a';
  ctx.lineWidth = size * 0.014;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * c * 0.36, c + Math.sin(a) * c * 0.36);
    ctx.lineTo(c + Math.cos(a + 0.42) * c * 0.9, c + Math.sin(a + 0.42) * c * 0.9);
    ctx.stroke();
  }

  const alb = canvas(size);
  const ac = alb.getContext('2d', { willReadFrequently: true });
  ac.drawImage(h, 0, 0);
  ac.globalCompositeOperation = 'multiply';
  const g = ac.createRadialGradient(c, c, size * 0.15, c, c, c);
  g.addColorStop(0, '#7a7c80');
  g.addColorStop(0.55, '#9aa0a8');
  g.addColorStop(1, '#63676d');
  ac.fillStyle = g;
  ac.fillRect(0, 0, size, size);
  ac.globalCompositeOperation = 'source-over';

  const maps = {
    map: toTexture(alb, { srgb: true, repeat: 1 }),
    normalMap: toTexture(heightToNormal(h, 1.4), { repeat: 1 }),
  };
  maps.map.wrapS = maps.map.wrapT = THREE.ClampToEdgeWrapping;
  maps.normalMap.wrapS = maps.normalMap.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('disc', maps);
  return maps;
}

/* ───────────────────── alcantara / leather ───────────────────── */

export function alcantaraMaps(size = 256) {
  if (cache.has('alcantara')) return cache.get('alcantara');
  const h = canvas(size);
  const ctx = h.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n = makeNoise2D(88);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm(n, x / size * 90, y / size * 90, 4, 2.4, 0.6) * 0.5 + 0.5;
      const i = (y * size + x) * 4;
      const c = lerp(90, 190, v);
      d[i] = d[i + 1] = d[i + 2] = c; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const maps = { normalMap: toTexture(heightToNormal(h, 0.8), { repeat: 2 }) };
  cache.set('alcantara', maps);
  return maps;
}

/* ─────────────────────── building facades ────────────────────── */

/**
 * A strip atlas of facades — each column is one building style, windows lit
 * according to `litRatio`. Emissive version returned alongside so windows
 * glow at night.
 */
export function facadeAtlas(size = 512, seed = 21) {
  const key = `facade${seed}`;
  if (cache.has(key)) return cache.get(key);
  const rng = makeRng(seed);
  const alb = canvas(size);
  const a = alb.getContext('2d', { willReadFrequently: true });
  const emi = canvas(size);
  const e = emi.getContext('2d', { willReadFrequently: true });
  e.fillStyle = '#000';
  e.fillRect(0, 0, size, size);

  const styles = 4;
  const colw = size / styles;
  const wallCols = ['#3b4048', '#4a4038', '#2f3640', '#565049'];

  for (let s = 0; s < styles; s++) {
    const x0 = s * colw;
    a.fillStyle = wallCols[s];
    a.fillRect(x0, 0, colw, size);
    // concrete mottling
    a.globalAlpha = 0.14;
    for (let i = 0; i < 160; i++) {
      a.fillStyle = rng() < 0.5 ? '#000' : '#fff';
      a.fillRect(x0 + rng() * colw, rng() * size, rng.range(2, 14), rng.range(2, 14));
    }
    a.globalAlpha = 1;

    const cols = 5 + (s % 3);
    const rows = 18;
    const mw = colw / cols, mh = size / rows;
    const pad = Math.min(mw, mh) * 0.19;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const wx = x0 + c * mw + pad;
        const wy = r * mh + pad;
        const ww = mw - pad * 2;
        const wh = mh - pad * 2;
        const lit = rng() < 0.42;
        // glass in daylight = dark blue-grey reflective
        const gl = a.createLinearGradient(wx, wy, wx, wy + wh);
        gl.addColorStop(0, '#8fa6bd');
        gl.addColorStop(0.4, '#26313e');
        gl.addColorStop(1, '#161d26');
        a.fillStyle = gl;
        a.fillRect(wx, wy, ww, wh);
        a.strokeStyle = 'rgba(0,0,0,.5)';
        a.lineWidth = 1;
        a.strokeRect(wx, wy, ww, wh);
        if (lit) {
          const warm = rng();
          e.fillStyle = warm < 0.62
            ? `rgb(255,${(190 + rng() * 45) | 0},${(120 + rng() * 60) | 0})`
            : warm < 0.85 ? '#cfe6ff' : '#9fffe0';
          e.globalAlpha = rng.range(0.45, 1.0);
          e.fillRect(wx, wy, ww, wh);
          e.globalAlpha = 1;
        }
      }
    }
    // ground-floor band
    a.fillStyle = 'rgba(0,0,0,.35)';
    a.fillRect(x0, size - mh * 1.2, colw, mh * 1.2);
  }

  const maps = {
    map: toTexture(alb, { srgb: true, repeat: 1 }),
    emissiveMap: toTexture(emi, { srgb: true, repeat: 1 }),
    styles,
  };
  maps.map.wrapS = THREE.ClampToEdgeWrapping;
  maps.emissiveMap.wrapS = THREE.ClampToEdgeWrapping;
  cache.set(key, maps);
  return maps;
}

/* ───────────────────────── ground cover ──────────────────────── */

export function groundMaps(size = 512) {
  if (cache.has('ground')) return cache.get('ground');
  const alb = canvas(size);
  const ctx = alb.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n1 = makeNoise2D(55);
  const n2 = makeNoise2D(155);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const patch = fbm(n1, u * 9, v * 9, 4) * 0.5 + 0.5;
      const detail = fbm(n2, u * 70, v * 70, 3) * 0.5 + 0.5;
      const t = clamp01(patch * 0.75 + detail * 0.25);
      // dry sun-bleached grass → deeper green in the hollows
      const r = lerp(96, 44, t), g = lerp(104, 78, t), b = lerp(58, 38, t);
      const i = (y * size + x) * 4;
      d[i] = r * lerp(0.85, 1.15, detail);
      d[i + 1] = g * lerp(0.85, 1.15, detail);
      d[i + 2] = b * lerp(0.85, 1.15, detail);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const h = canvas(size);
  const hc = h.getContext('2d', { willReadFrequently: true });
  const himg = hc.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = fbm(n2, x / size * 80, y / size * 80, 3) * 0.5 + 0.5;
      const i = (y * size + x) * 4;
      himg.data[i] = himg.data[i + 1] = himg.data[i + 2] = v * 255;
      himg.data[i + 3] = 255;
    }
  }
  hc.putImageData(himg, 0, 0);

  const maps = {
    map: toTexture(alb, { srgb: true, repeat: 1 }),
    normalMap: toTexture(heightToNormal(h, 1.1), { repeat: 1 }),
  };
  cache.set('ground', maps);
  return maps;
}

/* ───────────────────────── misc helpers ──────────────────────── */

/** Soft radial alpha sprite — smoke, dust, light glow. */
export function radialSprite(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', pow = 1) {
  const key = `radial${size}${inner}${outer}${pow}`;
  if (cache.has(key)) return cache.get(key);
  const cv = canvas(size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const a = Math.pow(1 - t, pow);
    g.addColorStop(t, i === 0 ? inner : `rgba(255,255,255,${a})`);
  }
  void outer;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = toTexture(cv, { srgb: true, repeat: 1, mips: true });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, t);
  return t;
}

/** Puffy smoke particle with internal turbulence. */
export function smokeSprite(size = 128) {
  if (cache.has('smoke')) return cache.get('smoke');
  const cv = canvas(size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n = makeNoise2D(707);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const r = Math.hypot(dx, dy);
      const turb = fbm(n, x / size * 6, y / size * 6, 4, 2.2, 0.55) * 0.5 + 0.5;
      let a = clamp01(1 - r) ;
      a = Math.pow(a, 1.5) * lerp(0.45, 1.25, turb);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = clamp01(a) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = toTexture(cv, { srgb: true, repeat: 1 });
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('smoke', t);
  return t;
}

/** Horizontal streak used for headlight beams and speed lines. */
export function streakSprite(w = 256, h = 64) {
  if (cache.has('streak')) return cache.get('streak');
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.save();
  ctx.translate(w / 2, h / 2); ctx.scale(1, h / w); ctx.translate(-w / 2, -h / 2);
  ctx.fillRect(0, 0, w, w);
  ctx.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('streak', t);
  return t;
}

/** Blurred blob used as the cheap contact shadow under each car. */
export function blobShadow(size = 256) {
  if (cache.has('blob')) return cache.get('blob');
  const cv = canvas(size);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  // Drawn as a white→black ramp on an opaque canvas: used as an alphaMap the
  // green channel becomes the opacity, which behaves identically everywhere.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(150,150,150,1)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g;
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(1, 0.52);
  ctx.translate(-size / 2, -size / 2);
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  cache.set('blob', t);
  return t;
}

export function disposeTextures() {
  for (const v of cache.values()) {
    if (v?.isTexture) v.dispose();
    else if (v && typeof v === 'object') for (const t of Object.values(v)) t?.isTexture && t.dispose();
  }
  cache.clear();
}
