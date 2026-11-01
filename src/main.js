import * as THREE from '../vendor/three.module.js';
import { Graphics } from './graphics.js';

import {
  clamp, lerp, damp, fmtTime, rand, mulberry32,
  makeCanvas, PHYS, settings, saveSettings, saveJSON, loadJSON, sanitizeText, isMobileDevice,
} from './util.js';
import { audio } from './audio.js';
import { music, TRACK_CATALOG } from './music.js';
import { net } from './net.js';
import { buildWorld } from './world.js';
import { createPlayer } from './player.js';
import { CombatSystem } from './combat.js';
import { MissionSystem } from './missions.js';
import { TouchControls } from './touch.js';
import {
  profile, SKILLS, SKINS, skillLevel, skillCost, buySkill, buySkin, equipSkin,
  addXp, addCredits, rankName, levelProgress, dailyInfo, skinDef, saveProfile, skillEffect,
} from './profile.js';

/* =========================================================================
   镜之边缘 · WEB —— 开放世界第一人称跑酷
   Three.js + WebGL2 · 程序化白色都市 · 动态 BGM · 公共中继联机 · 计时挑战
   ========================================================================= */

const eulerYaw = (dx, dz) => Math.atan2(-dx, -dz);

/* ------------------------------------------------------------- DOM */
const $ = (id) => document.getElementById(id);
const dom = {
  canvas: $('game'),
  loading: $('loading'),
  loadingFill: $('loading-fill'),
  loadingText: $('loading-text'),
  menu: $('menu'),
  pause: $('pause'),
  finish: $('finish'),
  records: $('records'),
  btnStart: $('btn-start'),
  btnResume: $('btn-resume'),
  btnRestart: $('btn-restart'),
  btnQuit: $('btn-quit'),
  btnAgain: $('btn-again'),
  timer: $('timer'),
  objective: $('objective'),
  prompt: $('prompt'),
  marker: $('marker'),
  marker2: $('marker2'),
  speedBox: $('speed-box'),
  staminaFill: $('stamina-fill'),
  stateLabel: $('state-label'),
  crosshair: $('crosshair'),
  damage: $('damage'),
  fxCanvas: $('fx-canvas'),
  finishTitle: $('finish-title'),
  finishSub: $('finish-sub'),
  finishTime: $('finish-time'),
  finishBest: $('finish-best'),
  statMaxspeed: $('stat-maxspeed'),
  statJumps: $('stat-jumps'),
  statDeaths: $('stat-deaths'),
  statCp: $('stat-cp'),
  statRoute: $('stat-route'),
  setSens: $('set-sens'),
  setFov: $('set-fov'),
  setQuality: $('set-quality'),
  setRT: $('set-rt'),
  setTime: $('set-time'),
  setTouch: $('set-touch'),
  chkAutoSprint: $('chk-autosprint'),
  setVolume: $('set-volume'),
  setMusicVolume: $('set-music-volume'),
  chkGhost: $('chk-ghost'),
  musicTrack: $('music-track'),
  musicLabel: $('music-label'),
  trackList: $('track-list'),
  netLabel: $('net-label'),
  netStatus: $('net-status'),
  netCount: $('net-count'),
  netState: $('net-state'),
  netfeed: $('netfeed'),
  chatLog: $('chat-log'),
  chatWrap: $('chat-wrap'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),
  btnChatCancel: $('btn-chat-cancel'),
  btnFinishContinue: $('btn-finish-continue'),
  btnPauseX: $('btn-pause-x'),
  btnRecordsX: $('btn-records-x'),
  btnPauseRespawn: $('btn-pause-respawn'),
  btnPauseLight: $('btn-pause-light'),
  btnPauseMusic: $('btn-pause-music'),
  btnPauseNext: $('btn-pause-next'),
  btnPauseFs: $('btn-pause-fs'),
  runnerMarker: $('runner-marker'),
  nick: $('nick'),
  room: $('room'),
  btnNet: $('btn-net'),
  routeCount: $('route-count'),
  flowBox: $('flow-box'),
  flowNum: $('flow-num'),
  flowCombo: $('flow-combo'),
  flowFill: $('flow-fill'),
  flowPop: $('flow-pop'),
  coinCount: $('coin-count'),
  coinTotal: $('coin-total'),
  achToast: $('ach-toast'),
  achList: $('ach-list'),
  recCoins: $('rec-coins'),
  recDistance: $('rec-distance'),
  recMaxspeed: $('rec-maxspeed'),
  recMoves: $('rec-moves'),
  recFlow: $('rec-flow'),
  recRoute: $('rec-route'),
  trialList: $('trial-list'),
  lbList: $('lb-list'),
  btnRecordsClose: $('btn-records-close'),
  trial: $('trial'),
  trialName: $('trial-name'),
  trialTime: $('trial-time'),
  trialGates: $('trial-gates'),
  trialDelta: $('trial-delta'),
  creditCount: $('credit-count'),
  levelNum: $('level-num'),
  healthFill: $('health-fill'),
  alertBanner: $('alert-banner'),
  hitmarker: $('hitmarker'),
  missionHud: $('mission-hud'),
  mhTitle: $('mh-title'),
  mhObj: $('mh-obj'),
  mhDist: $('mh-dist'),
  mhTime: $('mh-time'),
  missionsPanel: $('missions'),
  storyList: $('story-list'),
  contractList: $('contract-list'),
  missionActive: $('mission-active'),
  dailyCard: $('daily-card'),
  btnRefresh: $('btn-refresh'),
  btnMissionsClose: $('btn-missions-close'),
  shopPanel: $('shop'),
  skillList: $('skill-list'),
  skinList: $('skin-list'),
  shopCredits: $('shop-credits'),
  shopLevel: $('shop-level'),
  shopRank: $('shop-rank'),
  btnShopClose: $('btn-shop-close'),
  marker3: (() => {
    const el = document.createElement('div');
    el.id = 'marker3';
    el.innerHTML = '<span>◆</span>';
    el.style.cssText = 'position:fixed;width:34px;height:34px;left:50%;top:50%;transform:translate(-50%,-50%);font-size:26px;color:#ffd75e;text-shadow:0 0 12px #ffb020;display:none;align-items:center;justify-content:center;z-index:12;pointer-events:none';
    el.firstElementChild.style.cssText = 'display:block;transform:rotate(45deg)';
    el.classList.add('show');
    document.body.appendChild(el);
    return el;
  })(),
};

dom.setSens.value = settings.sens;
dom.setFov.value = settings.fov;
dom.setQuality.value = settings.quality;
dom.setRT.value = settings.rt || 'low';
dom.setTime.value = settings.timeOfDay || 'morning';
if (dom.setTouch) dom.setTouch.value = settings.touch || 'auto';
if (dom.chkAutoSprint) dom.chkAutoSprint.checked = settings.autoSprint !== false;
dom.setVolume.value = settings.volume;
dom.setMusicVolume.value = settings.musicVolume;
dom.chkGhost.checked = settings.ghost !== false;
dom.nick.value = settings.name || '';
dom.room.value = settings.room || 'white-city';

/* ------------------------------------------------------- 渲染器 */
const renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileDevice() ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
/* 光照 / 阴影 / 后期管线全部由 src/graphics.js 接管 */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9dff0);
scene.fog = new THREE.Fog(0xd3e6f2, 320, 1500);

const camera = new THREE.PerspectiveCamera(settings.fov, window.innerWidth / window.innerHeight, 0.07, 2400);
camera.rotation.order = 'YXZ';
scene.add(camera);

/* 全新图形管线：单一太阳方向 · 纹素吸附阴影 · 天空 PMREM · 大气透视 · ACES 调色 */
const gfx = new Graphics(renderer, scene, camera);
camera.layers.enable(1);

/* ------------------------------------------------------- 世界 */
let world = null;
let player = null;
let P = null;
let combat = null;
let missions = null;
let missionsOpen = false;
let shopOpen = false;
let meleeAnimT = 0;
let meleeCd = 0;
let _alarmWas = false;

const stats = {
  jumps: 0, deaths: 0, maxSpeed: 0, distance: 0, airTimeTotal: 0,
  coins: 0, wallruns: 0, ziplines: 0, springs: 0, slides: 0, mantles: 0, vaults: 0,
  gates: 0, routesDone: 0, trialsDone: 0, records: 0,
};

/* ------------------------------------------------------- FLOW */
const flowSave = Object.assign({ total: 0, best: 0, maxMult: 1, gates: 0, routes: 0, trials: 0 }, loadJSON('mirrorweb-flow', {}));
const flow = { score: 0, chain: 0, mult: 1, timer: 0 };
function saveFlow() { saveJSON('mirrorweb-flow', flowSave); }
function showFlowPop(text) {
  dom.flowPop.textContent = text;
  dom.flowPop.classList.remove('show');
  void dom.flowPop.offsetWidth;
  dom.flowPop.classList.add('show');
}
function gainFlow(base, label) {
  if (gameState !== 'playing' || !P || P.moveState === 'dead') return;
  flow.chain++;
  flow.mult = Math.min(5, 1 + Math.floor(flow.chain / 3));
  flowSave.maxMult = Math.max(flowSave.maxMult, flow.mult);
  const pts = Math.round(base * flow.mult);
  flow.score += pts;
  flow.timer = 4.5;
  showFlowPop(`+${pts} ${label} ×${flow.mult}`);
  if (flow.mult >= 2 && flow.chain % 3 === 0) audio.tone({ f0: 520 + flow.mult * 110, type: 'sine', dur: 0.06, gain: 0.03 });
}
function bankFlow(quiet = false) {
  if (flow.score > 0) {
    flowSave.total += flow.score;
    flowSave.best = Math.max(flowSave.best, flow.score);
    saveFlow();
    if (!quiet && flow.chain >= 4) showToast(`✦ FLOW 结算 · +${flow.score}`);
  }
  flow.score = 0; flow.chain = 0; flow.mult = 1; flow.timer = 0;
}

/* ------------------------------------------------------- 事件提示 */
function showToast(text, ms = 2600) {
  dom.objective.textContent = text;
  dom.objective.classList.add('show');
  toastTimer = ms;
}
function pushFeed(text, color = '#8fd8ff') {
  const el = document.createElement('div');
  el.className = 'feed-item';
  el.textContent = text;
  el.style.borderColor = color;
  dom.netfeed.prepend(el);
  while (dom.netfeed.children.length > 4) dom.netfeed.lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 5200);
}

/* ------------------------------------------------------- 玩家 */
const collectedCoinIds = new Set(loadJSON('mirrorweb-coins', []));
const keys = new Set();
const hooks = {
  keys: new Set(),
  flow,
  getMoveInput: () => getMoveInput(),
  sprintHeld: () => keys.has('ShiftLeft') || keys.has('ShiftRight'),
  crouchHeld: () => keys.has('KeyC') || keys.has('ControlLeft') || keys.has('ControlRight'),
  onFlow: (base, label) => gainFlow(base, label),
  onToast: (t, ms) => showToast(t, ms),
  onStat: (k, n = 1) => { stats[k] = (stats[k] || 0) + n; },
  onLand: (impact, surface) => { /* 落地钩子 */ },
  onDie: (reason) => {
    stats.deaths++;
    dom.damage.style.opacity = 0.85;
    bankFlow(true);
    if (combat) combat.onPlayerDeath();
    net.sendEvent('death', { r: reason || '' });
  },
};
/* hooks.keys 与输入共用同一个 Set */
hooks.keys = keys;

/* ------------------------------------------------------- 输入 */
let jumpQueued = false;
let gameState = 'menu';
let paused = false;
let recordsOpen = false;
let runStarted = false;
let runTime = 0;
let menuTime = 0;
let toastTimer = 0;
let achToastTimer = 0;
let currentPrompt = '';
let curDistrict = null;
let focusRoute = null;
let lockGrace = 0;

const _moveInput = { x: 0, y: 0, len: 0 };
let touch = null;
const sprintHeld = () => keys.has('ShiftLeft') || keys.has('ShiftRight') || (touch ? touch.isSprinting() : false);
const crouchHeld = () => keys.has('KeyC') || keys.has('ControlLeft') || keys.has('ControlRight') || (touch ? touch.isCrouching() : false);
hooks.sprintHeld = sprintHeld;
hooks.crouchHeld = crouchHeld;

function getMoveInput() {
  let f = 0, s = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) s += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) s -= 1;
  const len = Math.hypot(f, s);
  if (len > 0) {
    _moveInput.x = s / len;
    _moveInput.y = f / len;
    _moveInput.len = 1;
    return _moveInput;
  }
  const tm = touch ? touch.getMove() : null;
  if (tm && tm.len > 0) {
    _moveInput.x = tm.x;
    _moveInput.y = tm.y;
    _moveInput.len = tm.len;
    return _moveInput;
  }
  _moveInput.x = 0; _moveInput.y = 0; _moveInput.len = 0;
  return _moveInput;
}

touch = new TouchControls({
  onLook: (dyaw, dpitch) => {
    if (!P || gameState !== 'playing' || paused) return;
    P.yaw -= dyaw;
    P.pitch = clamp(P.pitch - dpitch, -1.45, 1.45);
  },
  onJump: () => {
    jumpQueued = true;
    if (gameState === 'playing' && player) player.queueJump();
  },
  onInteract: () => {
    if (gameState === 'playing' && player) player.queueInteract();
  },
  onMelee: () => {
    if (gameState === 'playing' && !paused && !anyPanelOpen()) tryMelee();
  },
  onTurn180: () => {
    if (gameState === 'playing' && !paused && player) player.quickTurn();
  },
  getSpeed: () => (P ? Math.hypot(P.vel.x, P.vel.z) : 0),
  onToggleMissions: () => { if (gameState === 'playing') toggleMissions(); },
  onToggleShop: () => { if (gameState === 'playing') toggleShop(); },
  onToggleTrial: () => { if (gameState === 'playing' && !paused) toggleTrial(); },
  onToggleRecords: () => { if (gameState === 'playing') toggleRecords(!recordsOpen); },
  onOpenChat: () => { if (gameState === 'playing' && !paused) openChat(); },
  onTogglePause: () => { if (gameState === 'playing') togglePause(); },
  onUserGesture: () => {
    if (audio.ctx && audio.ctx.state !== 'running') audio.ctx.resume().catch(() => {});
  },
  onModeChange: () => { currentPrompt = '__dirty__'; },
});

