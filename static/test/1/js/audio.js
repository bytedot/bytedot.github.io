'use strict';
/* =====================================================================
 * audio.js — 程序化音效（Web Audio API，无任何外部音频文件）
 *  - 持续层：低频风声 / 高速风噪 / 贴近建筑的风压 / 极速低频轰鸣 / 射线嗡鸣
 *  - 一次性：撞击、玻璃破碎、音爆、爆炸、坍塌、呼啸、地面冲击、冲击拳
 *  - 远处的声音按距离衰减并按声速延迟到达
 * ===================================================================== */

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.voices = 0;
    this.lastPlay = {};
    this._v = new THREE.Vector3();
  }

  /** 必须在用户点击后调用（浏览器自动播放策略） */
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();

    // 输出链：master → 压缩器 → 扬声器
    this.out = ctx.createGain();
    this.out.gain.value = 0.85;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15; comp.knee.value = 12; comp.ratio.value = 5;
    comp.attack.value = 0.003; comp.release.value = 0.35;
    this.out.connect(comp);
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.connect(this.out);

    // 城市回声（卷积混响）
    this.verb = ctx.createConvolver();
    this.verb.buffer = this._impulse(3.2, 2.6);
    this.verbIn = ctx.createGain();
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.5;
    this.verbIn.connect(this.verb);
    this.verb.connect(verbOut);
    verbOut.connect(this.master);

    this.white = this._noise(3, 'white');
    this.pink = this._noise(3, 'pink');
    this.brown = this._noise(4, 'brown');
    this._loops();
    this.ready = true;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ready) this.out.gain.setTargetAtTime(m ? 0 : 0.85, this.ctx.currentTime, 0.05);
  }

  suspend() { if (this.ready) this.ctx.suspend(); }
  resume() { if (this.ready) this.ctx.resume(); }

  /* ---------------- 缓冲区生成 ---------------- */
  _noise(sec, kind) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else { // pink（Paul Kellet 近似）
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    }
    return buf;
  }

  _impulse(sec, decay) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 前 30ms 稀疏的早期反射 + 指数衰减尾音
        const early = i < ctx.sampleRate * 0.03 ? (Math.random() < 0.02 ? 1 : 0) : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
    }
    return buf;
  }

  /* ---------------- 持续层 ---------------- */
  _loopSrc(buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = true;
    s.start(0, Math.random() * buf.duration);
    return s;
  }

  _loops() {
    const ctx = this.ctx;
    const mk = (src, type, freq, q, gain) => {
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = gain;
      src.connect(f); f.connect(g); g.connect(this.master);
      return { f, g };
    };
    // 低频风声
    this.windLow = mk(this._loopSrc(this.brown), 'lowpass', 300, 0.5, 0.05);
    // 高速风噪（嘶嘶声）
    this.windHigh = mk(this._loopSrc(this.white), 'bandpass', 1800, 0.55, 0);
    // 风压层（贴近建筑），带声像
    {
      const src = this._loopSrc(this.pink);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 700; f.Q.value = 1.1;
      const g = ctx.createGain(); g.gain.value = 0;
      const p = ctx.createStereoPanner();
      src.connect(f); f.connect(g); g.connect(p); p.connect(this.master);
      this.pressure = { f, g, p };
    }
    // 极速低频轰鸣：两个低频正弦 + 低通棕噪声
    {
      const g = ctx.createGain(); g.gain.value = 0;
      const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 38;
      const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = 57.5;
      const og = ctx.createGain(); og.gain.value = 0.55;
      o1.connect(og); o2.connect(og); og.connect(g);
      o1.start(); o2.start();
      const n = this._loopSrc(this.brown);
      const nf = ctx.createBiquadFilter(); nf.type = 'lowpass'; nf.frequency.value = 110;
      const ng = ctx.createGain(); ng.gain.value = 1.4;
      n.connect(nf); nf.connect(ng); ng.connect(g);
      g.connect(this.master);
      this.drone = { g, o1, o2 };
    }
    // 目光射线：锯齿 + 方波经过带通 + 高频嘶嘶
    {
      const g = ctx.createGain(); g.gain.value = 0;
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 96;
      const o2 = ctx.createOscillator(); o2.type = 'square'; o2.frequency.value = 193;
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 0.9;
      const og = ctx.createGain(); og.gain.value = 0.25;
      o1.connect(f); o2.connect(f); f.connect(og); og.connect(g);
      o1.start(); o2.start();
      const n = this._loopSrc(this.white);
      const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 3800;
      const ng = ctx.createGain(); ng.gain.value = 0.35;
      n.connect(nf); nf.connect(ng); ng.connect(g);
      g.connect(this.master);
      this.beam = { g, o1, f };
    }
  }

  /**
   * 每帧更新持续层
   * p: { speed, hyper(0..1), pressure(0..1), pressurePan, beam(bool), active(bool) }
   */
  update(p) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const s = U.clamp(p.speed / 430, 0, 1);
    const act = p.active ? 1 : 0.35;
    const k = 0.09;
    this.windLow.g.gain.setTargetAtTime((0.05 + 0.55 * Math.pow(s, 0.7)) * act, t, k);
    this.windLow.f.frequency.setTargetAtTime(220 + 1500 * s, t, k);
    this.windHigh.g.gain.setTargetAtTime(0.32 * U.smooth(0.12, 1, s) * act, t, k);
    this.windHigh.f.frequency.setTargetAtTime(1300 + 4200 * s, t, k);
    this.pressure.g.gain.setTargetAtTime(p.pressure * (0.15 + 0.85 * s) * 0.9 * act, t, 0.05);
    this.pressure.f.frequency.setTargetAtTime(500 + 1600 * p.pressure * s, t, 0.08);
    this.pressure.p.pan.setTargetAtTime(U.clamp(p.pressurePan || 0, -1, 1), t, 0.08);
    this.drone.g.gain.setTargetAtTime(p.hyper * 0.55 * act, t, 0.15);
    this.drone.o1.frequency.setTargetAtTime(34 + 10 * p.hyper, t, 0.2);
    const b = p.beam ? 1 : 0;
    this.beam.g.gain.setTargetAtTime(b * 0.32, t, b ? 0.02 : 0.06);
    this.beam.o1.frequency.setTargetAtTime(92 + Math.random() * 10, t, 0.03);
  }

  /* ---------------- 一次性音效的基础构件 ---------------- */
  _canPlay(key, minGap) {
    const now = performance.now();
    if (this.lastPlay[key] && now - this.lastPlay[key] < minGap) return false;
    this.lastPlay[key] = now;
    return this.ready && !this.muted && this.voices < 56;
  }

  /** 滤波噪声爆发 */
  _burst(o) {
    const ctx = this.ctx, t0 = ctx.currentTime + (o.delay || 0);
    const buf = o.buf || this.white;
    const dur = o.dur;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o.rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type || 'lowpass';
    f.Q.value = o.q || 0.7;
    f.frequency.setValueAtTime(o.freq, t0);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t0 + dur);
    const g = ctx.createGain();
    const atk = o.attack || 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const pn = ctx.createStereoPanner();
    pn.pan.value = U.clamp(o.pan || 0, -1, 1);
    src.connect(f); f.connect(g); g.connect(pn); pn.connect(this.master);
    if (o.verb) { const vs = ctx.createGain(); vs.gain.value = o.verb; pn.connect(vs); vs.connect(this.verbIn); }
    const off = Math.random() * Math.max(0, buf.duration - dur - 0.05);
    src.start(t0, off);
    src.stop(t0 + dur + 0.05);
    this.voices++;
    src.onended = () => { this.voices--; };
  }

  /** 音高滑动的振荡器（低频冲击、轰鸣） */
  _tone(o) {
    const ctx = this.ctx, t0 = ctx.currentTime + (o.delay || 0);
    const osc = ctx.createOscillator();
    osc.type = o.wave || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), t0 + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    const pn = ctx.createStereoPanner();
    pn.pan.value = U.clamp(o.pan || 0, -1, 1);
    osc.connect(g); g.connect(pn); pn.connect(this.master);
    if (o.verb) { const vs = ctx.createGain(); vs.gain.value = o.verb; pn.connect(vs); vs.connect(this.verbIn); }
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
    this.voices++;
    osc.onended = () => { this.voices--; };
  }

  /** 计算世界坐标处声音的增益、声像与到达延迟（声速 343 m/s） */
  spatial(x, y, z, ref = 70) {
    const cam = G.camera;
    if (!cam) return { gain: 1, pan: 0, delay: 0 };
    const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const r = this._v.set(1, 0, 0).applyQuaternion(cam.quaternion);
    const pan = dist > 1 ? U.clamp((dx * r.x + dy * r.y + dz * r.z) / dist, -1, 1) * 0.85 : 0;
    const gain = 1 / (1 + Math.pow(dist / ref, 1.6));
    return { gain, pan, delay: Math.min(dist / 343, 2.5), dist };
  }

  /* ---------------- 具体音效 ---------------- */

  /** 混凝土撞击：低频重击 + 碎裂声 + 碎屑噼啪 */
  impact(I, sp = { gain: 1, pan: 0, delay: 0 }) {
    if (!this._canPlay('impact', 40)) return;
    const g = sp.gain, pan = sp.pan, d = sp.delay;
    if (g < 0.02) return;
    this._tone({ f0: 95, f1: 30, dur: 0.45 + 0.7 * I, gain: (0.5 + 0.6 * I) * g, pan, delay: d, verb: 0.4 });
    this._burst({ buf: this.brown, type: 'lowpass', freq: 2400, freqEnd: 260, dur: 0.5 + 0.9 * I, gain: (0.55 + 0.5 * I) * g, pan, delay: d, verb: 0.5 });
    this._burst({ type: 'bandpass', freq: 1400, q: 0.8, dur: 0.18, gain: 0.35 * g, pan, delay: d });
    const n = 2 + Math.floor(5 * I);
    for (let i = 0; i < n; i++) {
      this._burst({ type: 'highpass', freq: 1800 + Math.random() * 2500, dur: 0.04 + Math.random() * 0.06,
        gain: (0.06 + 0.12 * Math.random()) * g, pan: pan + (Math.random() - 0.5) * 0.4, delay: d + 0.05 + Math.random() * 0.5 });
    }
    // 碎屑落地声
    if (I > 0.25) this.debrisRain(I, sp);
  }

  debrisRain(I, sp) {
    const n = 3 + Math.floor(8 * I);
    for (let i = 0; i < n; i++) {
      this._burst({ buf: this.pink, type: 'bandpass', freq: 600 + Math.random() * 2600, q: 1.5,
        dur: 0.06 + Math.random() * 0.1, gain: (0.05 + 0.1 * Math.random()) * sp.gain,
        pan: sp.pan + (Math.random() - 0.5) * 0.6, delay: sp.delay + 0.5 + Math.random() * 1.6 });
    }
  }

  /** 玻璃破碎：高频碎裂 + 随机叮当声 */
  glass(I, sp = { gain: 1, pan: 0, delay: 0 }) {
    if (!this._canPlay('glass', 70)) return;
    const g = sp.gain;
    if (g < 0.02) return;
    this._burst({ type: 'highpass', freq: 3200, dur: 0.3 + 0.3 * I, gain: (0.18 + 0.3 * I) * g, pan: sp.pan, delay: sp.delay, verb: 0.3 });
    const n = 4 + Math.floor(10 * I);
    for (let i = 0; i < n; i++) {
      const f = 2400 + Math.random() * 5200;
      this._tone({ f0: f, f1: f * (0.96 + Math.random() * 0.03), dur: 0.05 + Math.random() * 0.22,
        gain: (0.025 + 0.05 * Math.random()) * g, pan: sp.pan + (Math.random() - 0.5) * 0.7,
        delay: sp.delay + Math.random() * 0.7, verb: 0.2 });
    }
  }

  /** 音爆：双重尖锐爆裂（N 波）+ 超低频下潜 + 长尾回响 */
  boom(I = 1) {
    if (!this._canPlay('boom', 400)) return;
    this._burst({ type: 'lowpass', freq: 5000, freqEnd: 500, dur: 0.22, gain: 1.0 * I, verb: 0.9 });
    this._burst({ type: 'lowpass', freq: 4000, freqEnd: 400, dur: 0.22, gain: 0.85 * I, delay: 0.11, verb: 0.9 });
    this._tone({ f0: 62, f1: 22, dur: 1.8, gain: 1.0 * I, verb: 0.4 });
    this._burst({ buf: this.brown, type: 'lowpass', freq: 500, freqEnd: 70, dur: 3.0, gain: 0.7 * I, attack: 0.02, verb: 1.0 });
  }

  /** 爆炸（汽车等） */
  explosion(I, sp) {
    if (!this._canPlay('explosion', 90)) return;
    const g = sp.gain;
    if (g < 0.02) return;
    this._tone({ f0: 80, f1: 26, dur: 1.3, gain: 0.9 * I * g, pan: sp.pan, delay: sp.delay, verb: 0.6 });
    this._burst({ buf: this.brown, type: 'lowpass', freq: 3000, freqEnd: 160, dur: 1.6, gain: 0.9 * I * g, pan: sp.pan, delay: sp.delay, verb: 0.8 });
    for (let i = 0; i < 6; i++) {
      this._burst({ type: 'bandpass', freq: 900 + Math.random() * 3000, q: 1.2, dur: 0.05 + Math.random() * 0.1,
        gain: 0.15 * g, pan: sp.pan, delay: sp.delay + 0.1 + Math.random() * 0.9 });
    }
  }

  /** 大楼坍塌：持续数秒的低沉轰鸣 + 连续断裂声 */
  collapse(I, sp, dur) {
    if (!this._canPlay('collapse', 300)) return;
    const g = sp.gain;
    if (g < 0.015) return;
    this._burst({ buf: this.brown, type: 'lowpass', freq: 420, freqEnd: 70, dur: dur + 2, gain: 0.9 * I * g, attack: 0.5, pan: sp.pan, delay: sp.delay, verb: 0.9 });
    this._tone({ f0: 48, f1: 24, dur: dur + 1, gain: 0.55 * I * g, attack: 0.4, pan: sp.pan, delay: sp.delay });
    const n = 6 + Math.floor(dur * 2);
    for (let i = 0; i < n; i++) {
      const dl = sp.delay + Math.random() * dur;
      this._burst({ buf: this.brown, type: 'lowpass', freq: 1800, freqEnd: 200, dur: 0.4 + Math.random() * 0.6,
        gain: (0.25 + 0.35 * Math.random()) * g, pan: sp.pan + (Math.random() - 0.5) * 0.3, delay: dl, verb: 0.6 });
      if (Math.random() < 0.4) this._burst({ type: 'highpass', freq: 3000, dur: 0.2, gain: 0.08 * g, pan: sp.pan, delay: dl });
    }
  }

  /** 掠过物体时的呼啸声 */
  whoosh(I, pan = 0) {
    if (!this._canPlay('whoosh', 110)) return;
    const ctx = this.ctx, t0 = ctx.currentTime, dur = 0.55;
    const src = ctx.createBufferSource(); src.buffer = this.pink;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(400, t0);
    f.frequency.exponentialRampToValueAtTime(2600, t0 + dur * 0.35);
    f.frequency.exponentialRampToValueAtTime(500, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.55 * I, t0 + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(U.clamp(pan, -1, 1), t0);
    p.pan.linearRampToValueAtTime(U.clamp(-pan * 0.5, -1, 1), t0 + dur);
    src.connect(f); f.connect(g); g.connect(p); p.connect(this.master);
    src.start(t0, Math.random() * 2);
    src.stop(t0 + dur + 0.05);
    this.voices++;
    src.onended = () => { this.voices--; };
  }

  /** 从高空俯冲砸地 */
  slam(I) {
    if (!this._canPlay('slam', 250)) return;
    this._burst({ type: 'lowpass', freq: 4000, freqEnd: 300, dur: 0.25, gain: 0.9 * I, verb: 0.8 });
    this._tone({ f0: 70, f1: 18, dur: 2.0, gain: 1.0 * I, verb: 0.5 });
    this._burst({ buf: this.brown, type: 'lowpass', freq: 1500, freqEnd: 90, dur: 2.6, gain: 0.85 * I, verb: 1.0 });
    this.debrisRain(I, { gain: 1, pan: 0, delay: 0 });
  }

  /** 冲击拳 */
  punch(hit) {
    if (!this._canPlay('punch', 120)) return;
    this._tone({ f0: 160, f1: 38, dur: 0.4, gain: 0.8, verb: 0.5 });
    this._burst({ buf: this.pink, type: 'bandpass', freq: 500, freqEnd: 140, q: 0.8, dur: 0.45, gain: 0.7, verb: 0.6 });
    if (hit) this._burst({ type: 'lowpass', freq: 3000, freqEnd: 400, dur: 0.2, gain: 0.5 });
  }

  /** 起飞 / 急停的气流声 */
  takeoff(I = 1) {
    if (!this._canPlay('takeoff', 200)) return;
    this._burst({ buf: this.pink, type: 'lowpass', freq: 300, freqEnd: 1600, dur: 0.7, gain: 0.5 * I, attack: 0.05 });
    this._tone({ f0: 90, f1: 40, dur: 0.35, gain: 0.35 * I });
  }

  airBrake() {
    if (!this._canPlay('brake', 300)) return;
    this._burst({ buf: this.pink, type: 'bandpass', freq: 1800, freqEnd: 250, q: 0.7, dur: 0.6, gain: 0.7, verb: 0.4 });
    this._tone({ f0: 110, f1: 35, dur: 0.5, gain: 0.6, verb: 0.3 });
  }

  /** 极速启动瞬间 */
  hyperKick() {
    if (!this._canPlay('kick', 300)) return;
    this._tone({ f0: 55, f1: 120, dur: 0.5, gain: 0.5, wave: 'triangle' });
    this._burst({ buf: this.pink, type: 'bandpass', freq: 300, freqEnd: 3500, q: 0.9, dur: 0.7, gain: 0.6, verb: 0.4 });
  }

  /** 着陆 */
  land(I) {
    if (!this._canPlay('land', 150)) return;
    this._tone({ f0: 120, f1: 45, dur: 0.3, gain: 0.35 * I });
    this._burst({ buf: this.brown, type: 'lowpass', freq: 900, freqEnd: 150, dur: 0.35, gain: 0.3 * I });
  }

  /** 金属撞击（路灯、汽车被撞飞） */
  metal(I, sp) {
    if (!this._canPlay('metal', 60)) return;
    const g = sp.gain;
    if (g < 0.02) return;
    const f = 300 + Math.random() * 500;
    this._tone({ f0: f, f1: f * 0.7, dur: 0.6, gain: 0.25 * I * g, wave: 'triangle', pan: sp.pan, delay: sp.delay, verb: 0.4 });
    this._tone({ f0: f * 2.76, f1: f * 2.5, dur: 0.35, gain: 0.12 * I * g, pan: sp.pan, delay: sp.delay });
    this._burst({ type: 'bandpass', freq: 2200, q: 1, dur: 0.15, gain: 0.3 * I * g, pan: sp.pan, delay: sp.delay });
  }

  /** 树木折断 */
  wood(I, sp) {
    if (!this._canPlay('wood', 80)) return;
    const g = sp.gain;
    if (g < 0.02) return;
    this._burst({ type: 'bandpass', freq: 900, q: 2.5, dur: 0.25, gain: 0.4 * I * g, pan: sp.pan, delay: sp.delay });
    this._burst({ buf: this.pink, type: 'highpass', freq: 2500, dur: 0.5, gain: 0.15 * g, pan: sp.pan, delay: sp.delay + 0.05 });
  }
}
