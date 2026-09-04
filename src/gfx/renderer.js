/**
 * Rendering backbone: WebGL2 context, HDR composer chain, image-based
 * lighting baked from the live sky, and an adaptive resolution controller
 * that trades pixels for frame rate on weaker devices.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

import { Sky, solarState, WEATHER } from './sky.js';
import { ApexFinishShader, WetSheenShader } from './postfx.js';
import { applyEnvironment, setAnisotropy } from './materials.js';
import { clamp, clamp01, damp, lerp, RollingMean } from '../core/util.js';

export class Renderer {
  constructor(canvas, preset) {
    this.preset = preset;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,             // SMAA handles this in the composer
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    });

    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio || 1, preset.pixelRatio));
    r.setSize(innerWidth, innerHeight, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.46;
    r.shadowMap.enabled = preset.shadows;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.shadowMap.autoUpdate = true;
    r.info.autoReset = true;

    this.maxAniso = Math.min(preset.anisotropy, r.capabilities.getMaxAnisotropy());
    setAnisotropy(this.maxAniso);

    /* ── scene + cameras ─────────────────────────────────────── */
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.18, preset.drawDistance);
    this.camera.position.set(0, 3, 9);

    this.scene.fog = new THREE.FogExp2(0x9fb6cf, 0.00055);

    /* ── sky + sun ───────────────────────────────────────────── */
    this.sky = new Sky();
    this.scene.add(this.sky.mesh);

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = preset.shadows;
    this.configureShadow(preset.shadowSize);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9fc7ff, 0x3a3428, 0.28);
    this.scene.add(this.hemi);

    // Fill light opposite the sun keeps shadowed bodywork from going flat.
    this.fill = new THREE.DirectionalLight(0x8fb4ff, 0.25);
    this.scene.add(this.fill);

    /* ── IBL ─────────────────────────────────────────────────── */
    this.pmrem = new THREE.PMREMGenerator(r);
    this.pmrem.compileCubemapShader();

    this.skyScene = new THREE.Scene();
    this.skyScene.add(this.sky.probeMesh);

    this.envCubeRT = new THREE.WebGLCubeRenderTarget(preset.envRes, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.envCubeCam = new THREE.CubeCamera(0.5, 400, this.envCubeRT);

    this.probeCubeRT = null;
    this.probeCubeCam = null;
    if (preset.dynamicEnv) {
      this.probeCubeRT = new THREE.WebGLCubeRenderTarget(preset.envRes, {
        type: THREE.HalfFloatType,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.probeCubeCam = new THREE.CubeCamera(0.5, Math.min(preset.drawDistance, 900), this.probeCubeRT);
    }

    this.skyPMREM = null;
    this.probePMREM = null;
    this._envDirty = true;
    this._probeFrame = 0;

    /* ── composer ────────────────────────────────────────────── */
    this.buildComposer();

    /* ── adaptive resolution ─────────────────────────────────── */
    this.frameTimes = new RollingMean(45, 16.7);
    this.renderScale = preset.renderScale;
    this._targetScale = preset.renderScale;
    this._scaleCooldown = 0;
    this.adaptive = true;

    this._sunScreen = new THREE.Vector3();
    this._tmpV = new THREE.Vector3();
    this._solar = null;
    this.timeOfDay = 0.34;
    this.weather = 'clear';
    this.wetness = 0;

    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize, { passive: true });
    addEventListener('orientationchange', this._onResize, { passive: true });
  }

  configureShadow(size) {
    const s = this.sun.shadow;
    s.mapSize.set(size, size);
    s.camera.near = 1;
    s.camera.far = 260;
    const half = 62;
    s.camera.left = -half; s.camera.right = half;
    s.camera.top = half; s.camera.bottom = -half;
    s.bias = -0.0006;
    s.normalBias = 0.035;
    s.radius = 2.4;
    s.camera.updateProjectionMatrix();
  }

  buildComposer() {
    const p = this.preset;
    const w = Math.max(2, Math.floor(innerWidth));
    const h = Math.max(2, Math.floor(innerHeight));

    if (this.composer) this.composer.dispose?.();

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    if (p.bloom) {
      // Threshold lives in scene-linear HDR, not display space: with an exposure
      // of ~0.46 anything past ~3 already clips, so bloom starts there. The
      // radius stays tight — a wide one turns the bright sky into a grey veil.
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), p.bloomStrength, 0.28, 11.0);
      this.composer.addPass(this.bloom);
    }

    if (p.reflectiveGround) {
      this.wetPass = new ShaderPass(WetSheenShader);
      this.wetPass.uniforms.amount.value = 0;
      this.composer.addPass(this.wetPass);
    }

    const finish = { ...ApexFinishShader, defines: { ...ApexFinishShader.defines } };
    finish.defines.BLUR_TAPS = p.motionBlur ? (p.key === 'ultra' ? '12' : '8') : '2';
    finish.defines.SHAFT_TAPS = p.key === 'low' ? '6' : p.key === 'ultra' ? '14' : '10';
    finish.defines.USE_SHAFTS = p.key === 'low' ? '0' : '1';
    finish.defines.USE_GRAIN = p.grain ? '1' : '0';
    finish.defines.USE_CHROMA = p.chromatic ? '1' : '0';
    this.finishPass = new ShaderPass(finish);
    this.finishPass.uniforms.resolution.value.set(w, h);
    this.composer.addPass(this.finishPass);

    if (p.smaa) {
      this.smaa = new SMAAPass();
      this.composer.addPass(this.smaa);
    }

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);
  }

  /** Re-apply a quality preset at runtime (settings panel). */
  applyPreset(preset) {
    this.preset = preset;
    const r = this.renderer;
    r.setPixelRatio(Math.min(devicePixelRatio || 1, preset.pixelRatio));
    r.shadowMap.enabled = preset.shadows;
    this.sun.castShadow = preset.shadows;
    this.configureShadow(preset.shadowSize);
    this.maxAniso = Math.min(preset.anisotropy, r.capabilities.getMaxAnisotropy());
    setAnisotropy(this.maxAniso);
    this.camera.far = preset.drawDistance;
    this.camera.updateProjectionMatrix();
    this.renderScale = this._targetScale = preset.renderScale;

    if (preset.dynamicEnv && !this.probeCubeCam) {
      this.probeCubeRT = new THREE.WebGLCubeRenderTarget(preset.envRes, {
        type: THREE.HalfFloatType, generateMipmaps: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      });
      this.probeCubeCam = new THREE.CubeCamera(0.5, Math.min(preset.drawDistance, 900), this.probeCubeRT);
    }
    this.buildComposer();
    this.resize();
    this._envDirty = true;
  }

  /* ── environment / time of day ───────────────────────────── */

  setTimeOfDay(t, weather = this.weather) {
    this.timeOfDay = t;
    this.weather = weather;
    const s = solarState(t);
    const w = WEATHER[weather] || WEATHER.clear;
    this._solar = s;
    this.wetness = w.wet;

    this.sky.setSun(s.dir);
    const u = this.sky.uniforms;
    u.turbidity.value = s.turbidity * w.turbidityMul;
    u.rayleigh.value = s.rayleigh;
    u.mieCoefficient.value = s.mieCoefficient;
    u.mieDirectionalG.value = s.mieDirectionalG;
    u.cloudCover.value = w.cloudCover;
    u.cloudSharp.value = w.cloudSharp;
    u.nightMix.value = s.night;
    u.exposure.value = s.exposure;
    u.groundColor.value.copy(s.fogColor).multiplyScalar(0.62);

    this.sun.position.copy(s.dir).multiplyScalar(160);
    this.sun.color.copy(s.sunColor);
    this.sun.intensity = s.sunIntensity + s.moonIntensity;
    if (s.night > 0.5) this.sun.color.setRGB(0.55, 0.66, 0.95);

    this.fill.position.copy(s.dir).multiplyScalar(-120).setY(60);
    this.fill.color.copy(s.skyAmbient);
    this.fill.intensity = 0.18 + s.above * 0.22;

    this.hemi.color.copy(s.skyAmbient);
    this.hemi.groundColor.copy(s.groundAmbient);
    this.hemi.intensity = s.ambientIntensity;

    this.scene.fog.color.copy(s.fogColor);
    this.scene.fog.density = (0.00042 + (1 - s.above) * 0.00055) * w.fogMul;

    if (this.wetPass) this.wetPass.uniforms.amount.value = w.wet;
    this.finishPass.uniforms.shaftColor.value.copy(s.sunColor).lerp(new THREE.Color(1, 1, 1), 0.25);

    this._envDirty = true;
    return s;
  }

  get solar() { return this._solar; }

  /** Bake the sky into a PMREM cube — this is the scene's ambient light. */
  bakeSkyEnvironment() {
    const r = this.renderer;
    const prevTone = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;

    const uMax = this.sky.uniforms.maxRadiance;
    const shown = uMax.value;
    uMax.value = 34.0;                    // tame the sun disc for convolution
    this.envCubeCam.position.set(0, 0, 0);
    this.envCubeCam.update(r, this.skyScene);
    uMax.value = shown;

    this.skyPMREM = this.pmrem.fromCubemap(this.envCubeRT.texture, this.skyPMREM);
    r.toneMapping = prevTone;

    if (!this.preset.dynamicEnv || !this.probePMREM) {
      this.scene.environment = this.skyPMREM.texture;
      applyEnvironment(this.skyPMREM.texture, 1);
    }
    this._envDirty = false;
  }

  /**
   * Local reflection probe: re-renders the world from the car so buildings,
   * kerbs and streetlights show up in the paint. Spread across frames.
   */
  updateProbe(position, hideList = []) {
    if (!this.probeCubeCam) return;
    const r = this.renderer;
    const prevTone = r.toneMapping;
    const prevShadow = r.shadowMap.autoUpdate;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.autoUpdate = false;

    for (const o of hideList) o.visible = false;
    this.sky.mesh.position.copy(position);
    this.probeCubeCam.position.copy(position);
    this.probeCubeCam.update(r, this.scene);
    for (const o of hideList) o.visible = true;

    this.probePMREM = this.pmrem.fromCubemap(this.probeCubeRT.texture, this.probePMREM);
    r.toneMapping = prevTone;
    r.shadowMap.autoUpdate = prevShadow;

    this.scene.environment = this.probePMREM.texture;
    applyEnvironment(this.probePMREM.texture, 1);
  }

  /* ── per-frame ───────────────────────────────────────────── */

  updateSunShadow(focus) {
    if (!this.preset.shadows) return;
    // Keep the shadow frustum snapped to texel grid to stop crawling edges.
    const s = this._solar;
    if (!s) return;
    const texelWorld = (124) / this.preset.shadowSize;
    const fx = Math.round(focus.x / texelWorld) * texelWorld;
    const fz = Math.round(focus.z / texelWorld) * texelWorld;
    this.sun.target.position.set(fx, 0, fz);
    this.sun.position.set(fx + s.dir.x * 120, s.dir.y * 120 + 8, fz + s.dir.z * 120);
    this.sun.target.updateMatrixWorld();
  }

  /** Project the sun into screen space for the shaft pass. */
  updateSunShafts(strength) {
    const s = this._solar;
    if (!s || !this.finishPass) return;
    this._tmpV.copy(s.dir).multiplyScalar(900).add(this.camera.position);
    this._tmpV.project(this.camera);
    const behind = this._tmpV.z > 1;
    const u = (this._tmpV.x * 0.5) + 0.5;
    const v = (this._tmpV.y * 0.5) + 0.5;
    const edge = clamp01(1.35 - Math.max(Math.abs(this._tmpV.x), Math.abs(this._tmpV.y)));
    const vis = behind ? 0 : edge * clamp01(s.above * 2.4) * strength;
    this.finishPass.uniforms.sunScreen.value.set(u, v, vis);
    this.finishPass.uniforms.shaftStrength.value = vis > 0 ? 0.85 : 0;
  }

  setSpeedBlur(amount, centerX = 0.5, centerY = 0.5) {
    const u = this.finishPass.uniforms;
    u.speedBlur.value = this.preset.motionBlur ? amount : 0;
    u.blurCenter.value.set(centerX, centerY);
  }

  setDamageFlash(v) { this.finishPass.uniforms.damageFlash.value = v; }
  setHeatHaze(v) { this.finishPass.uniforms.heatHaze.value = v; }

  /** Adaptive resolution: keep the frame under ~16.7 ms where possible. */
  tuneResolution(frameMs, dt) {
    if (!this.adaptive) return;
    const mean = this.frameTimes.push(frameMs);
    this._scaleCooldown -= dt;
    if (this._scaleCooldown > 0) return;

    const lo = this.preset.key === 'low' ? 0.55 : 0.62;
    if (mean > 21.5 && this._targetScale > lo) {
      this._targetScale = Math.max(lo, this._targetScale - 0.08);
      this._scaleCooldown = 1.1;
    } else if (mean < 13.6 && this._targetScale < this.preset.renderScale) {
      this._targetScale = Math.min(this.preset.renderScale, this._targetScale + 0.05);
      this._scaleCooldown = 2.0;
    }
    if (Math.abs(this.renderScale - this._targetScale) > 0.004) {
      this.renderScale = damp(this.renderScale, this._targetScale, 6, dt);
      this.applyRenderScale();
    }
  }

  applyRenderScale() {
    const w = Math.max(2, Math.floor(innerWidth * this.renderScale));
    const h = Math.max(2, Math.floor(innerHeight * this.renderScale));
    this.composer.setSize(w, h);
    this.finishPass.uniforms.resolution.value.set(w, h);
    if (this.bloom) this.bloom.setSize(w, h);
  }

  resize() {
    const w = Math.max(2, innerWidth);
    const h = Math.max(2, innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, this.preset.pixelRatio));
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.applyRenderScale();
    if (this.smaa) this.smaa.setSize(w * this.renderScale, h * this.renderScale);
  }

  update(dt, elapsed) {
    this.sky.advance(dt);
    this.sky.mesh.position.copy(this.camera.position);
    this.finishPass.uniforms.time.value = elapsed;
    if (this._envDirty) this.bakeSkyEnvironment();
  }

  render() {
    this.composer.render();
  }

  /** Direct (non-composer) render — used for the lightweight garage preview. */
  renderDirect(scene, camera) {
    this.renderer.setRenderTarget(null);
    this.renderer.render(scene, camera);
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  dispose() {
    removeEventListener('resize', this._onResize);
    removeEventListener('orientationchange', this._onResize);
    this.composer?.dispose?.();
    this.pmrem?.dispose();
    this.envCubeRT?.dispose();
    this.probeCubeRT?.dispose();
    this.skyPMREM?.dispose();
    this.probePMREM?.dispose();
    this.sky.dispose();
    this.renderer.dispose();
  }
}

export { clamp, lerp };
