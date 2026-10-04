'use strict';
/* =====================================================================
 * particles.js — 粒子与碎片（全部使用对象池 + 实例化渲染）
 *  - Particles : 面向相机的公告板粒子（烟尘、火焰、火花、蒸汽），一个系统 = 一次绘制调用
 *  - Debris    : 带简单刚体物理的碎块 / 玻璃碎片（InstancedMesh），到时自动缩小消失
 *  - ShockFX   : 冲击波圆环与球形激波
 * ===================================================================== */

/** 所有自定义着色器共享的雾参数（每帧从 scene.fog 同步） */
const FOG_U = {
  uFogColor: { value: new THREE.Color() },
  uFogNear: { value: 100 },
  uFogFar: { value: 3000 },
};

function syncFogUniforms(fog) {
  FOG_U.uFogColor.value.copy(fog.color);
  FOG_U.uFogNear.value = fog.near;
  FOG_U.uFogFar.value = fog.far;
}

/** 程序化烟团贴图：多个柔和圆斑叠加 */
function makePuffTexture() {
  const S = 128, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const rng = new RNG(31);
  for (let i = 0; i < 22; i++) {
    const r = rng.range(14, 34);
    const a = rng.range(0, Math.PI * 2), d = rng.range(0, 26);
    const x = S / 2 + Math.cos(a) * d, y = S / 2 + Math.sin(a) * d;
    const v = Math.floor(rng.range(170, 255));
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(${v},${v},${v},0.42)`);
    gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  }
  // 整体圆形衰减，保证边缘完全透明
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
  m.addColorStop(0, 'rgba(0,0,0,1)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m;
  g.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

const PARTICLE_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec4 iParams;   // x 尺寸, y 旋转, z 透明度
attribute vec3 iColor;
attribute vec3 iVel;
uniform float uStretch;
uniform float uFogNear, uFogFar;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
void main() {
  vUv = uv;
  vColor = iColor;
  vAlpha = iParams.z;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float size = iParams.x;
  // 相机钻进烟团时淡出并整块裁掉，避免全屏大面积重复绘制
  float nearFade = smoothstep(size * 0.12, size * 0.55, -mv.z);
  vAlpha *= nearFade;
  if (nearFade < 0.01) { vUv = vec2(0.0); vColor = vec3(0.0); vFog = 0.0; gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  vec2 corner = position.xy;
  vec2 off;
  if (uStretch > 0.0) {
    // 沿速度方向拉伸（火花、流光）
    vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
    float sp = length(vv.xy);
    vec2 dir = sp > 1e-4 ? vv.xy / sp : vec2(0.0, 1.0);
    vec2 perp = vec2(-dir.y, dir.x);
    float len = 1.0 + sp * uStretch / max(size, 0.02);
    off = (dir * corner.y * len + perp * corner.x) * size;
  } else {
    float c = cos(iParams.y), s = sin(iParams.y);
    off = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size;
  }
  mv.xy += off;
  vFog = smoothstep(uFogNear, uFogFar, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uTex;
uniform vec3 uFogColor;
uniform float uAdditive;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float a = t.a * vAlpha;
  if (a < 0.003) discard;
  vec3 col = vColor * (0.55 + 0.6 * t.r);
  if (uAdditive > 0.5) {
    gl_FragColor = vec4(col, a * (1.0 - vFog));
  } else {
    col = mix(col, uFogColor, vFog);
    gl_FragColor = vec4(col, a);
  }
}`;

class Particles {
  /**
   * @param {object} o { max, additive, texture, stretch, sort, renderOrder }
   */
  constructor(scene, o) {
    const max = this.max = o.max;
    this.count = 0;
    this.sort = !!o.sort;
    const F = (n = 1) => new Float32Array(max * n);
    this.p = F(3); this.v = F(3);
    this.age = F(); this.life = F();
    this.s0 = F(); this.s1 = F();
    this.rot = F(); this.rotV = F();
    this.col = F(3); this.a0 = F();
    this.drag = F(); this.grav = F();
    this.order = new Uint32Array(max);
    this.depth = new Float32Array(max);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = this.geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aPar = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    for (const a of [this.aPos, this.aPar, this.aCol, this.aVel]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iParams', this.aPar);
    geo.setAttribute('iColor', this.aCol);
    geo.setAttribute('iVel', this.aVel);
    geo.instanceCount = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({
        uTex: { value: o.texture },
        uStretch: { value: o.stretch || 0 },
        uAdditive: { value: o.additive ? 1 : 0 },
      }, FOG_U),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = o.renderOrder || 5;
    scene.add(this.mesh);
  }

  /** 发射一个粒子。颜色为线性空间，可超过 1（配合色调映射产生高亮） */
  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, drag = 0, grav = 0, rotV = 0) {
    let i;
    if (this.count < this.max) i = this.count++;
    else i = Math.floor(Math.random() * this.max);   // 池满：随机覆盖
    const i3 = i * 3;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.col[i3] = r; this.col[i3 + 1] = g; this.col[i3 + 2] = b;
    this.age[i] = 0; this.life[i] = life;
    this.s0[i] = s0; this.s1[i] = s1;
    this.rot[i] = Math.random() * 6.283; this.rotV[i] = rotV;
    this.a0[i] = a; this.drag[i] = drag; this.grav[i] = grav;
  }

  _kill(i) {
    const j = --this.count;
    if (i === j) return;
    const i3 = i * 3, j3 = j * 3;
    for (let k = 0; k < 3; k++) { this.p[i3 + k] = this.p[j3 + k]; this.v[i3 + k] = this.v[j3 + k]; this.col[i3 + k] = this.col[j3 + k]; }
    this.age[i] = this.age[j]; this.life[i] = this.life[j];
    this.s0[i] = this.s0[j]; this.s1[i] = this.s1[j];
    this.rot[i] = this.rot[j]; this.rotV[i] = this.rotV[j];
    this.a0[i] = this.a0[j]; this.drag[i] = this.drag[j]; this.grav[i] = this.grav[j];
  }

  update(dt, camera) {
    const p = this.p, v = this.v;
    for (let i = 0; i < this.count; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this._kill(i); i--; continue; }
      const i3 = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      v[i3] *= dr; v[i3 + 1] = v[i3 + 1] * dr - this.grav[i] * dt; v[i3 + 2] *= dr;
      p[i3] += v[i3] * dt; p[i3 + 1] += v[i3 + 1] * dt; p[i3 + 2] += v[i3 + 2] * dt;
      if (p[i3 + 1] < 0.2) { p[i3 + 1] = 0.2; v[i3 + 1] = Math.abs(v[i3 + 1]) * 0.2; }
      this.rot[i] += this.rotV[i] * dt;
    }
    const n = this.count;
    const order = this.order;
    for (let i = 0; i < n; i++) order[i] = i;
    if (this.sort && n > 1) {
      // 由远及近排序，保证半透明烟尘的叠加顺序正确
      const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
      const dep = this.depth;
      for (let i = 0; i < n; i++) {
        const dx = p[i * 3] - cx, dy = p[i * 3 + 1] - cy, dz = p[i * 3 + 2] - cz;
        dep[i] = dx * dx + dy * dy + dz * dz;
      }
      const sub = order.subarray(0, n);
      sub.sort((a, b) => dep[b] - dep[a]);
    }
    const ap = this.aPos.array, apr = this.aPar.array, ac = this.aCol.array, av = this.aVel.array;
    for (let k = 0; k < n; k++) {
      const i = order[k], i3 = i * 3, k3 = k * 3, k4 = k * 4;
      const t = this.age[i] / this.life[i];
      const grow = 1 - (1 - t) * (1 - t);
      const fadeIn = Math.min(1, this.age[i] / 0.06);
      ap[k3] = p[i3]; ap[k3 + 1] = p[i3 + 1]; ap[k3 + 2] = p[i3 + 2];
      av[k3] = v[i3]; av[k3 + 1] = v[i3 + 1]; av[k3 + 2] = v[i3 + 2];
      ac[k3] = this.col[i3]; ac[k3 + 1] = this.col[i3 + 1]; ac[k3 + 2] = this.col[i3 + 2];
      apr[k4] = this.s0[i] + (this.s1[i] - this.s0[i]) * grow;
      apr[k4 + 1] = this.rot[i];
      apr[k4 + 2] = this.a0[i] * fadeIn * Math.pow(1 - t, 1.3);
    }
    this.geo.instanceCount = n;
    if (n > 0) {
      for (const a of [this.aPos, this.aPar, this.aCol, this.aVel]) {
        a.needsUpdate = true;
        if (a.addUpdateRange) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); }
        else a.updateRange = { offset: 0, count: n * a.itemSize };
      }
    }
  }
}

