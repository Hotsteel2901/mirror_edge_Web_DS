import * as THREE from '../vendor/three.module.js';
import { clamp, damp, dampAngle, PHYS } from './util.js';
import { audio } from './audio.js';
import { skillEffect } from './profile.js';

/* =========================================================================
   玩家控制器 —— 镜之边缘风格第一人称跑酷
   ------------------------------------------------------------------------
   状态机：normal / crouch / slide / roll / mantle / vault / wallrun /
           climb / zipline / turn / dead
   连贯性设计：
   · 蹬墙跑冷却 + 连锁，墙面跳后仍可接住下一面墙
   · 落地保留全部水平动量；高冲击自动翻滚提速
   · 翻越 / 攀抓 / 滑铲 / 滑索全程不打断速度
   · 冲刺 180° 急转（S），像 Faith 一样贴地掉头
   ========================================================================= */

/* 射线过滤谓词提到模块级，避免每次调用都新建闭包（物理子步每帧会调用多次） */
const notZone = (b) => b.kind !== 'zone';
const isVaultable = (b) => b.kind === 'solid' && !b.street && !b.building;
const isMantleable = (b) => b.kind === 'solid' && b.mantle === true;

export function createPlayer(world, hooks) {
  const P = {
    pos: new THREE.Vector3(world.spawnPoint.x, world.spawnPoint.y + 0.06, world.spawnPoint.z),
    vel: new THREE.Vector3(),
    yaw: world.spawnPoint.yaw,
    pitch: 0,
    roll: 0,
    rollAnim: 0,
    height: PHYS.PLAYER_HEIGHT,
    eye: PHYS.EYE_HEIGHT,
    grounded: false,
    coyote: 0,
    jumpBuffer: 0,
    stamina: 100,
    exhausted: false,
    momentum: 0,
    moveState: 'normal',
    stateTime: 0,
    slide: null,
    mantle: null,
    vault: null,
    wallrun: null,
    climb: null,
    zipline: null,
    turn: null,
    deadTimer: 0,
    fallStartY: world.spawnPoint.y,
    airTime: 0,
    impact: 0,
    stepTimer: 0,
    foot: 0,
    bobTime: 0,
    bobY: 0,
    bobX: 0,
    landDip: 0,
    fovKick: 0,
    trauma: 0,
    damageFlash: 0,
    climbStepAcc: 0,
    slideSoundAcc: 0,
    wallCooldown: 0,
    onBounce: false,
    surface: 'concrete',
    lastSafe: { pos: new THREE.Vector3(world.spawnPoint.x, world.spawnPoint.y + 0.06, world.spawnPoint.z), yaw: world.spawnPoint.yaw },
    safeTimer: 0,
    deathReason: '',
  };

  let jumpQueued = false;
  let interactTimer = 0;
  P.physSteps = 0;

  /* 零分配热路径：所有逐帧运算复用同一批临时向量 */
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _probe = new THREE.Vector3();
  const _wish = new THREE.Vector3();
  const _zipDir = new THREE.Vector3();
  const _zipTmp = new THREE.Vector3();
  const forwardVec = () => { _fwd.set(-Math.sin(P.yaw), 0, -Math.cos(P.yaw)); return _fwd; };
  const rightVec = () => { _right.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw)); return _right; };
  const horizSpeed = () => Math.hypot(P.vel.x, P.vel.z);

  function queueJump() { jumpQueued = true; }
  function queueInteract() { interactTimer = 0.32; P.interactTimer = 0.32; }

  function setState(s) {
    P.moveState = s;
    P.stateTime = 0;
  }

  function gain(base, label) {
    if (P.moveState === 'dead') return;
    hooks.onFlow(base, label);
  }
  function stat(key, n = 1) { hooks.onStat(key, n); }

  /* ------------------------------------------------------ 碰撞 */
  const sweepMin = new THREE.Vector3();
  const sweepMax = new THREE.Vector3();
  const sweepOut = [];

  function resolveCollisions() {
    let bounceBox = null;
    const height = P.height;
    for (let iter = 0; iter < 3; iter++) {
      sweepMin.set(P.pos.x - PHYS.PLAYER_RADIUS - 0.05, P.pos.y - 0.02, P.pos.z - PHYS.PLAYER_RADIUS - 0.05);
      sweepMax.set(P.pos.x + PHYS.PLAYER_RADIUS + 0.05, P.pos.y + height + 0.02, P.pos.z + PHYS.PLAYER_RADIUS + 0.05);
      world.queryAABB(sweepMin, sweepMax, sweepOut);
      for (const b of sweepOut) {
        if (P.moveState === 'wallrun' && b.wallSolid) continue;
        const pminx = P.pos.x - PHYS.PLAYER_RADIUS, pmaxx = P.pos.x + PHYS.PLAYER_RADIUS;
        const pminy = P.pos.y, pmaxy = P.pos.y + height;
        const pminz = P.pos.z - PHYS.PLAYER_RADIUS, pmaxz = P.pos.z + PHYS.PLAYER_RADIUS;
        const ox = Math.min(pmaxx, b.max.x) - Math.max(pminx, b.min.x);
        const oy = Math.min(pmaxy, b.max.y) - Math.max(pminy, b.min.y);
        const oz = Math.min(pmaxz, b.max.z) - Math.max(pminz, b.min.z);
        if (ox <= 0 || oy <= 0 || oz <= 0) continue;
        const cy = P.pos.y + height * 0.5;
        const bcy = (b.min.y + b.max.y) * 0.5;
        const stepUp = b.max.y - P.pos.y;
        if (oy <= PHYS.AUTO_STEP_MAX + 0.06 && stepUp >= 0.02 && stepUp <= PHYS.AUTO_STEP_MAX && P.vel.y <= 0.01) {
          if (P.vel.y < 0) P.vel.y = 0;
          P.pos.y = b.max.y;
          P.surface = b.surface || 'concrete';
          if (b.kind === 'bounce') bounceBox = b;
          continue;
        }
        if (oy < ox && oy < oz) {
          if (cy > bcy) {
            if (P.vel.y < 0) P.vel.y = 0;
            P.pos.y = b.max.y;
            P.surface = b.surface || 'concrete';
            if (b.kind === 'bounce') bounceBox = b;
          } else {
            if (P.vel.y > 0) P.vel.y = 0;
            P.pos.y = b.min.y - height;
          }
        } else if (ox <= oz) {
          if (P.pos.x < (b.min.x + b.max.x) * 0.5) P.pos.x = b.min.x - PHYS.PLAYER_RADIUS;
          else P.pos.x = b.max.x + PHYS.PLAYER_RADIUS;
          P.vel.x = 0;
        } else {
          if (P.pos.z < (b.min.z + b.max.z) * 0.5) P.pos.z = b.min.z - PHYS.PLAYER_RADIUS;
          else P.pos.z = b.max.z + PHYS.PLAYER_RADIUS;
          P.vel.z = 0;
        }
      }
    }
    return bounceBox;
  }

  const downDir = new THREE.Vector3(0, -1, 0);
  const groundOut = [];

  function findGround() {
    if (P.vel.y > 0.6) { P.grounded = false; return null; }
    _probe.set(P.pos.x, P.pos.y + 0.5, P.pos.z);
    const hit = world.rayCast(_probe, downDir, 0.96, notZone);
    if (hit) {
      const gy = _probe.y - hit.t;
      if (gy >= P.pos.y - 0.36 && gy <= P.pos.y + 0.07) {
        if (gy < P.pos.y) P.pos.y = gy;
        P.vel.y = Math.min(P.vel.y, 0);
        P.grounded = true;
        P.surface = hit.box.surface || 'concrete';
        return hit.box;
      }
    }
    groundOut.length = 0;
    world.queryAABB(
      sweepMin.set(P.pos.x - PHYS.PLAYER_RADIUS, P.pos.y - 0.4, P.pos.z - PHYS.PLAYER_RADIUS),
      sweepMax.set(P.pos.x + PHYS.PLAYER_RADIUS, P.pos.y + 0.08, P.pos.z + PHYS.PLAYER_RADIUS),
      groundOut,
    );
    let best = null, bestScore = Infinity;
    for (const b of groundOut) {
      if (b.kind === 'zone') continue;
      const top = b.max.y;
      if (top < P.pos.y - 0.4 || top > P.pos.y + 0.07) continue;
      const score = (P.pos.x - (b.min.x + b.max.x) / 2) ** 2 + (P.pos.z - (b.min.z + b.max.z) / 2) ** 2;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (best) {
      if (best.max.y < P.pos.y) P.pos.y = best.max.y;
      P.vel.y = Math.min(P.vel.y, 0);
      P.grounded = true;
      P.surface = best.surface || 'concrete';
      return best;
    }
    P.grounded = false;
    return null;
  }

  function findVaultObstacle() {
    const fwd = forwardVec();
    for (const probeY of [0.95, 0.6, 0.35, 1.25]) {
      _probe.set(P.pos.x, P.pos.y + probeY, P.pos.z);
      const hit = world.rayCast(_probe, fwd, 1.6, isVaultable);
      if (!hit) continue;
      const top = hit.box.max.y;
      const d = top - P.pos.y;
      if (d < 0.3 || d > 1.5) continue;
      if (hit.box.min.y > P.pos.y + probeY + 0.15) continue;
      return { hit, top };
    }
    return null;
  }

  function findLedge() {
    const fwd = forwardVec();
    let hit = null;
    for (const probeY of [0.95, 1.5]) {
      _probe.set(P.pos.x, P.pos.y + probeY, P.pos.z);
      const h = world.rayCast(_probe, fwd, 1.35, isMantleable);
      if (h) { hit = h; break; }
    }
    if (!hit) return null;
    const top = hit.box.max.y;
    const d = top - P.pos.y;
    if (d < 0.35 || d > 2.7) return null;
    if (Math.abs(hit.normal.y) > 0.4) return null;
    let tx = P.pos.x, tz = P.pos.z;
    if (Math.abs(hit.normal.x) > 0.5) tx = hit.normal.x < 0 ? hit.box.min.x + PHYS.PLAYER_RADIUS : hit.box.max.x - PHYS.PLAYER_RADIUS;
    if (Math.abs(hit.normal.z) > 0.5) tz = hit.normal.z < 0 ? hit.box.min.z + PHYS.PLAYER_RADIUS : hit.box.max.z - PHYS.PLAYER_RADIUS;
    return { start: P.pos.clone(), end: new THREE.Vector3(tx, top, tz), top, normal: hit.normal.clone() };
  }

  /* ------------------------------------------------------ 动作 */
  function doJump() {
    if (P.moveState === 'crouch' || P.moveState === 'slide') {
      P.moveState = 'normal';
      P.slide = null;
      audio.stopLoop('slide');
    }
    P.vel.y = PHYS.JUMP_VEL;
    P.grounded = false;
    P.coyote = 0;
    P.jumpBuffer = 0;
    P.fallStartY = P.pos.y;
    stat('jumps');
    if (horizSpeed() > 8.5) gain(25, 'JUMP');
    audio.jump();
    world.burst(new THREE.Vector3(P.pos.x, P.pos.y + 0.08, P.pos.z), 0xd8dee2, 12, { life: 0.4, spread: 1.2, upBias: 0.4, gravity: 3 });
  }

  function startVault(v) {
    const sp0 = horizSpeed();
    setState('vault');
    P.vel.set(0, 0, 0);
    const n = v.hit.normal;
    const box = v.hit.box;
    let tx = P.pos.x, tz = P.pos.z;
    if (Math.abs(n.x) > 0.5) tx = n.x < 0 ? box.max.x + PHYS.PLAYER_RADIUS + 0.05 : box.min.x - PHYS.PLAYER_RADIUS - 0.05;
    if (Math.abs(n.z) > 0.5) tz = n.z < 0 ? box.max.z + PHYS.PLAYER_RADIUS + 0.05 : box.min.z - PHYS.PLAYER_RADIUS - 0.05;
    P.vault = { start: P.pos.clone(), end: new THREE.Vector3(tx, P.pos.y, tz), top: v.top, t: 0, dur: 0.5, enterSpeed: sp0 };
    stat('vaults');
    gain(60, 'VAULT');
    audio.vault();
    world.burst(new THREE.Vector3(P.pos.x, P.pos.y + 0.3, P.pos.z), 0xcfd8dc, 10, { life: 0.35, spread: 1.4, upBias: 0.8 });
  }

  function startMantle(ledge) {
    setState('mantle');
    P.vel.set(0, 0, 0);
    P.mantle = { start: ledge.start.clone(), end: ledge.end.clone(), t: 0, dur: 0.52, normal: ledge.normal };
    stat('mantles');
    gain(70, 'MANTLE');
    audio.mantle();
    world.burst(new THREE.Vector3(P.pos.x, P.pos.y + 1.2, P.pos.z), 0xff5544, 9, { life: 0.4, spread: 1.5, upBias: 0.7 });
  }

  function enterSlide() {
    setState('slide');
    /* 不再凭空提速：滑铲只保留进入时的真实速度（原为 clamp(hs,8.2,14.2)，会白送速度） */
    const sp = clamp(horizSpeed(), 7.2, 14.2);
    P.slide = { dir: new THREE.Vector3(P.vel.x, 0, P.vel.z).normalize(), time: 1.0, speed: sp };
    P.vel.x = P.slide.dir.x * sp;
    P.vel.z = P.slide.dir.z * sp;
    stat('slides');
    gain(40, 'SLIDE');
    audio.startLoop('slide', 0.05);
    audio.setLoop('slide', { gain: 0.07, freq: 800 }, 0.08);
    world.burst(new THREE.Vector3(P.pos.x, P.pos.y + 0.1, P.pos.z), 0xd8dee2, 14, { life: 0.5, spread: 2.5, upBias: 0.5, gravity: 4 });
    P.fovKick = 3.5;
  }

  function enterWallrun(zone) {
    setState('wallrun');
    P.wallrun = { zone, time: 0 };
    const sp = Math.max(PHYS.SPRINT_SPEED, horizSpeed() * 0.95);
    P.vel.set(zone.tangent.x * sp, Math.min(P.vel.y, 1.2), zone.tangent.z * sp);
    P.fallStartY = P.pos.y;
    P.wallCooldown = 0;
    stat('wallruns');
    gain(120, 'WALLRUN');
    audio.startLoop('wall', 0.05);
    const side = zone.wallNormal.clone().multiplyScalar(-PHYS.PLAYER_RADIUS);
    world.burst(new THREE.Vector3(P.pos.x + side.x, P.pos.y + 0.4, P.pos.z + side.z), 0xff5544, 14, { life: 0.5, spread: 1.8, upBias: 0.5 });
  }

  function wallJump(auto) {
    const z = P.wallrun ? P.wallrun.zone : null;
    const normal = z ? z.wallNormal : forwardVec().negate();
    const tangent = z ? z.tangent : new THREE.Vector3(P.vel.x, 0, P.vel.z).normalize();
    const speed = Math.max(11.2, horizSpeed());
    P.vel.set(
      tangent.x * speed + normal.x * 4.8,
      7.3,
      tangent.z * speed + normal.z * 4.8,
    );
    P.pos.y += 0.03;
    P.moveState = 'normal';
    P.grounded = false;
    P.coyote = 0;
    P.fallStartY = P.pos.y;
    P.wallrun = null;
    P.wallCooldown = PHYS.WALLRUN_COOLDOWN;
    P.fovKick = 4.5;
    P.trauma = Math.max(P.trauma, 0.16);
    if (!auto) gain(100, 'WALL-JUMP');
    audio.stopLoop('wall', 0.12);
    audio.walljump();
    const side = normal.clone().multiplyScalar(-PHYS.PLAYER_RADIUS);
    world.burst(new THREE.Vector3(P.pos.x + side.x, P.pos.y + 1.0, P.pos.z + side.z), 0xff5544, 16, { life: 0.5, spread: 2.4, upBias: 0.6 });
    if (auto) hooks.onToast('↯ 蹬墙跳 · WALL-JUMP', 1200);
  }

  function startTurn(dirSign) {
    P.turn = { t: 0, dur: 0.24, from: P.yaw, to: P.yaw + Math.PI * dirSign };
    P.stateTime = 0;
    P.moveState = 'turn';
    P.fovKick = 2.5;
  }

  /* ------------------------------------------------------ 更新子状态 */
  function updateMantle(dt) {
    const m = P.mantle;
    m.t += dt;
    const t = clamp(m.t / m.dur, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    P.pos.lerpVectors(m.start, m.end, e);
    P.pos.y += Math.sin(t * Math.PI) * 0.34;
    if (t >= 1) {
      P.pos.copy(m.end);
      P.mantle = null;
      P.moveState = 'normal';
      P.grounded = true;
      const f = forwardVec();
      P.vel.set(f.x * 4.2, 0, f.z * 4.2);
      P.fallStartY = P.pos.y;
    }
  }
  function updateVault(dt) {
    const v = P.vault;
    v.t += dt;
    const t = clamp(v.t / v.dur, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    P.pos.lerpVectors(v.start, v.end, e);
    P.pos.y = v.start.y + Math.sin(t * Math.PI) * Math.max(0.55, (v.top - v.start.y) + 0.44);
    P.rollAnim = Math.sin(t * Math.PI) * 0.18;
    if (t >= 1) {
      P.pos.copy(v.end);
      P.vault = null;
      P.moveState = 'normal';
      P.grounded = true;
      const sp = clamp(Math.max(v.enterSpeed * 0.96, 7.0), 7.0, 13.2);
      const f = forwardVec();
      P.vel.set(f.x * sp, 0, f.z * sp);
      P.rollAnim = 0;
    }
  }
  function updateClimb(dt) {
    const cd = P.climb.data;
    P.yaw = dampAngle(P.yaw, -Math.PI / 2, 10, dt);
    P.pitch = damp(P.pitch, -0.06, 8, dt);
    P.roll = damp(P.roll, 0, 8, dt);
    const mv = hooks.getMoveInput();
    const up = hooks.keys.has('KeyW') || hooks.keys.has('ArrowUp') || mv.y > 0.25;
    const down = hooks.keys.has('KeyS') || hooks.keys.has('ArrowDown') || mv.y < -0.25;
    const speed = (up ? 4.4 : 0) + (down ? -3.3 : 0);
    P.pos.y += speed * dt;
    P.pos.x = cd.x - 0.54;
    P.pos.z = cd.z;
    P.vel.set(0, speed, 0);
    P.climbStepAcc += Math.abs(speed) * dt;
    if (P.climbStepAcc > 1.5) { P.climbStepAcc = 0; audio.climbStep(); }
    if (P.pos.y >= cd.topY - 0.12 && up) {
      P.pos.copy(cd.dismount);
      P.vel.set(3.8, 0, 0);
      P.climb = null;
      P.moveState = 'normal';
      P.grounded = false;
      P.fallStartY = P.pos.y;
      jumpQueued = false;
      gain(60, 'CLIMB');
      audio.stopLoop('wall', 0.15);
      audio.mantle();
    } else if (P.pos.y <= cd.baseY + 0.12 && down) {
      P.pos.copy(cd.exitBottom);
      P.vel.set(-3.2, 0, 0);
      P.climb = null;
      P.moveState = 'normal';
      P.grounded = false;
      jumpQueued = false;
      audio.stopLoop('wall', 0.15);
    } else if (jumpQueued) {
      jumpQueued = false;
      P.pos.y -= 0.1;
      P.climb = null;
      P.moveState = 'normal';
      P.grounded = false;
      P.vel.set(-4.6, 4.6, 0);
      audio.stopLoop('wall', 0.15);
    }
    P.pos.y = clamp(P.pos.y, cd.baseY - 0.1, cd.topY + 0.4);
  }
  /* 滑索出口：down=滑到低端；top=爬到高端；bottom=回滑到底端；mid=中途跳离 */
  function exitZipline(mode) {
    const z = P.zipline;
    const zd = z.data;
    const dir = _zipDir.subVectors(zd.to, zd.from).normalize();
    const dh = _zipTmp.set(dir.x, 0, dir.z);
    if (dh.lengthSq() < 1e-6) dh.set(0, 0, 1);
    dh.normalize();
    const up = _fwd.set(-dh.x, 0, -dh.z);
    let vx, vy, vz, gainPts = 0, label = '';
    if (mode === 'top') {
      vx = up.x * 5.2; vy = 2.6; vz = up.z * 5.2;
      gainPts = 120; label = 'ZIP-TOP';
      hooks.onToast('🔝 登上滑索高点', 1300);
    } else if (mode === 'bottom') {
      vx = dh.x * 2.4; vy = 1.2; vz = dh.z * 2.4;
    } else if (mode === 'mid') {
      const climbing = z.v < -0.2;
      const f = climbing ? up : dh;
      vx = f.x * (climbing ? 4.6 : 8.6);
      vy = climbing ? 3.4 : 2.4;
      vz = f.z * (climbing ? 4.6 : 8.6);
      gainPts = 40; label = 'ZIP-OFF';
    } else {
      vx = dh.x * 9.0; vy = 2.4; vz = dh.z * 9.0;
      gainPts = 90; label = 'ZIP-RELEASE';
    }
    P.zipline = null;
    P.moveState = 'normal';
    P.grounded = false;
    P.yaw = Math.atan2(-vx, -vz);
    P.vel.set(vx, vy, vz);
    P.fallStartY = P.pos.y;
    P.fovKick = 4;
    if (gainPts) gain(gainPts, label);
    audio.stopLoop('zip', 0.25);
    audio.walljump();
    interactTimer = 0;
  }

  function updateZipline(dt) {
    P.physSteps++;
    const z = P.zipline;
    const zd = z.data;
    const dir = _zipDir.subVectors(zd.to, zd.from).normalize();
    if (z.mode === 'down') {
      /* 下滑：自动匀速 */
      z.s += 14.5 * skillEffect.zipSpeed() * dt;
      if (z.s >= z.len * zd.releaseT) { exitZipline('down'); return; }
      const t = clamp(z.s / z.len, 0, 1);
      P.pos.lerpVectors(zd.from, zd.to, t);
      P.yaw = Math.atan2(-dir.x, -dir.z);
      P.roll = Math.sin(t * Math.PI * 6) * 0.04;
      P.vel.copy(dir).multiplyScalar(14.5 * skillEffect.zipSpeed());
      audio.setLoop('zip', { gain: 0.1, freq: 1900 }, 0.1);
    } else {
      /* 上爬：按住 W / 上推摇杆才前进；松开沿索回滑；S / 下拉摇杆主动下滑 */
      const mv = hooks.getMoveInput();
      const w = hooks.keys.has('KeyW') || hooks.keys.has('ArrowUp') || mv.y > 0.25;
      const dn = hooks.keys.has('KeyS') || hooks.keys.has('ArrowDown') || mv.y < -0.25;
      const slope = Math.max(0.08, (zd.from.y - zd.to.y) / Math.max(1, z.len));
      const gravityAlong = PHYS.GRAVITY * Math.min(1, slope);
      /* 爬升力始终比重力分量大 10 m/s²，陡索只是更慢，不会爬不动 */
      const accel = (w && !dn) ? -(gravityAlong + 10) : (gravityAlong + (dn ? 6 : 0));
      z.v = clamp(z.v + accel * dt, -z.climbSpeed, 9.5);
      z.s += z.v * dt;
      if (z.s <= 0.3 && z.v < 0) { P.pos.copy(zd.from); exitZipline('top'); return; }
      if (z.s >= z.len) {
        /* 滑回底端：先悬停片刻（可继续按 W 再爬），不按才落到屋顶 */
        z.s = z.len;
        z.v = 0;
        z.bottomHold = (z.bottomHold || 0) + dt;
        if (z.bottomHold > 0.5) { P.pos.copy(zd.to); exitZipline('bottom'); return; }
      } else {
        z.bottomHold = 0;
      }
      const t = clamp(z.s / z.len, 0, 1);
      P.pos.lerpVectors(zd.from, zd.to, t);
      const f = _zipTmp.set(-dir.x, -dir.y, -dir.z);
      P.yaw = Math.atan2(-f.x, -f.z);
      P.roll = Math.sin(z.s * 0.4) * 0.05 * clamp(Math.abs(z.v) / 6, 0.25, 1);
      P.vel.copy(dir).multiplyScalar(z.v);
      audio.setLoop('zip', { gain: 0.06 + Math.min(0.06, Math.abs(z.v) * 0.006), freq: 1150 + Math.abs(z.v) * 90 }, 0.1);
    }
    P.pitch = damp(P.pitch, -0.05, 6, dt);
    if (jumpQueued || interactTimer > 0) {
      if (jumpQueued) jumpQueued = false;
      exitZipline('mid');
    }
  }
  function updateTurn(dt) {
    const t = P.turn;
    t.t += dt;
    const k = clamp(t.t / t.dur, 0, 1);
    const e = 1 - Math.pow(1 - k, 3);
    const yaw = t.from + (t.to - t.from) * e;
    _zipTmp.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    const sp = Math.max(6.5, horizSpeed());
    P.yaw = yaw;
    P.vel.x = _zipTmp.x * sp;
    P.vel.z = _zipTmp.z * sp;
    P.vel.y -= PHYS.GRAVITY * dt;
    P.pos.addScaledVector(P.vel, dt);
    resolveCollisions();
    findGround();
    if (k >= 1) {
      P.turn = null;
      P.moveState = 'normal';
      P.yaw = t.to;
    }
  }
  function updateDead(dt) {
    P.deadTimer -= dt;
    P.pos.y -= dt * 0.4;
    if (P.deadTimer <= 0) {
      P.deadTimer = 0;
      respawn();
    }
  }

  function die(reason = '') {
    if (P.moveState === 'dead') return;
    P.deathReason = reason;
    P.moveState = 'dead';
    P.deadTimer = 1.1;
    P.vel.set(0, 0, 0);
    P.trauma = 1;
    P.damageFlash = 1;
    stopLoops();
    audio.die();
    hooks.onDie(reason);
  }

  function stopLoops() {
    audio.stopLoop('slide', 0.2);
    audio.stopLoop('wall', 0.2);
    audio.stopLoop('zip', 0.3);
  }

  function quickTurn() {
    if (P.moveState === 'dead' || P.moveState === 'turn' || P.camTurn) return;
    if (P.moveState === 'wallrun') {
      const z = P.wallrun ? P.wallrun.zone : null;
      const n = z ? z.wallNormal : null;
      wallJump(false);
      P.camTurn = {
        t: 0, dur: 0.2, from: P.yaw,
        to: n ? Math.atan2(-n.x, -n.z) : P.yaw + Math.PI,
      };
      return;
    }
    if (P.moveState === 'normal' && P.grounded && horizSpeed() > 7.5) {
      startTurn(1);
      audio.whoosh();
      return;
    }
    if (P.moveState === 'normal' || P.moveState === 'crouch') {
      P.camTurn = { t: 0, dur: 0.2, from: P.yaw, to: P.yaw + Math.PI };
      P.fovKick = Math.max(P.fovKick, 1.8);
      audio.whoosh();
    }
  }

  function respawn() {
    const safe = P.lastSafe;
    P.pos.copy(safe.pos);
    P.vel.set(0, 0, 0);
    P.yaw = safe.yaw;
    P.pitch = 0;
    P.roll = 0; P.rollAnim = 0;
    P.height = PHYS.PLAYER_HEIGHT;
    P.eye = PHYS.EYE_HEIGHT;
    P.moveState = 'normal';
    P.slide = P.mantle = P.vault = P.wallrun = P.climb = P.zipline = P.turn = P.camTurn = null;
    P.grounded = false;
    P.stamina = 100;
    P.exhausted = false;
    P.trauma = 0;
    P.deadTimer = 0;
    P.onBounce = false;
    jumpQueued = false;
    interactTimer = 0;
    stopLoops();
  }

  function reset() {
    P.lastSafe = { pos: new THREE.Vector3(world.spawnPoint.x, world.spawnPoint.y + 0.06, world.spawnPoint.z), yaw: world.spawnPoint.yaw };
    respawn();
    P.lastSafe.pos.copy(P.pos);
    P.lastSafe.yaw = P.yaw;
  }

  function teleport(x, y, z, yaw) {
    P.pos.set(x, y, z);
    P.vel.set(0, 0, 0);
    P.yaw = yaw;
    P.pitch = 0;
    P.moveState = 'normal';
    P.slide = P.mantle = P.vault = P.wallrun = P.climb = P.zipline = P.turn = P.camTurn = null;
    P.grounded = false;
    P.fallStartY = y;
    stopLoops();
    P.lastSafe.pos.set(x, y + 0.02, z);
    P.lastSafe.yaw = yaw;
  }

  /* ------------------------------------------------------ 主更新 */
  function update(dt) {
    P.physSteps++;
    if (P.wallCooldown > 0) P.wallCooldown -= dt;
    if (interactTimer > 0) interactTimer -= dt;
    P.interactTimer = interactTimer;
    if (P.camTurn) {
      P.camTurn.t += dt;
      const k = clamp(P.camTurn.t / P.camTurn.dur, 0, 1);
      const e = 1 - Math.pow(1 - k, 3);
      P.yaw = P.camTurn.from + (P.camTurn.to - P.camTurn.from) * e;
      if (k >= 1) P.camTurn = null;
    }
    if (P.moveState === 'dead') { updateDead(dt); return; }
    if (P.moveState === 'mantle') { updateMantle(dt); return; }
    if (P.moveState === 'vault') { updateVault(dt); return; }
    if (P.moveState === 'climb') { updateClimb(dt); return; }
    if (P.moveState === 'zipline') { updateZipline(dt); return; }
    if (P.moveState === 'turn') { updateTurn(dt); return; }

    const move = hooks.getMoveInput();
    const wishDir = _wish;
    wishDir.set(0, 0, 0);
    wishDir.addScaledVector(rightVec(), move.x).addScaledVector(forwardVec(), move.y);
    if (wishDir.lengthSq() > 1e-6) wishDir.normalize();
    const hs = horizSpeed();

    /* 攀爬管道 / 滑索交互 */
    let climbNear = null, cd = 2.0;
    for (const c of world.climbs) {
      const dxc = P.pos.x - c.x, dzc = P.pos.z - c.z;
      if (dxc > 2.0 || dxc < -2.0 || dzc > 2.0 || dzc < -2.0) continue;
      const d = Math.hypot(dxc, dzc);
      if (d < cd) { cd = d; climbNear = c; }
    }
    let zipPick = null;
    for (const z of world.zips) {
      /* 便宜的高度粗筛 + 轴粗筛 */
      if (P.pos.y < z.to.y - 3.6 || P.pos.y > z.from.y + 1.4) continue;
      if (P.pos.x < z.from.x - 2.7 && P.pos.x < z.to.x - 2.7) continue;
      if (P.pos.x > z.from.x + 2.7 && P.pos.x > z.to.x + 2.7) continue;
      if (P.pos.z < z.from.z - 2.7 && P.pos.z < z.to.z - 2.7) continue;
      if (P.pos.z > z.from.z + 2.7 && P.pos.z > z.to.z + 2.7) continue;
      const df = Math.hypot(P.pos.x - z.from.x, P.pos.z - z.from.z);
      if (df < 2.7 && P.pos.y > z.from.y - 3.6 && P.pos.y < z.from.y + 1.4) {
        if (!zipPick || df < zipPick.dist) zipPick = { zd: z, end: 'from', dist: df };
      }
      const dt2 = Math.hypot(P.pos.x - z.to.x, P.pos.z - z.to.z);
      if (dt2 < 2.7 && P.pos.y > z.to.y - 3.6 && P.pos.y < z.to.y + 1.4) {
        if (!zipPick || dt2 < zipPick.dist) zipPick = { zd: z, end: 'to', dist: dt2 };
      }
    }
    if (P.moveState === 'normal' && climbNear && cd < 0.95 && P.pos.y > climbNear.baseY - 1.2 && P.pos.y < climbNear.topY - 0.5 && (move.y > 0.2 || interactTimer > 0)) {
      P.moveState = 'climb';
      P.climb = { data: climbNear };
      P.grounded = false;
      P.pos.y = Math.max(P.pos.y, climbNear.baseY);
      P.vel.set(0, 0, 0);
      P.pitch = damp(P.pitch, -0.08, 12, dt);
      interactTimer = 0;
      audio.startLoop('wall', 0.05);
      return;
    }
    if (P.moveState === 'normal' && zipPick && P.grounded && interactTimer > 0) {
      const zdz = zipPick.zd;
      const len = zdz.from.distanceTo(zdz.to);
      const slope = Math.max(0.08, (zdz.from.y - zdz.to.y) / Math.max(1, len));
      P.moveState = 'zipline';
      if (zipPick.end === 'from') {
        P.zipline = { mode: 'down', s: 0, v: 14.5, len, climbSpeed: 0, data: zdz };
        hooks.onToast('⚡ 滑索下滑 · SPACE 跳离', 1300);
      } else {
        const climbSpeed = clamp((6.0 - slope * 3.0) * (len > 40 ? 1.5 : 1), 2.4, 10);
        P.zipline = { mode: 'up', s: len, v: 0, len, climbSpeed, data: zdz };
        hooks.onToast('⚡ 抓住滑索 · 按住 W 上爬（松开回滑）', 2000);
      }
      stat('ziplines');
      P.vel.set(0, 0, 0);
      P.grounded = false;
      interactTimer = 0;
      gain(90, 'ZIPLINE');
      audio.startLoop('zip');
      return;
    }

    /* 体力 */
    const wantsSprint = hooks.sprintHeld() && !hooks.crouchHeld() && move.y > 0 && P.stamina > 0 && !P.exhausted;
    const flowRelief = hooks.flow.timer > 0 ? Math.min(2, (hooks.flow.mult - 1) * 0.5) : 0;
    if (wantsSprint && hs > 2) {
      P.stamina = Math.max(0, P.stamina - (6.2 - flowRelief * 1.1) * skillEffect.staminaMult() * dt);
      if (P.stamina <= 0) P.exhausted = true;
    } else {
      P.stamina = Math.min(100, P.stamina + (P.grounded ? 17 : 7.5) * (1 + flowRelief * 0.3) * dt);
      if (P.stamina > 22) P.exhausted = false;
    }

    /* 蹲伏 */
    if (P.moveState === 'normal' && hooks.crouchHeld() && P.grounded && hs <= 7.4) P.moveState = 'crouch';
    else if (P.moveState === 'crouch' && !hooks.crouchHeld()) P.moveState = 'normal';

    const flowBoost = hooks.flow.timer > 0 ? (hooks.flow.mult - 1) * 0.42 : 0;
    /* 惯性动量：持续冲刺会小幅提升极速，停跑 / 撞墙后衰减 */
    const sprinting = wantsSprint && P.grounded && hs > 5.5 && move.y > 0.2;
    P.momentum = clamp(P.momentum + (sprinting ? dt * 0.55 : -dt * 0.9), 0, 1);
    const sprintSpeed = PHYS.SPRINT_SPEED * skillEffect.sprintMult() + P.momentum * 0.85;
    const maxSpeed = (wantsSprint ? sprintSpeed : (hooks.crouchHeld() ? PHYS.CROUCH_SPEED : PHYS.WALK_SPEED)) + flowBoost;

    /* 滑铲 */
    if ((P.moveState === 'normal' || P.moveState === 'crouch') && hooks.crouchHeld() && P.grounded && hs > 7.2 && move.y > -0.2) {
      enterSlide();
    }

    /* 180° 急转（冲刺中按下 S，Faith 式掉头） */
    if (P.moveState === 'normal' && P.grounded && hs > 8.5 && move.y < -0.6 && Math.abs(move.x) < 0.35 && hooks.sprintHeld()) {
      startTurn(hooks.keys.has('KeyD') || hooks.keys.has('ArrowRight') ? -1 : 1);
      return;
    }

    /* 水平运动 */
    if (P.moveState === 'slide') {
      const sd = P.slide.dir;
      P.slide.speed = Math.max(6.2, P.slide.speed - 2.2 * dt);
      P.vel.x = damp(P.vel.x, sd.x * P.slide.speed, 3.4, dt);
      P.vel.z = damp(P.vel.z, sd.z * P.slide.speed, 3.4, dt);
      P.slide.time -= dt;
      audio.setLoop('slide', { gain: 0.075, freq: 780 + P.slide.speed * 24 }, 0.1);
      if (P.slide.time <= 0 || hs < 3.8) {
        P.moveState = hooks.crouchHeld() ? 'crouch' : 'normal';
        P.slide = null;
        audio.stopLoop('slide', 0.15);
      }
    } else if (P.moveState === 'roll') {
      P.stateTime += dt;
      const keep = Math.max(0.94, 1 - 0.42 * dt);
      P.vel.x *= keep;
      P.vel.z *= keep;
      if (P.stateTime > 0.4) {
        P.moveState = 'normal';
        P.rollAnim = 0;
      }
    } else {
      if (move.len > 0) {
        const analog = Math.min(1, move.len);
        const targetX = wishDir.x * maxSpeed * analog, targetZ = wishDir.z * maxSpeed * analog;
        const lam = P.grounded ? 11.5 : 3.2;
        P.vel.x = damp(P.vel.x, targetX, lam, dt);
        P.vel.z = damp(P.vel.z, targetZ, lam, dt);
      } else if (P.grounded) {
        const lam = hooks.crouchHeld() ? 12 : 2.4;
        P.vel.x = damp(P.vel.x, 0, lam, dt);
        P.vel.z = damp(P.vel.z, 0, lam, dt);
      }
    }

    /* 跳跃 / 翻越 */
    if (P.moveState === 'normal' || P.moveState === 'crouch' || P.moveState === 'slide') {
      if (P.grounded) P.coyote = PHYS.COYOTE; else P.coyote -= dt;
      if (jumpQueued) {
        if (P.grounded || P.coyote > 0) {
          const vault = P.grounded ? findVaultObstacle() : null;
          if (vault) { startVault(vault); jumpQueued = false; }
          else { doJump(); jumpQueued = false; }
        } else {
          P.jumpBuffer = PHYS.JUMP_BUFFER;
          jumpQueued = false;
        }
      }
      if (P.jumpBuffer > 0) {
        P.jumpBuffer -= dt;
        if (P.grounded) { doJump(); P.jumpBuffer = 0; }
      }
    } else {
      jumpQueued = false;
    }

    /* 蹬墙跑检测 */
    if (P.moveState === 'normal' && !P.grounded && P.wallCooldown <= 0 && Math.abs(P.vel.y) < 7.0) {
      for (const b of world.zones) {
        if (P.pos.x >= b.min.x && P.pos.x <= b.max.x && P.pos.y >= b.min.y && P.pos.y <= b.max.y && P.pos.z >= b.min.z && P.pos.z <= b.max.z) {
          if (P.vel.dot(b.tangent) > 6.5) {
            enterWallrun(b);
            break;
          }
        }
      }
    }

    /* 重力 + 积分 */
    if (P.moveState !== 'wallrun') {
      const g = P.moveState === 'slide' ? PHYS.GRAVITY * 0.92 : PHYS.GRAVITY;
      P.vel.y -= g * dt;
      P.pos.x += P.vel.x * dt;
      P.pos.y += P.vel.y * dt;
      P.pos.z += P.vel.z * dt;
    }

    /* 蹬墙跑更新 */
    if (P.moveState === 'wallrun') {
      const wz = P.wallrun.zone;
      P.wallrun.time += dt;
      const tangent = wz.tangent;
      const normal = wz.wallNormal;
      P.yaw = dampAngle(P.yaw, Math.atan2(-tangent.x, -tangent.z), 9.5, dt);
      P.pitch = damp(P.pitch, -0.03, 8, dt);
      P.roll = damp(P.roll, -0.13, 8, dt);
      P.vel.x = tangent.x * PHYS.SPRINT_SPEED;
      P.vel.z = tangent.z * PHYS.SPRINT_SPEED;
      P.vel.y -= PHYS.WALLRUN_GRAVITY * dt;
      P.pos.addScaledVector(tangent, PHYS.SPRINT_SPEED * dt);
      P.pos.y += P.vel.y * dt;
      const dist = P.pos.dot(normal) - wz.face.dot(normal);
      P.pos.addScaledVector(normal, PHYS.PLAYER_RADIUS - dist);
      P.grounded = false;
      audio.setLoop('wall', { gain: 0.1, freq: 340 }, 0.08);
      const progress = P.pos.dot(tangent);
      if (jumpQueued) { jumpQueued = false; wallJump(false); }
      else if (progress >= wz.endT - 0.6 || P.wallrun.time > skillEffect.wallrunTime()) wallJump(true);
      return;
    }

    /* 碰撞 / 地面 */
    const wasGrounded = P.grounded;
    const prevVy = P.vel.y;
    resolveCollisions();
    const groundBox = findGround();

    /* 弹簧板 */
    if (P.grounded && groundBox && groundBox.kind === 'bounce' && !P.onBounce) {
      P.onBounce = true;
      P.grounded = false;
      const lv = groundBox.launch || new THREE.Vector3(12.8, 14.2, 0);
      P.yaw = groundBox.launchYaw !== undefined ? groundBox.launchYaw : Math.atan2(-lv.x, -lv.z);
      P.vel.copy(lv);
      P.pos.y = groundBox.max.y + 0.02;
      P.fallStartY = P.pos.y;
      P.fovKick = 6;
      P.trauma = Math.max(P.trauma, 0.38);
      stat('springs');
      gain(110, 'SPRING');
      audio.spring();
      world.burst(new THREE.Vector3(P.pos.x, P.pos.y, P.pos.z), 0xff5544, 20, { life: 0.6, spread: 3.2, upBias: 1.1, gravity: 6, additive: true, size: 0.16 });
      hooks.onToast('◎ 弹簧板 · SPRINGBOARD', 1300);
      return;
    }
    if (P.grounded && (!groundBox || groundBox.kind !== 'bounce')) P.onBounce = false;

    /* 落地结算 */
    if (P.grounded && !wasGrounded) {
      P.impact = Math.max(0, -prevVy);
      const fallDist = Math.max(0, P.fallStartY - P.pos.y);
      const air = P.airTime;
      P.airTime = 0;
      if (air > 1.1) gain(Math.round(30 + air * 42), `AIR ${air.toFixed(1)}s`);
      if (groundBox && groundBox.street && P.pos.y <= PHYS.STREET_Y) { die('street'); return; }
      if (fallDist > 9.5) {
        P.trauma = Math.max(P.trauma, clamp(fallDist / 22, 0.2, 0.7));
        P.fovKick = 5;
      }
      if (P.impact > 4) {
        P.landDip = -Math.min(0.13, P.impact * 0.006);
        audio.land(P.impact, P.surface);
        hooks.onLand(P.impact, P.surface);
        world.burst(new THREE.Vector3(P.pos.x, P.pos.y + 0.06, P.pos.z), 0xd8dee2, Math.min(24, 7 + P.impact), { life: 0.5, spread: 2.4 + P.impact * 0.08, upBias: 0.5, gravity: 5 });
      }
      if (P.impact > 9 && horizSpeed() > 6.5 && (hooks.crouchHeld() || hooks.sprintHeld() || P.impact > 14)) {
        P.moveState = 'roll';
        P.stateTime = 0;
        P.rollAnim = -Math.PI * 2;
        P.fovKick = 4;
        gain(80, 'ROLL');
        audio.roll();
        P.vel.x *= 1.05;
        P.vel.z *= 1.05;
        const keep = skillEffect.rollKeep();
        P.vel.x *= keep;
        P.vel.z *= keep;
      } else if (P.impact > 15) {
        P.trauma = Math.max(P.trauma, 0.55);
        P.damageFlash = Math.max(P.damageFlash, 0.5);
        P.fovKick = 6;
        audio.hurt();
      }
      if (P.impact > PHYS.FATAL_IMPACT) { die('fall'); return; }
    }
    if (P.grounded) P.airTime = 0; else P.airTime += dt;

    /* 自动攀抓窗台 */
    if (P.moveState === 'normal' && !P.grounded && P.vel.y < 3.6 && (move.y > 0.25 || P.vel.y < -2.0) && !jumpQueued) {
      const ledge = findLedge();
      if (ledge) startMantle(ledge);
    }

    if (!P.grounded && wasGrounded) P.fallStartY = P.pos.y;

    /* 脚步 */
    if (P.grounded && P.moveState !== 'slide' && P.moveState !== 'roll' && P.moveState !== 'dead') {
      const stepSpeed = clamp(hs / 7, 0.35, 1.8);
      P.stepTimer -= dt * stepSpeed;
      if (P.stepTimer <= 0) {
        P.stepTimer = 0.62;
        P.foot ^= 1;
        audio.footstep(P.surface, hs, P.foot);
      }
    } else if (!P.grounded) {
      P.stepTimer = Math.min(P.stepTimer, 0.2);
    }

    /* 安全点 */
    P.safeTimer -= dt;
    if (P.grounded && P.pos.y > 1.2 && P.safeTimer <= 0) {
      P.safeTimer = 0.5;
      P.lastSafe.pos.set(P.pos.x, P.pos.y + 0.04, P.pos.z);
      P.lastSafe.yaw = P.yaw;
    }

    /* 空中风感 */
    if (P.pos.y < -25) die('void');
  }

  return { P, update, respawn, reset, die, teleport, queueJump, queueInteract, quickTurn };
}
