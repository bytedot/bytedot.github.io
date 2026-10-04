'use strict';
/* =====================================================================
 * props.js — 城市道具与交通
 *  - PropSystem : 路灯、行道树、长椅、垃圾桶、消防栓、红绿灯、公交站、喷泉、纪念碑
 *                 按 960m 分区（chunk）实例化，并做距离裁剪；被撞后转为刚体或"倒下"动画
 *  - Traffic    : 行驶车辆（按车道循环行驶）与路边停放车辆，被撞后变为刚体飞出 / 爆炸
 *  - stepBody   : 极简刚体（重力、地面反弹、摩擦、静止后贴地摆正）
 * ===================================================================== */

/** 行道树摆动的共享参数 */
const SWAY_U = {
  uTime: { value: 0 },
  uHeroPos: { value: new THREE.Vector3(0, -999, 0) },
  uHeroSpeed: { value: 0 },
};

const _bq = new THREE.Quaternion(), _bax = new THREE.Vector3(), _bv = new THREE.Vector3(), _bup = new THREE.Vector3(0, 1, 0);
const BODY_AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];

function makeBody(px, py, pz, q, hx, hy, hz) {
  return {
    p: new THREE.Vector3(px, py, pz), v: new THREE.Vector3(), q: q.clone(), w: new THREE.Vector3(),
    hx, hy, hz, rest: false, restT: 0, ground: false, age: 0, settleQ: null, settleH: 0, hitWall: 0,
  };
}

/** 刚体积分一步；返回 true 表示仍在运动 */
function stepBody(b, dt) {
  if (b.rest) return false;
  b.age += dt;
  if (b.settleQ) {
    // 静止后平滑摆正到最近的稳定朝向
    b.q.slerp(b.settleQ, 1 - Math.exp(-14 * dt));
    b.p.y = U.damp(b.p.y, b.settleH, 14, dt);
    if (b.q.angleTo(b.settleQ) < 0.01) { b.q.copy(b.settleQ); b.p.y = b.settleH; b.rest = true; }
    return true;
  }
  b.v.y -= 22 * dt;
  b.p.addScaledVector(b.v, dt);
  const wl = b.w.length();
  if (wl > 1e-4) {
    _bq.setFromAxisAngle(_bax.copy(b.w).multiplyScalar(1 / wl), wl * dt);
    b.q.premultiply(_bq).normalize();
  }
  // 最低角点贴地
  let minY = Infinity;
  for (let sx = -1; sx <= 1; sx += 2) for (let sy = -1; sy <= 1; sy += 2) for (let sz = -1; sz <= 1; sz += 2) {
    _bv.set(sx * b.hx, sy * b.hy, sz * b.hz).applyQuaternion(b.q);
    if (_bv.y < minY) minY = _bv.y;
  }
  const bottom = b.p.y + minY;
  b.ground = false;
  if (bottom < 0) {
    b.p.y -= bottom;
    if (b.v.y < 0) b.v.y = -b.v.y * 0.28;
    b.v.x *= 0.86; b.v.z *= 0.86;
    b.w.multiplyScalar(0.86);
    b.ground = true;
  }
  if (b.ground && b.v.lengthSq() < 1.2 && b.w.lengthSq() < 1.5) {
    b.restT += dt;
    if (b.restT > 0.3) {
      // 找到最朝上的局部轴，算出摆正后的目标朝向与高度
      let best = 0, bestY = -2;
      for (let k = 0; k < 6; k++) {
        _bv.copy(BODY_AXES[k]).applyQuaternion(b.q);
        if (_bv.y > bestY) { bestY = _bv.y; best = k; }
      }
      _bv.copy(BODY_AXES[best]).applyQuaternion(b.q);
      const d = new THREE.Quaternion().setFromUnitVectors(_bv, _bup);
      b.settleQ = d.multiply(b.q);
      b.settleH = best < 2 ? b.hx : best < 4 ? b.hy : b.hz;
      b.v.set(0, 0, 0); b.w.set(0, 0, 0);
    }
  } else b.restT = 0;
  return true;
}

