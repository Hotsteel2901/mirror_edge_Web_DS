
import { loadJSON, saveJSON, clamp } from './util.js';

/* =========================================================================
   跑者档案 —— 信用点 / 经验 / 技能 / 外观 / 剧情进度 / 每日挑战
   ========================================================================= */

export const SKILLS = [
  { id: 'sprint',  name: '疾风',   icon: '⚡', desc: '冲刺极速 +6%',       max: 3, cost: [140, 320, 680] },
  { id: 'stamina', name: '长息',   icon: '🫁', desc: '体力消耗 −14%',      max: 3, cost: [120, 280, 600] },
  { id: 'roll',    name: '缓冲',   icon: '🌀', desc: '落地翻滚保留更多速度', max: 3, cost: [150, 330, 700] },
  { id: 'magnet',  name: '磁吸',   icon: '🧲', desc: '金币拾取半径 +0.8m',  max: 3, cost: [100, 240, 520] },
  { id: 'vision',  name: '鹰眼',   icon: '👁️', desc: '跑者视觉范围 +18%',   max: 3, cost: [130, 300, 640] },
  { id: 'wallrun', name: '壁虎',   icon: '🧱', desc: '蹬墙跑时长 +0.18s',   max: 3, cost: [160, 360, 760] },
  { id: 'zip',     name: '索道',   icon: '🔗', desc: '滑索速度 +10%',       max: 3, cost: [120, 280, 600] },
];

export const SKINS = [
  { id: 'faith', name: '信使红', color: 0xc21a10, glove: 0x1b1f24, cost: 0 },
  { id: 'pulse', name: '脉冲青', color: 0x2aa9d8, glove: 0x102027, cost: 300 },
  { id: 'ivory', name: '象牙白', color: 0xe9eef1, glove: 0x333a40, cost: 460 },
  { id: 'aurum', name: '赤金',   color: 0xd8a428, glove: 0x231d10, cost: 900 },
  { id: 'void',  name: '夜行',   color: 0x2b2f36, glove: 0x0c0e11, cost: 700 },
  { id: 'jade',  name: '翡翠',   color: 0x2fbf8a, glove: 0x10231c, cost: 620 },
];

const KEY = 'mirrorweb-profile';

const DEFAULT = {
  credits: 0,
  xp: 0,
  level: 1,
  skills: {},
  skins: ['faith'],
  skin: 'faith',
  story: 0,
  missionsDone: [],
  missionHistory: 0,
  daily: { date: '', done: false, score: 0 },
  totalCredits: 0,
};

export const profile = Object.assign({}, DEFAULT, loadJSON(KEY, {}));
profile.skills = Object.assign({}, DEFAULT.skills, profile.skills || {});
profile.skins = Array.isArray(profile.skins) && profile.skins.length ? profile.skins : ['faith'];
if (!profile.skins.includes('faith')) profile.skins.push('faith');
if (!SKINS.some((s) => s.id === profile.skin)) profile.skin = 'faith';

export function saveProfile() {
  saveJSON(KEY, {
    credits: profile.credits,
    xp: profile.xp,
    level: profile.level,
    skills: profile.skills,
    skins: profile.skins,
    skin: profile.skin,
    story: profile.story,
    missionsDone: profile.missionsDone,
    missionHistory: profile.missionHistory,
    daily: profile.daily,
    totalCredits: profile.totalCredits,
  });
}

/* ---------------------------------------------------------------- 经验 */
export function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(110 * Math.pow(level - 1, 1.62));
}
export function levelFromXp(xp) {
  let l = 1;
  while (l < 60 && xp >= xpForLevel(l + 1)) l++;
  return l;
}
export function levelProgress() {
  const cur = xpForLevel(profile.level);
  const next = xpForLevel(profile.level + 1);
  return clamp((profile.xp - cur) / Math.max(1, next - cur), 0, 1);
}
export function addXp(n) {
  if (!n || n < 0) return 0;
  profile.xp += Math.round(n);
  const nl = levelFromXp(profile.xp);
  const gained = nl - profile.level;
  if (gained > 0) {
    profile.level = nl;
    profile.credits += gained * 60;
    profile.totalCredits += gained * 60;
  }
  saveProfile();
  return gained;
}

