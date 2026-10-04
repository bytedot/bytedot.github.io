'use strict';
/* =====================================================================
 * destruction.js — 破坏系统
 *  - 建筑：撞穿（破洞 + 内部可见）、碎窗、累计损伤后整体坍塌（下沉 + 巨量烟尘 + 碎石堆）
 *  - 小型建筑（独栋住宅、报亭、小商铺）：高速撞击直接完全摧毁
 *  - 道具 / 汽车：撞倒、撞飞、爆炸、连锁反应
 *  - 大型事件：地面冲击（俯冲砸地）、音爆、冲击拳、目光射线
 * 所有效果都走对象池（粒子 / 碎片 / 冲击波），远处碎片会自动加速消失。
 * ===================================================================== */

const DUST = [0.42, 0.4, 0.37];

class Destruction {
  constructor(scene, city, env) {
    this.scene = scene;
    this.city = city;
    this.env = env;
    this.collapsing = [];
    this.emitters = [];
    this.hitstop = 0;
    this._hitstopCd = 0;
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._n = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._shatterCd = 0;
    this._groundFxT = 0;
    this.stats = { buildings: 0, cars: 0 };
    this.beamCut = null;
    this._beamScorch = new THREE.Vector3(1e9, 0, 0);
    this._buildRubble(scene);
    // 刚体（汽车 / 道具）高速撞到建筑时调用
    this.onBodyHitBuilding = (B, p, axis, sp) => {
      if (B.state !== 0) return;
      const nx = axis === 0 ? -1 : axis === 1 ? 1 : 0, nz = axis === 2 ? -1 : axis === 3 ? 1 : 0;
      if (sp > 45 && B.kind !== BK.HOUSE && B.kind !== BK.SHOP) {
        this.city.ensureInterior(B);
        this.city.holes.add(B.id, p.x + nx, p.y, p.z + nz, p.x - nx * 3, p.y, p.z - nz * 3, 2.2, HOLE.SMASH);
        this.addDamage(B, 0.34);
      } else if (sp > 35 && (B.kind === BK.HOUSE || B.kind === BK.SHOP)) {
        this.obliterate(B, p.x, p.y, p.z, -nx, 0, -nz, sp);
        return;
      }
      this.shatter(B, p.x, p.y, p.z, 7);
      this.impactFx(p.x, p.y, p.z, nx, 0, nz, -nx, 0, -nz, Math.min(sp * 2, 200), B, 0.5);
    };
  }

