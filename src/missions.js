
import * as THREE from '../vendor/three.module.js';
import { clamp, rand, pick, mulberry32 } from './util.js';
import { audio } from './audio.js';
import {
  profile, addCredits, addXp, markMissionDone, advanceStory,
  dailySeed, dailyInfo, completeDaily, saveProfile,
} from './profile.js';

/* =========================================================================
   城市委托 / 剧情行动 / 每日挑战
   ------------------------------------------------------------------------
   四种委托：
   · 递送 DELIVERY  取件 → 送达（限时）
   · 脱逃 EVADE     触发警报 → 在追捕中抵达安全屋
   · 侦查 SCOUT     依次抵达 3 个信号点
   · 追踪 COURIER   跟上无人机，在时限内抵达终点
   系统只负责规则与 3D 信标；UI 由 main.js 渲染
   ========================================================================= */

const STORY = [
  { id: 'story-1', name: '第一单', kind: 'delivery', tag: '剧情 01', desc: '把一个不起眼的包裹送到金融城的屋顶。别问里面是什么。', reward: { credits: 120, xp: 90 }, dist: [60, 120], time: 150 },
  { id: 'story-2', name: '断线', kind: 'evade', tag: '剧情 02', desc: 'City Protection 已经盯上你。跑出封锁区，回到老城的接应点。', reward: { credits: 180, xp: 140 }, dist: [110, 190], time: 120 },
  { id: 'story-3', name: '三处信号', kind: 'scout', tag: '剧情 03', desc: '校准中继器：依次经过三个信号点，别让巡逻队看到你。', reward: { credits: 220, xp: 180 }, dist: [70, 150], time: 170, points: 3 },
  { id: 'story-4', name: '高处的眼睛', kind: 'scout', tag: '剧情 04', desc: '跑到 Shard 的楼顶停机坪，把整座城市看一遍。', reward: { credits: 260, xp: 220 }, dist: [140, 220], time: 190, points: 2, landmark: true },
  { id: 'story-5', name: '黑箱', kind: 'delivery', tag: '剧情 05', desc: '包裹必须在警报响起前送到码头。别走直线，别停下。', reward: { credits: 340, xp: 300 }, dist: [170, 260], time: 200, guards: true },
  { id: 'story-6', name: '最后一段', kind: 'evade', tag: '剧情 06', desc: '全城的眼睛都在找你。跑到最远的那个屋顶，然后跳下去。', reward: { credits: 520, xp: 480 }, dist: [200, 300], time: 150, guards: true },
];

const KIND_INFO = {
  delivery: { label: '递送', verb: '取件', verb2: '送达' },
  evade: { label: '脱逃', verb: '触发警报', verb2: '抵达安全屋' },
  scout: { label: '侦查', verb: '信号点', verb2: '信号点' },
  courier: { label: '追踪', verb: '跟上无人机', verb2: '终点' },
};

let uid = 1;

export class MissionSystem {
  constructor(world, scene, deps) {
    this.world = world;
    this.scene = scene;
    this.deps = deps; // { getPlayer, combat, hooks }
    this.active = null;
    this.offers = [];
    this.story = null;
    this.daily = null;
    this.lastRefresh = -999;
    this.time = 0;
    this.marker = this.buildMarker();
    this.stageFx = this.buildStageFx();
    this.hud = { show: false, title: '', objective: '', distText: '', timeText: '', urgency: false };
    this.refreshOffers();
    this.buildStory();
    this.buildDaily();
  }