document.addEventListener('keydown', (e) => {
  if (chat.open) {
    if (e.code === 'Enter') { sendChat(); e.preventDefault(); }
    else if (e.code === 'Escape') { closeChat(); e.preventDefault(); }
    return;
  }
  if (e.repeat) {
    if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    return;
  }
  keys.add(e.code);
  if (e.code === 'Space') {
    jumpQueued = true;
    if (gameState === 'playing') { player.queueJump(); e.preventDefault(); }
  }
  if (e.code === 'KeyE') {
    if (gameState === 'playing') { player.queueInteract(); e.preventDefault(); }
  }
  if (e.code === 'KeyQ' && gameState === 'playing' && !paused && !anyPanelOpen()) {
    player.quickTurn();
    e.preventDefault();
  }
  if (e.code === 'KeyF' && gameState === 'playing' && !paused && !recordsOpen && !missionsOpen && !shopOpen) {
    tryMelee();
    e.preventDefault();
  }
  if (e.code === 'KeyJ' && gameState === 'playing' && (!paused || missionsOpen)) { toggleMissions(); e.preventDefault(); return; }
  if (e.code === 'KeyK' && gameState === 'playing' && (!paused || shopOpen)) { toggleShop(); e.preventDefault(); return; }
  if (e.code === 'KeyR' && gameState === 'playing' && !paused) { player.respawn(); stats.deaths++; showToast('↻ 返回最近的安全屋顶'); }
  if (e.code === 'KeyM') {
    const on = music.toggle(gameState !== 'playing');
    settings.musicOn = on;
    saveSettings();
    e.preventDefault();
  }
  if (e.code === 'KeyN') { music.next(gameState !== 'playing'); e.preventDefault(); }
  if (e.code === 'KeyL' && gameState === 'playing') {
    const i = TIME_PRESETS.indexOf(settings.timeOfDay || 'morning');
    applyTimePreset(TIME_PRESETS[(i + 1) % TIME_PRESETS.length]);
    e.preventDefault();
  }
  if (e.code === 'KeyT' && gameState === 'playing' && !paused) toggleTrial();
  if (e.code === 'KeyG') {
    settings.ghost = !settings.ghost;
    dom.chkGhost.checked = settings.ghost;
    saveSettings();
    showToast(settings.ghost ? '👻 幽灵显示：开' : '幽灵显示：关', 1400);
  }
  if (e.code === 'KeyO' && gameState === 'playing' && (!paused || recordsOpen)) { toggleRecords(!recordsOpen); e.preventDefault(); }
  if (e.code === 'Escape' && (missionsOpen || shopOpen)) {
    if (missionsOpen) toggleMissions(false);
    if (shopOpen) toggleShop(false);
    e.preventDefault();
    return;
  }
  if ((e.code === 'KeyP' || e.code === 'Escape') && gameState === 'playing') togglePause();
  if (e.code === 'Enter' && gameState === 'menu') startGame();
  else if (e.code === 'Enter' && gameState === 'playing' && !paused && !recordsOpen) { openChat(); e.preventDefault(); }
});
document.addEventListener('keyup', (e) => keys.delete(e.code));
document.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== dom.canvas || gameState !== 'playing' || paused) return;
  const s = 0.0021 * settings.sens;
  P.yaw -= e.movementX * s;
  P.pitch -= e.movementY * s;
  P.pitch = clamp(P.pitch, -1.45, 1.45);
});
document.addEventListener('pointerlockchange', () => {
  if (touch && touch.active) return;
  const locked = document.pointerLockElement === dom.canvas;
  if (locked) { lockGrace = 0; return; }
  /* 刚请求/切换锁定时的短暂解锁不触发暂停（避免重开一局被误暂停） */
  if (!locked && gameState === 'playing' && !paused && !recordsOpen && lockGrace <= 0 && !chat.open) setPaused(true);
});
window.addEventListener('blur', () => { keys.clear(); jumpQueued = false; if (touch) touch.reset(); });
dom.canvas.addEventListener('click', () => {
  if (touch && touch.active) return;
  if (gameState === 'playing' && !paused && !recordsOpen) requestLock();
});

function requestLock() {
  if (touch && touch.active) return;
  lockGrace = 0.9;
  if (document.pointerLockElement !== dom.canvas && dom.canvas.requestPointerLock) {
    try {
      const p = dom.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }
}

/* ------------------------------------------------------- 路线 / 光门 */
const routes = [];
const completedRoutes = new Set(loadJSON('mirrorweb-routes', []));
const gateMatNext = new THREE.MeshStandardMaterial({ color: 0xff2c20, emissive: 0xff2200, emissiveIntensity: 1.7, roughness: 0.35 });
const gateMatIdle = new THREE.MeshStandardMaterial({ color: 0xff6a5a, emissive: 0xb31b00, emissiveIntensity: 0.5, roughness: 0.5, transparent: true, opacity: 0.8 });
const gateMatDone = new THREE.MeshStandardMaterial({ color: 0x5a6a72, emissive: 0x223038, emissiveIntensity: 0.3, roughness: 0.7, transparent: true, opacity: 0.4 });
const beamTex = makeCanvas(64, 256, (g) => {
  g.clearRect(0, 0, 64, 256);
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, 'rgba(255,120,90,0)');
  grd.addColorStop(0.55, 'rgba(255,90,60,0.55)');
  grd.addColorStop(1, 'rgba(255,60,40,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 256);
});
const beamMat = new THREE.MeshBasicMaterial({ map: beamTex, color: 0xff5a3c, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });

function addRoute(id, name, points) {
  const gates = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const nx = points[i + 1] || points[i - 1];
    const yaw = points[i + 1] ? eulerYaw(nx[0] - p[0], nx[2] - p[2]) : eulerYaw(p[0] - nx[0], p[2] - nx[2]);
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(2.35, 0.13, 12, 40), gateMatIdle);
    mesh.position.set(p[0], p[1], p[2]);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.7, 90, 12, 1, true), beamMat);
    beam.position.set(p[0], p[1] + 45, p[2]);
    beam.visible = false;
    scene.add(beam);
    gates.push({ x: p[0], y: p[1], z: p[2], mesh, beam });
    if (points[i + 1]) {
      const q = points[i + 1];
      const midId = id + '-mid-' + i;
      createCoin((p[0] + q[0]) / 2, Math.max(p[1], q[1]) + 0.8, (p[2] + q[2]) / 2, midId, 5);
      /* 面包屑：沿两门连线撒金币，自动指引跑酷弧线 */
      for (let bi = 1; bi <= 2; bi++) {
        const t2 = bi / 3;
        const bx = p[0] + (q[0] - p[0]) * t2;
        const bz = p[2] + (q[2] - p[2]) * t2;
        const by = p[1] + (q[1] - p[1]) * t2 + 1.0 + Math.sin(t2 * Math.PI) * 1.6;
        createCoin(bx, by, bz, id + '-bc-' + i + '-' + bi, 1);
      }
    }
  }
  /* 起点：第 0 门下方屋顶，向第 1 门方向后退 7m */
  const p0 = points[0], p1 = points[1] || points[0];
  const dx = p1[0] - p0[0], dz = p1[2] - p0[2];
  const dl = Math.hypot(dx, dz) || 1;
  const sx = p0[0] - dx / dl * 7, sz = p0[2] - dz / dl * 7;
  const gy = world.rayDown(sx, sz, p0[1] + 4, 120);
  const start = { x: sx, y: (gy === null ? p0[1] - 2 : gy) + 0.05, z: sz, yaw: eulerYaw(dx, dz) };
  routes.push({
    id, name, gates, start,
    progress: completedRoutes.has(id) ? gates.length : 0,
    done: completedRoutes.has(id),
  });
}

function buildRoutes() {
  addRoute('R-tutorial', '中央教学环线', [
    [10, 20.6, 0], [33, 16.6, 0], [48, 15.5, -2.1], [63, 14.6, 0], [80, 23.6, 0],
    [93.5, 23.8, 0], [110, 23.6, 0], [125, 15.5, 0], [141, 10.9, 0], [158, 14.6, 0],
  ]);
  const bs = world.openCity.buildings.filter((b) => b.w >= 13 && b.d >= 13);
  const rnd = mulberry32(20260905);
  const dq = world.districts;
  for (let ri = 0; ri < 7; ri++) {
    const pts = [];
    const visited = new Set();
    let cur = bs[Math.floor(rnd() * bs.length)];
    let guard = 0;
    while (cur && guard++ < 40) {
      visited.add(cur);
      let next = null, best = Infinity;
      for (const b of bs) {
        if (visited.has(b)) continue;
        const d = Math.hypot(b.cx - cur.cx, b.cz - cur.cz);
        if (d < 14 || d > 54) continue;
        if (Math.abs(b.top - cur.top) > 12) continue;
        const score = Math.abs(d - 26) + rnd() * 12;
        if (score < best) { best = score; next = b; }
      }
      if (!next) break;
      const dx = next.cx - cur.cx, dz = next.cz - cur.cz;
      const dist = Math.hypot(dx, dz) || 1;
      const edge = Math.min(cur.w, cur.d) * 0.5 - 2.5;
      pts.push([cur.cx + dx / dist * edge, cur.top + 2.6, cur.cz + dz / dist * edge]);
      cur = next;
      if (pts.length >= 6 + Math.floor(rnd() * 4)) break;
    }
    if (pts.length >= 5) {
      pts.push([cur.cx, cur.top + 2.6, cur.cz]);
      const name = `${world.districtAt(cur.cx, cur.cz).short || '城区'} 线路 ${ri + 1}`;
      addRoute(`R-${ri}`, name, pts);
    }
  }
  refreshGates();
}

function refreshGates() {
  focusRoute = null;
  let bestD = Infinity;
  for (const r of routes) {
    if (r.done) continue;
    const g = r.gates[r.progress];
    const d = (g.x - P.pos.x) ** 2 + (g.z - P.pos.z) ** 2;
    if (d < bestD) { bestD = d; focusRoute = r; }
  }
  for (const r of routes) {
    r.gates.forEach((g, i) => {
      const isDone = r.done || i < r.progress;
      const isNext = !r.done && i === r.progress;
      g.mesh.material = isDone ? gateMatDone : isNext ? gateMatNext : gateMatIdle;
    });
  }
}
function nextGatePos() {
  if (focusRoute && !focusRoute.done) {
    return focusRoute.gates[focusRoute.progress]; /* {x,y,z}，不再每帧新建 Vector3 */
  }
  return null;
}
function passGate(r) {
  const g = r.gates[r.progress];
  r.progress++;
  stats.gates++;
  flowSave.gates = (flowSave.gates || 0) + 1;
  gainFlow(150, 'GATE');
  world.burst(new THREE.Vector3(g.x, g.y, g.z), 0xff5544, 24, { life: 0.7, spread: 4.2, upBias: 0.5, additive: true, size: 0.15 });
  world.burst(new THREE.Vector3(g.x, g.y, g.z), 0xffd75e, 12, { life: 0.5, spread: 3.0, upBias: 0.8, additive: true, size: 0.13 });
  audio.gate(r.progress);
  net.sendEvent('gate', { r: r.id, g: r.progress, t: r.gates.length });
  if (trial.active && trial.route === r) onTrialGate(r);
  if (r.progress >= r.gates.length) {
    r.done = true;
    completedRoutes.add(r.id);
    saveJSON('mirrorweb-routes', [...completedRoutes]);
    stats.routesDone++;
    flowSave.routes = (flowSave.routes || 0) + 1;
    flow.score += 300;
    saveFlow();
    showToast(`🏁 路线完成 · ${r.gates.length} 门 · BONUS +300 FLOW`, 3000);
    audio.routeDone();
    net.sendEvent('route', { r: r.id, t: 0 });
  }
  refreshGates();
  checkAchievements();
}
function updateRoutes() {
  if (!routes.length) return;
  for (const r of routes) {
    if (r.done) continue;
    const g = r.gates[r.progress];
    const dx = P.pos.x - g.x, dz = P.pos.z - g.z;
    const dy = (P.pos.y + 0.9) - g.y;
    if (dx * dx + dz * dz < 10.5 && Math.abs(dy) < 3.4) { passGate(r); break; }
  }
  let focus = null, bestD = Infinity;
  for (const r of routes) {
    if (r.done) continue;
    const g = r.gates[r.progress];
    const d = (g.x - P.pos.x) ** 2 + (g.z - P.pos.z) ** 2;
    if (d < bestD) { bestD = d; focus = r; }
  }
  focusRoute = focus;
  for (const r of routes) {
    for (const g of r.gates) g.beam.visible = !r.done && r === focus && g === r.gates[r.progress];
  }
  gateMatNext.emissiveIntensity = 1.3 + Math.sin(performance.now() * 0.006) * 0.5;
  beamMat.opacity = 0.42 + Math.sin(performance.now() * 0.003) * 0.12;
}

/* ------------------------------------------------------- 金币 */
function createCoin(x, y, z, id, value = 1) {
  return world.addCoin ? world.addCoin(x, y, z, id, value) : -1;
}
function collectWorldCoins() {
  const list = world.coins;
  let collected = false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.taken) continue;
    const dx = P.pos.x - c.x, dz = P.pos.z - c.z;
    const dy = Math.abs(P.pos.y - c.y);
    const R = skillEffect.coinRadius();
    if (dx * dx + dz * dz < R * R && dy < 2.9) {
      if (world.takeCoin(i)) {
        const val = c.value || 1;
        stats.coins++;
        stats.credits = (stats.credits || 0) + val;
        addCredits(val);
        addXp(val >= 5 ? 8 : 2);
        collectedCoinIds.add(c.id);
        collected = true;
        gainFlow(30 * Math.min(3, val), 'COIN');
        if (val >= 5) audio.dataChip(); else audio.coin();
        world.burst(new THREE.Vector3(c.x, c.y, c.z), 0xffd75e, 16, { life: 0.55, spread: 2.2, upBias: 0.9, gravity: 4, additive: true, size: 0.14 });
        checkAchievements();
      }
    }
  }
  if (collected) {
    saveJSON('mirrorweb-coins', [...collectedCoinIds]);
    net.sendEvent('coin', { c: stats.coins });
  }
}
function nearestCoinPos() {
  let best = null, bd = Infinity;
  for (const c of world.coins) {
    if (c.taken) continue;
    const d = (c.x - P.pos.x) ** 2 + (c.y - P.pos.y) ** 2 + (c.z - P.pos.z) ** 2;
    if (d > 250 * 250) continue;
    if (d < bd) { bd = d; best = c; }
  }
  return best; /* 直接返回金币对象，避免每帧分配 Vector3 */
}

