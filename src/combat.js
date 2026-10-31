
import * as THREE from '../vendor/three.module.js';
import { clamp, rand, pick } from './util.js';
import { audio } from './audio.js';

/* =========================================================================
   City Protection —— 屋顶巡逻警力 / 追捕 / 近战解除武装
   ------------------------------------------------------------------------
   · 低多边形守卫：巡逻 → 起疑 → 交火 → 眩晕 / 缴械，全部由屋顶路点驱动
   · 视线判定走空间哈希射线：蹲伏时被发现的距离减半，躲进女儿墙后即可脱身
   · 子弹为命中扫描 + 曳光弹池；命中判定同样做遮挡检测，不会穿墙打人
   · 近战 F：踢击 + 短暂反应时间（慢动作），成功缴械额外奖励
   · 全局警报：交火开始后 14 秒内附近守卫都会被惊动
   ========================================================================= */

const NOT_ZONE = (b) => b.kind !== 'zone';
const EYE_Y = 1.62;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _vLOS = new THREE.Vector3();
const _pc = new THREE.Vector3();   /* 玩家胸口：整个 update 内只写一次，禁止被复用临时向量覆盖 */
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();

class Guard {
  constructor(id, roof, scene, shared) {
    this.id = id;
    this.roof = roof;
    this.y = roof.top + 0.02;
    this.x0 = roof.x0 + 1.4; this.x1 = roof.x1 - 1.4;
    this.z0 = roof.z0 + 1.4; this.z1 = roof.z1 - 1.4;
    const alongX = (roof.x1 - roof.x0) >= (roof.z1 - roof.z0);
    const midX = (this.x0 + this.x1) / 2, midZ = (this.z0 + this.z1) / 2;
    if (alongX) {
      this.a = new THREE.Vector3(this.x0, this.y, midZ);
      this.b = new THREE.Vector3(this.x1, this.y, midZ);
    } else {
      this.a = new THREE.Vector3(midX, this.y, this.z0);
      this.b = new THREE.Vector3(midX, this.y, this.z1);
    }
    this.pos = this.a.clone().lerp(this.b, rand(0.1, 0.9));
    this.dir = 1;
    this.yaw = Math.atan2(-(this.b.x - this.a.x), -(this.b.z - this.a.z));
    this.state = 'patrol';
    this.stateT = 0;
    this.suspicion = 0;
    this.fireCd = rand(0.4, 1.2);
    this.aimT = 0;
    this.walkPhase = rand(6.28);
    this.hp = 3;
    this.dead = false;
    this.lastSeen = -99;
    this.fleeDir = 1;

    /* --- 低多边形模型（共享几何 / 材质，每个守卫一个 Group） --- */
    const g = new THREE.Group();
    const torso = new THREE.Mesh(shared.torsoGeo, shared.armor);
    torso.position.y = 1.16;
    const head = new THREE.Mesh(shared.headGeo, shared.helmet);
    head.position.y = 1.62;
    const visor = new THREE.Mesh(shared.visorGeo, shared.visorMat);
    visor.position.set(0, 1.63, -0.115);
    const armGeo = shared.armGeo;
    const armL = new THREE.Mesh(armGeo, shared.suit); armL.position.set(-0.27, 1.38, 0);
    const armR = new THREE.Mesh(armGeo, shared.suit); armR.position.set(0.27, 1.38, 0);
    const legL = new THREE.Mesh(armGeo, shared.pants); legL.position.set(-0.11, 0.86, 0);
    const legR = new THREE.Mesh(armGeo, shared.pants); legR.position.set(0.11, 0.86, 0);
    const gun = new THREE.Mesh(shared.gunGeo, shared.gunMat);
    gun.position.set(0.3, 1.32, -0.34);
    g.add(torso, head, visor, armL, armR, legL, legR, gun);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    g.visible = false;
    scene.add(g);
    this.group = g;
    this.parts = { torso, head, armL, armR, legL, legR, gun };
    this.weaponUp = false;
  }

