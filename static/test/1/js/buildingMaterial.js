'use strict';
/* =====================================================================
 * buildingMaterial.js — 建筑立面着色器 + 破坏数据纹理
 *
 * 思路：所有方盒建筑共用一个 InstancedMesh（一次绘制调用）。
 *  - 窗户、幕墙、楼层、屋顶、停机坪全部在片元着色器中按世界坐标程序化生成，无需贴图。
 *  - 每栋建筑在一张浮点"破坏纹理"里拥有 16 个槽位，每个槽位是一段胶囊体（两端点 + 半径 + 类型）。
 *    片元落在"撞穿"胶囊内 → discard，形成真实的破洞，能透过破洞看到建筑内部和另一侧；
 *    破洞周围显示裸露混凝土，更大范围内的玻璃显示为破碎。
 *  - 被破坏的建筑会额外加入一个"内部"实例（背面渲染），让破洞里看到昏暗的楼板与透光的窗户。
 * ===================================================================== */

class HoleSystem {
  constructor(maxBuildings) {
    this.SLOTS = 16;
    this.W = 256;                       // 每行 8 栋建筑 × 32 个像素
    this.H = Math.ceil(maxBuildings / 8) + 1;
    this.data = new Float32Array(this.W * this.H * 4);
    this.tex = new THREE.DataTexture(this.data, this.W, this.H, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    // 单栋建筑的暂存行，用于局部上传（texSubImage2D），避免每次上传整张纹理
    this.stage = new Float32Array(32 * 4);
    this.stageTex = new THREE.DataTexture(this.stage, 32, 1, THREE.RGBAFormat, THREE.FloatType);
    this.dirty = new Set();
    this.age = new Uint32Array(maxBuildings * this.SLOTS);
    this.counter = 1;
    this._pos = new THREE.Vector2();
  }

  base(bid) { return (Math.floor(bid / 8) * this.W + (bid % 8) * 32) * 4; }

  /** 新增一段破坏胶囊，返回槽位号。槽位满时按"碎窗 → 射线切口 → 撞击破洞"的顺序覆盖最旧的 */
  add(bid, ax, ay, az, bx, by, bz, r, type) {
    const o = this.base(bid), d = this.data;
    let slot = -1;
    for (let i = 0; i < this.SLOTS; i++) {
      if (d[o + i * 8 + 7] === 0) { slot = i; break; }
    }
    if (slot < 0) {
      const prio = (t) => (t === HOLE.SHATTER ? 0 : t === HOLE.BEAM ? 1 : 2);
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < this.SLOTS; i++) {
        const score = prio(d[o + i * 8 + 7]) * 1e9 + this.age[bid * this.SLOTS + i];
        if (score < bestScore) { bestScore = score; best = i; }
      }
      slot = best;
    }
    this.write(bid, slot, ax, ay, az, bx, by, bz, r, type);
    this.age[bid * this.SLOTS + slot] = this.counter++;
    return slot;
  }

  write(bid, slot, ax, ay, az, bx, by, bz, r, type) {
    const k = this.base(bid) + slot * 8, d = this.data;
    d[k] = ax; d[k + 1] = ay; d[k + 2] = az; d[k + 3] = r;
    d[k + 4] = bx; d[k + 5] = by; d[k + 6] = bz; d[k + 7] = type;
    this.dirty.add(bid);
  }

  /** 延长胶囊的终点（角色在建筑内部持续穿行时使用） */
  setEnd(bid, slot, bx, by, bz, r) {
    const k = this.base(bid) + slot * 8, d = this.data;
    d[k + 4] = bx; d[k + 5] = by; d[k + 6] = bz;
    if (r !== undefined) d[k + 3] = Math.max(d[k + 3], r);
    this.dirty.add(bid);
  }

  slotType(bid, slot) { return this.data[this.base(bid) + slot * 8 + 7]; }

  /** 点是否位于已有破洞内（margin 为安全余量） */
  insideHole(bid, x, y, z, margin) {
    const o = this.base(bid), d = this.data;
    for (let i = 0; i < this.SLOTS; i++) {
      const k = o + i * 8, t = d[k + 7];
      if (t === 0) break;
      if (t === HOLE.SHATTER) continue;
      if (distPointSeg(x, y, z, d[k], d[k + 1], d[k + 2], d[k + 4], d[k + 5], d[k + 6]) < d[k + 3] * 0.8 - margin) return true;
    }
    return false;
  }

