/**
 * Garage: a turntable showroom with studio lighting, swipe-to-switch cars,
 * a paint picker and wheel choices. It renders into the same scene the game
 * uses so the paint you pick is literally the paint you drive away with.
 */
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { $, $$, clamp, clamp01, lerp, damp, vibrate } from '../core/util.js';
import { settings } from '../core/settings.js';
import { CarModel } from '../cars/model.js';
import { CARS } from '../cars/defs.js';

export class Garage {
  constructor(scene, camera, opts = {}) {
    this.scene = scene;
    this.camera = camera;
    this.group = new THREE.Group();
    this.group.name = 'garage';
    this.scene.add(this.group);

    this.index = clamp(settings.get('car'), 0, CARS.length - 1);
    this.models = [];
    this.quality = opts.quality ?? 1;
    this.turn = 0;
    this.turnSpeed = 0.22;
    this.targetIndex = this.index;
    this.slide = this.index;
    this.dragging = false;
    this._dragStart = 0;
    this._dragBase = 0;
    this._userTurn = 0;
    this.onSelect = opts.onSelect || (() => {});
    this.onDrive = opts.onDrive || (() => {});
    this.active = false;

    this.buildStage();
    this.buildModels();
    this.bindUI();
    this.refreshPanel();
  }

  /* ── showroom ───────────────────────────────────────── */

