/**
 * PBR material factory. All car surfaces use MeshPhysicalMaterial so we get
 * a real clearcoat lobe on top of the metallic flake base — that second
 * specular layer is what makes rendered car paint read as *paint* rather
 * than as shiny plastic.
 */
import * as THREE from 'three';
import { carbonMaps, flakeNormal, tyreMaps, brakeDiscMaps, alcantaraMaps } from './textures.js';

let ANISO = 8;
export function setAnisotropy(v) { ANISO = v; }

const registry = new Set();
function reg(m) { registry.add(m); return m; }

/**
 * Metallic / pearlescent car paint.
 * @param {object} spec  { color, flake, metalness, roughness, clearcoat, pearl }
 */
export function carPaint(spec = {}) {
  const {
    color = 0xff8a2b,
    metalness = 0.48,
    roughness = 0.28,
    clearcoat = 1.0,
    clearcoatRoughness = 0.035,
    flake = 0.55,
    pearl = 0,
    sheenColor = null,
  } = spec;

  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness,
    roughness,
    clearcoat,
    clearcoatRoughness,
    envMapIntensity: 1.05,
    side: THREE.FrontSide,
  });

  if (flake > 0) {
    const fn = flakeNormal();
    m.normalMap = fn;
    m.normalScale = new THREE.Vector2(flake * 0.42, flake * 0.42);
    m.normalMap.repeat.set(46, 46);
    m.normalMap.anisotropy = ANISO;
  }
  if (pearl > 0) {
    // A thin-film interference layer gives the colour-shift of a pearl coat.
    m.iridescence = pearl;
    m.iridescenceIOR = 1.42;
    m.iridescenceThicknessRange = [120, 460];
  }
  if (sheenColor) {
    m.sheen = 0.35;
    m.sheenColor = new THREE.Color(sheenColor);
    m.sheenRoughness = 0.4;
  }
  return reg(m);
}

/** Satin / matt paint (Zonda-style bare-carbon-adjacent finishes). */
export function satinPaint(color = 0x1b1e24, roughness = 0.44) {
  return reg(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.5,
    roughness,
    clearcoat: 0.55,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.95,
  }));
}

/** Exposed carbon fibre with a glossy lacquer over the weave. */
export function carbonFibre({ scale = 1, clear = 1.0, tint = 0xffffff } = {}) {
  const maps = carbonMaps();
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tint),
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    metalness: 0.30,
    roughness: 0.32,
    clearcoat: clear,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.1,
  });
  for (const t of [m.map, m.normalMap, m.roughnessMap]) {
    t.repeat.set(6 * scale, 6 * scale);
    t.anisotropy = ANISO;
  }
  m.normalScale = new THREE.Vector2(0.7, 0.7);
  return reg(m);
}

/** Tinted automotive glass. Physically transmissive on high quality only. */
export function glass({ tint = 0x070b11, opacity = 0.80, transmission = 0, rough = 0.045 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(tint),
    metalness: 0.05,
    roughness: rough,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    transparent: transmission === 0,
    opacity: transmission === 0 ? opacity : 1,
    transmission,
    thickness: transmission > 0 ? 0.06 : 0,
    ior: 1.46,
    envMapIntensity: 1.05,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
  return reg(m);
}

/** Polished chrome / titanium / anodised metals. */
export function metal({ color = 0xc9ced6, roughness = 0.14, metalness = 1.0, env = 1.6 } = {}) {
  return reg(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness, roughness,
    envMapIntensity: env,
  }));
}

/** Heat-tinted titanium exhaust tips. */
export function heatedTitanium() {
  return reg(new THREE.MeshPhysicalMaterial({
    color: 0x8e7f7a,
    metalness: 1.0,
    roughness: 0.28,
    iridescence: 0.85,
    iridescenceIOR: 2.0,
    iridescenceThicknessRange: [200, 700],
    envMapIntensity: 1.5,
  }));
}

/** Matte structural plastic — bumper inserts, vents, splitter under-trays. */
export function matteBlack(roughness = 0.72, color = 0x0d1014) {
  return reg(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    metalness: 0.12,
    roughness,
    envMapIntensity: 0.55,
  }));
}

/** Tyre rubber with tread normal + sidewall lettering roughness. */
export function tyreRubber() {
  const maps = tyreMaps();
  const m = new THREE.MeshPhysicalMaterial({
    color: 0x14161a,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    metalness: 0.0,
    roughness: 0.86,
    envMapIntensity: 0.35,
    sheen: 0.22,
    sheenColor: new THREE.Color(0x2a2d33),
    sheenRoughness: 0.9,
  });
  m.normalMap.repeat.set(1, 1);
  m.normalMap.anisotropy = ANISO;
  m.normalScale = new THREE.Vector2(1.15, 1.15);
  return reg(m);
}

/** Cross-drilled carbon-ceramic disc. */
export function brakeDisc() {
  const maps = brakeDiscMaps();
  return reg(new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    metalness: 0.85,
    roughness: 0.36,
    envMapIntensity: 0.9,
    side: THREE.DoubleSide,
  }));
}

/** Suede-like cabin trim. */
export function alcantara(color = 0x191c22) {
  const maps = alcantaraMaps();
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    normalMap: maps.normalMap,
    roughness: 0.95,
    metalness: 0,
    sheen: 0.85,
    sheenColor: new THREE.Color(0x555c68),
    sheenRoughness: 0.85,
    envMapIntensity: 0.3,
  });
  m.normalScale = new THREE.Vector2(0.6, 0.6);
  return reg(m);
}

/**
 * Light lens: emissive core wrapped in a clear cover. `power` scales the
 * emissive intensity above 1 so the bloom pass picks it up.
 */
export function lightLens({ color = 0xffffff, power = 1, rough = 0.08 } = {}) {
  return reg(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color).multiplyScalar(0.15),
    emissive: new THREE.Color(color),
    emissiveIntensity: power,
    metalness: 0.1,
    roughness: rough,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.4,
  }));
}

/** Dark reflector housing behind the lenses. */
export function reflectorHousing() {
  return reg(new THREE.MeshPhysicalMaterial({
    color: 0x05070a,
    metalness: 0.9,
    roughness: 0.22,
    envMapIntensity: 1.2,
  }));
}

/** Mesh grille — alpha-cut honeycomb, doubles as intake blanking. */
export function grilleMesh() {
  return reg(new THREE.MeshPhysicalMaterial({
    color: 0x090b0e,
    metalness: 0.55,
    roughness: 0.55,
    envMapIntensity: 0.5,
    side: THREE.DoubleSide,
  }));
}

/** Apply a shared environment map to every material we handed out. */
export function applyEnvironment(envMap, intensityScale = 1) {
  for (const m of registry) {
    m.envMap = envMap;
    if (m.userData._baseEnv === undefined) m.userData._baseEnv = m.envMapIntensity ?? 1;
    m.envMapIntensity = m.userData._baseEnv * intensityScale;
    m.needsUpdate = true;
  }
}

export function forEachMaterial(fn) { registry.forEach(fn); }

export function disposeMaterials() {
  for (const m of registry) m.dispose();
  registry.clear();
}