/* ------------------------------------------------------- 计时挑战 + 幽灵 */
const trialTimes = loadJSON('mirrorweb-trials', {});
const trial = {
  active: false, route: null, t: 0, started: false, splits: [],
  rec: [], recTimer: 0, ghost: null, ghostSampleIdx: 0, delta: null, deltaTimer: 0,
  ghostVisible: false, ghostAvatar: null, ghostNames: '',
};
const GHOST_INTERVAL = 0.05;
const GHOST_MAX = 6000;
let recTimer = 0;

function encodeGhost(interval, time, splits, samples) {
  const nS = samples.length;
  const buf = new ArrayBuffer(16 + splits.length * 4 + nS * 10);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4D57); // 'MW'
  dv.setUint16(2, 1);
  dv.setUint16(4, splits.length);
  dv.setUint16(6, 0);
  dv.setFloat32(8, time);
  dv.setUint32(12, nS);
  let o = 16;
  for (const s of splits) { dv.setFloat32(o, s); o += 4; }
  for (const s of samples) {
    dv.setInt16(o, clamp(Math.round(s.x * 20), -32000, 32000)); o += 2;
    dv.setInt16(o, clamp(Math.round(s.y * 20), -32000, 32000)); o += 2;
    dv.setInt16(o, clamp(Math.round(s.z * 20), -32000, 32000)); o += 2;
    dv.setInt16(o, clamp(Math.round(s.yaw * 1000), -32000, 32000)); o += 2;
    dv.setUint8(o, s.state & 255); o += 1;
    dv.setUint8(o, clamp(Math.round(s.speed * 8), 0, 255)); o += 1;
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
function decodeGhost(str) {
  try {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dv = new DataView(bytes.buffer);
    if (dv.getUint16(0) !== 0x4D57) return null;
    const nSplits = dv.getUint16(4);
    const time = dv.getFloat32(8);
    const n = dv.getUint32(12);
    let o = 16;
    const splits = [];
    for (let i = 0; i < nSplits; i++) { splits.push(dv.getFloat32(o)); o += 4; }
    const xs = new Float32Array(n), ys = new Float32Array(n), zs = new Float32Array(n),
      yaws = new Float32Array(n), states = new Uint8Array(n), speeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = dv.getInt16(o) / 20; o += 2;
      ys[i] = dv.getInt16(o) / 20; o += 2;
      zs[i] = dv.getInt16(o) / 20; o += 2;
      yaws[i] = dv.getInt16(o) / 1000; o += 2;
      states[i] = dv.getUint8(o); o += 1;
      speeds[i] = dv.getUint8(o) / 8; o += 1;
    }
    return { time, splits, xs, ys, zs, yaws, states, speeds, interval: GHOST_INTERVAL, count: n };
  } catch (e) { return null; }
}
function loadGhost(routeId) {
  const raw = localStorage.getItem(`mirrorweb-ghost-${routeId}`);
  return raw ? decodeGhost(raw) : null;
}

function toggleTrial() {
  if (trial.active) { cancelTrial(); return; }
  const route = focusRoute && !focusRoute.done ? focusRoute : routes.find((r) => !r.done);
  if (!route) { showToast('✦ 所有路线已完成 · 自由跑酷', 2200); return; }
  startTrial(route);
}
function startTrial(route) {
  trial.active = true;
  trial.route = route;
  trial.t = 0;
  trial.started = false;
  trial.splits = [];
  trial.rec = [];
  trial.recTimer = 0;
  trial.delta = null;
  route.progress = 0;
  refreshGates();
  const s = route.start;
  player.teleport(s.x, s.y, s.z, s.yaw);
  trial.ghost = loadGhost(route.id);
  trial.ghostSampleIdx = 0;
  if (trial.ghost && !trial.ghostAvatar) trial.ghostAvatar = makeAvatar('', 0x6fe8ff, true);
  if (trial.ghostAvatar) { trial.ghostAvatar.visible = false; scene.add(trial.ghostAvatar); }
  dom.trial.classList.add('show');
  dom.trialName.textContent = `${route.name} · ${route.gates.length} 门`;
  const best = trialTimes[route.id];
  dom.trialDelta.textContent = best ? `PB ${fmtTime(best.time)}` : '首次挑战';
  playTrialSound(true);
  showToast(`⏱ ${route.name} · 穿过第一个门开始计时（T 取消）`, 2800);
  net.sendEvent('trial_start', { r: route.id });
}
function cancelTrial(quiet = false) {
  trial.active = false;
  trial.started = false;
  trial.ghost = null;
  dom.trial.classList.remove('show');
  if (trial.ghostAvatar) trial.ghostAvatar.visible = false;
  if (!quiet) showToast('⏹ 已取消计时挑战', 1500);
}
function playTrialSound(start) {
  if (start) audio.trialStart(); else audio.trialFinish();
}
function onTrialGate(r) {
  if (!trial.active || trial.route !== r) return;
  const idx = r.progress - 1;
  if (idx === 0 && !trial.started) {
    trial.started = true;
    trial.t = 0;
    trial.splits = [0];
    trial.rec = [];
    playTrialSound(true);
    if (trial.ghost) {
      trial.ghostSampleIdx = 0;
      if (trial.ghostAvatar) trial.ghostAvatar.visible = true;
    }
    return;
  }
  if (trial.started) {
    trial.splits[idx] = trial.t;
    if (trial.ghost && trial.ghost.splits[idx] !== undefined) {
      trial.delta = trial.t - trial.ghost.splits[idx];
      trial.deltaTimer = 2.4;
      const sign = trial.delta <= 0 ? '−' : '+';
      dom.trialDelta.textContent = `Δ ${sign}${Math.abs(trial.delta).toFixed(2)}s`;
      dom.trialDelta.style.color = trial.delta <= 0 ? '#7dffb0' : '#ff8f7a';
    }
    if (r.progress >= r.gates.length) finishTrial(r);
  }
}
function finishTrial(route) {
  const time = trial.t;
  trial.active = false;
  trial.started = false;
  const prev = trialTimes[route.id];
  let newRecord = false;
  if (!prev || time < prev.time) {
    const samples = trial.rec.slice(0, GHOST_MAX);
    try {
      localStorage.setItem(`mirrorweb-ghost-${route.id}`, encodeGhost(GHOST_INTERVAL, time, trial.splits, samples));
    } catch (e) { /* quota */ }
    trialTimes[route.id] = { time, date: Date.now() };
    saveJSON('mirrorweb-trials', trialTimes);
    newRecord = true;
    stats.records++;
  }
  stats.trialsDone++;
  flowSave.trials = (flowSave.trials || 0) + 1;
  saveFlow();
  playTrialSound(false);
  flow.score += newRecord ? 600 : 250;
  bankFlow(true);
  showFinishCard({
    title: '计时挑战完成',
    sub: `${route.name} · ${newRecord ? '🏆 新纪录！' : '完成'}`,
    time,
    best: trialTimes[route.id].time,
  });
  if (trial.ghostAvatar) trial.ghostAvatar.visible = false;
  dom.trial.classList.remove('show');
  net.sendEvent('trial', { r: route.id, t: time, pb: newRecord });
  checkAchievements();
}
function updateTrial(dt) {
  if (!trial.active) return;
  if (trial.started) {
    trial.t += dt;
    recTimer += dt;
    if (recTimer >= GHOST_INTERVAL) {
      recTimer = 0;
      if (trial.rec.length < GHOST_MAX) {
        trial.rec.push({
          x: P.pos.x, y: P.pos.y, z: P.pos.z, yaw: P.yaw,
          state: stateCode(P.moveState), speed: Math.hypot(P.vel.x, P.vel.z),
        });
      }
    }
  }
  dom.trialTime.textContent = fmtTime(trial.t);
  dom.trialGates.textContent = trial.route ? `${trial.route.progress}/${trial.route.gates.length}` : '';
  if (trial.deltaTimer > 0) {
    trial.deltaTimer -= dt;
    if (trial.deltaTimer <= 0) {
      const best = trialTimes[trial.route.id];
      dom.trialDelta.textContent = best ? `PB ${fmtTime(best.time)}` : '首次挑战';
      dom.trialDelta.style.color = '#8fd8ff';
    }
  }
  updateGhostAvatar(dt);
}

function updateGhostAvatar(dt) {
  const gh = trial.ghost;
  const av = trial.ghostAvatar;
  if (!gh || !av || !trial.started || !settings.ghost) { if (av) av.visible = false; return; }
  const idxF = trial.t / gh.interval;
  const i0 = Math.floor(idxF);
  if (i0 >= gh.count - 1) { av.visible = false; return; }
  av.visible = true;
  const f = idxF - i0;
  const x = lerp(gh.xs[i0], gh.xs[i0 + 1], f);
  const y = lerp(gh.ys[i0], gh.ys[i0 + 1], f);
  const z = lerp(gh.zs[i0], gh.zs[i0 + 1], f);
  const yaw = lerp(gh.yaws[i0], gh.yaws[i0 + 1], f);
  av.position.set(x, y, z);
  av.rotation.y = yaw;
  poseAvatar(av, gh.states[i0], gh.speeds[i0], performance.now() * 0.012);
}

/* ------------------------------------------------------- 成就 */
const ACH_DEFS = [
  { id: 'coin1', icon: '🪙', name: '初次拾金', desc: '收集第 1 枚金币', test: (s) => s.coins >= 1 },
  { id: 'coin20', icon: '💰', name: '屋顶淘金客', desc: '累计收集 20 枚金币', test: (s) => s.coins >= 20 },
  { id: 'coin60', icon: '💎', name: '城市宝藏猎人', desc: '累计收集 60 枚金币', test: (s) => s.coins >= 60 },
  { id: 'coin120', icon: '👑', name: '金色传说', desc: '累计收集 120 枚金币', test: (s) => s.coins >= 120 },
  { id: 'jump100', icon: '🦘', name: '跃动者', desc: '累计跳跃 100 次', test: (s) => s.jumps >= 100 },
  { id: 'wall20', icon: '🧱', name: '墙面疾走', desc: '蹬墙跑 20 次', test: (s) => s.wallruns >= 20 },
  { id: 'zip10', icon: '⚡', name: '空中飞人', desc: '使用滑索 10 次', test: (s) => s.ziplines >= 10 },
  { id: 'spring15', icon: '🚀', name: '弹簧腿', desc: '踩弹簧板 15 次', test: (s) => s.springs >= 15 },
  { id: 'slide40', icon: '🧹', name: '贴地飞行', desc: '滑铲 40 次', test: (s) => s.slides >= 40 },
  { id: 'distance1k', icon: '🏙️', name: '城市漫游者', desc: '累计移动 1 km', test: (s) => s.distance >= 1000 },
  { id: 'distance5k', icon: '🌆', name: '不知疲倦', desc: '累计移动 5 km', test: (s) => s.distance >= 5000 },
  { id: 'air120', icon: '🕊️', name: '滞空大师', desc: '累计滞空 120 秒', test: (s) => s.airTimeTotal >= 120 },
  { id: 'mantle30', icon: '🧗', name: '城市攀登者', desc: '翻越 / 攀抓 30 次', test: (s) => s.mantles + s.vaults >= 30 },
  { id: 'flow500', icon: '🔥', name: '心流初现', desc: '单次连锁攒到 500 FLOW', test: () => flowSave.best >= 500 },
  { id: 'flow2000', icon: '🌪️', name: '城市之心', desc: '单次连锁攒到 2000 FLOW', test: () => flowSave.best >= 2000 },
  { id: 'multx5', icon: '⚡', name: '极限倍率', desc: '达到 ×5 连锁倍率', test: () => flowSave.maxMult >= 5 },
  { id: 'gate25', icon: '🎯', name: '穿针引线', desc: '累计穿过 25 个光门', test: () => (flowSave.gates || 0) >= 25 },
  { id: 'route1', icon: '🛤️', name: '路线跑者', desc: '完成 1 条光门路线', test: () => completedRoutes.size >= 1 },
  { id: 'routeall', icon: '🏁', name: '全城制霸', desc: '完成所有光门路线', test: () => routes.length > 0 && completedRoutes.size >= routes.length },
  { id: 'trial1', icon: '⏱️', name: '时间赛跑者', desc: '完成 1 次计时挑战', test: (s) => s.trialsDone >= 1 },
  { id: 'trial5', icon: '🥇', name: '破纪录机器', desc: '刷新 5 次路线纪录', test: (s) => s.records >= 5 },
  { id: 'disarm1', icon: '🥋', name: '解除武装', desc: '近战缴械 1 名守卫', test: (s) => (s.kills || 0) >= 1 },
  { id: 'disarm10', icon: '💥', name: '反应时间', desc: '近战缴械 10 名守卫', test: (s) => (s.kills || 0) >= 10 },
  { id: 'credit1k', icon: '💳', name: '信用良好', desc: '累计获得 1000 信用点', test: () => profile.totalCredits >= 1000 },
  { id: 'contract5', icon: '📦', name: '可靠信使', desc: '完成 5 份城市委托', test: () => profile.missionHistory >= 5 },
  { id: 'storydone', icon: '📖', name: '她的故事', desc: '完成全部剧情行动', test: () => profile.story >= 6 },
  { id: 'skillmax', icon: '🧠', name: '全副武装', desc: '任意技能升到满级', test: () => { for (const k in profile.skills) if (profile.skills[k] >= 3) return true; return false; } },
  { id: 'lv10', icon: '🎖️', name: '资深跑者', desc: '跑者等级达到 10', test: () => profile.level >= 10 },
  { id: 'online', icon: '🛰️', name: '城市同跑', desc: '联机时与其他跑者同场', test: () => net.count >= 1 },
  { id: 'collectall', icon: '🌟', name: '跑者视觉', desc: '完成所有其他成就', test: (s, done) => ACH_DEFS.every((a) => a.id === 'collectall' || done.has(a.id)) },
];
const unlockedAch = new Set(loadJSON('mirrorweb-achievements', []));
function unlockAchievement(a) {
  if (unlockedAch.has(a.id)) return;
  unlockedAch.add(a.id);
  saveJSON('mirrorweb-achievements', [...unlockedAch]);
  dom.achToast.innerHTML = `${a.icon} 成就解锁 · ${a.name}`;
  dom.achToast.classList.add('show');
  achToastTimer = 3.2;
  audio.ach();
}
function checkAchievements() {
  for (const a of ACH_DEFS) {
    if (a.id === 'collectall') continue;
    if (!unlockedAch.has(a.id) && a.test(stats, unlockedAch)) unlockAchievement(a);
  }
  const all = ACH_DEFS.find((a) => a.id === 'collectall');
  if (all && !unlockedAch.has('collectall') && all.test(stats, unlockedAch)) unlockAchievement(all);
}

