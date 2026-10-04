'use strict';
/* =====================================================================
 * postfx.js — 单通道后期处理（场景先渲染到 HDR + MSAA 渲染目标）
 *  - 径向运动模糊：以"运动消失点"为中心，强度随速度增长
 *  - 空气扭曲：极速时角色周围与画面边缘的噪声折射
 *  - 冲击脉冲：音爆 / 砸地时从画面中心扩散的波纹
 *  - 屏幕空间速度线、色差、暗角、闪白
 *  - 最后统一做 ACES 色调映射与 sRGB 输出
 * ===================================================================== */

class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const gl2 = renderer.capabilities.isWebGL2;
    this.rt = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      samples: gl2 ? CFG.render.msaa : 0,
      depthBuffer: true,
    });
    this.flashV = 0;
    this.pulseV = 0;
    this.pulseT = 1;
    this.uniforms = {
      tDiffuse: { value: this.rt.texture },
      uCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uHero: { value: new THREE.Vector2(0.5, 0.45) },
      uBlur: { value: 0 },
      uLines: { value: 0 },
      uDistort: { value: 0 },
      uChroma: { value: 0 },
      uFlash: { value: 0 },
      uVignette: { value: 0.35 },
      uPulse: { value: 0 },
      uPulseR: { value: 0 },
      uTime: { value: 0 },
      uAspect: { value: 1 },
    };
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uCenter, uHero;
        uniform float uBlur, uLines, uDistort, uChroma, uFlash, uVignette, uPulse, uPulseR, uTime, uAspect;
        varying vec2 vUv;
        float h21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n21(vec2 p) {
          vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        void main() {
          vec2 uv = vUv;
          vec2 asp = vec2(uAspect, 1.0);
          // 空气扭曲
          if (uDistort > 0.001) {
            vec2 q = uv * asp;
            vec2 n = vec2(n21(q * 8.0 + vec2(0.0, uTime * 6.0)), n21(q * 8.0 + vec2(4.3, -uTime * 6.0))) - 0.5;
            vec2 th = (uv - uHero) * asp;
            float hf = exp(-dot(th, th) * 22.0);
            float edge = smoothstep(0.35, 0.85, length((uv - 0.5) * asp));
            uv += n * uDistort * (0.002 + 0.014 * hf + 0.009 * edge);
          }
          // 冲击脉冲波纹
          if (uPulse > 0.001) {
            vec2 pd = (uv - 0.5) * asp;
            float pr = length(pd);
            float ring = exp(-pow((pr - uPulseR) * 9.0, 2.0));
            uv -= (pd / max(pr, 1e-3)) / asp * ring * uPulse * 0.03;
          }
          vec2 dir = uv - uCenter;
          vec3 col;
          if (uBlur > 0.0005) {
            col = vec3(0.0);
            float tw = 0.0;
            float rl = smoothstep(0.03, 0.5, length(dir * asp));
            for (int i = 0; i < 12; i++) {
              float t = float(i) / 11.0;
              float w = 1.0 - t * 0.55;
              col += texture2D(tDiffuse, uCenter + dir * (1.0 - uBlur * t * rl)).rgb * w;
              tw += w;
            }
            col /= tw;
          } else {
            col = texture2D(tDiffuse, uv).rgb;
          }
          // 色差
          if (uChroma > 0.0005) {
            vec2 off = dir * uChroma;
            col.r = mix(col.r, texture2D(tDiffuse, uv + off).r, 0.75);
            col.b = mix(col.b, texture2D(tDiffuse, uv - off).b, 0.75);
          }
          // 速度线
          if (uLines > 0.001) {
            vec2 d2 = dir * asp;
            float ang = atan(d2.y, d2.x) / 6.28318 + 0.5;
            float r = length(d2);
            float a = ang * 90.0;
            float seg = floor(a);
            float on = step(0.78, h21(vec2(seg, floor(uTime * 22.0))));
            float thin = 1.0 - smoothstep(0.0, 0.22, abs(fract(a) - 0.5));
            float radial = smoothstep(0.28, 0.85, r) * (0.5 + 0.5 * h21(vec2(seg, 7.0)));
            col += vec3(0.92, 0.96, 1.0) * on * thin * radial * uLines * 0.55;
          }
          // 暗角
          float v = smoothstep(1.05, 0.3, length((vUv - 0.5) * vec2(uAspect * 0.8, 1.0)));
          col *= mix(1.0, v, uVignette);
          col += vec3(1.0, 0.97, 0.92) * uFlash;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this._v = new THREE.Vector3();
  }

  setSize(w, h, pr) {
    this.rt.setSize(Math.max(1, Math.floor(w * pr)), Math.max(1, Math.floor(h * pr)));
    this.uniforms.uAspect.value = w / h;
  }

  flash(a) { this.flashV = Math.max(this.flashV, a); }
  pulse(a) { this.pulseV = Math.max(this.pulseV, a); this.pulseT = 0; }

  /** 世界坐标 → 屏幕 UV */
  project(p, camera, out) {
    this._v.copy(p).project(camera);
    return out.set(this._v.x * 0.5 + 0.5, this._v.y * 0.5 + 0.5);
  }

  /**
   * o: { time, dt, speed, hyper, vel, heroPos, camera }
   */
  render(scene, camera, o) {
    const u = this.uniforms;
    const dt = o.dt;
    u.uTime.value = o.time;
    const sp = o.speed;
    const fast = U.smooth(110, 420, sp);
    const hyper = o.hyper ? U.smooth(200, 420, sp) : 0;
    u.uBlur.value = fast * 0.07 + hyper * 0.045;
    u.uLines.value = hyper * 0.55 + U.smooth(250, 420, sp) * 0.15;
    u.uDistort.value = hyper * 0.9 + this.pulseV * 0.6;
    u.uChroma.value = fast * 0.0018 + hyper * 0.003 + this.pulseV * 0.008;
    u.uVignette.value = 0.3 + fast * 0.25;
    // 运动消失点：速度方向在屏幕上的投影
    if (sp > 20) {
      this._v.copy(o.vel).normalize().multiplyScalar(1000).add(camera.position).project(camera);
      if (this._v.z < 1) u.uCenter.value.set(U.clamp(this._v.x * 0.5 + 0.5, 0.1, 0.9), U.clamp(this._v.y * 0.5 + 0.5, 0.1, 0.9));
    } else u.uCenter.value.set(0.5, 0.5);
    this.project(o.heroPos, camera, u.uHero.value);
    this.flashV *= Math.exp(-7 * dt);
    u.uFlash.value = this.flashV;
    this.pulseT += dt;
    this.pulseV *= Math.exp(-2.5 * dt);
    u.uPulse.value = this.pulseV;
    u.uPulseR.value = this.pulseT * 1.4;

    const r = this.renderer;
    r.setRenderTarget(this.rt);
    r.render(scene, camera);
    r.setRenderTarget(null);
    r.render(this.scene, this.cam);
  }
}