  alert(reason) {
    if (this.dead) return false;
    if (this.state === 'combat') return false;
    this.state = 'combat';
    this.stateT = 0;
    this.suspicion = 1;
    this.aimT = 0;
    this.fireCd = rand(0.5, 0.9);
    return true;
  }

  stun(t) {
    if (this.dead) return;
    this.state = 'stunned';
    this.stateT = t;
    this.aimT = 0;
  }

  disarm() {
    this.dead = true;
    this.state = 'down';
    this.parts.gun.visible = false;
    this.parts.armL.rotation.x = -1.9;
    this.parts.armR.rotation.x = -1.7;
  }

  /* 巡逻 / 追击移动（限制在屋顶矩形内） */
  moveToward(tx, tz, speed, dt) {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return 0;
    const step = Math.min(speed * dt, d);
    this.pos.x += dx / d * step;
    this.pos.z += dz / d * step;
    this.yaw = Math.atan2(-dx, -dz);
    this.walkPhase += step * 3.4;
    return step;
  }
}

export class CombatSystem {
  constructor(world, scene, camera, hooks) {
    this.world = world;
    this.scene = scene;
    this.camera = camera;
    this.hooks = hooks || {};
    this.guards = [];
    this.hp = 100;
    this.maxHp = 100;
    this.lastDamage = -99;
    this._lastHit = -99;
    this.alarm = 0;
    this.alarmCooldown = 0;
    this.slowmo = 0;
    this.downed = false;
    this.kills = 0;
    this.shots = 0;
    this.time = 0;
    this._detectAcc = 0;
    this._hurtCb = 0;
    this.initShared();
    this.spawnGuards();
    this.initFx();
  }

