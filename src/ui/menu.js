/**
 * Settings sheet and pause menu. Rows are declared as data so adding a new
 * option is one line rather than a block of DOM plumbing.
 */
import { $, clamp, formatTime, vibrate } from '../core/util.js';
import { settings, PRESETS } from '../core/settings.js';

const ROWS = [
  { group: 'GRAFIK' },
  {
    type: 'seg', key: 'quality', label: 'Qualität',
    options: [
      ['auto', 'AUTO'], ['low', 'NIEDRIG'], ['medium', 'MITTEL'], ['high', 'HOCH'], ['ultra', 'ULTRA'],
    ],
  },
  {
    type: 'seg', key: 'weather', label: 'Wetter',
    options: [['clear', 'KLAR'], ['wet', 'NASS'], ['dusk', 'ABEND'], ['night', 'NACHT']],
  },
  { type: 'range', key: 'timeOfDay', label: 'Tageszeit', min: 0, max: 1, step: 0.01 },
  { type: 'toggle', key: 'dynamicTime', label: 'Tageszeit läuft' },
  { type: 'range', key: 'fov', label: 'Sichtfeld', min: 52, max: 92, step: 1 },

  { group: 'STEUERUNG' },
  {
    type: 'seg', key: 'steering', label: 'Lenkung',
    options: [['wheel', 'LENKRAD'], ['tilt', 'NEIGEN'], ['buttons', 'TASTEN']],
  },
  { type: 'range', key: 'steerSensitivity', label: 'Lenk-Empfindlichkeit', min: 0.4, max: 1.8, step: 0.05 },
  {
    type: 'seg', key: 'transmission', label: 'Getriebe',
    options: [['auto', 'AUTOMATIK'], ['manual', 'MANUELL']],
  },
  { type: 'toggle', key: 'haptics', label: 'Vibration' },

  { group: 'FAHRHILFEN' },
  { type: 'toggle', key: 'assistABS', label: 'ABS' },
  { type: 'toggle', key: 'assistTC', label: 'Traktionskontrolle' },
  { type: 'toggle', key: 'assistESC', label: 'Stabilitätskontrolle' },

  { group: 'AUDIO' },
  { type: 'range', key: 'volumeMaster', label: 'Gesamt-Lautstärke', min: 0, max: 1, step: 0.05 },
  { type: 'range', key: 'volumeEngine', label: 'Motor', min: 0, max: 1.4, step: 0.05 },

  { group: 'SONSTIGES' },
  { type: 'toggle', key: 'showFps', label: 'FPS anzeigen' },
];

export class Menu {
  constructor(opts = {}) {
    this.onChange = opts.onChange || (() => {});
    this.body = $('#settings-body');
    this.sheet = $('#settings');
    this.pause = $('#pause');
    this.build();

    $('#btn-settings')?.addEventListener('click', () => this.openSettings());
    $('#btn-settings-close')?.addEventListener('click', () => this.closeSettings());
    $('#btn-resume')?.addEventListener('click', () => opts.onResume?.());
    $('#btn-to-garage')?.addEventListener('click', () => opts.onGarage?.());
    $('#btn-pause')?.addEventListener('click', () => opts.onPause?.());

    this.sheet?.addEventListener('click', (e) => { if (e.target === this.sheet) this.closeSettings(); });
    this.pause?.addEventListener('click', (e) => { if (e.target === this.pause) opts.onResume?.(); });
  }

  build() {
    if (!this.body) return;
    this.body.innerHTML = '';
    this._controls = [];

    for (const row of ROWS) {
      if (row.group) {
        const h = document.createElement('div');
        h.className = 'set-group';
        h.textContent = row.group;
        this.body.appendChild(h);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'set-row';
      const label = document.createElement('label');
      label.textContent = row.label;
      el.appendChild(label);

      if (row.type === 'seg') {
        const seg = document.createElement('div');
        seg.className = 'seg';
        const buttons = row.options.map(([val, text]) => {
          const b = document.createElement('button');
          b.textContent = text;
          b.addEventListener('click', () => {
            settings.set(row.key, val);
            sync();
            vibrate(10);
            this.onChange(row.key, val);
          });
          seg.appendChild(b);
          return { b, val };
        });
        const sync = () => {
          const cur = settings.get(row.key);
          buttons.forEach(({ b, val }) => b.classList.toggle('on', val === cur));
        };
        sync();
        this._controls.push(sync);
        el.appendChild(seg);
      } else if (row.type === 'toggle') {
        const b = document.createElement('button');
        b.className = 'sw-toggle';
        b.setAttribute('role', 'switch');
        const sync = () => {
          const on = !!settings.get(row.key);
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', String(on));
        };
        b.addEventListener('click', () => {
          settings.set(row.key, !settings.get(row.key));
          sync();
          vibrate(10);
          this.onChange(row.key, settings.get(row.key));
        });
        sync();
        this._controls.push(sync);
        el.appendChild(b);
      } else if (row.type === 'range') {
        const r = document.createElement('input');
        r.type = 'range';
        r.min = row.min; r.max = row.max; r.step = row.step;
        const sync = () => { r.value = settings.get(row.key); };
        r.addEventListener('input', () => {
          settings.set(row.key, Number(r.value));
          this.onChange(row.key, Number(r.value));
        });
        sync();
        this._controls.push(sync);
        el.appendChild(r);
      }
      this.body.appendChild(el);
    }
  }

  syncAll() { this._controls?.forEach((f) => f()); }

  openSettings() {
    this.syncAll();
    this.sheet?.classList.add('active');
  }
  closeSettings() { this.sheet?.classList.remove('active'); }
  get settingsOpen() { return this.sheet?.classList.contains('active'); }

  openPause(stats) {
    const box = $('#pause-stats');
    if (box && stats) {
      box.innerHTML = '';
      for (const [k, v] of stats) {
        const d = document.createElement('div');
        d.innerHTML = `<span>${k}</span><b>${v}</b>`;
        box.appendChild(d);
      }
    }
    this.pause?.classList.add('active');
  }
  closePause() { this.pause?.classList.remove('active'); }
  get paused() { return this.pause?.classList.contains('active'); }
}

export { PRESETS, formatTime, clamp };
