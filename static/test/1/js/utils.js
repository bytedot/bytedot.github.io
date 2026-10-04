'use strict';
/* =====================================================================
 * utils.js — 数学工具、随机数、噪声、几何合并、碰撞检测、实例矩阵写入
 * ===================================================================== */

const U = {
  clamp(x, a, b) { return x < a ? a : x > b ? b : x; },
  lerp(a, b, t) { return a + (b - a) * t; },
  invLerp(a, b, x) { return U.clamp((x - a) / (b - a), 0, 1); },
  /** 平滑阶跃 */
  smooth(a, b, x) { const t = U.invLerp(a, b, x); return t * t * (3 - 2 * t); },
  /** 与帧率无关的指数阻尼插值 */
  damp(a, b, lambda, dt) { return a + (b - a) * (1 - Math.exp(-lambda * dt)); },
  wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  },
  dampAngle(a, b, lambda, dt) { return a + U.wrapAngle(b - a) * (1 - Math.exp(-lambda * dt)); },
  moveToward(a, b, maxDelta) {
    if (Math.abs(b - a) <= maxDelta) return b;
    return a + Math.sign(b - a) * maxDelta;
  },
  rand(a, b) { return a + (b - a) * Math.random(); },
  randSign() { return Math.random() < 0.5 ? -1 : 1; },
};

/** 可复现的伪随机数（mulberry32），用于城市生成 */
class RNG {
  constructor(seed) { this.s = seed >>> 0; }
  next() {
    let t = (this.s += 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this.next()); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p) { return this.next() < p; }
}

/** 整数哈希 → [0,1) */
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 一维值噪声（用于镜头抖动等） */
function noise1(x, seed = 0) {
  const i = Math.floor(x), f = x - i;
  const a = hash2(i, seed), b = hash2(i + 1, seed);
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** 二维值噪声 */
function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** 生成变换矩阵（位置 / 欧拉角 / 缩放） */
const _mq = new THREE.Quaternion(), _me = new THREE.Euler(), _mp = new THREE.Vector3(), _ms = new THREE.Vector3();
function M4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _me.set(rx, ry, rz);
  _mq.setFromEuler(_me);
  return new THREE.Matrix4().compose(_mp.set(x, y, z), _mq, _ms.set(sx, sy, sz));
}

/**
 * 把多个几何体合并为一个带顶点色的非索引几何体。
 * parts: [{ geo, color, matrix? }]
 * 这样一个道具（例如路灯 = 灯杆 + 灯臂 + 灯头）只需要一个 InstancedMesh、一次绘制调用。
 */
function mergeGeos(parts) {
  let total = 0;
  const prepared = [];
  for (const p of parts) {
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    if (p.matrix) g.applyMatrix4(p.matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    prepared.push({ g, c: new THREE.Color(p.color) });
    total += g.attributes.position.count;
    p.geo.dispose();
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, c } of prepared) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < n; i++) {
      col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b;
    }
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** 给几何体顶点加随机扰动（碎石、云朵等不规则形状） */
function jitterGeo(geo, amount, rng = Math.random) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position;
  // 同一位置的顶点必须得到相同扰动，否则会裂开
  const map = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
    let d = map.get(key);
    if (!d) { d = [(rng() - 0.5) * amount, (rng() - 0.5) * amount, (rng() - 0.5) * amount]; map.set(key, d); }
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  // 径向法线：让不规则的团块（树冠、碎石堆）有柔和的明暗过渡
  const n = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), l = Math.hypot(x, y, z) || 1;
    n[i * 3] = x / l; n[i * 3 + 1] = y / l; n[i * 3 + 2] = z / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  return g;
}

/**
 * 线段与轴对齐包围盒求交（slab 算法）。
 * 起点 a，位移 d（终点 = a + d）。命中时 out.t ∈ [0,1]，out.axis(0/1/2)，out.sign(面法线方向 ±1)。
 * 起点已经在盒子内部时返回 false（由调用方单独处理"在建筑内部"的情况）。
 */