/* ===================================================================== */

/** 带物理的碎块（混凝土 / 玻璃 / 汽车残片） */
class Debris {
  constructor(scene, max, geo, mat, castShadow) {
    this.max = max;
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = !!castShadow;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const m = this.mesh.instanceMatrix.array;
    for (let i = 0; i < max; i++) writeZeroMatrix(m, i);
    scene.add(this.mesh);
    const F = (n = 1) => new Float32Array(max * n);
    this.p = F(3); this.v = F(3); this.q = F(4); this.w = F(3); this.s = F(3);
    this.age = F(); this.life = F(); this.rest = new Uint8Array(max);
    this.active = [];
    this.free = [];
    for (let i = max - 1; i >= 0; i--) this.free.push(i);
    this.colorDirty = false;
  }

  spawn(x, y, z, vx, vy, vz, size, r, g, b, life = 6, spin = 8) {
    let i;
    if (this.free.length) i = this.free.pop();
    else { i = this.active.shift(); }   // 池满：回收最旧的
    this.active.push(i);
    const i3 = i * 3, i4 = i * 4;
    this.p[i3] = x; this.p[i3 + 1] = y; this.p[i3 + 2] = z;
    this.v[i3] = vx; this.v[i3 + 1] = vy; this.v[i3 + 2] = vz;
    this.w[i3] = (Math.random() - 0.5) * spin; this.w[i3 + 1] = (Math.random() - 0.5) * spin; this.w[i3 + 2] = (Math.random() - 0.5) * spin;
    const qa = Math.random() * 6.283, qb = Math.random() * 6.283;
    this.q[i4] = Math.sin(qa) * Math.cos(qb) * 0.7; this.q[i4 + 1] = Math.sin(qa) * Math.sin(qb) * 0.7;
    this.q[i4 + 2] = Math.cos(qa) * 0.7; this.q[i4 + 3] = 0.714;
    this.s[i3] = size * (0.6 + Math.random() * 0.8);
    this.s[i3 + 1] = size * (0.4 + Math.random() * 0.6);
    this.s[i3 + 2] = size * (0.6 + Math.random() * 0.8);
    this.age[i] = 0; this.life[i] = life * (0.7 + Math.random() * 0.6);
    this.rest[i] = 0;
    const c = this.mesh.instanceColor.array;
    c[i3] = r; c[i3 + 1] = g; c[i3 + 2] = b;
    this.colorDirty = true;
    return i;
  }