  /* ------------------------------------------------------------- 信标 */
  buildMarker() {
    const g = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd75e, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.08, 8, 40), ringMat);
    ring.rotation.x = Math.PI / 2;
    const beamTex = (() => {
      const c = document.createElement('canvas');
      c.width = 16; c.height = 128;
      const x = c.getContext('2d');
      const grd = x.createLinearGradient(0, 0, 0, 128);
      grd.addColorStop(0, 'rgba(255,215,94,0)');
      grd.addColorStop(0.6, 'rgba(255,215,94,0.55)');
      grd.addColorStop(1, 'rgba(255,215,94,0.9)');
      x.fillStyle = grd;
      x.fillRect(0, 0, 16, 128);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 1.5, 40, 12, 1, true),
      new THREE.MeshBasicMaterial({ map: beamTex, color: 0xffd75e, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    );
    beam.position.y = 20;
    const beam2 = beam.clone();
    beam2.material = beam.material.clone();
    beam2.material.opacity = 0.18;
    beam2.scale.set(2.6, 1.7, 2.6);
    g.add(ring, beam, beam2);
    g.visible = false;
    g.layers.set(1);
    this.scene.add(g);
    return { group: g, ring, beam, beam2, mat: ringMat };
  }

  buildStageFx() {
    const geo = new THREE.TorusGeometry(0.55, 0.06, 8, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0x5ad7ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const list = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.layers.set(1);
      this.scene.add(m);
      list.push({ mesh: m, life: 0 });
    }
    return list;
  }

  /* ------------------------------------------------------------- 位置生成 */
  get player() { return this.deps.getPlayer(); }

  pickRoof(minDist, maxDist, rnd) {
    const P = this.player;
    const bs = this.world.openCity.buildings;
    if (!P || !bs.length) return null;
    const ox = P.pos.x, oz = P.pos.z;
    for (let i = 0; i < 90; i++) {
      const b = bs[Math.floor((rnd ? rnd() : Math.random()) * bs.length)];
      if (!b || b.top < 6 || b.top > 92 || b.w < 9 || b.d < 9) continue;
      const d = Math.hypot(b.cx - ox, b.cz - oz);
      if (d < minDist || d > maxDist) continue;
      for (let k = 0; k < 6; k++) {
        const x = b.cx + (Math.random() - 0.5) * (b.w - 6);
        const z = b.cz + (Math.random() - 0.5) * (b.d - 6);
        if (this.world.pointInsideProp(x, b.top + 1.4, z, 0.9)) continue;
        return { x, y: b.top + 0.05, z, roof: b };
      }
    }
    return null;
  }

  landmarkPoint(kind) {
    if (kind === 'shard') return { x: 138, y: 118.4, z: -184 };
    if (kind === 'highway') return { x: 60, y: 15.05, z: -161 + 4 };
    if (kind === 'park') return { x: -184, y: 0.1, z: 138 };
    return null;
  }

  /* ------------------------------------------------------------- 委托生成 */
  makeMission(kind, opts = {}) {
    const P = this.player;
    const dist = opts.dist || [60, 160];
    const a = this.pickRoof(30, 110) || { x: 30, y: 16, z: 0 };
    const b = this.pickRoof(dist[0], dist[1]) || { x: 120, y: 16, z: 0 };
    const stages = [];
    if (kind === 'delivery' || kind === 'courier' || kind === 'evade') {
      stages.push({ x: a.x, y: a.y + 1.6, z: a.z, label: kind === 'evade' ? '前往触发点' : '取件' });
      stages.push({ x: b.x, y: b.y + 1.6, z: b.z, label: kind === 'evade' ? '安全屋' : '送达' });
    } else if (kind === 'scout') {
      const n = opts.points || 3;
      const used = [];
      for (let i = 0; i < n; i++) {
        let p = null;
        for (let t = 0; t < 20 && !p; t++) {
          const cand = i === 0 && opts.landmark ? this.landmarkPoint('shard') : this.pickRoof(dist[0] * 0.5, dist[1]);
          if (!cand) continue;
          if (used.some((u) => Math.hypot(u.x - cand.x, u.z - cand.z) < 40)) continue;
          used.push(cand);
          p = cand;
        }
        if (p) stages.push({ x: p.x, y: p.y + 1.6, z: p.z, label: '信号点 ' + (i + 1) });
      }
    }
    const time = opts.time || (90 + Math.round(dist[1] * 0.5));
    return {
      id: 'm' + (uid++),
      kind,
      tag: KIND_INFO[kind] ? KIND_INFO[kind].label : '委托',
      name: opts.name || (KIND_INFO[kind] ? KIND_INFO[kind].label + '委托' : '城市委托'),
      desc: opts.desc || '完成这条路线，拿回你的报酬。',
      stages,
      stage: 0,
      timeLimit: time,
      timeLeft: time,
      reward: opts.reward || { credits: Math.round(50 + dist[1] * 0.55), xp: Math.round(40 + dist[1] * 0.35) },
      guards: !!opts.guards,
      story: !!opts.story,
      storyIndex: opts.storyIndex,
      daily: !!opts.daily,
      state: 'offer',
      started: false,
      startedAt: 0,
    };
  }

  refreshOffers() {
    const kinds = ['delivery', 'evade', 'scout', 'courier'];
    this.offers = [];
    for (let i = 0; i < 3; i++) {
      const kind = kinds[(Math.floor(Math.random() * kinds.length) + i) % kinds.length];
      const m = this.makeMission(kind, {
        dist: [70, 220],
        time: 130 + Math.round(Math.random() * 70),
      });
      m.name = pick(['高空快递', '屋顶转场', '阴影中的包裹', '城市脉搏', '断线重连', '夜间班次', '最后的信标']) + ' · ' + m.tag;
      m.desc = pick([
        '收件人不会等你。走屋顶，别走地面。',
        '这一单的路线被 City Protection 标记为高风险。跑快点。',
        '沿着跑者视觉的红色路线，穿过三个街区。',
        '包裹很轻，时间很重。',
        '客户要求无接触交付。别留下痕迹。',
      ]);
      this.offers.push(m);
    }
    this.lastRefresh = this.time;
  }

  buildStory() {
    const step = clamp(profile.story, 0, STORY.length - 1);
    const def = STORY[step];
    const m = this.makeMission(def.kind, {
      name: def.name,
      desc: def.desc,
      reward: def.reward,
      dist: def.dist,
      time: def.time,
      points: def.points,
      landmark: def.landmark,
      guards: def.guards,
      story: true,
      storyIndex: step,
    });
    m.tag = def.tag;
    m.id = def.id;
    this.story = m;
  }

  buildDaily() {
    const info = dailyInfo();
    const rnd = mulberry32(dailySeed());
    const m = this.makeMission('scout', {
      name: '每日挑战 · ' + new Date().toISOString().slice(5, 10),
      desc: '今日城市挑战：连续抵达 3 个信号点，越快越好。每天刷新一次。',
      dist: [90, 200],
      time: 105,
      points: 3,
      reward: { credits: 320, xp: 260 },
    });
    m.daily = true;
    m.done = !!info.done;
    m.best = info.score || 0;
    this.daily = m;
  }

  /* ------------------------------------------------------------- 接受 / 放弃 */
  accept(mission) {
    if (!mission) return false;
    const P = this.player;
    if (!P) return false;
    if (this.active) this.abandon(true);
    mission.state = 'active';
    mission.stage = 0;
    mission.timeLeft = mission.timeLimit;
    mission.startedAt = this.time;
    mission.started = false;
    this.active = mission;
    this.updateMarker();
    if (mission.daily) this.daily = mission;
    else if (mission.story) this.story = mission;
    else {
      const i = this.offers.indexOf(mission);
      if (i >= 0) this.offers.splice(i, 1);
    }
    if (mission.kind === 'evade' && this.deps.combat) {
      this.deps.combat.raiseAlarm(45);
      this.deps.combat.hooks && this.deps.combat.hooks.onAlarmStart && this.deps.combat.hooks.onAlarmStart();
    }
    audio.missionAccept();
    this.deps.hooks.onToast && this.deps.hooks.onToast('◈ 已接受：' + mission.name, 2600);
    return true;
  }

  abandon(quiet) {
    if (!this.active) return;
    if (this.active.story || this.active.daily) {
      this.active.state = 'offer';
    } else {
      this.active.state = 'offer';
      this.offers.push(this.active);
    }
    this.active = null;
    this.marker.group.visible = false;
    this.hud.show = false;
    if (!quiet) this.deps.hooks.onToast && this.deps.hooks.onToast('✖ 已放弃任务', 1600);
  }

  /* ------------------------------------------------------------- 更新 */
  update(dt, P) {
    this.time += dt;
    if (!this.active) {
      this.hud.show = false;
      this.marker.group.visible = false;
      return;
    }
    const m = this.active;
    if (!m.started) {
      /* 从接单开始计时，制造紧迫感 */
      m.started = true;
    }
    m.timeLeft -= dt;
    if (m.timeLeft <= 0) { this.fail('时间耗尽'); return; }

    const st = m.stages[m.stage];
    if (!st) { this.complete(); return; }

    /* 抵达判定 */
    const dx = P.pos.x - st.x, dz = P.pos.z - st.z;
    const dy = (P.pos.y + 1.0) - st.y;
    if (dx * dx + dz * dz < 10.0 && Math.abs(dy) < 6.5) {
      m.stage++;
      audio.gate(m.stage);
      if (m.stage >= m.stages.length) { this.complete(); return; }
      const nx = m.stages[m.stage];
      this.burst(st.x, st.y, st.z);
      this.deps.hooks.onToast && this.deps.hooks.onToast('◈ ' + (m.stages[m.stage].label) + ' · 还剩 ' + Math.ceil(m.timeLeft) + 's', 2200);
      this.updateMarker();
    }

    /* 追踪类：警报常驻 */
    if (m.kind === 'evade' && this.deps.combat) {
      if (this.deps.combat.alarm < 2) this.deps.combat.raiseAlarm(12);
    }

    this.updateMarker();
    this.updateHud(P);
  }

  updateMarker() {
    const m = this.active;
    if (!m) { this.marker.group.visible = false; return; }
    const st = m.stages[m.stage];
    if (!st) { this.marker.group.visible = false; return; }
    this.marker.group.visible = true;
    this.marker.group.position.set(st.x, st.y - 1.2, st.z);
  }

  updateHud(P) {
    const m = this.active;
    if (!m) { this.hud.show = false; return; }
    const st = m.stages[m.stage];
    if (!st) { this.hud.show = false; return; }
    const d = Math.hypot(st.x - P.pos.x, st.z - P.pos.z);
    this.hud.show = true;
    this.hud.title = m.name;
    this.hud.objective = st.label + (m.stage === 0 && m.kind === 'delivery' ? ' · 前往取件点' : '');
    this.hud.distText = Math.round(d) + ' m';
    this.hud.timeText = Math.ceil(m.timeLeft) + ' s';
    this.hud.urgency = m.timeLeft < 20;
    this.hud.stage = m.stage + 1;
    this.hud.stages = m.stages.length;
  }

  /* ------------------------------------------------------------- 结算 */
  complete() {
    const m = this.active;
    if (!m) return;
    m.state = 'done';
    const P = this.player;
    const used = m.timeLimit - m.timeLeft;
    let credits = m.reward.credits;
    let xp = m.reward.xp;
    /* 剩余时间奖励 */
    const bonus = Math.min(Math.round(m.timeLeft * 1.5), Math.round(m.reward.credits * 0.6));
    credits += bonus;
    addCredits(credits);
    addXp(xp);
    if (m.story) {
      markMissionDone(m.id);
      advanceStory((m.storyIndex || 0) + 1);
      this.buildStory();
      this.deps.hooks.onToast && this.deps.hooks.onToast('★ 剧情推进 · ' + m.name, 3400);
    } else if (m.daily) {
      m.done = true;
      m.best = Math.round(used);
      completeDaily(Math.round(used), 0);
      this.buildDaily();
    } else {
      markMissionDone(m.id);
      this.deps.hooks.onToast && this.deps.hooks.onToast('✔ 委托完成 · +' + credits + ' 信用点', 3200);
    }
    audio.missionDone();
    this.burstAll(m);
    this.deps.hooks.onComplete && this.deps.hooks.onComplete(m, credits, xp, bonus);
    this.active = null;
    this.marker.group.visible = false;
    this.hud.show = false;
  }

  fail(reason) {
    const m = this.active;
    if (!m) return;
    m.state = 'failed';
    if (m.story || m.daily) {
      m.timeLeft = m.timeLimit;
      m.stage = 0;
      m.state = 'offer';
      if (m.story) this.story = m; else this.daily = m;
    } else {
      this.offers.push(m);
    }
    this.deps.hooks.onToast && this.deps.hooks.onToast('✖ 任务失败 · ' + reason, 3000);
    audio.missionFail();
    this.deps.hooks.onFail && this.deps.hooks.onFail(m, reason);
    this.active = null;
    this.marker.group.visible = false;
    this.hud.show = false;
  }

  /* ------------------------------------------------------------- 特效 */
  burst(x, y, z) {
    if (this.world.burst) this.world.burst(new THREE.Vector3(x, y, z), 0xffd75e, 22, { life: 0.8, spread: 3.6, upBias: 0.8, additive: true, size: 0.14 });
  }

  burstAll(m) {
    for (const st of m.stages) this.burst(st.x, st.y, st.z);
  }

  updateFx(dt, t) {
    if (this.marker.group.visible) {
      this.marker.ring.rotation.z = t * 1.4;
      this.marker.ring.position.y = Math.sin(t * 2) * 0.25;
      this.marker.mat.opacity = 0.65 + Math.sin(t * 4) * 0.2;
      this.marker.beam.material.opacity = 0.3 + Math.sin(t * 2.4) * 0.08;
    }
  }

  /* 供 UI 使用 */
  storyIndex() { return clamp(profile.story, 0, STORY.length - 1); }
  storyDone() { return profile.story >= STORY.length; }
  storyDefs() { return STORY; }
}

export { STORY };