/* ------------------------------------------------------- 化身 / 第一人称手臂 */
const AV_STATES = { normal: 0, crouch: 1, slide: 2, roll: 3, mantle: 4, vault: 5, wallrun: 6, climb: 7, zipline: 8, dead: 9, turn: 10 };
function stateCode(s) { return AV_STATES[s] !== undefined ? AV_STATES[s] : 0; }

function makeNameSprite(name, colorHex) {
  const tex = makeCanvas(256, 64, (g) => {
    g.clearRect(0, 0, 256, 64);
    g.font = 'bold 30px "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const c = '#' + colorHex.toString(16).padStart(6, '0');
    g.fillStyle = 'rgba(8,12,18,0.55)';
    g.fillRect(28, 8, 200, 48);
    g.fillStyle = c;
    g.fillText(name.slice(0, 12), 128, 34);
  });
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(2.0, 0.5, 1);
  return sp;
}

function makeAvatar(name, colorHex, ghost = false) {
  const g = new THREE.Group();
  const alpha = ghost ? 0.38 : 1;
  const jacket = new THREE.MeshStandardMaterial({
    color: colorHex, emissive: colorHex, emissiveIntensity: ghost ? 0.8 : 0.18,
    roughness: 0.55, transparent: ghost, opacity: alpha, depthWrite: !ghost,
  });
  const pants = new THREE.MeshStandardMaterial({ color: 0x252b31, roughness: 0.85, transparent: ghost, opacity: ghost ? 0.3 : 1, depthWrite: !ghost });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd8a882, roughness: 0.8, transparent: ghost, opacity: ghost ? 0.35 : 1, depthWrite: !ghost });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.52, 0.22), jacket);
  torso.position.y = 1.16;
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.2), pants);
  hips.position.y = 0.86;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 10), skin);
  head.position.y = 1.56;
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 0.24), new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.9, transparent: ghost, opacity: ghost ? 0.3 : 1 }));
  hair.position.y = 1.64;
  const armGeo = new THREE.BoxGeometry(0.095, 0.5, 0.11);
  armGeo.translate(0, -0.25, 0);
  const legGeo = new THREE.BoxGeometry(0.13, 0.72, 0.14);
  legGeo.translate(0, -0.36, 0);
  const armL = new THREE.Mesh(armGeo, jacket); const armR = new THREE.Mesh(armGeo, jacket);
  armL.position.set(-0.26, 1.36, 0); armR.position.set(0.26, 1.36, 0);
  const legL = new THREE.Mesh(legGeo, pants); const legR = new THREE.Mesh(legGeo, pants);
  legL.position.set(-0.1, 0.82, 0); legR.position.set(0.1, 0.82, 0);
  g.add(torso, hips, head, hair, armL, armR, legL, legR);
  if (name) {
    const tag = makeNameSprite(name, colorHex);
    tag.position.y = 1.98;
    g.add(tag);
  }
  g.userData = { armL, armR, legL, legR, torso, head };
  g.traverse((o) => { if (o.isMesh) { o.castShadow = !ghost; o.receiveShadow = false; } });
  return g;
}

function poseAvatar(av, state, speed, phase) {
  const u = av.userData;
  if (!u) return;
  const k = clamp(speed / 11, 0, 1.5);
  const sw = Math.sin(phase) * (0.45 + k * 0.5);
  const sw2 = Math.sin(phase + Math.PI) * (0.45 + k * 0.5);
  u.armL.rotation.x = sw2; u.armR.rotation.x = sw;
  u.legL.rotation.x = sw; u.legR.rotation.x = sw2;
  u.torso.rotation.x = k * 0.22;
  av.rotation.x = 0; av.rotation.z = 0;
  switch (state) {
    case 2:
      av.rotation.x = -1.15;
      break;
    case 6:
      av.rotation.z = 0.34;
      u.armL.rotation.x = -0.6; u.armR.rotation.x = 0.9;
      break;
    case 7:
    case 4:
      u.armL.rotation.x = -2.6 + Math.sin(phase) * 0.4;
      u.armR.rotation.x = -2.6 + Math.sin(phase + Math.PI) * 0.4;
      break;
    case 8:
      u.armL.rotation.x = -2.9; u.armR.rotation.x = -2.9;
      u.legL.rotation.x = 0.3; u.legR.rotation.x = 0.3;
      break;
    case 9:
      av.rotation.x = -1.5;
      break;
    case 1:
      u.torso.rotation.x = 0.35;
      break;
    default:
      break;
  }
}

function makeArms() {
  const group = new THREE.Group();
  const sleeve = new THREE.MeshStandardMaterial({ color: 0xb8180e, roughness: 0.62 });
  const cuff = new THREE.MeshStandardMaterial({ color: 0x1b1f24, roughness: 0.7 });
  const glove = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.55 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd8a882, roughness: 0.75 });
  function arm(side) {
    const a = new THREE.Group();
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.34, 0.095), sleeve);
    forearm.position.y = -0.17;
    const wrist = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), cuff);
    wrist.position.y = -0.345;
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.13, 0.08), glove);
    hand.position.y = -0.425;
    const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.035, 0.055), skin);
    knuckle.position.set(0, -0.485, -0.012);
    a.add(forearm, wrist, hand, knuckle);
    a.scale.setScalar(0.94);
    a.position.set(0.3 * side, -0.4, -0.46);
    a.rotation.set(-0.3, 0, 0);
    group.add(a);
    return a;
  }
  const left = arm(-1);
  const right = arm(1);
  group.userData = { left, right, sleeve, glove };
  group.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
  return group;
}
const arms = makeArms();
camera.add(arms);

function updateArms(dt, t) {
  const u = arms.userData;
  const hs = P ? Math.hypot(P.vel.x, P.vel.z) : 0;
  const k = clamp(hs / 11, 0, 1.4);
  const st = P ? P.moveState : 'normal';
  const bob = P ? P.bobTime : 0;
  const targets = {
    lx: -0.3, ly: -0.38, lz: -0.45, lrx: -0.25,
    rx: 0.3, ry: -0.38, rz: -0.45, rrx: -0.25,
  };
  if (meleeAnimT > 0) {
    const k = clamp(meleeAnimT / 0.32, 0, 1);
    const punch = Math.sin((1 - k) * Math.PI);
    targets.rx = 0.16; targets.ry = -0.26 - punch * 0.1; targets.rz = -0.66 - punch * 0.18;
    targets.rrx = -1.35 - punch * 0.85;
    targets.lx = -0.34; targets.ly = -0.34; targets.lz = -0.4; targets.lrx = -0.22;
  }
  else if (st === 'slide' || st === 'roll') { targets.ly = -0.5; targets.ry = -0.5; targets.lz = -0.55; targets.rz = -0.55; targets.lrx = 0.7; targets.rrx = 0.7; }
  else if (st === 'wallrun') { targets.lx = -0.46; targets.lz = -0.3; targets.lrx = -1.2; targets.rx = 0.34; targets.rrx = Math.sin(bob * 2) * 0.55; }
  else if (st === 'climb') { targets.ly = -0.2 + Math.sin(bob * 3) * 0.15; targets.ry = -0.2 + Math.sin(bob * 3 + Math.PI) * 0.15; targets.lrx = -2.2; targets.rrx = -2.2; }
  else if (st === 'zipline') { targets.lx = -0.16; targets.rx = 0.16; targets.ly = -0.18; targets.ry = -0.18; targets.lrx = -2.4; targets.rrx = -2.4; }
  else if (st === 'vault' || st === 'mantle') { targets.lrx = -1.5; targets.rrx = -1.5; targets.lz = -0.55; targets.rz = -0.55; }
  else if (st === 'dead') { targets.ly = -0.7; targets.ry = -0.7; targets.lrx = 0.9; targets.rrx = 0.9; }
  else {
    /* 跑步摆臂 */
    const swing = Math.sin(bob * 1.15) * (0.14 + k * 0.5);
    targets.ly = -0.36 + swing * 0.10;
    targets.ry = -0.36 - swing * 0.10;
    targets.lrx = -0.3 - swing;
    targets.rrx = -0.3 + swing;
  }
  const lam = 12;
  u.left.position.x = damp(u.left.position.x, targets.lx, lam, dt);
  u.left.position.y = damp(u.left.position.y, targets.ly, lam, dt);
  u.left.position.z = damp(u.left.position.z, targets.lz, lam, dt);
  u.left.rotation.x = damp(u.left.rotation.x, targets.lrx, lam, dt);
  u.right.position.x = damp(u.right.position.x, targets.rx, lam, dt);
  u.right.position.y = damp(u.right.position.y, targets.ry, lam, dt);
  u.right.position.z = damp(u.right.position.z, targets.rz, lam, dt);
  u.right.rotation.x = damp(u.right.rotation.x, targets.rrx, lam, dt);
  /* 空中时手臂上抬 */
  if (P && !P.grounded && st === 'normal') {
    u.left.rotation.x -= clamp(P.vel.y * 0.02, -0.3, 0.4);
    u.right.rotation.x -= clamp(P.vel.y * 0.02, -0.3, 0.4);
  }
}

/* ------------------------------------------------------- 聊天 */
const chat = { open: false, last: 0 };
function pushChat(name, text, colorHex) {
  const el = document.createElement('div');
  el.className = 'chat-line';
  const nm = document.createElement('b');
  nm.textContent = `${name}: `;
  nm.style.color = '#' + (colorHex || 0x8fd8ff).toString(16).padStart(6, '0');
  const tx = document.createElement('span');
  tx.textContent = text;
  el.append(nm, tx);
  dom.chatLog.appendChild(el);
  while (dom.chatLog.children.length > 8) dom.chatLog.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 700); }, 14000);
}
function openChat() {
  if (chat.open || gameState !== 'playing' || paused || recordsOpen) return;
  chat.open = true;
  keys.clear();
  if (touch) touch.reset();
  dom.chatWrap.classList.add('show');
  dom.chatInput.value = '';
  dom.chatInput.focus();
  if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
}
function closeChat() {
  if (!chat.open) return;
  chat.open = false;
  dom.chatWrap.classList.remove('show');
  dom.chatInput.blur();
  if (gameState === 'playing' && !paused && !recordsOpen) requestLock();
}
function sendChat() {
  const text = sanitizeText(dom.chatInput.value || '', 120).trim();
  if (text && performance.now() - chat.last > 600) {
    chat.last = performance.now();
    pushChat(net.name || '我', text, net.color);
    net.sendEvent('chat', { m: text });
  }
  closeChat();
}
if (dom.chatForm) {
  dom.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });
}
if (dom.btnChatCancel) {
  dom.btnChatCancel.addEventListener('click', () => closeChat());
}

/* ------------------------------------------------------- 联机化身 */
const remoteAvatars = new Map();
function netOnlineCount() {
  const online = net.status === 'online' || net.status === 'local';
  return online ? net.count + 1 : 0;
}
function refreshNetCount() {
  const n = netOnlineCount();
  if (dom.netCount) dom.netCount.textContent = n ? `· ${n} 人在线` : '';
  if (dom.netState) {
    const base = dom.netState.dataset.base || dom.netState.textContent.replace(/ · \d+ 人在线$/, '');
    dom.netState.dataset.base = base;
    dom.netState.textContent = n ? `${base} · ${n} 人在线` : base;
  }
}
net.on('status', (s, mode) => {
  const map = { off: '离线', connecting: '连接中…', online: `在线 · ${mode === 'mqtt' ? '公网中继' : mode}`, local: '本机同屏', error: '连接失败' };
  dom.netStatus.textContent = map[s] || s;
  dom.netLabel.classList.toggle('off', s === 'off' || s === 'error');
  dom.netState.textContent = map[s] || s;
  dom.netState.dataset.base = map[s] || s;
  if (s === 'online' || s === 'local') dom.btnNet.textContent = '断开联机';
  else if (s === 'off' || s === 'error') dom.btnNet.textContent = '加入联机';
  refreshNetCount();
});
net.on('join', (p) => {
  pushFeed(`◈ ${p.name} 进入了城市`, '#8fd8ff');
  audio.netJoin();
  if (!remoteAvatars.has(p.id)) {
    const av = makeAvatar(p.name, p.color, false);
    av.position.set(p.pos[0], Math.max(0, p.pos[1]), p.pos[2]);
    av.visible = p.pos[1] > -100;
    scene.add(av);
    remoteAvatars.set(p.id, { av, phase: rand(6.28) });
  }
  checkAchievements();
  refreshNetCount();
});
net.on('leave', (p) => {
  pushFeed(`◇ ${p.name} 离开了`, '#8a98a6');
  audio.netLeave();
  const r = remoteAvatars.get(p.id);
  if (r) { scene.remove(r.av); remoteAvatars.delete(p.id); }
  refreshNetCount();
});
net.on('event', (e) => {
  const n = e.name;
  if (e.k === 'hello' || e.k === 'join' || e.k === 'leave') return;
  if (e.k === 'route') pushFeed(`🏁 ${n} 完成了一条光门路线`, '#ffd75e');
  else if (e.k === 'gate') pushFeed(`🎯 ${n} 穿过第 ${e.d.g} 门`, '#8fd8ff');
  else if (e.k === 'trial') pushFeed(`⏱ ${n} 计时挑战 ${fmtTime(e.d.t)}${e.d.pb ? ' · 新纪录!' : ''}`, '#7dffb0');
  else if (e.k === 'death') pushFeed(`💥 ${n} 摔落了`, '#ff8f7a');
  else if (e.k === 'trial_start') pushFeed(`⏱ ${n} 开始了计时挑战`, '#c9b6ff');
  else if (e.k === 'chat') pushChat(n, String((e.d && e.d.m) || '').slice(0, 120), net.colorFor(n));
});
net.on('room', (room) => { dom.room.value = room; settings.room = room; saveSettings(); });