function segAABB(ax, ay, az, dx, dy, dz, x0, y0, z0, x1, y1, z1, out) {
  let tmin = 0, tmax = 1, axis = -1, sign = 0;
  if (Math.abs(dx) < 1e-9) { if (ax < x0 || ax > x1) return false; }
  else {
    const inv = 1 / dx;
    let t1 = (x0 - ax) * inv, t2 = (x1 - ax) * inv, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-9) { if (ay < y0 || ay > y1) return false; }
  else {
    const inv = 1 / dy;
    let t1 = (y0 - ay) * inv, t2 = (y1 - ay) * inv, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) { if (az < z0 || az > z1) return false; }
  else {
    const inv = 1 / dz;
    let t1 = (z0 - az) * inv, t2 = (z1 - az) * inv, s = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (axis < 0) return false;
  out.t = tmin; out.axis = axis; out.sign = sign;
  return true;
}

/** 点到线段的距离 */
function distPointSeg(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const ll = abx * abx + aby * aby + abz * abz;
  let t = ll > 1e-8 ? (apx * abx + apy * aby + apz * abz) / ll : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t - px, cy = ay + aby * t - py, cz = az + abz * t - pz;
  return Math.sqrt(cx * cx + cy * cy + cz * cz);
}

/** 线段上离点最近处的参数 t */
function segClosestT(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const ll = abx * abx + aby * aby + abz * abz;
  if (ll < 1e-8) return 0;
  const t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ll;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 直接写入实例矩阵数组：位置 + 绕 Y 轴旋转 + 缩放（比 Object3D 快很多） */
function writeYawMatrix(arr, i, x, y, z, yaw, sx, sy, sz) {
  const o = i * 16, c = Math.cos(yaw), s = Math.sin(yaw);
  arr[o] = c * sx; arr[o + 1] = 0; arr[o + 2] = -s * sx; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = s * sz; arr[o + 9] = 0; arr[o + 10] = c * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

/** 写入完整 TRS 矩阵（四元数旋转） */
function writeTRS(arr, i, x, y, z, qx, qy, qz, qw, sx, sy, sz) {
  const o = i * 16;
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  arr[o] = (1 - (yy + zz)) * sx; arr[o + 1] = (xy + wz) * sx; arr[o + 2] = (xz - wy) * sx; arr[o + 3] = 0;
  arr[o + 4] = (xy - wz) * sy; arr[o + 5] = (1 - (xx + zz)) * sy; arr[o + 6] = (yz + wx) * sy; arr[o + 7] = 0;
  arr[o + 8] = (xz + wy) * sz; arr[o + 9] = (yz - wx) * sz; arr[o + 10] = (1 - (xx + yy)) * sz; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z; arr[o + 15] = 1;
}

/** 把实例缩放为 0（隐藏） */
function writeZeroMatrix(arr, i) { arr.fill(0, i * 16, i * 16 + 16); }

/** 球坐标方向（偏航 yaw、俯仰 pitch）→ 单位向量。yaw=0 指向 -Z */
function dirFromYawPitch(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** 在单位向量 a 朝 b 方向旋转最多 maxAngle（弧度），结果写入 a */
const _rtAxis = new THREE.Vector3(), _rtQ = new THREE.Quaternion();
function rotateToward(a, b, maxAngle) {
  const d = U.clamp(a.dot(b), -1, 1);
  const ang = Math.acos(d);
  if (ang <= maxAngle || ang < 1e-5) { a.copy(b); return; }
  _rtAxis.crossVectors(a, b);
  if (_rtAxis.lengthSq() < 1e-10) {
    // 反向：任选一个垂直轴
    _rtAxis.set(0, 1, 0).cross(a);
    if (_rtAxis.lengthSq() < 1e-6) _rtAxis.set(1, 0, 0);
  }
  _rtAxis.normalize();
  _rtQ.setFromAxisAngle(_rtAxis, maxAngle);
  a.applyQuaternion(_rtQ).normalize();
}

/** 生成柔和圆形贴图（粒子、光晕等） */
function makeRadialTexture(size, stops) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
