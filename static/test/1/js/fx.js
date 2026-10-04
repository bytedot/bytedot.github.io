'use strict';
/* =====================================================================
 * fx.js — 飞行特效
 *  - TrailRibbon  : 高速 / 极速时身后的云雾拖尾（面向相机的条带）
 *  - SpeedStreaks : 3D 空间中的速度线（静止在世界中的"气流粒子"，被拉伸成线）
 *  - VaporCone    : 突破音障时包裹角色的蒸汽锥
 *  - EyeBeams     : 目光射线
 * ===================================================================== */

class TrailRibbon {
  constructor(scene, maxPts = 90) {
    this.max = maxPts;
    this.pts = [];
    this.life = 1.6;
    const nv = maxPts * 2;
    const geo = this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(nv * 3);
    this.alpha = new Float32Array(nv);
    this.side = new Float32Array(nv);
    for (let i = 0; i < maxPts; i++) { this.side[i * 2] = -1; this.side[i * 2 + 1] = 1; }
    const idx = [];
    for (let i = 0; i < maxPts - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSide', new THREE.BufferAttribute(this.side, 1));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({ uColor: { value: new THREE.Color(0.95, 0.97, 1.0) } }, FOG_U),
      vertexShader: /* glsl */`
        attribute float aAlpha; attribute float aSide;
        uniform float uFogNear, uFogFar;
        varying float vA; varying float vS; varying float vFog;
        void main() {
          vA = aAlpha; vS = aSide;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFog = smoothstep(uFogNear, uFogFar, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform vec3 uFogColor;
        varying float vA; varying float vS; varying float vFog;
        void main() {
          float e = 1.0 - vS * vS;
          float a = vA * e * e;
          if (a < 0.003) discard;
          gl_FragColor = vec4(mix(uColor, uFogColor, vFog), a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
    this._t = new THREE.Vector3(); this._c = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  /** 每帧推入当前点；intensity=0 时不再产生新拖尾 */
  push(p, intensity, now) {
    const last = this.pts[this.pts.length - 1];
    if (intensity <= 0.01) return;
    if (last && last.p.distanceToSquared(p) < 1.0 && now - last.t < 0.05) { last.p.copy(p); return; }
    if (this.pts.length >= this.max) this.pts.shift();
    this.pts.push({ p: p.clone(), t: now, w: intensity });
  }

  update(now, camera) {
    while (this.pts.length && now - this.pts[0].t > this.life) this.pts.shift();
    const n = this.pts.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    for (let i = 0; i < n; i++) {
      const pt = this.pts[i];
      const a = this.pts[Math.max(0, i - 1)].p, b = this.pts[Math.min(n - 1, i + 1)].p;
      this._t.subVectors(b, a);
      this._c.subVectors(camera.position, pt.p);
      this._s.crossVectors(this._t, this._c);
      const l = this._s.length();
      if (l > 1e-6) this._s.multiplyScalar(1 / l); else this._s.set(0, 1, 0);
      const age = (now - pt.t) / this.life;
      const w = 0.5 + age * 6.5;
      const head = U.clamp((n - 1 - i) / 4, 0, 1);  // 靠近角色处逐渐出现
      const al = pt.w * Math.pow(1 - age, 1.6) * 0.55 * head;
      const o = i * 6;
      this.pos[o] = pt.p.x - this._s.x * w; this.pos[o + 1] = pt.p.y - this._s.y * w; this.pos[o + 2] = pt.p.z - this._s.z * w;
      this.pos[o + 3] = pt.p.x + this._s.x * w; this.pos[o + 4] = pt.p.y + this._s.y * w; this.pos[o + 5] = pt.p.z + this._s.z * w;
      this.alpha[i * 2] = al; this.alpha[i * 2 + 1] = al;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    this.geo.setDrawRange(0, (n - 1) * 6);
  }
}

/* ===================================================================== */

class SpeedStreaks {
  constructor(scene, n = 200) {
    this.n = n;
    this.p = new Float32Array(n * 3);
    const base = new THREE.PlaneGeometry(1, 1);
    const geo = this.geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) seed[i] = Math.random();
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 1));
    geo.instanceCount = n;
    this.uniforms = {
      uDir: { value: new THREE.Vector3(0, 0, -1) },
      uLen: { value: 10 },
      uWidth: { value: 0.07 },
      uAlpha: { value: 0 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute float iSeed;
        uniform vec3 uDir; uniform float uLen; uniform float uWidth; uniform float uAlpha;
        varying float vA; varying float vL;
        void main() {
          vec3 toCam = normalize(cameraPosition - iPos);
          vec3 side = normalize(cross(uDir, toCam) + vec3(1e-5));
          float len = uLen * (0.5 + iSeed);
          vec3 wp = iPos + uDir * position.y * len + side * position.x * uWidth * (0.6 + iSeed);
          float d = distance(iPos, cameraPosition);
          vA = uAlpha * smoothstep(4.0, 14.0, d) * (1.0 - smoothstep(120.0, 200.0, d)) * (0.4 + 0.6 * iSeed);
          vL = position.y + 0.5;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */`
        varying float vA; varying float vL;
        void main() {
          float a = vA * smoothstep(0.0, 0.7, vL) * (1.0 - smoothstep(0.85, 1.0, vL));
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(0.9, 0.95, 1.0) * 1.4, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
    scene.add(this.mesh);
    this.inited = false;
    this._d = new THREE.Vector3(); this._a = new THREE.Vector3(); this._b = new THREE.Vector3();
  }

  _spawn(i, cam, dir, near) {
    // 在飞行方向前方随机位置生成一个"空气粒子"
    const d = this._d.copy(dir);
    this._a.set(0, 1, 0);
    if (Math.abs(d.y) > 0.9) this._a.set(1, 0, 0);
    this._a.cross(d).normalize();
    this._b.crossVectors(d, this._a);
    const ahead = near ? U.rand(8, 200) : U.rand(90, 210);
    const ang = Math.random() * Math.PI * 2, rad = U.rand(4, 42);
    const i3 = i * 3;
    this.p[i3] = cam.x + d.x * ahead + (this._a.x * Math.cos(ang) + this._b.x * Math.sin(ang)) * rad;
    this.p[i3 + 1] = cam.y + d.y * ahead + (this._a.y * Math.cos(ang) + this._b.y * Math.sin(ang)) * rad;
    this.p[i3 + 2] = cam.z + d.z * ahead + (this._a.z * Math.cos(ang) + this._b.z * Math.sin(ang)) * rad;
  }

  update(dt, camera, vel, speed) {
    const alpha = U.smooth(70, 320, speed);
    this.uniforms.uAlpha.value = alpha * 0.32;
    this.mesh.visible = alpha > 0.01;
    if (!this.mesh.visible) { this.inited = false; return; }
    const dir = this.uniforms.uDir.value.copy(vel).normalize();
    this.uniforms.uLen.value = 2 + speed * 0.045;
    const cam = camera.position;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3;
      if (!this.inited) { this._spawn(i, cam, dir, true); continue; }
      const dx = this.p[i3] - cam.x, dy = this.p[i3 + 1] - cam.y, dz = this.p[i3 + 2] - cam.z;
      const along = dx * dir.x + dy * dir.y + dz * dir.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (along < -8 || d2 > 240 * 240 || d2 - along * along > 60 * 60) this._spawn(i, cam, dir, false);
    }
    this.inited = true;
    this.aPos.array.set(this.p);
    this.aPos.needsUpdate = true;
  }
}

/* ===================================================================== */

class VaporCone {
  constructor(scene) {
    const geo = new THREE.ConeGeometry(2.4, 5.5, 40, 6, true);
    this.uniforms = { uOpacity: { value: 0 }, uTime: { value: 0 } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV; varying float vH; varying vec3 vP;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          vH = position.y / 5.5 + 0.5;   // 0 = 开口端，1 = 锥尖
          vP = position;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uOpacity; uniform float uTime;
        varying vec3 vN; varying vec3 vV; varying float vH; varying vec3 vP;
        float h1(float n) { return fract(sin(n) * 43758.5453); }
        void main() {
          float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
          float ang = atan(vP.z, vP.x);
          float streak = 0.6 + 0.4 * sin(ang * 9.0 + uTime * 40.0 + vH * 6.0) * sin(ang * 4.0 - uTime * 23.0);
          float fade = smoothstep(0.0, 0.45, vH) * (1.0 - smoothstep(0.85, 1.0, vH));
          float a = uOpacity * (0.25 + 0.75 * pow(f, 1.5)) * streak * fade;
          if (a < 0.003) discard;
          gl_FragColor = vec4(vec3(0.92, 0.95, 1.0), a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.flash = 0;
    this._up = new THREE.Vector3(0, 1, 0);
  }

  update(dt, pos, dir, speed, time) {
    this.flash = Math.max(0, this.flash - dt * 1.4);
    const k = U.smooth(300, 395, speed) * 0.42 + this.flash * 0.7;
    this.uniforms.uOpacity.value = k;
    this.uniforms.uTime.value = time;
    this.mesh.visible = k > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.quaternion.setFromUnitVectors(this._up, dir);
    // 锥尖位于角色头部前方，开口向后
    this.mesh.position.copy(pos).addScaledVector(dir, -1.2);
    const s = 1 + this.flash * 0.6;
    this.mesh.scale.set(s, 1 + this.flash * 0.3, s);
  }
}

/* ===================================================================== */

class EyeBeams {
  constructor(scene) {
    // 2 束射线 × (内核 + 外层光晕) = 4 个四边形，每帧在 CPU 上更新顶点
    const quads = 4;
    this.pos = new Float32Array(quads * 4 * 3);
    const uv = new Float32Array(quads * 4 * 2);
    const layer = new Float32Array(quads * 4);
    const idx = [];
    for (let q = 0; q < quads; q++) {
      const o = q * 4;
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], o * 2);
      for (let k = 0; k < 4; k++) layer[o + k] = q % 2;
      idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    const geo = this.geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 1));
    geo.setIndex(idx);
    this.uniforms = { uTime: { value: 0 }, uIntensity: { value: 0 } };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        attribute float aLayer; varying vec2 vUv; varying float vLayer;
        void main() { vUv = uv; vLayer = aLayer; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform float uIntensity;
        varying vec2 vUv; varying float vLayer;
        void main() {
          float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
          float flick = 0.85 + 0.15 * sin(uTime * 90.0 + vUv.y * 40.0);
          vec3 core = vec3(4.0, 3.2, 1.8);
          vec3 glow = vec3(2.2, 0.7, 0.12);
          float a;
          vec3 col;
          if (vLayer < 0.5) { a = pow(across, 3.0); col = core; }
          else { a = pow(across, 1.5) * 0.45; col = glow; }
          a *= uIntensity * flick * smoothstep(0.0, 0.02, vUv.y);
          gl_FragColor = vec4(col, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this._d = new THREE.Vector3(); this._c = new THREE.Vector3(); this._s = new THREE.Vector3();
  }

  _quad(q, a, b, width, camera) {
    this._d.subVectors(b, a);
    this._c.subVectors(camera.position, a);
    this._s.crossVectors(this._d, this._c).normalize().multiplyScalar(width);
    const o = q * 12, P = this.pos, s = this._s;
    P[o] = a.x - s.x; P[o + 1] = a.y - s.y; P[o + 2] = a.z - s.z;
    P[o + 3] = a.x + s.x; P[o + 4] = a.y + s.y; P[o + 5] = a.z + s.z;
    P[o + 6] = b.x - s.x; P[o + 7] = b.y - s.y; P[o + 8] = b.z - s.z;
    P[o + 9] = b.x + s.x; P[o + 10] = b.y + s.y; P[o + 11] = b.z + s.z;
  }

  update(time, active, eyeL, eyeR, target, camera) {
    this.uniforms.uTime.value = time;
    const k = this.uniforms.uIntensity.value = U.damp(this.uniforms.uIntensity.value, active ? 1 : 0, 18, 1 / 60);
    this.mesh.visible = k > 0.02;
    if (!this.mesh.visible) return;
    this._quad(0, eyeL, target, 0.05, camera);
    this._quad(1, eyeL, target, 0.32, camera);
    this._quad(2, eyeR, target, 0.05, camera);
    this._quad(3, eyeR, target, 0.32, camera);
    this.geo.attributes.position.needsUpdate = true;
  }
}