const _avTarget = new THREE.Vector3();
function updateRemoteAvatars(dt) {
  /* 懒创建：即使漏掉 join 事件，只要在 net.players 里就会出现 */
  for (const [id, p] of net.players) {
    if (!remoteAvatars.has(id)) {
      const av = makeAvatar(p.name, p.color, false);
      av.position.set(p.pos[0], Math.max(0, p.pos[1]), p.pos[2]);
      scene.add(av);
      remoteAvatars.set(id, { av, phase: rand(6.28) });
    }
  }
  for (const [id, r] of remoteAvatars) {
    const p = net.players.get(id);
    if (!p) { scene.remove(r.av); remoteAvatars.delete(id); continue; }
    if (p.pos[1] < -100) { r.av.visible = false; continue; }
    const target = _avTarget.set(p.pos[0], p.pos[1], p.pos[2]);
    r.av.visible = true;
    /* 距离过大（刚出现 / 传送）直接吸附，避免从地底飞上来 */
    if (r.av.position.distanceToSquared(target) > 400) {
      r.av.position.copy(target);
    } else {
      r.av.position.lerp(target, 1 - Math.exp(-11 * dt));
    }
    const dYaw = ((p.yaw - r.av.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    r.av.rotation.y += dYaw * (1 - Math.exp(-11 * dt));
    r.phase += dt * (2.4 + p.speed * 1.5);
    poseAvatar(r.av, p.state, p.speed, r.phase);
  }
}

/* ------------------------------------------------------- 跑者视觉 */
const RV_RED = new THREE.Color(0xff2400);
const rvDir = new THREE.Vector3();
const rvTo = new THREE.Vector3();
let rvTimer = 0;
function updateRunnerVision(dt) {
  const speed01 = clamp(Math.hypot(P.vel.x, P.vel.z) / PHYS.SPRINT_SPEED, 0, 1);
  const boosting = P.moveState === 'wallrun' || P.moveState === 'zipline' || P.moveState === 'vault';
  rvTimer -= dt;
  if (rvTimer <= 0) {
    rvTimer = 0.1;
    camera.getWorldDirection(rvDir);
    const scored = [];
    const vr = skillEffect.visionRange();
    for (const e of world.highlight) {
      rvTo.copy(e.center).sub(camera.position);
      const dist = rvTo.length();
      if (dist > e.radius * 2.6 * vr) { e.targetGlow = 0; continue; }
      rvTo.normalize();
      const dot = rvTo.dot(rvDir);
      if (dot < 0.05 && dist > e.radius) { e.targetGlow = 0; continue; }
      const score = dot * 1.7 - dist / e.radius + speed01 * 0.6 + (boosting ? 0.4 : 0);
      scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const e of world.highlight) e.targetGlow = 0;
    for (let i = 0; i < Math.min(3, scored.length); i++) {
      scored[i].e.targetGlow = clamp(0.25 + speed01 * 0.85, 0.25, 1) * (i === 0 ? 1 : 0.5);
    }
  }
  for (const e of world.highlight) {
    const target = e.targetGlow || 0;
    if (Math.abs(e.glow - target) < 0.01 && target !== 0) continue;
    if (Math.abs(e.glow - target) < 0.01 && e.glow === 0) continue;
    e.glow = damp(e.glow, target, 9, dt);
    for (let i = 0; i < e.mats.length; i++) {
      const m = e.mats[i];
      const base = e.base[i];
      m.emissive.copy(base.emissive).lerp(RV_RED, e.glow);
      m.emissiveIntensity = base.intensity + e.glow * 1.4;
    }
  }
}

/* ------------------------------------------------------- 速度特效 */
const fxCtx = dom.fxCanvas ? dom.fxCanvas.getContext('2d') : null;
let fxW = 0, fxH = 0, fxAcc = 0;
const streaks = Array.from({ length: 90 }, () => ({ a: rand(Math.PI * 2), len: rand(0.12, 0.55), w: rand(0.6, 2.2), o: rand(0.25, 1) }));
function resizeFx() {
  if (!dom.fxCanvas) return;
  fxW = window.innerWidth; fxH = window.innerHeight;
  dom.fxCanvas.width = fxW;
  dom.fxCanvas.height = fxH;
}
resizeFx();
function updateSpeedFx(dt) {
  if (!fxCtx) return;
  fxAcc += dt;
  if (fxAcc < 0.033) return;
  fxAcc = 0;
  const hs = Math.hypot(P.vel.x, P.vel.z);
  const speed01 = clamp((hs - 6.5) / (PHYS.SPRINT_SPEED - 6.5), 0, 1);
  const flow01 = flow.timer > 0 ? (flow.mult - 1) / 4 : 0;
  const intensity = clamp(speed01 * 0.75 + flow01 * 0.35 + P.fovKick * 0.03, 0, 1);
  fxCtx.clearRect(0, 0, fxW, fxH);
  if (intensity < 0.02) return;
  const cx = fxW / 2, cy = fxH / 2;
  const t = performance.now() * 0.001;
  fxCtx.save();
  fxCtx.globalCompositeOperation = 'lighter';
  for (const s of streaks) {
    const jitter = Math.sin(t * 3 + s.a * 7) * 0.04;
    const a = s.a + jitter;
    const r0 = Math.min(fxW, fxH) * (0.42 + 0.1 * Math.sin(t * 2 + s.o * 9));
    const r1 = r0 + Math.min(fxW, fxH) * s.len * (0.5 + intensity);
    const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0;
    const x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
    fxCtx.strokeStyle = s.o > 0.75 ? `rgba(255,235,225,${(0.05 + intensity * 0.22) * s.o})` : `rgba(255,255,255,${(0.04 + intensity * 0.18) * s.o})`;
    fxCtx.lineWidth = s.w;
    fxCtx.beginPath();
    fxCtx.moveTo(x0, y0);
    fxCtx.lineTo(x1, y1);
    fxCtx.stroke();
  }
  fxCtx.restore();
}

/* ------------------------------------------------------- 相机 */
/* 阴影跟随 / 按需重绘已迁移至 Graphics.update */
const _camRight = new THREE.Vector3();
function updateCamera(dt) {
  const hs = Math.hypot(P.vel.x, P.vel.z);
  let targetH = PHYS.PLAYER_HEIGHT, targetEye = PHYS.EYE_HEIGHT;
  if (P.moveState === 'slide') { targetH = 0.92; targetEye = 0.72; }
  else if (P.moveState === 'crouch') { targetH = 1.05; targetEye = 0.8; }
  else if (P.moveState === 'climb') { targetH = 1.7; targetEye = 1.5; }
  else if (P.moveState === 'zipline') { targetH = 1.5; targetEye = 1.3; }
  P.height = damp(P.height, targetH, 14, dt);
  P.eye = damp(P.eye, targetEye, 14, dt);

  const bobSpeed = P.grounded && (P.moveState === 'normal' || P.moveState === 'crouch') ? hs : 0;
  P.bobTime += dt * (2.0 + bobSpeed * 1.45);
  const bobAmp = clamp(bobSpeed / PHYS.SPRINT_SPEED, 0, 1);
  P.bobY = damp(P.bobY, Math.sin(P.bobTime) * 0.05 * bobAmp + Math.sin(P.bobTime * 0.5) * 0.016, 14, dt);
  P.bobX = damp(P.bobX, Math.cos(P.bobTime * 0.5) * 0.032 * bobAmp, 14, dt);
  P.landDip = damp(P.landDip, 0, 8, dt);

  let fovTarget = settings.fov;
  if (sprintHeld() && hs > 7) fovTarget += 6;
  if (P.moveState === 'wallrun') fovTarget += 7;
  if (P.moveState === 'zipline') fovTarget += 4.5;
  if (P.moveState === 'slide') fovTarget += 3.5;
  if (P.moveState === 'crouch') fovTarget -= 3;
  if (flow.timer > 0 && flow.mult >= 3) fovTarget += 2.5;
  fovTarget += P.fovKick;
  P.fovKick = damp(P.fovKick, 0, 5, dt);
  P.fov = damp(P.fov, fovTarget, 9, dt);
  if (Math.abs(camera.fov - P.fov) > 0.01) { camera.fov = P.fov; camera.updateProjectionMatrix(); }

  if (P.moveState === 'roll') P.rollAnim = damp(P.rollAnim, 0, 10, dt);
  P.roll = damp(P.roll, 0, 6, dt);

  const r = _camRight.set(Math.cos(P.yaw), 0, -Math.sin(P.yaw));
  camera.position.set(P.pos.x, P.pos.y + P.eye + P.landDip, P.pos.z);
  camera.position.addScaledVector(r, P.bobX);
  camera.position.y += P.bobY;

  const shake = P.trauma * P.trauma * 0.26;
  if (shake > 0.0001) {
    const t = performance.now();
    camera.position.x += (Math.sin(t * 0.045) * 0.5 + Math.sin(t * 0.021 + 1.3) * 0.5) * shake;
    camera.position.y += (Math.cos(t * 0.037 + 0.7) * 0.5 + Math.sin(t * 0.019 + 2.1) * 0.5) * shake;
  }
  P.trauma = Math.max(0, P.trauma - dt * 1.5);
  camera.rotation.set(P.pitch, P.yaw, P.roll + P.rollAnim, 'YXZ');

  /* 太阳跟随（保证阴影聚焦在玩家周围）
     阴影图按需更新：光照锚点吸附到 1m 网格，只有跨越格子才重绘阴影贴图，
     避免每帧（且每帧两次 render）都跑一遍 2048² 的阴影 pass。 */
}
/* ------------------------------------------------------- HUD */
let hudAcc = 0;
/* 缓存上一次写入的 HUD 值：只在真正变化时才碰 DOM（避免每帧样式/文本失效） */
let _hudSpeed = -1, _hudSta = -1, _hudExhausted = null, _hudState = '';
let _hudHp = -1, _hudAlert = null, _hudCredits = -1, _hudLevel = -1, _hudCoinTotal = -1;
let _hudMName = '', _hudMObj = '', _hudMDist = '', _hudMTime = '', _hudMUrg = null, _hudMShow = null;
let _hudMult = -1, _hudFlowShow = null, _hudFlowW = -1, _hudSpread = null, _hudDmg = -1;
let _hudMusicOff = null, _hudNetOff = null;
const STATE_LABELS = {
  normal: 'RUNNER', slide: 'SLIDE', crouch: 'CROUCH', roll: 'ROLL',
  wallrun: 'WALLRUN', mantle: 'MANTLE', vault: 'VAULT', climb: 'CLIMB', zipline: 'ZIPLINE',
  turn: '180° TURN', dead: 'DOWN',
};
function updateHUD(dt) {
  const hs = Math.hypot(P.vel.x, P.vel.z);
  stats.maxSpeed = Math.max(stats.maxSpeed, hs);
  const spd = Math.round(hs);
  if (spd !== _hudSpeed) { _hudSpeed = spd; dom.speedBox.innerHTML = `${spd}<small> m/s</small>`; }
  const sta = Math.round(P.stamina);
  if (sta !== _hudSta) { _hudSta = sta; dom.staminaFill.style.width = `${sta}%`; }
  const hp = combat ? Math.round(combat.hp) : 100;
  if (hp !== _hudHp) {
    _hudHp = hp;
    dom.healthFill.style.width = hp + '%';
    dom.healthFill.classList.toggle('low', hp < 36);
  }
  const alerted = !!(combat && combat.alarm > 0);
  if (alerted !== _hudAlert) {
    _hudAlert = alerted;
    dom.alertBanner.classList.toggle('show', alerted);
  }
  if (world && world.coins.length !== _hudCoinTotal) {
    _hudCoinTotal = world.coins.length;
    dom.coinTotal.textContent = String(_hudCoinTotal);
  }
  const credits = profile.credits;
  if (credits !== _hudCredits) { _hudCredits = credits; dom.creditCount.textContent = String(credits); }
  const lvl = profile.level;
  if (lvl !== _hudLevel) { _hudLevel = lvl; dom.levelNum.textContent = String(lvl); }
  if (P.exhausted !== _hudExhausted) {
    _hudExhausted = P.exhausted;
    dom.staminaFill.style.background = P.exhausted ? '#ff4a3a' : 'linear-gradient(90deg,#ffb02e,#ff2e2e)';
  }
  const label = P.moveState === 'normal' ? (P.grounded ? 'RUNNER' : 'AIRBORNE')
    : (STATE_LABELS[P.moveState] || P.moveState.toUpperCase());
  if (label !== _hudState) { _hudState = label; dom.stateLabel.textContent = label; }
  if (runStarted && gameState === 'playing') {
    runTime += dt;
    hudAcc += dt;
    if (hudAcc > 0.12) {
      hudAcc = 0;
      dom.timer.textContent = fmtTime(runTime);
      dom.coinCount.textContent = String(stats.coins);
      dom.coinTotal.textContent = String(world.coins.length);
      dom.creditCount.textContent = String(profile.credits);
      dom.levelNum.textContent = String(profile.level);
      dom.flowNum.textContent = String(flow.score);
      dom.routeCount.textContent = routes.length
        ? `${completedRoutes.size}/${routes.length} · ${focusRoute && !focusRoute.done ? `GATE ${focusRoute.progress + 1}/${focusRoute.gates.length}` : 'ALL CLEAR'}`
        : '—';
      refreshNetCount();
    }
  }
  if (flow.mult !== _hudMult) {
    _hudMult = flow.mult;
    dom.flowCombo.textContent = `×${flow.mult}`;
    dom.flowCombo.classList.toggle('hot', flow.mult >= 4);
  }
  const flowShow = flow.timer > 0;
  if (flowShow !== _hudFlowShow) { _hudFlowShow = flowShow; dom.flowBox.classList.toggle('show', flowShow); }
  const flowW = Math.round(clamp(flow.timer / 4.5, 0, 1) * 100);
  if (flowW !== _hudFlowW) { _hudFlowW = flowW; dom.flowFill.style.width = `${flowW}%`; }

  const spread = !P.grounded || P.moveState === 'slide';
  if (spread !== _hudSpread) { _hudSpread = spread; dom.crosshair.classList.toggle('spread', spread); }
  const dmg = clamp(P.damageFlash * 0.9 + P.trauma * 0.12, 0, 0.9);
  if (dmg === 0 ? _hudDmg !== 0 : Math.abs(dmg - _hudDmg) > 0.004) {
    _hudDmg = dmg;
    dom.damage.style.opacity = String(dmg);
  }
  P.damageFlash = Math.max(0, P.damageFlash - dt * 1.6);

  /* 交互提示 */
  let prompt = '';
  let nearest = null, nd = 1.5;
  for (const c of world.climbs) {
    const d = Math.hypot(P.pos.x - c.x, P.pos.z - c.z);
    if (d < nd) { nd = d; nearest = c; }
  }
  let zipNear = null, zdd = 3.0, zipEnd = 'from';
  for (const z of world.zips) {
    const df = Math.hypot(P.pos.x - z.from.x, P.pos.z - z.from.z);
    if (df < zdd && P.pos.y > z.from.y - 4) { zdd = df; zipNear = z; zipEnd = 'from'; }
    const dt2 = Math.hypot(P.pos.x - z.to.x, P.pos.z - z.to.z);
    if (dt2 < zdd && P.pos.y > z.to.y - 4) { zdd = dt2; zipNear = z; zipEnd = 'to'; }
  }
  let meleeNear = 1e9;
  if (combat) {
    for (const g of combat.guards) {
      if (g.dead || g.state === 'down') continue;
      const d = Math.hypot(g.pos.x - P.pos.x, g.pos.z - P.pos.z);
      if (d < meleeNear) meleeNear = d;
    }
  }
  const isTouch = !!(touch && touch.active);
  const canZip = !!(zipNear && zdd < 2.8 && P.grounded && P.pos.y > (zipEnd === 'to' ? zipNear.to.y : zipNear.from.y) - 4);
  const canPipe = !!(nearest && nd < 1.4 && P.grounded && P.pos.y < nearest.topY - 0.5);
  if (touch) {
    touch.updateContext({
      canInteract: canZip || canPipe,
      canMelee: meleeNear < 4.2,
      inTrial: trial.active,
      needMissionDot: !(missions && missions.active),
    });
  }
  if (meleeNear < 3.0) prompt = isTouch ? '点击 <b>缴械</b> · 近战反击（反应时间）' : '<b>F</b> 近战 · 缴械（反应时间）';
  else if (zipNear && zipEnd === 'to' && zdd < 2.8 && P.grounded && P.pos.y > zipNear.to.y - 4) {
    prompt = isTouch ? '点击 <b>互动</b> 抓滑索 · 上推摇杆上爬' : '<b>E</b> 抓住滑索 · 按住 <b>W</b> 上爬';
  }
  else if (zipNear && zdd < 2.8 && P.grounded && P.pos.y > zipNear.from.y - 4) {
    prompt = isTouch ? '点击 <b>互动</b> 滑索下滑' : '<b>E</b> 滑索下滑';
  }
  else if (nearest && nd < 1.4 && P.grounded && P.pos.y < nearest.topY - 0.5) {
    prompt = isTouch ? '上推摇杆 / 点击 <b>互动</b> 攀爬管道' : '<b>W / E</b> 攀爬管道';
  }
  else if (P.moveState === 'climb' && P.climb && P.pos.y > P.climb.data.topY - 0.6) {
    prompt = isTouch ? '继续上推摇杆翻上屋顶' : '<b>W</b> 翻上屋顶';
  }
  else if (P.moveState === 'normal' && !P.grounded && P.pos.x > 43 && P.pos.x < 57 && P.pos.z > -4 && P.pos.z < 1) prompt = '贴近红色跑道墙 · 蹬墙跑';
  else if (P.pos.x > 29.5 && P.pos.x < 34.5 && P.pos.y > 13 && P.pos.y < 15 && hs > 5) {
    prompt = isTouch ? '点击 <b>铲/蹲</b> 滑铲通过横杆' : '<b>C</b> 滑铲通过横杆';
  }
  else if (P.pos.x > 36.5 && P.pos.x < 39.5 && P.pos.y > 13 && P.pos.y < 15) {
    prompt = isTouch ? '点击 <b>跳</b> 翻越障碍' : '<b>SPACE</b> 翻越障碍';
  }
  else if (P.pos.x > 133 && P.pos.x < 140.5 && P.pos.y < 9) prompt = '踩上弹簧板 · SPRINGBOARD';
  else if (trial.active && !trial.started) prompt = '穿过发光圆环 · 开始计时';
  if (prompt !== currentPrompt) {
    currentPrompt = prompt;
    dom.prompt.innerHTML = prompt;
    dom.prompt.classList.toggle('show', !!prompt);
  }

  if (gameState === 'playing' && !paused) {
    const dq = world.districtAt(P.pos.x, P.pos.z);
    if (dq !== curDistrict) {
      const first = curDistrict === null;
      curDistrict = dq;
      if (!first) {
        showToast(`◈ ${dq.name}`);
        audio.tone({ f0: 587, type: 'sine', dur: 0.08, gain: 0.04 });
      }
    }
  }

  /* 屏幕外目标：最近金币 + 下一光门 + 最近的联机跑者 */
  camera.updateMatrixWorld();
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const target = nearestCoinPos();
  const gateTarget = nextGatePos();
  updateMarker(dom.marker, target, 30);
  updateMarker(dom.marker2, gateTarget, 30);
  updateRunnerMarker();
  updateMissionMarker();

  /* 任务 HUD */
  if (missions) {
    const mh = missions.hud;
    if (mh.show !== _hudMShow) { _hudMShow = mh.show; dom.missionHud.classList.toggle('show', mh.show); }
    if (mh.show) {
      if (mh.title !== _hudMName) { _hudMName = mh.title; dom.mhTitle.textContent = mh.title; }
      if (mh.objective !== _hudMObj) { _hudMObj = mh.objective; dom.mhObj.textContent = mh.objective; }
      const dtxt = mh.distText;
      if (dtxt !== _hudMDist) { _hudMDist = dtxt; dom.mhDist.textContent = dtxt; }
      const ttxt = mh.timeText;
      if (ttxt !== _hudMTime) { _hudMTime = ttxt; dom.mhTime.textContent = ttxt; }
      if (mh.urgency !== _hudMUrg) { _hudMUrg = mh.urgency; dom.mhTime.classList.toggle('urgency', mh.urgency); }
    }
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) dom.objective.classList.remove('show');
  }
  if (achToastTimer > 0) {
    achToastTimer -= dt;
    if (achToastTimer <= 0) dom.achToast.classList.remove('show');
  }
  const musicOff = !music.on;
  if (musicOff !== _hudMusicOff) { _hudMusicOff = musicOff; dom.musicLabel.classList.toggle('off', musicOff); }
  const netOff = net.status === 'off' || net.status === 'error';
  if (netOff !== _hudNetOff) { _hudNetOff = netOff; dom.netLabel.classList.toggle('off', netOff); }
}
const _markerV = new THREE.Vector3();
const _runnerV = new THREE.Vector3();
const _missionV = new THREE.Vector3();
let _runnerEm = null;
function nearestRemote() {
  let best = null, bd = 260 * 260;
  for (const p of net.players.values()) {
    if (p.pos[1] < -100) continue;
    const d = (p.pos[0] - P.pos.x) ** 2 + (p.pos[1] - P.pos.y) ** 2 + (p.pos[2] - P.pos.z) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function updateRunnerMarker() {
  const el = dom.runnerMarker;
  const p = nearestRemote();
  if (!p || gameState !== 'playing') { el.classList.remove('show'); return; }
  _runnerV.set(p.pos[0], p.pos[1] + 2.3, p.pos[2]).project(camera);
  const dist = Math.hypot(p.pos[0] - P.pos.x, p.pos[1] - P.pos.y, p.pos[2] - P.pos.z);
  if (_runnerV.z > 1) { el.classList.remove('show'); return; }
  const cx = (_runnerV.x * 0.5 + 0.5) * window.innerWidth;
  const cy = (-_runnerV.y * 0.5 + 0.5) * window.innerHeight;
  const onScreen = cx > 40 && cx < window.innerWidth - 40 && cy > 40 && cy < window.innerHeight - 40;
  el.classList.add('show');
  el.style.left = `${clamp(cx, 34, window.innerWidth - 34)}px`;
  el.style.top = `${clamp(cy, 34, window.innerHeight - 34)}px`;
  el.style.opacity = onScreen ? '0.85' : '1';
  if (!_runnerEm) _runnerEm = el.querySelector('em');
  if (_runnerEm) _runnerEm.textContent = `${p.name} ${Math.round(dist)}m`;
}
function updateMissionMarker() {
  const el = dom.marker3;
  const m = missions && missions.active;
  if (!m || !P || gameState !== 'playing') { el.style.display = 'none'; return; }
  const st = m.stages[m.stage];
  if (!st) { el.style.display = 'none'; return; }
  _missionV.set(st.x, st.y, st.z).project(camera);
  if (_missionV.z >= 1) { el.style.display = 'none'; return; }
  const cx = (_missionV.x * 0.5 + 0.5) * window.innerWidth;
  const cy = (-_missionV.y * 0.5 + 0.5) * window.innerHeight;
  el.style.display = 'flex';
  el.style.left = clamp(cx, 30, window.innerWidth - 30) + 'px';
  el.style.top = clamp(cy, 30, window.innerHeight - 30) + 'px';
  const ang = Math.atan2(cy - window.innerHeight / 2, cx - window.innerWidth / 2) + Math.PI / 4;
  el.firstElementChild.style.transform = 'rotate(' + ang + 'rad)';
}
function updateMarker(el, target, margin) {
  if (!target || gameState !== 'playing') { el.classList.remove('show'); return; }
  _markerV.set(target.x, target.y, target.z).project(camera);
  if (_markerV.z < 1) {
    const cx = (_markerV.x * 0.5 + 0.5) * window.innerWidth;
    const cy = (-_markerV.y * 0.5 + 0.5) * window.innerHeight;
    const ex = clamp(cx, margin, window.innerWidth - margin);
    const ey = clamp(cy, margin, window.innerHeight - margin);
    el.classList.add('show');
    el.style.left = `${ex}px`;
    el.style.top = `${ey}px`;
    const ang = Math.atan2(cy - window.innerHeight / 2, cx - window.innerWidth / 2) + Math.PI / 4;
    el.firstElementChild.style.transform = `rotate(${ang}rad)`;
  } else {
    el.classList.remove('show');
  }
}

/* ------------------------------------------------------- 菜单 / 面板 */
function setPaused(v) {
  paused = v;
  dom.pause.classList.toggle('hidden', !paused);
  if (paused) {
    if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
  } else {
    requestLock();
  }
}
function togglePause() {
  if (gameState !== 'playing') return;
  if (missionsOpen) { toggleMissions(false); return; }
  if (shopOpen) { toggleShop(false); return; }
  if (recordsOpen) { toggleRecords(false); return; }
  setPaused(!paused);
}
function anyPanelOpen() { return recordsOpen || missionsOpen || shopOpen; }
function syncPanelPause() {
  if (gameState !== 'playing') return;
  if (anyPanelOpen()) {
    if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
    paused = true;
    dom.pause.classList.add('hidden');
  } else if (paused && dom.pause.classList.contains('hidden')) {
    paused = false;
    requestLock();
  }
}
function tryMelee() {
  if (!combat || meleeCd > 0) return;
  meleeCd = 0.42;
  meleeAnimT = 0.32;
  P.fovKick += 1.6;
  const res = combat.melee(P);
  if (res.hit) {
    gainFlow(160, 'DISARM');
    addXp(30);
    showToast('◈ 缴械 · REACTION TIME', 1500);
    P.trauma = Math.max(P.trauma, 0.3);
    dom.hitmarker.classList.remove('show');
    void dom.hitmarker.offsetWidth;
    dom.hitmarker.classList.add('show');
    checkAchievements();
  }
}

/* ------------------------------------------------------- 任务面板 */
const missionRefs = new Map();
function missionCard(m, cls) {
  missionRefs.set(m.id, m);
  const active = missions && missions.active === m;
  const reward = m.reward || { credits: 0, xp: 0 };
  const stageTxt = m.stages && m.stages.length ? ' · ' + m.stages.length + ' 段' : '';
  return '<div class="mcard ' + (cls || '') + (active ? ' active' : '') + '">'
    + '<div class="mtop"><span class="mname">' + m.name + '</span><span class="mtag">' + (m.tag || '') + stageTxt + '</span></div>'
    + '<div class="mdesc">' + (m.desc || '') + '</div>'
    + '<div class="mfoot"><span class="mrew">+' + reward.credits + ' ¢<span>+' + reward.xp + ' XP</span></span>'
    + (active
      ? '<button class="btn ghost small" data-act="abandon">放弃</button>'
      : '<button class="btn small" data-act="accept" data-mid="' + m.id + '">接受</button>')
    + '</div></div>';
}
function renderMissions() {
  if (!missions) return;
  missionRefs.clear();
  const story = missions.story;
  if (missions.storyDone()) {
    dom.storyList.innerHTML = '<div class="mcard story"><div class="mname">剧情已全部完成</div><div class="mdesc">这座城市的每一条屋顶线都记得你。</div></div>';
  } else {
    dom.storyList.innerHTML = missionCard(story, 'story');
  }
  dom.contractList.innerHTML = missions.offers.length
    ? missions.offers.map((m) => missionCard(m, '')).join('')
    : '<div class="mcard"><div class="mname">暂无委托</div><div class="mdesc">点击右上角「刷新」获取新委托。</div></div>';
  const act = missions.active;
  dom.missionActive.innerHTML = act
    ? '<div class="section-title">进行中</div>' + missionCard(act, '') 
    : '';
  const daily = missions.daily;
  const dinfo = dailyInfo();
  dom.dailyCard.innerHTML = '<div class="mcard ' + (dinfo.done ? '' : 'story') + '">'
    + '<div class="mtop"><span class="mname">' + (daily ? daily.name : '每日挑战') + '</span><span class="mtag">' + (dinfo.done ? '已完成' : '今日限一次') + '</span></div>'
    + '<div class="mdesc">' + (dinfo.done ? '今日已完成 · 用时 ' + dinfo.score + 's · 明天再来' : '连续抵达 3 个信号点 · 奖励 320 ¢ + 260 XP') + '</div>'
    + '<div class="mfoot"><span class="mrew">' + (dinfo.done ? '—' : '+320 ¢<span>+260 XP</span>') + '</span>'
    + (dinfo.done ? '' : '<button class="btn small" data-mid="' + (daily ? daily.id : '') + '" data-act="accept-daily">开始</button>')
    + '</div></div>';
  missionRefs.forEach(() => {});
  if (daily) missionRefs.set(daily.id, daily);
  dom.missionsPanel.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const actType = btn.dataset.act;
      if (actType === 'abandon') { missions.abandon(); renderMissions(); return; }
      if (actType === 'accept') {
        const m = missionRefs.get(btn.dataset.mid);
        if (m && missions.accept(m)) { toggleMissions(false); }
        return;
      }
      if (actType === 'accept-daily') {
        const m = missionRefs.get(btn.dataset.mid);
        if (m && missions.accept(m)) toggleMissions(false);
      }
    });
  });
  dom.btnRefresh.onclick = () => {
    missions.refreshOffers();
    renderMissions();
    audio.uiClick();
  };
}
function toggleMissions(force) {
  if (gameState !== 'playing') return;
  missionsOpen = force !== undefined ? force : !missionsOpen;
  dom.missionsPanel.classList.toggle('hidden', !missionsOpen);
  if (missionsOpen) {
    if (shopOpen) toggleShop(false);
    renderMissions();
  }
  syncPanelPause();
}

