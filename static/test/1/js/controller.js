'use strict';
/* =====================================================================
 * controller.js — 角色控制与飞行物理
 *
 * 飞行模型 = "方向 + 速率"分离：
 *  - 方向以有限角速度转向输入方向（速度越快转得越慢 → 高速时的弧线与惯性）
 *  - 速率按档位（普通 / 高速 / 极速）加速到目标值；松开按键平滑减速到悬停
 *  - 高速撞击建筑时直接撞穿，几乎不减速；低速时被墙挡住并可贴墙滑动、落在屋顶
 * 状态：ground（步行）/ flight（飞行与悬停）/ landing（超级英雄落地硬直）
 * ===================================================================== */

class HeroController {
  constructor(city) {
    this.city = city;
    this.pos = new THREE.Vector3(0, CFG.hero.hipHeight, 60);
    this.vel = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);
    this.state = 'ground';
    this.heading = 0;
    this.hyper = false;
    this.boost = false;
    this.brake = 0;
    this.landT = 0;
    this.punchT = 0;
    this.punchCd = 0;
    this.shiftHeld = 0;
    this.hyperOff = 0;
    this.machDone = false;
    this.speed = 0;
    this.altitude = 0;
    this.beamOn = false;
    this.beamTarget = new THREE.Vector3();
    this.pressure = 0;
    this.pressurePan = 0;
    this.nearBoundary = false;
    this.inside = new Map();
    this._near = false;
    this._hit = {};
    this._f = new THREE.Vector3(); this._r = new THREE.Vector3(); this._w = new THREE.Vector3();
    this._s = new THREE.Vector3(); this._p0 = new THREE.Vector3(); this._t = new THREE.Vector3();
    this._list = [];
  }

  /** 每帧更新。aimYaw / aimPitch 来自相机（鼠标） */
  update(dt, inp, aimYaw, aimPitch) {
    const C = CFG.hero;
    this.punchT = Math.max(0, this.punchT - dt);
    this.punchCd -= dt;
    // 飞行方向：相机朝向 + 少许上抬，方便在镜头略微俯视时保持水平飞行
    const fwd = dirFromYawPitch(aimYaw, U.clamp(aimPitch + 0.12, -1.55, 1.55), this._f);
    const right = this._r.set(Math.cos(aimYaw), 0, -Math.sin(aimYaw));
    const f = inp.forward, st = inp.strafe, vt = inp.vertical;

    // ---------- 高速 / 极速档位 ----------
    this.boost = inp.shift && this.state === 'flight';
    this.shiftHeld = inp.shift ? this.shiftHeld + dt : 0;
    if (this.state === 'flight' && f > 0 && !this.hyper && (inp.doubleShift || (this.shiftHeld > 1.0 && this.speed > 90))) this._enterHyper();
    if (this.hyper) {
      this.hyperOff = f <= 0 ? this.hyperOff + dt : 0;
      if (this.hyperOff > 0.25 || inp.down('KeyX') || this.state !== 'flight') this.hyper = false;
    }

    if (this.state === 'landing') {
      this.landT -= dt;
      this.vel.set(0, 0, 0);
      if (this.landT <= 0) this.state = 'ground';
      if (this.landT < 0.25 && (vt > 0 || inp.hit('Space'))) this._takeoff();
    } else if (this.state === 'ground') {
      this._ground(dt, inp, aimYaw);
    } else {
      this._flight(dt, inp, fwd, right, f, st, vt, aimYaw);
    }

    this._p0.copy(this.pos);
    this._move(dt);
    this._groundCheck(dt);
    this._props(this._p0, this.pos);
    this._boundary(dt);

    this.speed = this.vel.length();
    this.altitude = this.pos.y - C.hipHeight;
    // 音爆：首次突破 1 马赫
    if (this.speed > C.mach1 && !this.machDone && this.state === 'flight') {
      this.machDone = true;
      G.destruction.sonicBoom(this.pos, this._t.copy(this.vel).normalize());
    }
    if (this.speed < C.mach1 * 0.86) this.machDone = false;
    // 气流对周围的影响
    if (this.state === 'flight') G.destruction.airPressure(this.pos, this.vel, this.speed, dt, this.altitude);
    this._proximity();

    // ---------- 冲击拳 ----------
    if (inp.lmbPressed && this.punchCd <= 0 && this.state !== 'landing') {
      this.punchT = 0.3;
      this.punchCd = 0.45;
      const aim = dirFromYawPitch(aimYaw, aimPitch, this._w);
      this._t.copy(this.pos); this._t.y += 0.4;
      G.destruction.punch(this._t, aim);
      if (this.state === 'flight' && this.speed < 30) this.vel.addScaledVector(aim, -6);   // 反冲
    }
    // ---------- 目光射线 ----------
    this.beamOn = inp.rmb && this.state !== 'landing';
  }

  _enterHyper() {
    this.hyper = true;
    this.hyperOff = 0;
    const sp = this.vel.length();
    if (sp > 1) this.vel.multiplyScalar((sp + CFG.hero.hyperKick) / sp);
    else this.vel.copy(this._f).multiplyScalar(CFG.hero.hyperKick);
    G.audio.hyperKick();
    G.rig.fovKick(9);
    G.rig.kickBack(4);
    G.post.pulse(0.7);
    G.shock.ring(this.pos, this._t.copy(this.vel).normalize(), 1, 26, 0.5, 0.6, 0xdfeaff, false, 0.5);
    if (G.hud) G.hud.banner('极速', 'hyper', 0.9);
  }

  _takeoff() {
    this.state = 'flight';
    this.vel.y = Math.max(this.vel.y, 15);
    this.dir.copy(this.vel).normalize();
    G.audio.takeoff(1);
    const gy = this.pos.y - CFG.hero.hipHeight;
    this._t.set(this.pos.x, gy + 0.3, this.pos.z);
    G.shock.ring(this._t, this._t2 || (this._t2 = new THREE.Vector3(0, 1, 0)), 0.5, 9, 0.6, 0.45, 0xd9d2c4, false, 0.4);
    G.destruction.dust(this.pos.x, gy + 0.5, this.pos.z, 8, 2.2, 1.5, 6, 2.5);
  }

  /* ---------------- 步行 ---------------- */
  _ground(dt, inp, yaw) {
    const C = CFG.hero;
    const f = inp.forward, s = inp.strafe;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let wx = fx * f + rx * s, wz = fz * f + rz * s;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const target = inp.shift ? C.sprint : C.walk;
    this.vel.x = U.damp(this.vel.x, wx * target, 10, dt);
    this.vel.z = U.damp(this.vel.z, wz * target, 10, dt);
    this.vel.y = 0;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.6) this.heading = U.dampAngle(this.heading, Math.atan2(-this.vel.x, -this.vel.z), 12, dt);
    if (inp.rmb) this.heading = U.dampAngle(this.heading, yaw, 10, dt);
    if (inp.hit('Space') || inp.vertical > 0) this._takeoff();
  }

  /* ---------------- 飞行 ---------------- */
  _flight(dt, inp, fwd, right, f, st, vt, aimYaw) {
    const C = CFG.hero;
    const wish = this._w.set(0, 0, 0).addScaledVector(fwd, f).addScaledVector(right, st);
    wish.y += vt;
    const wl = wish.length();
    let speed = this.vel.length();
    const dir = this.dir;
    if (speed > 0.5) dir.copy(this.vel).multiplyScalar(1 / speed);
    let braking = 0;
    if (inp.down('KeyX')) {
      // 紧急停止
      if (inp.hit('KeyX') && speed > 25) {
        G.audio.airBrake();
        G.rig.addTrauma(0.25 + speed / 900);
        this._t.copy(this.pos).addScaledVector(dir, 3);
        G.shock.ring(this._t, dir, 1, 10 + speed * 0.06, 0.45, 0.7, 0xffffff, false, 0.4);
        G.destruction.dust(this._t.x, this._t.y, this._t.z, 6, 2, 1, 5 + speed * 0.03, 1.5, [0.8, 0.82, 0.85], 0.35);
      }
      speed = Math.max(0, speed - 950 * dt);
      braking = speed > 3 ? 1 : 0.4;
    } else if (wl > 0.01) {
      wish.multiplyScalar(1 / wl);
      let tier, accel;
      if (this.hyper) { tier = C.hyper; accel = C.hyperAccel; }
      else if (this.boost) { tier = C.boost; accel = C.boostAccel; }
      else { tier = C.fly; accel = C.flyAccel; }
      const along = Math.max(0, wish.dot(fwd));
      let target = tier * U.lerp(0.45, 1, along);
      if (!this.hyper && f <= 0) target = Math.min(target, this.boost ? 95 : 24);
      if (speed < 8) dir.copy(wish);
      else {
        const cosA = dir.dot(wish);
        if (cosA < -0.3 && speed > 25) {
          // 反向输入：先刹车再掉头
          speed = Math.max(0, speed - 280 * dt);
          braking = 0.75;
        } else {
          const rate = U.lerp(C.turnRateLow, C.turnRateHigh, U.smooth(20, 420, speed));
          rotateToward(dir, wish, rate * dt);
        }
      }
      if (speed < target) speed = Math.min(target, speed + accel * dt);
      else speed = Math.max(target, speed - (this.hyper ? 140 : 170) * dt);
    } else {
      // 无输入：滑行减速至悬停（高速时减速更慢，体现惯性）；
      // 但若正在向下俯冲，则不减速反而借重力加速，保证俯冲砸地的冲击力
      const down = speed > 70 ? Math.max(0, -dir.y) : 0;
      speed *= Math.exp(-(speed > 140 ? 0.9 : 2.3) * (1 - down) * dt);
      speed += 14 * down * dt;
      if (speed < 0.3) speed = 0;
    }
    this.brake = U.damp(this.brake, braking, braking > this.brake ? 12 : 5, dt);
    this.vel.copy(dir).multiplyScalar(speed);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 4 && !inp.rmb) this.heading = U.dampAngle(this.heading, Math.atan2(-this.vel.x, -this.vel.z), 9, dt);
    else this.heading = U.dampAngle(this.heading, aimYaw, inp.rmb ? 10 : 3.5, dt);
  }

  /* ---------------- 移动与建筑碰撞 ---------------- */
  _move(dt) {
    const disp = this._s.copy(this.vel).multiplyScalar(dt);
    const len = disp.length();
    if (len < 1e-6) { this._insideCheck(); return; }
    const n = U.clamp(Math.ceil(len / 2.5), 1, 18);
    const step = disp.multiplyScalar(1 / n);
    for (let i = 0; i < n; i++) {
      this._stepBuildings(step, n, dt);
      this.pos.add(step);
    }
  }

  /** 静止时也检查：建筑坍塌或落到身上 */
  _insideCheck() {
    for (const [id, hole] of this.inside) {
      const b = this.city.buildings[id];
      if (b.state === 2) this.inside.delete(id);
    }
  }

  _stepBuildings(step, n, dt) {
    const C = CFG.hero, R = C.radius, p = this.pos;
    const nx = p.x + step.x, ny = p.y + step.y, nz = p.z + step.z;
    const src = this.city.queryBuildings(Math.min(p.x, nx) - R - 1, Math.min(p.z, nz) - R - 1, Math.max(p.x, nx) + R + 1, Math.max(p.z, nz) + R + 1);
    const list = this._list;
    list.length = 0;
    for (let k = 0; k < src.length; k++) list.push(src[k]);
    const speed = this.vel.length();
    const dx = speed > 0.01 ? this.vel.x / speed : 0, dy = speed > 0.01 ? this.vel.y / speed : 0, dz = speed > 0.01 ? this.vel.z / speed : 0;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (b.state === 2) { this.inside.delete(b.id); continue; }
      const top = b.y1 - b.sink, bot = b.y0 - b.sink;
      const x0 = b.x0 - R, x1 = b.x1 + R, y0 = bot - R, y1 = top + R, z0 = b.z0 - R, z1 = b.z1 + R;
      const inNow = p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1 && p.z > z0 && p.z < z1;
      const ex = p.x + step.x, ey = p.y + step.y, ez = p.z + step.z;
      const inNext = ex > x0 && ex < x1 && ey > y0 && ey < y1 && ez > z0 && ez < z1;
      let hole = this.inside.get(b.id);
      if (inNow) {
        if (!hole) {
          // 没有记录却在内部（例如出生 / 坍塌）：直接开始穿行
          if (b.kind === BK.HOUSE || b.kind === BK.SHOP) { G.destruction.obliterate(b, p.x, p.y, p.z, dx, dy, dz, Math.max(speed, 30)); continue; }
          this.city.ensureInterior(b);
          hole = { slot: -1, r: 2.6 };
          this.inside.set(b.id, hole);
        }
        if (inNext) {
          this._carve(b, hole, ex, ey, ez, dx, dy, dz, speed);
          if (speed > 30) this.vel.multiplyScalar(Math.exp(-0.25 * dt / n));
        } else {
          // 冲出建筑：判断从哪个面离开
          const fx = Math.min(ex - x0, x1 - ex), fy = Math.min(ey - y0, y1 - ey), fz = Math.min(ez - z0, z1 - ez);
          let nX = 0, nY = 0, nZ = 0;
          if (ex <= x0 || ex >= x1) nX = ex <= x0 ? -1 : 1;
          else if (ez <= z0 || ez >= z1) nZ = ez <= z0 ? -1 : 1;
          else if (ey <= y0 || ey >= y1) nY = ey <= y0 ? -1 : 1;
          else if (fx < fy && fx < fz) nX = Math.sign(dx) || 1; else if (fz < fy) nZ = Math.sign(dz) || 1; else nY = Math.sign(dy) || 1;
          if (hole.slot < 0 && !this.city.holes.insideHole(b.id, ex, ey + b.sink, ez, 0)) {
            hole.slot = this.city.holes.add(b.id, p.x, p.y + b.sink, p.z, ex, ey + b.sink, ez, hole.r, HOLE.SMASH);
          }
          if (hole.slot >= 0) G.destruction.exitBurst(b, hole, ex, ey, ez, nX, nY, nZ, dx, dy, dz, speed);
          this.inside.delete(b.id);
        }
        continue;
      }
      // 是否在本子步内撞入
      if (!segAABB(p.x, p.y, p.z, step.x, step.y, step.z, x0, y0, z0, x1, y1, z1, this._hit)) continue;
      const t = this._hit.t;
      const hx = p.x + step.x * t, hy = p.y + step.y * t, hz = p.z + step.z * t;
      const nX = this._hit.axis === 0 ? this._hit.sign : 0, nY = this._hit.axis === 1 ? this._hit.sign : 0, nZ = this._hit.axis === 2 ? this._hit.sign : 0;
      // 从已有破洞进入：无需再撞
      if (this.city.holes.insideHole(b.id, hx, hy + b.sink, hz, R * 0.5)) {
        this.inside.set(b.id, { slot: -1, r: 2.6 });
        continue;
      }
      const small = b.kind === BK.HOUSE || b.kind === BK.SHOP;
      // 普通速度垂直下降到屋顶 = 落在屋顶上；加速 / 极速 / 高速俯冲才会砸穿屋顶
      const roofSoft = nY > 0 && -this.vel.y < 32 && !this.hyper && !this.boost;
      if (!roofSoft && (speed >= C.smashSpeed || (small && speed > 12))) {
        const res = G.destruction.smash(b, hx - nX * R, hy - nY * R, hz - nZ * R, nX, nY, nZ, dx, dy, dz, speed);
        const loss = U.clamp(0.32 - speed / 1300, 0.025, 0.32) * (small ? 0.4 : 1);
        this.vel.multiplyScalar(1 - loss);
        step.multiplyScalar(1 - loss);
        if (res) this.inside.set(b.id, res);
      } else {
        // 被挡住：沿墙面滑动
        const rem = 1 - t;
        const sx = step.x * rem, sy = step.y * rem, sz = step.z * rem;
        const dot = sx * nX + sy * nY + sz * nZ;
        step.set(step.x * t + sx - nX * Math.min(0, dot) + nX * 0.002, step.y * t + sy - nY * Math.min(0, dot) + nY * 0.002, step.z * t + sz - nZ * Math.min(0, dot) + nZ * 0.002);
        const vd = this.vel.x * nX + this.vel.y * nY + this.vel.z * nZ;
        if (vd < 0) { this.vel.x -= nX * vd; this.vel.y -= nY * vd; this.vel.z -= nZ * vd; }
        if (speed > 8 && nY === 0) { G.audio.land(0.4); G.destruction.dust(hx, hy, hz, 2, 1.5, 0.5, 2, 2); }
      }
    }
  }

  _carve(b, hole, x, y, z, dx, dy, dz, speed) {
    if (hole.slot < 0) {
      // 沿已有隧道穿行时不需要新开洞
      if (this.city.holes.insideHole(b.id, x, y + b.sink, z, CFG.hero.radius * 0.4)) return;
      hole.slot = this.city.holes.add(b.id, x - dx * 1.5, y - dy * 1.5 + b.sink, z - dz * 1.5, x, y + b.sink, z, hole.r, HOLE.SMASH);
      return;
    }
    G.destruction.carve(b, hole, x, y, z, dx, dy, dz, speed);
  }

  /* ---------------- 地面 / 屋顶 ---------------- */
  _groundCheck(dt) {
    const C = CFG.hero;
    const feet = this.pos.y - C.hipHeight;
    const gh = this.city.groundHeight(this.pos.x, this.pos.z, feet + (this.state === 'ground' ? 0.6 : 0));
    if (this.state === 'ground' || this.state === 'landing') {
      if (feet > gh + 0.7 && this.state === 'ground') {
        // 走出屋顶边缘 → 自动悬停
        this.state = 'flight';
        this.dir.set(0, -1, 0);
        return;
      }
      this.pos.y = gh + C.hipHeight;
      return;
    }
    if (feet >= gh) return;
    const vy = this.vel.y, sp = this.vel.length();
    if (-vy > C.slamSpeed || (sp > 160 && -vy > 38)) {
      // 俯冲砸地
      this.pos.y = gh + C.hipHeight;
      G.destruction.groundSlam(this._t.set(this.pos.x, gh, this.pos.z), -vy + sp * 0.25);
      this.vel.set(0, 0, 0);
      this.hyper = false;
      this.state = 'landing';
      this.landT = 0.85;
      return;
    }
    this.pos.y = gh + C.hipHeight;
    if (sp < 22 && vy <= 0.5) {
      this.state = 'ground';
      this.vel.y = 0;
      this.hyper = false;
      G.audio.land(U.clamp(-vy / 15, 0.3, 1));
      if (-vy > 6) G.destruction.dust(this.pos.x, gh + 0.4, this.pos.z, 6, 2, 1.2, 4, 2);
    } else if (vy < 0) {
      // 高速贴地滑行
      this.vel.y = 0;
      if (this.dir.y < 0) { this.dir.y = 0; this.dir.normalize(); }
    }
  }

  /* ---------------- 道具 / 车辆 ---------------- */
  _props(p0, p1) {
    const C = CFG.hero, R = C.radius;
    const speed = this.vel.length();
    const ax = p0.x, az = p0.z, bx = p1.x, bz = p1.z;
    const abx = bx - ax, abz = bz - az, ll = abx * abx + abz * abz;
    const yLow = Math.min(p0.y, p1.y) - C.hipHeight;
    const slow = this.state !== 'flight' || speed < 10;
    const closest = (x, z) => {
      let t = ll > 1e-8 ? ((x - ax) * abx + (z - az) * abz) / ll : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return t;
    };
    const props = this.city.props;
    const list = props.query(Math.min(ax, bx) - 3, Math.min(az, bz) - 3, Math.max(ax, bx) + 3, Math.max(az, bz) + 3);
    const hits = list.slice();
    for (const p of hits) {
      const T = props.types[p.t];
      if (yLow > T.h * p.s) continue;
      const t = closest(p.x, p.z);
      const cx = ax + abx * t, cz = az + abz * t;
      const d = Math.hypot(p.x - cx, p.z - cz);
      const rr = R + T.r * p.s;
      if (d >= rr) continue;
      if (slow) {
        // 慢速：被挡住
        const l = d || 1;
        this.pos.x = p.x + (cx - p.x) / l * rr;
        this.pos.z = p.z + (cz - p.z) / l * rr;
        continue;
      }
      G.destruction.hitProp(p, this.vel.x, this.vel.y, this.vel.z, speed);
      this.vel.multiplyScalar(T.heavy ? 0.9 : 0.985);
    }
    const tr = this.city.traffic;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const cars = tr.queryNear(mx, mz, Math.sqrt(ll) / 2 + 9).slice();
    for (const car of cars) {
      const md = tr.models[car.m];
      if (yLow > md.hy * 2) continue;
      const t = closest(car.x, car.z);
      const cx = ax + abx * t - car.x, cz = az + abz * t - car.z;
      const c = Math.cos(car.yaw), s = Math.sin(car.yaw);
      const lx = cx * c - cz * s, lz = cx * s + cz * c;
      if (Math.abs(lx) > md.hx + R || Math.abs(lz) > md.hz + R) continue;
      if (slow) {
        const l = Math.hypot(cx, cz) || 1;
        const rr = Math.max(md.hz, 1) + R + 0.2;
        if (l < rr + md.hx) { this.pos.x = car.x + cx / l * Math.max(l, rr); this.pos.z = car.z + cz / l * Math.max(l, rr); }
        continue;
      }
      G.destruction.hitCar(car, this.vel.x, this.vel.y, this.vel.z, speed);
      this.vel.multiplyScalar(0.98);
    }
  }

  /* ---------------- 世界边界 ---------------- */
  _boundary(dt) {
    const B = this.city.half + CFG.city.shore + 1000;
    const p = this.pos, v = this.vel;
    let near = false;
    for (const ax of ['x', 'z']) {
      const o = Math.abs(p[ax]) - B;
      if (o > -250) near = true;
      if (o > 0) {
        const s = Math.sign(p[ax]);
        if (v[ax] * s > 0) v[ax] -= s * Math.min(Math.abs(v[ax]), (300 + Math.abs(v[ax]) * 3) * dt);
        if (o > 150) p[ax] = s * (B + 150);
      }
    }
    if (p.y > 3200) { p.y = 3200; if (v.y > 0) v.y = 0; }
    this.nearBoundary = near;
    if (this.speed > 0.5) this.dir.copy(v).normalize();
  }

  /* ---------------- 贴近建筑：风压声与沿途碎窗 ---------------- */
  _proximity() {
    const sp = this.speed;
    if (sp < 35 || this.state !== 'flight') { this.pressure = 0; return; }
    const r = 20, p = this.pos;
    const list = this.city.queryBuildings(p.x - r, p.z - r, p.x + r, p.z + r);
    let best = r, bb = null, bx = 0, by = 0, bz = 0;
    for (let k = 0; k < list.length; k++) {
      const b = list[k];
      if (b.state === 2 || this.inside.has(b.id)) continue;
      const cx = U.clamp(p.x, b.x0, b.x1), cy = U.clamp(p.y, b.y0, b.y1 - b.sink), cz = U.clamp(p.z, b.z0, b.z1);
      const d = Math.hypot(cx - p.x, cy - p.y, cz - p.z);
      if (d < best) { best = d; bb = b; bx = cx; by = cy; bz = cz; }
    }
    this.pressure = bb ? Math.pow(1 - best / r, 1.3) : 0;
    if (bb) {
      const cam = G.camera;
      this._t.set(1, 0, 0).applyQuaternion(cam.quaternion);
      const l = best || 1;
      this.pressurePan = ((bx - p.x) * this._t.x + (by - p.y) * this._t.y + (bz - p.z) * this._t.z) / l;
      if (sp > 220 && best < 12) G.destruction.windowBlast(bb, bx, by, bz, sp);
    }
    if (this.pressure > 0.5 && !this._near) {
      this._near = true;
      G.audio.whoosh(U.clamp(sp / 200, 0.3, 1), this.pressurePan);
    } else if (this.pressure < 0.25) this._near = false;
  }
}