/* ---------------------------------------------------------------- 信用点 */
export function addCredits(n) {
  if (!n || n <= 0) return;
  profile.credits += Math.round(n);
  profile.totalCredits += Math.round(n);
  saveProfile();
}
export function spendCredits(n) {
  if (profile.credits < n) return false;
  profile.credits -= n;
  saveProfile();
  return true;
}

/* ---------------------------------------------------------------- 技能 */
export function skillLevel(id) { return clamp(profile.skills[id] || 0, 0, 3); }
export function skillCost(id) {
  const def = SKILLS.find((s) => s.id === id);
  if (!def) return Infinity;
  const lv = skillLevel(id);
  if (lv >= def.max) return Infinity;
  return def.cost[lv];
}
export function buySkill(id) {
  const def = SKILLS.find((s) => s.id === id);
  if (!def) return { ok: false, reason: '未知技能' };
  const lv = skillLevel(id);
  if (lv >= def.max) return { ok: false, reason: '已满级' };
  const cost = def.cost[lv];
  if (profile.credits < cost) return { ok: false, reason: '还差 ' + (cost - profile.credits) + ' 信用点' };
  profile.credits -= cost;
  profile.skills[id] = lv + 1;
  saveProfile();
  return { ok: true, level: lv + 1, cost };
}

/* 便捷效果查询（0 级时为基准值） */
export const skillEffect = {
  sprintMult: () => 1 + skillLevel('sprint') * 0.06,
  staminaMult: () => 1 - skillLevel('stamina') * 0.14,
  rollKeep: () => 0.94 + skillLevel('roll') * 0.012,
  coinRadius: () => 2.0 + skillLevel('magnet') * 0.8,
  visionRange: () => 1 + skillLevel('vision') * 0.18,
  wallrunTime: () => 1.6 + skillLevel('wallrun') * 0.18,
  zipSpeed: () => 1 + skillLevel('zip') * 0.10,
};

/* ---------------------------------------------------------------- 外观 */
export function skinDef(id = profile.skin) {
  return SKINS.find((s) => s.id === id) || SKINS[0];
}
export function buySkin(id) {
  const def = SKINS.find((s) => s.id === id);
  if (!def) return { ok: false, reason: '未知外观' };
  if (profile.skins.includes(id)) return { ok: false, reason: '已拥有' };
  if (profile.credits < def.cost) return { ok: false, reason: '还差 ' + (def.cost - profile.credits) + ' 信用点' };
  profile.credits -= def.cost;
  profile.skins.push(id);
  profile.skin = id;
  saveProfile();
  return { ok: true };
}
export function equipSkin(id) {
  if (!profile.skins.includes(id)) return false;
  profile.skin = id;
  saveProfile();
  return true;
}

/* ---------------------------------------------------------------- 每日挑战 */
export function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function dailySeed() {
  const s = todayKey();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) || 1;
}
export function dailyInfo() {
  if (profile.daily.date !== todayKey()) {
    profile.daily = { date: todayKey(), done: false, score: 0 };
    saveProfile();
  }
  return profile.daily;
}
export function completeDaily(score, reward) {
  const d = dailyInfo();
  if (d.done) return false;
  d.done = true;
  d.score = Math.round(score);
  addCredits(reward);
  addXp(180);
  saveProfile();
  return true;
}

/* ---------------------------------------------------------------- 剧情 */
export function markMissionDone(id) {
  if (!profile.missionsDone.includes(id)) profile.missionsDone.push(id);
  profile.missionHistory++;
  saveProfile();
}
export function advanceStory(step) {
  if (step > profile.story) { profile.story = step; saveProfile(); }
}

export function rankName(level = profile.level) {
  if (level >= 18) return '传奇跑者';
  if (level >= 14) return '城市幽灵';
  if (level >= 10) return '资深信使';
  if (level >= 6) return '信使';
  if (level >= 3) return '见习跑者';
  return '街头新人';
}
