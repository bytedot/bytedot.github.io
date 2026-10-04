'use strict';
/* =====================================================================
 * hero.js — 原创角色"天顶 ZENITH"
 *  - 由基本几何体拼成的分层骨架（骨盆/脊柱/胸/头/双臂/双腿），石墨黑战衣 + 金色饰边 + 象牙白披风
 *  - 多套姿势按速度与状态加权混合：站立 / 行走 / 悬停 / 普通飞行 / 高速 / 极速 / 垂直上升 / 急停 / 超级英雄落地 / 出拳
 *  - 身体整体朝向由"头顶方向 = 速度方向"推导：慢速时直立，越快越接近水平，俯冲时头朝下
 *  - 披风：在角色局部空间做 Verlet 布料模拟，受重力、迎面气流与抖动影响，不会因高速而爆炸
 * ===================================================================== */

const POSES = {
  stand: {
    spine: [0, 0, 0], chest: [0.02, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
    shoulderL: [0.05, 0, 0.13], shoulderR: [0.05, 0, -0.13], elbowL: [-0.18, 0, 0], elbowR: [-0.18, 0, 0],
    hipL: [0, 0, 0.05], hipR: [0, 0, -0.05], kneeL: [0.03, 0, 0], kneeR: [0.03, 0, 0], ankleL: [0, 0, 0], ankleR: [0, 0, 0], drop: 0,
  },
  hover: {
    spine: [0.06, 0, 0], chest: [0.04, 0, 0], neck: [-0.06, 0, 0], head: [0, 0, 0],
    shoulderL: [0.1, 0, 0.42], shoulderR: [0.1, 0, -0.42], elbowL: [-0.28, 0, 0], elbowR: [-0.28, 0, 0],
    hipL: [-0.14, 0, 0.06], hipR: [0.06, 0, -0.04], kneeL: [0.38, 0, 0], kneeR: [0.14, 0, 0], ankleL: [0.5, 0, 0], ankleR: [0.4, 0, 0], drop: 0,
  },
  fly: {
    spine: [0.04, 0, 0], chest: [0, 0, 0], neck: [-0.5, 0, 0], head: [-0.12, 0, 0],
    shoulderL: [0.38, 0, 0.17], shoulderR: [0.38, 0, -0.17], elbowL: [-0.12, 0, 0], elbowR: [-0.12, 0, 0],
    hipL: [0.06, 0, 0.04], hipR: [0.2, 0, -0.04], kneeL: [0.14, 0, 0], kneeR: [0.38, 0, 0], ankleL: [0.75, 0, 0], ankleR: [0.75, 0, 0], drop: 0,
  },
  fast: {
    spine: [0, 0, 0], chest: [0, 0, 0], neck: [-0.88, 0, 0], head: [-0.25, 0, 0],
    shoulderL: [0.24, 0, 0.1], shoulderR: [0.24, 0, -0.1], elbowL: [0, 0, 0], elbowR: [0, 0, 0],
    hipL: [0.03, 0, 0.02], hipR: [0.09, 0, -0.02], kneeL: [0.05, 0, 0], kneeR: [0.16, 0, 0], ankleL: [0.95, 0, 0], ankleR: [0.95, 0, 0], drop: 0,
  },
  hyper: {
    spine: [0, 0, 0], chest: [0, 0, 0], neck: [-0.95, 0, 0], head: [-0.25, 0, 0],
    shoulderL: [0.3, 0, 0.05], shoulderR: [0.3, 0, -0.05], elbowL: [0, 0, 0], elbowR: [0, 0, 0],
    hipL: [0, 0, 0.01], hipR: [0.02, 0, -0.01], kneeL: [0, 0, 0], kneeR: [0.04, 0, 0], ankleL: [1.05, 0, 0], ankleR: [1.05, 0, 0], drop: 0,
  },
  ascend: {
    spine: [0, 0, 0], chest: [0, 0, 0], neck: [-0.42, 0, 0], head: [-0.2, 0, 0],
    shoulderL: [0.06, 0, 0.07], shoulderR: [0.06, 0, -0.07], elbowL: [0, 0, 0], elbowR: [0, 0, 0],
    hipL: [0, 0, 0.02], hipR: [0, 0, -0.02], kneeL: [0.04, 0, 0], kneeR: [0.1, 0, 0], ankleL: [0.7, 0, 0], ankleR: [0.7, 0, 0], drop: 0,
  },
  brake: {
    spine: [-0.28, 0, 0], chest: [-0.12, 0, 0], neck: [0.15, 0, 0], head: [0, 0, 0],
    shoulderL: [-0.45, 0, 1.05], shoulderR: [-0.45, 0, -1.05], elbowL: [-0.55, 0, 0], elbowR: [-0.55, 0, 0],
    hipL: [-0.95, 0, 0.12], hipR: [-0.6, 0, -0.12], kneeL: [0.95, 0, 0], kneeR: [0.55, 0, 0], ankleL: [0.1, 0, 0], ankleR: [0.1, 0, 0], drop: 0,
  },
  land: {
    spine: [0.5, 0, 0], chest: [0.18, 0, 0], neck: [-0.45, 0, 0], head: [-0.1, 0, 0],
    shoulderL: [0.35, 0, 0.75], shoulderR: [-0.95, 0, -0.18], elbowL: [-0.35, 0, 0], elbowR: [-0.35, 0, 0],
    hipL: [-1.45, 0, 0.18], hipR: [0.25, 0, -0.12], kneeL: [1.55, 0, 0], kneeR: [2.05, 0, 0], ankleL: [-0.12, 0, 0], ankleR: [0.6, 0, 0], drop: -0.5,
  },
};
const JOINTS = ['spine', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR'];

class HeroModel {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.j = {};
    this.cur = {};
    for (const k of JOINTS) this.cur[k] = [0, 0, 0];
    this.curDrop = 0;
    this.time = 0;
    this.walkPhase = 0;
    this._buildMaterials();
    this._buildBody();
    this._buildCape();
    this._buildGlow();
    this.root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(this.root);
    // 朝向计算用的临时变量
    this._q = new THREE.Quaternion(); this._qb = new THREE.Quaternion(); this._m = new THREE.Matrix4();
    this._u = new THREE.Vector3(0, 1, 0); this._c = new THREE.Vector3(); this._r = new THREE.Vector3(); this._x = new THREE.Vector3();
    this._t = new THREE.Vector3(); this._ax = new THREE.Vector3();
    this.bank = 0;
    this._prevHeading = 0;
  }

  _buildMaterials() {
    this.mat = {
      suit: new THREE.MeshStandardMaterial({ color: 0x1b1e25, roughness: 0.42, metalness: 0.35 }),
      armor: new THREE.MeshStandardMaterial({ color: 0x2c3039, roughness: 0.28, metalness: 0.85 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xd4a64a, roughness: 0.22, metalness: 1.0 }),
      skin: new THREE.MeshStandardMaterial({ color: 0xc99a7c, roughness: 0.62, metalness: 0 }),
      hair: new THREE.MeshStandardMaterial({ color: 0x2a1f17, roughness: 0.75, metalness: 0.05 }),
      mask: new THREE.MeshStandardMaterial({ color: 0x0f1115, roughness: 0.3, metalness: 0.6 }),
      eye: new THREE.MeshBasicMaterial({ color: 0xffc86b }),
      capeOut: new THREE.MeshStandardMaterial({ color: 0xe6dfcf, roughness: 0.78, metalness: 0, side: THREE.FrontSide }),
      capeIn: new THREE.MeshStandardMaterial({ color: 0xa8833a, roughness: 0.5, metalness: 0.35, side: THREE.BackSide }),
    };
  }

  _joint(name, parent, x, y, z) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    if (name) this.j[name] = g;
    return g;
  }

  _mesh(geo, mat, parent, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.scale.set(sx, sy, sz);
    parent.add(m);
    return m;
  }

  _buildBody() {
    const M = this.mat;
    const pelvis = this._joint('pelvis', this.body, 0, 0, 0);
    // 骨盆与腰带
    this._mesh(new THREE.CapsuleGeometry(0.15, 0.13, 4, 10), M.suit, pelvis, 0, -0.03, 0, 0, 0, Math.PI / 2, 1, 1, 0.78);
    this._mesh(new THREE.CylinderGeometry(0.185, 0.19, 0.07, 18), M.gold, pelvis, 0, 0.06, 0, 0, 0, 0, 1, 1, 0.78);
    this._mesh(new THREE.BoxGeometry(0.07, 0.06, 0.03), M.gold, pelvis, 0, 0.06, 0.15);

    const spine = this._joint('spine', pelvis, 0, 0.08, 0);
    this._mesh(new THREE.CapsuleGeometry(0.145, 0.14, 4, 12), M.suit, spine, 0, 0.12, 0, 0, 0, 0, 1.12, 1, 0.82);

    const chest = this._joint('chest', spine, 0, 0.24, 0);
    this._mesh(new THREE.SphereGeometry(0.2, 20, 14), M.suit, chest, 0, 0.12, 0, 0, 0, 0, 1.36, 1.05, 0.86);
    this._mesh(new THREE.SphereGeometry(0.2, 20, 14), M.armor, chest, 0, 0.13, 0.035, 0, 0, 0, 1.18, 0.9, 0.78);
    // 胸前徽记：原创"上升 V 形" + 菱形
    this._mesh(new THREE.BoxGeometry(0.15, 0.028, 0.02), M.gold, chest, 0.048, 0.155, 0.19, 0, 0, 0.62);
    this._mesh(new THREE.BoxGeometry(0.15, 0.028, 0.02), M.gold, chest, -0.048, 0.155, 0.19, 0, 0, -0.62);
    this._mesh(new THREE.OctahedronGeometry(0.03, 0), M.gold, chest, 0, 0.215, 0.185, 0, 0, 0, 0.8, 1.2, 0.5);
    // 高领与披风扣
    this._mesh(new THREE.TorusGeometry(0.095, 0.028, 8, 20), M.gold, chest, 0, 0.27, -0.005, Math.PI / 2, 0, 0, 1, 0.85, 1);
    this._mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 14), M.gold, chest, 0.17, 0.25, -0.06, Math.PI / 2, 0, 0);
    this._mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 14), M.gold, chest, -0.17, 0.25, -0.06, Math.PI / 2, 0, 0);
    // 肩甲
    for (const s of [1, -1]) {
      this._mesh(new THREE.SphereGeometry(0.115, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.armor, chest, s * 0.255, 0.215, 0, 0, 0, s * -0.25, 1.15, 0.85, 1.1);
      this._mesh(new THREE.TorusGeometry(0.112, 0.012, 6, 20), M.gold, chest, s * 0.255, 0.215, 0, Math.PI / 2, s * 0.25, 0, 1.15, 1.1, 1);
    }

    const neck = this._joint('neck', chest, 0, 0.29, 0);
    this._mesh(new THREE.CylinderGeometry(0.058, 0.068, 0.13, 12), M.skin, neck, 0, 0.05, 0);
    const head = this._joint('head', neck, 0, 0.11, 0);
    this._mesh(new THREE.SphereGeometry(0.115, 22, 16), M.skin, head, 0, 0.1, 0.005, 0, 0, 0, 0.92, 1.1, 1.0);
    this._mesh(new THREE.SphereGeometry(0.1, 16, 12), M.skin, head, 0, 0.035, 0.025, 0, 0, 0, 0.82, 0.62, 0.88);
    // 向后梳的短发：前额发际线较高，后脑覆盖较低
    this._mesh(new THREE.SphereGeometry(0.123, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.44), M.hair, head, 0, 0.118, -0.016, -0.5, 0, 0, 0.96, 1.0, 1.08);
    this._mesh(new THREE.BoxGeometry(0.022, 0.036, 0.028), M.skin, head, 0, 0.082, 0.112, -0.2, 0, 0);
    this._mesh(new THREE.SphereGeometry(0.024, 8, 6), M.skin, head, 0.106, 0.095, -0.005, 0, 0, 0, 0.5, 1, 0.8);
    this._mesh(new THREE.SphereGeometry(0.024, 8, 6), M.skin, head, -0.106, 0.095, -0.005, 0, 0, 0, 0.5, 1, 0.8);
    // 半截面罩（眼部）
    this._mesh(new THREE.CylinderGeometry(0.119, 0.117, 0.05, 24, 1, true, -Math.PI * 0.42, Math.PI * 0.84), M.mask, head, 0, 0.118, 0.004, 0, 0, 0, 0.93, 1, 1.0);
    this.eyeL = this._mesh(new THREE.SphereGeometry(0.013, 8, 6), M.eye, head, 0.038, 0.12, 0.103);
    this.eyeR = this._mesh(new THREE.SphereGeometry(0.013, 8, 6), M.eye, head, -0.038, 0.12, 0.103);

    // 双臂（+X 为角色左侧）
    for (const [s, n] of [[1, 'L'], [-1, 'R']]) {
      const sh = this._joint('shoulder' + n, chest, s * 0.245, 0.2, 0);
      this._mesh(new THREE.CapsuleGeometry(0.062, 0.22, 4, 10), M.suit, sh, 0, -0.15, 0);
      const el = this._joint('elbow' + n, sh, 0, -0.3, 0);
      this._mesh(new THREE.CapsuleGeometry(0.057, 0.2, 4, 10), M.armor, el, 0, -0.13, 0);
      this._mesh(new THREE.CylinderGeometry(0.064, 0.064, 0.025, 14), M.gold, el, 0, -0.05, 0);
      const hand = this._joint('hand' + n, el, 0, -0.27, 0);
      this._mesh(new THREE.SphereGeometry(0.05, 12, 8), M.armor, hand, 0, -0.04, 0.005, 0, 0, 0, 0.85, 1.15, 1.0);
    }
    // 双腿
    for (const [s, n] of [[1, 'L'], [-1, 'R']]) {
      const hip = this._joint('hip' + n, pelvis, s * 0.1, -0.06, 0);
      this._mesh(new THREE.CapsuleGeometry(0.085, 0.3, 4, 10), M.suit, hip, 0, -0.21, 0);
      const knee = this._joint('knee' + n, hip, 0, -0.43, 0);
      this._mesh(new THREE.CapsuleGeometry(0.069, 0.3, 4, 10), M.armor, knee, 0, -0.2, 0);
      this._mesh(new THREE.SphereGeometry(0.05, 10, 8), M.gold, knee, 0, 0.0, 0.045, 0, 0, 0, 1, 1, 0.6);
      const ankle = this._joint('ankle' + n, knee, 0, -0.42, 0);
      this._mesh(new THREE.BoxGeometry(0.1, 0.085, 0.25), M.armor, ankle, 0, -0.035, 0.05);
      this._mesh(new THREE.BoxGeometry(0.104, 0.02, 0.254), M.gold, ankle, 0, -0.075, 0.05);
    }
  }

  /* ---------------- 披风（Verlet 布料） ---------------- */
  _buildCape() {
    const W = this.cW = 9, H = this.cH = 14;
    const n = W * H;
    this.cp = new Float32Array(n * 3);
    this.cprev = new Float32Array(n * 3);
    this.cr = new Float32Array(n * 3);      // 渲染用位置（模拟位置 + 褶皱）
    this.cLen = 1.3;
    const idx = [], uv = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) uv.push(c / (W - 1), 1 - r / (H - 1));
    for (let r = 0; r < H - 1; r++) for (let c = 0; c < W - 1; c++) {
      const a = r * W + c, b = a + 1, d = a + W, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    const geo = this.capeGeo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.cr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // 约束：结构（横 / 竖）+ 剪切（对角）+ 弯曲（隔一个）
    this.cons = [];
    const width = (r) => U.lerp(0.38, 1.02, r / (H - 1));
    const dy = this.cLen / (H - 1);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const wr = width(r) / (W - 1);
      if (c < W - 1) this.cons.push(i, i + 1, wr);
      if (r < H - 1) this.cons.push(i, i + W, dy);
      if (r < H - 1 && c < W - 1) {
        const wn = width(r + 1) / (W - 1);
        this.cons.push(i, i + W + 1, Math.hypot((wr + wn) / 2, dy));
        this.cons.push(i + 1, i + W, Math.hypot((wr + wn) / 2, dy));
      }
      if (r < H - 2) this.cons.push(i, i + 2 * W, dy * 2);
    }
    this.cons = new Float32Array(this.cons);
    this.capeOut = new THREE.Mesh(geo, this.mat.capeOut);
    this.capeIn = new THREE.Mesh(geo, this.mat.capeIn);
    for (const m of [this.capeOut, this.capeIn]) { m.frustumCulled = false; this.root.add(m); }
    this.capeInit = false;
    this.capeAcc = 0;
    this._anchors = [];
    for (let c = 0; c < W; c++) this._anchors.push(new THREE.Vector3());
    this._tmp = new THREE.Vector3();
    this._wind = new THREE.Vector3();
    this._grav = new THREE.Vector3();
    this._caps = [];
    for (let k = 0; k < 5; k++) this._caps.push({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 });
    this._invRoot = new THREE.Matrix4();
  }

  _toRoot(obj, x, y, z, out) {
    out.set(x, y, z);
    obj.localToWorld(out);
    return out.applyMatrix4(this._invRoot);
  }

  _capeAnchors() {
    const chest = this.j.chest, W = this.cW;
    for (let c = 0; c < W; c++) {
      const t = c / (W - 1);
      const x = U.lerp(0.17, -0.17, t);
      const z = -0.075 - 0.05 * Math.sin(Math.PI * t);
      this._toRoot(chest, x, 0.25 - 0.02 * Math.sin(Math.PI * t), z, this._anchors[c]);
    }
    // 碰撞胶囊：躯干、双腿
    const C = this._caps, j = this.j;
    this._toRoot(j.pelvis, 0, 0, 0, C[0].a); this._toRoot(j.chest, 0, 0.2, -0.02, C[0].b); C[0].r = 0.21;
    this._toRoot(j.hipL, 0, 0, 0, C[1].a); this._toRoot(j.kneeL, 0, 0, 0, C[1].b); C[1].r = 0.12;
    this._toRoot(j.kneeL, 0, 0, 0, C[2].a); this._toRoot(j.ankleL, 0, 0, 0, C[2].b); C[2].r = 0.1;
    this._toRoot(j.hipR, 0, 0, 0, C[3].a); this._toRoot(j.kneeR, 0, 0, 0, C[3].b); C[3].r = 0.12;
    this._toRoot(j.kneeR, 0, 0, 0, C[4].a); this._toRoot(j.ankleR, 0, 0, 0, C[4].b); C[4].r = 0.1;
  }

  _capeStep(dt, velWorld, speed) {
    const W = this.cW, H = this.cH, P = this.cp, Q = this.cprev;
    const inv = this._qb.copy(this.root.quaternion).invert();
    this._grav.set(0, -9.8, 0).applyQuaternion(inv);
    // 迎面气流（限幅，避免极速时数值爆炸）
    const ws = Math.min(speed, 55);
    this._wind.copy(velWorld);
    if (speed > 1e-3) this._wind.multiplyScalar(-ws / speed); else this._wind.set(0, 0, 0);
    this._wind.applyQuaternion(inv);
    const t = this.time;
    // 抖动：速度越快越剧烈、频率越高
    const flutter = 3 + Math.min(speed, 220) * 0.75;
    const fq = 1 + Math.min(speed, 300) / 70;
    const dt2 = dt * dt;
    for (let r = 1; r < H; r++) for (let c = 0; c < W; c++) {
      const i = (r * W + c) * 3;
      const k = r / (H - 1);
      const vx = (P[i] - Q[i]) * 0.982, vy = (P[i + 1] - Q[i + 1]) * 0.982, vz = (P[i + 2] - Q[i + 2]) * 0.982;
      Q[i] = P[i]; Q[i + 1] = P[i + 1]; Q[i + 2] = P[i + 2];
      const fl = flutter * k * k;
      const ph = t * 9 * fq - r * 0.85;     // 由上往下传播的波
      const fx = Math.sin(ph + c * 0.5) * fl * 0.6;
      const fy = Math.cos(ph * 0.8 - c * 0.7) * fl;
      const fz = Math.sin(ph * 1.2 + c * 0.3) * fl;
      const ax = this._grav.x + this._wind.x * 1.15 + fx;
      const ay = this._grav.y + this._wind.y * 1.15 + fy;
      const az = this._grav.z + this._wind.z * 1.15 + fz;
      P[i] += vx + ax * dt2; P[i + 1] += vy + ay * dt2; P[i + 2] += vz + az * dt2;
    }
    const cons = this.cons;
    for (let it = 0; it < 4; it++) {
      for (let c = 0; c < W; c++) {
        const a = this._anchors[c], i = c * 3;
        P[i] = a.x; P[i + 1] = a.y; P[i + 2] = a.z;
      }
      for (let k = 0; k < cons.length; k += 3) {
        const i = cons[k] * 3, j2 = cons[k + 1] * 3, rest = cons[k + 2];
        const dx = P[j2] - P[i], dy = P[j2 + 1] - P[i + 1], dz = P[j2 + 2] - P[i + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = (d - rest) / d;
        const pinI = cons[k] < W, pinJ = cons[k + 1] < W;
        const wi = pinI ? 0 : pinJ ? 1 : 0.5, wj = pinJ ? 0 : pinI ? 1 : 0.5;
        P[i] += dx * diff * wi; P[i + 1] += dy * diff * wi; P[i + 2] += dz * diff * wi;
        P[j2] -= dx * diff * wj; P[j2 + 1] -= dy * diff * wj; P[j2 + 2] -= dz * diff * wj;
      }
      // 与身体胶囊碰撞
      for (let p = W; p < W * H; p++) {
        const i = p * 3;
        for (const cap of this._caps) {
          const a = cap.a, b = cap.b;
          const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
          const ll = abx * abx + aby * aby + abz * abz || 1e-6;
          let tt = ((P[i] - a.x) * abx + (P[i + 1] - a.y) * aby + (P[i + 2] - a.z) * abz) / ll;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          const cx = P[i] - (a.x + abx * tt), cy = P[i + 1] - (a.y + aby * tt), cz = P[i + 2] - (a.z + abz * tt);
          const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
          const rr = cap.r + 0.025;
          if (d < rr) {
            // 推向背后（-Z）一侧，避免穿过身体
            if (d < 1e-4) { P[i + 2] -= rr; continue; }
            const s = (rr - d) / d;
            P[i] += cx * s; P[i + 1] += cy * s; P[i + 2] += cz * s;
          }
        }
      }
    }
  }

  /** 渲染位置 = 模拟位置 + 沿法线方向的竖向褶皱，让披风看起来像布料而不是平板 */
  _capePleats() {
    const W = this.cW, H = this.cH, P = this.cp, Rr = this.cr;
    const geo = this.capeGeo;
    Rr.set(P);
    geo.attributes.position.needsUpdate = true;
    geo.computeVertexNormals();
    const N = geo.attributes.normal.array;
    for (let r = 0; r < H; r++) {
      const k = r / (H - 1);
      for (let c = 0; c < W; c++) {
        const i = (r * W + c) * 3;
        const p = Math.sin((c / (W - 1)) * Math.PI * 3.0 + k * 0.6) * (0.012 + 0.045 * k);
        Rr[i] += N[i] * p; Rr[i + 1] += N[i + 1] * p; Rr[i + 2] += N[i + 2] * p;
      }
    }
    geo.computeVertexNormals();
  }

  _buildGlow() {
    const tex = makeRadialTexture(64, [[0, 'rgba(255,240,200,1)'], [0.25, 'rgba(255,190,90,0.7)'], [1, 'rgba(255,140,40,0)']]);
    const mk = () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      s.scale.setScalar(0.09);
      return s;
    };
    this.glowL = mk(); this.glowR = mk();
    this.eyeL.add(this.glowL); this.eyeR.add(this.glowR);
    this.glowL.position.set(0, 0, 0.01); this.glowR.position.set(0, 0, 0.01);
  }

  /** 眼睛的世界坐标（射线起点） */
  eyeWorld(left, out) { return (left ? this.eyeL : this.eyeR).getWorldPosition(out); }

  /* ---------------- 每帧更新 ---------------- */
  /**
   * s: { pos, vel, speed, state('ground'|'flight'|'landing'), heading, faceYaw, hyper, brake(0..1),
   *      landT, punchT, beam, groundSpeed, aimPitch }
   */
  update(dt, s) {
    this.time += dt;
    const t = this.time;
    const sp = s.speed;
    const target = {};
    for (const k of JOINTS) target[k] = [0, 0, 0];
    let drop = 0;
    let wsum = 0;
    const add = (pose, w) => {
      if (w <= 0.0001) return;
      wsum += w;
      for (const k of JOINTS) { const a = pose[k], o = target[k]; o[0] += a[0] * w; o[1] += a[1] * w; o[2] += a[2] * w; }
      drop += pose.drop * w;
    };
    if (s.state === 'landing') {
      add(POSES.land, 1);
    } else if (s.state === 'ground') {
      const gs = s.groundSpeed;
      add(POSES.stand, 1);
      // 行走 / 奔跑的程序化步态
      const run = U.smooth(6, 12, gs);
      const amp = U.smooth(0.3, 2, gs) * U.lerp(0.5, 0.95, run);
      this.walkPhase += dt * (gs / U.lerp(1.5, 2.6, run)) * Math.PI * 2 * 0.5;
      const ph = this.walkPhase;
      const sw = Math.sin(ph);
      target.hipL[0] += -sw * amp; target.hipR[0] += sw * amp;
      target.kneeL[0] += Math.max(0, Math.sin(ph + 1.2)) * amp * 1.4;
      target.kneeR[0] += Math.max(0, Math.sin(ph + 1.2 + Math.PI)) * amp * 1.4;
      target.shoulderL[0] += sw * amp * 0.8; target.shoulderR[0] += -sw * amp * 0.8;
      target.elbowL[0] -= amp * 0.6 * run + amp * 0.2; target.elbowR[0] -= amp * 0.6 * run + amp * 0.2;
      target.spine[0] += 0.12 * run;
      target.chest[1] += sw * 0.08 * amp;
      drop += -Math.abs(Math.cos(ph)) * 0.05 * amp;
    } else {
      const hyperW = s.hyper ? U.smooth(160, 360, sp) : 0;
      const wHover = 1 - U.smooth(3, 22, sp);
      const wFly = U.smooth(3, 22, sp) * (1 - U.smooth(65, 140, sp));
      const wFast = U.smooth(65, 140, sp) * (1 - hyperW);
      const vy = sp > 0.01 ? s.vel.y / sp : 0;
      const wAsc = U.smooth(0.55, 0.9, vy) * U.smooth(8, 30, sp);
      add(POSES.hover, wHover);
      add(POSES.fly, wFly * (1 - wAsc));
      add(POSES.fast, wFast * (1 - wAsc));
      add(POSES.hyper, hyperW * (1 - wAsc));
      add(POSES.ascend, wAsc * (1 - wHover));
      if (s.brake > 0) {
        // 急停姿势覆盖
        for (const k of JOINTS) for (let i = 0; i < 3; i++) target[k][i] = target[k][i] / Math.max(wsum, 1e-4) * (1 - s.brake) * wsum + POSES.brake[k][i] * s.brake * wsum;
      }
      // 悬停时手臂轻微摆动，极速时细微颤动
      target.shoulderL[2] += Math.sin(t * 1.3) * 0.04 * wHover;
      target.shoulderR[2] -= Math.sin(t * 1.3 + 0.5) * 0.04 * wHover;
      target.hipL[0] += Math.sin(t * 1.1) * 0.05 * wHover;
      if (hyperW > 0) {
        const jit = 0.02 * hyperW;
        target.shoulderL[2] += (Math.random() - 0.5) * jit; target.shoulderR[2] += (Math.random() - 0.5) * jit;
        target.kneeL[0] += (Math.random() - 0.5) * jit; target.kneeR[0] += (Math.random() - 0.5) * jit;
      }
    }
    if (wsum > 0) {
      for (const k of JOINTS) for (let i = 0; i < 3; i++) target[k][i] /= wsum;
      drop /= wsum;
    }
    // 出拳覆盖右臂
    if (s.punchT > 0) {
      const p = Math.sin(Math.min(1, s.punchT / 0.28) * Math.PI);
      target.shoulderR[0] = U.lerp(target.shoulderR[0], -1.55, p);
      target.shoulderR[2] = U.lerp(target.shoulderR[2], -0.05, p);
      target.elbowR[0] = U.lerp(target.elbowR[0], -0.05, p);
      target.chest[1] = U.lerp(target.chest[1], 0.35, p);
    }
    // 头部朝向视线方向（悬停 / 站立 / 射线时）
    if (s.state !== 'landing') {
      const look = s.beam ? 1 : (1 - U.smooth(10, 40, sp)) * 0.7;
      const yawOff = U.clamp(U.wrapAngle(s.faceYaw - s.heading), -1.0, 1.0);
      target.head[1] += yawOff * 0.6 * look;
      target.neck[1] += yawOff * 0.3 * look;
      if (s.state === 'ground' || sp < 10) target.neck[0] += -s.aimPitch * 0.5 * look;
    }
    // 关节阻尼
    const rate = s.state === 'landing' ? 22 : 9 + Math.min(sp, 300) * 0.02;
    for (const k of JOINTS) {
      const c = this.cur[k], g = target[k];
      for (let i = 0; i < 3; i++) c[i] = U.damp(c[i], g[i], rate, dt);
      this.j[k].rotation.set(c[0], c[1], c[2]);
    }
    this.curDrop = U.damp(this.curDrop, drop, 12, dt);
    const bob = s.state === 'flight' ? Math.sin(t * 1.7) * 0.07 * (1 - U.smooth(3, 20, sp)) : 0;
    this.body.position.y = this.curDrop + bob;

    this._orient(dt, s);
    this.root.position.copy(s.pos);
    this.root.updateMatrixWorld(true);
    this._invRoot.copy(this.root.matrixWorld).invert();

    // 披风：固定步长模拟
    this._capeAnchors();
    if (!this.capeInit) {
      const W = this.cW;
      for (let r = 0; r < this.cH; r++) for (let c = 0; c < W; c++) {
        const i = (r * W + c) * 3, a = this._anchors[c];
        this.cp[i] = a.x * (1 + r * 0.06); this.cp[i + 1] = a.y - r * (this.cLen / (this.cH - 1)); this.cp[i + 2] = a.z - 0.05;
        this.cprev[i] = this.cp[i]; this.cprev[i + 1] = this.cp[i + 1]; this.cprev[i + 2] = this.cp[i + 2];
      }
      this.capeInit = true;
    }
    this.capeAcc += Math.min(dt, 0.05);
    const h = 1 / 90;
    let steps = 0;
    while (this.capeAcc >= h && steps < 6) { this._capeStep(h, s.vel, sp); this.capeAcc -= h; steps++; }
    this._capePleats();

    // 眼睛发光
    const g = s.beam ? 1.9 + Math.random() * 0.4 : 0.9 + 0.1 * Math.sin(t * 2.3);
    this.glowL.scale.setScalar(0.09 * g); this.glowR.scale.setScalar(0.09 * g);
  }

  /** 计算身体整体朝向：头顶方向 u、胸口方向 c，再绕身体长轴做转弯侧倾 */
  _orient(dt, s) {
    const sp = s.speed;
    const up = this._t.set(0, 1, 0);
    const u = this._u.set(0, 1, 0);
    const heading = s.heading;
    // 水平右方向
    const fx = -Math.sin(heading), fz = -Math.cos(heading);
    this._r.set(-fz, 0, fx);                 // right = forward × up
    if (s.state === 'flight' && sp > 0.5) {
      const vd = this._c.copy(s.vel).multiplyScalar(1 / sp);
      // 普通飞行（≈46 m/s）前倾约 40°，高速接近水平，极速完全水平
      let align = U.smooth(2, 90, sp) * 0.92 + (s.hyper ? 0.08 * U.smooth(150, 300, sp) : 0);
      align = Math.min(align, 1) * (1 - 0.85 * s.brake);
      const ang = Math.acos(U.clamp(vd.dot(up), -1, 1)) * align;
      this._ax.crossVectors(up, vd);
      if (this._ax.lengthSq() < 1e-6) this._ax.copy(this._r).multiplyScalar(-1);
      this._ax.normalize();
      u.applyAxisAngle(this._ax, ang);
      // 急停：身体后仰
      if (s.brake > 0) u.applyAxisAngle(this._r, 0.55 * s.brake).normalize();
    }
    // 胸口方向 c = u × right，再正交化
    const c = this._c.crossVectors(u, this._r);
    if (c.lengthSq() < 1e-6) c.set(fx, 0, fz);
    c.normalize();
    const x = this._x.crossVectors(u, c).normalize();
    this._m.makeBasis(x, u, c);
    this._q.setFromRotationMatrix(this._m);
    // 转弯侧倾
    const yawRate = U.wrapAngle(heading - this._prevHeading) / Math.max(dt, 1e-4);
    this._prevHeading = heading;
    const bankT = s.state === 'flight' ? U.clamp(-yawRate * U.smooth(10, 150, sp) * 0.35, -1.1, 1.1) : 0;
    this.bank = U.damp(this.bank, bankT, 6, dt);
    this._qb.setFromAxisAngle(this._t.set(0, 1, 0), this.bank);
    this._q.multiply(this._qb);
    const rate = s.state === 'landing' ? 20 : 7 + Math.min(sp, 300) * 0.02;
    this.root.quaternion.slerp(this._q, 1 - Math.exp(-rate * dt));
  }
}
