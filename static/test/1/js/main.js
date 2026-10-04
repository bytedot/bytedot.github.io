'use strict';
/* =====================================================================
 * main.js — 启动、主循环、菜单 / 暂停、自适应分辨率
 * ===================================================================== */

(function () {
  const fatal = (msg) => {
    const el = document.getElementById('fatal');
    el.innerHTML = msg;
    el.classList.remove('hidden');
  };
  if (typeof THREE === 'undefined') {
    fatal('无法加载 Three.js。<br>本游戏需要联网从 CDN 加载 Three.js，请检查网络后刷新页面。');
    return;
  }

  /* ---------------- 渲染器与场景 ---------------- */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  } catch (e) {
    fatal('无法创建 WebGL 上下文。<br>请使用最新版 Chrome / Edge / Firefox，并确认已开启硬件加速。');
    return;
  }
  if (!renderer.capabilities.isWebGL2) {
    fatal('当前浏览器不支持 WebGL 2，无法运行本游戏。<br>请使用最新版 Chrome / Edge / Firefox。');
    return;
  }
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CFG.camera.fovBase, window.innerWidth / window.innerHeight, 0.5, 32000);
  G.renderer = renderer;
  G.scene = scene;
  G.camera = camera;

  const startBtn = document.getElementById('startBtn');
  const menu = document.getElementById('menu');
  const pauseEl = document.getElementById('pause');
  const resumeBtn = document.getElementById('resumeBtn');

  let playing = false;
  let paused = false;
  let ready = false;
  let renderScale = 1;
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /* ---------------- 构建世界 ---------------- */
  async function boot() {
    startBtn.textContent = '正在生成城市…';
    await nextFrame();
    const city = G.city = new City(scene);
    city.generate();
    startBtn.textContent = '正在布置光照…';
    await nextFrame();
    const env = G.env = new Environment(scene, renderer);
    env.build(city);

    // 粒子与特效对象池
    G.dust = new Particles(scene, { max: CFG.pools.dust, texture: makePuffTexture(), sort: true, renderOrder: 5 });
    const glowTex = makeRadialTexture(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]);
    G.glow = new Particles(scene, { max: CFG.pools.glow, texture: glowTex, additive: true, stretch: 0.035, renderOrder: 6 });
    const chunkGeo = jitterGeo(new THREE.IcosahedronGeometry(0.6, 0), 0.35, mulberry(3));
    G.debris = new Debris(scene, CFG.pools.debris, chunkGeo,
      new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0.05, flatShading: true }), true);
    const shardGeo = new THREE.BufferGeometry();
    shardGeo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.4, 0, 0.5, -0.3, 0, -0.1, 0.6, 0], 3));
    shardGeo.computeVertexNormals();
    G.shards = new Debris(scene, CFG.pools.shards, shardGeo,
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.05, metalness: 1.0, side: THREE.DoubleSide, envMapIntensity: 1.6 }), false);
    G.shock = new ShockFX(scene);
    G.trail = new TrailRibbon(scene);
    G.streaks = new SpeedStreaks(scene);
    G.vapor = new VaporCone(scene);
    G.beams = new EyeBeams(scene);
    G.destruction = new Destruction(scene, city, env);
    G.hero = new HeroController(city);
    G.model = new HeroModel(scene);
    G.rig = new CameraRig(camera);
    G.post = new PostFX(renderer);
    G.hud = new HUD();
    G.audio = new AudioEngine();
    G.input = new Input(renderer.domElement);
    G.input.onLockChange = onLockChange;
    resize();
    startBtn.textContent = '正在编译着色器…';
    await nextFrame();
    G.model.update(0.016, modelState(0.016));
    G.rig.update(0.016, G.hero, G.model);
    warmUp();
    ready = true;
    startBtn.disabled = false;
    startBtn.textContent = '开始游戏';
    startBtn.focus();
  }

  /**
   * 预热：把所有平时隐藏 / 数量为 0 的对象临时显示出来，编译着色器并真正绘制一帧，
   * 避免第一次撞击、第一次音爆时因为着色器编译出现明显卡顿。
   */
  function warmUp() {
    const restore = [];
    scene.traverse((o) => {
      if ((o.isMesh || o.isSprite) && !o.visible) { o.visible = true; restore.push(() => { o.visible = false; }); }
      if (o.isInstancedMesh && o.count === 0) { o.count = 1; restore.push(() => { o.count = 0; }); }
      const g = o.geometry;
      if (g && g.isInstancedBufferGeometry && g.instanceCount === 0) { g.instanceCount = 1; restore.push(() => { g.instanceCount = 0; }); }
      if (g && g.drawRange && g.drawRange.count === 0) { g.setDrawRange(0, 6); restore.push(() => { g.setDrawRange(0, 0); }); }
    });
    try {
      renderer.compile(scene, camera);
      G.post.render(scene, camera, { time: 0, dt: 0.016, speed: 0, hyper: false, vel: G.hero.vel, heroPos: G.hero.pos });
    } catch (e) { /* 某些驱动不支持预编译，忽略 */ }
    for (const f of restore) f();
  }

  /* ---------------- 菜单 / 暂停 ---------------- */
  function startGame() {
    if (!ready) return;
    G.audio.init();
    menu.classList.add('hidden');
    pauseEl.classList.add('hidden');
    G.hud.show(true);
    G.input.enabled = true;
    G.input.reset();
    G.input.requestLock();
    if (!playing) G.rig.begin(G.hero.heading);
    playing = true;
    paused = false;
    G.audio.resume();
    window.addEventListener('beforeunload', guardUnload);
  }

  // 防止误按 Ctrl+W 等快捷键直接关闭页面
  function guardUnload(e) {
    if (!playing) return;
    e.preventDefault();
    e.returnValue = '';
  }

  function setPaused(p) {
    if (!playing) return;
    paused = p;
    pauseEl.classList.toggle('hidden', !p);
    G.input.enabled = !p;
    if (p) { G.input.reset(); G.audio.suspend(); }
    else G.audio.resume();
  }

  function onLockChange(locked) {
    if (!playing) return;
    if (!locked && !G.input.fallback) setPaused(true);
    else if (locked) setPaused(false);
  }

  startBtn.addEventListener('click', startGame);
  resumeBtn.addEventListener('click', () => {
    G.audio.init();
    setPaused(false);
    G.input.requestLock();
  });

  window.addEventListener('keydown', (e) => {
    if (!playing) {
      if ((e.code === 'Enter' || e.code === 'Space') && ready && !menu.classList.contains('hidden')) { e.preventDefault(); startGame(); }
      return;
    }
    if (e.code === 'KeyH') G.hud.toggleHints();
    if (e.code === 'KeyM') G.audio.setMuted(!G.audio.muted);
    if (e.code === 'Backquote') G.hud.toggleFps();
    if (e.code === 'Escape' && G.input.fallback) setPaused(!paused);
    if (e.code === 'KeyP') { if (!paused) { setPaused(true); G.input.exitLock(); } }
  });

  /* ---------------- 尺寸与自适应分辨率 ---------------- */
  function pixelRatio() { return Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio) * renderScale; }
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (G.post) G.post.setSize(w, h, pixelRatio());
  }
  window.addEventListener('resize', resize);

  let perfT = 0, perfN = 0, perfSum = 0;
  function adapt(dtReal) {
    perfSum += dtReal; perfN++; perfT += dtReal;
    if (perfT < 1.5) return;
    const avg = perfSum / perfN;
    perfT = perfSum = perfN = 0;
    let s = renderScale;
    if (avg > 1 / 45 && s > 0.6) s = Math.max(0.6, s - 0.1);
    else if (avg < 1 / 57 && s < 1) s = Math.min(1, s + 0.05);
    if (s !== renderScale) {
      renderScale = s;
      G.post.setSize(window.innerWidth, window.innerHeight, pixelRatio());
    }
  }

  /* ---------------- 主循环 ---------------- */
  function modelState(dt) {
    const h = G.hero;
    return {
      pos: h.pos, vel: h.vel, speed: h.speed, state: h.state, heading: h.heading, faceYaw: G.rig.aimYaw,
      hyper: h.hyper, brake: h.brake, punchT: h.punchT, beam: h.beamOn, groundSpeed: Math.hypot(h.vel.x, h.vel.z),
      aimPitch: G.rig.aimPitch,
    };
  }

  let last = performance.now();
  let time = 0;
  const eyeL = new THREE.Vector3(), eyeR = new THREE.Vector3(), aim = new THREE.Vector3(), tmp = new THREE.Vector3(), trailP = new THREE.Vector3();

  function loop(now) {
    requestAnimationFrame(loop);
    const dtReal = Math.min(0.05, Math.max(0.0001, (now - last) / 1000));
    last = now;
    if (!ready) return;
    if (paused) {
      G.post.render(scene, camera, { time, dt: dtReal, speed: 0, hyper: false, vel: G.hero.vel, heroPos: G.hero.pos });
      return;
    }
    // 顿帧：重击瞬间时间放慢
    let ts = 1;
    if (G.destruction.hitstop > 0) { G.destruction.hitstop -= dtReal; ts = 0.12; }
    const dt = dtReal * ts;
    time += dt;
    const inp = G.input;
    const hero = G.hero;

    if (playing) {
      G.rig.applyMouse(inp.mx, inp.my);
      if (inp.wheel) G.rig.zoom = U.clamp(G.rig.zoom * (inp.wheel > 0 ? 1.12 : 0.89), 0.6, 2.2);
      hero.update(dt, inp, G.rig.aimYaw, G.rig.aimPitch);
    }

    G.city.update(dt, camera);
    G.destruction.update(dt);
    G.model.update(dt, modelState(dt));

    // ---- 飞行特效 ----
    const sp = hero.speed;
    const dirV = tmp.copy(hero.vel);
    if (sp > 0.01) dirV.multiplyScalar(1 / sp); else dirV.set(0, 0, -1);
    trailP.copy(hero.pos).addScaledVector(dirV, -0.6);
    G.trail.push(trailP, hero.state === 'flight' ? U.smooth(130, 330, sp) * (hero.hyper ? 1 : 0.55) : 0, time);
    G.trail.update(time, camera);
    G.streaks.update(dt, camera, hero.vel, hero.state === 'flight' ? sp : 0);
    G.vapor.update(dt, hero.pos, dirV, hero.state === 'flight' && hero.hyper ? sp : 0, time);
    // 极速时的云雾拖尾粒子
    if (hero.state === 'flight' && sp > 220) {
      const n = hero.hyper ? 3 : 1;
      for (let i = 0; i < n; i++) {
        const k = Math.random();
        G.dust.emit(hero.pos.x - hero.vel.x * dt * k + U.rand(-0.6, 0.6), hero.pos.y - hero.vel.y * dt * k + U.rand(-0.6, 0.6), hero.pos.z - hero.vel.z * dt * k + U.rand(-0.6, 0.6),
          U.rand(-2, 2), U.rand(-1, 2), U.rand(-2, 2), U.rand(0.8, 1.6), 0.8, 4.5, 0.85, 0.88, 0.92, 0.22, 2, 0, U.rand(-1, 1));
      }
    }
    // ---- 目光射线 ----
    let beamActive = false;
    if (playing && hero.beamOn) {
      dirFromYawPitch(G.rig.aimYaw, G.rig.aimPitch, aim);
      const origin = eyeL.copy(camera.position).addScaledVector(aim, G.rig.dist + 1);
      const r = G.destruction.beam(dt, origin, aim);
      if (r) hero.beamTarget.set(r.x, r.y, r.z);
      else hero.beamTarget.copy(origin).addScaledVector(aim, 1500);
      beamActive = true;
    } else G.destruction.beamCut = null;
    G.model.eyeWorld(true, eyeL);
    G.model.eyeWorld(false, eyeR);
    G.beams.update(time, beamActive, eyeL, eyeR, hero.beamTarget, camera);

    G.dust.update(dt, camera);
    G.glow.update(dt, camera);
    G.debris.update(dt);
    G.shards.update(dt, 10);
    G.shock.update(dt);

    G.rig.update(dtReal, hero, G.model);
    G.env.update(dt, camera, hero.pos);
    syncFogUniforms(scene.fog);
    SWAY_U.uTime.value = time;
    SWAY_U.uHeroPos.value.copy(hero.pos);
    SWAY_U.uHeroSpeed.value = hero.state === 'flight' ? sp : 0;
    G.city.holes.flush(renderer);

    G.audio.update({
      speed: hero.state === 'flight' ? sp : 0,
      hyper: hero.hyper ? U.smooth(150, 400, sp) : 0,
      pressure: hero.pressure,
      pressurePan: hero.pressurePan,
      beam: beamActive,
      active: playing,
    });
    if (playing) G.hud.update(dtReal, hero);

    G.post.render(scene, camera, { time, dt: dtReal, speed: hero.state === 'flight' ? sp : 0, hyper: hero.hyper, vel: hero.vel, heroPos: hero.pos });
    inp.endFrame();
    adapt(dtReal);
  }

  requestAnimationFrame(loop);
  boot().catch((e) => {
    console.error(e);
    fatal('初始化失败：' + (e && e.message ? e.message : e));
  });
})();