  /** 该处是否已被某个碎窗 / 破洞区域覆盖（避免重复写入） */
  covered(bid, x, y, z, r) {
    const o = this.base(bid), d = this.data;
    for (let i = 0; i < this.SLOTS; i++) {
      const k = o + i * 8, t = d[k + 7];
      if (t === 0) break;
      const rr = t === HOLE.SHATTER ? d[k + 3] : d[k + 3] * 2.5;
      if (distPointSeg(x, y, z, d[k], d[k + 1], d[k + 2], d[k + 4], d[k + 5], d[k + 6]) + r * 0.45 < rr) return true;
    }
    return false;
  }

  /** 把改动上传到 GPU（每帧调用一次） */
  flush(renderer) {
    if (!this.dirty.size) return;
    if (this.dirty.size > 48 || !renderer.copyTextureToTexture) {
      this.tex.needsUpdate = true;
      this.dirty.clear();
      return;
    }
    for (const bid of this.dirty) {
      const o = this.base(bid);
      this.stage.set(this.data.subarray(o, o + 128));
      this._pos.set((bid % 8) * 32, Math.floor(bid / 8));
      renderer.copyTextureToTexture(this._pos, this.stageTex, this.tex);
    }
    this.dirty.clear();
  }
}

/* ---------------- 着色器片段 ---------------- */
const BLD_VERT_PARS = /* glsl */`
attribute float aBid;
attribute vec4 aStyle;
attribute vec4 aDims;
attribute vec4 aDims2;
varying vec3 vBPos;
varying vec3 vBNrm;
varying vec4 vStyle;
varying vec4 vDims;
varying vec4 vDims2;
flat varying int vBid;
`;

const BLD_VERT_MAIN = /* glsl */`
{
  vec4 bwp = vec4(transformed, 1.0);
  vec3 bn = objectNormal;
  #ifdef USE_INSTANCING
    bwp = instanceMatrix * bwp;
    bn = mat3(instanceMatrix) * bn;
  #endif
  bwp = modelMatrix * bwp;
  // aDims2.z = 下沉量；加回去让窗户和破洞随建筑一起下沉
  vBPos = bwp.xyz + vec3(0.0, aDims2.z, 0.0);
  vBNrm = normalize(mat3(modelMatrix) * bn + vec3(1e-6));
  vStyle = aStyle; vDims = aDims; vDims2 = aDims2;
  vBid = int(aBid + 0.5);
}
`;

const BLD_FRAG_PARS = /* glsl */`
uniform highp sampler2D uHoleTex;
varying vec3 vBPos;
varying vec3 vBNrm;
varying vec4 vStyle;
varying vec4 vDims;
varying vec4 vDims2;
flat varying int vBid;
float bHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float bHash3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float bNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(bHash3(i), bHash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(bHash3(i + vec3(0.0, 1.0, 0.0)), bHash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(bHash3(i + vec3(0.0, 0.0, 1.0)), bHash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(bHash3(i + vec3(0.0, 1.0, 1.0)), bHash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float sdSeg(vec3 p, vec3 a, vec3 b) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float bBox(float f, float a, float b, float aa) { return smoothstep(a - aa, a + aa, f) * (1.0 - smoothstep(b - aa, b + aa, f)); }
// 镜面玻璃的反射色（金属度高，反射天空与城市）
vec3 glassTint(float s) {
  if (s < 0.2) return vec3(0.30, 0.42, 0.50);
  if (s < 0.4) return vec3(0.20, 0.30, 0.45);
  if (s < 0.6) return vec3(0.42, 0.34, 0.24);
  if (s < 0.8) return vec3(0.44, 0.48, 0.52);
  return vec3(0.26, 0.40, 0.36);
}
`;

