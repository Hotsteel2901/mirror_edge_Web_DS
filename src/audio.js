import { clamp, rand, settings } from './util.js';

/* =========================================================================
   音频引擎（全部 WebAudio 实时合成，零外部素材）
   - 与 BGM 完全分离的独立母线
   - 支持持续循环音（风 / 滑铲 / 蹬墙 / 滑索）
   - 材质化脚步（混凝土 / 金属 / 玻璃 / 草地 / 木 / 布面）
   ========================================================================= */

const SURFACES = {
  concrete: { freq: 900, thump: 82, q: 0.7, ring: 0, gain: 1.0 },
  metal: { freq: 1500, thump: 110, q: 1.4, ring: 620, gain: 0.9 },
  glass: { freq: 2600, thump: 140, q: 1.8, ring: 1850, gain: 0.75 },
  grass: { freq: 420, thump: 64, q: 0.5, ring: 0, gain: 0.8 },
  wood: { freq: 700, thump: 96, q: 1.0, ring: 320, gain: 0.95 },
  cloth: { freq: 300, thump: 60, q: 0.4, ring: 0, gain: 0.65 },
};

const LOOP_DEFS = {
  wind: { kind: 'noise', filter: 'bandpass', freq: 480, q: 0.42, gain: 0.02, attack: 0.4 },
  slide: { kind: 'noise', filter: 'bandpass', freq: 820, q: 0.9, gain: 0.0, attack: 0.05 },
  wall: { kind: 'noise', filter: 'bandpass', freq: 360, q: 1.2, gain: 0.0, attack: 0.08 },
  zip: { kind: 'zip', filter: 'highpass', freq: 1500, q: 0.7, gain: 0.0, attack: 0.06 },
};

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.volume = settings.volume;
    this.loops = new Map();
    this.muted = false;
  }

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -13;
      comp.ratio.value = 7;
      comp.attack.value = 0.004;
      comp.release.value = 0.16;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      const len = Math.floor(this.ctx.sampleRate * 2.5);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.022 * white) / 1.022;
        d[i] = last * 3.1;
      }
      this._startLoop('wind');
      this._setLoop('wind', { gain: 0.02 }, 1.5);
    } catch (e) { this.ctx = null; }
    return this.ctx;
  }

  setVolume(v) {
    this.volume = v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.06);
  }
  setMuted(m) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.06);
  }

  /* ---------------- 循环音 ---------------- */
  _startLoop(name) {
    if (!this.ctx || this.loops.has(name)) return this.loops.get(name);
    const def = LOOP_DEFS[name];
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = def.filter;
    filter.frequency.value = def.freq;
    filter.Q.value = def.q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const pan = ctx.createStereoPanner();
    src.connect(filter);
    filter.connect(gain);
    gain.connect(pan);
    pan.connect(this.master);
    const obj = { src, filter, gain, pan, def, osc: null, oscGain: null };
    if (def.kind === 'zip') {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 340;
      const og = ctx.createGain();
      og.gain.value = 0.4;
      const of = ctx.createBiquadFilter();
      of.type = 'bandpass';
      of.frequency.value = 900;
      of.Q.value = 4;
      osc.connect(of);
      of.connect(og);
      og.connect(gain);
      osc.start();
      obj.osc = osc;
      obj.oscGain = og;
    }
    src.start();
    this.loops.set(name, obj);
    return obj;
  }
  _setLoop(name, opts, time = 0.08) {
    const l = this.loops.get(name);
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = Math.max(0.015, time);
    if (opts.gain !== undefined) l.gain.gain.setTargetAtTime(Math.max(0, opts.gain), t, tc);
    if (opts.freq !== undefined) l.filter.frequency.setTargetAtTime(opts.freq, t, tc);
    if (opts.q !== undefined) l.filter.Q.setTargetAtTime(opts.q, t, tc);
    if (opts.rate !== undefined) l.src.playbackRate.setTargetAtTime(opts.rate, t, tc);
    if (opts.pan !== undefined) l.pan.pan.setTargetAtTime(clamp(opts.pan, -1, 1), t, tc);
    if (l.osc && opts.oscFreq !== undefined) l.osc.frequency.setTargetAtTime(opts.oscFreq, t, tc);
  }
  startLoop(name, fade = 0.08) {
    if (!this.ctx) return;
    this._startLoop(name);
    this._setLoop(name, { gain: name === 'wind' ? 0.02 : 0.001 }, fade);
  }
  setLoop(name, opts, time = 0.08) {
    if (!this.ctx) return;
    if (!this.loops.has(name)) this._startLoop(name);
    this._setLoop(name, opts, time);
  }
  stopLoop(name, fade = 0.12) {
    if (!this.loops.has(name)) return;
    this._setLoop(name, { gain: 0 }, fade);
  }

  updateWind(speed, airborne) {
    if (!this.ctx) return;
    const g = 0.012 + clamp(speed / 11.6, 0, 1) * 0.055 + (airborne ? 0.024 : 0);
    this._setLoop('wind', { gain: g, freq: 400 + speed * 46 }, 0.1);
  }

  /* ---------------- 基础发声 ---------------- */
  _env(when, peak, attack, hold, release, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setValueAtTime(peak, when + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + hold + release);
    g.connect(dest || this.master);
    return g;
  }

  noise(opts = {}) {
    if (!this.ctx) return;
    const {
      dur = 0.15, gain = 0.1, type = 'lowpass', freq = 800, q = 0.8,
      freqEnd = null, attack = 0.004, release = 0.07, pan = 0,
    } = opts;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = rand(0.85, 1.2);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(Math.max(40, freqEnd), t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + release + 0.05);
  }

  tone(opts = {}) {
    if (!this.ctx) return;
    const {
      f0 = 400, f1 = null, type = 'sine', dur = 0.12, gain = 0.08,
      attack = 0.007, release = 0.05, pan = 0, when = null,
    } = opts;
    const ctx = this.ctx;
    const t = when || ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    o.connect(g).connect(p).connect(this.master);
    o.start(t);
    o.stop(t + dur + release + 0.05);
  }

  /* ---------------- 跑酷音效 ---------------- */
  footstep(surface = 'concrete', speed = 5, foot = 0) {
    const s = SURFACES[surface] || SURFACES.concrete;
    const hard = speed > 8.2;
    const pan = foot ? 0.1 : -0.1;
    this.noise({
      dur: hard ? 0.05 : 0.085, gain: (hard ? 0.13 : 0.062) * s.gain,
      type: 'lowpass', freq: s.freq * rand(0.9, 1.15), q: s.q, pan,
    });
    this.tone({ f0: s.thump * rand(0.95, 1.08), f1: s.thump * 0.5, type: 'sine', dur: 0.08, gain: hard ? 0.11 : 0.07, pan });
    if (s.ring) this.tone({ f0: s.ring * rand(0.96, 1.05), type: 'triangle', dur: 0.045, gain: 0.022, pan });
  }

  jump() {
    this.noise({ dur: 0.14, gain: 0.09, type: 'bandpass', freq: 640, freqEnd: 1900, q: 1.1 });
    this.tone({ f0: 210, f1: 340, type: 'triangle', dur: 0.1, gain: 0.035 });
  }
  land(impact, surface = 'concrete') {
    const v = clamp(impact / 18, 0, 1.2);
    const s = SURFACES[surface] || SURFACES.concrete;
    this.tone({ f0: 120, f1: 40, type: 'sine', dur: 0.15, gain: 0.1 + v * 0.3 });
    this.noise({ dur: 0.12 + v * 0.12, gain: (0.1 + v * 0.28) * s.gain, type: 'lowpass', freq: s.freq * (0.7 + v * 0.5), q: s.q });
    if (s.ring && impact > 6) this.tone({ f0: s.ring, f1: s.ring * 0.8, type: 'triangle', dur: 0.12, gain: 0.03 });
  }
  roll() {
    this.noise({ dur: 0.32, gain: 0.11, type: 'bandpass', freq: 380, freqEnd: 950, q: 0.8 });
  }
  vault() {
    this.noise({ dur: 0.22, gain: 0.085, type: 'bandpass', freq: 820, freqEnd: 1900, q: 1.0 });
    this.tone({ f0: 160, f1: 280, type: 'triangle', dur: 0.12, gain: 0.03 });
  }
  mantle() {
    this.noise({ dur: 0.3, gain: 0.09, type: 'bandpass', freq: 480, freqEnd: 1400, q: 0.9 });
    this.tone({ f0: 140, f1: 190, type: 'triangle', dur: 0.16, gain: 0.035 });
  }
  walljump() {
    this.noise({ dur: 0.2, gain: 0.13, type: 'bandpass', freq: 720, freqEnd: 2300, q: 1.0 });
    this.tone({ f0: 190, f1: 330, type: 'triangle', dur: 0.16, gain: 0.09 });
  }
  spring() {
    this.tone({ f0: 120, f1: 680, type: 'sine', dur: 0.34, gain: 0.15 });
    this.tone({ f0: 240, f1: 1360, type: 'triangle', dur: 0.26, gain: 0.05 });
    this.noise({ dur: 0.2, gain: 0.07, type: 'bandpass', freq: 900, freqEnd: 2600, q: 1.1 });
  }
  climbStep() {
    this.tone({ f0: 190, f1: 120, type: 'triangle', dur: 0.055, gain: 0.05 });
    this.noise({ dur: 0.045, gain: 0.045, type: 'highpass', freq: 2100, q: 0.8 });
  }
  coin() {
    this.tone({ f0: 940, f1: 1410, type: 'sine', dur: 0.1, gain: 0.06 });
    this.tone({ f0: 1410, f1: 1880, type: 'sine', dur: 0.13, gain: 0.04, attack: 0.02 });
  }
  gate(step = 0) {
    const f = 620 + Math.min(8, step) * 120;
    this.tone({ f0: f, f1: f * 1.6, type: 'triangle', dur: 0.13, gain: 0.08 });
    this.tone({ f0: f * 2, f1: f * 3, type: 'sine', dur: 0.1, gain: 0.03 });
  }
  routeDone() {
    [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => this.tone({ f0: f, type: 'triangle', dur: 0.24, gain: 0.08 }), i * 82));
  }
  trialStart() {
    this.tone({ f0: 880, type: 'sine', dur: 0.09, gain: 0.07 });
    setTimeout(() => this.tone({ f0: 1320, type: 'sine', dur: 0.14, gain: 0.06 }), 110);
  }
  trialFinish() {
    [659, 880, 1318, 1760].forEach((f, i) => setTimeout(() => this.tone({ f0: f, type: 'triangle', dur: 0.28, gain: 0.08 }), i * 95));
  }
  ach() {
    this.tone({ f0: 523, type: 'sine', dur: 0.12, gain: 0.06 });
    setTimeout(() => this.tone({ f0: 784, type: 'sine', dur: 0.2, gain: 0.06 }), 108);
  }
  hurt() {
    this.tone({ f0: 150, f1: 46, type: 'sawtooth', dur: 0.45, gain: 0.13 });
    this.noise({ dur: 0.36, gain: 0.18, type: 'lowpass', freq: 900, q: 0.5 });
  }
  die() {
    this.tone({ f0: 330, f1: 40, type: 'sawtooth', dur: 0.9, gain: 0.15 });
    this.noise({ dur: 0.75, gain: 0.2, type: 'lowpass', freq: 1300, freqEnd: 160, q: 0.6 });
    this.tone({ f0: 70, f1: 34, type: 'sine', dur: 1.0, gain: 0.12 });
  }
  netJoin() {
    this.tone({ f0: 660, f1: 990, type: 'sine', dur: 0.14, gain: 0.05 });
    this.tone({ f0: 990, f1: 1320, type: 'sine', dur: 0.16, gain: 0.035 });
  }
  netLeave() {
    this.tone({ f0: 660, f1: 330, type: 'sine', dur: 0.2, gain: 0.04 });
  }
  netPing() {
    this.tone({ f0: 1240, type: 'sine', dur: 0.05, gain: 0.03 });
  }
  uiClick() {
    this.tone({ f0: 720, f1: 980, type: 'triangle', dur: 0.06, gain: 0.05 });
  }

  /* ---------------- 战斗 / 任务 ---------------- */
  kick() {
    this.tone({ f0: 130, f1: 44, type: 'sine', dur: 0.18, gain: 0.16 });
    this.noise({ dur: 0.1, gain: 0.11, type: 'lowpass', freq: 950, q: 0.8 });
  }
  fleshHit() {
    this.tone({ f0: 190, f1: 58, type: 'triangle', dur: 0.14, gain: 0.13 });
    this.noise({ dur: 0.13, gain: 0.15, type: 'bandpass', freq: 420, q: 1.1 });
  }
  gunshot() {
    this.noise({ dur: 0.055, gain: 0.19, type: 'highpass', freq: 1500, q: 0.6, pan: rand(-0.3, 0.3) });
    this.noise({ dur: 0.24, gain: 0.1, type: 'lowpass', freq: 760, freqEnd: 180, q: 0.5 });
    this.tone({ f0: 92, f1: 38, type: 'square', dur: 0.17, gain: 0.09 });
  }
  guardAlert() {
    this.tone({ f0: 860, f1: 1220, type: 'square', dur: 0.1, gain: 0.05 });
    setTimeout(() => this.tone({ f0: 1220, type: 'square', dur: 0.06, gain: 0.035 }), 90);
  }
  alarm() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this.tone({ f0: 760, f1: 980, type: 'sawtooth', dur: 0.16, gain: 0.05 });
        setTimeout(() => this.tone({ f0: 980, f1: 760, type: 'sawtooth', dur: 0.16, gain: 0.05 }), 170);
      }, i * 380);
    }
  }
  missionAccept() {
    [660, 880, 1100].forEach((f, i) => setTimeout(() => this.tone({ f0: f, type: 'sine', dur: 0.1, gain: 0.055 }), i * 70));
  }
  missionDone() {
    [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => setTimeout(() => this.tone({ f0: f, type: 'triangle', dur: 0.26, gain: 0.07 }), i * 92));
  }
  missionFail() {
    [520, 415, 311].forEach((f, i) => setTimeout(() => this.tone({ f0: f, f1: f * 0.9, type: 'triangle', dur: 0.3, gain: 0.07 }), i * 150));
  }
  buy() {
    this.tone({ f0: 1320, f1: 1760, type: 'sine', dur: 0.09, gain: 0.05 });
    setTimeout(() => this.tone({ f0: 1760, type: 'sine', dur: 0.16, gain: 0.04 }), 80);
  }
  levelUp() {
    [392, 523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone({ f0: f, type: 'triangle', dur: 0.3, gain: 0.075 }), i * 85));
    setTimeout(() => this.noise({ dur: 0.5, gain: 0.05, type: 'bandpass', freq: 3000, q: 1.2 }), 120);
  }
  dataChip() {
    this.tone({ f0: 880, f1: 1760, type: 'square', dur: 0.12, gain: 0.045 });
    setTimeout(() => this.tone({ f0: 1320, f1: 2200, type: 'sine', dur: 0.2, gain: 0.04 }), 70);
  }
  lockOn() {
    this.tone({ f0: 1500, type: 'square', dur: 0.04, gain: 0.03 });
    setTimeout(() => this.tone({ f0: 1900, type: 'square', dur: 0.05, gain: 0.025 }), 55);
  }
  whoosh() {
    this.noise({ dur: 0.4, gain: 0.1, type: 'bandpass', freq: 300, freqEnd: 1600, q: 0.7 });
  }
}

export const audio = new AudioEngine();