/* ------------------------------------------------------- 商店 */
function renderShop() {
  dom.shopCredits.textContent = String(profile.credits);
  dom.shopLevel.textContent = String(profile.level);
  dom.shopRank.textContent = '· ' + rankName() + ' · 进度 ' + Math.round(levelProgress() * 100) + '%';
  dom.skillList.innerHTML = SKILLS.map((def) => {
    const lv = skillLevel(def.id);
    const cost = skillCost(def.id);
    const maxed = lv >= def.max;
    let dots = '';
    for (let i = 0; i < def.max; i++) dots += '<i class="' + (i < lv ? 'on' : '') + '"></i>';
    return '<div class="scard"><div class="srow"><span class="sname">' + def.icon + ' ' + def.name + '</span>'
      + '<span class="scost">' + (maxed ? '已满级' : cost + ' ¢') + '</span></div>'
      + '<div class="sdesc">' + def.desc + '</div>'
      + '<div class="srow"><div class="srank">' + dots + '</div>'
      + (maxed ? '' : '<button class="btn small" data-skill="' + def.id + '">升级</button>')
      + '</div></div>';
  }).join('');
  dom.skinList.innerHTML = SKINS.map((def) => {
    const owned = profile.skins.includes(def.id);
    const eq = profile.skin === def.id;
    const hex = '#' + def.color.toString(16).padStart(6, '0');
    return '<div class="kcard ' + (eq ? 'equipped' : owned ? 'owned' : '') + '" data-skin="' + def.id + '">'
      + '<div class="swatch" style="background:' + hex + '"></div>'
      + '<div class="kname">' + def.name + '</div>'
      + '<div class="kprice ' + (owned ? 'free' : '') + '">' + (eq ? '使用中' : owned ? '已拥有 · 点击装备' : def.cost + ' ¢') + '</div>'
      + '</div>';
  }).join('');
  dom.skillList.querySelectorAll('button[data-skill]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const res = buySkill(btn.dataset.skill);
      if (res.ok) { audio.buy(); showToast('✦ 技能升级 · LV' + res.level, 1600); }
      else { audio.uiClick(); showToast('✖ ' + res.reason, 1800); }
      renderShop();
    });
  });
  dom.skinList.querySelectorAll('[data-skin]').forEach((card) => {
    card.addEventListener('click', () => {
      const id = card.dataset.skin;
      if (profile.skins.includes(id)) {
        equipSkin(id);
        audio.uiClick();
      } else {
        const res = buySkin(id);
        if (res.ok) { audio.buy(); showToast('✦ 已解锁外观', 1800); }
        else { audio.uiClick(); showToast('✖ ' + res.reason, 1800); }
      }
      applySkin();
      renderShop();
    });
  });
}
function toggleShop(force) {
  if (gameState !== 'playing') return;
  shopOpen = force !== undefined ? force : !shopOpen;
  dom.shopPanel.classList.toggle('hidden', !shopOpen);
  if (shopOpen) {
    if (missionsOpen) toggleMissions(false);
    renderShop();
  }
  syncPanelPause();
}
function applySkin() {
  const def = skinDef();
  if (arms && arms.userData) {
    const u = arms.userData;
    if (u.sleeve) u.sleeve.color.setHex(def.color);
    if (u.glove) u.glove.color.setHex(def.glove);
  }
}
function toggleRecords(force) {
  recordsOpen = force !== undefined ? force : !recordsOpen;
  if (recordsOpen) {
    if (missionsOpen) { missionsOpen = false; dom.missionsPanel.classList.add('hidden'); }
    if (shopOpen) { shopOpen = false; dom.shopPanel.classList.add('hidden'); }
  }
  dom.records.classList.toggle('hidden', !recordsOpen);
  if (recordsOpen) renderRecords();
  if (recordsOpen && gameState === 'playing') {
    if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
    paused = true;
    dom.pause.classList.add('hidden');
  } else if (!recordsOpen && gameState === 'playing' && paused) {
    paused = false;
    requestLock();
  }
}
function showFinishCard({ title, sub, time, best }) {
  dom.finishTitle.textContent = title;
  dom.finishSub.textContent = sub;
  dom.finishTime.textContent = fmtTime(time);
  dom.finishBest.textContent = best !== undefined ? `个人最佳 · ${fmtTime(best)}` : '';
  dom.statMaxspeed.textContent = `${stats.maxSpeed.toFixed(1)} m/s`;
  dom.statJumps.textContent = String(stats.jumps);
  dom.statDeaths.textContent = String(stats.deaths);
  dom.statCp.textContent = `${stats.routesDone}/${routes.length}`;
  dom.statRoute.textContent = `${stats.trialsDone} 次 · ${stats.records} 纪录`;
  dom.finish.classList.remove('hidden');
  if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
  paused = true;
}
function renderRecords() {
  dom.recCoins.textContent = `${stats.coins} / ${world.coins.length}`;
  dom.recDistance.textContent = `${stats.distance.toFixed(0)} m`;
  dom.recMaxspeed.textContent = `${stats.maxSpeed.toFixed(1)} m/s`;
  dom.recMoves.textContent = `${stats.jumps} / ${stats.wallruns} / ${stats.ziplines} / ${stats.springs}`;
  dom.recFlow.textContent = `${flowSave.total} · 最佳连锁 ${flowSave.best}`;
  dom.recRoute.textContent = `${flowSave.gates || 0} 门 · ${completedRoutes.size}/${routes.length} 条路线`;
  const pr = document.getElementById('rec-profile');
  if (pr) pr.innerHTML = '信用点 <b>' + profile.credits + '</b> · 等级 <b>' + profile.level + '</b> ' + rankName()
    + ' · 剧情 <b>' + Math.min(profile.story, 6) + '/6</b> · 委托 <b>' + profile.missionHistory + '</b>';
  dom.achList.innerHTML = ACH_DEFS.map((a) => {
    const ok = unlockedAch.has(a.id);
    return `<div class="ach ${ok ? 'unlocked' : ''}"><div class="ico">${a.icon}</div><div><b>${a.name}</b><span>${a.desc}</span></div></div>`;
  }).join('');
  dom.trialList.innerHTML = routes.map((r) => {
    const t = trialTimes[r.id];
    const done = completedRoutes.has(r.id);
    return `<div class="stat-line"><span>${done ? '✓ ' : ''}${r.name}</span><b>${t ? fmtTime(t.time) : '—'}</b></div>`;
  }).join('');
  renderLeaderboard();
}
function renderLeaderboard() {
  const rows = [{ name: net.name || '我', best: flowSave.best, self: true, online: net.status === 'online' || net.status === 'local' }];
  for (const p of net.players.values()) rows.push({ name: p.name, best: p.best, self: false, online: true });
  rows.sort((a, b) => b.best - a.best);
  dom.lbList.innerHTML = rows.map((r, i) => `
    <div class="stat-line ${r.self ? 'self' : ''}">
      <span>${i + 1}. ${r.name}${r.self ? ' · 我' : ''}</span><b>${r.best || 0} FLOW</b>
    </div>`).join('');
}