/* 立面：先算出窗格坐标，再读取破坏数据（破洞按像素判断，碎窗按整块玻璃判断） */
const BLD_FRAG_FACADE = /* glsl */`
vec3 wallCol = diffuseColor.rgb;
vec3 bnrm = normalize(vBNrm);
float fType = vStyle.x;
float seed = vStyle.y;
float floorH = vStyle.z;
float colW = vStyle.w;
float ly = vBPos.y - vDims2.x;
bool isWall = abs(bnrm.y) < 0.5;
vec3 tg = vec3(-bnrm.z, 0.0, bnrm.x);
float lh = dot(vBPos.xz - vDims.xy, tg.xz);
float halfLen = abs(bnrm.x) > 0.5 ? vDims.w : vDims.z;
float nCols = max(1.0, floor(2.0 * halfLen / colW + 0.5));
float cw = 2.0 * halfLen / nCols;
float cx = (lh + halfLen) / cw;
float ci = floor(cx), fx = fract(cx);
float lobby = (fType < 0.5 || fType > 3.5) ? floorH * 1.7 : floorH;
float fi, fy, cellY;
if (ly < lobby) { fi = -1.0; fy = ly / lobby; cellY = lobby * 0.5; }
else { float yy = (ly - lobby) / floorH; fi = floor(yy); fy = fract(yy); cellY = lobby + (fi + 0.5) * floorH; }
vec3 cellC = isWall ? vec3(vBPos.x - tg.x * (fx - 0.5) * cw, vDims2.x + cellY, vBPos.z - tg.z * (fx - 0.5) * cw) : vBPos;

// ---- 破坏数据：本建筑的 16 个槽位 ----
float holeD = 1e5;
float paneD = 1e5;
float shatterZ = -1.0;
float beamZ = 0.0;
{
  int bxo = (vBid % 8) * 32;
  int byo = vBid / 8;
  for (int i = 0; i < 16; i++) {
    vec4 t1 = texelFetch(uHoleTex, ivec2(bxo + i * 2 + 1, byo), 0);
    if (t1.w < 0.5) break;
    vec4 t0 = texelFetch(uHoleTex, ivec2(bxo + i * 2, byo), 0);
    float d = sdSeg(vBPos, t0.xyz, t1.xyz) / t0.w;
    float dc = sdSeg(cellC, t0.xyz, t1.xyz) / t0.w;
    if (t1.w < 1.5) { holeD = min(holeD, d); paneD = min(paneD, dc); }
    else if (t1.w < 2.5) shatterZ = max(shatterZ, 1.0 - dc);
    else { holeD = min(holeD, d * 1.15); beamZ = max(beamZ, 1.0 - d / 3.2); paneD = min(paneD, dc * 1.6); }
  }
}
float jag = 0.8 + 0.42 * bNoise(vBPos * 0.5) + 0.16 * bNoise(vBPos * 2.1);
if (holeD < jag) discard;
float rim = 1.0 - smoothstep(jag, jag * 1.5, holeD);
float paneRand = bHash(vec2(ci * 1.37 + seed * 11.0 + bnrm.x * 5.0, fi * 2.11 + bnrm.z * 9.0));
bool brokenZ = paneD < 2.2 + paneRand * 1.5 || shatterZ > paneRand * 0.3;

vec3 fCol = wallCol;
float fRough = 0.85;
float fMetal = 0.0;
vec3 fEmis = vec3(0.0);
float glassAmt = 0.0;
if (bnrm.y > 0.5) {
  // 屋顶：砾石 + 女儿墙 + 可能的停机坪
  vec2 lp = vBPos.xz - vDims.xy;
  vec2 ed = vDims.zw - abs(lp);
  float e = min(ed.x, ed.y);
  float gv = bNoise(vec3(vBPos.xz * 0.9, 1.7));
  fCol = mix(vec3(0.07, 0.07, 0.075), vec3(0.15, 0.145, 0.14), gv);
  fCol = mix(fCol, wallCol * 0.85, 1.0 - smoothstep(0.7, 1.05, e));
  if (vDims2.w > 0.5) {
    float r = length(lp);
    float ring = 1.0 - smoothstep(0.25, 0.45, abs(r - 8.5));
    vec2 hp = abs(lp);
    float H = step(hp.x, 3.0) * step(hp.y, 4.0) * clamp(step(2.1, hp.x) + step(hp.y, 0.5), 0.0, 1.0);
    fCol = mix(fCol, vec3(0.05, 0.07, 0.06), 1.0 - smoothstep(10.0, 10.5, r));
    fCol = mix(fCol, vec3(0.75), max(ring, H));
  }
  fRough = 0.95;
} else if (bnrm.y < -0.5) {
  fCol = vec3(0.05);
} else {
  float faceId = bnrm.x * 3.0 + bnrm.z * 7.0;
  float wr = bHash(vec2(ci + faceId * 31.0 + seed * 97.0, fi + seed * 13.0));
  float wr2 = bHash(vec2(fi * 1.7 + seed * 5.0, ci * 3.1 + faceId));
  float aaX = fwidth(cx) * 1.2 + 1e-4;
  float aaY = fwidth(ly / floorH) * 1.2 + 1e-4;
  float win = 0.0;
  if (fType < 0.5) {
    win = bBox(fx, 0.035, 0.965, aaX) * bBox(fy, 0.07, 0.985, aaY);
    if (fi < 0.0) win = bBox(fx, 0.02, 0.98, aaX) * bBox(fy, 0.02, 0.92, aaY);
  } else if (fType < 1.5) {
    win = bBox(fx, 0.05, 0.95, aaX) * bBox(fy, 0.3, 0.93, aaY);
  } else if (fType < 2.5) {
    win = bBox(fx, 0.25, 0.75, aaX) * bBox(fy, 0.3, 0.84, aaY);
  } else if (fType < 3.5) {
    win = bBox(fx, 0.3, 0.7, aaX) * bBox(fy, 0.35, 0.8, aaY);
  } else if (fType < 4.5) {
    if (fi < 0.0) win = bBox(fx, 0.04, 0.96, aaX) * bBox(fy, 0.04, 0.68, aaY);
    else win = bBox(fx, 0.08, 0.92, aaX) * bBox(fy, 0.32, 0.9, aaY);
  } else {
    win = bBox(fx, 0.32, 0.68, aaX) * bBox(fy, 0.35, 0.8, aaY);
  }
  if (fType > 0.5) win *= smoothstep(0.5, 0.9, halfLen - abs(lh));  // 转角壁柱
  win *= 1.0 - step(vDims2.y - 1.2, ly);                           // 顶部女儿墙
  float detail = 1.0 - smoothstep(0.25, 0.7, max(aaX, aaY));       // 远处淡化细节，避免摩尔纹
  vec3 gl = glassTint(fract(seed * 7.13)) * (0.72 + 0.45 * wr);
  float glR = 0.03 + 0.12 * wr2;
  float glM = 0.9;
  if (fType > 1.5 && fType < 3.5) {
    // 住宅窗：偏暗，部分窗帘为暖色
    gl = mix(vec3(0.11, 0.12, 0.13), vec3(0.42, 0.3, 0.18), step(0.72, wr) * 0.7);
    glM = 0.6; glR = 0.1;
  }
  if (fType > 3.5 && fType < 4.5 && fi < 0.0) {
    float band = bBox(fy, 0.74, 0.92, aaY);
    vec3 sc = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + wr));
    fEmis += sc * band * 0.55 * detail;
  }
  float broken = brokenZ ? 1.0 : 0.0;
  vec3 wcol = wallCol * (0.86 + 0.14 * smoothstep(0.0, 8.0, ly)) * (0.93 + 0.1 * bNoise(vBPos * 0.15));
  float avgWin = fType < 0.5 ? 0.85 : (fType < 1.5 ? 0.55 : (fType < 2.5 ? 0.25 : (fType < 3.5 ? 0.18 : 0.42)));
  float w = mix(avgWin, win, detail);
  vec3 paneCol = mix(gl, vec3(0.012, 0.011, 0.01), broken);
  float paneRough = mix(glR, 0.95, broken);
  float paneMetal = mix(glM, 0.0, broken);
  fCol = mix(wcol, paneCol, w);
  fRough = mix(fType < 0.5 ? 0.45 : 0.82, paneRough, w);
  fMetal = mix(fType < 0.5 ? 0.6 : 0.0, paneMetal, w);
  glassAmt = w * (1.0 - broken);
}
// 破洞边缘：裸露的混凝土
float rubbleN = bNoise(vBPos * 3.1);
fCol = mix(fCol, vec3(0.2, 0.19, 0.17) * (0.55 + 0.6 * rubbleN), rim);
fRough = mix(fRough, 1.0, rim);
fMetal = mix(fMetal, 0.0, rim);
// 射线灼烧痕迹
float bz = clamp(beamZ, 0.0, 1.0);
fCol *= 1.0 - bz * 0.85;
fRough = mix(fRough, 1.0, bz);
fMetal *= 1.0 - bz;
#ifdef INTERIOR
  // 建筑内部：昏暗混凝土 + 楼板线 + 窗户透进来的天光
  float slab = 1.0 - smoothstep(0.0, 0.1, fract(max(ly, 0.0) / floorH));
  vec3 ic = vec3(0.07, 0.066, 0.062) * (0.7 + 0.5 * bNoise(vBPos * 0.7));
  ic = mix(ic, vec3(0.025), slab * 0.85);
  fEmis = vec3(0.28, 0.33, 0.4) * glassAmt * 0.7;
  fCol = mix(ic, vec3(0.02), glassAmt);
  if (bnrm.y < -0.5) fCol = vec3(0.12, 0.115, 0.11) * (0.7 + 0.4 * bNoise(vBPos * 0.5));
  fRough = 1.0; fMetal = 0.0;
#endif
diffuseColor.rgb = fCol;
`;

/** 创建建筑材质（interior=true 时为背面渲染的内部材质） */
function createBuildingMaterial(holeTex, interior) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.8,
    metalness: 0.0,
    side: interior ? THREE.BackSide : THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uHoleTex = { value: holeTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + BLD_VERT_PARS)
      .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + BLD_VERT_MAIN);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + (interior ? '#define INTERIOR\n' : '') + BLD_FRAG_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + BLD_FRAG_FACADE)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nroughnessFactor = fRough; metalnessFactor = fMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += fEmis;');
  };
  mat.customProgramCacheKey = () => (interior ? 'zenith-bld-int' : 'zenith-bld-ext');
  return mat;
}