  update(dt, gravity = 15) {
    const m = this.mesh.instanceMatrix.array;
    const camP = G.camera ? G.camera.position : null;
    for (let k = 0; k < this.active.length; k++) {
      const i = this.active[k];
      const i3 = i * 3, i4 = i * 4;
      this.age[i] += dt;
      // 远处碎片更快消失
      if (camP) {
        const dx = this.p[i3] - camP.x, dz = this.p[i3 + 2] - camP.z;
        if (dx * dx + dz * dz > 600 * 600) this.age[i] += dt * 3;
      }
      const life = this.life[i];
      if (this.age[i] >= life) {
        writeZeroMatrix(m, i);
        this.active.splice(k, 1); k--;
        this.free.push(i);
        continue;
      }
      if (!this.rest[i]) {
        this.v[i3 + 1] -= gravity * dt;
        const dr = Math.exp(-0.15 * dt);
        this.v[i3] *= dr; this.v[i3 + 2] *= dr;
        this.p[i3] += this.v[i3] * dt; this.p[i3 + 1] += this.v[i3 + 1] * dt; this.p[i3 + 2] += this.v[i3 + 2] * dt;
        const floor = this.s[i3 + 1] * 0.45;
        if (this.p[i3 + 1] < floor) {
          this.p[i3 + 1] = floor;
          if (this.v[i3 + 1] < -2) {
            this.v[i3 + 1] = -this.v[i3 + 1] * 0.28;
            this.v[i3] *= 0.6; this.v[i3 + 2] *= 0.6;
            this.w[i3] *= 0.6; this.w[i3 + 1] *= 0.6; this.w[i3 + 2] *= 0.6;
          } else {
            this.v[i3 + 1] = 0; this.v[i3] *= 0.8; this.v[i3 + 2] *= 0.8;
            this.w[i3] *= 0.8; this.w[i3 + 1] *= 0.8; this.w[i3 + 2] *= 0.8;
            if (this.v[i3] * this.v[i3] + this.v[i3 + 2] * this.v[i3 + 2] < 0.3) this.rest[i] = 1;
          }
        }
        // 四元数积分
        const wx = this.w[i3], wy = this.w[i3 + 1], wz = this.w[i3 + 2];
        let qx = this.q[i4], qy = this.q[i4 + 1], qz = this.q[i4 + 2], qw = this.q[i4 + 3];
        const h = 0.5 * dt;
        const nx = qx + h * (wx * qw + wy * qz - wz * qy);
        const ny = qy + h * (wy * qw + wz * qx - wx * qz);
        const nz = qz + h * (wz * qw + wx * qy - wy * qx);
        const nw = qw + h * (-wx * qx - wy * qy - wz * qz);
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        this.q[i4] = nx * inv; this.q[i4 + 1] = ny * inv; this.q[i4 + 2] = nz * inv; this.q[i4 + 3] = nw * inv;
      }
      const shrink = U.clamp((life - this.age[i]) / 0.8, 0, 1);
      writeTRS(m, i, this.p[i3], this.p[i3 + 1], this.p[i3 + 2],
        this.q[i4], this.q[i4 + 1], this.q[i4 + 2], this.q[i4 + 3],
        this.s[i3] * shrink, this.s[i3 + 1] * shrink, this.s[i3 + 2] * shrink);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.colorDirty) { this.mesh.instanceColor.needsUpdate = true; this.colorDirty = false; }
  }
}

