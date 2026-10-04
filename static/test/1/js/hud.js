'use strict';
/* =====================================================================
 * hud.js — 极简界面：速度 / 马赫 / 高度 / 状态 / 极速标识 / 操作提示 / 横幅
 * ===================================================================== */

class HUD {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      hud: $('hud'), speed: $('speed'), mach: $('mach'), alt: $('alt'), mode: $('mode'),
      bar: $('speedbar'), hyper: $('hyperTag'), banner: $('banner'), hints: $('hints'),
      boundary: $('boundary'), fps: $('fps'),
    };
    this.t = 0;
    this.bannerT = 0;
    this.showFps = false;
    this.frames = 0;
    this.fpsT = 0;
    this.fpsV = 0;
    this.lastMode = '';
  }

  show(v) { this.el.hud.classList.toggle('hidden', !v); }
  toggleHints() { this.el.hints.classList.toggle('hidden'); }
  toggleFps() { this.showFps = !this.showFps; this.el.fps.textContent = ''; }

  banner(text, cls = '', dur = 1.2) {
    const b = this.el.banner;
    b.textContent = text;
    b.className = 'show' + (cls ? ' ' + cls : '');
    this.bannerT = dur;
  }

  update(dt, hero) {
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) { this.fpsV = this.frames / this.fpsT; this.frames = 0; this.fpsT = 0; }
    if (this.bannerT > 0) {
      this.bannerT -= dt;
      if (this.bannerT <= 0) this.el.banner.className = '';
    }
    this.t += dt;
    if (this.t < 0.066) return;     // 约 15Hz 刷新文字
    this.t = 0;
    const sp = hero.speed;
    const kmh = Math.round(sp * 3.6);
    this.el.speed.textContent = kmh;
    const mach = sp / CFG.hero.mach1;
    this.el.mach.textContent = 'M ' + mach.toFixed(2);
    this.el.mach.classList.toggle('super', mach >= 1);
    this.el.alt.textContent = Math.max(0, Math.round(hero.altitude));
    this.el.bar.style.width = Math.min(100, (sp / CFG.hero.hyper) * 100).toFixed(1) + '%';
    this.el.bar.classList.toggle('hyper', hero.hyper);
    this.el.hyper.classList.toggle('on', hero.hyper);
    let mode, cls = '';
    if (hero.state === 'landing') mode = '落地';
    else if (hero.state === 'ground') mode = sp > 8 ? '奔跑' : '步行';
    else if (hero.hyper) { mode = '极速'; cls = 'hyper'; }
    else if (sp > 85) { mode = '高速'; cls = 'fast'; }
    else if (sp < 3) mode = '悬停';
    else mode = '飞行';
    if (mode !== this.lastMode) {
      this.el.mode.textContent = mode;
      this.el.mode.className = 'chip' + (cls ? ' ' + cls : '');
      this.lastMode = mode;
    }
    this.el.boundary.classList.toggle('show', hero.nearBoundary);
    if (this.showFps) this.el.fps.textContent = Math.round(this.fpsV) + ' FPS';
  }
}