/* ------------------------------------------------------- 游戏流程 */
function startGame() {
  audio.ensure();
  audio.setVolume(settings.volume);
  music.setVolume(settings.musicVolume);
  if (settings.musicOn) music.start(false);
  resetRun();
  gameState = 'playing';
  paused = false;
  missionsOpen = false;
  shopOpen = false;
  if (dom.missionsPanel) dom.missionsPanel.classList.add('hidden');
  if (dom.shopPanel) dom.shopPanel.classList.add('hidden');
  if (combat) combat.reset();
  if (missions) { missions.buildStory(); missions.refreshOffers(); missions.buildDaily(); }
  dom.menu.classList.add('hidden');
  dom.pause.classList.add('hidden');
  dom.finish.classList.add('hidden');
  dom.records.classList.add('hidden');
  recordsOpen = false;
  if (settings.net && net.status !== 'online' && net.status !== 'local') {
    net.connect(settings.room, settings.name || dom.nick.value);
  }
  requestLock();
}
function resetRun() {
  player.reset();
  Object.assign(stats, {
    jumps: 0, deaths: 0, maxSpeed: 0, distance: 0, airTimeTotal: 0,
    coins: collectedCoinIds.size, wallruns: 0, ziplines: 0, springs: 0, slides: 0, mantles: 0, vaults: 0,
    gates: 0, routesDone: 0, trialsDone: 0, records: 0,
  });
  flow.score = 0; flow.chain = 0; flow.mult = 1; flow.timer = 0;
  runTime = 0;
  runStarted = false;
  curDistrict = null;
  dom.damage.style.opacity = 0;
  cancelTrial(true);
  showToast(
    touch && touch.active
      ? '◈ 点击右上角「任务」接取委托 · 推到底自动冲刺 · 红色 = 跑者视觉'
      : '◈ 按 J 接受第一份城市委托 · 跟随金色光柱 · 红色 = 跑者视觉路线',
    3800,
  );
}
function quitToMenu() {
  setPaused(false);
  missionsOpen = false;
  shopOpen = false;
  if (dom.missionsPanel) dom.missionsPanel.classList.add('hidden');
  if (dom.shopPanel) dom.shopPanel.classList.add('hidden');
  gameState = 'menu';
  paused = false;
  dom.pause.classList.add('hidden');
  dom.records.classList.add('hidden');
  dom.menu.classList.remove('hidden');
  cancelTrial(true);
  if (document.pointerLockElement === dom.canvas) document.exitPointerLock();
  music.menuMode = true;
  music.setIntensity(0.28);
  if (music.on) music.next(true);
}

dom.btnStart.addEventListener('click', startGame);
dom.btnResume.addEventListener('click', () => setPaused(false));
if (dom.btnPauseX) dom.btnPauseX.addEventListener('click', () => setPaused(false));
dom.btnRestart.addEventListener('click', () => { setPaused(false); startGame(); });
dom.btnQuit.addEventListener('click', quitToMenu);
dom.btnAgain.addEventListener('click', () => { dom.finish.classList.add('hidden'); setPaused(false); startGame(); });
if (dom.btnFinishContinue) {
  dom.btnFinishContinue.addEventListener('click', () => {
    dom.finish.classList.add('hidden');
    setPaused(false);
  });
}
dom.btnRecordsClose.addEventListener('click', () => toggleRecords(false));
if (dom.btnRecordsX) dom.btnRecordsX.addEventListener('click', () => toggleRecords(false));
dom.records.addEventListener('click', (e) => { if (e.target === dom.records) toggleRecords(false); });
dom.pause.addEventListener('click', (e) => { if (e.target === dom.pause) setPaused(false); });
dom.btnMissionsClose.addEventListener('click', () => toggleMissions(false));
dom.btnShopClose.addEventListener('click', () => toggleShop(false));
document.getElementById('btn-missions-x').addEventListener('click', () => toggleMissions(false));
document.getElementById('btn-shop-x').addEventListener('click', () => toggleShop(false));
dom.missionsPanel.addEventListener('click', (e) => { if (e.target === dom.missionsPanel) toggleMissions(false); });
dom.shopPanel.addEventListener('click', (e) => { if (e.target === dom.shopPanel) toggleShop(false); });

/* 暂停面板快捷操作（移动端与桌面端通用） */
if (dom.btnPauseRespawn) {
  dom.btnPauseRespawn.addEventListener('click', () => {
    setPaused(false);
    if (player) { player.respawn(); stats.deaths++; showToast('↻ 返回最近的安全屋顶'); }
  });
}
if (dom.btnPauseLight) {
  dom.btnPauseLight.addEventListener('click', () => {
    const i = TIME_PRESETS.indexOf(settings.timeOfDay || 'morning');
    applyTimePreset(TIME_PRESETS[(i + 1) % TIME_PRESETS.length]);
    audio.uiClick();
  });
}
if (dom.btnPauseMusic) {
  dom.btnPauseMusic.addEventListener('click', () => {
    const on = music.toggle(false);
    settings.musicOn = on;
    saveSettings();
    dom.btnPauseMusic.textContent = on ? '♪ 音乐：开' : '♪ 音乐：关';
  });
}
if (dom.btnPauseNext) {
  dom.btnPauseNext.addEventListener('click', () => {
    music.next(false);
  });
}
if (dom.btnPauseFs) {
  if (touch && !touch.canFullscreen()) dom.btnPauseFs.style.display = 'none';
  dom.btnPauseFs.addEventListener('click', () => {
    if (touch) touch.toggleFullscreen(true);
  });
}
dom.btnNet.addEventListener('click', () => {
  if (net.status === 'online' || net.status === 'local' || net.status === 'connecting') net.disconnect();
  else net.connect(dom.room.value, dom.nick.value);
});
dom.nick.addEventListener('change', () => { settings.name = sanitizeText(dom.nick.value, 12); dom.nick.value = settings.name; saveSettings(); });
dom.room.addEventListener('change', () => {
  settings.room = sanitizeText(dom.room.value, 24).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'white-city';
  dom.room.value = settings.room;
  saveSettings();
  if (net.status === 'online' || net.status === 'local') net.connect(settings.room, settings.name || dom.nick.value);
});
dom.setSens.addEventListener('input', () => { settings.sens = parseFloat(dom.setSens.value); saveSettings(); });
dom.setFov.addEventListener('input', () => {
  settings.fov = parseInt(dom.setFov.value, 10);
  saveSettings();
});
dom.setVolume.addEventListener('input', () => { settings.volume = parseFloat(dom.setVolume.value); audio.setVolume(settings.volume); saveSettings(); });
dom.setMusicVolume.addEventListener('input', () => { settings.musicVolume = parseFloat(dom.setMusicVolume.value); music.setVolume(settings.musicVolume); saveSettings(); });
dom.chkGhost.addEventListener('change', () => { settings.ghost = dom.chkGhost.checked; saveSettings(); });
dom.setQuality.addEventListener('change', () => { setQuality(dom.setQuality.value); saveSettings(); });
dom.setRT.addEventListener('change', () => { settings.rt = dom.setRT.value; applyRT(); saveSettings(); });
dom.setTime.addEventListener('change', () => applyTimePreset(dom.setTime.value));
if (dom.setTouch) {
  dom.setTouch.addEventListener('change', () => {
    settings.touch = dom.setTouch.value;
    saveSettings();
    if (touch) touch.refreshMode();
  });
}
if (dom.chkAutoSprint) {
  dom.chkAutoSprint.addEventListener('change', () => {
    settings.autoSprint = dom.chkAutoSprint.checked;
    saveSettings();
  });
}