/* ===================================================================== */

/** 冲击波：扁平圆环（地面 / 墙面 / 音爆蒸汽环）与透明球形激波 */
class ShockFX {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
    const ringGeo = new THREE.CircleGeometry(1, 72);
    const sphereGeo = new THREE.SphereGeometry(1, 40, 20);
    const ringVert = /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
    const ringFrag = /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; uniform float uInner;
      varying vec2 vUv;
      void main() {
        float r = length(vUv * 2.0 - 1.0);
        float a = smoothstep(uInner, 0.94, r) * (1.0 - smoothstep(0.94, 1.0, r));
        a = pow(a, 1.6) * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`;
    const sphVert = /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`;
    const sphFrag = /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float a = pow(f, 3.0) * uOpacity;
        if (a < 0.003) discard;
        gl_FragColor = vec4(uColor, a);
      }`;
    for (let i = 0; i < 28; i++) {
      const isSphere = i >= 20;
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color(1, 1, 1) }, uOpacity: { value: 0 }, uInner: { value: 0.6 } },
        vertexShader: isSphere ? sphVert : ringVert,
        fragmentShader: isSphere ? sphFrag : ringFrag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(isSphere ? sphereGeo : ringGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 6;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.items.push({ mesh, mat, sphere: isSphere, active: false, t: 0, dur: 1, r0: 0, r1: 1, op: 1 });
    }
    this._z = new THREE.Vector3(0, 0, 1);
  }

  _get(sphere) {
    let oldest = null;
    for (const it of this.items) {
      if (it.sphere !== sphere) continue;
      if (!it.active) return it;
      if (!oldest || it.t / it.dur > oldest.t / oldest.dur) oldest = it;
    }
    return oldest;
  }

  /** 圆环：pos 位置，normal 朝向，r0→r1 扩张 */
  ring(pos, normal, r0, r1, dur, opacity, color = 0xffffff, additive = false, inner = 0.6) {
    const it = this._get(false);
    it.active = true; it.t = 0; it.dur = dur; it.r0 = r0; it.r1 = r1; it.op = opacity;
    it.mesh.position.copy(pos);
    it.mesh.quaternion.setFromUnitVectors(this._z, normal);
    it.mat.uniforms.uColor.value.set(color);
    it.mat.uniforms.uInner.value = inner;
    it.mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    it.mesh.visible = true;
    it.mesh.scale.setScalar(r0);
  }

  /** 球形激波 */
  sphere(pos, r0, r1, dur, opacity, color = 0xffffff) {
    const it = this._get(true);
    it.active = true; it.t = 0; it.dur = dur; it.r0 = r0; it.r1 = r1; it.op = opacity;
    it.mesh.position.copy(pos);
    it.mat.uniforms.uColor.value.set(color);
    it.mat.blending = THREE.AdditiveBlending;
    it.mesh.visible = true;
    it.mesh.scale.setScalar(r0);
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt;
      const k = it.t / it.dur;
      if (k >= 1) { it.active = false; it.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 3);
      it.mesh.scale.setScalar(it.r0 + (it.r1 - it.r0) * e);
      it.mat.uniforms.uOpacity.value = it.op * Math.pow(1 - k, 1.5);
    }
  }
}