/** 刚体撞到建筑：推出并反弹，高速时在墙上砸出小洞 */
function bodyVsBuildings(b, city, onHit) {
  if (b.rest || b.settleQ) return;
  const r = Math.max(b.hx, b.hz);
  const list = city.queryBuildings(b.p.x - r, b.p.z - r, b.p.x + r, b.p.z + r);
  for (let k = 0; k < list.length; k++) {
    const B = list[k];
    const top = B.y1 - B.sink;
    if (b.p.y > top + r || b.p.x < B.x0 - r || b.p.x > B.x1 + r || b.p.z < B.z0 - r || b.p.z > B.z1 + r) continue;
    if (city.holes.insideHole(B.id, b.p.x, b.p.y, b.p.z, 0)) continue;
    // 选择穿透最浅的方向推出
    const pen = [b.p.x - (B.x0 - r), (B.x1 + r) - b.p.x, b.p.z - (B.z0 - r), (B.z1 + r) - b.p.z, (top + r) - b.p.y];
    let m = 0;
    for (let i = 1; i < 5; i++) if (pen[i] < pen[m]) m = i;
    const sp = b.v.length();
    if (m === 0) { b.p.x = B.x0 - r; b.v.x = -Math.abs(b.v.x) * 0.3; }
    else if (m === 1) { b.p.x = B.x1 + r; b.v.x = Math.abs(b.v.x) * 0.3; }
    else if (m === 2) { b.p.z = B.z0 - r; b.v.z = -Math.abs(b.v.z) * 0.3; }
    else if (m === 3) { b.p.z = B.z1 + r; b.v.z = Math.abs(b.v.z) * 0.3; }
    else { b.p.y = top + r; if (b.v.y < 0) b.v.y = -b.v.y * 0.25; }
    if (onHit && sp > 25 && m < 4) onHit(B, b.p, m, sp);
  }
}

/* ===================================================================== */