  buildStage() {
    // RectAreaLight needs its LTC lookup textures uploaded before first use.
    RectAreaLightUniformsLib.init();

    // Studio shell: a dark cyclorama so the car reads against the background
    // instead of dissolving into a bright sky.
    const shellMat = new THREE.MeshBasicMaterial({
      color: 0x0a0d13, side: THREE.BackSide, toneMapped: false, fog: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(46, 32, 20), shellMat);
    shell.position.y = 6;
    this.group.add(shell);
    this.shell = shell;

    // soft gradient wash on the back wall
    const washGeo = new THREE.CylinderGeometry(30, 30, 34, 40, 1, true);
    const washMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: { uTop: { value: new THREE.Color(0x1b2330) }, uBot: { value: new THREE.Color(0x05070b) } },
      vertexShader: 'varying float vY; void main(){ vY = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `
        uniform vec3 uTop; uniform vec3 uBot; varying float vY;
        void main(){ gl_FragColor = vec4(mix(uBot, uTop, smoothstep(0.05, 0.75, vY)), 1.0); }`,
    });
    const wash = new THREE.Mesh(washGeo, washMat);
    wash.position.y = 11;
    this.group.add(wash);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(17, 80),
      new THREE.MeshPhysicalMaterial({
        color: 0x0a0d12, roughness: 0.30, metalness: 0.30,
        clearcoat: 0.55, clearcoatRoughness: 0.26, envMapIntensity: 0.45,
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(7.4, 7.75, 96),
      new THREE.MeshBasicMaterial({ color: 0xff8a2b, toneMapped: false, transparent: true, opacity: 0.55 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.006;
    this.group.add(ring);
    this.ring = ring;

    // Studio rig: two big soft boxes plus a warm rim. Area lights are what
    // give car paint those long, straight-edged highlights down the flanks.
    const key = new THREE.RectAreaLight(0xffffff, 5.0, 9, 3.6);
    key.position.set(5.2, 6.0, 5.2);
    key.lookAt(0, 0.7, 0);
    this.group.add(key);

    const fill = new THREE.RectAreaLight(0xa9c8ff, 2.6, 9, 3.6);
    fill.position.set(-6.6, 4.4, 2.6);
    fill.lookAt(0, 0.7, 0);
    this.group.add(fill);

    const rim = new THREE.RectAreaLight(0xff9a4a, 4.6, 7, 2.2);
    rim.position.set(-2.4, 3.2, -7.2);
    rim.lookAt(0, 0.8, 0);
    this.group.add(rim);

    const strip = new THREE.RectAreaLight(0xffffff, 3.2, 12, 0.7);
    strip.position.set(0, 5.6, 2.2);
    strip.lookAt(0, 0.9, 0);
    this.group.add(strip);

    const top = new THREE.SpotLight(0xffffff, 42, 24, 0.7, 0.65, 1.5);
    top.position.set(0.4, 9.0, 1.2);
    top.target.position.set(0, 0.5, 0);
    top.castShadow = true;
    top.shadow.mapSize.set(1024, 1024);
    top.shadow.bias = -0.0016;
    top.shadow.normalBias = 0.02;
    this.group.add(top, top.target);

    const amb = new THREE.HemisphereLight(0x2a3646, 0x0a0c10, 0.35);
    this.group.add(amb);

    this.lights = [key, fill, rim, strip, top, amb];
  }

  buildModels() {
    for (const def of CARS) {
      const m = new CarModel(def, {
        paint: settings.paintFor(def.id, 0),
        rim: settings.rimFor(def.id, def.defaultRim ?? 0),
        quality: this.quality,
      });
      m.group.visible = false;
      this.group.add(m.group);
      this.models.push(m);
    }
  }

  /* ── UI wiring ──────────────────────────────────────── */

  bindUI() {
    const dots = $('#g-dots');
    if (dots) {
      dots.innerHTML = '';
      this._dots = CARS.map((_, i) => {
        const d = document.createElement('span');
        d.className = 'dot';
        dots.appendChild(d);
        return d;
      });
    }

    $('#car-prev')?.addEventListener('click', () => this.step(-1));
    $('#car-next')?.addEventListener('click', () => this.step(1));
    $('#btn-drive')?.addEventListener('click', () => this.onDrive(this.current));

    $$('.chip').forEach((c) => {
      c.addEventListener('click', () => {
        const r = Number(c.dataset.rim);
        settings.setRim(this.current.id, r);
        this.rebuildCurrent();
        this.refreshPanel();
        vibrate(12);
      });
    });

    // swipe on the canvas to spin the car and flick between cars
    const stage = $('#stage');
    let pid = null, lastX = 0, dragDist = 0, startX = 0;
    const down = (e) => {
      if (!this.active) return;
      const t = e.changedTouches ? e.changedTouches[0] : e;
      pid = t.identifier ?? 'mouse';
      lastX = startX = t.clientX;
      dragDist = 0;
      this.dragging = true;
      $('#g-hint')?.classList.add('hide');
    };
    const move = (e) => {
      if (!this.dragging || !this.active) return;
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        if ((t.identifier ?? 'mouse') !== pid) continue;
        const dx = t.clientX - lastX;
        lastX = t.clientX;
        dragDist += Math.abs(dx);
        this._userTurn -= dx * 0.0085;
      }
    };
    const up = (e) => {
      if (!this.dragging) return;
      const list = e.changedTouches ? Array.from(e.changedTouches) : [e];
      for (const t of list) {
        if ((t.identifier ?? 'mouse') !== pid) continue;
        const total = t.clientX - startX;
        if (Math.abs(total) > 70 && dragDist < Math.abs(total) * 1.9) {
          this.step(total < 0 ? 1 : -1);
        }
        this.dragging = false;
        pid = null;
      }
    };
    stage?.addEventListener('touchstart', down, { passive: true });
    stage?.addEventListener('touchmove', move, { passive: true });
    stage?.addEventListener('touchend', up, { passive: true });
    stage?.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'touch') down(e); });
    addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') move(e); });
    addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') up(e); });
  }

  step(dir) {
    this.targetIndex = (this.targetIndex + dir + CARS.length) % CARS.length;
    // choose the shorter way round the carousel
    if (Math.abs(this.targetIndex - this.slide) > CARS.length / 2) {
      this.slide += Math.sign(this.targetIndex - this.slide) * -CARS.length;
    }
    this.index = this.targetIndex;
    settings.set('car', this.index);
    this.refreshPanel();
    this.onSelect(this.current);
    vibrate(14);
  }

  get current() { return CARS[this.index]; }
  get currentModel() { return this.models[this.index]; }

  rebuildCurrent() {
    const def = this.current;
    const old = this.models[this.index];
    this.group.remove(old.group);
    old.dispose();
    const m = new CarModel(def, {
      paint: settings.paintFor(def.id, 0),
      rim: settings.rimFor(def.id, def.defaultRim ?? 0),
      quality: this.quality,
    });
    this.group.add(m.group);
    this.models[this.index] = m;
  }

  refreshPanel() {
    const def = this.current;
    const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v; };
    set('#car-maker', def.maker);
    set('#car-model', def.model);
    set('#car-tag', def.tagline);
    set('#sp-power', def.ui.power);
    set('#sp-accel', def.ui.accel.toFixed(1));
    set('#sp-top', def.ui.topSpeed);
    set('#sp-weight', def.ui.mass);

    const bar = (sel, v) => { const el = $(sel); if (el) el.style.width = `${v * 100}%`; };
    bar('#bar-power', def.ratings.power);
    bar('#bar-handling', def.ratings.handling);
    bar('#bar-brakes', def.ratings.brakes);
    bar('#bar-aero', def.ratings.aero);

    const sw = $('#swatches');
    if (sw) {
      sw.innerHTML = '';
      const active = settings.paintFor(def.id, 0);
      def.paints.forEach((p, i) => {
        const b = document.createElement('button');
        b.className = `sw${i === active ? ' on' : ''}`;
        b.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
        b.title = p.name;
        b.setAttribute('aria-label', p.name);
        b.addEventListener('click', () => {
          settings.setPaint(def.id, i);
          this.currentModel.setPaint(i);
          $$('.sw', sw).forEach((e, j) => e.classList.toggle('on', j === i));
          vibrate(10);
        });
        sw.appendChild(b);
      });
    }

    const rimIdx = settings.rimFor(def.id, def.defaultRim ?? 0);
    $$('.chip').forEach((c, i) => {
      c.classList.toggle('on', i === rimIdx);
      c.textContent = def.rims?.[i]?.label ?? `FELGE ${i + 1}`;
    });

    this._dots?.forEach((d, i) => d.classList.toggle('on', i === this.index));
  }

  /* ── lifecycle ──────────────────────────────────────── */

  show() {
    this.active = true;
    this.group.visible = true;
    for (const l of this.lights) l.visible = true;
    this.refreshPanel();
  }

  hide() {
    this.active = false;
    this.group.visible = false;
    for (const l of this.lights) l.visible = false;
  }

  update(dt, elapsed) {
    if (!this.active) return;
    this.slide = damp(this.slide, this.targetIndex, 7, dt);
    if (!this.dragging) this._userTurn = damp(this._userTurn, 0, 1.2, dt);
    this.turn += dt * this.turnSpeed;

    const spacing = 9.0;
    this.models.forEach((m, i) => {
      const offset = (i - this.slide) * spacing;
      const vis = Math.abs(offset) < spacing * 1.6;
      m.group.visible = vis;
      if (!vis) return;
      m.group.position.set(offset, 0, 0);
      m.group.rotation.y = this.turn + this._userTurn + offset * 0.06;
      const fade = clamp01(1 - Math.abs(offset) / (spacing * 1.3));
      m.group.scale.setScalar(lerp(0.86, 1, fade));
      m.update(dt, {
        steer: Math.sin(elapsed * 0.5) * 0.25,
        wheelOmega: [0, 0, 0, 0],
        suspension: [0, 0, 0, 0],
        brake: 0, headlights: false, speed: 0,
      });
    });

    if (this.ring) {
      this.ring.material.opacity = 0.35 + Math.sin(elapsed * 1.6) * 0.16;
    }

    // orbiting hero camera
    const wide = innerWidth / innerHeight > 1.25;
    const a = -0.66 + Math.sin(elapsed * 0.14) * 0.30;
    const r = wide ? 9.9 : 10.4;
    this.camera.position.set(
      Math.sin(a) * r,
      1.95 + Math.sin(elapsed * 0.22) * 0.26,
      Math.cos(a) * r
    );
    // in landscape the spec panel owns the right-hand third, so bias the car left
    this.camera.lookAt(wide ? 1.35 : 0, 0.60, 0);
    const fov = wide ? 36 : 42;
    if (Math.abs(this.camera.fov - fov) > 0.1) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

export { CARS };
