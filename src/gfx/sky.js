/**
 * Physically-inspired sky dome.
 *
 * Rayleigh + Mie single scattering (Preetham analytic model) with a
 * procedural cloud deck, a sun disc with limb glow, stars and a moon.
 * The same material is rendered into a cube map so the atmosphere also
 * lights the scene through IBL — the sky the player sees *is* the light.
 */
import * as THREE from 'three';
import { clamp01, lerp, TAU } from '../core/util.js';

const VERT = /* glsl */`
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const vec3 up = vec3(0.0, 1.0, 0.0);
const float e = 2.71828182845904523536028747135266249775724709369995957;
const float pi = 3.141592653589793238462643383279502884197169;

// wavelength-dependent scattering constants for 680/550/450 nm
const vec3 totalRayleigh = vec3(5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5);
const vec3 MieConst = vec3(1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14);

const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
}

vec3 totalMie(float T) {
  float c = (0.2 * T) * 10e-18;
  return 0.434 * c * MieConst;
}

void main() {
  // Direction only: the dome is translated to follow the camera, so the
  // view ray must be taken relative to the dome centre, not the origin.
  vWorldPosition = mat3(modelMatrix) * position;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  vSunDirection = normalize(sunPosition);
  vSunE = sunIntensity(dot(vSunDirection, up));
  vSunfade = 1.0 - clamp(1.0 - exp((sunPosition.y / 450000.0)), 0.0, 1.0);

  float rayleighCoefficient = rayleigh - (1.0 * (1.0 - vSunfade));
  vBetaR = totalRayleigh * rayleighCoefficient;
  vBetaM = totalMie(turbidity) * mieCoefficient;
}
`;

