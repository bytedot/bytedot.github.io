'use strict';
/* =====================================================================
 * input.js — 键盘 / 鼠标 / 指针锁定
 * 指针锁定失败（某些嵌入环境）时自动降级为"移动鼠标直接转视角"。
 * ===================================================================== */

class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.pressed = new Set();
    this.mx = 0; this.my = 0;
    this.wheel = 0;
    this.lmb = false; this.rmb = false;
    this.lmbPressed = false;
    this.locked = false;
    this.fallback = false;      // 无指针锁定时的降级模式
    this.enabled = false;       // 游戏进行中才处理视角
    this.doubleShift = false;
    this._lastShift = 0;
    this.onLockChange = null;

    const gameKeys = new Set(['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyX', 'ShiftLeft', 'ShiftRight',
      'ControlLeft', 'ControlRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyQ', 'KeyE']);

    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      // 屏蔽 Ctrl+S / Ctrl+D 等组合键的浏览器默认行为（Ctrl+W 无法屏蔽，靠离开确认兜底）
      if (gameKeys.has(e.code) || e.ctrlKey) e.preventDefault();
      if (e.repeat) return;
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight')) {
        const now = performance.now();
        if (now - this._lastShift < 330) this.doubleShift = true;
        this._lastShift = now;
      }
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.lmb = this.rmb = false; });

    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (!this.locked && !this.fallback) return;
      // 某些系统首帧会出现巨大的位移尖峰，做截断
      this.mx += U.clamp(e.movementX || 0, -250, 250);
      this.my += U.clamp(e.movementY || 0, -250, 250);
    });
    el.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (!this.locked && !this.fallback) { this.requestLock(); return; }
      if (e.button === 0) { this.lmb = true; this.lmbPressed = true; }
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.wheel += Math.sign(e.deltaY); }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.locked) this.fallback = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.locked = false;
      this.fallback = true;
    });
  }

  requestLock() {
    if (!this.el.requestPointerLock) { this.fallback = true; return; }
    try {
      const p = this.el.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) {
        p.catch(() => {
          // 不支持 unadjustedMovement 时退回普通锁定
          try {
            const p2 = this.el.requestPointerLock();
            if (p2 && p2.catch) p2.catch(() => { this.fallback = true; });
          } catch (err) { this.fallback = true; }
        });
      }
    } catch (err) {
      this.fallback = true;
    }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  hit(code) { return this.pressed.has(code); }

  get forward() { return (this.down('KeyW') || this.down('ArrowUp') ? 1 : 0) - (this.down('KeyS') || this.down('ArrowDown') ? 1 : 0); }
  get strafe() { return (this.down('KeyD') || this.down('ArrowRight') ? 1 : 0) - (this.down('KeyA') || this.down('ArrowLeft') ? 1 : 0); }
  get vertical() {
    const up = this.down('Space') ? 1 : 0;
    const dn = (this.down('ControlLeft') || this.down('ControlRight') || this.down('KeyC')) ? 1 : 0;
    return up - dn;
  }
  get shift() { return this.down('ShiftLeft') || this.down('ShiftRight'); }

  /** 每帧末尾清空"本帧"状态 */
  endFrame() {
    this.pressed.clear();
    this.mx = 0; this.my = 0;
    this.wheel = 0;
    this.lmbPressed = false;
    this.doubleShift = false;
  }

  reset() { this.keys.clear(); this.lmb = this.rmb = false; this.endFrame(); }
}