class PropSystem {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.list = [];
    this.types = this._defineTypes();
    this.tIndex = {};
    this.types.forEach((t, i) => { this.tIndex[t.name] = i; });
    this.chunk = 960;
    this.dyn = [];
    this.topples = [];
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._e = new THREE.Euler();
    this._v = new THREE.Vector3(); this._ax = new THREE.Vector3();
    this._out = [];
  }

  _defineTypes() {
    const T = [];
    T.push({ name: 'lamp', r: 0.35, h: 9, hx: 0.3, hy: 4.5, hz: 0.3, topple: true, cull: 480, snd: 'metal',
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(0.09, 0.14, 9, 6, 1, true), color: '#3a3e44', matrix: M4(0, 4.5, 0) },
        { geo: new THREE.BoxGeometry(2.6, 0.12, 0.12), color: '#3a3e44', matrix: M4(1.25, 8.9, 0) },
        { geo: new THREE.BoxGeometry(0.95, 0.18, 0.42), color: '#cfd3d8', matrix: M4(2.45, 8.82, 0) },
        { geo: new THREE.BoxGeometry(0.7, 0.04, 0.3), color: '#fff3d0', matrix: M4(2.45, 8.72, 0) },
      ]) });
    T.push({ name: 'tree', r: 0.6, h: 8.5, hx: 2.0, hy: 4.2, hz: 2.0, topple: true, cull: 900, snd: 'wood', sway: true,
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(0.17, 0.3, 4.2, 5, 1, true), color: '#4f3a2a', matrix: M4(0, 2.1, 0) },
        { geo: jitterGeo(new THREE.IcosahedronGeometry(2.5, 0), 0.6, mulberry(5)), color: '#3d6b2c', matrix: M4(0, 5.6, 0, 0, 0, 0, 1, 0.9, 1) },
        { geo: jitterGeo(new THREE.IcosahedronGeometry(1.8, 0), 0.5, mulberry(6)), color: '#4a7a33', matrix: M4(0.9, 6.9, -0.4) },
        { geo: jitterGeo(new THREE.IcosahedronGeometry(1.6, 0), 0.5, mulberry(7)), color: '#557f38', matrix: M4(-1.0, 6.3, 0.6) },
      ]) });
    T.push({ name: 'bench', r: 0.9, h: 1, hx: 0.9, hy: 0.45, hz: 0.3, cull: 220, snd: 'wood',
      geo: mergeGeos([
        { geo: new THREE.BoxGeometry(1.8, 0.08, 0.5), color: '#7a5a3c', matrix: M4(0, 0.45, 0) },
        { geo: new THREE.BoxGeometry(1.8, 0.45, 0.06), color: '#7a5a3c', matrix: M4(0, 0.75, -0.24) },
        { geo: new THREE.BoxGeometry(0.08, 0.45, 0.5), color: '#33363a', matrix: M4(-0.8, 0.22, 0) },
        { geo: new THREE.BoxGeometry(0.08, 0.45, 0.5), color: '#33363a', matrix: M4(0.8, 0.22, 0) },
      ]) });
    T.push({ name: 'bin', r: 0.35, h: 1, hx: 0.3, hy: 0.5, hz: 0.3, cull: 220, snd: 'metal',
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(0.3, 0.27, 0.95, 10), color: '#2f4a3a', matrix: M4(0, 0.48, 0) },
        { geo: new THREE.CylinderGeometry(0.32, 0.32, 0.06, 10), color: '#1f2a24', matrix: M4(0, 0.98, 0) },
      ]) });
    T.push({ name: 'hydrant', r: 0.25, h: 0.8, hx: 0.2, hy: 0.4, hz: 0.2, cull: 200, snd: 'metal', water: true,
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(0.16, 0.19, 0.7, 10), color: '#b3261e', matrix: M4(0, 0.35, 0) },
        { geo: new THREE.SphereGeometry(0.17, 10, 6), color: '#c8a02a', matrix: M4(0, 0.72, 0) },
        { geo: new THREE.CylinderGeometry(0.07, 0.07, 0.42, 8), color: '#b3261e', matrix: M4(0, 0.45, 0, 0, 0, Math.PI / 2) },
      ]) });
    T.push({ name: 'tlight', r: 0.35, h: 6.6, hx: 0.3, hy: 3.3, hz: 0.3, topple: true, cull: 520, snd: 'metal',
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(0.11, 0.15, 6.6, 6, 1, true), color: '#2e3236', matrix: M4(0, 3.3, 0) },
        { geo: new THREE.BoxGeometry(6.2, 0.16, 0.16), color: '#2e3236', matrix: M4(3.0, 6.4, 0) },
        { geo: new THREE.BoxGeometry(0.38, 1.05, 0.38), color: '#b08a1e', matrix: M4(3.6, 5.8, 0) },
        { geo: new THREE.BoxGeometry(0.38, 1.05, 0.38), color: '#b08a1e', matrix: M4(5.6, 5.8, 0) },
        { geo: new THREE.BoxGeometry(0.2, 0.2, 0.06), color: '#44ff88', matrix: M4(3.6, 5.5, 0.2) },
        { geo: new THREE.BoxGeometry(0.2, 0.2, 0.06), color: '#44ff88', matrix: M4(5.6, 5.5, 0.2) },
      ]) });
    T.push({ name: 'busstop', r: 2.0, h: 2.7, hx: 2.0, hy: 1.35, hz: 0.8, cull: 420, snd: 'glass', glass: true,
      geo: mergeGeos([
        { geo: new THREE.BoxGeometry(4.2, 0.14, 1.7), color: '#3b4048', matrix: M4(0, 2.6, 0) },
        { geo: new THREE.BoxGeometry(4.0, 2.2, 0.05), color: '#9db4c2', matrix: M4(0, 1.4, -0.75) },
        { geo: new THREE.BoxGeometry(0.1, 2.6, 0.1), color: '#3b4048', matrix: M4(-2.0, 1.3, -0.75) },
        { geo: new THREE.BoxGeometry(0.1, 2.6, 0.1), color: '#3b4048', matrix: M4(2.0, 1.3, -0.75) },
        { geo: new THREE.BoxGeometry(0.1, 2.6, 0.1), color: '#3b4048', matrix: M4(-2.0, 1.3, 0.75) },
        { geo: new THREE.BoxGeometry(0.1, 2.6, 0.1), color: '#3b4048', matrix: M4(2.0, 1.3, 0.75) },
        { geo: new THREE.BoxGeometry(3.0, 0.08, 0.45), color: '#7a5a3c', matrix: M4(0, 0.5, -0.45) },
        { geo: new THREE.BoxGeometry(1.2, 2.0, 0.08), color: '#d9a43c', matrix: M4(1.4, 1.5, -0.7) },
      ]) });
    T.push({ name: 'fountain', r: 6.3, h: 2.6, hx: 6, hy: 1.3, hz: 6, cull: 900, snd: 'impact', heavy: true,
      geo: mergeGeos([
        { geo: new THREE.CylinderGeometry(6.2, 6.4, 0.85, 32), color: '#a49e92', matrix: M4(0, 0.42, 0) },
        { geo: new THREE.CylinderGeometry(5.7, 5.7, 0.1, 32), color: '#3f6f84', matrix: M4(0, 0.82, 0) },
        { geo: new THREE.CylinderGeometry(0.55, 0.75, 2.4, 12), color: '#b9b2a4', matrix: M4(0, 1.2, 0) },
        { geo: new THREE.CylinderGeometry(1.8, 0.6, 0.45, 20), color: '#b9b2a4', matrix: M4(0, 2.5, 0) },
        { geo: new THREE.CylinderGeometry(1.6, 1.6, 0.06, 20), color: '#4f86a0', matrix: M4(0, 2.72, 0) },
      ]) });
    T.push({ name: 'monument', r: 2.2, h: 36, hx: 1.6, hy: 18, hz: 1.6, topple: true, cull: 2600, snd: 'impact', heavy: true,
      geo: mergeGeos([
        { geo: new THREE.BoxGeometry(7, 2, 7), color: '#9e978a', matrix: M4(0, 1, 0) },
        { geo: new THREE.BoxGeometry(3.2, 30, 3.2), color: '#d4ccbb', matrix: M4(0, 17, 0) },
        { geo: new THREE.ConeGeometry(2.3, 4, 4), color: '#d6a84e', matrix: M4(0, 34, 0, 0, Math.PI / 4, 0) },
      ]) });
    return T;
  }

  add(name, x, z, yaw, s) {
    this.list.push({ t: this.tIndex[name], x, z, yaw, s, state: 0, chunkMesh: null, idx: -1, heat: 0 });
  }

  /** 沿街道布置路灯、行道树、长椅、垃圾桶、消防栓、公交站、红绿灯 */
  placeStreets() {
    const c = this.city, N = c.N, rng = new RNG(CFG.seed + 7);
    const sw = CFG.city.sidewalk;
    for (let i = 0; i <= N; i++) {
      const L = c.L(i), w = c.W(i), avenue = i % CFG.city.avenueEvery === 0;
      for (let j = 0; j < N; j++) {
        const a0 = c.L(j) + c.W(j) / 2 + 5, a1 = c.L(j + 1) - c.W(j + 1) / 2 - 5;
        const midDist = Math.hypot(L, (a0 + a1) / 2) / c.half;
        const downtown = midDist < 0.3;
        for (const side of [-1, 1]) {
          const off = w / 2 - sw + 0.8;           // 靠路缘一侧
          const offT = w / 2 - sw + 1.9;          // 树稍靠里
          // 两个方向：沿 z 的道路（x = L）与沿 x 的道路（z = L）
          for (const axis of [0, 1]) {
            const place = (name, along, o, yaw, s = 1) => {
              if (axis === 0) this.add(name, L + side * o, along, yaw, s);
              else this.add(name, along, L + side * o, yaw, s);
            };
            // 灯臂朝向道路中心
            const lampYaw = axis === 0 ? (side > 0 ? Math.PI : 0) : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
            const start = side > 0 ? 6 : 26;
            for (let t = a0 + start; t < a1 - 3; t += 40) place('lamp', t, off, lampYaw);
            // 行道树：CBD 稀少，其余街道每隔约 24m 一棵
            if (downtown ? rng.chance(0.15) : rng.chance(0.85)) {
              for (let t = a0 + 14; t < a1 - 4; t += rng.range(21, 27)) {
                if (((t - a0 - start) % 40 + 40) % 40 < 5) continue;
                place('tree', t, offT, rng.range(0, 6.28), rng.range(0.85, 1.2));
              }
            }
            for (let t = a0 + 8; t < a1 - 6; t += 30) {
              const r = rng.next();
              if (r < 0.12) place('bench', t + 3, off + 1.4, lampYaw + Math.PI / 2);
              else if (r < 0.22) place('bin', t + 1.5, off - 0.2, 0);
              else if (r < 0.27) place('hydrant', t + 2, off - 0.3, 0);
            }
            if (avenue && side > 0 && rng.chance(0.35)) place('busstop', (a0 + a1) / 2, off + 1.2, lampYaw + Math.PI / 2);
          }
        }
      }
    }
    // 主干道路口的红绿灯（对角两个）
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      if (i % CFG.city.avenueEvery !== 0 && j % CFG.city.avenueEvery !== 0) continue;
      const x = c.L(i), z = c.L(j), wx = c.W(i) / 2 - 0.8, wz = c.W(j) / 2 - 0.8;
      this.add('tlight', x + wx, z + wz, Math.PI / 2, 1);   // 灯臂沿 -Z 伸出
      this.add('tlight', x - wx, z - wz, -Math.PI / 2, 1);
    }
  }

  /** 创建分区实例网格、动态网格与碰撞网格 */
  build() {
    const c = this.city;
    const half = c.half + 600;
    this.nch = Math.ceil((half * 2) / this.chunk);
    this.chMin = -half;
    this.mats = {
      std: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.15 }),
      tree: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 }),
    };
    this.mats.tree.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, SWAY_U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime; uniform vec3 uHeroPos; uniform float uHeroSpeed;')
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float swayW = smoothstep(2.5, 8.0, position.y) * (position.y / 8.0);
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = ip.x * 0.13 + ip.z * 0.17;
          vec2 wind = vec2(sin(uTime * 1.3 + ph), cos(uTime * 1.1 + ph * 1.3)) * 0.18;
          vec3 d = ip - uHeroPos;
          float dist = length(d.xz);
          float gust = min(uHeroSpeed * 0.02, 2.2) * (1.0 - smoothstep(6.0, 45.0, dist)) * (1.0 - smoothstep(10.0, 60.0, abs(d.y)));
          vec2 away = dist > 0.1 ? d.xz / dist : vec2(0.0);
          vec2 off = wind + away * gust * (0.75 + 0.25 * sin(uTime * 22.0 + ph * 5.0));
          mat3 im = mat3(instanceMatrix);
          float s2 = max(dot(im[0], im[0]), 1e-4);
          transformed += (transpose(im) * vec3(off.x, 0.0, off.y)) * swayW / s2;
        }
        #endif`);
    };
    this.mats.tree.customProgramCacheKey = () => 'zenith-tree';

    // 分区统计
    const buckets = new Map();
    this.list.forEach((p, k) => {
      const cx = U.clamp(Math.floor((p.x - this.chMin) / this.chunk), 0, this.nch - 1);
      const cz = U.clamp(Math.floor((p.z - this.chMin) / this.chunk), 0, this.nch - 1);
      const key = (p.t * 10000) + cz * 100 + cx;
      let bk = buckets.get(key);
      if (!bk) { bk = { t: p.t, cx, cz, items: [] }; buckets.set(key, bk); }
      bk.items.push(k);
    });
    this.chunkMeshes = [];
    const tint = [[1, 1, 1], [0.86, 1.02, 0.82], [1.12, 1.04, 0.78], [0.78, 0.92, 0.74], [1.0, 0.92, 0.7]];
    for (const bk of buckets.values()) {
      const T = this.types[bk.t];
      const mesh = new THREE.InstancedMesh(T.geo, T.sway ? this.mats.tree : this.mats.std, bk.items.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (T.sway) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(bk.items.length * 3), 3);
      bk.items.forEach((pi, k) => {
        const p = this.list[pi];
        p.chunkMesh = mesh; p.idx = k;
        writeYawMatrix(mesh.instanceMatrix.array, k, p.x, 0, p.z, p.yaw, p.s, p.s, p.s);
        if (T.sway) { const tt = tint[Math.floor(hash2(Math.floor(p.x), Math.floor(p.z)) * tint.length)]; mesh.instanceColor.setXYZ(k, tt[0], tt[1], tt[2]); }
      });
      const ccx = this.chMin + (bk.cx + 0.5) * this.chunk, ccz = this.chMin + (bk.cz + 0.5) * this.chunk;
      if (mesh.boundingSphere !== undefined) mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(ccx, T.h / 2, ccz), this.chunk * 0.75 + T.h + 30);
      else mesh.frustumCulled = false;
      mesh.castShadow = T.name !== 'hydrant' && T.name !== 'bin';
      mesh.receiveShadow = true;
      mesh.userData = { cx: ccx, cz: ccz, cull: T.cull + this.chunk * 0.75 };
      this.scene.add(mesh);
      this.chunkMeshes.push(mesh);
    }
    // 动态（被撞飞）实例：每种道具一个全局网格
    const cap = CFG.pools.dynProps;
    this.dynMeshes = this.types.map((T) => {
      const m = new THREE.InstancedMesh(T.geo, T.sway ? this.mats.tree : this.mats.std, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < cap; i++) writeZeroMatrix(m.instanceMatrix.array, i);
      if (T.sway) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      m.frustumCulled = false;
      m.castShadow = true;
      m.count = 0;
      m.userData.free = [];
      for (let i = cap - 1; i >= 0; i--) m.userData.free.push(i);
      m.userData.owners = new Array(cap);
      this.scene.add(m);
      return m;
    });
    // 碰撞网格
    const cell = c.cell;
    this.gridP = new Array(c.gn * c.gn);
    this.list.forEach((p, k) => {
      const cx = c._cellX(p.x), cz = c._cellX(p.z);
      const key = cz * c.gn + cx;
      (this.gridP[key] || (this.gridP[key] = [])).push(k);
    });
    this.cellSize = cell;
  }

  /** 查询矩形范围内仍然完好的道具 */
  query(x0, z0, x1, z1) {
    const c = this.city, out = this._out;
    out.length = 0;
    const c0 = c._cellX(x0 - 7), c1 = c._cellX(x1 + 7), r0 = c._cellX(z0 - 7), r1 = c._cellX(z1 + 7);
    for (let r = r0; r <= r1; r++) for (let cc = c0; cc <= c1; cc++) {
      const list = this.gridP[r * c.gn + cc];
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const p = this.list[list[k]];
        if (p.state === 0 && p.x >= x0 - 7 && p.x <= x1 + 7 && p.z >= z0 - 7 && p.z <= z1 + 7) out.push(p);
      }
    }
    return out;
  }

  /** 让道具倒下（以底部为支点旋转），dirX/dirZ 为倒下方向 */
  topple(p, dirX, dirZ, power) {
    if (p.state !== 0) return;
    p.state = 3;
    const l = Math.hypot(dirX, dirZ) || 1;
    this.topples.push({ p, ax: dirZ / l, az: -dirX / l, ang: 0, w: 0.8 + power * 2.5, done: false });
  }

  /** 把道具变为刚体并赋予速度（被撞飞） */
  launch(p, vx, vy, vz, spin) {
    if (p.state === 2) return null;
    const T = this.types[p.t];
    const dm = this.dynMeshes[p.t];
    const ud = dm.userData;
    let slot;
    if (ud.free.length) slot = ud.free.pop();
    else {
      // 回收最早的动态实例
      const old = this.dyn.find((d) => d.prop.t === p.t);
      if (!old) return null;
      slot = old.slot;
      writeZeroMatrix(dm.instanceMatrix.array, slot);
      this.dyn.splice(this.dyn.indexOf(old), 1);
    }
    // 隐藏原分区实例
    if (p.chunkMesh) {
      writeZeroMatrix(p.chunkMesh.instanceMatrix.array, p.idx);
      p.chunkMesh.instanceMatrix.needsUpdate = true;
    }
    const s = p.s;
    let q;
    if (p.state === 3) {
      const tp = this.topples.find((t) => t.p === p);
      q = this._toppleQuat(p, tp);
      if (tp) this.topples.splice(this.topples.indexOf(tp), 1);
    } else q = this._q.setFromAxisAngle(_bup, p.yaw).clone();
    p.state = 2;
    const off = this._v.set(0, T.hy * s, 0).applyQuaternion(q);
    const body = makeBody(p.x + off.x, off.y, p.z + off.z, q, T.hx * s, T.hy * s, T.hz * s);
    body.v.set(vx, vy, vz);
    body.w.set((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin);
    const d = { prop: p, slot, body, scale: s };
    this.dyn.push(d);
    dm.count = Math.max(dm.count, slot + 1);
    if (dm.instanceColor && p.chunkMesh && p.chunkMesh.instanceColor) {
      const ca = p.chunkMesh.instanceColor.array;
      dm.instanceColor.setXYZ(slot, ca[p.idx * 3], ca[p.idx * 3 + 1], ca[p.idx * 3 + 2]);
      dm.instanceColor.needsUpdate = true;
    }
    return d;
  }

  /** 直接销毁（喷泉等重型道具） */
  destroy(p) {
    if (p.state === 2) return;
    p.state = 2;
    if (p.chunkMesh) {
      writeZeroMatrix(p.chunkMesh.instanceMatrix.array, p.idx);
      p.chunkMesh.instanceMatrix.needsUpdate = true;
    }
  }

  _toppleQuat(p, tp) {
    const qy = this._q2.setFromAxisAngle(_bup, p.yaw);
    if (!tp) return qy.clone();
    this._ax.set(tp.ax, 0, tp.az);
    return new THREE.Quaternion().setFromAxisAngle(this._ax, tp.ang).multiply(qy);
  }

  update(dt, camera) {
    // 距离裁剪
    const cx = camera.position.x, cz = camera.position.z;
    const altBoost = Math.min(Math.max(0, camera.position.y) * 1.2, 450);
    for (const m of this.chunkMeshes) {
      const u = m.userData;
      const dx = u.cx - cx, dz = u.cz - cz;
      const lim = u.cull + altBoost;
      m.visible = dx * dx + dz * dz < lim * lim;
    }
    // 倒下动画
    for (let k = 0; k < this.topples.length; k++) {
      const tp = this.topples[k];
      const T = this.types[tp.p.t];
      const maxA = T.name === 'tree' ? 1.32 : 1.52;
      tp.w += (5.5 * Math.sin(tp.ang) + 0.8) * dt * (T.heavy ? 0.5 : 1);
      tp.ang += tp.w * dt;
      if (tp.ang >= maxA) {
        tp.ang = maxA;
        if (tp.w > 1.2) {
          tp.w = -tp.w * 0.22;
          if (G.destruction) G.destruction.toppleImpact(tp.p, T);
        } else tp.done = true;
      }
      const q = this._toppleQuat(tp.p, tp);
      const s = tp.p.s;
      writeTRS(tp.p.chunkMesh.instanceMatrix.array, tp.p.idx, tp.p.x, 0, tp.p.z, q.x, q.y, q.z, q.w, s, s, s);
      tp.p.chunkMesh.instanceMatrix.needsUpdate = true;
      if (tp.done) { tp.p.state = 4; this.topples.splice(k, 1); k--; }
    }
    // 刚体
    for (let k = 0; k < this.dyn.length; k++) {
      const d = this.dyn[k];
      const b = d.body;
      const moving = stepBody(b, dt);
      if (moving) bodyVsBuildings(b, this.city, G.destruction ? G.destruction.onBodyHitBuilding : null);
      const T = this.types[d.prop.t];
      const dm = this.dynMeshes[d.prop.t];
      const off = this._v.set(0, -T.hy * d.scale, 0).applyQuaternion(b.q);
      writeTRS(dm.instanceMatrix.array, d.slot, b.p.x + off.x, b.p.y + off.y, b.p.z + off.z, b.q.x, b.q.y, b.q.z, b.q.w, d.scale, d.scale, d.scale);
      dm.instanceMatrix.needsUpdate = true;
    }
  }
}