const FRAG = /* glsl */`
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying float vSunfade;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float mieDirectionalG;
uniform float cloudCover;      // 0 = clear, 1 = overcast
uniform float cloudSharp;
uniform float cloudScale;
uniform float cloudHeight;
uniform vec2  cloudWind;
uniform float nightMix;        // 0 day .. 1 night
uniform float exposure;
uniform float maxRadiance;
uniform vec3  groundColor;
uniform vec3  moonDir;

const vec3 up = vec3(0.0, 1.0, 0.0);
const float pi = 3.141592653589793238462643383279502884197169;
const float rayleighZenithLength = 8.4e3;
const float mieZenithLength = 1.25e3;
const float sunAngularDiameterCos = 0.9999566769464483;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) { return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0)); }

float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inv = 1.0 / pow(max(0.0, 1.0 - 2.0 * g * cosTheta + g2), 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inv);
}

/* ── hash / value noise ── */
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) {
  float s = 0.0, a = 0.55;
  mat2 m = mat2(1.62, 1.2, -1.2, 1.62);
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = m * p; a *= 0.5; }
  return s;
}

/* Cloud deck: the view ray is intersected with a flat slab at cloudHeight,
   which is cheap and reads convincingly for anything above ~10° elevation. */
vec2 cloudUv(vec3 dir) {
  return (dir.xz / max(dir.y, 0.035)) * cloudScale + cloudWind;
}

float cloudDensity(vec2 uv) {
  float d = fbm2(uv);
  return smoothstep(cloudCover, cloudCover + cloudSharp, d);
}

float starField(vec3 dir) {
  vec3 p = dir * 260.0;
  vec3 c = floor(p);
  float h = hash31(c);
  float bright = pow(max(h - 0.972, 0.0) * 36.0, 3.0);
  float d = length(fract(p) - 0.5);
  float tw = 0.75 + 0.25 * sin(hash31(c + 7.3) * 40.0);
  return bright * smoothstep(0.42, 0.03, d) * tw;
}

void main() {
  vec3 direction = normalize(vWorldPosition);

  /* ── optical depth toward the horizon ── */
  float zenithAngle = acos(max(0.0, dot(up, direction)));
  float inv = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inv;
  float sM = mieZenithLength * inv;

  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

  float cosTheta = dot(direction, vSunDirection);
  vec3 betaRTheta = vBetaR * rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaMTheta = vBetaM * hgPhase(cosTheta, mieDirectionalG);

  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(
    vec3(1.0),
    pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)),
    clamp(pow(1.0 - dot(up, vSunDirection), 5.0), 0.0, 1.0)
  );

  /* ── sun disc with a soft limb ── */
  float sundisk = smoothstep(sunAngularDiameterCos, sunAngularDiameterCos + 0.000045, cosTheta);
  vec3 L0 = vec3(0.1) * Fex;
  L0 += (vSunE * 5200.0 * Fex) * sundisk;
  // broad forward glow around the sun
  L0 += vSunE * 18.0 * Fex * pow(max(cosTheta, 0.0), 320.0);

  vec3 sky = (Lin + L0) * 0.04 + vec3(0.0, 0.00035, 0.0009);

  /* ── night: stars + moon ── */
  if (nightMix > 0.001) {
    float s = starField(direction) * smoothstep(-0.02, 0.16, direction.y);
    vec3 night = vec3(0.006, 0.010, 0.024) * (0.4 + 0.6 * smoothstep(-0.1, 0.5, direction.y));
    night += vec3(1.0, 0.97, 0.9) * s * 1.6;
    float md = dot(direction, normalize(moonDir));
    night += vec3(0.85, 0.88, 1.0) * smoothstep(0.9994, 0.99965, md) * 4.0;
    night += vec3(0.30, 0.36, 0.52) * pow(max(md, 0.0), 700.0) * 0.6;
    sky = mix(sky, night, nightMix);
  }

  /* ── cloud deck ── */
  float above = smoothstep(0.012, 0.13, direction.y);
  if (above > 0.001 && cloudCover < 0.995) {
    vec2 uv = cloudUv(direction);
    float d = cloudDensity(uv);
    // second sample toward the sun approximates self-shadowing
    vec2 sunOff = normalize(vSunDirection.xz + vec2(1e-4)) * 0.22;
    float ds = cloudDensity(uv - sunOff);
    float lit = clamp((d - ds) * 1.6 + 0.42, 0.0, 1.0);

    float sunUp = clamp(vSunDirection.y * 1.6 + 0.12, 0.0, 1.0);
    vec3 litCol = mix(vec3(0.36, 0.30, 0.34), vec3(1.06, 1.02, 0.98), sunUp);
    vec3 shdCol = mix(vec3(0.10, 0.10, 0.15), vec3(0.44, 0.47, 0.55), sunUp);
    // warm rim where the sun grazes the cloud edge
    litCol += vec3(0.55, 0.24, 0.05) * pow(max(cosTheta, 0.0), 12.0) * (1.0 - sunUp) * 1.4;

    vec3 cloudCol = mix(shdCol, litCol, lit) * (1.0 - nightMix * 0.82);
    // silver lining right at the sun
    cloudCol += vec3(1.0, 0.92, 0.78) * pow(max(cosTheta, 0.0), 90.0) * d * 1.2;

    float a = d * above * 0.94;
    sky = mix(sky, cloudCol, a);
  }

  /* ── below the horizon fades into ground haze ── */
  float belowT = smoothstep(0.02, -0.06, direction.y);
  sky = mix(sky, groundColor * (1.0 - nightMix * 0.7), belowT);

  // Hard-clamp the radiance. The sun disc is otherwise bright enough to
  // overflow a half-float cube map to +Inf, and the PMREM convolution then
  // smears NaN across the entire environment.
  sky = min(sky * exposure, vec3(maxRadiance));

  gl_FragColor = vec4(sky, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class Sky {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      name: 'ApexSky',
      uniforms: {
        turbidity: { value: 2.6 },
        rayleigh: { value: 2.75 },
        mieCoefficient: { value: 0.0042 },
        mieDirectionalG: { value: 0.80 },
        sunPosition: { value: new THREE.Vector3(0, 1, 0) },
        cloudCover: { value: 0.46 },
        cloudSharp: { value: 0.34 },
        cloudScale: { value: 0.55 },
        cloudHeight: { value: 900 },
        cloudWind: { value: new THREE.Vector2() },
        nightMix: { value: 0 },
        exposure: { value: 1.0 },
        maxRadiance: { value: 26.0 },
        groundColor: { value: new THREE.Color(0x2a2e33) },
        moonDir: { value: new THREE.Vector3(0, -1, 0) },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });

    this.geometry = new THREE.SphereGeometry(1, 48, 24);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.scale.setScalar(60);
    this.mesh.renderOrder = -10000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'sky';

    // Separate identical dome used only for baking the environment cube map.
    this.probeMesh = new THREE.Mesh(this.geometry, this.material);
    this.probeMesh.scale.setScalar(60);
    this.probeMesh.frustumCulled = false;

    this._wind = new THREE.Vector2();
  }

  get uniforms() { return this.material.uniforms; }

  /** Update the wind drift of the cloud deck. */
  advance(dt, speed = 1) {
    this._wind.x += dt * 0.0075 * speed;
    this._wind.y += dt * 0.0032 * speed;
    this.uniforms.cloudWind.value.copy(this._wind);
  }

  setSun(dir) {
    this.uniforms.sunPosition.value.copy(dir).multiplyScalar(450000);
    this.uniforms.moonDir.value.copy(dir).multiplyScalar(-1);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ─────────────────── time-of-day driven presets ─────────────────── */

/**
 * Maps a 0..1 clock (0 = midnight, 0.5 = noon) onto sun direction plus the
 * matching atmosphere and light colours.
 */
export function solarState(timeOfDay, latitudeTilt = 0.28) {
  const t = ((timeOfDay % 1) + 1) % 1;
  const ang = (t - 0.25) * TAU;             // sunrise at t=0.25
  const elev = Math.sin(ang);
  const azim = Math.cos(ang);

  const dir = new THREE.Vector3(
    azim * Math.cos(latitudeTilt),
    elev,
    azim * Math.sin(latitudeTilt) + 0.34 * (1 - Math.abs(elev))
  ).normalize();

  const above = clamp01(elev);
  const night = clamp01(-elev * 5.0);
  const twilight = clamp01(1 - Math.abs(elev) * 7.0);

  // Sun colour: deep amber at the horizon → neutral white overhead.
  const sunCol = new THREE.Color().setRGB(
    lerp(1.0, 1.0, above),
    lerp(0.46, 0.965, Math.pow(above, 0.45)),
    lerp(0.18, 0.92, Math.pow(above, 0.35))
  );

  const sunIntensity = lerp(0.02, 4.20, Math.pow(above, 0.62));
  const moonIntensity = night * 0.22;

  const skyAmbient = new THREE.Color().setRGB(
    lerp(0.05, 0.42, above), lerp(0.07, 0.56, above), lerp(0.16, 0.86, above)
  );
  const groundAmbient = new THREE.Color().setRGB(
    lerp(0.03, 0.30, above), lerp(0.03, 0.27, above), lerp(0.05, 0.22, above)
  );
  const ambientIntensity = lerp(0.10, 0.34, above) + twilight * 0.06;

  const fogColor = new THREE.Color().setRGB(
    lerp(0.030, 0.60, above) + twilight * 0.22,
    lerp(0.040, 0.70, above) + twilight * 0.08,
    lerp(0.075, 0.88, above)
  );

  return {
    dir, elev, above, night, twilight,
    sunColor: sunCol,
    sunIntensity,
    moonIntensity,
    skyAmbient, groundAmbient, ambientIntensity,
    fogColor,
    turbidity: lerp(2.6, 7.5, twilight),
    rayleigh: lerp(2.75, 3.6, twilight),
    mieCoefficient: lerp(0.0040, 0.0125, twilight),
    mieDirectionalG: lerp(0.78, 0.86, twilight),
    exposure: lerp(0.86, 1.0, above),
    headlightsOn: elev < 0.10,
  };
}

export const WEATHER = {
  clear:  { cloudCover: 0.58, cloudSharp: 0.30, turbidityMul: 1.0,  wet: 0.0,  fogMul: 1.0 },
  wet:    { cloudCover: 0.26, cloudSharp: 0.46, turbidityMul: 1.45, wet: 0.85, fogMul: 1.9 },
  dusk:   { cloudCover: 0.44, cloudSharp: 0.34, turbidityMul: 1.2,  wet: 0.25, fogMul: 1.3 },
  night:  { cloudCover: 0.62, cloudSharp: 0.30, turbidityMul: 1.0,  wet: 0.35, fogMul: 1.15 },
};
