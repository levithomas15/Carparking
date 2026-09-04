/**
 * APEX — Hypercar Simulator
 * Application entry point: boots the renderer, builds the world, and runs the
 * garage → drive loop.
 */
import * as THREE from 'three';

import { settings, PRESETS } from './core/settings.js';
import { $, clamp, clamp01, lerp, damp, formatTime, isTouchDevice, vibrate, RollingMean } from './core/util.js';

import { Renderer } from './gfx/renderer.js';
import { CameraRig } from './gfx/camera.js';
import { Effects } from './gfx/particles.js';
import { applyEnvironment } from './gfx/materials.js';

import { World } from './world/meshes.js';
import { CarModel } from './cars/model.js';
import { CARS } from './cars/defs.js';
import { Vehicle } from './physics/vehicle.js';

import { Input } from './input/input.js';
import { EngineAudio } from './audio/engine.js';
import { HUD, RaceState } from './ui/hud.js';
import { Garage } from './ui/garage.js';
import { Menu } from './ui/menu.js';

const boot = $('#boot');
const bootFill = $('#boot-fill');
const bootStatus = $('#boot-status');

function progress(pct, text) {
  if (bootFill) bootFill.style.width = `${pct}%`;
  if (bootStatus && text) bootStatus.textContent = text;
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}

function fatal(err) {
  const el = $('#fatal');
  if (el) {
    el.textContent = `APEX konnte nicht starten.\n\n${err?.message || err}\n\n${(err?.stack || '').split('\n').slice(0, 8).join('\n')}`;
    el.classList.add('show');
  }
  console.error(err);
}

class Game {
  constructor() {
    this.state = 'boot';
    this.elapsed = 0;
    this.frameTimer = new RollingMean(45, 16.7);
    this.lastFrame = performance.now();
    this._probeTick = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.fps = 60;
  }

  async init() {
    await progress(6, 'Rendering-Pipeline…');
    const canvas = $('#stage');
    const tierPreset = { key: 'medium', ...PRESETS.medium };
    this.renderer = new Renderer(canvas, tierPreset);

    // now that a GL context exists we can pick the real quality tier
    const preset = settings.preset(this.renderer.renderer);
    this.preset = preset;
    this.renderer.applyPreset(preset);

    await progress(16, `Qualität: ${preset.name}`);

    this.renderer.setTimeOfDay(settings.get('timeOfDay'), settings.get('weather'));
    this.renderer.bakeSkyEnvironment();

    await progress(26, 'Strecke wird modelliert…');
    this.world = new World(preset, { seed: 20260904 });
    this.world.build();
    this.renderer.scene.add(this.world.root);

    await progress(56, 'Fahrzeuge werden gebaut…');
    this.effects = new Effects(this.renderer.scene, preset);

    this.cameraRig = new CameraRig(this.renderer.camera, { fov: settings.get('fov') });
    this.hud = new HUD();
    this.hud.prepareMinimap(this.world);

    this.input = new Input();
    this.audio = new EngineAudio();

    await progress(72, 'Showroom…');
    this.garage = new Garage(this.renderer.scene, this.renderer.camera, {
      quality: preset.key === 'low' ? 0.5 : 1,
      onDrive: (def) => this.startDrive(def),
      onSelect: () => this.audio.blip('ui'),
    });

    this.menu = new Menu({
      onChange: (k, v) => this.onSettingChange(k, v),
      onResume: () => this.resume(),
      onGarage: () => this.toGarage(),
      onPause: () => this.pauseGame(),
    });

    this.driveCar = null;
    this.vehicle = null;
    this.race = null;

    await progress(88, 'Beleuchtung wird berechnet…');
    this.applyWeather();
    this.renderer.updateSunShadow(new THREE.Vector3());

    // prime the shader cache so the first drive frame is not a stall
    this.renderer.renderer.compile(this.renderer.scene, this.renderer.camera);

    await progress(100, 'Bereit.');
    document.body.classList.toggle('no-touch', !isTouchDevice());

    setTimeout(() => {
      boot?.classList.remove('active');
      this.toGarage();
    }, 260);

    this.bindGlobal();
    this.loop();
  }

