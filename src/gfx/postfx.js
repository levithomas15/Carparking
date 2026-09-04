/**
 * The APEX finishing pass.
 *
 * One combined fragment shader does sun shafts, radial speed blur,
 * chromatic aberration, film grain, vignette and a filmic colour grade.
 * Folding them together keeps the mobile fill-rate cost to a single
 * full-screen pass on top of bloom.
 */
import * as THREE from 'three';

export const ApexFinishShader = {
  name: 'ApexFinish',

  defines: {
    BLUR_TAPS: '8',
    SHAFT_TAPS: '10',
    USE_SHAFTS: '1',
    USE_GRAIN: '1',
    USE_CHROMA: '1',
  },

  uniforms: {
    tDiffuse:     { value: null },
    resolution:   { value: new THREE.Vector2(1, 1) },
    time:         { value: 0 },

    speedBlur:    { value: 0.0 },
    blurCenter:   { value: new THREE.Vector2(0.5, 0.5) },

    sunScreen:    { value: new THREE.Vector3(0.5, 0.5, 0) },  // xy = uv, z = visibility
    shaftStrength:{ value: 0.0 },
    shaftColor:   { value: new THREE.Color(1.0, 0.82, 0.55) },

    chroma:       { value: 0.0022 },
    vignette:     { value: 0.36 },
    grain:        { value: 0.030 },

    lift:         { value: new THREE.Vector3(0.004, 0.006, 0.014) },
    gain:         { value: new THREE.Vector3(1.035, 1.005, 0.985) },
    gammaC:       { value: new THREE.Vector3(1.0, 1.0, 1.02) },
    saturation:   { value: 1.12 },
    contrast:     { value: 1.06 },

    damageFlash:  { value: 0.0 },
    heatHaze:     { value: 0.0 },
  },

  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,

  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2  resolution;
    uniform float time;

    uniform float speedBlur;
    uniform vec2  blurCenter;

    uniform vec3  sunScreen;
    uniform float shaftStrength;
    uniform vec3  shaftColor;

    uniform float chroma;
    uniform float vignette;
    uniform float grain;

    uniform vec3  lift;
    uniform vec3  gain;
    uniform vec3  gammaC;
    uniform float saturation;
    uniform float contrast;

    uniform float damageFlash;
    uniform float heatHaze;

    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 uv = vUv;

      // ── heat shimmer off the exhaust / hot tarmac ──
      #if USE_GRAIN
      if (heatHaze > 0.0001) {
        float w = sin(uv.y * 90.0 + time * 7.0) * cos(uv.x * 60.0 - time * 4.0);
        uv.x += w * heatHaze * 0.0035 * smoothstep(0.55, 0.05, uv.y);
      }
      #endif

      // ── radial speed blur toward the vanishing point ──
      vec3 col;
      if (speedBlur > 0.001) {
        vec2 dir = (uv - blurCenter);
        float acc = 0.0;
        col = vec3(0.0);
        for (int i = 0; i < BLUR_TAPS; i++) {
          float t = float(i) / float(BLUR_TAPS - 1);
          float scale = 1.0 - t * speedBlur * 0.14;
          // weight the sharp centre sample the highest
          float w = mix(1.0, 0.34, t);
          col += texture2D(tDiffuse, blurCenter + dir * scale).rgb * w;
          acc += w;
        }
        col /= acc;
      } else {
        col = texture2D(tDiffuse, uv).rgb;
      }

      // ── chromatic aberration, strongest at the frame edges ──
      #if USE_CHROMA
      {
        vec2 d = uv - 0.5;
        float r2 = dot(d, d);
        float amt = chroma * (0.35 + r2 * 2.6) * (1.0 + speedBlur * 2.2);
        float cr = texture2D(tDiffuse, uv + d * amt).r;
        float cb = texture2D(tDiffuse, uv - d * amt).b;
        col.r = mix(col.r, cr, 0.85);
        col.b = mix(col.b, cb, 0.85);
      }
      #endif

      // ── volumetric sun shafts (radial light scattering) ──
      #if USE_SHAFTS
      if (shaftStrength > 0.001 && sunScreen.z > 0.001) {
        vec2 sp = sunScreen.xy;
        vec2 delta = (uv - sp) / float(SHAFT_TAPS) * 0.86;
        vec2 p = uv;
        float illum = 1.0;
        vec3 shaft = vec3(0.0);
        for (int i = 0; i < SHAFT_TAPS; i++) {
          p -= delta;
          vec3 s = texture2D(tDiffuse, clamp(p, 0.0, 1.0)).rgb;
          float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
          s *= smoothstep(14.0, 70.0, lum);
          shaft += s * illum;
          illum *= 0.94;
        }
        shaft /= float(SHAFT_TAPS);
        float falloff = pow(1.0 - clamp(length(uv - sp) * 0.75, 0.0, 1.0), 2.0);
        col += shaft * shaftColor * shaftStrength * sunScreen.z * falloff * 0.85;
      }
      #endif

      // ── filmic grade: lift / gamma / gain, then contrast + saturation ──
      col = max(col, 0.0);
      col = col * gain + lift;
      col = pow(col, 1.0 / max(gammaC, vec3(0.01)));
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, saturation);
      col = (col - 0.5) * contrast + 0.5;

      // ── impact flash ──
      if (damageFlash > 0.001) {
        col = mix(col, vec3(1.0, 0.72, 0.62), damageFlash * 0.55);
      }

      // ── vignette ──
      {
        vec2 d = (uv - 0.5) * vec2(resolution.x / max(resolution.y, 1.0), 1.0);
        float v = 1.0 - vignette * dot(d, d) * 1.25;
        col *= clamp(v, 0.0, 1.0);
      }

      // ── grain, scaled down in the highlights like real film ──
      #if USE_GRAIN
      if (grain > 0.0001) {
        float n = hash12(gl_FragCoord.xy + fract(time) * 1371.0) - 0.5;
        float lum2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col += n * grain * (1.0 - smoothstep(0.35, 1.0, lum2));
      }
      #endif

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/**
 * Cheap screen-space "wet road" sheen — a separate optional pass that adds a
 * vertical smear of bright pixels, mimicking reflections stretching on a
 * damp surface without the cost of true SSR.
 */
export const WetSheenShader = {
  name: 'WetSheen',
  uniforms: {
    tDiffuse: { value: null },
    amount:   { value: 0.0 },
    horizon:  { value: 0.5 },
  },
  vertexShader: ApexFinishShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float amount;
    uniform float horizon;
    varying vec2 vUv;

    void main() {
      vec3 base = texture2D(tDiffuse, vUv).rgb;
      if (amount < 0.001 || vUv.y > horizon) { gl_FragColor = vec4(base, 1.0); return; }

      float belowness = clamp((horizon - vUv.y) / max(horizon, 0.001), 0.0, 1.0);
      vec3 smear = vec3(0.0);
      float acc = 0.0;
      for (int i = 1; i <= 6; i++) {
        float t = float(i) / 6.0;
        float off = t * 0.055 * (0.35 + belowness);
        float w = 1.0 - t;
        smear += texture2D(tDiffuse, vec2(vUv.x, min(vUv.y + off, 1.0))).rgb * w;
        acc += w;
      }
      smear /= acc;
      float lum = dot(smear, vec3(0.2126, 0.7152, 0.0722));
      float mask = smoothstep(0.28, 1.4, lum) * belowness * amount;
      gl_FragColor = vec4(mix(base, max(base, smear), mask * 0.75), 1.0);
    }
  `,
};