  /* ---------------- 碎石堆 ---------------- */
  _buildRubble(scene) {
    const geo = jitterGeo(new THREE.IcosahedronGeometry(1, 1), 0.45, mulberry(42));
    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true });
    const cap = CFG.pools.rubble;
    this.rubble = new THREE.InstancedMesh(geo, mat, cap);
    this.rubble.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    for (let i = 0; i < cap; i++) writeZeroMatrix(this.rubble.instanceMatrix.array, i);
    this.rubble.count = 0;
    this.rubble.castShadow = true;
    this.rubble.receiveShadow = true;
    this.rubble.frustumCulled = false;
    scene.add(this.rubble);
    this._rubbleNext = 0;
  }

  addRubble(b) {
    const n = U.clamp(Math.round((b.hw * b.hd) / 120), 2, 6);
    const hgt = U.clamp(b.h * 0.07, 1.5, 11);
    b.rubbleIdx = [];
    for (let k = 0; k < n; k++) {
      const i = this._rubbleNext;
      b.rubbleIdx.push(i);
      this._rubbleNext = (this._rubbleNext + 1) % CFG.pools.rubble;
      this.rubble.count = Math.max(this.rubble.count, i + 1);
      const x = b.cx + U.rand(-0.45, 0.45) * b.hw, z = b.cz + U.rand(-0.45, 0.45) * b.hd;
      const sx = b.hw * U.rand(0.45, 0.8), sz = b.hd * U.rand(0.45, 0.8);
      writeYawMatrix(this.rubble.instanceMatrix.array, i, x, b.y0 - hgt * 0.15, z, Math.random() * 6.28, sx, hgt * U.rand(0.6, 1.1), sz);
      const c = b.color, g = 0.45;
      this.rubble.instanceColor.setXYZ(i, U.lerp(c.r, 0.25, g) * 0.8, U.lerp(c.g, 0.24, g) * 0.8, U.lerp(c.b, 0.22, g) * 0.8);
    }
    this.rubble.instanceMatrix.needsUpdate = true;
    this.rubble.instanceColor.needsUpdate = true;
  }

  /* ---------------- 通用特效 ---------------- */
  dust(x, y, z, n, size, spread, vel, life = 4, col = DUST, alpha = 0.55) {
    for (let k = 0; k < n; k++) {
      const s = U.rand(0.7, 1.3);
      G.dust.emit(
        x + U.rand(-spread, spread), y + U.rand(-spread, spread) * 0.5, z + U.rand(-spread, spread),
        U.rand(-vel, vel), U.rand(-0.2, 1) * vel * 0.6, U.rand(-vel, vel),
        life * U.rand(0.7, 1.3), size * 0.5 * s, size * 2.2 * s,
        col[0] * U.rand(0.85, 1.1), col[1] * U.rand(0.85, 1.1), col[2] * U.rand(0.85, 1.1),
        alpha, 1.3, -0.25, U.rand(-0.4, 0.4));
    }
  }

  sparks(x, y, z, n, speed, dx = 0, dy = 0, dz = 0) {
    for (let k = 0; k < n; k++) {
      G.glow.emit(x, y, z,
        dx * speed + U.rand(-1, 1) * speed * 0.6, dy * speed + U.rand(-0.3, 1) * speed * 0.6, dz * speed + U.rand(-1, 1) * speed * 0.6,
        U.rand(0.25, 0.6), U.rand(0.08, 0.18), 0.05, 3.2, 1.7, 0.6, 1, 0.8, 14);
    }
  }

  fire(x, y, z, n, size) {
    for (let k = 0; k < n; k++) {
      G.glow.emit(x + U.rand(-1, 1) * size * 0.3, y + U.rand(0, 1) * size * 0.3, z + U.rand(-1, 1) * size * 0.3,
        U.rand(-2, 2), U.rand(2, 7), U.rand(-2, 2),
        U.rand(0.4, 0.9), size * 0.4, size * 1.3, 3.6, 1.3, 0.35, 0.75, 1.2, -4, U.rand(-1, 1));
    }
  }

  /** 撞击点特效：碎块、玻璃、烟尘、圆环冲击波、火花、声音、震屏、顿帧 */
  impactFx(px, py, pz, nx, ny, nz, dx, dy, dz, speed, b, scale = 1) {
    const I = U.clamp(speed / 430, 0.06, 1) * scale;
    const c = b ? b.color : { r: 0.4, g: 0.4, b: 0.4 };
    const nDeb = Math.round(6 + 38 * I);
    for (let k = 0; k < nDeb; k++) {
      const out = U.rand(4, 18) * (0.6 + I);
      const carry = U.rand(0.05, 0.3) * Math.min(speed, 200);
      const g = U.rand(0.45, 0.8);
      G.debris.spawn(px + U.rand(-2, 2), py + U.rand(-2, 2), pz + U.rand(-2, 2),
        nx * out + dx * carry * 0.3 + U.rand(-6, 6), ny * out + U.rand(-2, 10) + dy * carry * 0.3, nz * out + dz * carry * 0.3 + U.rand(-6, 6),
        U.rand(0.25, 0.85) * (1 + I * 0.8), U.lerp(c.r, 0.3, g), U.lerp(c.g, 0.29, g), U.lerp(c.b, 0.27, g), U.rand(4, 8));
    }
    if (!b || b.glass || b.facade === FACADE.RESI || b.facade === FACADE.COMMERCIAL) {
      const nGl = Math.round((b && b.facade === FACADE.GLASS ? 20 : 8) + 50 * I);
      for (let k = 0; k < nGl; k++) {
        G.shards.spawn(px + U.rand(-3, 3), py + U.rand(-3, 3), pz + U.rand(-3, 3),
          nx * U.rand(3, 16) + U.rand(-5, 5), ny * U.rand(3, 16) + U.rand(-2, 8), nz * U.rand(3, 16) + U.rand(-5, 5),
          U.rand(0.15, 0.5), 0.75, 0.85, 0.95, U.rand(2.5, 5), 20);
      }
    }
    this.dust(px + nx * 1.5, py + ny * 1.5, pz + nz * 1.5, Math.round(5 + 16 * I), 3 + 5 * I, 2 + 3 * I, 5 + 9 * I, 3.5 + 3 * I);
    this._n.set(nx, ny, nz);
    this._v.set(px + nx * 0.4, py + ny * 0.4, pz + nz * 0.4);
    G.shock.ring(this._v, this._n, 1.5, 6 + 30 * I, 0.55, 0.55, 0xd9d2c4, false, 0.25);
    if (I > 0.35) G.shock.ring(this._v, this._n, 1, 10 + 40 * I, 0.35, 0.5, 0xfff2dc, true, 0.75);
    this.sparks(px, py, pz, Math.round(4 + 18 * I), 18 + 30 * I, nx * 0.5, ny * 0.5, nz * 0.5);
    const sp = G.audio.spatial(px, py, pz);
    G.audio.impact(I, sp);
    if (!b || b.glass) G.audio.glass(Math.min(1, I * 1.4), sp);
    const fall = U.clamp(1 - sp.dist / 400, 0, 1);
    G.rig.addTrauma((0.16 + 0.55 * I) * fall);
    if (I > 0.4 && this._hitstopCd <= 0) { this.hitstop = 0.055 + 0.04 * I; this._hitstopCd = 0.9; }
  }

  /* ---------------- 建筑 ---------------- */

  /** 在建筑上记录一个碎窗区域 */
  shatter(b, x, y, z, r) {
    if (b.state === 2 || r < 2) return;
    // 把点吸附到建筑表面
    const cx = U.clamp(x, b.x0, b.x1), cy = U.clamp(y, b.y0, b.y1 - b.sink), cz = U.clamp(z, b.z0, b.z1);
    if (this.city.holes.covered(b.id, cx, cy + b.sink, cz, r)) return;
    this.city.holes.add(b.id, cx, cy + b.sink, cz, cx, cy + b.sink, cz, r, HOLE.SHATTER);
    const sp = G.audio.spatial(cx, cy, cz);
    G.audio.glass(U.clamp(r / 25, 0.2, 0.8), sp);
    const n = Math.round(U.clamp(r * 1.2, 4, 26));
    for (let k = 0; k < n; k++) {
      G.shards.spawn(cx + U.rand(-r, r) * 0.6, cy + U.rand(-r, r) * 0.6, cz + U.rand(-r, r) * 0.6,
        U.rand(-3, 3), U.rand(-1, 2), U.rand(-3, 3), U.rand(0.12, 0.4), 0.75, 0.85, 0.95, U.rand(2.5, 4.5), 18);
    }
  }

  /**
   * 角色撞进建筑。返回 { slot, r } 表示开始在建筑内穿行；返回 null 表示建筑已被整体摧毁。
   * (px,py,pz) 撞击点；(nx,ny,nz) 撞击面法线；(dx,dy,dz) 运动方向
   */
  smash(b, px, py, pz, nx, ny, nz, dx, dy, dz, speed) {
    if ((b.kind === BK.HOUSE || b.kind === BK.SHOP) && speed > 12) {
      this.obliterate(b, px, py, pz, dx, dy, dz, speed);
      return null;
    }
    const r = U.clamp(2.3 + speed * 0.012, 2.3, 7.4);
    this.city.ensureInterior(b);
    const sy = b.sink;
    const slot = this.city.holes.add(b.id, px - dx * r * 0.7, py - dy * r * 0.7 + sy, pz - dz * r * 0.7,
      px + dx * 0.5, py + dy * 0.5 + sy, pz + dz * 0.5, r, HOLE.SMASH);
    if (speed > 120) this.shatter(b, px, py, pz, r * 3.5 + speed * 0.03);
    this.impactFx(px, py, pz, nx, ny, nz, dx, dy, dz, speed, b);
    const low = (py - b.y0) < b.h * 0.34 ? 1.5 : 1;
    this.addDamage(b, (speed > 250 ? 2 : 1) * low);
    return { slot, r };
  }

  /** 角色在建筑内部持续穿行：延长破洞胶囊 */
  carve(b, hole, x, y, z, dx, dy, dz, speed) {
    if (b.state === 2) return;
    const H = this.city.holes;
    const sy = b.sink;
    if (H.slotType(b.id, hole.slot) !== HOLE.SMASH) {
      hole.slot = H.add(b.id, x, y + sy, z, x + dx * 0.3, y + dy * 0.3 + sy, z + dz * 0.3, hole.r, HOLE.SMASH);
      return;
    }
    // 方向变化较大时开一段新的胶囊
    const k = H.base(b.id) + hole.slot * 8, d = H.data;
    const ax = d[k], ay = d[k + 1], az = d[k + 2];
    const ex = x - ax, ey = y + sy - ay, ez = z - az;
    const el = Math.hypot(ex, ey, ez);
    if (el > 6 && (ex * dx + ey * dy + ez * dz) / el < 0.93) {
      hole.slot = H.add(b.id, x - dx * 1.5, y + sy - dy * 1.5, z - dz * 1.5, x + dx * 0.3, y + dy * 0.3 + sy, z + dz * 0.3, hole.r, HOLE.SMASH);
    } else {
      H.setEnd(b.id, hole.slot, x + dx * 0.3, y + dy * 0.3 + sy, z + dz * 0.3);
    }
    // 楼内碎屑
    if (Math.random() < 0.35) this.dust(x, y, z, 1, 3, 1, 4, 2.5, [0.3, 0.29, 0.27], 0.5);
  }

  /** 从建筑另一侧冲出：碎块和玻璃向外爆开 */
  exitBurst(b, hole, px, py, pz, nx, ny, nz, dx, dy, dz, speed) {
    if (b.state === 2) return;
    const H = this.city.holes;
    const sy = b.sink;
    if (H.slotType(b.id, hole.slot) === HOLE.SMASH) H.setEnd(b.id, hole.slot, px + dx * hole.r * 0.8, py + dy * hole.r * 0.8 + sy, pz + dz * hole.r * 0.8);
    const I = U.clamp(speed / 430, 0.06, 1);
    const c = b.color;
    const n = Math.round(8 + 40 * I);
    for (let k = 0; k < n; k++) {
      const sp = U.rand(0.15, 0.5) * Math.min(speed, 260) + U.rand(3, 10);
      const g = U.rand(0.45, 0.8);
      G.debris.spawn(px + U.rand(-2, 2), py + U.rand(-2, 2), pz + U.rand(-2, 2),
        dx * sp + U.rand(-8, 8), dy * sp + U.rand(-3, 9), dz * sp + U.rand(-8, 8),
        U.rand(0.3, 1.0) * (1 + I), U.lerp(c.r, 0.3, g), U.lerp(c.g, 0.29, g), U.lerp(c.b, 0.27, g), U.rand(4, 8));
    }
    if (b.glass || b.facade === FACADE.RESI) {
      for (let k = 0; k < 15 + 50 * I; k++) {
        const sp = U.rand(0.1, 0.4) * Math.min(speed, 240) + U.rand(2, 8);
        G.shards.spawn(px + U.rand(-3, 3), py + U.rand(-3, 3), pz + U.rand(-3, 3),
          dx * sp + U.rand(-6, 6), dy * sp + U.rand(-2, 6), dz * sp + U.rand(-6, 6), U.rand(0.15, 0.5), 0.75, 0.85, 0.95, U.rand(2.5, 5), 20);
      }
    }
    this.dust(px + dx * 2, py, pz + dz * 2, Math.round(6 + 14 * I), 3 + 5 * I, 2, 6 + 10 * I, 4 + 3 * I);
    this._n.set(nx, ny, nz);
    this._v.set(px, py, pz);
    G.shock.ring(this._v, this._n, 1.5, 8 + 30 * I, 0.5, 0.5, 0xd9d2c4, false, 0.25);
    const sp = G.audio.spatial(px, py, pz);
    G.audio.impact(I * 0.8, sp);
    if (b.glass) G.audio.glass(I, sp);
    G.rig.addTrauma(0.1 + 0.3 * I);
    if (speed > 120) this.shatter(b, px, py, pz, 10 + speed * 0.03);
  }

  /** 小型建筑被完全摧毁 */
  obliterate(b, px, py, pz, dx, dy, dz, speed) {
    if (b.state === 2) return;
    this.city.hide(b);
    this.stats.buildings++;
    const I = U.clamp(speed / 300, 0.2, 1);
    const vol = b.hw * b.hd * b.h;
    const n = Math.round(U.clamp(vol / 25, 18, 60));
    const c = b.color;
    for (let k = 0; k < n; k++) {
      const x = b.cx + U.rand(-1, 1) * b.hw, y = b.y0 + U.rand(0.1, 1) * b.h, z = b.cz + U.rand(-1, 1) * b.hd;
      const carry = U.rand(0.1, 0.45) * Math.min(speed, 220);
      const g = U.rand(0, 0.5);
      G.debris.spawn(x, y, z, dx * carry + U.rand(-8, 8), U.rand(2, 14), dz * carry + U.rand(-8, 8),
        U.rand(0.4, 1.4), U.lerp(c.r, 0.3, g), U.lerp(c.g, 0.28, g), U.lerp(c.b, 0.26, g), U.rand(5, 9));
    }
    if (b.roof >= 0) {
      for (let k = 0; k < 14; k++) {
        G.debris.spawn(b.cx + U.rand(-1, 1) * b.hw, b.y1 + 1, b.cz + U.rand(-1, 1) * b.hd,
          dx * U.rand(10, 40) + U.rand(-6, 6), U.rand(4, 16), dz * U.rand(10, 40) + U.rand(-6, 6), U.rand(0.6, 1.4), 0.25, 0.12, 0.09, U.rand(5, 8));
      }
    }
    for (let k = 0; k < 25; k++) {
      G.shards.spawn(b.cx + U.rand(-1, 1) * b.hw, b.y0 + U.rand(0.2, 1) * b.h, b.cz + U.rand(-1, 1) * b.hd,
        dx * U.rand(5, 30) + U.rand(-5, 5), U.rand(0, 8), dz * U.rand(5, 30) + U.rand(-5, 5), U.rand(0.15, 0.4), 0.75, 0.85, 0.95, 4, 18);
    }
    this.dust(b.cx, b.y0 + b.h * 0.4, b.cz, 18, 5 + b.h * 0.25, Math.max(b.hw, b.hd) * 0.6, 7, 6);
    this.addRubble(b);
    this._v.set(b.cx, 0.6, b.cz);
    G.shock.ring(this._v, this._up, 2, Math.max(b.hw, b.hd) * 3, 0.8, 0.5, 0xd9d2c4, false, 0.4);
    const sp = G.audio.spatial(b.cx, b.y0 + b.h / 2, b.cz);
    G.audio.impact(Math.max(0.6, I), sp);
    G.audio.glass(0.7, sp);
    G.rig.addTrauma(0.35 * U.clamp(1 - sp.dist / 300, 0, 1));
    this.emitters.push({ x: b.cx, y: 1, z: b.cz, t: 0, dur: 10, rate: 3, kind: 'dust', size: 6, spread: Math.max(b.hw, b.hd) * 0.6 });
  }

  addDamage(b, amount) {
    if (b.state !== 0) return;
    b.damage += amount;
    if (b.damage >= b.threshold) this.startCollapse(b);
  }

  /** 整体坍塌：建筑及其上方部件一起下沉，伴随巨量烟尘 */
  startCollapse(b) {
    if (b.state !== 0) return;
    const group = [];
    const collect = (x) => {
      if (x.state === 0) { x.state = 1; group.push(x); }
      // 上方部件此前坍塌留下的碎石堆，会随底座一起消失
      if (x !== b && x.rubbleIdx) {
        for (const i of x.rubbleIdx) writeZeroMatrix(this.rubble.instanceMatrix.array, i);
        x.rubbleIdx = null;
        this.rubble.instanceMatrix.needsUpdate = true;
      }
      for (const c of x.children) collect(this.city.buildings[c]);
    };
    collect(b);
    let top = b.y1;
    for (const x of group) top = Math.max(top, x.y1);
    const H = top - b.y0;
    const dur = U.clamp(Math.sqrt(H) * 0.62, 2.6, 10);
    this.collapsing.push({ b, group, t: 0, dur, H, seed: Math.random() * 100, base: b.y0 });
    this.stats.buildings += group.length;
    const sp = G.audio.spatial(b.cx, b.y0 + H * 0.3, b.cz, 160);
    G.audio.collapse(U.clamp(H / 150, 0.5, 1.2), sp, dur);
    if (G.hud && H > 60) G.hud.banner(H > 200 ? '摩天楼倒塌' : '大楼倒塌', 'gold', 1.6);
  }

  _updateCollapses(dt) {
    for (let k = 0; k < this.collapsing.length; k++) {
      const c = this.collapsing[k];
      c.t += dt;
      const kk = Math.min(c.t / c.dur, 1);
      const e = Math.pow(kk, 1.7);
      const sink = (c.H + 2) * e;
      const amp = 0.45 * (1 - kk) * Math.min(1, c.t * 3);
      const jx = (noise1(c.t * 9, c.seed) - 0.5) * amp, jz = (noise1(c.t * 9, c.seed + 5) - 0.5) * amp;
      for (const x of c.group) this.city.setSink(x, sink + (c.base - c.b.y0), jx, jz);
      const b = c.b;
      const perim = (b.hw + b.hd) * 2;
      // 底部向外翻涌的烟尘
      const n = Math.min(6, 1 + Math.floor(perim / 50));
      for (let i = 0; i < n; i++) {
        const t = Math.random() * 4;
        let ex, ez, ox, oz;
        if (t < 1) { ex = U.lerp(b.x0, b.x1, t); ez = b.z0; ox = 0; oz = -1; }
        else if (t < 2) { ex = b.x1; ez = U.lerp(b.z0, b.z1, t - 1); ox = 1; oz = 0; }
        else if (t < 3) { ex = U.lerp(b.x1, b.x0, t - 2); ez = b.z1; ox = 0; oz = 1; }
        else { ex = b.x0; ez = U.lerp(b.z1, b.z0, t - 3); ox = -1; oz = 0; }
        const s = U.rand(0.8, 1.3) * U.clamp(c.H / 40, 1, 3);
        G.dust.emit(ex, b.y0 + U.rand(1, 6), ez, ox * U.rand(6, 24) + U.rand(-3, 3), U.rand(0.5, 4), oz * U.rand(6, 24) + U.rand(-3, 3),
          U.rand(6, 11), 6 * s, 26 * s, DUST[0] * U.rand(0.9, 1.1), DUST[1] * U.rand(0.9, 1.1), DUST[2] * U.rand(0.9, 1.1), 0.65, 0.55, -0.35, U.rand(-0.2, 0.2));
      }
      // 顶部边缘不断崩落的碎块与烟尘
      const topY = b.y0 + c.H - sink;
      if (topY > b.y0 + 2) {
        const cc = b.color;
        for (let i = 0; i < 2; i++) {
          const x = U.rand(b.x0, b.x1), z = U.rand(b.z0, b.z1);
          G.debris.spawn(x, topY, z, U.rand(-7, 7), U.rand(-2, 5), U.rand(-7, 7), U.rand(0.8, 2.4), cc.r * 0.8, cc.g * 0.8, cc.b * 0.8, 5);
        }
        if (Math.random() < 0.7) {
          const x = U.rand(b.x0, b.x1), z = U.rand(b.z0, b.z1);
          const s = U.clamp(c.H / 60, 1, 2.5);
          G.dust.emit(x, topY + 2, z, U.rand(-5, 5), U.rand(2, 7), U.rand(-5, 5), U.rand(4, 7), 5 * s, 16 * s,
            DUST[0], DUST[1], DUST[2], 0.5, 0.6, -0.4, U.rand(-0.3, 0.3));
        }
      }
      if (b.glass && Math.random() < 0.6) {
        G.shards.spawn(U.rand(b.x0, b.x1), U.rand(b.y0, topY), Math.random() < 0.5 ? b.z0 : b.z1, U.rand(-4, 4), U.rand(-2, 2), U.rand(-4, 4), U.rand(0.2, 0.5), 0.75, 0.85, 0.95, 4, 16);
      }
      // 远近决定的持续震动
      const d = G.camera.position.distanceTo(this._v.set(b.cx, Math.max(0, topY * 0.5), b.cz));
      G.rig.addTrauma(dt * 1.2 * U.clamp(1 - d / (300 + c.H * 2), 0, 1) * (1 - kk * 0.6));
      if (kk >= 1) {
        for (const x of c.group) this.city.hide(x);
        this.addRubble(b);
        this.emitters.push({ x: b.cx, y: b.y0 + 2, z: b.cz, t: 0, dur: 24, rate: 5, kind: 'dust', size: 8 + c.H * 0.05, spread: Math.max(b.hw, b.hd) * 0.7 });
        this.collapsing.splice(k, 1); k--;
      }
    }
  }

  /* ---------------- 道具与汽车 ---------------- */
  hitProp(p, vx, vy, vz, speed) {
    const ps = this.city.props;
    const T = ps.types[p.t];
    const sp = G.audio.spatial(p.x, 2, p.z);
    if (T.name === 'fountain') {
      ps.destroy(p);
      for (let k = 0; k < 30; k++) G.debris.spawn(p.x + U.rand(-5, 5), 1, p.z + U.rand(-5, 5), vx * 0.3 + U.rand(-10, 10), U.rand(4, 16), vz * 0.3 + U.rand(-10, 10), U.rand(0.5, 1.2), 0.45, 0.43, 0.4, 7);
      this.water(p.x, 1, p.z, 60, 14);
      this.emitters.push({ x: p.x, y: 1, z: p.z, t: 0, dur: 14, rate: 30, kind: 'water' });
      G.audio.impact(0.6, sp);
      return;
    }
    const hs = Math.hypot(vx, vz) || 1;
    if (T.topple && (speed < 70 || T.name === 'monument') && p.state === 0) {
      ps.topple(p, vx / hs, vz / hs, U.clamp(speed / 60, 0.3, 1.5));
      if (T.snd === 'wood') G.audio.wood(0.8, sp); else G.audio.metal(0.8, sp);
      this.dust(p.x, 1, p.z, 3, 2.5, 1, 3, 3);
      if (T.name === 'monument') { G.audio.impact(0.7, sp); this.sparks(p.x, 3, p.z, 20, 20); }
      return;
    }
    const k = U.clamp(0.85 - speed / 900, 0.4, 0.85);
    const cap = 150;
    let lvx = vx * k, lvz = vz * k;
    const l = Math.hypot(lvx, lvz);
    if (l > cap) { lvx *= cap / l; lvz *= cap / l; }
    const d = ps.launch(p, lvx + U.rand(-4, 4), Math.max(vy * 0.5, 0) + 5 + Math.min(speed * 0.1, 30), lvz + U.rand(-4, 4), 5 + Math.min(speed * 0.06, 18));
    if (!d) return;
    if (T.snd === 'wood') G.audio.wood(1, sp);
    else if (T.snd === 'glass') G.audio.glass(0.6, sp);
    else G.audio.metal(1, sp);
    if (T.glass) for (let i = 0; i < 18; i++) G.shards.spawn(p.x, 1.5, p.z, U.rand(-6, 6) + vx * 0.2, U.rand(1, 7), U.rand(-6, 6) + vz * 0.2, U.rand(0.15, 0.4), 0.75, 0.85, 0.95, 4, 16);
    if (T.water) this.emitters.push({ x: p.x, y: 0.5, z: p.z, t: 0, dur: 16, rate: 26, kind: 'water' });
    this.sparks(p.x, 1.5, p.z, 6, 12);
  }

  hitCar(car, vx, vy, vz, speed) {
    const tr = this.city.traffic;
    if (car.mode >= 2) return;
    const k = U.clamp(0.9 - speed / 800, 0.4, 0.85);
    let lvx = vx * k, lvz = vz * k;
    const l = Math.hypot(lvx, lvz), cap = 160;
    if (l > cap) { lvx *= cap / l; lvz *= cap / l; }
    tr.launch(car, lvx + U.rand(-3, 3), Math.max(vy * 0.4, 0) + 4 + Math.min(speed * 0.12, 38), lvz + U.rand(-3, 3), 3 + Math.min(speed * 0.05, 12));
    this.stats.cars++;
    const sp = G.audio.spatial(car.x, 1, car.z);
    G.audio.metal(1, sp);
    G.audio.glass(0.5, sp);
    this.sparks(car.x, 1, car.z, 14, 20, vx / (speed || 1), 0.3, vz / (speed || 1));
    for (let i = 0; i < 10; i++) G.shards.spawn(car.x, 1.3, car.z, U.rand(-5, 5) + vx * 0.2, U.rand(1, 6), U.rand(-5, 5) + vz * 0.2, U.rand(0.1, 0.3), 0.6, 0.7, 0.75, 3.5, 18);
    G.rig.addTrauma(0.12);
    if (speed > 85 || (speed > 45 && Math.random() < 0.4)) this.explodeCar(car, speed > 85 ? 0 : U.rand(0.2, 0.8));
  }

  /** 汽车爆炸（可延迟），会推开并可能引爆附近车辆 */
  explodeCar(car, delay = 0) {
    if (car.exploding || car.burnt) return;
    car.exploding = true;
    this.emitters.push({ kind: 'explode', car, t: -delay, dur: 0.01 });
  }

  _doExplode(car) {
    const x = car.body ? car.body.p.x : car.x, y = car.body ? car.body.p.y : 1, z = car.body ? car.body.p.z : car.z;
    this.city.traffic.burn(car);
    for (let k = 0; k < 40; k++) {
      G.glow.emit(x + U.rand(-1.5, 1.5), y + U.rand(0, 1.5), z + U.rand(-1.5, 1.5), U.rand(-9, 9), U.rand(2, 14), U.rand(-9, 9),
        U.rand(0.5, 1.2), U.rand(1.5, 3), U.rand(4, 8), 4.5, 1.6, 0.35, 0.85, 2.5, -3, U.rand(-1, 1));
    }
    for (let k = 0; k < 16; k++) {
      G.dust.emit(x + U.rand(-2, 2), y + U.rand(0, 3), z + U.rand(-2, 2), U.rand(-4, 4), U.rand(3, 9), U.rand(-4, 4),
        U.rand(4, 8), 3, 12, 0.06, 0.055, 0.05, 0.8, 0.8, -1.2, U.rand(-0.3, 0.3));
    }
    const col = car.color;
    for (let k = 0; k < 14; k++) {
      const dark = Math.random() < 0.5 ? 0.12 : 0.45;
      G.debris.spawn(x, y + 0.5, z, U.rand(-14, 14), U.rand(6, 22), U.rand(-14, 14), U.rand(0.12, 0.4), col.r * dark, col.g * dark, col.b * dark, 6);
    }
    this.sparks(x, y, z, 30, 30);
    this._v.set(x, Math.max(0.4, y), z);
    G.shock.sphere(this._v, 2, 14, 0.3, 0.35, 0xffb25a);
    G.shock.ring(this._v.set(x, 0.4, z), this._up, 1, 22, 0.6, 0.5, 0x6b6359, false, 0.4);
    this.env.addCrater(x, z, 3.2, 0.8);
    const sp = G.audio.spatial(x, y, z);
    G.audio.explosion(1, sp);
    G.rig.addTrauma(0.35 * U.clamp(1 - sp.dist / 250, 0, 1));
    G.post.flash(0.12 * U.clamp(1 - sp.dist / 300, 0, 1));
    this.emitters.push({ kind: 'burn', car, t: 0, dur: 18, rate: 10 });
    // 连锁反应
    const near = this.city.traffic.queryNear(x, z, 14);
    for (const c of near) {
      const dx = c.x - x, dz = c.z - z, d = Math.hypot(dx, dz) || 1;
      this.city.traffic.launch(c, dx / d * 14, 10 + Math.random() * 6, dz / d * 14, 4);
      if (Math.random() < 0.55) this.explodeCar(c, U.rand(0.3, 1.2));
    }
    for (const p of this.city.props.query(x - 10, z - 10, x + 10, z + 10)) {
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz) || 1;
      if (d < 10) this.hitProp(p, dx / d * 30, 8, dz / d * 30, 30);
    }
  }

  water(x, y, z, n, up) {
    for (let k = 0; k < n; k++) {
      G.dust.emit(x + U.rand(-0.3, 0.3), y, z + U.rand(-0.3, 0.3), U.rand(-2.5, 2.5), U.rand(up * 0.6, up), U.rand(-2.5, 2.5),
        U.rand(1.2, 2.2), 0.4, 1.6, 0.62, 0.72, 0.8, 0.45, 0.4, 9.8, 0);
    }
  }

  /** 道具倒地时的扬尘 */
  toppleImpact(p, T) {
    const tip = T.h * p.s * 0.75;
    this.dust(p.x, 0.8, p.z, 3, 2 + T.h * 0.1, tip * 0.3, 3, 3);
    const sp = G.audio.spatial(p.x, 1, p.z);
    if (T.name === 'monument') { G.audio.impact(0.8, sp); G.rig.addTrauma(0.3); this.dust(p.x, 1, p.z, 16, 6, 12, 6, 6); }
    else G.audio.land(0.6);
  }

  /* ---------------- 气流影响（高速掠过） ---------------- */
  airPressure(pos, vel, speed, dt, altitude) {
    if (speed < 45) return;
    const R = 8 + speed * 0.06;
    const low = altitude < 30;
    // 汽车晃动 / 被吹翻
    if (pos.y < 40) {
      for (const car of this.city.traffic.queryNear(pos.x, pos.z, R)) {
        const dx = car.x - pos.x, dz = car.z - pos.z, d = Math.hypot(dx, dz);
        if (d > R) continue;
        const k = (1 - d / R) * U.clamp(speed / 300, 0, 1.5) * U.clamp(1 - (pos.y - 1) / 40, 0, 1);
        car.shake = Math.max(car.shake, k * 2.2);
        if (speed > 260 && d < 6 && pos.y < 8) this.hitCar(car, dx / (d || 1) * 25 + vel.x * 0.1, 10, dz / (d || 1) * 25 + vel.z * 0.1, 60);
      }
    }
    // 小型道具被气流卷走
    if (speed > 170 && pos.y < 14) {
      for (const p of this.city.props.query(pos.x - 8, pos.z - 8, pos.x + 8, pos.z + 8)) {
        const T = this.city.props.types[p.t];
        if (T.topple || T.heavy) continue;
        const dx = p.x - pos.x, dz = p.z - pos.z, d = Math.hypot(dx, dz);
        if (d < 7) this.hitProp(p, vel.x * 0.25 + dx * 3, 8, vel.z * 0.25 + dz * 3, 40);
      }
    }
    // 贴地高速飞行：地面扬尘、空气冲击环
    if (low) {
      const k = U.clamp(1 - altitude / 30, 0, 1) * U.smooth(45, 300, speed);
      const n = Math.round(k * 4 + Math.random());
      for (let i = 0; i < n; i++) {
        const side = U.randSign();
        const sx = -vel.z / speed, sz = vel.x / speed;
        const w = U.rand(0.5, 3 + speed * 0.02);
        G.dust.emit(pos.x + sx * side * w - vel.x * 0.02, 0.6, pos.z + sz * side * w - vel.z * 0.02,
          sx * side * U.rand(4, 14) * (speed / 200) + vel.x * 0.04, U.rand(1, 5), sz * side * U.rand(4, 14) * (speed / 200) + vel.z * 0.04,
          U.rand(2, 4), 1.5 + speed * 0.01, 5 + speed * 0.03, 0.5, 0.48, 0.44, 0.38 * k, 1.2, -0.3, U.rand(-0.5, 0.5));
      }
      this._groundFxT -= dt;
      if (speed > 220 && altitude < 14 && this._groundFxT <= 0) {
        this._groundFxT = 0.12;
        this._v.set(pos.x, 0.25, pos.z);
        G.shock.ring(this._v, this._up, 2, 14 + speed * 0.05, 0.5, 0.25 * k, 0xe6ddcc, false, 0.6);
      }
    }
  }

  /** 极速贴近建筑：震碎沿途玻璃 */
  windowBlast(b, x, y, z, speed) {
    this._shatterCd -= 1;
    if (this._shatterCd > 0) return;
    this._shatterCd = 3;
    this.shatter(b, x, y, z, 8 + speed * 0.035);
  }

  /* ---------------- 大型事件 ---------------- */

  /** 从高空俯冲砸向地面 */
  groundSlam(pos, power) {
    const R = U.clamp(power * 0.42, 18, 95);
    const I = U.clamp(power / 300, 0.3, 1);
    const x = pos.x, z = pos.z;
    this.env.addCrater(x, z, R * 0.38, 1);
    for (let k = 0; k < 60 + R; k++) {
      const a = Math.random() * Math.PI * 2, r0 = U.rand(0, R * 0.25);
      const v = U.rand(18, 55) * (R / 60);
      G.dust.emit(x + Math.cos(a) * r0, U.rand(0.5, 3), z + Math.sin(a) * r0, Math.cos(a) * v, U.rand(1, 6), Math.sin(a) * v,
        U.rand(3.5, 7), 5, 16 + R * 0.12, DUST[0], DUST[1], DUST[2], 0.6, 1.1, -0.4, U.rand(-0.3, 0.3));
    }
    for (let k = 0; k < 40 + R * 0.6; k++) {
      const a = Math.random() * Math.PI * 2, v = U.rand(4, 22);
      const g = U.rand(0.05, 0.25);
      G.debris.spawn(x + Math.cos(a) * 2, 0.5, z + Math.sin(a) * 2, Math.cos(a) * v, U.rand(10, 36) * I, Math.sin(a) * v,
        U.rand(0.2, 0.75), g, g, g * 1.05, U.rand(4, 8));
    }
    this.sparks(x, 1, z, 30, 26);
    this._v.set(x, 0.4, z);
    G.shock.ring(this._v, this._up, 2, R * 2.4, 0.95, 0.85, 0xd8cfbf, false, 0.45);
    G.shock.ring(this._v, this._up, 1, R * 1.6, 0.5, 0.7, 0xfff1d6, true, 0.8);
    this._v.set(x, 0, z);
    G.shock.sphere(this._v, 2, R * 1.5, 0.75, 0.7, 0xfff3e0);
    // 波及范围内的道具、汽车、建筑
    for (const p of this.city.props.query(x - R, z - R, x + R, z + R)) {
      const dx = p.x - x, dz = p.z - z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const k = 1 - d / R, l = d || 1;
      this.hitProp(p, dx / l * (15 + 45 * k), 8 + 22 * k, dz / l * (15 + 45 * k), 80 + 100 * k);
    }
    for (const car of this.city.traffic.queryNear(x, z, R)) {
      const dx = car.x - x, dz = car.z - z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const k = 1 - d / R, l = d || 1;
      this.city.traffic.launch(car, dx / l * (12 + 40 * k), 8 + 24 * k, dz / l * (12 + 40 * k), 4 + 8 * k);
      this.stats.cars++;
      if (k > 0.55 || Math.random() < 0.25) this.explodeCar(car, U.rand(0.1, 0.9));
    }
    for (const b of this.city.queryBuildings(x - R, z - R, x + R, z + R)) {
      if (b.state !== 0) continue;
      const cx = U.clamp(x, b.x0, b.x1), cz = U.clamp(z, b.z0, b.z1);
      const d = Math.hypot(cx - x, cz - z);
      if (d > R) continue;
      const k = 1 - d / R;
      if ((b.kind === BK.HOUSE || b.kind === BK.SHOP) && k > 0.45) { this.obliterate(b, cx, 2, cz, (cx - x) / (d || 1), 0, (cz - z) / (d || 1), 120); continue; }
      this.shatter(b, cx, Math.min(b.y1 - b.sink, 6 + 20 * k), cz, 10 + 30 * k);
      if (d < R * 0.35) this.addDamage(b, 1.2 * k);
    }
    G.audio.slam(I);
    G.rig.addTrauma(0.95);
    G.rig.fovKick(10 * I);
    G.post.flash(0.3 * I);
    G.post.pulse(1.0);
    this.hitstop = 0.09;
    this._hitstopCd = 1;
    this.emitters.push({ x, y: 1, z, t: 0, dur: 9, rate: 6, kind: 'dust', size: 8, spread: R * 0.3 });
    if (G.hud) G.hud.banner('地面冲击', 'gold', 1.0);
  }

  /** 突破音障 */
  sonicBoom(pos, dir) {
    G.shock.ring(pos, dir, 1.5, 75, 1.5, 0.85, 0xffffff, false, 0.4);
    G.shock.ring(pos, dir, 1, 120, 0.9, 0.5, 0xdbe8ff, true, 0.8);
    G.shock.sphere(pos, 12, 190, 1.0, 0.16, 0xe2ecff);
    for (let k = 0; k < 40; k++) {
      const a = Math.random() * Math.PI * 2;
      this._v.set(Math.cos(a), Math.sin(a), 0);
      // 垂直于飞行方向的随机向量
      this._n.copy(dir).cross(this._up);
      if (this._n.lengthSq() < 1e-4) this._n.set(1, 0, 0);
      this._n.normalize();
      this._v2.crossVectors(dir, this._n);
      const vx = this._n.x * Math.cos(a) + this._v2.x * Math.sin(a), vy = this._n.y * Math.cos(a) + this._v2.y * Math.sin(a), vz = this._n.z * Math.cos(a) + this._v2.z * Math.sin(a);
      const sp = U.rand(25, 45);
      G.dust.emit(pos.x + vx * 3, pos.y + vy * 3, pos.z + vz * 3, vx * sp - dir.x * 30, vy * sp - dir.y * 30, vz * sp - dir.z * 30,
        U.rand(1.2, 2.2), 3, 9, 0.85, 0.88, 0.92, 0.5, 2.2, 0, U.rand(-1, 1));
    }
    G.post.flash(0.22);
    G.post.pulse(1.2);
    G.rig.addTrauma(0.7);
    G.rig.fovKick(13);
    G.audio.boom(1);
    G.vapor.flash = 1;
    if (G.hud) G.hud.banner('MACH 1', 'hyper', 1.4);
    // 震碎附近玻璃、晃动车辆
    const R = 85;
    for (const b of this.city.queryBuildings(pos.x - R, pos.z - R, pos.x + R, pos.z + R)) {
      const cx = U.clamp(pos.x, b.x0, b.x1), cy = U.clamp(pos.y, b.y0, b.y1 - b.sink), cz = U.clamp(pos.z, b.z0, b.z1);
      const d = Math.hypot(cx - pos.x, cy - pos.y, cz - pos.z);
      if (d < R) this.shatter(b, cx, cy, cz, 30 * (1 - d / R) + 8);
    }
    for (const car of this.city.traffic.queryNear(pos.x, pos.z, 90)) {
      if (pos.y < 60) car.shake = Math.max(car.shake, 2.5);
    }
  }

  /** 冲击拳：前方锥形冲击波 */
  punch(origin, dir) {
    let hit = false;
    this._v.copy(origin).addScaledVector(dir, 1.6);
    G.shock.ring(this._v, dir, 0.5, 16, 0.45, 0.8, 0xffffff, false, 0.3);
    G.shock.sphere(this._v, 0.5, 9, 0.3, 0.6, 0xfff0d0);
    G.post.pulse(0.5);
    G.rig.addTrauma(0.3);
    const r = this.raycast(origin, dir, 60);
    if (r && r.b && r.t < 14) {
      hit = true;
      const b = r.b;
      if (b.kind === BK.HOUSE || b.kind === BK.SHOP) this.obliterate(b, r.x, r.y, r.z, dir.x, dir.y, dir.z, 200);
      else {
        this.city.ensureInterior(b);
        this.city.holes.add(b.id, r.x - dir.x * 2, r.y - dir.y * 2 + b.sink, r.z - dir.z * 2, r.x + dir.x * 9, r.y + dir.y * 9 + b.sink, r.z + dir.z * 9, 4.6, HOLE.SMASH);
        this.shatter(b, r.x, r.y, r.z, 18);
        this.impactFx(r.x, r.y, r.z, r.nx, r.ny, r.nz, dir.x, dir.y, dir.z, 260, b);
        this.addDamage(b, 1);
      }
    } else if (r && r.b && r.t < 60) {
      this.shatter(r.b, r.x, r.y, r.z, 16 - r.t * 0.15);
    } else if (r && r.ground && r.t < 16) {
      hit = true;
      this.groundSlam(this._v2.set(r.x, 0, r.z), 110);
    }
    // 锥形范围内的车辆与道具
    const R = 42;
    const test = (x, y, z) => {
      this._n.set(x - origin.x, y - origin.y, z - origin.z);
      const d = this._n.length();
      if (d > R || d < 0.1) return 0;
      const c = this._n.dot(dir) / d;
      return c > 0.72 ? (1 - d / R) : 0;
    };
    for (const car of this.city.traffic.queryNear(origin.x, origin.z, R)) {
      const k = test(car.x, 1, car.z);
      if (k > 0) { hit = true; this.hitCar(car, dir.x * (30 + 90 * k), dir.y * 40 + 10, dir.z * (30 + 90 * k), 60 + 120 * k); }
    }
    for (const p of this.city.props.query(origin.x - R, origin.z - R, origin.x + R, origin.z + R)) {
      const k = test(p.x, 2, p.z);
      if (k > 0) { hit = true; this.hitProp(p, dir.x * (25 + 80 * k), 10 + 10 * k, dir.z * (25 + 80 * k), 80 + 100 * k); }
    }
    G.audio.punch(hit);
  }

  /**
   * 射线检测（建筑 / 车辆 / 地面）。穿过已有破洞的部分会被忽略。
   * 返回 { t, x, y, z, nx, ny, nz, b?, car?, ground? } 或 null
   */
  raycast(o, d, maxT, solid = false) {
    let best = null;
    const out = this._seg || (this._seg = {});
    // 地面
    if (d.y < -1e-4) {
      const t = -o.y / d.y;
      if (t > 0 && t < maxT) best = { t, x: o.x + d.x * t, y: 0, z: o.z + d.z * t, nx: 0, ny: 1, nz: 0, ground: true };
    }
    const step = 36;
    for (let s = 0; s < maxT; s += step) {
      if (best && best.t < s) break;
      const e = Math.min(s + step, maxT);
      const ax = o.x + d.x * s, az = o.z + d.z * s, bx = o.x + d.x * e, bz = o.z + d.z * e;
      const list = this.city.queryBuildings(Math.min(ax, bx) - 2, Math.min(az, bz) - 2, Math.max(ax, bx) + 2, Math.max(az, bz) + 2);
      for (let k = 0; k < list.length; k++) {
        const b = list[k];
        if (b.state === 2) continue;
        if (!segAABB(o.x, o.y, o.z, d.x * maxT, d.y * maxT, d.z * maxT, b.x0, b.y0 - b.sink, b.z0, b.x1, b.y1 - b.sink, b.z1, out)) continue;
        const t = out.t * maxT;
        if (best && t >= best.t) continue;
        const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
        if (!solid && this.city.holes.insideHole(b.id, x, y + b.sink, z, -0.5)) continue;
        best = { t, x, y, z, nx: out.axis === 0 ? out.sign : 0, ny: out.axis === 1 ? out.sign : 0, nz: out.axis === 2 ? out.sign : 0, b };
      }
    }
    // 车辆（球体近似）
    const lim = best ? best.t : maxT;
    for (const car of this.city.traffic.cars) {
      if (car.mode > 1) continue;
      const cx = car.x - o.x, cy = 1 - o.y, cz = car.z - o.z;
      const t = cx * d.x + cy * d.y + cz * d.z;
      if (t < 0 || t > lim) continue;
      const px = cx - d.x * t, py = cy - d.y * t, pz = cz - d.z * t;
      if (px * px + py * py + pz * pz < 2.6) {
        if (!best || t < best.t) best = { t, x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t, nx: -d.x, ny: -d.y, nz: -d.z, car };
      }
    }
    return best;
  }

  /** 目光射线：每帧调用（按住右键时） */
  beam(dt, origin, dir) {
    // 射线把建筑表面视为实体（不穿过自己刚切开的槽），这样才能连续切割
    const r = this.raycast(origin, dir, 1500, true);
    if (!r) { this.beamCut = null; return null; }
    if (Math.random() < 0.9) this.sparks(r.x + r.nx * 0.3, r.y + r.ny * 0.3, r.z + r.nz * 0.3, 3, 14, r.nx * 0.6, r.ny * 0.6 + 0.3, r.nz * 0.6);
    if (Math.random() < 0.35) this.fire(r.x + r.nx * 0.5, r.y + r.ny * 0.5, r.z + r.nz * 0.5, 2, 1.6);
    if (Math.random() < 0.25) this.dust(r.x + r.nx, r.y + r.ny, r.z + r.nz, 1, 2.5, 0.5, 2, 3, [0.08, 0.075, 0.07], 0.6);
    if (r.b) {
      const b = r.b;
      const H = this.city.holes;
      this.city.ensureInterior(b);
      const sy = b.sink;
      const cut = this.beamCut;
      if (cut && cut.b === b && cut.last.distanceTo(this._v.set(r.x, r.y, r.z)) < 9 && H.slotType(b.id, cut.slot) === HOLE.BEAM) {
        const k = H.base(b.id) + cut.slot * 8, dd = H.data;
        const len = Math.hypot(r.x - dd[k], r.y + sy - dd[k + 1], r.z - dd[k + 2]);
        const segLen = cut.last.distanceTo(this._v);
        // 割线太长或方向偏折时开新段
        if (len > 26) cut.slot = H.add(b.id, cut.last.x, cut.last.y + sy, cut.last.z, r.x, r.y + sy, r.z, 1.1, HOLE.BEAM);
        else H.setEnd(b.id, cut.slot, r.x - r.nx * 0.2, r.y + sy - r.ny * 0.2, r.z - r.nz * 0.2);
        cut.last.set(r.x, r.y, r.z);
        cut.len += segLen;
        if (cut.len > 6) {
          // 切割底部三分之一的伤害更高：横扫大楼根部可以让整栋楼倒塌
          const low = (r.y - b.y0) < b.h * 0.34 ? 1.6 : 1;
          this.addDamage(b, (cut.len / (b.hw + b.hd)) * 2.2 * low);
          cut.len = 0;
        }
      } else {
        const slot = H.add(b.id, r.x - r.nx * 0.2, r.y + sy - r.ny * 0.2, r.z - r.nz * 0.2, r.x - r.nx * 0.3, r.y + sy - r.ny * 0.3, r.z - r.nz * 0.3, 1.1, HOLE.BEAM);
        this.beamCut = { b, slot, last: new THREE.Vector3(r.x, r.y, r.z), len: 0 };
        this.shatter(b, r.x, r.y, r.z, 6);
      }
      if (Math.random() < 0.3) {
        const c = b.color;
        G.debris.spawn(r.x + r.nx, r.y, r.z + r.nz, r.nx * U.rand(2, 6) + U.rand(-2, 2), U.rand(0, 4), r.nz * U.rand(2, 6) + U.rand(-2, 2), U.rand(0.15, 0.4), c.r * 0.5, c.g * 0.45, c.b * 0.4, 3);
      }
    } else {
      this.beamCut = null;
      if (r.car) {
        r.car.heat += dt;
        if (r.car.heat > 0.3) { this.hitCar(r.car, dir.x * 20, 14, dir.z * 20, 30); this.explodeCar(r.car, 0); }
      } else if (r.ground) {
        if (this._beamScorch.distanceTo(this._v.set(r.x, 0, r.z)) > 3.5) {
          this._beamScorch.copy(this._v);
          this.env.addCrater(r.x, r.z, 1.6, 0.9);
          if (Math.random() < 0.3) this.emitters.push({ x: r.x, y: 0.5, z: r.z, t: 0, dur: 4, rate: 6, kind: 'fire', size: 1.5 });
        }
      }
      for (const p of this.city.props.query(r.x - 3, r.z - 3, r.x + 3, r.z + 3)) {
        if (Math.hypot(p.x - r.x, p.z - r.z) > 2.8) continue;
        p.heat += dt;
        if (p.heat > 0.25) this.hitProp(p, dir.x * 15, 6, dir.z * 15, 30);
      }
    }
    return r;
  }

  /* ---------------- 每帧 ---------------- */
  update(dt) {
    this._hitstopCd -= dt;
    this._updateCollapses(dt);
    for (let k = 0; k < this.emitters.length; k++) {
      const e = this.emitters[k];
      e.t += dt;
      if (e.kind === 'explode') {
        if (e.t >= 0) { this._doExplode(e.car); this.emitters.splice(k, 1); k--; }
        continue;
      }
      if (e.t > e.dur) { this.emitters.splice(k, 1); k--; continue; }
      const fade = 1 - e.t / e.dur;
      const n = e.rate * dt * fade;
      const cnt = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
      for (let i = 0; i < cnt; i++) {
        if (e.kind === 'dust') {
          G.dust.emit(e.x + U.rand(-e.spread, e.spread), e.y + U.rand(0, 3), e.z + U.rand(-e.spread, e.spread),
            U.rand(-1.5, 1.5), U.rand(1, 3.5), U.rand(-1.5, 1.5), U.rand(6, 10), e.size * 0.6, e.size * 2.4,
            DUST[0] * 0.9, DUST[1] * 0.9, DUST[2] * 0.9, 0.4 * fade + 0.1, 0.3, -0.3, U.rand(-0.2, 0.2));
        } else if (e.kind === 'water') {
          this.water(e.x, e.y, e.z, 1, 16);
        } else if (e.kind === 'burn' || e.kind === 'fire') {
          const x = e.car ? (e.car.body ? e.car.body.p.x : e.car.x) : e.x;
          const y = e.car ? (e.car.body ? e.car.body.p.y + 0.6 : 1.2) : e.y;
          const z = e.car ? (e.car.body ? e.car.body.p.z : e.car.z) : e.z;
          if (Math.random() < 0.55) this.fire(x, y, z, 1, e.size || 2.2);
          if (Math.random() < 0.5) G.dust.emit(x + U.rand(-0.6, 0.6), y + 1.5, z + U.rand(-0.6, 0.6), U.rand(-0.8, 0.8), U.rand(3, 6), U.rand(-0.8, 0.8),
            U.rand(4, 7), 1.5, 9, 0.05, 0.048, 0.045, 0.55 * fade, 0.25, -1.2, U.rand(-0.3, 0.3));
        }
      }
    }
  }
}
