'use strict';
/* =====================================================================
 * environment.js — 天空、阳光、阴影、雾、云层、环境反射、地面（道路着色器）、海面、远山
 * 地面不使用任何贴图：道路、车道线、斑马线、人行道、草地、广场、弹坑全部在着色器中程序化绘制。
 * ===================================================================== */

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * p;
  gl_Position.z = gl_Position.w; // 永远画在最远处
}`;

const SKY_FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.42));
  // 地平线以下：逐渐过渡到地面雾色
  col = mix(col, uGround, smoothstep(0.0, -0.12, h));
  float sd = max(dot(d, uSunDir), 0.0);
  // 太阳本体 + 光晕 + 大范围暖色散射
  col += uSunColor * (pow(sd, 1600.0) * 60.0 + pow(sd, 90.0) * 0.9 + pow(sd, 8.0) * 0.22);
  col += vec3(1.0, 0.75, 0.45) * pow(sd, 3.0) * 0.12 * (1.0 - clamp(h * 3.0, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

class Environment {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.time = 0;
    this.craters = [];
    this.craterIdx = 0;
    // 太阳方向（指向太阳）：左前方，仰角约 33°，形成较长的建筑阴影
    this.sunDir = new THREE.Vector3(-0.62, 0.55, -0.42).normalize();
    this.colors = {
      zenith: new THREE.Color('#3f6fb3'),
      horizon: new THREE.Color('#c9d8e6'),
      ground: new THREE.Color('#b9c3cb'),
      sun: new THREE.Color('#fff1d6'),
      fog: new THREE.Color('#c3d1de'),
    };
  }

  build(city) {
    this._sky();
    this._lights();
    this._envMap();
    this._clouds();
    this._ground(city);
    this._mountains();
    this.scene.fog = new THREE.Fog(this.colors.fog, 150, 2800);
  }

  /* ---------------- 天空 ---------------- */
  _skyMaterial() {
    return new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uSunDir: { value: this.sunDir },
        uZenith: { value: this.colors.zenith },
        uHorizon: { value: this.colors.horizon },
        uGround: { value: this.colors.ground },
        uSunColor: { value: this.colors.sun },
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
  }

  _sky() {
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(20000, 32, 16), this._skyMaterial());
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
  }

  /* ---------------- 光照与阴影 ---------------- */
  _lights() {
    const sun = this.sun = new THREE.DirectionalLight(0xffecd2, 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(CFG.render.shadowSize, CFG.render.shadowSize);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
    this.shadowHalf = 260;
    const sc = sun.shadow.camera;
    sc.left = -this.shadowHalf; sc.right = this.shadowHalf;
    sc.top = this.shadowHalf; sc.bottom = -this.shadowHalf;
    sc.near = 10; sc.far = 4000;
    sc.updateProjectionMatrix();
    this.scene.add(sun);
    this.scene.add(sun.target);

    this.hemi = new THREE.HemisphereLight(0xbdd3f2, 0x6a6258, 0.55);
    this.scene.add(this.hemi);

    this._lr = new THREE.Vector3().crossVectors(this.sunDir, new THREE.Vector3(0, 1, 0)).normalize();
    this._lu = new THREE.Vector3().crossVectors(this._lr, this.sunDir).normalize();
  }

  /**
   * 环境反射贴图：天空 + 一圈远景"城市天际线"剪影 + 深色地面。
   * 玻璃幕墙反射里会出现建筑轮廓，比纯天空反射真实得多。
   */
  _envMap() {
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), this._skyMaterial()));
    const rng = new RNG(77);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const mats = [0x7a8796, 0x8c99a7, 0x667383, 0x9eabb9, 0x5a6575].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    for (let i = 0; i < 160; i++) {
      const a = rng.range(0, Math.PI * 2), dist = rng.range(260, 340);
      const h = dist * Math.tan(THREE.MathUtils.degToRad(rng.range(1.5, 11)));
      const w = rng.range(14, 46);
      const m = new THREE.Mesh(box, rng.pick(mats));
      m.position.set(Math.cos(a) * dist, h / 2 - 4, Math.sin(a) * dist);
      m.scale.set(w, h, w);
      m.lookAt(0, m.position.y, 0);
      envScene.add(m);
    }
    const ground = new THREE.Mesh(new THREE.CircleGeometry(480, 32), new THREE.MeshBasicMaterial({ color: 0x5b5f64 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -4;
    envScene.add(ground);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(envScene, 0.0, 1, 1200);
    this.scene.environment = rt.texture;
    pmrem.dispose();
  }

  /* ---------------- 云层（软粒子公告板） ---------------- */
  _cloudTexture() {
    const S = 256, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const rng = new RNG(1234);
    for (let i = 0; i < 46; i++) {
      const r = rng.range(S * 0.08, S * 0.22);
      const x = S / 2 + rng.range(-1, 1) * (S / 2 - r) * 0.75;
      const y = S / 2 + rng.range(-0.6, 0.45) * (S / 2 - r) * 0.75;
      const shade = Math.floor(rng.range(200, 255));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${shade},${shade},${shade},0.55)`);
      gr.addColorStop(0.6, `rgba(${shade},${shade},${shade},0.22)`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  _clouds() {
    const rng = new RNG(4242);
    const clusters = 70, per = 9, n = clusters * per;
    const geo = new THREE.InstancedBufferGeometry();
    const base = new THREE.PlaneGeometry(1, 1);
    geo.index = base.index;
    geo.setAttribute('position', base.attributes.position);
    geo.setAttribute('uv', base.attributes.uv);
    const pos = new Float32Array(n * 3), size = new Float32Array(n * 2), shade = new Float32Array(n), rot = new Float32Array(n);
    let k = 0;
    for (let c = 0; c < clusters; c++) {
      const cx = rng.range(-9000, 9000), cz = rng.range(-9000, 9000), cy = rng.range(700, 1150);
      const sc = rng.range(0.7, 1.6);
      for (let i = 0; i < per; i++, k++) {
        const ox = rng.range(-1, 1) * 260 * sc, oz = rng.range(-1, 1) * 200 * sc, oy = rng.range(-0.3, 1) * 60 * sc;
        pos[k * 3] = cx + ox; pos[k * 3 + 1] = cy + oy; pos[k * 3 + 2] = cz + oz;
        const s = rng.range(220, 420) * sc;
        size[k * 2] = s; size[k * 2 + 1] = s * rng.range(0.55, 0.8);
        shade[k] = U.clamp(0.45 + (oy / (60 * sc)) * 0.5, 0, 1);
        rot[k] = rng.range(-0.2, 0.2);
      }
    }
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(size, 2));
    geo.setAttribute('iShade', new THREE.InstancedBufferAttribute(shade, 1));
    geo.setAttribute('iRot', new THREE.InstancedBufferAttribute(rot, 1));
    geo.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTex: { value: this._cloudTexture() },
        uLit: { value: new THREE.Color('#ffffff').multiplyScalar(1.25) },
        uShadow: { value: new THREE.Color('#9fb0c4') },
        uFogColor: { value: this.colors.horizon },
      },
      vertexShader: /* glsl */`
        attribute vec3 iPos; attribute vec2 iSize; attribute float iShade; attribute float iRot;
        varying vec2 vUv; varying float vShade; varying float vFade; varying float vDist;
        void main() {
          vUv = uv;
          vec4 mv = viewMatrix * vec4(iPos, 1.0);
          float c = cos(iRot), s = sin(iRot);
          vec2 off = vec2(c * position.x - s * position.y, s * position.x + c * position.y) * iSize;
          mv.xy += off;
          vShade = iShade;
          float d = length(mv.xyz);
          vDist = length(iPos.xz - cameraPosition.xz);
          vFade = smoothstep(iSize.x * 0.12, iSize.x * 0.55, d);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex; uniform vec3 uLit; uniform vec3 uShadow; uniform vec3 uFogColor;
        varying vec2 vUv; varying float vShade; varying float vFade; varying float vDist;
        void main() {
          vec4 t = texture2D(uTex, vUv);
          float a = t.a * vFade;
          if (a < 0.004) discard;
          vec3 col = mix(uShadow, uLit, clamp(vShade * 0.7 + vUv.y * 0.5, 0.0, 1.0)) * (0.8 + 0.25 * t.r);
          float f = smoothstep(5000.0, 12500.0, vDist);
          col = mix(col, uFogColor, f);
          gl_FragColor = vec4(col, a * (1.0 - f * 0.85));
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    this.clouds = new THREE.Mesh(geo, mat);
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = 1;
    this.scene.add(this.clouds);
  }

  /* ---------------- 地面：道路 / 人行道 / 绿地 / 广场 / 海面 ---------------- */
  _ground(city) {
    const C = CFG.city;
    const N = C.blocks;
    const blockTex = new THREE.DataTexture(city.blockTypes, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
    blockTex.minFilter = blockTex.magFilter = THREE.NearestFilter;
    blockTex.needsUpdate = true;

    const craters = [];
    for (let i = 0; i < 24; i++) craters.push(new THREE.Vector4(0, 0, 0, 0));
    this.craterUniform = craters;

    const uniforms = {
      uPeriod: { value: C.period },
      uN: { value: N },
      uStreetW: { value: C.streetW },
      uAvenueW: { value: C.avenueW },
      uAvenueEvery: { value: C.avenueEvery },
      uSidewalk: { value: C.sidewalk },
      uCityHalf: { value: N * C.period / 2 },
      uShore: { value: C.shore },
      uBlockTex: { value: blockTex },
      uCraters: { value: craters },
      uTime: { value: 0 },
    };
    this.groundUniforms = uniforms;

    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
        .replace('#include <fog_vertex>', '#include <fog_vertex>\nvGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + GROUND_PARS)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + GROUND_COLOR)
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = gRough; metalnessFactor = 0.0;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + GROUND_NORMAL);
    };
    mat.customProgramCacheKey = () => 'zenith-ground';

    const geo = new THREE.PlaneGeometry(44000, 44000, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  /** 远处山脉：环形带状网格 */
  _mountains() {
    const seg = 220, rows = 6;
    const pos = [], idx = [];
    const rng = new RNG(99);
    const heights = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const n = noise1(a * 5, 3) * 0.6 + noise1(a * 13, 5) * 0.3 + noise1(a * 31, 7) * 0.1;
      heights.push(250 + Math.pow(n, 1.6) * 1500 + rng.range(0, 60));
    }
    for (let r = 0; r <= rows; r++) {
      const t = r / rows;
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const rad = 12500 + t * 4000;
        const h = heights[i] * Math.sin(t * Math.PI) * (0.7 + 0.3 * noise1(i * 0.7 + r, 11)) - 20;
        pos.push(Math.cos(a) * rad, h, Math.sin(a) * rad);
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < seg; i++) {
        const a = r * (seg + 1) + i, b = a + seg + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4b5a66, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
    this.scene.add(m);
  }

  /** 地面弹坑（俯冲冲击 / 爆炸）：写入着色器的环形缓冲 */
  addCrater(x, z, r, intensity = 1) {
    const v = this.craterUniform[this.craterIdx];
    v.set(x, z, r, intensity);
    this.craterIdx = (this.craterIdx + 1) % this.craterUniform.length;
  }

  /** 每帧：天空跟随相机、阴影相机跟随焦点、雾随高度变化 */
  update(dt, camera, focus) {
    this.time += dt;
    this.groundUniforms.uTime.value = this.time;
    this.sky.position.copy(camera.position);

    const alt = Math.max(0, camera.position.y);
    // 阴影范围随高度扩大
    const half = U.clamp(240 + alt * 0.7, 240, 1100);
    if (Math.abs(half - this.shadowHalf) > 8) {
      this.shadowHalf = half;
      const sc = this.sun.shadow.camera;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      sc.updateProjectionMatrix();
    }
    // 按阴影贴图像素对齐，避免移动时阴影边缘闪烁
    const texel = (2 * this.shadowHalf) / CFG.render.shadowSize;
    const a = Math.round(focus.dot(this._lr) / texel) * texel;
    const b = Math.round(focus.dot(this._lu) / texel) * texel;
    const c = focus.dot(this.sunDir);
    const t = this.sun.target.position;
    t.copy(this._lr).multiplyScalar(a).addScaledVector(this._lu, b).addScaledVector(this.sunDir, c);
    this.sun.position.copy(t).addScaledVector(this.sunDir, 1800);
    this.sun.target.updateMatrixWorld();

    // 越高看得越远：飞到高空可以看到完整城市轮廓
    const fog = this.scene.fog;
    fog.near = 150 + alt * 0.8;
    fog.far = Math.min(2800 + alt * 6.5, 16000);
  }
}

/* ---------------- 地面着色器片段 ---------------- */
const GROUND_PARS = /* glsl */`
varying vec3 vGPos;
uniform float uPeriod, uN, uStreetW, uAvenueW, uAvenueEvery, uSidewalk, uCityHalf, uShore, uTime;
uniform sampler2D uBlockTex;
uniform vec4 uCraters[24];

float gHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float gNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gFbm(vec2 p) { return gNoise(p) * 0.55 + gNoise(p * 2.13) * 0.28 + gNoise(p * 4.37) * 0.17; }
// 抗锯齿细线：d 为到中心线的距离
float gLine(float d, float c, float hw) {
  float x = abs(d - c);
  float aa = fwidth(d) * 0.8 + 1e-4;
  return 1.0 - smoothstep(hw - aa, hw + aa, x);
}
`;

const GROUND_COLOR = /* glsl */`
vec2 gp = vGPos.xz;
vec3 gCol = vec3(0.05);
float gRough = 0.92;
float gWater = 0.0;
float edgeDist = max(abs(gp.x), abs(gp.y)) - uCityHalf;
float pix = length(fwidth(gp));
float markFade = 1.0 - smoothstep(0.12, 0.5, pix);
if (edgeDist > uShore) {
  // 海面
  gWater = 1.0;
  float depth = smoothstep(uShore, uShore + 900.0, edgeDist);
  gCol = mix(vec3(0.02, 0.06, 0.065), vec3(0.006, 0.022, 0.04), depth);
  gRough = 0.07;
} else if (edgeDist > uAvenueW * 0.5) {
  // 城外绿地与沙滩
  float s = smoothstep(uShore - 70.0, uShore - 10.0, edgeDist);
  vec3 grass = mix(vec3(0.055, 0.12, 0.03), vec3(0.09, 0.16, 0.045), gFbm(gp * 0.05));
  vec3 sand = vec3(0.55, 0.47, 0.3) * (0.9 + 0.1 * gNoise(gp * 0.3));
  gCol = mix(grass, sand, s);
  gRough = 0.95;
} else {
  float P = uPeriod;
  float ix = floor(gp.x / P + 0.5), iz = floor(gp.y / P + 0.5);
  float dx = abs(gp.x - ix * P), dz = abs(gp.y - iz * P);
  float wx = mod(ix + uN * 0.5, uAvenueEvery) < 0.5 ? uAvenueW : uStreetW;
  float wz = mod(iz + uN * 0.5, uAvenueEvery) < 0.5 ? uAvenueW : uStreetW;
  float ax = wx * 0.5 - uSidewalk, az = wz * 0.5 - uSidewalk;
  bool roadX = dx < ax, roadZ = dz < az;
  bool walkX = dx < wx * 0.5, walkZ = dz < wz * 0.5;
  float n1 = gNoise(gp * 0.6), n2 = gFbm(gp * 0.035);
  vec3 asphalt = vec3(0.045, 0.047, 0.052) * (0.82 + 0.25 * n1) * (0.85 + 0.3 * n2);
  vec3 white = vec3(0.75, 0.75, 0.72);
  vec3 yellow = vec3(0.72, 0.42, 0.05);
  if (roadX || roadZ) {
    gCol = asphalt;
    gRough = 0.86;
    if (roadX && roadZ) {
      gCol *= 0.95;  // 路口
    } else {
      // d: 到道路中心线的距离；along: 沿道路方向的坐标；cross: 横穿道路方向的坐标
      float d = roadX ? dx : dz;
      float along = roadX ? gp.y : gp.x;
      float acrossW = roadX ? wz : wx;
      float other = roadX ? dz : dx;
      bool avenue = (roadX ? wx : wz) > (uStreetW + 1.0);
      float m = 0.0; vec3 mc = white;
      if (other < acrossW * 0.5 + 0.6) {
        // 斑马线
        float acrossC = roadX ? gp.x : gp.y;
        float stripe = step(0.5, fract(acrossC / 1.3));
        m = stripe * step(other, acrossW * 0.5 - 0.6) * step(acrossW * 0.5 - uSidewalk + 0.8, other);
      } else {
        float dash = step(fract(along / 12.0), 0.55);
        if (avenue) {
          float y = gLine(d, 0.85, 0.09);
          if (y > 0.0) { m = y; mc = yellow; }
          m = max(m, (gLine(d, 4.5, 0.08) + gLine(d, 8.0, 0.08)) * dash);
          m = max(m, gLine(d, 11.5, 0.1));
        } else {
          float y = gLine(d, 0.16, 0.07);
          if (y > 0.0) { m = y; mc = yellow; }
          m = max(m, gLine(d, 3.6, 0.07) * dash);
          m = max(m, gLine(d, 7.2, 0.08));
        }
        // 停车线前的白色停止线
        m = max(m, step(other, acrossW * 0.5 + 2.2) * step(acrossW * 0.5 + 1.6, other) * step(d, avenue ? 11.5 : 7.2));
      }
      gCol = mix(gCol, mc * (0.85 + 0.15 * n1), clamp(m, 0.0, 1.0) * markFade * 0.9);
    }
  } else if (walkX || walkZ) {
    // 人行道：方砖 + 路缘石
    float curb = (walkX && dx - ax < 0.35) || (walkZ && dz - az < 0.35) ? 1.0 : 0.0;
    vec2 tile = fract(gp / 1.5);
    float joint = (1.0 - smoothstep(0.0, 0.04, min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y)))) * markFade;
    gCol = vec3(0.31, 0.3, 0.28) * (0.9 + 0.12 * n1) * (1.0 - joint * 0.25);
    gCol = mix(gCol, vec3(0.46, 0.45, 0.42), curb);
    gRough = 0.9;
  } else {
    // 街区内部：根据街区类型着色
    vec2 bi = floor(gp / P + uN * 0.5);
    vec4 bt = texelFetch(uBlockTex, ivec2(clamp(bi, vec2(0.0), vec2(uN - 1.0))), 0);
    float type = floor(bt.r * 255.0 + 0.5);
    if (type < 0.5) {          // 0 硬化地面
      vec2 tile = fract(gp / 6.0);
      float joint = (1.0 - smoothstep(0.0, 0.015, min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y)))) * markFade;
      gCol = vec3(0.24, 0.23, 0.215) * (0.88 + 0.18 * n1) * (1.0 - joint * 0.3);
    } else if (type < 1.5) {   // 1 公园草地
      gCol = mix(vec3(0.05, 0.11, 0.028), vec3(0.1, 0.17, 0.045), gFbm(gp * 0.08)) * (0.9 + 0.2 * n1);
      // 小径
      vec2 lp = fract(gp / P + uN * 0.5) - 0.5;
      float path = min(abs(lp.x), abs(lp.y)) * P;
      gCol = mix(gCol, vec3(0.4, 0.36, 0.3), (1.0 - smoothstep(1.4, 1.9, path)) * 0.9);
      gRough = 0.97;
    } else if (type < 2.5) {   // 2 广场石材
      vec2 tile = fract(gp / 3.0);
      float joint = (1.0 - smoothstep(0.0, 0.025, min(min(tile.x, 1.0 - tile.x), min(tile.y, 1.0 - tile.y)))) * markFade;
      vec2 lp = (fract(gp / P + uN * 0.5) - 0.5) * P;
      float ring = abs(length(lp) - 26.0);
      gCol = vec3(0.47, 0.42, 0.35) * (0.9 + 0.12 * gHash(floor(gp / 3.0))) * (1.0 - joint * 0.35);
      gCol = mix(gCol, vec3(0.28, 0.27, 0.27), (1.0 - smoothstep(1.0, 1.4, ring)) * 0.8);
      gRough = 0.75;
    } else {                   // 3 住宅庭院草坪
      gCol = mix(vec3(0.07, 0.13, 0.035), vec3(0.12, 0.18, 0.06), gFbm(gp * 0.12));
      gRough = 0.95;
    }
  }
}
// 弹坑：焦黑中心 + 放射状裂纹 + 外圈尘土
for (int i = 0; i < 24; i++) {
  vec4 c = uCraters[i];
  if (c.z <= 0.0) break;
  vec2 dv = gp - c.xy;
  float d = length(dv) / c.z;
  if (d < 2.2) {
    float ang = atan(dv.y, dv.x);
    float cracks = smoothstep(0.82, 0.97, gNoise(vec2(ang * 7.0 + c.x, d * 2.0))) * (1.0 - smoothstep(0.8, 2.1, d));
    float scorch = 1.0 - smoothstep(0.25, 1.05, d);
    float dust = 1.0 - smoothstep(0.9, 2.2, d);
    gCol = mix(gCol, vec3(0.32, 0.29, 0.25), dust * 0.35 * c.w);
    gCol = mix(gCol, vec3(0.03, 0.026, 0.022), scorch * 0.9 * c.w);
    gCol *= 1.0 - cracks * 0.85 * c.w;
    gRough = mix(gRough, 1.0, scorch);
    gWater *= step(1.0, d);
  }
}
diffuseColor.rgb = gCol;
`;

const GROUND_NORMAL = /* glsl */`
if (gWater > 0.5) {
  vec2 q = vGPos.xz * 0.045;
  float t = uTime;
  vec2 w = vec2(
    sin(q.x * 3.1 + t * 1.3) + 0.6 * sin(q.y * 2.3 - t * 1.1) + 0.3 * sin((q.x + q.y) * 7.7 + t * 2.3),
    cos(q.y * 2.9 + t * 1.2) + 0.6 * cos(q.x * 2.1 - t * 0.9) + 0.3 * cos((q.x - q.y) * 8.1 - t * 1.9)) * 0.035;
  vec3 nw = normalize(vec3(w.x, 1.0, w.y));
  normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
}
`;
