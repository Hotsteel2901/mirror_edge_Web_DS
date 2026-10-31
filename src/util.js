import * as THREE from '../vendor/three.module.js';

/* =========================================================================
   通用工具 / 常量 / 设置持久化
   ========================================================================= */

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = THREE.MathUtils.lerp;
export const damp = THREE.MathUtils.damp;

export function dampAngle(a, b, lambda, dt) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}

export function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export function rand(a = 1, b) { return b === undefined ? Math.random() * a : a + Math.random() * (b - a); }
export function randi(a, b) { return Math.floor(rand(a, b + 1)); }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

/* 稳定哈希：用于程序化世界的确定性伪随机 */
export function hash2(i, j) {
  let n = (i * 374761393 + j * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

export function makeCanvas(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/* 物理 / 手感常量（镜之边缘风格：更快、更顺、更连贯） */
export const PHYS = {
  GRAVITY: 23,
  PLAYER_RADIUS: 0.38,
  PLAYER_HEIGHT: 1.8,
  EYE_HEIGHT: 1.62,
  WALK_SPEED: 7.2,
  SPRINT_SPEED: 11.6,
  CROUCH_SPEED: 3.6,
  JUMP_VEL: 10.0,
  COYOTE: 0.13,
  JUMP_BUFFER: 0.15,
  FATAL_IMPACT: 27,
  STREET_Y: 1.0,
  WALLRUN_COOLDOWN: 0.32,
  WALLRUN_GRAVITY: 5.2,   /* 蹬墙跑时的专属重力（远小于 GRAVITY，形成贴墙滑行感） */
  AUTO_STEP_MAX: 0.38,    /* 无需翻越即可自动迈上的最大高度 */
};

/* 本地存储 */
export function loadJSON(key, def) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return def;
    return JSON.parse(raw);
  } catch (e) { return def; }
}
export function saveJSON(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* quota */ }
}

/* 设置（与旧版键名兼容） */
export const settings = {
  sens: 1.0,
  fov: 80,
  quality: 'high',
  volume: 0.8,
  musicVolume: 0.42,
  musicOn: true,
  ghost: true,
  rt: 'low',
  timeOfDay: 'morning',
  net: true,
  name: '',
  room: 'white-city',
};
try { Object.assign(settings, loadJSON('mirrorweb-settings', {})); } catch (e) { /* ignore */ }
export function saveSettings() { saveJSON('mirrorweb-settings', settings); }

export function sanitizeText(s, max = 12) {
  return String(s || '')
    .replace(/[<>&"'`\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