/* ===================================================================== */

class Traffic {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.cars = [];
    this.bodies = [];
    this._out = [];
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ'); this._v = new THREE.Vector3();
    this.models = [
      { name: 'sedan', hx: 2.25, hy: 0.8, hz: 0.95 },
      { name: 'suv', hx: 2.4, hy: 1.0, hz: 1.0 },
      { name: 'bus', hx: 5.8, hy: 1.55, hz: 1.3 },
    ];
  }

  _carGeo(k) {
    const dark = '#1b232b', tire = '#141414', lightF = '#fff1c4', lightR = '#9d1414';
    const wheels = (xs, r, z) => {
      const out = [];
      for (const x of xs) for (const s of [-1, 1]) out.push({ geo: new THREE.CylinderGeometry(r, r, 0.28, 8), color: tire, matrix: M4(x, r, s * z, Math.PI / 2, 0, 0) });
      return out;
    };
    if (k === 0) return mergeGeos([
      { geo: new THREE.BoxGeometry(4.5, 0.72, 1.86), color: '#ffffff', matrix: M4(0, 0.68, 0) },
      { geo: new THREE.BoxGeometry(2.4, 0.6, 1.66), color: dark, matrix: M4(-0.2, 1.34, 0) },
      { geo: new THREE.BoxGeometry(2.2, 0.06, 1.62), color: '#ffffff', matrix: M4(-0.2, 1.66, 0) },
      { geo: new THREE.BoxGeometry(0.08, 0.16, 1.5), color: lightF, matrix: M4(2.25, 0.82, 0) },
      { geo: new THREE.BoxGeometry(0.08, 0.16, 1.5), color: lightR, matrix: M4(-2.25, 0.86, 0) },
      ...wheels([-1.45, 1.45], 0.34, 0.86),
    ]);
    if (k === 1) return mergeGeos([
      { geo: new THREE.BoxGeometry(4.8, 0.95, 1.96), color: '#ffffff', matrix: M4(0, 0.86, 0) },
      { geo: new THREE.BoxGeometry(3.1, 0.72, 1.82), color: dark, matrix: M4(-0.35, 1.68, 0) },
      { geo: new THREE.BoxGeometry(3.0, 0.07, 1.8), color: '#ffffff', matrix: M4(-0.35, 2.06, 0) },
      { geo: new THREE.BoxGeometry(0.08, 0.2, 1.6), color: lightF, matrix: M4(2.4, 1.0, 0) },
      { geo: new THREE.BoxGeometry(0.08, 0.2, 1.6), color: lightR, matrix: M4(-2.4, 1.05, 0) },
      ...wheels([-1.55, 1.55], 0.4, 0.9),
    ]);
    return mergeGeos([
      { geo: new THREE.BoxGeometry(11.6, 2.5, 2.55), color: '#ffffff', matrix: M4(0, 1.65, 0) },
      { geo: new THREE.BoxGeometry(11.0, 0.95, 2.58), color: dark, matrix: M4(0.1, 2.15, 0) },
      { geo: new THREE.BoxGeometry(0.06, 1.3, 2.2), color: dark, matrix: M4(5.81, 2.0, 0) },
      { geo: new THREE.BoxGeometry(11.6, 0.1, 2.5), color: '#cfd3d6', matrix: M4(0, 2.95, 0) },
      ...wheels([-3.8, 3.6], 0.5, 1.15),
    ]);
  }

  generate() {
    const c = this.city, N = c.N, rng = new RNG(CFG.seed + 99);
    const half = c.half;
    const colors = ['#e9e9e6', '#1a1b1e', '#9a9ea3', '#5a5e63', '#1f3557', '#7d1c1c', '#e0b324', '#2c4a3a', '#c9bfa8', '#3a6ea8'];
    const busColors = ['#c43c2c', '#2f6db0', '#e0b324', '#3f8a52'];
    for (let i = 0; i <= N; i++) {
      const L = c.L(i), avenue = i % CFG.city.avenueEvery === 0;
      const offs = avenue ? [2.75, 6.25, 9.75] : [1.8, 5.4];
      for (const axis of [0, 1]) for (const dir of [1, -1]) {
        offs.forEach((o, li) => {
          const lane = { axis, dir, c: axis === 0 ? (dir > 0 ? L - o : L + o) : (dir > 0 ? L + o : L - o), speed: rng.range(10, 17) };
          const n = avenue ? (rng.chance(0.85) ? rng.int(1, 3) : 0) : (rng.chance(0.5) ? 1 : 0);
          for (let k = 0; k < n; k++) {
            const bus = avenue && li === offs.length - 1 && rng.chance(0.25);
            const m = bus ? 2 : rng.chance(0.3) ? 1 : 0;
            const col = bus ? rng.pick(busColors) : rng.chance(0.08) ? '#e8b51e' : rng.pick(colors);
            this.cars.push({ m, lane, along: rng.range(-half, half), mode: 0, color: new THREE.Color(col), x: 0, z: 0, yaw: 0, shake: 0, shakeT: rng.next() * 10, heat: 0 });
          }
        });
        // 路边停车
        const po = avenue ? 13.6 : 8.0;
        for (let j = 0; j < N; j++) {
          if (!rng.chance(0.075)) continue;
          const a0 = c.L(j) + c.W(j) / 2 + 8, a1 = c.L(j + 1) - c.W(j + 1) / 2 - 8;
          const n = rng.int(1, 2);
          for (let k = 0; k < n; k++) {
            const along = rng.range(a0, a1);
            const lane = { axis, dir, c: axis === 0 ? (dir > 0 ? L - po : L + po) : (dir > 0 ? L + po : L - po), speed: 0 };
            this.cars.push({ m: rng.chance(0.3) ? 1 : 0, lane, along, mode: 1, color: new THREE.Color(rng.pick(colors)), x: 0, z: 0, yaw: 0, shake: 0, shakeT: 0, heat: 0 });
          }
        }
      }
    }
  }

  build() {
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.45 });
    this.meshes = this.models.map((md, k) => {
      const list = this.cars.filter((c) => c.m === k);
      const mesh = new THREE.InstancedMesh(this._carGeo(k), mat, Math.max(1, list.length));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, list.length) * 3), 3);
      list.forEach((car, i) => {
        car.idx = i;
        mesh.instanceColor.setXYZ(i, car.color.r, car.color.g, car.color.b);
        this._place(car);
        writeYawMatrix(mesh.instanceMatrix.array, i, car.x, 0, car.z, car.yaw, 1, 1, 1);
      });
      mesh.count = list.length;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return mesh;
    });
  }

  _place(car) {
    const ln = car.lane;
    if (ln.axis === 0) { car.x = ln.c; car.z = car.along; car.yaw = ln.dir > 0 ? -Math.PI / 2 : Math.PI / 2; }
    else { car.x = car.along; car.z = ln.c; car.yaw = ln.dir > 0 ? 0 : Math.PI; }
  }

  /** 查询某点附近的车辆（mode 0/1 = 行驶 / 停放） */
  queryNear(x, z, r) {
    const out = this._out;
    out.length = 0;
    for (let k = 0; k < this.cars.length; k++) {
      const c = this.cars[k];
      if (c.mode > 1) continue;
      if (Math.abs(c.x - x) < r && Math.abs(c.z - z) < r) out.push(c);
    }
    return out;
  }

  /** 撞飞汽车 */
  launch(car, vx, vy, vz, spin) {
    if (car.mode >= 2) return null;
    const md = this.models[car.m];
    car.mode = 2;
    this._q.setFromAxisAngle(_bup, car.yaw);
    const b = makeBody(car.x, md.hy, car.z, this._q, md.hx, md.hy, md.hz);
    b.v.set(vx, vy, vz);
    b.w.set((Math.random() - 0.5) * spin, (Math.random() - 0.5) * spin * 0.6, (Math.random() - 0.5) * spin);
    car.body = b;
    this.bodies.push(car);
    return b;
  }

  /** 汽车被烧毁 / 爆炸后变黑 */
  burn(car) {
    const mesh = this.meshes[car.m];
    mesh.instanceColor.setXYZ(car.idx, 0.05, 0.045, 0.04);
    mesh.instanceColor.needsUpdate = true;
    car.burnt = true;
  }

  update(dt, camera) {
    const half = this.city.half;
    const arrs = this.meshes.map((m) => m.instanceMatrix.array);
    const camx = camera.position.x, camz = camera.position.z;
    for (let k = 0; k < this.cars.length; k++) {
      const car = this.cars[k];
      if (car.mode >= 2) continue;
      if (car.mode === 0) {
        car.along += car.lane.speed * car.lane.dir * dt;
        if (car.along > half) car.along -= half * 2;
        else if (car.along < -half) car.along += half * 2;
        this._place(car);
      } else if (car.shake <= 0.001) {
        // 停放车辆：只有晃动结束时写回一次正常姿态
        if (!car.wob) continue;
        car.wob = false;
        writeYawMatrix(arrs[car.m], car.idx, car.x, 0, car.z, car.yaw, 1, 1, 1);
        continue;
      }
      if (car.shake > 0.001) {
        car.wob = true;
        car.shake *= Math.exp(-3.2 * dt);
        car.shakeT += dt;
        const sx = Math.sin(car.shakeT * 21) * car.shake * 0.09, sz = Math.cos(car.shakeT * 17) * car.shake * 0.06;
        this._e.set(sx, car.yaw, sz, 'YXZ');
        this._q.setFromEuler(this._e);
        writeTRS(arrs[car.m], car.idx, car.x, Math.abs(sx) * 0.6, car.z, this._q.x, this._q.y, this._q.z, this._q.w, 1, 1, 1);
      } else {
        writeYawMatrix(arrs[car.m], car.idx, car.x, 0, car.z, car.yaw, 1, 1, 1);
      }
    }
    for (let k = 0; k < this.bodies.length; k++) {
      const car = this.bodies[k];
      const b = car.body;
      const moving = stepBody(b, dt);
      if (moving) bodyVsBuildings(b, this.city, G.destruction ? G.destruction.onBodyHitBuilding : null);
      const md = this.models[car.m];
      const off = this._v.set(0, -md.hy, 0).applyQuaternion(b.q);
      car.x = b.p.x; car.z = b.p.z;
      writeTRS(arrs[car.m], car.idx, b.p.x + off.x, b.p.y + off.y, b.p.z + off.z, b.q.x, b.q.y, b.q.z, b.q.w, 1, 1, 1);
      if (b.rest) { car.mode = 3; this.bodies.splice(k, 1); k--; }
    }
    for (const m of this.meshes) m.instanceMatrix.needsUpdate = true;
  }
}

/** 小工具：返回 () => [0,1) 的确定性随机函数 */
function mulberry(seed) { const r = new RNG(seed); return () => r.next(); }