  bindGlobal() {
    // audio contexts need a gesture; arm on the first interaction
    const arm = async () => {
      await this.audio.init(this.driveCar?.audio ?? CARS[0].audio);
      this.audio.setVolumes();
      removeEventListener('pointerdown', arm);
      removeEventListener('touchstart', arm);
      removeEventListener('keydown', arm);
    };
    addEventListener('pointerdown', arm, { once: false });
    addEventListener('touchstart', arm, { once: false });
    addEventListener('keydown', arm, { once: false });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.audio.setMuted(true); }
      else { this.audio.setMuted(false); this.lastFrame = performance.now(); }
    });
  }

  onSettingChange(key, value) {
    if (key === 'quality') {
      const preset = settings.preset(this.renderer.renderer);
      this.preset = preset;
      this.renderer.applyPreset(preset);
      this.applyWeather();
      this.hud.showToast(`GRAFIK: ${preset.name}`);
    } else if (key === 'weather' || key === 'timeOfDay') {
      this.applyWeather();
    } else if (key === 'fov') {
      this.cameraRig.baseFov = value;
    } else if (key === 'assistABS' && this.vehicle) this.vehicle.abs = value;
    else if (key === 'assistTC' && this.vehicle) this.vehicle.tc = value;
    else if (key === 'assistESC' && this.vehicle) this.vehicle.esc = value;
    else if (key === 'volumeMaster' || key === 'volumeEngine') this.audio.setVolumes();
  }

  applyWeather() {
    const weather = settings.get('weather');
    let tod = settings.get('timeOfDay');
    if (weather === 'night') tod = 0.94;
    else if (weather === 'dusk') tod = 0.775;
    const solar = this.renderer.setTimeOfDay(tod, weather);
    this.renderer.bakeSkyEnvironment();
    this.world.setNight(solar.night * 0.85 + solar.twilight * 0.35);
    this.solar = solar;
  }

  /* ── mode switching ─────────────────────────────────── */

  toGarage() {
    this.state = 'garage';
    this.garage.show();
    if (this.carModel) this.carModel.group.visible = false;
    this.world.root.visible = false;
    this.effects.markMesh.visible = false;
    $('#garage')?.classList.add('active');
    $('#hud')?.classList.remove('active');
    this.menu.closePause();
    this.renderer.setSpeedBlur(0);
    this.renderer.finishPass.uniforms.shaftStrength.value = 0;
    this.renderer.scene.fog = null;
    this.renderer.sky.mesh.visible = false;
    this.renderer.setExposure(0.44);
    applyEnvironment(this.renderer.scene.environment, 0.34);
    this.audio.update(0.016, { rpm: 900, redline: 8000, throttle: 0, speed: 0, skid: 0, surfaceRumble: 0, muteEngine: true });
  }

  async startDrive(def) {
    this.garage.hide();
    $('#garage')?.classList.remove('active');
    $('#hud')?.classList.add('active');
    this.world.root.visible = true;
    this.effects.markMesh.visible = true;
    this.effects.clearMarks();
    this.renderer.sky.mesh.visible = true;
    this.renderer.setExposure(0.46);
    applyEnvironment(this.renderer.scene.environment, 1);
    this.renderer.scene.fog = this._fog ||= new THREE.FogExp2(0x9fb6cf, 0.0006);
    this.applyWeather();

    if (!this.carModel || this.carModel.def.id !== def.id) {
      if (this.carModel) {
        this.renderer.scene.remove(this.carModel.group);
        this.carModel.dispose();
      }
      this.carModel = new CarModel(def, {
        paint: settings.paintFor(def.id, 0),
        rim: settings.rimFor(def.id, def.defaultRim ?? 0),
        quality: this.preset.key === 'low' ? 0.5 : 1,
      });
      this.renderer.scene.add(this.carModel.group);
    } else {
      this.carModel.setPaint(settings.paintFor(def.id, 0));
    }
    this.carModel.group.visible = true;
    this.driveCar = def;

    const d = this.carModel.dimensions;
    this.vehicle = new Vehicle(def.phys, {
      wheelbase: d.wheelbase, trackFront: d.trackFront, trackRear: d.trackRear,
      frontR: def.wheels.frontR, rearR: def.wheels.rearR, frontZ: def.wheels.frontZ,
    }, this.world);
    this.vehicle.abs = settings.get('assistABS');
    this.vehicle.tc = settings.get('assistTC');
    this.vehicle.esc = settings.get('assistESC');

    const slot = this.world.gridSlot(0);
    this.vehicle.reset(slot.x, slot.z, slot.heading, slot.y);

    this.race = new RaceState(this.world, def.id);
    this.race.onLap = (t, best) => {
      this.hud.showToast(best ? `NEUE BESTZEIT ${formatTime(t)}` : `RUNDE ${formatTime(t)}`, best, 2.4);
      this.audio.blip('beep', best ? 2 : 1);
      if (settings.get('haptics')) vibrate(best ? [20, 40, 20] : 18);
    };
    this.race.onDriftBank = (pts) => {
      if (pts > 400) this.hud.showToast(`+${pts.toLocaleString('de-DE')} DRIFT`, false, 1.2);
    };

    this.cameraRig.setMode(settings.get('camera'));
    this.cameraRig.snapTo(this.vehicle);

    await this.audio.init(def.audio);
    this.audio.configure(def.audio);
    this.audio.blip('start');

    this.state = 'drive';
    this.hud.showToast(def.model, true, 1.8);
  }

  pauseGame() {
    if (this.state !== 'drive') return;
    this.state = 'paused';
    this.menu.openPause([
      ['Beste Runde', formatTime(this.race.bestLap)],
      ['Letzte Runde', formatTime(this.race.lastLap)],
      ['Runde', String(this.race.lap)],
      ['Top-Speed', `${Math.round(this.race.topSpeed)} km/h`],
      ['Drift-Punkte', Math.round(this.race.displayScore).toLocaleString('de-DE')],
      ['Distanz', `${(this.vehicle.odometer / 1000).toFixed(2)} km`],
    ]);
    this.audio.setMuted(true);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.menu.closePause();
    this.state = 'drive';
    this.audio.setMuted(false);
    this.lastFrame = performance.now();
  }

  respawn() {
    if (!this.vehicle) return;
    const prog = this.world.trackProgress(this.vehicle.position.x, this.vehicle.position.z);
    const s = this.world.samples[prog.index];
    this.vehicle.reset(s.pos.x, s.pos.z, Math.atan2(s.tan.x, s.tan.z), s.pos.y);
    this.cameraRig.snapTo(this.vehicle);
    this.effects.clearMarks();
    this.hud.showToast('ZURÜCKGESETZT', false, 1.0);
  }

  /* ── frame ──────────────────────────────────────────── */

  loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const frameMs = dt * 1000;
    dt = Math.min(dt, 1 / 20);
    this.elapsed += dt;

    this._fpsAcc += dt; this._fpsFrames++;
    if (this._fpsAcc > 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
    }

    try {
      if (this.state === 'garage') this.updateGarage(dt);
      else if (this.state === 'drive') this.updateDrive(dt);
      else if (this.state === 'paused') this.updatePaused(dt);

      this.renderer.update(dt, this.elapsed);
      this.renderer.render();
      this.renderer.tuneResolution(frameMs, dt);
    } catch (e) {
      fatal(e);
      this.state = 'error';
    }
  };

  updateGarage(dt) {
    this.garage.update(dt, this.elapsed);
    this.renderer.setSpeedBlur(0);
  }

  updatePaused(dt) {
    this.input.update(dt);
    if (this.input.consume('pause')) this.resume();
    this.cameraRig.update(dt * 0.15, this.vehicle, this.driveCar, this.world);
  }

  updateDrive(dt) {
    const input = this.input;
    input.update(dt);

    if (input.consume('pause')) { this.pauseGame(); return; }
    if (input.consume('reset')) this.respawn();
    if (input.consume('camera')) {
      const m = this.cameraRig.cycle();
      settings.set('camera', m);
      this.hud.cameraToast(m);
      this.audio.blip('ui');
    }
    if (input.consume('horn')) this.audio.blip('horn');
    if (input.consume('lights')) {
      this._forceLights = !this._forceLights;
      this.hud.showToast(this._forceLights ? 'LICHT AN' : 'LICHT AUS', false, 0.9);
    }

    const v = this.vehicle;
    const prevGear = v.gearIndex;

    v.update(dt, {
      throttle: input.throttle,
      brake: input.brake,
      steer: input.steer,
      handbrake: input.handbrake,
      shiftUp: input.shiftUp,
      shiftDown: input.shiftDown,
      manual: input.manual,
    });

    if (v.gearIndex !== prevGear) this.audio.blip('shift', 0.8);
    if (v.impact > 0.25 && !this._impactCool) {
      this.audio.blip('impact', v.impact);
      this.cameraRig.addShake(v.impact * 1.1);
      this.renderer.setDamageFlash(clamp01(v.impact));
      if (settings.get('haptics')) vibrate(Math.round(30 + v.impact * 60));
      this._impactCool = 0.35;
    }
    this._impactCool = Math.max(0, (this._impactCool || 0) - dt);
    this.renderer.setDamageFlash(damp(this.renderer.finishPass.uniforms.damageFlash.value, 0, 6, dt));

    /* ── model + effects ── */
    v.syncModel(this.carModel.group);
    const headlights = this._forceLights ?? this.solar?.headlightsOn ?? false;
    this.carModel.update(dt, {
      steer: input.steer,
      wheelOmega: v.wheelOmegas,
      suspension: v.suspensionOffsets,
      brake: input.brake,
      reverse: v.reverse,
      headlights,
      indicator: 0,
      speed: v.speed,
    });

    this.spawnEffects(dt, v);

    /* ── camera ── */
    this.cameraRig.update(dt, v, this.driveCar, this.world);
    const speedT = clamp01((v.speed - 12) / 68);
    this.renderer.setSpeedBlur(Math.pow(speedT, 1.4) * 0.85);
    this.renderer.updateSunShafts(0.9);
    this.renderer.updateSunShadow(v.position);
    this.renderer.setHeatHaze(clamp01(v.rpmNorm - 0.6) * (this.solar?.above ?? 0) * 0.5);
    this.world.updateLights(this.renderer.camera.position);

    /* local reflection probe, spread over frames */
    if (this.preset.dynamicEnv && this.preset.envUpdateInterval > 0) {
      this._probeTick++;
      if (this._probeTick >= this.preset.envUpdateInterval) {
        this._probeTick = 0;
        this.renderer.updateProbe(
          this._probePos ||= new THREE.Vector3(),
          [this.carModel.group]
        );
      }
      (this._probePos ||= new THREE.Vector3()).copy(v.position).setY(v.position.y + 0.6);
    }

    /* ── race + hud ── */
    this.race.update(dt, v);
    this.hud.update(dt, {
      speedKmh: v.speedKmh,
      rpmNorm: v.rpmNorm,
      gear: v.gearLabel,
      abs: v.abs, tc: v.tc, esc: v.esc,
      absActive: v.absActive, tcActive: v.tcActive, escActive: v.escActive,
      handbrake: input.handbrake,
      lap: this.race.lap,
      lapTime: this.race.lapTime,
      bestLap: this.race.bestLap,
      delta: this.race.delta,
      driftActive: this.race.driftActive,
      driftScore: this.race.displayScore,
      driftMult: this.race.driftMult,
      driftHold: this.race.driftHold,
      driftBanked: this.race.driftBanked,
      carPos: v.position,
      heading: Math.atan2(
        new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion).x,
        new THREE.Vector3(0, 0, 1).applyQuaternion(v.quaternion).z
      ),
    });

    /* ── audio ── */
    let skid = 0, rumble = 0;
    for (const w of v.wheels) {
      skid = Math.max(skid, w.skid);
      if (w.grounded && (w.surface === 'grass' || w.surface === 'kerb' || w.surface === 'sand')) rumble = 1;
    }
    this.audio.update(dt, {
      rpm: v.rpm, redline: v.spec.redline, throttle: v.throttleOut,
      speed: v.speed, skid, surfaceRumble: rumble, limiter: v.limiterCut,
      gear: v.gearIndex + 1, muteEngine: false,
    });
  }

  spawnEffects(dt, v) {
    const fx = this.effects;
    const budget = this.preset.particles;
    for (const w of v.wheels) {
      if (!w.grounded) { fx.breakSkid(w.index); continue; }
      const heat = w.skid;
      if (heat > 0.12 && v.speed > 3) {
        const n = Math.min(3, heat * 3.2 * budget);
        if (Math.random() < n) {
          fx.emitSmoke(w.contact, v.velocity, 1, w.surface);
        }
        fx.addSkidMark(w.index, w.contact, w.right, w.width * 0.95, clamp01((heat - 0.10) * 1.6));
      } else {
        fx.breakSkid(w.index);
      }
      // sparks when the floor grounds out hard
      if (w.compression > w.travel * 0.98 && v.speed > 16 && Math.random() < 0.25 * budget) {
        fx.emitSparks(w.contact, v.velocity.clone().normalize().multiplyScalar(-1), 3);
      }
    }
    if (v.impact > 0.3) {
      fx.emitSparks(v.position, new THREE.Vector3(0, 0.4, 0), Math.round(10 * budget));
    }
    fx.update(dt, this.renderer.camera);
  }
}

/* ── boot ── */
const game = new Game();
game.init().catch(fatal);
window.__apex = game;
window.__apexDiag = () => ({
  state: game.state,
  fps: Math.round(game.fps),
  scale: +game.renderer?.renderScale.toFixed(2),
  tris: game.renderer?.renderer.info.render.triangles,
  calls: game.renderer?.renderer.info.render.calls,
  geometries: game.renderer?.renderer.info.memory.geometries,
  textures: game.renderer?.renderer.info.memory.textures,
  speed: game.vehicle ? Math.round(game.vehicle.speedKmh) : null,
  rpm: game.vehicle ? Math.round(game.vehicle.rpm) : null,
  gear: game.vehicle?.gearLabel ?? null,
  pos: game.vehicle ? game.vehicle.position.toArray().map((n) => +n.toFixed(1)) : null,
  grounded: game.vehicle?.onGroundCount ?? null,
});

export { game };
