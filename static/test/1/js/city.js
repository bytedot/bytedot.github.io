'use strict';
/* =====================================================================
 * city.js — 程序化城市生成
 *  - 40×40 街区网格，每 4 条道路一条主干道
 *  - 由中心向外：摩天楼 CBD → 写字楼区 → 住宅区 → 低层住宅（独栋小屋）
 *  - 公园、广场、纪念碑、喷泉
 *  - 所有方盒建筑合并为一个 InstancedMesh；空间哈希网格用于碰撞查询
 * ===================================================================== */

const PALETTE = {
  glassFrame: ['#5d646c', '#8a9199', '#3a3f45', '#b7bcc2', '#2b2f35', '#6f6a62'],
  office: ['#9a948a', '#b8b2a6', '#7d7a74', '#c9c2b4', '#6e6a64', '#a89a86', '#8c8f93'],
  concrete: ['#8e8b85', '#a19d95', '#76736e', '#b3ada2'],
  resi: ['#8a4b3a', '#9c5a45', '#c8b79a', '#d6cdb8', '#8d8d88', '#b07d5e', '#e0d6c2', '#a46a52', '#c9a98a'],
  house: ['#e8dcc5', '#d9c7a8', '#c4d0d6', '#e6e1d6', '#d8b8a0', '#b9c7b0', '#efe6cf', '#cfd6dd'],
  roof: ['#6b3b2e', '#4a4f57', '#7a4a33', '#3e4247', '#5a2f28', '#5d5f63'],
  shop: ['#a8a39a', '#c2b8a6', '#8f8a82', '#b9a48a'],
};

class City {
  constructor(scene) {
    const C = CFG.city;
    this.scene = scene;
    this.N = C.blocks;
    this.P = C.period;
    this.half = (this.N * this.P) / 2;
    this.rng = new RNG(CFG.seed);
    this.buildings = [];
    this.blockTypes = new Uint8Array(this.N * this.N * 4);
    this.props = new PropSystem(scene, this);
    this.traffic = new Traffic(scene, this);
    this.roofItems = [];          // 屋顶设备（空调外机 / 水箱 / 天线）
    // 空间哈希网格
    this.cell = 40;
    this.gmin = -this.half - 400;
    this.gn = Math.ceil((this.half * 2 + 800) / this.cell);
    this.gridB = new Array(this.gn * this.gn);
    this.stampId = 0;
    this._qb = [];
  }

  /** 第 i 条道路中心线坐标 */
  L(i) { return (i - this.N / 2) * this.P; }
  /** 第 i 条道路总宽 */
  W(i) { return i % CFG.city.avenueEvery === 0 ? CFG.city.avenueW : CFG.city.streetW; }

