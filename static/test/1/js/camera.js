'use strict';
/* =====================================================================
 * camera.js — 第三人称镜头
 *  - 距离与 FOV 随速度变化（悬停近 → 高速拉远 → 极速更远、FOV 增大）
 *  - 距离使用弹簧：进入极速瞬间角色会先"甩开"镜头再被追上
 *  - 镜头朝向带延迟（速度越快延迟越明显），急转弯更有重量感
 *  - 高速俯冲时镜头上抬并额外下俯；转弯时轻微侧倾；创伤值驱动的屏幕震动
 * ===================================================================== */

class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.aimYaw = 0;
    this.aimPitch = -0.12;
    this.yaw = 0;
    this.pitch = -0.12;
    this.dist = CFG.camera.distWalk;
    this.distV = 0;
    this.zoom = 1;
    this.fov = CFG.camera.fovBase;
    this.fovPunch = 0;
    this.trauma = 0;
    this.time = 0;
    this.roll = 0;
    this.lift = 0;
    this.menu = true;
    this.menuT = 0;
    this.blend = 0;          // 0 = 菜单环绕镜头，1 = 游戏镜头
    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._pos = new THREE.Vector3();
    this._tgt = new THREE.Vector3();
    this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._q = new THREE.Quaternion();
    this._mq = new THREE.Quaternion();
    this._mp = new THREE.Vector3();
    this._m = new THREE.Matrix4();
  }

  applyMouse(dx, dy) {
    const s = CFG.camera.sensitivity;
    this.aimYaw -= dx * s;
    this.aimPitch = U.clamp(this.aimPitch - dy * s, -1.48, 1.48);
  }

  addTrauma(a) { this.trauma = Math.min(1, this.trauma + a); }
  fovKick(d) { this.fovPunch = Math.max(this.fovPunch, d); }
  kickBack(d) { this.distV += d * 5; }

  /** 开始游戏：从菜单镜头平滑过渡 */
  begin(heading) {
    this.menu = false;
    this.aimYaw = this.yaw = heading;
    this.aimPitch = this.pitch = -0.12;
  }

  update(dt, hero, model) {
    this.time += dt;
    const C = CFG.camera;
    const sp = hero.speed;
    let dT, fovT;
    if (hero.state !== 'flight') {
      dT = C.distWalk;
      fovT = C.fovBase;
    } else {
      const k1 = U.smooth(3, 40, sp), k2 = U.smooth(60, 160, sp), k3 = hero.hyper ? U.smooth(160, 400, sp) : 0;
      dT = U.lerp(C.distHover, C.distFly, k1);
      dT = U.lerp(dT, C.distFast, k2);
      dT = U.lerp(dT, C.distHyper, k3);
      fovT = U.lerp(C.fovBase, C.fovFast, k2);
      fovT = U.lerp(fovT, C.fovHyper, k3);
    }
    dT *= this.zoom;
    // 临界阻尼弹簧
    const w = 5.5;
    this.distV += (w * w * (dT - this.dist) - 2 * w * this.distV) * dt;
    this.dist += this.distV * dt;

    // 朝向延迟：速度越快越"重"
    const lag = U.lerp(28, 8.5, U.smooth(30, 420, sp));
    this.yaw = U.dampAngle(this.yaw, this.aimYaw, lag, dt);
    this.pitch = U.damp(this.pitch, this.aimPitch, lag, dt);

    // 俯冲：镜头上抬 + 额外下俯
    const dive = hero.state === 'flight' && sp > 40 ? U.clamp(-hero.vel.y / sp, 0, 1) * U.smooth(40, 220, sp) : 0;
    this.lift = U.damp(this.lift, dive, 4, dt);
    const pitch = this.pitch - this.lift * 0.14;
    const fwd = dirFromYawPitch(this.yaw, pitch, this._fwd);
    const tgt = this._tgt.copy(hero.pos);
    tgt.y += hero.state === 'flight' ? 0.45 : 0.62;
    // 相机上方向（用于把角色放在画面中心略偏下）
    this._e.set(pitch, this.yaw, 0, 'YXZ');
    this._q.setFromEuler(this._e);
    const up = this._up.set(0, 1, 0).applyQuaternion(this._q);
    const pos = this._pos.copy(tgt).addScaledVector(fwd, -this.dist).addScaledVector(up, 0.55 + this.dist * 0.04 + this.lift * 1.6);
    if (pos.y < 0.6) pos.y = 0.6;

    // 侧倾：跟随角色转弯
    const rollT = hero.state === 'flight' ? -model.bank * 0.22 : 0;
    this.roll = U.damp(this.roll, rollT, 4, dt);

    // FOV
    this.fovPunch *= Math.exp(-3.5 * dt);
    this.fov = U.damp(this.fov, fovT, 3.5, dt);

    // 屏幕震动（创伤值²）
    const base = hero.hyper ? 0.16 * U.smooth(250, 430, sp) : 0;
    this.trauma = Math.max(0, this.trauma - dt * 0.85);
    const tr = Math.max(this.trauma, base);
    const sh = tr * tr;
    const t = this.time * 23;
    const ox = (noise1(t, 1) - 0.5) * 2 * sh * 0.7, oy = (noise1(t, 2) - 0.5) * 2 * sh * 0.7;
    const rp = (noise1(t, 3) - 0.5) * 2 * sh * 0.045, ry = (noise1(t, 4) - 0.5) * 2 * sh * 0.045, rr = (noise1(t, 5) - 0.5) * 2 * sh * 0.06;

    this._e.set(pitch + rp, this.yaw + ry, this.roll + rr, 'YXZ');
    this._q.setFromEuler(this._e);
    const right = this._fwd.set(1, 0, 0).applyQuaternion(this._q);
    pos.addScaledVector(right, ox).addScaledVector(up, oy);

    // 菜单：环绕市中心的电影镜头
    this.blend = U.damp(this.blend, this.menu ? 0 : 1, 1.6, dt);
    if (this.blend < 0.999) {
      this.menuT += dt;
      const a = this.menuT * 0.035 + 0.6;
      this._mp.set(Math.sin(a) * 520, 210 + Math.sin(this.menuT * 0.1) * 30, Math.cos(a) * 520 + 60);
      this._m.lookAt(this._mp, this._tgt.set(0, 90, 0), this._up.set(0, 1, 0));
      this._mq.setFromRotationMatrix(this._m);
      const k = this.blend * this.blend * (3 - 2 * this.blend);
      this.cam.position.lerpVectors(this._mp, pos, k);
      this.cam.quaternion.copy(this._mq).slerp(this._q, k);
      this.cam.fov = U.lerp(55, this.fov + this.fovPunch, k);
    } else {
      this.cam.position.copy(pos);
      this.cam.quaternion.copy(this._q);
      this.cam.fov = this.fov + this.fovPunch;
    }
    this.cam.updateProjectionMatrix();
    this.cam.updateMatrixWorld();
  }
}