  initShared() {
    const armor = new THREE.MeshStandardMaterial({ color: 0x1d242b, roughness: 0.55, metalness: 0.25 });
    const suit = new THREE.MeshStandardMaterial({ color: 0x39434c, roughness: 0.8 });
    const pants = new THREE.MeshStandardMaterial({ color: 0x22282e, roughness: 0.85 });
    const helmet = new THREE.MeshStandardMaterial({ color: 0xe8edf0, roughness: 0.35, metalness: 0.2 });
    const visorMat = new THREE.MeshBasicMaterial({ color: 0x7de3ff });
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x15191d, roughness: 0.4, metalness: 0.6 });
    const torsoGeo = new THREE.BoxGeometry(0.44, 0.58, 0.27);
    const headGeo = new THREE.BoxGeometry(0.25, 0.26, 0.25);
    const visorGeo = new THREE.BoxGeometry(0.19, 0.07, 0.03);
    const armGeo = new THREE.BoxGeometry(0.12, 0.56, 0.13);
    armGeo.translate(0, -0.28, 0);
    const legGeo = new THREE.BoxGeometry(0.15, 0.8, 0.17);
    legGeo.translate(0, -0.4, 0);
    const gunGeo = new THREE.BoxGeometry(0.07, 0.1, 0.34);
    this.shared = { armor, suit, pants, helmet, visorMat, gunMat, torsoGeo, headGeo, visorGeo, armGeo, legGeo, gunGeo };
  }

  spawnGuards() {
    const bs = this.world.openCity.buildings.filter((b) => b.top > 7 && b.top < 52 && b.w > 11 && b.d > 11);
    if (!bs.length) return;
    /* 优先布置在教学环线与主城区，保证玩家很快遇到；其余散布全城 */
    const near = bs.filter((b) => b.cz > -120 && b.cz < 120 && b.cx > -40 && b.cx < 200);
    const pool = near.length > 10 ? near : bs;
    const used = new Set();
    /* 屋顶巡逻线必须避开冷却塔 / 楼梯间 / 空调等道具，否则守卫会被卡在箱体里 */
    const roofClear = (b) => {
      const y = b.top + 1.1;
      const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2;
      const pts = [[b.x0 + 1.6, mz], [b.x1 - 1.6, mz], [mx, b.z0 + 1.6], [mx, b.z1 - 1.6], [mx, mz]];
      for (const [x, z] of pts) {
        if (this.world.pointInsideProp(x, y, z, 1.2)) return false;
      }
      return true;
    };
    const take = (arr) => {
      for (let i = 0; i < 80; i++) {
        const b = arr[Math.floor(Math.random() * arr.length)];
        if (!b || used.has(b)) continue;
        if (!roofClear(b)) { used.add(b); continue; }
        used.add(b);
        return b;
      }
      return null;
    };
    const n = 12;
    for (let i = 0; i < n; i++) {
      const b = take(pool) || take(bs);
      if (!b) break;
      this.guards.push(new Guard(i, b, this.scene, this.shared));
    }
    /* 几处固定高点哨位（不需要移动） */
    for (const b of bs) {
      if (b.top > 38 && Math.abs(b.cx) < 260 && this.guards.length < 16 && !used.has(b)) {
        used.add(b);
        this.guards.push(new Guard(this.guards.length, b, this.scene, this.shared));
      }
    }
  }

  initFx() {
    /* 曳光弹池 */
    this.tracers = [];
    const geo = new THREE.BoxGeometry(0.035, 0.035, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.layers.set(1);
      m.frustumCulled = false;
      this.scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }
    /* 枪口闪光 */
    const flashTex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.35, 'rgba(255,220,150,0.8)');
      grd.addColorStop(1, 'rgba(255,160,60,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.flashes = [];
    for (let i = 0; i < 4; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false }));
      sp.scale.setScalar(1.1);
      sp.visible = false;
      sp.layers.set(1);
      this.scene.add(sp);
      this.flashes.push({ sp, life: 0 });
    }
  }

  /* 玩家被击倒 / 死亡后：解除追捕、恢复状态，守卫回到巡逻 */
  onPlayerDeath() {
    this.hp = this.maxHp;
    this.downed = false;
    this.alarm = 0;
    this.slowmo = 0;
    this.lastDamage = this.time + 3;
    for (const g of this.guards) {
      if (g.dead) continue;
      g.state = 'patrol';
      g.suspicion = 0;
      g.aimT = 0;
      g.group.visible = false;
    }
  }

  reset() {
    this.hp = this.maxHp;
    this.downed = false;
    this.alarm = 0;
    this.lastDamage = -99;
    this.slowmo = 0;
    for (const g of this.guards) {
      g.dead = false;
      g.state = 'patrol';
      g.suspicion = 0;
      g.group.visible = false;
      g.parts.gun.visible = true;
    }
  }

  get alerted() { return this.alarm > 0; }

  raiseAlarm(seconds = 14, source) {
    this.alarm = Math.max(this.alarm, seconds);
    for (const g of this.guards) {
      if (g.dead) continue;
      if (source && g.pos.distanceToSquared(source) > 70 * 70) continue;
      if (g.alert()) this.hooks.onAlert && this.hooks.onAlert(g);
    }
  }

  /* ------------------------------------------------------------ 射线 / 视线 */
  /* 视线检测：使用独立临时向量，绝不修改传入的 from / to
     （早期版本复用了 _v1，导致 playerCenter 被覆盖，守卫永远打不中） */
  losClear(from, to) {
    _vLOS.subVectors(to, from);
    const dist = _vLOS.length();
    if (dist < 0.4) return true;
    _vLOS.divideScalar(dist);
    const hit = this.world.rayCast(from, _vLOS, dist - 0.35, NOT_ZONE);
    return !hit;
  }

  /* ------------------------------------------------------------ 近战 */
  melee(P) {
    const fwd = _v3.set(-Math.sin(P.yaw), 0, -Math.cos(P.yaw));
    const origin = _v1.set(P.pos.x, P.pos.y + 1.2, P.pos.z);
    let hit = null, best = 1e9;
    for (const g of this.guards) {
      if (g.dead) continue;
      _v2.set(g.pos.x - origin.x, g.y + 1.1 - origin.y, g.pos.z - origin.z);
      const d = _v2.length();
      if (d > 2.9) continue;
      _v2.normalize();
      if (_v2.dot(fwd) < 0.25) continue;
      if (!this.losClear(origin, _v2.clone().multiplyScalar(d).add(origin))) continue;
      if (d < best) { best = d; hit = g; }
    }
    if (!hit) {
      audio.whoosh();
      return { hit: false };
    }
    hit.stun(1.3);
    hit.disarm();
    this.kills++;
    this.slowmo = 0.42;
    audio.fleshHit();
    audio.kick();
    this.hooks.onMelee && this.hooks.onMelee(hit);
    /* 附近守卫被惊动 */
    this.raiseAlarm(12, hit.pos);
    return { hit: true, guard: hit };
  }

  /* ------------------------------------------------------------ 伤害 */
  damage(n, fromPos) {
    if (this.downed) return;
    /* 受击后的短暂无敌帧：避免多名守卫同帧叠加瞬间击倒 */
    if (this.time - this._lastHit < 0.4) return;
    this._lastHit = this.time;
    this.hp = Math.max(0, this.hp - n);
    this.lastDamage = this.time;
    this.hooks.onDamage && this.hooks.onDamage(n, fromPos);
    if (this.hp <= 0) {
      this.downed = true;
      this.hooks.onDown && this.hooks.onDown();
    }
  }

  /* ------------------------------------------------------------ 守卫 AI */
  update(dt, P) {
    this.time += dt;
    if (this.alarm > 0) this.alarm -= dt;
    if (this.slowmo > 0) this.slowmo -= dt;
    if (this.downed) return;

    /* 回复：脱离交火 5 秒后缓慢恢复 */
    if (this.time - this.lastDamage > 5 && this.hp < this.maxHp) {
      this.hp = Math.min(this.maxHp, this.hp + 20 * dt);
    }

    const playerCenter = _pc.set(P.pos.x, P.pos.y + 1.15, P.pos.z);
    const crouch = P.moveState === 'crouch' || P.moveState === 'slide';
    const speed = Math.hypot(P.vel.x, P.vel.z);
    let seen = false;

    for (const g of this.guards) {
      const dx = g.pos.x - P.pos.x, dz = g.pos.z - P.pos.z;
      const d2 = dx * dx + dz * dz;
      const near = d2 < 170 * 170;
      g.group.visible = near;
      if (!near) continue;

      if (g.state === 'down') {
        g.group.rotation.set(1.5, g.yaw, 0);
        g.group.position.set(g.pos.x, g.y + 0.25, g.pos.z);
        continue;
      }
      if (g.state === 'stunned') {
        g.stateT -= dt;
        if (g.stateT <= 0) { g.state = 'patrol'; g.suspicion = 0; }
      }

      if (g.state === 'patrol' || g.state === 'suspicious') {
        /* 巡逻移动 */
        const target = g.dir > 0 ? g.b : g.a;
        const moved = g.moveToward(target.x, target.z, 1.5, dt);
        if (Math.hypot(target.x - g.pos.x, target.z - g.pos.z) < 0.5) g.dir = -g.dir;
        /* 行走动画 */
        const sw = Math.sin(g.walkPhase) * 0.5 * Math.min(1, moved / Math.max(0.001, 1.5 * dt));
        g.parts.legL.rotation.x = sw;
        g.parts.legR.rotation.x = -sw;
        g.parts.armL.rotation.x = -sw * 0.7;
        g.parts.armR.rotation.x = sw * 0.7 - 0.15;
        g.parts.torso.rotation.z = 0;

        /* 发现玩家 */
        const dist = Math.sqrt(d2);
        const sight = crouch ? 24 : 52;
        if (dist < sight) {
          _v2.set(P.pos.x - g.pos.x, (P.pos.y + 1.2) - (g.y + EYE_Y), P.pos.z - g.pos.z).normalize();
          const facing = _v3.set(-Math.sin(g.yaw), 0, -Math.cos(g.yaw));
          const dot = _v2.x * facing.x + _v2.z * facing.z;
          const aware = g.state === 'suspicious' ? -0.2 : (speed > 9 ? 0.25 : 0.45);
          if (dot > aware && this.losClear(_v2.set(g.pos.x, g.y + EYE_Y, g.pos.z), playerCenter)) {
            g.suspicion = Math.min(1.4, g.suspicion + dt * (crouch ? 1.1 : 2.4));
            if (g.suspicion > 0.55) {
              g.yaw = Math.atan2(-(P.pos.x - g.pos.x), -(P.pos.z - g.pos.z));
              if (g.state !== 'suspicious') { g.state = 'suspicious'; audio.guardAlert(); }
            }
            if (g.suspicion >= 1.2) {
              g.alert();
              this.raiseAlarm(14, g.pos);
              this.hooks.onSpotted && this.hooks.onSpotted(g);
              seen = true;
            }
          } else {
            g.suspicion = Math.max(0, g.suspicion - dt * 0.5);
            if (g.state === 'suspicious' && g.suspicion <= 0) g.state = 'patrol';
          }
        } else {
          g.suspicion = Math.max(0, g.suspicion - dt * 0.4);
        }
      } else if (g.state === 'combat') {
        g.stateT += dt;
        const dist = Math.sqrt(d2);
        g.yaw = Math.atan2(-(P.pos.x - g.pos.x), -(P.pos.z - g.pos.z));
        /* 追击：保持在屋顶上，靠近玩家所在位置并停下射击 */
        if (dist > 15) {
          const tx = clamp(P.pos.x, g.x0, g.x1);
          const tz = clamp(P.pos.z, g.z0, g.z1);
          g.moveToward(tx, tz, 3.1, dt);
          const sw = Math.sin(g.walkPhase) * 0.55;
          g.parts.legL.rotation.x = sw;
          g.parts.legR.rotation.x = -sw;
          g.parts.armL.rotation.x = 0.3;
          g.parts.armR.rotation.x = -0.9;
          g.weaponUp = true;
        } else {
          g.parts.legL.rotation.x = 0;
          g.parts.legR.rotation.x = 0;
          g.parts.armL.rotation.x = -0.5;
          g.parts.armR.rotation.x = -1.35;
          g.weaponUp = true;
        }
        g.parts.torso.rotation.z = 0;
        g.parts.gun.visible = true;
        if (g.parts.gun) {
          g.parts.gun.position.set(0.3, 1.33, -0.36);
          g.parts.gun.rotation.x = 0;
        }

        g.aimT += dt;
        g.fireCd -= dt;
        const canSee = dist < 60 && this.losClear(_v2.set(g.pos.x, g.y + EYE_Y, g.pos.z), playerCenter);
        if (canSee && g.aimT > 0.55 && g.fireCd <= 0) {
          this.fire(g, P, playerCenter);
          g.fireCd = rand(1.45, 2.25);
          g.aimT = 0.2;
        }
        if (this.time - this.lastSeen > 6 && !canSee) {
          /* 跟丢玩家：回到巡逻 */
          g.state = 'suspicious';
          g.suspicion = 0.3;
        }
        if (canSee) { this.lastSeen = this.time; g.lastSeen = this.time; }
        if (dist < 2.2 && !g.meleeCd) {
          g.meleeCd = 1.2;
          this.damage(9, g.pos);
          audio.fleshHit();
        }
        if (g.meleeCd) g.meleeCd -= dt;
      }

      /* 位置 / 朝向落盘 */
      g.group.position.set(g.pos.x, g.y, g.pos.z);
      g.group.rotation.y = g.yaw;
      if (g.state !== 'down') g.group.rotation.x = 0;
    }

    /* 与玩家保持最小间距（不做动态碰撞体，用软推开） */
    for (const g of this.guards) {
      if (g.dead || !g.group.visible) continue;
      const dx = P.pos.x - g.pos.x, dz = P.pos.z - g.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.001 && d < 0.9 && Math.abs(P.pos.y - g.y) < 1.9) {
        const push = (0.9 - d);
        P.pos.x += dx / d * push * 0.6;
        P.pos.z += dz / d * push * 0.6;
      }
    }

    /* 特效衰减 */
    for (const t of this.tracers) {
      if (t.life > 0) {
        t.life -= dt;
        t.mesh.material.opacity = Math.max(0, t.life / 0.12) * 0.9;
        if (t.life <= 0) t.mesh.visible = false;
      }
    }
    for (const f of this.flashes) {
      if (f.life > 0) {
        f.life -= dt;
        f.sp.material.opacity = Math.max(0, f.life / 0.07);
        if (f.life <= 0) f.sp.visible = false;
      }
    }

    /* 警报解除 */
    if (this.alarm <= 0) {
      let any = false;
      for (const g of this.guards) if (g.state === 'combat' && !g.dead) any = true;
      if (!any && this.hooks.onAlarmEnd) this.hooks.onAlarmEnd();
    }
    /* 警报开始时通知一次 */
    if (seen && this.hooks.onAlarmStart) this.hooks.onAlarmStart();
  }

  fire(g, P, playerCenter) {
    const muzzle = _v1.set(g.pos.x, g.y + 1.32, g.pos.z);
    const dir = _v2.subVectors(playerCenter, muzzle);
    const dist = dir.length();
    if (dist < 0.4) return;
    dir.divideScalar(dist);
    /* 精度：跑得越快越难被命中；蹲伏不动更容易被打中 */
    const hs = Math.hypot(P.vel.x, P.vel.z);
    const spread = 0.012 + clamp(hs / 12, 0, 1) * 0.045 + (P.grounded ? 0 : 0.02);
    dir.x += rand(-spread, spread);
    dir.y += rand(-spread, spread);
    dir.z += rand(-spread, spread);
    dir.normalize();

    const wall = this.world.rayCast(muzzle, dir, Math.min(dist, 70), NOT_ZONE);
    const hitDist = wall ? Math.min(wall.t, dist) : Math.min(dist, 70);
    const willHitPlayer = (!wall || wall.t > dist - 0.45) && dist < 62;

    /* 曳光弹 */
    const tr = this.tracers.find((t) => t.life <= 0) || this.tracers[0];
    tr.life = 0.12;
    tr.mesh.visible = true;
    tr.mesh.material.opacity = 0.9;
    tr.mesh.position.copy(muzzle).addScaledVector(dir, hitDist / 2);
    tr.mesh.scale.set(1, 1, Math.max(0.4, hitDist));
    _q1.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    tr.mesh.quaternion.copy(_q1);

    /* 枪口闪光 */
    const fl = this.flashes.find((f) => f.life <= 0) || this.flashes[0];
    fl.life = 0.07;
    fl.sp.visible = true;
    fl.sp.position.copy(muzzle).addScaledVector(dir, 0.5);
    fl.sp.material.opacity = 1;

    this.shots++;
    audio.gunshot();

    if (willHitPlayer) {
      _v3.subVectors(playerCenter, muzzle).normalize();
      this.damage(9, g.pos);
      this.hooks.onHitMarker && this.hooks.onHitMarker();
    }
  }

  /* 给 HUD 用的状态 */
  status() {
    let combatCount = 0;
    for (const g of this.guards) if (!g.dead && g.state === 'combat') combatCount++;
    return { hp: this.hp, maxHp: this.maxHp, alarm: this.alarm, combatCount };
  }
}