music.onChange = (tr) => {
  dom.musicTrack.textContent = `${tr.name} · ${tr.mood}`;
  renderTrackList();
};
function renderTrackList() {
  dom.trackList.innerHTML = TRACK_CATALOG.map((t, i) => `
    <div class="track ${i === music.trackIndex ? 'playing' : ''}" title="${t.mood} · ${t.bpm} BPM">
      <span>${i + 1}. ${t.name}</span><span>${t.bpm}</span>
    </div>`).join('');
}

/* 质量 */
function applyRT() {
  gfx.applyRT(settings.quality === 'low' ? 'off' : (settings.rt || 'low'));
}
const TIME_PRESETS = ['morning', 'noon', 'golden', 'overcast'];
function applyTimePreset(id, rebake = true) {
  if (!world || !gfx) return;
  const p = gfx.setPreset(id);
  if (!p) return;
  const u = world.skyUniforms;
  if (u) {
    u.uZenith.value.setHex(p.zenith);
    u.uHorizon.value.setHex(p.horizon);
    u.uGround.value.setHex(p.ground);
    u.uSunColor.value.setHex(p.sun);
    u.uSunDir.value.copy(gfx.sunDir);
  }
  scene.fog.color.setHex(p.horizon);
  scene.background.setHex(p.horizon);
  renderer.shadowMap.needsUpdate = true;
  if (rebake) gfx.bakeEnvironment(world.skyMat);
  settings.timeOfDay = id;
  if (dom.setTime) dom.setTime.value = id;
  saveSettings();
  const names = { morning: '清晨', noon: '正午', golden: '黄昏', overcast: '阴天' };
  if (gameState === 'playing') showToast('☀ 光照 · ' + (names[id] || id), 1600);
}
function setQuality(q) {
  settings.quality = q;
  dom.setQuality.value = q;
  gfx.setQuality(q);
  if (world) world.quality = q;
  if (q === 'low') {
    renderer.setPixelRatio(1);
    dom.fxCanvas.style.display = 'none';
  } else {
    const mobile = isMobileDevice();
    const maxPr = mobile ? (q === 'medium' ? 1.35 : 1.65) : (q === 'medium' ? 1.5 : 2);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPr));
    dom.fxCanvas.style.display = '';
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  gfx.resize();
  applyRT();
}

/* ------------------------------------------------------- 主循环 */
let musicMeterTimer = 0;
let achAcc = 0;
function updateGame(dt) {
  if (!runStarted && (getMoveInput().len > 0 || jumpQueued)) runStarted = true;
  if (world && world.physStats) {
    world.physStats.queries = 0;
    world.physStats.boxesExamined = 0;
    world.physStats.rays = 0;
    world.physStats.raySteps = 0;
  }
  /* 反应时间：成功缴械后短暂慢动作（镜之边缘标志性手感） */
  const timeScale = combat && combat.slowmo > 0 ? 0.38 : 1;
  const simDt = dt * timeScale;
  if (meleeAnimT > 0) meleeAnimT -= dt;
  if (meleeCd > 0) meleeCd -= dt;
  /* 低帧率时拆分子步，保证碰撞稳定（60fps 时恒为 1 步，手感不变） */
  const steps = simDt > 0.024 ? Math.min(3, Math.ceil(simDt / 0.018)) : 1;
  const h = simDt / steps;
  for (let i = 0; i < steps; i++) player.update(h);
  /* NaN 看门狗 */
  if (!isFinite(P.pos.x) || !isFinite(P.pos.y) || !isFinite(P.pos.z) || !isFinite(P.vel.x) || !isFinite(P.vel.y) || !isFinite(P.vel.z)) {
    P.pos.copy(P.lastSafe.pos);
    P.vel.set(0, 0, 0);
    P.moveState = 'normal';
    P.slide = P.mantle = P.vault = P.wallrun = P.climb = P.zipline = P.turn = null;
    P.grounded = false;
    console.warn('[WATCHDOG] NaN 物理状态 → 重置到安全屋顶');
  }
  const hs = Math.hypot(P.vel.x, P.vel.z);
  stats.distance += hs * dt;
  if (!P.grounded && P.moveState !== 'climb' && P.moveState !== 'zipline') stats.airTimeTotal += dt;

  world.updateCoins(dt, P.pos);
  collectWorldCoins();
  updateRoutes();
  updateTrial(dt);
  if (combat) {
    const alarmNow = combat.alarm > 0;
    if (alarmNow !== _alarmWas) {
      _alarmWas = alarmNow;
      if (music.setMood) music.setMood(alarmNow ? 'chase' : 'explore');
    }
    combat.update(simDt, P);
  }
  if (missions) { missions.update(dt, P); missions.updateFx(dt, performance.now() * 0.001); }
  if (flow.timer > 0) {
    flow.timer -= dt;
    if (flow.timer <= 0) bankFlow();
  }
  achAcc += dt;
  if (achAcc > 0.33) { achAcc = 0; checkAchievements(); }
  updateCamera(dt);
  updateRunnerVision(dt);
  updateSpeedFx(dt);
  updateHUD(dt);
  audio.updateWind(hs, !P.grounded);
  world.updateBursts(dt);
  world.updateAmbient(dt, performance.now() * 0.001);
  net.update(dt);
  /* 联机状态上报 */
  net.selfBest = flowSave.best;
  net.sendState(false, [P.pos.x, P.pos.y, P.pos.z, P.yaw, hs, stateCode(P.moveState), flow.mult, flowSave.best]);
  updateRemoteAvatars(dt);

  /* 动态 BGM：跑得越快、连锁越高，层次越丰富 */
  if (!musicMeterTimer || performance.now() - musicMeterTimer > 200) {
    musicMeterTimer = performance.now();
    const target = clamp(
      0.16 + clamp(hs / PHYS.SPRINT_SPEED, 0, 1) * 0.42 + (P.grounded ? 0 : 0.06)
      + (flow.timer > 0 ? (flow.mult - 1) * 0.08 : 0)
      + (P.moveState === 'wallrun' || P.moveState === 'zipline' ? 0.12 : 0)
      + (combat && combat.alarm > 0 ? 0.26 : 0),
      0, 1,
    );
    music.setIntensity(target);
  }
}

function updateAttract(dt) {
  menuTime += dt;
  const a = menuTime * 0.05;
  camera.position.set(70 + Math.sin(a) * 55, 34 + Math.cos(a * 0.7) * 10, 46 + Math.cos(a) * 55);
  camera.lookAt(52, 17, 0);
  camera.fov = settings.fov;
  camera.updateProjectionMatrix();
  audio.updateWind(0.4, true);
  arms.visible = false;
  music.setIntensity(0.28);
  if (world) world.updateAmbient(dt, performance.now() * 0.001);
  updateRemoteAvatars(dt);
  net.update(dt);
  net.sendState(false, [0, -999, 0, 0, 0, 0, 1, flowSave.best]);
}

function render() {
  gfx.render();
}

let lastTime = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  let dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;
  if (lockGrace > 0) lockGrace -= dt;
  if (touch) {
    const finishOpen = !dom.finish.classList.contains('hidden');
    touch.setGameplayVisible(gameState === 'playing' && !paused && !anyPanelOpen() && !chat.open && !finishOpen);
  }
  const simDt = (gameState === 'playing' && !paused) ? dt : 0;
  if (simDt > 0) {
    arms.visible = true;
    updateGame(simDt);
  } else if (gameState === 'menu') {
    updateAttract(dt);
  } else {
    updateHUD(0);
    updateCamera(dt);
    arms.visible = gameState === 'playing';
  }
  if (gameState !== 'menu') updateArms(dt, now * 0.001);
  music.update(dt);
  const pulse = 0.5 + Math.sin(now * 0.004) * 0.12;
  for (const m of world.pulseMats) {
    if (m.emissiveIntensity === undefined) continue;
    m.emissiveIntensity = pulse * (m === world.pulseMats[1] ? 1.5 : 0.75);
  }
  /* 图形管线：阴影跟随玩家 · 太阳视觉 · 大气/调色 uniform */
  gfx.update(dt, {
    P: gameState === 'playing' ? P : null,
    speed: P ? Math.hypot(P.vel.x, P.vel.z) : 0,
    damage: P ? clamp(P.damageFlash * 0.8 + P.trauma * 0.1, 0, 0.9) : 0,
    flash: 0,
    flow: flow.timer > 0 && flow.mult >= 3,
  });
  render();
}

/* ------------------------------------------------------- 启动 */
function handleResize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  gfx.resize();
  resizeFx();
}
window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => setTimeout(handleResize, 120));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', handleResize);
}

function setLoading(pct, text) {
  dom.loadingFill.style.width = `${pct}%`;
  if (text) dom.loadingText.textContent = text;
}
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const fin = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 80);
});

async function boot() {
  setLoading(8, '初始化渲染器…');
  await nextFrame();
  setLoading(20, '生成白色城市…');
  await nextFrame();
  world = await buildWorld(scene, (p) => setLoading(20 + p * 36, '生成白色城市…'));
scene.traverse((o) => {
  if (o.isSprite || o.isPoints) o.layers.set(1);
});
  /* 重建玩家（真实世界） */
  player = createPlayer(world, hooks);
  P = player.P;
  P.fov = settings.fov;
  P.height = PHYS.PLAYER_HEIGHT;
  P.eye = PHYS.EYE_HEIGHT;
  P.rollAnim = 0;
  P.bobTime = 0;
  /* City Protection 追捕系统 */
  combat = new CombatSystem(world, scene, camera, {
    onDamage: (n, from) => {
      P.damageFlash = Math.max(P.damageFlash, 0.85);
      P.trauma = Math.max(P.trauma, 0.4);
      audio.hurt();
    },
    onDown: () => {
      showToast('✖ 你被击倒了 · 回到安全点', 2600);
      player.die('shot');
    },
    onSpotted: () => {
      showToast('⚠ City Protection 发现了你 · 快跑', 2200);
      audio.alarm();
    },
    onAlarmStart: () => { if (music.setMood) music.setMood('chase'); },
    onAlarmEnd: () => { if (music.setMood) music.setMood('explore'); },
    onMelee: (g) => { stats.kills = (stats.kills || 0) + 1; },
    onHitMarker: () => { },
  });
  missions = new MissionSystem(world, scene, {
    getPlayer: () => P,
    combat,
    hooks: {
      onToast: (t, ms) => showToast(t, ms),
      onComplete: (m, credits, xp, bonus) => {
        gainFlow(320, 'CONTRACT');
        addXp(20);
        checkAchievements();
        showToast('✔ ' + m.name + ' 完成 · +' + credits + ' ¢' + (bonus > 0 ? ' · 余时奖励 +' + bonus : ''), 3800);
        pushFeed('◈ ' + m.name + ' · +' + credits + ' ¢', '#ffd75e');
        net.sendEvent('mission', { n: m.name, c: credits });
      },
      onFail: () => { checkAchievements(); },
    },
  });
  applySkin();
  setLoading(58, '铺设跑酷设施…');
  await nextFrame();
  setLoading(72, '布置光门路线…');
  await nextFrame();
  buildRoutes();
  /* 高空数据芯片：地标与最高楼顶的稀有收集品（10 信用点 / 枚） */
  const chips = [[138, 119.6, -184], [60, 15.7, -157], [-184, 0.8, 138], [93.5, 23.0, 0], [50, 16.0, -160], [150, 60, -150]];
  const tall = world.openCity.buildings.slice().sort((a, b) => b.top - a.top);
  for (let i = 0; i < tall.length && chips.length < 16; i++) {
    const b = tall[i];
    if (b.top < 42) continue;
    chips.push([b.cx, b.top + 1.6, b.cz]);
  }
  for (let i = 0; i < chips.length; i++) createCoin(chips[i][0], chips[i][1], chips[i][2], 'data-' + i, 10);
  world.syncCoins();
  /* 恢复金币收集状态（含路线中段金币） */
  let owned = 0;
  for (let i = 0; i < world.coins.length; i++) {
    if (collectedCoinIds.has(world.coins[i].id)) { world.coins[i].taken = true; owned++; }
  }
  world.syncCoins();
  stats.coins = owned;
  setLoading(86, '校准音乐引擎…');
  await nextFrame();
  setQuality(settings.quality);
  applyTimePreset(settings.timeOfDay || 'morning', true);
  renderTrackList();
  renderLeaderboard();
  setLoading(96, '准备就绪');
  await nextFrame();
  setTimeout(() => {
    setLoading(100, '准备好了');
    setTimeout(() => dom.loading.classList.add('hidden'), 300);
  }, 300);
  requestAnimationFrame((t) => { lastTime = t; loop(t); });
}

boot();

/* 调试接口 */
window.__MIRROR = {
  THREE,
  get physStats() { return world ? world.physStats : null; },
  get P() { return P; }, stats, flow, flowSave, routes, trial, net, music, audio, touch, scene, renderer, composer: gfx.composer, gfx,
  get missions() { return missions; }, get combat() { return combat; }, profile,
  melee: () => tryMelee(),
  /* 测试 / 调试：以固定步长推进模拟，不受渲染帧率影响 */
  step: (n = 60, fixedDt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      if (gameState === 'playing' && !paused) updateGame(fixedDt);
      gfx.update(fixedDt, { P, speed: P ? Math.hypot(P.vel.x, P.vel.z) : 0, damage: 0 });
    }
  },
  applyTimePreset, setQuality, toggleMissions, toggleShop,
  missionAccept: (i) => missions && missions.accept(i),
  get world() { return world; }, startGame, respawn: () => player.respawn(),
  state: () => gameState, isPaused: () => paused,
  teleport: (x, y, z, yaw = 0) => player.teleport(x, y, z, yaw),
  queueInteract: () => player.queueInteract(),
  snap: () => gfx.snap(),
  trialTimes,
};
window.addEventListener('error', (e) => { console.error('[MIRROR]', e.message); });