  /* ============================== 生成 ============================== */
  generate() {
    const N = this.N;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) this._block(i, j);
    }
    this.props.placeStreets();
    this.traffic.generate();
    this._buildMeshes();
    this.props.build();
    this.traffic.build();
    for (const b of this.buildings) this._gridInsert(b);
  }

  _block(i, j) {
    const rng = this.rng;
    const x0 = this.L(i) + this.W(i) / 2, x1 = this.L(i + 1) - this.W(i + 1) / 2;
    const z0 = this.L(j) + this.W(j) / 2, z1 = this.L(j + 1) - this.W(j + 1) / 2;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const dn = Math.hypot(cx, cz) / this.half + (noise2(i * 0.31 + 7.1, j * 0.31 + 3.3) - 0.5) * 0.22;
    const box = { x0, z0, x1, z1, cx, cz, dn };
    const mid = this.N / 2;
    let type;
    // ---- 特殊街区 ----
    if (i === mid && j === mid - 1) type = this._plaza(box, true);               // 中央广场 + 纪念碑
    else if ((i === mid - 1 || i === mid) && j === mid) type = this._downtown(box, 'hero'); // 出生点两侧的高楼
    else if (i === mid - 2 && j === mid - 2) type = this._downtown(box, 'landmark');        // 地标超高层
    else if (i === mid + 3 && (j === mid + 2 || j === mid + 3)) type = this._park(box, 0.9);
    else {
      const r = rng.next();
      if (dn < 0.3) {
        type = r < 0.08 ? this._plaza(box, false) : r < 0.13 ? this._park(box, 0.6) : this._downtown(box, null);
      } else if (dn < 0.56) {
        type = r < 0.08 ? this._park(box, 0.7) : r < 0.14 ? this._plaza(box, false) : this._midtown(box);
      } else if (dn < 0.8) {
        type = r < 0.13 ? this._park(box, 0.8) : this._residential(box);
      } else {
        type = r < 0.18 ? this._park(box, 1.0) : this._suburb(box);
      }
    }
    this.blockTypes[(j * this.N + i) * 4] = type;
  }

  /** 创建一个方盒建筑 */
  addB(kind, x0, z0, x1, z1, y0, h, facade, colorHex, opt = {}) {
    const rng = this.rng;
    const b = {
      id: this.buildings.length,
      kind, facade,
      x0, x1, z0, z1, y0, y1: y0 + h, h,
      cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
      hw: (x1 - x0) / 2, hd: (z1 - z0) / 2,
      color: new THREE.Color(colorHex),
      parent: opt.parent !== undefined ? opt.parent : -1,
      children: [],
      state: 0,                 // 0 完好 / 1 坍塌中 / 2 已消失
      sink: 0,
      damage: 0,
      threshold: h < 16 ? 1 : h < 55 ? 2 : h < 130 ? 3 : h < 230 ? 4 : 5,
      seed: rng.next(),
      floorH: opt.floorH || (facade === FACADE.RESI || facade === FACADE.HOUSE ? rng.range(2.9, 3.2) : rng.range(3.6, 4.2)),
      colW: opt.colW || (facade === FACADE.GLASS ? rng.range(1.4, 2.2) : facade === FACADE.RESI ? rng.range(3.2, 4.2) : rng.range(2.0, 3.4)),
      helipad: !!opt.helipad,
      roof: -1,
      interior: -1,
      attach: [],
      glass: facade === FACADE.GLASS || facade === FACADE.OFFICE,
    };
    if (b.parent >= 0) this.buildings[b.parent].children.push(b.id);
    this.buildings.push(b);
    return b;
  }

  /* ---------- CBD 摩天楼 ---------- */
  _downtown(box, special) {
    const rng = this.rng;
    const m = 3;
    const X0 = box.x0 + m, X1 = box.x1 - m, Z0 = box.z0 + m, Z1 = box.z1 - m;
    const W = X1 - X0, D = Z1 - Z0;
    const hBase = () => U.lerp(330, 140, U.clamp(box.dn / 0.3, 0, 1)) * rng.range(0.55, 1.08);
    const glassOr = () => (rng.chance(0.72) ? FACADE.GLASS : FACADE.OFFICE);
    let layout = rng.next();
    if (special === 'hero') layout = 0.1;
    if (special === 'landmark') layout = 0.1;
    if (layout < 0.4) {
      // 裙楼 + 主塔 + 塔冠
      const ph = rng.range(14, 24);
      const pod = this.addB(BK.OFFICE, X0 + 2, Z0 + 2, X1 - 2, Z1 - 2, 0, ph, FACADE.COMMERCIAL, rng.pick(PALETTE.shop));
      const fw = W * rng.range(0.5, 0.66), fd = D * rng.range(0.5, 0.66);
      const ox = rng.range(-1, 1) * (W - fw) * 0.25, oz = rng.range(-1, 1) * (D - fd) * 0.25;
      const tx = (X0 + X1) / 2 + ox, tz = (Z0 + Z1) / 2 + oz;
      let th = hBase();
      if (special === 'hero') th = rng.range(230, 300);
      if (special === 'landmark') th = 430;
      const facade = special === 'landmark' ? FACADE.GLASS : glassOr();
      const frame = facade === FACADE.GLASS ? rng.pick(PALETTE.glassFrame) : rng.pick(PALETTE.office);
      const crown = rng.chance(0.55) || special === 'landmark';
      const tower = this.addB(BK.TOWER, tx - fw / 2, tz - fd / 2, tx + fw / 2, tz + fd / 2, ph, th, facade, frame,
        { parent: pod.id, helipad: !crown && rng.chance(0.4) });
      if (crown) {
        const k = rng.range(0.55, 0.8), ch = special === 'landmark' ? 40 : rng.range(8, 28);
        const cr = this.addB(BK.TOWER, tx - fw * k / 2, tz - fd * k / 2, tx + fw * k / 2, tz + fd * k / 2, ph + th, ch,
          rng.chance(0.6) ? facade : FACADE.CONCRETE, frame, { parent: tower.id });
        if (rng.chance(0.5) || special === 'landmark') this._spire(cr, special === 'landmark' ? 70 : rng.range(18, 55));
        else this._roofStuff(cr);
      } else if (!tower.helipad) this._roofStuff(tower);
      this._roofStuff(pod, 0.5);
    } else if (layout < 0.66) {
      // 双塔
      const alongX = W >= D;
      const gap = rng.range(16, 22);
      for (let k = 0; k < 2; k++) {
        let a0, a1, b0, b1;
        if (alongX) { const w = (W - gap) / 2; a0 = X0 + k * (w + gap); a1 = a0 + w; b0 = Z0 + D * 0.12; b1 = Z1 - D * 0.12; }
        else { const d = (D - gap) / 2; b0 = Z0 + k * (d + gap); b1 = b0 + d; a0 = X0 + W * 0.12; a1 = X1 - W * 0.12; }
        const f = glassOr();
        const t = this.addB(BK.TOWER, a0, b0, a1, b1, 0, hBase() * 0.85, f, f === FACADE.GLASS ? rng.pick(PALETTE.glassFrame) : rng.pick(PALETTE.office),
          { helipad: rng.chance(0.25) });
        if (!t.helipad) this._roofStuff(t);
      }
    } else if (layout < 0.88) {
      // 2×2 四栋
      const gap = 14;
      const w = (W - gap) / 2, d = (D - gap) / 2;
      for (let a = 0; a < 2; a++) for (let c = 0; c < 2; c++) {
        const f = rng.chance(0.55) ? FACADE.GLASS : rng.chance(0.5) ? FACADE.OFFICE : FACADE.CONCRETE;
        const ax = X0 + a * (w + gap), az = Z0 + c * (d + gap);
        const t = this.addB(BK.TOWER, ax + 1, az + 1, ax + w - 1, az + d - 1, 0, hBase() * rng.range(0.45, 0.8), f,
          f === FACADE.GLASS ? rng.pick(PALETTE.glassFrame) : rng.pick(PALETTE.office));
        this._roofStuff(t);
      }
    } else {
      // 角落一栋塔楼 + 开阔广场
      const s = Math.min(W, D) * 0.48;
      const cxs = rng.chance(0.5) ? X0 : X1 - s, czs = rng.chance(0.5) ? Z0 : Z1 - s;
      const f = glassOr();
      const t = this.addB(BK.TOWER, cxs, czs, cxs + s, czs + s, 0, hBase(), f,
        f === FACADE.GLASS ? rng.pick(PALETTE.glassFrame) : rng.pick(PALETTE.office), { helipad: rng.chance(0.4) });
      if (!t.helipad) this._roofStuff(t);
      const fx = cxs < (X0 + X1) / 2 ? X1 - 18 : X0 + 18, fz = czs < (Z0 + Z1) / 2 ? Z1 - 18 : Z0 + 18;
      this.props.add('fountain', fx, fz, 0, 0.7);
      for (let k = 0; k < 4; k++) this.props.add('bench', fx + rng.range(-12, 12), fz + rng.range(-12, 12), rng.range(0, 6.28), 1);
      return 2;
    }
    return 0;
  }

  /* ---------- 写字楼区 ---------- */
  _midtown(box) {
    const rng = this.rng;
    const m = 3;
    const X0 = box.x0 + m, X1 = box.x1 - m, Z0 = box.z0 + m, Z1 = box.z1 - m;
    const hMax = U.lerp(120, 45, U.clamp((box.dn - 0.3) / 0.26, 0, 1));
    const alongX = rng.chance(0.5);
    const slices = rng.int(2, 3);
    const gap = rng.range(12, 16);
    const W = X1 - X0, D = Z1 - Z0;
    for (let s = 0; s < slices; s++) {
      let a0, a1, b0, b1;
      if (alongX) { const w = (W - gap * (slices - 1)) / slices; a0 = X0 + s * (w + gap); a1 = a0 + w; b0 = Z0; b1 = Z1; }
      else { const d = (D - gap * (slices - 1)) / slices; b0 = Z0 + s * (d + gap); b1 = b0 + d; a0 = X0; a1 = X1; }
      const split = rng.chance(0.45);
      const parts = split ? 2 : 1;
      for (let p = 0; p < parts; p++) {
        let c0 = a0, c1 = a1, e0 = b0, e1 = b1;
        if (split) {
          if (alongX) { const d = (b1 - b0 - gap) / 2; e0 = b0 + p * (d + gap); e1 = e0 + d; }
          else { const w = (a1 - a0 - gap) / 2; c0 = a0 + p * (w + gap); c1 = c0 + w; }
        }
        const r = rng.next();
        const f = r < 0.42 ? FACADE.OFFICE : r < 0.67 ? FACADE.GLASS : r < 0.87 ? FACADE.CONCRETE : FACADE.COMMERCIAL;
        const col = f === FACADE.GLASS ? rng.pick(PALETTE.glassFrame) : f === FACADE.CONCRETE ? rng.pick(PALETTE.concrete) : rng.pick(PALETTE.office);
        const h = rng.range(0.3, 1) * hMax + 12;
        const bb = this.addB(h > 60 ? BK.TOWER : BK.OFFICE, c0 + 1, e0 + 1, c1 - 1, e1 - 1, 0, h, f, col);
        if (h > 50 && rng.chance(0.25)) {
          const k = 0.7;
          const cw = (c1 - c0) * k / 2, cd = (e1 - e0) * k / 2, mx = (c0 + c1) / 2, mz = (e0 + e1) / 2;
          const cr = this.addB(BK.OFFICE, mx - cw, mz - cd, mx + cw, mz + cd, h, rng.range(6, 16), f, col, { parent: bb.id });
          this._roofStuff(cr, 0.6);
        } else this._roofStuff(bb);
      }
    }
    return 0;
  }

  /* ---------- 住宅区 ---------- */
  _residential(box) {
    const rng = this.rng;
    const m = 4;
    const X0 = box.x0 + m, X1 = box.x1 - m, Z0 = box.z0 + m, Z1 = box.z1 - m;
    const nx = rng.int(2, 3), nz = 2, gap = rng.range(12, 15);
    const w = (X1 - X0 - gap * (nx - 1)) / nx, d = (Z1 - Z0 - gap * (nz - 1)) / nz;
    for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
      const ax = X0 + a * (w + gap), az = Z0 + c * (d + gap);
      if (rng.chance(0.08)) {
        // 空地 → 种树
        for (let k = 0; k < 4; k++) this.props.add('tree', ax + rng.range(3, w - 3), az + rng.range(3, d - 3), rng.range(0, 6.28), rng.range(0.85, 1.25));
        continue;
      }
      const shop = rng.chance(0.15);
      const h = shop ? rng.range(9, 22) : rng.range(12, 46) * U.lerp(1.1, 0.7, U.clamp((box.dn - 0.56) / 0.24, 0, 1));
      const iw = rng.range(0, 3), id = rng.range(0, 3);
      const bb = this.addB(shop ? BK.SHOP : BK.APT, ax + iw, az + id, ax + w - iw, az + d - id, 0, h,
        shop ? FACADE.COMMERCIAL : FACADE.RESI, shop ? rng.pick(PALETTE.shop) : rng.pick(PALETTE.resi));
      if (!shop && rng.chance(0.3)) this._waterTank(bb);
      else this._roofStuff(bb, 0.5);
    }
    // 楼间树木
    for (let k = 0; k < 6; k++) {
      const tx = rng.range(X0, X1), tz = rng.range(Z0, Z1);
      if (this._insideAny(tx, tz, 2.5, this.buildings.length - nx * nz)) continue;
      this.props.add('tree', tx, tz, rng.range(0, 6.28), rng.range(0.8, 1.2));
    }
    return 3;
  }

  /* ---------- 低层独栋住宅 ---------- */
  _suburb(box) {
    const rng = this.rng;
    const m = 3;
    const X0 = box.x0 + m, X1 = box.x1 - m, Z0 = box.z0 + m, Z1 = box.z1 - m;
    const nx = Math.max(2, Math.floor((X1 - X0) / 27)), nz = Math.max(2, Math.floor((Z1 - Z0) / 27));
    const cw = (X1 - X0) / nx, cd = (Z1 - Z0) / nz;
    for (let a = 0; a < nx; a++) for (let c = 0; c < nz; c++) {
      const ax = X0 + a * cw, az = Z0 + c * cd;
      // 只在靠近街道的一圈放房子，中间留作后院
      const edge = a === 0 || c === 0 || a === nx - 1 || c === nz - 1;
      if (!edge || rng.chance(0.1)) {
        for (let k = 0; k < 2; k++) this.props.add('tree', ax + rng.range(4, cw - 4), az + rng.range(4, cd - 4), rng.range(0, 6.28), rng.range(0.8, 1.3));
        continue;
      }
      const hw = rng.range(10, 14) / 2, hd = rng.range(9.5, 13) / 2;
      const mx = ax + cw / 2 + rng.range(-1.5, 1.5), mz = az + cd / 2 + rng.range(-1.5, 1.5);
      const h = rng.range(5.6, 7.4);
      const shop = rng.chance(0.07);
      const bb = this.addB(shop ? BK.SHOP : BK.HOUSE, mx - hw, mz - hd, mx + hw, mz + hd, 0, h,
        shop ? FACADE.COMMERCIAL : FACADE.HOUSE, shop ? rng.pick(PALETTE.shop) : rng.pick(PALETTE.house), { floorH: h / 2 });
      bb.gable = !shop;
      if (rng.chance(0.6)) this.props.add('tree', ax + rng.range(2, 5), az + rng.range(2, 5), rng.range(0, 6.28), rng.range(0.8, 1.2));
    }
    return 3;
  }

  /* ---------- 公园 ---------- */
  _park(box, density) {
    const rng = this.rng;
    const n = Math.floor(rng.range(16, 30) * density);
    const X0 = box.x0 + 4, X1 = box.x1 - 4, Z0 = box.z0 + 4, Z1 = box.z1 - 4;
    const mx = (X0 + X1) / 2, mz = (Z0 + Z1) / 2;
    for (let k = 0; k < n; k++) {
      const tx = rng.range(X0, X1), tz = rng.range(Z0, Z1);
      if (Math.abs(tx - mx) < 3 || Math.abs(tz - mz) < 3) continue;   // 留出小径
      this.props.add('tree', tx, tz, rng.range(0, 6.28), rng.range(0.85, 1.45));
    }
    for (let k = 0; k < 6; k++) {
      const alongX = rng.chance(0.5);
      const t = rng.range(-30, 30);
      this.props.add('bench', alongX ? mx + t : mx + 3.2, alongX ? mz + 3.2 : mz + t, alongX ? 0 : Math.PI / 2, 1);
    }
    if (rng.chance(0.5)) this.props.add('fountain', mx, mz, 0, 0.6);
    return 1;
  }

  /* ---------- 广场 ---------- */
  _plaza(box, central) {
    const rng = this.rng;
    const mx = (box.x0 + box.x1) / 2, mz = (box.z0 + box.z1) / 2;
    if (central) this.props.add('monument', mx, mz, 0.4, 1);
    else this.props.add('fountain', mx, mz, 0, 1);
    for (let k = 0; k < 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      this.props.add('bench', mx + Math.cos(a) * 18, mz + Math.sin(a) * 18, -a, 1);
    }
    const X0 = box.x0 + 5, X1 = box.x1 - 5, Z0 = box.z0 + 5, Z1 = box.z1 - 5;
    for (let t = 0; t <= 1.001; t += 0.25) {
      this.props.add('tree', U.lerp(X0, X1, t), Z0, rng.range(0, 6), 1);
      this.props.add('tree', U.lerp(X0, X1, t), Z1, rng.range(0, 6), 1);
      if (t > 0 && t < 1) { this.props.add('tree', X0, U.lerp(Z0, Z1, t), rng.range(0, 6), 1); this.props.add('tree', X1, U.lerp(Z0, Z1, t), rng.range(0, 6), 1); }
    }
    // 报亭（可被完全摧毁的小型建筑）
    const kx = X0 + 8, kz = Z1 - 8;
    this.addB(BK.SHOP, kx - 2.2, kz - 1.8, kx + 2.2, kz + 1.8, 0, 3.4, FACADE.COMMERCIAL, rng.pick(PALETTE.shop), { floorH: 3.4 });
    return 2;
  }

  _insideAny(x, z, pad, from) {
    for (let k = Math.max(0, from); k < this.buildings.length; k++) {
      const b = this.buildings[k];
      if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
    }
    return false;
  }

  /* ---------- 屋顶设备 ---------- */
  _roofStuff(b, chance = 0.85) {
    const rng = this.rng;
    if (!rng.chance(chance) || b.hw < 7 || b.hd < 7) return;
    const n = rng.int(1, 4);
    for (let k = 0; k < n; k++) {
      const x = rng.range(b.x0 + 3, b.x1 - 3), z = rng.range(b.z0 + 3, b.z1 - 3);
      this.roofItems.push({ type: 0, b: b.id, x, y: b.y1, z, yaw: rng.chance(0.5) ? 0 : Math.PI / 2, sx: rng.range(2, 4), sy: rng.range(1.2, 2.2), sz: rng.range(2, 3) });
    }
  }

  _waterTank(b) {
    const rng = this.rng;
    this.roofItems.push({ type: 1, b: b.id, x: rng.range(b.x0 + 4, b.x1 - 4), y: b.y1, z: rng.range(b.z0 + 4, b.z1 - 4), yaw: 0, sx: 1, sy: 1, sz: 1 });
  }

  _spire(b, h) {
    this.roofItems.push({ type: 2, b: b.id, x: b.cx, y: b.y1, z: b.cz, yaw: 0, sx: 1, sy: h, sz: 1 });
  }

  /* ============================== 网格与渲染 ============================== */
  _buildMeshes() {
    const n = this.buildings.length;
    this.holes = new HoleSystem(n);
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    geo.deleteAttribute('uv');

    const mat = createBuildingMaterial(this.holes.tex, false);
    const mesh = this.bMesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    const aBid = new Float32Array(n), aStyle = new Float32Array(n * 4), aDims = new Float32Array(n * 4), aDims2 = new Float32Array(n * 4);
    const arr = mesh.instanceMatrix.array;
    for (const b of this.buildings) {
      const i = b.id;
      writeYawMatrix(arr, i, b.cx, b.y0, b.cz, 0, b.hw * 2, b.h, b.hd * 2);
      mesh.instanceColor.setXYZ(i, b.color.r, b.color.g, b.color.b);
      aBid[i] = i;
      aStyle.set([b.facade, b.seed, b.floorH, b.colW], i * 4);
      aDims.set([b.cx, b.cz, b.hw, b.hd], i * 4);
      aDims2.set([b.y0, b.h, 0, b.helipad ? 1 : 0], i * 4);
    }
    this.aDims2 = new THREE.InstancedBufferAttribute(aDims2, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aBid', new THREE.InstancedBufferAttribute(aBid, 1));
    geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(aStyle, 4));
    geo.setAttribute('aDims', new THREE.InstancedBufferAttribute(aDims, 4));
    geo.setAttribute('aDims2', this.aDims2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // ---- 内部（背面）实例：只有受损的建筑才加入 ----
    const cap = CFG.pools.interiors;
    const igeo = new THREE.BoxGeometry(1, 1, 1);
    igeo.translate(0, 0.5, 0);
    igeo.deleteAttribute('uv');
    this.iAttr = {
      aBid: new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage),
      aStyle: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage),
      aDims: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage),
      aDims2: new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage),
    };
    for (const k in this.iAttr) igeo.setAttribute(k, this.iAttr[k]);
    const imesh = this.iMesh = new THREE.InstancedMesh(igeo, createBuildingMaterial(this.holes.tex, true), cap);
    imesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    imesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    imesh.count = 0;
    imesh.frustumCulled = false;
    imesh.receiveShadow = true;
    this.scene.add(imesh);
    this.interiorOwner = [];

    // ---- 独栋住宅的坡屋顶 ----
    const houses = this.buildings.filter((b) => b.gable);
    const rgeo = this._gableGeo();
    const rmesh = this.roofMesh = new THREE.InstancedMesh(rgeo, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 }), Math.max(1, houses.length));
    rmesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, houses.length) * 3), 3);
    rmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    houses.forEach((b, k) => {
      b.roof = k;
      const along = b.hw > b.hd;
      const rh = this.rng.range(2.4, 3.6);
      writeYawMatrix(rmesh.instanceMatrix.array, k, b.cx, b.y1, b.cz, along ? Math.PI / 2 : 0,
        (along ? b.hd : b.hw) * 2.16, rh, (along ? b.hw : b.hd) * 2.12);
      const c = new THREE.Color(this.rng.pick(PALETTE.roof));
      rmesh.instanceColor.setXYZ(k, c.r, c.g, c.b);
      b.roofH = rh;
      b.roofYaw = along ? Math.PI / 2 : 0;
    });
    rmesh.castShadow = true;
    rmesh.receiveShadow = true;
    rmesh.frustumCulled = false;
    this.scene.add(rmesh);

    this._buildRoofItems();
  }

  /** 三棱柱坡屋顶（底面 1×1，屋脊沿 Z 轴，高 1） */
  _gableGeo() {
    const v = [
      // 两个山墙三角形
      -0.5, 0, 0.5, 0.5, 0, 0.5, 0, 1, 0.5,
      0.5, 0, -0.5, -0.5, 0, -0.5, 0, 1, -0.5,
      // 两个坡面
      -0.5, 0, -0.5, -0.5, 0, 0.5, 0, 1, 0.5,
      -0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5,
      0.5, 0, 0.5, 0.5, 0, -0.5, 0, 1, -0.5,
      0.5, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    return g;
  }

  /** 屋顶设备：空调外机、水箱、天线 */
  _buildRoofItems() {
    const geos = [
      mergeGeos([
        { geo: new THREE.BoxGeometry(1, 1, 1), color: '#b9bbbd', matrix: M4(0, 0.5, 0) },
        { geo: new THREE.BoxGeometry(0.55, 0.06, 0.55), color: '#4a4c4f', matrix: M4(0, 1.02, 0) },
      ]),
      mergeGeos([
        { geo: new THREE.CylinderGeometry(2.2, 2.2, 4.2, 14), color: '#7b5a40', matrix: M4(0, 5.1, 0) },
        { geo: new THREE.ConeGeometry(2.4, 1.4, 14), color: '#4b3a2c', matrix: M4(0, 7.9, 0) },
        { geo: new THREE.BoxGeometry(0.25, 3, 0.25), color: '#2f3134', matrix: M4(1.5, 1.5, 1.5) },
        { geo: new THREE.BoxGeometry(0.25, 3, 0.25), color: '#2f3134', matrix: M4(-1.5, 1.5, 1.5) },
        { geo: new THREE.BoxGeometry(0.25, 3, 0.25), color: '#2f3134', matrix: M4(1.5, 1.5, -1.5) },
        { geo: new THREE.BoxGeometry(0.25, 3, 0.25), color: '#2f3134', matrix: M4(-1.5, 1.5, -1.5) },
      ]),
      mergeGeos([
        { geo: new THREE.CylinderGeometry(0.25, 0.9, 1, 8), color: '#9ea3a8', matrix: M4(0, 0.5, 0) },
        { geo: new THREE.SphereGeometry(0.45, 10, 6), color: '#d33a2c', matrix: M4(0, 1.02, 0, 0, 0, 0, 1, 0.03, 1) },
      ]),
    ];
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 });
    this.roofMeshes = geos.map((g, t) => {
      const items = this.roofItems.filter((r) => r.type === t);
      const m = new THREE.InstancedMesh(g, mat, Math.max(1, items.length));
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      items.forEach((r, k) => {
        r.mesh = m; r.idx = k;
        writeYawMatrix(m.instanceMatrix.array, k, r.x, r.y, r.z, r.yaw, r.sx, r.sy, r.sz);
        this.buildings[r.b].attach.push(r);
      });
      m.count = items.length;
      m.castShadow = true;
      m.frustumCulled = false;
      this.scene.add(m);
      return m;
    });
  }

  _gridInsert(b) {
    const c0 = this._cellX(b.x0), c1 = this._cellX(b.x1), r0 = this._cellX(b.z0), r1 = this._cellX(b.z1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * this.gn + c;
      (this.gridB[k] || (this.gridB[k] = [])).push(b.id);
    }
  }

  _cellX(v) { return U.clamp(Math.floor((v - this.gmin) / this.cell), 0, this.gn - 1); }

  /** 查询与矩形区域重叠的建筑（返回共享数组，调用方不要长期持有） */
  queryBuildings(x0, z0, x1, z1) {
    const out = this._qb;
    out.length = 0;
    const id = ++this.stampId;
    if (!this.stamp) this.stamp = new Uint32Array(this.buildings.length);
    const c0 = this._cellX(x0), c1 = this._cellX(x1), r0 = this._cellX(z0), r1 = this._cellX(z1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const list = this.gridB[r * this.gn + c];
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const bi = list[k];
        if (this.stamp[bi] === id) continue;
        this.stamp[bi] = id;
        const b = this.buildings[bi];
        if (b.state !== 2) out.push(b);
      }
    }
    return out;
  }

  /** 角色脚下可站立的高度（地面或屋顶） */
  groundHeight(x, z, feetY) {
    let gh = 0;
    const list = this.queryBuildings(x - 0.4, z - 0.4, x + 0.4, z + 0.4);
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      const top = b.y1 - b.sink;
      if (top <= feetY + 0.9 && top > gh && !this.holes.insideHole(b.id, x, top, z, 0)) gh = top;
    }
    return gh;
  }

  /** 首次受损时为建筑分配一个内部（背面）实例 */
  ensureInterior(b) {
    if (b.interior >= 0) return;
    const im = this.iMesh;
    let k;
    if (im.count < CFG.pools.interiors) k = im.count++;
    else {
      // 用尽：回收最早的
      k = this._iRecycle = ((this._iRecycle || 0) + 1) % CFG.pools.interiors;
      const old = this.interiorOwner[k];
      if (old !== undefined) this.buildings[old].interior = -1;
    }
    b.interior = k;
    this.interiorOwner[k] = b.id;
    const A = this.iAttr;
    A.aBid.array[k] = b.id;
    A.aStyle.array.set([b.facade, b.seed, b.floorH, b.colW], k * 4);
    A.aDims.array.set([b.cx, b.cz, b.hw, b.hd], k * 4);
    A.aDims2.array.set([b.y0, b.h, b.sink, 0], k * 4);
    for (const key in A) A[key].needsUpdate = true;
    // 内部比外墙略小，避免深度冲突
    writeYawMatrix(im.instanceMatrix.array, k, b.cx, b.y0 - b.sink + 0.05, b.cz, 0, b.hw * 2 - 0.3, b.h - 0.3, b.hd * 2 - 0.3);
    im.instanceColor.setXYZ(k, 1, 1, 1);
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
  }

  /** 设置建筑下沉量（坍塌动画），同步外墙、内部、屋顶与屋顶设备 */
  setSink(b, sink, jx = 0, jz = 0) {
    b.sink = sink;
    const arr = this.bMesh.instanceMatrix.array;
    writeYawMatrix(arr, b.id, b.cx + jx, b.y0 - sink, b.cz + jz, 0, b.hw * 2, b.h, b.hd * 2);
    this.bMesh.instanceMatrix.needsUpdate = true;
    this.aDims2.array[b.id * 4 + 2] = sink;
    this.aDims2.needsUpdate = true;
    if (b.interior >= 0) {
      writeYawMatrix(this.iMesh.instanceMatrix.array, b.interior, b.cx + jx, b.y0 - sink + 0.05, b.cz + jz, 0, b.hw * 2 - 0.3, b.h - 0.3, b.hd * 2 - 0.3);
      this.iAttr.aDims2.array[b.interior * 4 + 2] = sink;
      this.iAttr.aDims2.needsUpdate = true;
      this.iMesh.instanceMatrix.needsUpdate = true;
    }
    if (b.roof >= 0) {
      const along = b.roofYaw !== 0;
      writeYawMatrix(this.roofMesh.instanceMatrix.array, b.roof, b.cx + jx, b.y1 - sink, b.cz + jz, b.roofYaw,
        (along ? b.hd : b.hw) * 2.16, b.roofH, (along ? b.hw : b.hd) * 2.12);
      this.roofMesh.instanceMatrix.needsUpdate = true;
    }
    for (const r of b.attach) {
      writeYawMatrix(r.mesh.instanceMatrix.array, r.idx, r.x + jx, r.y - sink, r.z + jz, r.yaw, r.sx, r.sy, r.sz);
      r.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** 彻底移除建筑（被完全摧毁 / 坍塌结束） */
  hide(b) {
    b.state = 2;
    writeZeroMatrix(this.bMesh.instanceMatrix.array, b.id);
    this.bMesh.instanceMatrix.needsUpdate = true;
    if (b.interior >= 0) {
      writeZeroMatrix(this.iMesh.instanceMatrix.array, b.interior);
      this.iMesh.instanceMatrix.needsUpdate = true;
    }
    if (b.roof >= 0) {
      writeZeroMatrix(this.roofMesh.instanceMatrix.array, b.roof);
      this.roofMesh.instanceMatrix.needsUpdate = true;
    }
    for (const r of b.attach) {
      writeZeroMatrix(r.mesh.instanceMatrix.array, r.idx);
      r.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  update(dt, camera) {
    this.props.update(dt, camera);
    this.traffic.update(dt, camera);
  }
}
