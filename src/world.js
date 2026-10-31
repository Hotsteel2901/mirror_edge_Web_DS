import * as THREE from '../vendor/three.module.js';
import { mergeGeometries } from '../vendor/addons/utils/BufferGeometryUtils.js';
import { clamp, rand, randi, hash2, mulberry32, makeCanvas, PHYS } from './util.js';
import { applyWorldUV, makeBumpTexture } from './matfx.js';

/* =========================================================================
   开放世界构建 —— 全面对标《镜之边缘》原版城市
   ------------------------------------------------------------------------
   依据原版文献与截图还原：
   · 真实街道峡谷（14-18m 车行道 + 黄色中线 + 斑马线），街区内部小巷 3-5m
   · 三种原版立面：小窗网格 / 横向带窗 / 深色玻璃幕墙；白混凝土为主，
     整栋橙 / 蓝 / 黄彩色楼点缀
   · 屋顶：成排冷却塔（圆形风扇）、空调机组、格栅风管、烟囱蒸汽、水塔、
     通信塔（碟形天线）、屋顶大字招牌、广告牌、细杆吊臂、管道桥
   · 白色女儿墙 + 栏杆；红色只属于跑者视觉 / 可互动物件
   · 地标：The Shard 摩天楼、高架路、海湾码头（橙色集装箱 + 龙门吊）、
     施工区（围挡 + 集装箱 + 塔吊 + 圆井）、雾中远景天际线、巡逻直升机
   性能：实例化立面 / 屋顶、几何合批、空间哈希碰撞网格
   ========================================================================= */

const PITCH = 46;
const N = 15;
const HALF = (N - 1) * PITCH / 2;
const BAY_Z = 258;
const HIGHWAY_Z = -161;
const HIGHWAY_Y = 15;

/* ------------------------------------------------------------------ 网格 */
export class SpatialHash {
  constructor(cellSize = 14) {
    this.size = cellSize;
    this.map = new Map();
  }
  key(ix, iz) { return (ix + 4096) * 8192 + (iz + 4096); }
  insert(b) {
    const c = this.size;
    const x0 = Math.floor(b.min.x / c), x1 = Math.floor(b.max.x / c);
    const z0 = Math.floor(b.min.z / c), z1 = Math.floor(b.max.z / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const k = this.key(ix, iz);
        let arr = this.map.get(k);
        if (!arr) { arr = []; this.map.set(k, arr); }
        arr.push(b);
      }
    }
  }
  cell(ix, iz) { return this.map.get(this.key(ix, iz)); }
}

/* --------------------------------------------------------------- 合批器 */
/* 合批用的临时对象（避免每次调用都分配 Matrix4 / Euler） */
const _bMat = new THREE.Matrix4();
const _bEuler = new THREE.Euler();

class Batcher {
  constructor(scene) {
    this.scene = scene;
    this.groups = new Map();
  }
  add(geo, mat, matrix) {
    let g = this.groups.get(mat);
    if (!g) { g = []; this.groups.set(mat, g); }
    /* 调用方传入的几何体均为一次性新建，直接就地变换入批，省去 clone 分配 */
    geo.applyMatrix4(matrix);
    g.push(geo);
  }
  box(w, h, d, x, y, z, mat, ry = 0) {
    _bMat.makeRotationY(ry);
    _bMat.setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), mat, _bMat);
  }
  boxR(w, h, d, x, y, z, mat, rx = 0, ry = 0, rz = 0) {
    _bMat.makeRotationFromEuler(_bEuler.set(rx, ry, rz, 'YXZ'));
    _bMat.setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), mat, _bMat);
  }
  cyl(rt, rb, h, seg, x, y, z, mat, rx = 0, ry = 0, rz = 0) {
    _bMat.makeRotationFromEuler(_bEuler.set(rx, ry, rz));
    _bMat.setPosition(x, y, z);
    this.add(new THREE.CylinderGeometry(rt, rb, h, seg), mat, _bMat);
  }
  plane(w, h, x, y, z, mat, rx = -Math.PI / 2, ry = 0) {
    _bMat.makeRotationFromEuler(_bEuler.set(rx, ry, 0, 'YXZ'));
    _bMat.setPosition(x, y, z);
    this.add(new THREE.PlaneGeometry(w, h), mat, _bMat);
  }
  flush(shadows = true) {
    for (const [mat, geos] of this.groups) {
      if (!geos.length) continue;
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
    }
    this.groups.clear();
  }
}

/* ---------------------------------------------------------------- 纹理 */
/* 原版立面 A：小窗网格（混凝土 + 密集小方窗） */
function facadeGridTex(variant, accentHex) {
  const seed = mulberry32(7001 + variant * 331);
  return makeCanvas(512, 512, (g, w, h) => {
    g.scale(2, 2);
    w = 256; h = 256;
    const base = g.createLinearGradient(0, 0, 0, h);
    if (accentHex) {
      base.addColorStop(0, accentHex);
      base.addColorStop(1, shade(accentHex, -0.14));
    } else {
      base.addColorStop(0, '#e4eaee');
      base.addColorStop(0.7, '#cdd7dd');
      base.addColorStop(1, '#b3c0c8');
    }
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    if (accentHex) {
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(0, 0, w, 26);
    }
    /* 混凝土板缝 */
    g.strokeStyle = 'rgba(120,134,142,0.22)';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    /* 密集小窗 */
    const cols = 9, rows = 12;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = i * (w / cols) + 4;
        const y = j * (h / rows) + 3.5;
        const ww = w / cols - 8;
        const wh = h / rows - 7;
        const lit = seed() < 0.12;
        g.fillStyle = lit ? (seed() < 0.6 ? 'rgba(255,233,183,0.9)' : 'rgba(196,232,255,0.85)') : (seed() < 0.5 ? '#5d7382' : '#4a6474');
        g.fillRect(x, y, ww, wh);
        g.fillStyle = '#eef2f4';
        g.fillRect(x - 3, y - 4, ww + 6, 4);
        g.fillRect(x - 3, y + wh, ww + 6, 4);
        g.fillStyle = 'rgba(80,95,105,0.35)';
        g.fillRect(x - 3, y + wh + 4, ww + 6, 3);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(x + ww * 0.45, y, ww * 0.1, wh);
      }
    }
    /* 底部污渍 */
    g.fillStyle = 'rgba(56,72,82,0.22)';
    g.fillRect(0, h - 26, w, 26);
  });
}

/* 原版立面 B：横向带窗（白色楼板 + 深色窗带） */
function facadeRibbonTex(variant, accentHex) {
  const seed = mulberry32(9001 + variant * 131);
  return makeCanvas(512, 512, (g, w, h) => {
    g.scale(2, 2);
    w = 256; h = 256;
    g.fillStyle = accentHex || '#eef2f4';
    g.fillRect(0, 0, w, h);
    const bands = 5;
    for (let b = 0; b < bands; b++) {
      const y = b * (h / bands);
      const wh = h / bands * 0.52;
      g.fillStyle = accentHex ? shade(accentHex, -0.32) : '#5f7686';
      g.fillRect(0, y + wh * 0.55, w, wh);
      /* 玻璃反光 */
      g.globalAlpha = 0.2;
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.moveTo(0, y + wh * 1.55);
      g.lineTo(w * (0.2 + seed() * 0.4), y + wh * 0.55);
      g.lineTo(w * (0.42 + seed() * 0.4), y + wh * 0.55);
      g.lineTo(0, y + wh * 1.9);
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
      /* 白楼板 + 竖挺 */
      g.fillStyle = accentHex ? shade(accentHex, 0.08) : '#e8eef1';
      g.fillRect(0, y, w, wh * 0.55);
      for (let i = 0; i < 8; i++) {
        g.fillRect(i * (w / 8), y + wh * 0.55, 3, wh);
      }
      /* 个别亮窗 */
      if (seed() < 0.5) {
        g.fillStyle = 'rgba(255,236,190,0.65)';
        g.fillRect(Math.floor(seed() * 7) * (w / 8) + 4, y + wh * 0.62, w / 8 - 8, wh * 0.8);
      }
    }
    g.fillStyle = 'rgba(70,88,98,0.12)';
    g.fillRect(0, h - 16, w, 16);
  });
}

/* 原版立面 C：深色玻璃幕墙 */
function facadeGlassTex(variant, accentHex) {
  const seed = mulberry32(11003 + variant * 173);
  return makeCanvas(512, 512, (g, w, h) => {
    g.scale(2, 2);
    w = 256; h = 256;
    const base = g.createLinearGradient(0, 0, w, h);
    base.addColorStop(0, accentHex ? shade(accentHex, -0.1) : '#5d7686');
    base.addColorStop(0.5, accentHex ? shade(accentHex, 0.05) : '#718d9d');
    base.addColorStop(1, accentHex ? shade(accentHex, -0.22) : '#4d6472');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    /* 云影与太阳反光 */
    g.globalAlpha = 0.16;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.ellipse(seed() * w, seed() * h, 30 + seed() * 50, 12 + seed() * 24, seed() * 0.7 - 0.35, 0, 7);
      g.fill();
    }
    g.globalAlpha = 1;
    /* 幕墙分格：远处也能读出楼层的横向楼板 + 竖向竖挺 */
    g.strokeStyle = 'rgba(244,249,251,0.62)';
    g.lineWidth = 1;
    for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); }
    for (let y = 0; y <= h; y += 42) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    /* 每两层一道加粗楼板：玻璃塔在远处最关键的识别特征 */
    g.fillStyle = 'rgba(250,252,253,0.78)';
    for (let y = 0; y <= h; y += 84) g.fillRect(0, y - 1, w, 5);
    /* 角柱 / 竖挺加密 */
    g.fillStyle = 'rgba(255,255,255,0.3)';
    for (let x = 0; x <= w; x += 64) g.fillRect(x - 1, 0, 3, h);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(0, 0, w, 3);
  });
}

function shade(hex, amt) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, clamp(hsl.l + amt, 0, 1));
  return '#' + c.getHexString();
}

function roofCanvas() {
  return makeCanvas(256, 256, (g) => {
    g.fillStyle = '#dde2e4';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(96,110,120,0.75)';
    g.lineWidth = 2;
    for (let i = 0; i <= 256; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(${randi(110, 185)},${randi(120, 190)},${randi(130, 195)},${rand(0.06, 0.18)})`;
      g.fillRect(rand(256), rand(256), rand(1, 4), rand(1, 4));
    }
    /* 大块污渍 / 补丁：让屋顶在远处也有可读的明暗层次 */
    for (let i = 0; i < 10; i++) {
      g.fillStyle = `rgba(110,124,132,${rand(0.03, 0.07)})`;
      g.beginPath();
      g.ellipse(rand(256), rand(256), rand(18, 60), rand(12, 40), rand(6.28), 0, 7);
      g.fill();
    }
  });
}


/* 店面橱窗：深色玻璃 + 白色竖挺 + 暖色内光 + 玻璃反光，按世界米制铺贴 */
function shopfrontCanvas(emissive) {
  return makeCanvas(256, 128, (g) => {
    if (emissive) {
      g.fillStyle = '#000000';
      g.fillRect(0, 0, 256, 128);
    } else {
      const base = g.createLinearGradient(0, 0, 0, 128);
      base.addColorStop(0, '#2b3d4a');
      base.addColorStop(0.55, '#1b2b36');
      base.addColorStop(1, '#243440');
      g.fillStyle = base;
      g.fillRect(0, 0, 256, 128);
    }
    const panes = 4, pw = 256 / panes;
    for (let i = 0; i < panes; i++) {
      const x = i * pw;
      const lit = (i * 37 + 11) % 5 === 0;
      if (lit) {
        if (emissive) {
          const gl = g.createLinearGradient(x, 20, x, 118);
          gl.addColorStop(0, 'rgba(255,214,150,0.95)');
          gl.addColorStop(0.55, 'rgba(255,196,120,0.75)');
          gl.addColorStop(1, 'rgba(180,120,60,0.35)');
          g.fillStyle = gl;
          g.fillRect(x + 4, 20, pw - 8, 98);
        } else {
          const gl = g.createLinearGradient(x, 20, x, 118);
          gl.addColorStop(0, 'rgba(255,222,170,0.55)');
          gl.addColorStop(0.6, 'rgba(240,200,150,0.32)');
          gl.addColorStop(1, 'rgba(90,80,70,0.2)');
          g.fillStyle = gl;
          g.fillRect(x + 4, 20, pw - 8, 98);
        }
      }
      if (!emissive) {
        g.globalAlpha = 0.16;
        g.fillStyle = '#ffffff';
        g.beginPath();
        g.moveTo(x + 6, 128);
        g.lineTo(x + pw * 0.62, 18);
        g.lineTo(x + pw * 0.82, 18);
        g.lineTo(x + 6 + pw * 0.3, 128);
        g.closePath();
        g.fill();
        g.globalAlpha = 1;
      }
    }
    g.fillStyle = emissive ? '#000000' : '#e6ebee';
    for (let i = 0; i <= panes; i++) g.fillRect(i * pw - 2, 0, 4, 128);
    if (emissive) {
      g.fillStyle = 'rgba(255,240,210,0.12)';
      g.fillRect(0, 18, 256, 3);
    } else {
      g.fillRect(0, 14, 256, 5);
      g.fillRect(0, 118, 256, 10);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(0, 19, 256, 2);
    }
  });
}

/* 冷却塔顶部：深色圆形风扇（原版标志性屋顶元素） */
function fanCanvas() {
  return makeCanvas(128, 128, (g) => {
    g.fillStyle = '#b9c1c6';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#2c3439';
    g.beginPath(); g.arc(64, 64, 52, 0, 7); g.fill();
    g.strokeStyle = '#4d585f';
    g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 52, 0, 7); g.stroke();
    g.fillStyle = '#1d2429';
    for (let i = 0; i < 4; i++) {
      g.save();
      g.translate(64, 64);
      g.rotate(i * Math.PI / 2 + 0.5);
      g.beginPath();
      g.moveTo(0, -6);
      g.lineTo(46, -16);
      g.lineTo(46, 16);
      g.lineTo(0, 6);
      g.closePath();
      g.fill();
      g.restore();
    }
    g.fillStyle = '#5c666d';
    g.beginPath(); g.arc(64, 64, 10, 0, 7); g.fill();
  });
}

function grilleCanvas() {
  return makeCanvas(128, 128, (g) => {
    g.fillStyle = '#c3ccd1';
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(60,72,80,0.55)';
    for (let y = 8; y < 128; y += 12) g.fillRect(8, y, 112, 4);
    g.strokeStyle = 'rgba(90,104,112,0.6)';
    g.lineWidth = 3;
    g.strokeRect(3, 3, 122, 122);
  });
}

function corrugateCanvas() {
  return makeCanvas(128, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 128, 128);
    for (let x = 0; x < 128; x += 16) {
      g.fillStyle = 'rgba(0,0,0,0.16)';
      g.fillRect(x, 0, 5, 128);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(x + 8, 0, 3, 128);
    }
    g.fillStyle = 'rgba(0,0,0,0.24)';
    g.fillRect(0, 0, 128, 6);
    g.fillRect(0, 122, 128, 6);
  });
}

function runnerCanvas() {
  return makeCanvas(256, 256, (g) => {
    g.fillStyle = '#e02318';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(255,255,255,0.82)';
    g.lineWidth = 7;
    for (let i = -1; i < 4; i++) {
      g.beginPath();
      g.moveTo(30 + i * 66, 256);
      g.lineTo(96 + i * 66, 0);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,70,50,0.28)';
    g.fillRect(0, 0, 256, 256);
  });
}

function stripeCanvas() {
  return makeCanvas(256, 256, (g) => {
    g.fillStyle = '#f3f6f7';
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#e88a1e';
    for (let y = -256; y < 512; y += 80) {
      g.beginPath();
      g.moveTo(0, y); g.lineTo(256, y + 128);
      g.lineTo(256, y + 168); g.lineTo(0, y + 40);
      g.closePath();
      g.fill();
    }
  });
}

function hazardCanvas() {
  return makeCanvas(256, 128, (g) => {
    g.fillStyle = '#f4c53a';
    g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#23282c';
    for (let x = -128; x < 512; x += 80) {
      g.beginPath();
      g.moveTo(x, 0); g.lineTo(x + 40, 0);
      g.lineTo(x + 80, 128); g.lineTo(x + 40, 128);
      g.closePath();
      g.fill();
    }
  });
}

function arrowCanvas() {
  return makeCanvas(128, 128, (g) => {
    g.clearRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(230,30,20,0.96)';
    g.beginPath();
    g.moveTo(23, 24);
    g.lineTo(90, 64);
    g.lineTo(23, 104);
    g.lineTo(23, 77);
    g.lineTo(5, 77);
    g.lineTo(5, 51);
    g.lineTo(23, 51);
    g.closePath();
    g.fill();
  });
}

function cloudCanvas() {
  return makeCanvas(256, 128, (g) => {
    g.clearRect(0, 0, 256, 128);
    for (let i = 0; i < 16; i++) {
      const x = rand(36, 220), y = rand(46, 82), r = rand(14, 30);
      const grd = g.createRadialGradient(x, y, 2, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.94)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
}

function softCanvas() {
  return makeCanvas(64, 64, (g) => {
    const grd = g.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(255,255,255,0.85)');
    grd.addColorStop(0.5, 'rgba(240,244,246,0.4)');
    grd.addColorStop(1, 'rgba(240,244,246,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
  });
}

function birdCanvas() {
  return makeCanvas(64, 32, (g) => {
    g.clearRect(0, 0, 64, 32);
    g.strokeStyle = 'rgba(40,52,62,0.9)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(4, 20); g.quadraticCurveTo(16, 6, 32, 18);
    g.quadraticCurveTo(48, 6, 60, 20);
    g.stroke();
  });
}

function heliCanvas() {
  return makeCanvas(256, 256, (g) => {
    g.fillStyle = '#89949a';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#f4c53a';
    g.lineWidth = 14;
    g.beginPath(); g.arc(128, 128, 88, 0, 7); g.stroke();
    g.fillStyle = '#f4c53a';
    g.font = 'bold 120px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('H', 128, 136);
  });
}

/* 原版风格广告：亮黄 / 橙 / 蓝底 + 粗体大字 + 圆形图形 */
function adCanvas(seed, hex) {
  return makeCanvas(256, 160, (g) => {
    const r = mulberry32(seed);
    const words = ['VEGADE+', 'NICAix', 'RAPOSA', 'CITY NEWS', 'DAILY CITY', 'PK', 'SHIPPING', 'MONO', 'ARIA', 'FLOW', 'BIG 08', 'URBS'];
    g.fillStyle = hex;
    g.fillRect(0, 0, 256, 160);
    g.fillStyle = 'rgba(255,255,255,0.85)';
    const mark = r();
    if (mark < 0.4) { g.beginPath(); g.arc(48, 80, 34, 0, 7); g.fill(); }
    else if (mark < 0.7) { g.beginPath(); g.moveTo(14, 120); g.lineTo(58, 40); g.lineTo(102, 120); g.closePath(); g.fill(); }
    else { g.fillRect(18, 46, 68, 68); }
    g.fillStyle = 'rgba(255,255,255,0.16)';
    g.fillRect(0, 0, 256, 24);
    g.fillStyle = '#101619';
    g.font = `bold ${34 + Math.floor(r() * 16)}px "Arial Black", "Segoe UI", sans-serif`;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillText(words[Math.floor(r() * words.length)], 244, 84);
    g.font = 'bold 18px "Segoe UI", sans-serif';
    g.fillStyle = 'rgba(16,22,25,0.7)';
    g.fillText(['Your 5-a-day', 'Nutrition', 'Every day', 'Logistics'][Math.floor(r() * 4)], 244, 132);
  });
}

/* 屋顶大字招牌 */
function signCanvas(text, bgHex, fgHex) {
  return makeCanvas(512, 128, (g) => {
    g.fillStyle = bgHex;
    g.fillRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(0, 0, 512, 16);
    g.fillStyle = fgHex;
    g.font = 'bold 72px "Arial Black", "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 256, 70);
  });
}

/* 地面：真实街道 / 人行道 / 黄色中线 / 斑马线 / 广场 / 海湾 */
function groundCanvas(blocks, corridor) {
  return makeCanvas(2048, 2048, (g) => {
    const S = 2048 / 1100; // 世界米 → 像素
    const px = (wx) => (wx + 550) * S;
    g.fillStyle = '#3d444b';
    g.fillRect(0, 0, 2048, 2048);
    /* 沥青噪点 */
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = `rgba(${randi(40, 90)},${randi(46, 96)},${randi(52, 104)},0.25)`;
      g.fillRect(rand(2048), rand(2048), rand(1, 3), rand(1, 3));
    }
    /* 人行道 + 街区底板 */
    for (const b of blocks) {
      g.fillStyle = '#9aa3a9';
      g.fillRect(px(b.x0 - 1.4), px(b.z0 - 1.4), (b.x1 - b.x0 + 2.8) * S, (b.z1 - b.z0 + 2.8) * S);
      g.fillStyle = '#59616a';
      g.fillRect(px(b.x0), px(b.z0), (b.x1 - b.x0) * S, (b.z1 - b.z0) * S);
    }
    /* 教学区广场 */
    g.fillStyle = '#a7afb4';
    g.fillRect(px(corridor.x0), px(corridor.z0), (corridor.x1 - corridor.x0) * S, (corridor.z1 - corridor.z0) * S);
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 1;
    for (let x = corridor.x0; x < corridor.x1; x += 14) {
      g.beginPath(); g.moveTo(px(x), px(corridor.z0)); g.lineTo(px(x), px(corridor.z1)); g.stroke();
    }
    /* 海湾 */
    g.fillStyle = '#2f6b93';
    g.fillRect(0, px(BAY_Z), 2048, 2048 - px(BAY_Z));
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 2;
    for (let y = BAY_Z + 10; y < 540; y += 22) {
      g.beginPath(); g.moveTo(0, px(y)); g.lineTo(2048, px(y)); g.stroke();
    }
  });
}

/* 粒子爆发 */
class Burst {
  constructor(scene, pos, color, count = 24, opts = {}) {
    this.age = 0;
    this.life = opts.life || 0.55;
    this.count = count;
    this.gravity = opts.gravity !== undefined ? opts.gravity : 7;
    this.drag = opts.drag !== undefined ? opts.drag : 1.6;
    this.spread = opts.spread || 2.2;
    this.upBias = opts.upBias || 1.2;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.positions[i * 3] = pos.x;
      this.positions[i * 3 + 1] = pos.y;
      this.positions[i * 3 + 2] = pos.z;
      const a = rand(Math.PI * 2);
      const sp = rand(0.3, 1) * this.spread;
      this.velocities[i * 3] = Math.cos(a) * sp;
      this.velocities[i * 3 + 1] = rand(0.2, 1) * this.spread * this.upBias;
      this.velocities[i * 3 + 2] = Math.sin(a) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mat = new THREE.PointsMaterial({
      color, size: opts.size || 0.13, transparent: true, opacity: 0.85,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.layers.set(1);
    scene.add(this.points);
  }
  update(dt) {
    this.age += dt;
    const k = clamp(1 - this.age / this.life, 0, 1);
    this.mat.opacity = 0.85 * k * k;
    const d = Math.exp(-this.drag * dt);
    for (let i = 0; i < this.count; i++) {
      this.velocities[i * 3 + 1] -= this.gravity * dt;
      this.velocities[i * 3] *= d;
      this.velocities[i * 3 + 1] *= d;
      this.velocities[i * 3 + 2] *= d;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    return this.age < this.life;
  }
  dispose(scene) {
    scene.remove(this.points);
    this.points.geometry.dispose();
    this.mat.dispose();
  }
}

/* ===================================================================== */
/* 让出主线程一帧：既保证加载条能真正刷新，也避免长时间占满主线程造成卡死 */
function yieldFrame() {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fin);
    setTimeout(fin, 60);
  });
}

export async function buildWorld(scene, progress = () => {}) {
  const world = {
    scene,
    colliders: [],
    zones: [],
    climbs: [],
    zips: [],
    highlight: [],
    pulseMats: [],
    districts: [],
    openCity: { buildings: [] },
    coins: [],
    coinMesh: null,
    bursts: [],
    spawnPoint: { x: 1.5, y: 18.04, z: 0, yaw: -Math.PI / 2 },
    quality: 'high',
  };
  const grid = new SpatialHash(14);
  world.grid = grid;
  const batcher = new Batcher(scene);

  /* 金币实例矩阵统一写入（复用临时矩阵，避免每帧 new Matrix4） */
  const _coinM = new THREE.Matrix4();
  const _coinZeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  function setCoinInstance(i, x, y, z, spin) {
    if (spin === null) _coinM.copy(_coinZeroM);
    else { _coinM.makeRotationY(spin); _coinM.setPosition(x, y, z); }
    world.coinMesh.setMatrixAt(i, _coinM);
  }

  /* ---------------------------------------------------------- 材质 */
  const roofTex = roofCanvas();
  const runnerTex = runnerCanvas();
  const stripeTex = stripeCanvas();
  const hazardTex = hazardCanvas();
  const arrowTex = arrowCanvas();
  const cloudTex = cloudCanvas();
  const softTex = softCanvas();
  const birdTex = birdCanvas();
  const heliTex = heliCanvas();
  const fanTex = fanCanvas();
  const grilleTex = grilleCanvas();
  const corrugateTex = corrugateCanvas();

  roofTex.anisotropy = 16;
  const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, roughness: 0.92, metalness: 0.04, envMapIntensity: 0.55 });
  /* 屋顶按真实米制铺贴：8m 一块板，不再随楼体缩放拉伸 */
  applyWorldUV(roofMat, { scale: 1 / 8, bump: makeBumpTexture(roofTex, 128), bumpScale: 0.12 });
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeff3f5, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.5 });
  const panelMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.72, metalness: 0.04, envMapIntensity: 0.4 });
  const runnerMat = new THREE.MeshStandardMaterial({ map: runnerTex, color: 0xe0251a, emissive: 0xb01000, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0.06 });
  const runnerMatBright = new THREE.MeshStandardMaterial({ color: 0xf02c1c, emissive: 0xd01400, emissiveIntensity: 0.75, roughness: 0.45, metalness: 0.08 });
  const runnerMatPlain = new THREE.MeshStandardMaterial({ color: 0xe62f20, emissive: 0xa81200, emissiveIntensity: 0.35, roughness: 0.62, metalness: 0.05 });
  const darkTrimMat = new THREE.MeshStandardMaterial({ color: 0x2c363d, roughness: 0.55, metalness: 0.4 });
  const metalSideMat = new THREE.MeshStandardMaterial({ map: grilleTex, roughness: 0.7, metalness: 0.35 });
  const metalTopMat = new THREE.MeshStandardMaterial({ map: fanTex, roughness: 0.7, metalness: 0.3 });
  const acMat = new THREE.MeshStandardMaterial({ map: grilleTex, color: 0xd4dade, roughness: 0.75, metalness: 0.25 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0xcfeaf4, roughness: 0.06, metalness: 0.2, transparent: true, opacity: 0.34 });
  const glassDarkMat = new THREE.MeshStandardMaterial({ color: 0x3d5566, roughness: 0.1, metalness: 0.4 });
  const streetMat = new THREE.MeshStandardMaterial({ color: 0x3d4650, roughness: 0.94, metalness: 0.02 });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x8fae93, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x9fb89d, roughness: 0.95 });
  const concreteMat = new THREE.MeshStandardMaterial({ color: 0xaab3b9, roughness: 0.9 });
  const stripeMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.5 });
  const hazardMat = new THREE.MeshStandardMaterial({ map: hazardTex, roughness: 0.6 });
  const whitePanelMat = new THREE.MeshStandardMaterial({ color: 0xe8edef, roughness: 0.6 });
  const arrowMat = new THREE.MeshStandardMaterial({ map: arrowTex, emissive: 0xff1800, emissiveIntensity: 0.5, roughness: 0.5, transparent: true });
  const flagMat = new THREE.MeshStandardMaterial({ map: runnerTex, color: 0xff3528, emissive: 0xd11400, emissiveIntensity: 0.55, roughness: 0.55, side: THREE.DoubleSide });
  const stripMat = new THREE.MeshStandardMaterial({ color: 0xff2f22, emissive: 0xd11400, emissiveIntensity: 0.7, roughness: 0.5 });
  const orangeMat = new THREE.MeshStandardMaterial({ map: corrugateTex, color: 0xef8527, roughness: 0.6, metalness: 0.15 });
  const blueCrateMat = new THREE.MeshStandardMaterial({ map: corrugateTex, color: 0x2f6fb0, roughness: 0.6, metalness: 0.15 });
  world.pulseMats.push(runnerMat, runnerMatBright, runnerMatPlain, flagMat, stripMat);

  /* 分区（按原版关卡风格） */
  const DISTRICTS = [
    { key: 'DOWNTOWN', name: 'DOWNTOWN 金融城', short: '金融城', accent: 0x2f7fc4, h0: 26, amp: 6, min: 16, max: 46, tower: 0.22, glass: 0.45 },
    { key: 'OLDTOWN', name: 'OLD TOWN 老城', short: '老城', accent: 0xe0a92e, h0: 11, amp: 3, min: 8, max: 18, tower: 0.05, glass: 0.1 },
    { key: 'DOCKS', name: 'DOCKS 码头区', short: '码头区', accent: 0xe8762a, h0: 9, amp: 2.5, min: 6, max: 14, tower: 0.04, glass: 0.15 },
    { key: 'VIEW', name: 'THE VIEW 湾景', short: '湾景', accent: 0x7a6fd0, h0: 17, amp: 5, min: 10, max: 30, tower: 0.12, glass: 0.3 },
    { key: 'GREEN', name: 'GREENFIELD 公园区', short: '公园区', accent: 0x88b394, h0: 13, amp: 4, min: 9, max: 22, tower: 0.08, glass: 0.2 },
    { key: 'MIDTOWN', name: 'MIDTOWN 中城', short: '中城', accent: 0x8fa3b4, h0: 17, amp: 5, min: 10, max: 28, tower: 0.1, glass: 0.25 },
  ];
  for (const d of DISTRICTS) {
    d.color3 = new THREE.Color(d.accent);
    d.mat = new THREE.MeshStandardMaterial({ color: d.accent, roughness: 0.55, metalness: 0.12 });
    d.hex = '#' + d.accent.toString(16).padStart(6, '0');
  }
  world.districts = DISTRICTS;
  for (const d of DISTRICTS) world.pulseMats.push(d.mat);
  function districtAt(cx, cz) {
    if (cz > BAY_Z - 40) return DISTRICTS[2];
    if (cz < -140) return DISTRICTS[3];
    if (cx > 30 && cz > -140) return DISTRICTS[0];
    if (cx < -80 && cz > -140 && cz < 40) return DISTRICTS[1];
    if (cx < -80) return DISTRICTS[4];
    return DISTRICTS[5];
  }
  world.districtAt = districtAt;
  function districtHeight(d, cx, cz) {
    let h = d.h0
      + Math.sin(cx * 0.021 + 1.7) * d.amp
      + Math.cos(cz * 0.019 + 0.6) * d.amp * 0.7
      + Math.sin((cx + cz) * 0.043 + 2.2) * d.amp * 0.35;
    return clamp(Math.round(h * 2) / 2, d.min, d.max);
  }

  /* 立面材质缓存：style|variant|accent */
  const facadeCache = new Map();
  function facadeMat(style, variant, accentHex) {
    const key = `${style}_${variant}_${accentHex || 'n'}`;
    let m = facadeCache.get(key);
    if (!m) {
      let tex;
      if (style === 'ribbon') tex = facadeRibbonTex(variant, accentHex);
      else if (style === 'glass') tex = facadeGlassTex(variant, accentHex);
      else tex = facadeGridTex(variant, accentHex);
      tex.anisotropy = 16;
      m = new THREE.MeshStandardMaterial({ map: tex, roughness: style === 'glass' ? 0.2 : 0.62, metalness: style === 'glass' ? 0.4 : 0.07, envMapIntensity: 0.6 });
      /* 世界空间 UV：窗格尺寸恒定；再用反照率生成凹凸，窗洞在斜阳下有真实进深 */
      applyWorldUV(m, {
        scale: style === 'glass' ? 1 / 18 : style === 'ribbon' ? 1 / 17 : 1 / 19,
        bump: makeBumpTexture(tex, 256),
        bumpScale: style === 'glass' ? 0.1 : 0.38,
      });
      facadeCache.set(key, m);
    }
    return m;
  }
  world.facadeMat = facadeMat;

  /* ------------------------------------------------------- 碰撞体 */
  function addCollider(x0, x1, y0, y1, z0, z1, kind = 'solid', extra = {}) {
    const b = {
      min: new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      max: new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      kind,
      surface: extra.surface || 'concrete',
      __q: 0, __r: 0,
      ...extra,
    };
    world.colliders.push(b);
    if (kind === 'zone') world.zones.push(b);
    else grid.insert(b);
    return b;
  }
  world.addCollider = addCollider;

  function addBoxMesh(x0, x1, y0, y1, z0, z1, materials, opts = {}) {
    const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0), d = Math.abs(z1 - z0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = opts.receiveShadow !== false;
    scene.add(mesh);
    if (opts.collider !== false) addCollider(x0, x1, y0, y1, z0, z1, opts.kind || 'solid', opts.extra || {});
    return mesh;
  }
  world.addBoxMesh = addBoxMesh;

  function registerHighlight(mesh, radius = 9, existingMats = null) {
    const mats = existingMats || (Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : [mesh.material.clone()]);
    if (!existingMats) mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
    mesh.updateMatrixWorld(true);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const center = mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
    const entry = {
      mesh, radius, mats, center,
      base: mats.map((m) => ({
        emissive: (m.emissive || new THREE.Color(0)).clone(),
        intensity: m.emissiveIntensity !== undefined ? m.emissiveIntensity : 0,
      })),
      glow: 0,
    };
    world.highlight.push(entry);
    return entry;
  }
  world.registerHighlight = registerHighlight;

  /* 借助空间哈希只扫描邻近格子：结果与原先全量扫描 world.colliders 完全等价，
     但把建城期的 O(建筑 × 道具 × 碰撞体) 降到接近 O(1)。 */
  function pointInsideProp(x, y, z, pad = 0.25) {
    const c = grid.size;
    const r = Math.max(1, Math.ceil(pad / c));
    const ix = Math.floor(x / c), iz = Math.floor(z / c);
    for (let ax = ix - r; ax <= ix + r; ax++) {
      for (let az = iz - r; az <= iz + r; az++) {
        const cell = grid.cell(ax, az);
        if (!cell) continue;
        for (const b of cell) {
          if (b.kind === 'zone' || b.street || b.building) continue;
      if (b.name === 'parapet') continue;   /* 女儿墙属于楼体本身，不算屋顶道具 */
          if (x >= b.min.x - pad && x <= b.max.x + pad && y >= b.min.y && y <= b.max.y + 0.4 && z >= b.min.z - pad && z <= b.max.z + pad) return true;
        }
      }
    }
    return false;
  }
  world.pointInsideProp = pointInsideProp;

  let ignorePathCheck = false;
  /* 遮挡检测：直线路径是否被实体阻挡（滑索 / 弹簧板弹道用）
     两端各屏蔽 18m —— 起点/终点所在楼体本身不算遮挡，只检查街道中段 */
  function pathBlocked(a, b, steps = 24, ignoreNames = null) {
    if (ignorePathCheck) return false;
    const p = new THREE.Vector3();
    const total = a.distanceTo(b);
    const skip = Math.min(0.42, 18 / Math.max(total, 1));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (t < skip || t > 1 - skip) continue;
      p.lerpVectors(a, b, t);
      const cell = grid.cell(Math.floor(p.x / grid.size), Math.floor(p.z / grid.size));
      if (!cell) continue;
      for (const c of cell) {
        if (c.kind === 'zone' || c.street) continue;
        if (ignoreNames && c.name && ignoreNames.has(c.name)) continue;
        if (p.x > c.min.x - 0.4 && p.x < c.max.x + 0.4 && p.y > c.min.y && p.y < c.max.y + 0.6 && p.z > c.min.z - 0.4 && p.z < c.max.z + 0.4) {
          return true;
        }
      }
    }
    return false;
  }

  /* ---------------------------------------------------------- 地面 */
  const corridor = { x0: -24, x1: 178, z0: -16, z1: 16 };
  world.corridor = corridor;
  /* 地标保留区：不生成普通楼 */
  const RESERVED = [
    { x: 138, z: -184, hw: 18, hd: 18 },  // The Shard
    { x: 92, z: 92, hw: 22, hd: 22 },     // 施工区
    { x: -184, z: 138, hw: 20, hd: 20 },  // 公园广场
  ];
  function reservedOverlap(cx, cz, hw, hd) {
    return RESERVED.some((r) => cx + hw > r.x - r.hw && cx - hw < r.x + r.hw && cz + hd > r.z - r.hd && cz - hd < r.z + r.hd);
  }
  function corridorOverlap(cx, cz, halfW, halfD) {
    return cx + halfW > corridor.x0 - 6 && cx - halfW < corridor.x1 + 6
      && cz + halfD > corridor.z0 - 6 && cz - halfD < corridor.z1 + 6;
  }
  function courseHeightAtX(x) {
    if (x >= -8 && x < 20) return 18;
    if (x >= 27 && x < 44) return 14;
    if (x >= 57 && x < 69) return 12;
    if (x >= 73 && x < 90) return 21;
    if (x >= 97 && x < 116) return 21;
    if (x >= 126 && x < 150) return 8;
    if (x >= 150 && x < 166) return 12;
    return 14;
  }
  world.courseHeightAtX = courseHeightAtX;

  /* ---------------------------------------------------- 天空 / 远景 */
  /* 全局太阳方向（天空、平行光、光轴、大气透视共用同一方向）
     低角度暖阳 → 长阴影 + 强烈的体积光，是镜之边缘最标志性的光 */
  const SUN_DIR = new THREE.Vector3(-0.42, 0.40, 0.62).normalize();
  world.sunDir = SUN_DIR;

  const skyUniforms = {
    uZenith: { value: new THREE.Color(0x2f6cb4) },
    uHorizon: { value: new THREE.Color(0xd7e9f4) },
    uGround: { value: new THREE.Color(0xb9c8d2) },
    uSunColor: { value: new THREE.Color(0xfff0cf) },
    uSunDir: { value: SUN_DIR.clone() },
    uTime: { value: 0 },
    uCloud: { value: 1 },
    uCloudCover: { value: 0.52 },
  };
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uTime;
      uniform float uCloud;
      uniform float uCloudCover;

      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) {
          s += a * vnoise(p);
          p = p * 2.03 + vec2(17.3, 9.1);
          a *= 0.5;
        }
        return s;
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.46));
        if (h < 0.0) col = mix(uHorizon, uGround, smoothstep(0.0, -0.16, h));

        float cosT = max(dot(d, uSunDir), 0.0);
        /* 米氏散射：太阳周围的暖色光晕 */
        col += uSunColor * pow(cosT, 6.0) * 0.20;
        col += uSunColor * pow(cosT, 42.0) * 0.55;
        /* 太阳圆盘 */
        col += uSunColor * smoothstep(0.99955, 0.99985, cosT) * 14.0;

        /* 卷云：只在天空上半部分，靠近地平线逐渐淡出 */
        if (uCloud > 0.5 && h > 0.012) {
          vec2 cuv = d.xz / (h + 0.14);
          float drift = uTime * 0.0045;
          float c = fbm(cuv * 0.62 + vec2(drift, drift * 0.45));
          c += 0.35 * fbm(cuv * 1.7 - vec2(drift * 1.7, 0.0));
          c = smoothstep(uCloudCover, uCloudCover + 0.34, c * 0.78);
          c *= smoothstep(0.012, 0.22, h);
          vec3 lit = mix(vec3(0.72, 0.78, 0.86), vec3(1.02, 1.0, 0.96) * (0.8 + uSunColor.r * 0.6), 0.45);
          lit += uSunColor * pow(cosT, 3.0) * 0.22;
          col = mix(col, lit, c * 0.62);
        }

        /* 地平线下方的一圈薄雾，让远景楼群有落点 */
        col += uHorizon * 0.12 * exp(-abs(h) * 22.0);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  world.skyMat = skyMat;
  world.skyUniforms = skyUniforms;
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1800, 40, 22), skyMat));

  /* 云层由天空着色器程序化生成（卷云），不再使用精灵贴片 */
  /* 远景天际线（雾中高塔剪影） */
  {
    /* 三层天际线：近层密集低矮、远层稀疏高耸，配合大气透视形成真实的城市纵深 */
    const rings = [
      { cnt: 170, r0: 640, r1: 820, h0: 22, h1: 78, w0: 16, w1: 42, tint: 0.72 },
      { cnt: 140, r0: 900, r1: 1180, h0: 40, h1: 138, w0: 22, w1: 54, tint: 0.82 },
      { cnt: 90, r0: 1280, r1: 1650, h0: 60, h1: 205, w0: 26, w1: 64, tint: 0.9 },
    ];
    const mat = new THREE.MeshStandardMaterial({ color: 0x839db4, roughness: 0.95, metalness: 0.02, fog: true });
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    for (const ring of rings) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, ring.cnt);
      for (let i = 0; i < ring.cnt; i++) {
        const a = (i / ring.cnt) * Math.PI * 2 + rand(-0.035, 0.035);
        const r = rand(ring.r0, ring.r1);
        const h = rand(ring.h0, ring.h1);
        const w = rand(ring.w0, ring.w1), d = rand(ring.w0, ring.w1);
        m.makeScale(w, h, d);
        m.setPosition(Math.cos(a) * r, h / 2, Math.sin(a) * r);
        inst.setMatrixAt(i, m);
        const t = rand(ring.tint - 0.06, ring.tint + 0.05);
        col.setRGB(t * 0.94, t * 0.99, t * 1.04);
        inst.setColorAt(i, col);
      }
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = false;
      inst.receiveShadow = false;
      scene.add(inst);
      /* 部分超高层加天线尖塔，打破纯方块天际线 */
      const spireMat = new THREE.MeshStandardMaterial({ color: 0x8fa5b8, roughness: 0.8, metalness: 0.2 });
      const spires = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.9, 1.6, 1, 6), spireMat, Math.ceil(ring.cnt * 0.22));
      let si = 0;
      for (let i = 0; i < ring.cnt && si < spires.count; i++) {
        if (hash2(i + ring.cnt, ring.r0) > 0.22) continue;
        const a2 = (i / ring.cnt) * Math.PI * 2;
        const r2 = ring.r0 + (ring.r1 - ring.r0) * hash2(i + 3, ring.r0 + 7);
        const h2 = ring.h0 + (ring.h1 - ring.h0) * hash2(i + 11, ring.r1 + 5);
        const sh = 12 + hash2(i + 17, ring.r0 + 13) * 34;
        m.makeScale(1, sh, 1);
        m.setPosition(Math.cos(a2) * r2, h2 + sh / 2, Math.sin(a2) * r2);
        spires.setMatrixAt(si++, m);
      }
      spires.count = si;
      spires.instanceMatrix.needsUpdate = true;
      spires.frustumCulled = false;
      scene.add(spires);
    }
  }

  /* 远处飞鸟 */
  const birds = [];
  const flocks = [];
  for (let f = 0; f < 3; f++) {
    const flock = new THREE.Group();
    const cx = rand(-200, 300), cz = rand(-200, 200), cy = rand(60, 110);
    flock.position.set(cx, cy, cz);
    for (let i = 0; i < 7; i++) {
      const b = new THREE.Sprite(new THREE.SpriteMaterial({ map: birdTex, transparent: true, opacity: 0.75, depthWrite: false }));
      b.layers.set(1);
      b.position.set(rand(-8, 8), rand(-2, 2), rand(-8, 8));
      flock.add(b);
      birds.push({ sprite: b, phase: rand(6.28) });
    }
    scene.add(flock);
    flocks.push({ group: flock, cx, cz, cy, speed: rand(0.06, 0.12), r: rand(40, 90), phase: rand(6.28) });
  }

  /* 巡逻直升机（原版 City Protection 白色警用机） */
  let heli = null;
  {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(1.1, 2.6, 6, 12), new THREE.MeshStandardMaterial({ color: 0xf2f5f6, roughness: 0.4, metalness: 0.3 }));
    body.rotation.z = Math.PI / 2;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.5 }));
    stripe.position.set(0.4, 0, 1.02);
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.34, 3.4, 8), new THREE.MeshStandardMaterial({ color: 0xf2f5f6, roughness: 0.4 }));
    tail.rotation.z = Math.PI / 2;
    tail.position.set(-2.6, 0.25, 0);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.0, 0.7), new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.5 }));
    fin.position.set(-4.2, 0.7, 0);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.4, 6), darkTrimMat);
    mast.position.set(0.3, 1.2, 0);
    const rotor = new THREE.Group();
    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x22282c, roughness: 0.7 });
    for (let i = 0; i < 2; i++) {
      const bl = new THREE.Mesh(new THREE.BoxGeometry(11, 0.06, 0.34), bladeMat);
      bl.rotation.y = i * Math.PI / 2;
      rotor.add(bl);
    }
    rotor.position.set(0.3, 1.45, 0);
    const tailRotor = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 0.2), bladeMat);
    tailRotor.position.set(-4.3, 0.3, 0.4);
    const skidMat = new THREE.MeshStandardMaterial({ color: 0x3a434a, roughness: 0.6, metalness: 0.4 });
    for (const sz of [-0.9, 0.9]) {
      const skid = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.1, 0.12), skidMat);
      skid.position.set(0, -1.35, sz);
      g.add(skid);
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), skidMat);
      leg.position.set(-0.8, -1.1, sz);
      g.add(leg);
      const leg2 = leg.clone();
      leg2.position.x = 0.8;
      g.add(leg2);
    }
    g.add(body, stripe, tail, fin, mast, rotor, tailRotor);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    scene.add(g);
    heli = { group: g, rotor, tailRotor, phase: rand(6.28) };
  }

  /* ---------------------------------------------------- 中央教学区 */
  function strip(x0, x1, z0, z1, y, mat = runnerMatPlain) {
    batcher.box(Math.abs(x1 - x0), 0.05, Math.abs(z1 - z0), (x0 + x1) / 2, y + 0.028, (z0 + z1) / 2, mat);
  }
  world.strip = strip;

  function addTutorialBuilding(x0, x1, z0, z1, top, opts = {}) {
    const d = districtAt((x0 + x1) / 2, (z0 + z1) / 2);
    const style = opts.style || 'grid';
    const accent = opts.accent ? d.hex : null;
    const side = facadeMat(style, Math.floor(hash2(Math.round(x0), Math.round(z0)) * 2), accent);
    const mesh = addBoxMesh(x0, x1, 0, top, z0, z1, [side, side, roofMat, roofMat, side, side], {
      ...opts,
      extra: { mantle: true, building: true, surface: 'concrete', ...(opts.extra || {}) },
    });
    mesh.name = opts.name || 'building';
    /* 白色女儿墙（原版屋顶边缘，高 0.85m 必须翻越） */
    const ph = 0.85, pt = 0.22, py = top + ph / 2;
    batcher.box(x1 - x0, ph, pt, (x0 + x1) / 2, py, z0, whiteMat);
    batcher.box(x1 - x0, ph, pt, (x0 + x1) / 2, py, z1, whiteMat);
    batcher.box(pt, ph, z1 - z0, x0, py, (z0 + z1) / 2, whiteMat);
    batcher.box(pt, ph, z1 - z0, x1, py, (z0 + z1) / 2, whiteMat);
    addCollider(x0, x1, top, top + ph, z0 - pt / 2, z0 + pt / 2, 'solid', { surface: 'concrete', name: 'parapet' });
    addCollider(x0, x1, top, top + ph, z1 - pt / 2, z1 + pt / 2, 'solid', { surface: 'concrete', name: 'parapet' });
    addCollider(x0 - pt / 2, x0 + pt / 2, top, top + ph, z0, z1, 'solid', { surface: 'concrete', name: 'parapet' });
    addCollider(x1 - pt / 2, x1 + pt / 2, top, top + ph, z0, z1, 'solid', { surface: 'concrete', name: 'parapet' });
    return mesh;
  }

  /* ---------------------------------------------------- 查询接口 */
  let visitQ = 0, visitR = 0;
  world.physStats = { queries: 0, boxesExamined: 0, rays: 0, raySteps: 0 };
  world.queryAABB = (min, max, out = []) => {
    out.length = 0;
    visitQ++;
    world.physStats.queries++;
    const c = grid.size;
    const x0 = Math.floor(min.x / c), x1 = Math.floor(max.x / c);
    const z0 = Math.floor(min.z / c), z1 = Math.floor(max.z / c);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = grid.cell(ix, iz);
        if (!arr) continue;
        for (const b of arr) {
          world.physStats.boxesExamined++;
          if (b.__q === visitQ) continue;
          b.__q = visitQ;
          if (max.x < b.min.x || min.x > b.max.x) continue;
          if (max.y < b.min.y || min.y > b.max.y) continue;
          if (max.z < b.min.z || min.z > b.max.z) continue;
          out.push(b);
        }
      }
    }
    return out;
  };

  /* 旧版 rayBox（分配 point/normal 且与 boxRayT 重复）已删除，
     射线查询统一走下方零分配的 boxRayT / rayCast。 */

  let _rAxis = -1, _rSign = 0;
  function boxRayT(origin, dir, box, maxDist) {
    let tmin = 0;
    let tmax = maxDist;
    let axis = -1;
    let sign = 0;
    for (let i = 0; i < 3; i++) {
      const d = dir.getComponent(i);
      const o = origin.getComponent(i);
      if (Math.abs(d) < 1e-9) {
        if (o < box.min.getComponent(i) || o > box.max.getComponent(i)) return null;
        continue;
      }
      let t1 = (box.min.getComponent(i) - o) / d;
      let t2 = (box.max.getComponent(i) - o) / d;
      let s = -1;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = i; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    _rAxis = axis;
    _rSign = sign;
    return tmin;
  }
  const _rp = new THREE.Vector3();
  const _hitNormal = new THREE.Vector3(0, 1, 0);
  const _rayHit = { t: 0, normal: _hitNormal, box: null };
  world.rayCast = (origin, dir, maxDist, filter = () => true) => {
    let bestT = Infinity;
    let bestBox = null;
    let bestAxis = -1;
    let bestSign = 0;
    visitR++;
    world.physStats.rays++;
    const c = grid.size;
    const step = c * 0.45;
    _rp.copy(origin);
    let travelled = 0;
    while (travelled <= maxDist) {
      const ix = Math.floor(_rp.x / c), iz = Math.floor(_rp.z / c);
      const arr = grid.cell(ix, iz);
      if (arr) {
        for (const b of arr) {
          if (b.__r === visitR) continue;
          b.__r = visitR;
          if (!filter(b)) continue;
          world.physStats.raySteps++;
          const t = boxRayT(origin, dir, b, Math.min(maxDist, bestT));
          if (t !== null && t < bestT) {
            bestT = t;
            bestBox = b;
            bestAxis = _rAxis;
            bestSign = _rSign;
          }
        }
      }
      if (bestBox && bestT <= travelled) break;
      travelled += step;
      _rp.addScaledVector(dir, step);
    }
    if (!bestBox) return null;
    _hitNormal.set(0, 0, 0);
    if (bestAxis >= 0) _hitNormal.setComponent(bestAxis, bestSign);
    _rayHit.t = bestT;
    _rayHit.box = bestBox;
    return _rayHit;
  };

  const _rdOrigin = new THREE.Vector3();
  const _downDir = new THREE.Vector3(0, -1, 0);
  world.rayDown = (x, z, fromY, maxDist = 260) => {
    _rdOrigin.set(x, fromY, z);
    const hit = world.rayCast(_rdOrigin, _downDir, maxDist, (b) => b.kind !== 'zone');
    return hit ? fromY - hit.t : null;
  };

  function buildTutorial() {
    addTutorialBuilding(-8, 20, -9, 9, 18, { name: 'A' });
    addTutorialBuilding(27, 44, -7, 7, 14, { name: 'B' });
    addTutorialBuilding(57, 69, -7.5, 7.5, 12, { name: 'C', style: 'ribbon' });
    addTutorialBuilding(73, 90, -8, 8, 21, { name: 'D' });
    addTutorialBuilding(97, 116, -9, 9, 21, { name: 'E', style: 'ribbon' });
    addTutorialBuilding(126, 150, -9, 9, 8, { name: 'F', style: 'panel' });
    addTutorialBuilding(150, 166, -7, 7, 12, { name: 'G' });

    /* 滑铲横杆 */
    const slideBar = addBoxMesh(33, 33.9, 15.1, 16.35, -6.8, 6.8,
      [stripeMat, stripeMat, whitePanelMat, whitePanelMat, stripeMat, stripeMat],
      { extra: { noMantle: true, name: 'slideBarrier', surface: 'metal' } });
    registerHighlight(slideBar, 10);
    strip(33, 33.9, -6.8, 6.8, 15.1, runnerMatPlain);

    /* 翻越障碍 */
    const vaultVent = addBoxMesh(38.4, 40.6, 14, 15.35, -2.5, 2.5,
      [metalSideMat, metalSideMat, metalTopMat, metalTopMat, metalSideMat, metalSideMat],
      { extra: { noMantle: true, name: 'vaultVent', surface: 'metal' } });
    registerHighlight(vaultVent, 9);
    strip(38.4, 40.6, -2.5, 2.5, 15.35, runnerMatBright);
    for (let i = 0; i < 4; i++) batcher.box(0.08, 0.5, 2.3, 38.7 + i * 0.6, 15.6, 0, whiteMat);

    /* 蹬墙跑 */
    addWallrunX({ x0: 42, x1: 56.8, faceZ: -2.5, thickness: 0.6, y0: 0, y1: 17.6, normalZ: 1, direction: 1,
      zoneX0: 43.5, zoneX1: 56.6, zoneY0: 9, zoneY1: 18.2, zoneZ0: -5.0, zoneZ1: 0.6 });

    /* 攀爬平台 + 管道 */
    addBoxMesh(69.9, 71.5, 11.4, 13.6, -1.4, 1.4,
      [runnerMatPlain, runnerMatPlain, roofMat, roofMat, runnerMatPlain, runnerMatPlain],
      { extra: { mantle: true, name: 'plinth', surface: 'metal' } });
    strip(69.9, 71.5, -1.4, 1.4, 13.6, runnerMatBright);
    addClimbEntry(70.7, 0, 13.6, 21.0, 73.6, 0, 68.6, 0);

    /* 空中横梁 */
    addBoxMesh(89.5, 97.5, 20.6, 21.15, -1.0, 1.0,
      [whiteMat, whiteMat, roofMat, roofMat, whiteMat, whiteMat], { extra: { name: 'beam', surface: 'metal' } });
    strip(89.5, 97.5, -0.95, 0.95, 21.15, runnerMatPlain);

    /* 滑索 */
    addZipEntry([108.5, 20.9, 0], [134.6, 11.0, 0], 0.94);

    /* 弹簧板 */
    addSpringboard(140.2, 141.8, 8, 8.35, -1.4, 1.4, [12.8, 14.2, 0]);

    /* 教学箭头 */
    for (const [ax, ay, az] of [
      [4, 18.52, 0], [22, 18.52, 0], [31, 14.52, 0], [35.5, 14.52, 0],
      [44.5, 14.52, -1.2], [62, 12.52, 0], [77, 21.52, 0], [93, 21.52, 0],
      [108, 21.52, 0], [118, 15.52, 0], [137, 8.52, 0],
    ]) {
      const arr = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.1), arrowMat);
      arr.rotation.x = -Math.PI / 2;
      arr.rotation.z = Math.PI / 2;
      arr.position.set(ax, ay + 0.02, az);
      arr.receiveShadow = true;
      scene.add(arr);
    }
  }

  /* ------------------------------------------------ 跑酷设施构造器 */
  function addClimbEntry(x, z, baseY, topY, dismountX, dismountZ, exitX, exitZ) {
    const cd = {
      x, z, baseY, topY,
      dismount: new THREE.Vector3(dismountX, topY + 0.06, dismountZ),
      exitBottom: new THREE.Vector3(exitX, baseY + 0.06, exitZ),
    };
    world.climbs.push(cd);
    const pipeMat = runnerMatBright.clone();
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, topY - baseY, 10), pipeMat);
    pipe.position.set(x, (baseY + topY) / 2, z);
    pipe.castShadow = true;
    pipe.receiveShadow = true;
    scene.add(pipe);
    const ringGeos = [];
    const ringM = new THREE.Matrix4();
    for (let y = baseY + 0.7; y < topY; y += 1.0) {
      const g = new THREE.TorusGeometry(0.38, 0.045, 8, 18).rotateX(Math.PI / 2);
      ringM.makeTranslation(x, y, z);
      g.applyMatrix4(ringM);
      ringGeos.push(g);
    }
    const ringMat = runnerMatPlain.clone();
    if (ringGeos.length) {
      const rings = new THREE.Mesh(mergeGeometries(ringGeos, false), ringMat);
      rings.castShadow = true;
      scene.add(rings);
      registerHighlight(rings, 11, [ringMat]);
    } else {
      ringGeos.forEach((g) => g.dispose());
    }
    registerHighlight(pipe, 11, [pipeMat]);
    return cd;
  }

  function addZipEntry(from, to, releaseT = 0.94) {
    const zd = { from: new THREE.Vector3(...from), to: new THREE.Vector3(...to), releaseT };
    /* 端点正下方必须确实有屋顶：否则不要创建（杜绝“连到空中”） */
    const hiBase = world.rayDown(zd.from.x, zd.from.z, zd.from.y + 6, 80);
    const loBase = world.rayDown(zd.to.x, zd.to.z, zd.to.y + 6, 80);
    if (hiBase === null || loBase === null) return null;
    const hiDrop = zd.from.y - hiBase, loDrop = zd.to.y - loBase;
    if (hiDrop < -0.35 || hiDrop > 7 || loDrop < -0.35 || loDrop > 7) return null;
    world.zips.push(zd);
    const zipMid = zd.from.clone().lerp(zd.to, 0.5);
    zipMid.y -= 1.4;
    const curve = new THREE.QuadraticBezierCurve3(zd.from, zipMid, zd.to);
    batcher.add(new THREE.TubeGeometry(curve, 20, 0.045, 6), darkTrimMat, new THREE.Matrix4());
    /* 高端锚杆：底座落在实际屋顶上 */
    const hiH = clamp(zd.from.y + 0.45 - hiBase, 0.8, 6);
    batcher.cyl(0.09, 0.13, hiH, 8, zd.from.x, hiBase + hiH / 2, zd.from.z, darkTrimMat);
    batcher.box(0.5, 0.14, 0.5, zd.from.x, hiBase + 0.07, zd.from.z, concreteMat);
    const handleMat = runnerMatBright.clone();
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), handleMat);
    handle.position.copy(zd.from);
    scene.add(handle);
    /* 低端抓杆：底座落在实际屋顶上，人可在杆下按住 W 上爬 */
    const loH = clamp(zd.to.y + 0.5 - loBase, 1.2, 8);
    batcher.cyl(0.12, 0.18, loH, 8, zd.to.x, loBase + loH / 2, zd.to.z, darkTrimMat);
    batcher.box(0.6, 0.16, 0.6, zd.to.x, loBase + 0.08, zd.to.z, concreteMat);
    const handle2Mat = runnerMatBright.clone();
    const handle2 = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), handle2Mat);
    handle2.position.copy(zd.to);
    scene.add(handle2);
    registerHighlight(handle, 10, [handleMat]);
    registerHighlight(handle2, 10, [handle2Mat]);
    return zd;
  }

  function addWallrunMaterial(normalAxis, sign) {
    const side = new THREE.MeshStandardMaterial({ color: 0xd8dee2, roughness: 0.7 });
    const top = new THREE.MeshStandardMaterial({ color: 0xe6eaeb, roughness: 0.8 });
    const red = runnerMat.clone();
    const arr = [side, side, top, top, side, side];
    if (normalAxis === 'z') arr[sign > 0 ? 4 : 5] = red;
    else arr[sign > 0 ? 0 : 1] = red;
    return { mats: arr, red };
  }

  function addWallrunX(opts) {
    const { x0, x1, faceZ, thickness = 0.6, y0 = 0, y1 = 16, normalZ = 1, direction = 1,
      zoneX0 = x0 - 0.6, zoneX1 = x1 + 0.6, zoneY0 = y0 + 0.2, zoneY1 = y1 - 0.2, zoneZ0, zoneZ1 } = opts;
    const zBack = faceZ - normalZ * thickness;
    const { mats, red } = addWallrunMaterial('z', normalZ);
    const mesh = addBoxMesh(x0, x1, y0, y1, Math.min(faceZ, zBack), Math.max(faceZ, zBack), mats,
      { extra: { name: 'wallRunSlab', wallSolid: true, surface: 'metal' } });
    registerHighlight(mesh, 14, [red]);
    const z0z = zoneZ0 !== undefined ? zoneZ0 : (normalZ > 0 ? faceZ - 0.4 : faceZ - 4.0);
    const z1z = zoneZ1 !== undefined ? zoneZ1 : (normalZ > 0 ? faceZ + 4.0 : faceZ + 0.4);
    addCollider(zoneX0, zoneX1, zoneY0, zoneY1, z0z, z1z, 'zone', {
      name: 'wallrunZone',
      wallNormal: new THREE.Vector3(0, 0, normalZ),
      tangent: new THREE.Vector3(direction, 0, 0),
      face: new THREE.Vector3(direction > 0 ? x0 : x1, 0, faceZ),
      startT: direction > 0 ? x0 : -x1,
      endT: direction > 0 ? x1 : -x0,
    });
  }

  function addWallrunZ(opts) {
    const { z0, z1, faceX, thickness = 0.6, y0 = 0, y1 = 16, normalX = 1, direction = 1,
      zoneZ0 = z0 - 0.6, zoneZ1 = z1 + 0.6, zoneY0 = y0 + 0.2, zoneY1 = y1 - 0.2, zoneX0, zoneX1 } = opts;
    const xBack = faceX - normalX * thickness;
    const { mats, red } = addWallrunMaterial('x', normalX);
    const mesh = addBoxMesh(Math.min(faceX, xBack), Math.max(faceX, xBack), y0, y1, z0, z1, mats,
      { extra: { name: 'wallRunSlab', wallSolid: true, surface: 'metal' } });
    registerHighlight(mesh, 14, [red]);
    const x0z = zoneX0 !== undefined ? zoneX0 : (normalX > 0 ? faceX - 4.0 : faceX - 0.4);
    const x1z = zoneX1 !== undefined ? zoneX1 : (normalX > 0 ? faceX + 0.4 : faceX + 4.0);
    addCollider(x0z, x1z, zoneY0, zoneY1, zoneZ0, zoneZ1, 'zone', {
      name: 'wallrunZone',
      wallNormal: new THREE.Vector3(normalX, 0, 0),
      tangent: new THREE.Vector3(0, 0, direction),
      face: new THREE.Vector3(faceX, 0, direction > 0 ? z0 : z1),
      startT: direction > 0 ? z0 : -z1,
      endT: direction > 0 ? z1 : -z0,
    });
  }

  function addSpringboard(x0, x1, y0, y1, z0, z1, launch) {
    const lv = new THREE.Vector3(launch[0], launch[1], launch[2]);
    const yaw = Math.atan2(-lv.x, -lv.z);
    const sideMat = runnerMatBright.clone();
    const pad = addBoxMesh(x0, x1, y0, y1, z0, z1, sideMat,
      { kind: 'bounce', extra: { name: 'springboard', launch: lv, launchYaw: yaw, surface: 'metal' } });
    registerHighlight(pad, 12, [sideMat]);
    /* 箭头贴花合批（与教学箭头共用材质） */
    batcher.plane(x1 - x0 - 0.2, z1 - z0 - 0.2, (x0 + x1) / 2, y1 + 0.03, (z0 + z1) / 2, arrowMat, -Math.PI / 2, yaw + Math.PI / 2);
    strip(x0, x1, z0, z1, y1, runnerMatBright);
    return pad;
  }
  world.addWallrunX = addWallrunX;
  world.addWallrunZ = addWallrunZ;
  world.addSpringboard = addSpringboard;
  world.addZipEntry = addZipEntry;
  world.addClimbEntry = addClimbEntry;

  progress(0.02); await yieldFrame();
  buildTutorial();

  /* --------------------------------------------- 程序化街区生成 */
  const cellList = [];
  const buildingBoxes = [];
  const styleBoxes = new Map(); // key -> {mat, list:[{m, color}]}

  function addStyleBox(style, variant, accentHex, x0, x1, z0, z1, h) {
    const key = `${style}_${variant}_${accentHex || 'n'}`;
    let entry = styleBoxes.get(key);
    if (!entry) {
      entry = { mat: facadeMat(style, variant, accentHex), list: [] };
      styleBoxes.set(key, entry);
    }
    entry.list.push({ x0, x1, z0, z1, h });
  }

  function generateCity() {
    /* ---- 阶段 A：高度场 + 相邻街区高差约束（保证任何相邻街区都能用弹簧板/滑索跨越） ---- */
    const cellBase = new Map();
    const cellInfo = new Map();
    const ck = (i, j) => `${i},${j}`;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const cx = -HALF + i * PITCH;
        const cz = -HALF + j * PITCH;
        const bw = 27 + hash2(i * 3 + 11, j * 5 + 7) * 11;
        const bd = 27 + hash2(i * 7 + 3, j * 11 + 5) * 11;
        if (corridorOverlap(cx, cz, bw / 2, bd / 2)) continue;
        if (reservedOverlap(cx, cz, bw / 2, bd / 2)) continue;
        if (cz > 252) continue;
        if (cz > HIGHWAY_Z - 17 && cz < HIGHWAY_Z + 17) continue;
        const district = districtAt(cx, cz);
        const nearCorridor = Math.abs(cz) < 110 && cx > -60 && cx < 210;
        let base = districtHeight(district, cx, cz);
        if (nearCorridor) base = clamp(courseHeightAtX(clamp(cx, -6, 170)) + (hash2(i + 31, j + 53) - 0.5) * 3, 8, 42);
        cellBase.set(ck(i, j), base);
        cellInfo.set(ck(i, j), { cx, cz, bw, bd, district, nearCorridor });
      }
    }
    /* 高差约束：相邻街区高差不超过 12m（弹簧板上限），迭代松弛 */
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const [k, info] of cellInfo) {
        const [i, j] = k.split(',').map(Number);
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          const kn = ck(i + di, j + dj);
          if (!cellBase.has(kn)) continue;
          let a = cellBase.get(k), b = cellBase.get(kn);
          const d = b - a;
          const MAXD = 6;
          if (Math.abs(d) > MAXD) {
            const move = (Math.abs(d) - MAXD) / 2 * Math.sign(d);
            a += move; b -= move;
            cellBase.set(k, clamp(Math.round(a * 2) / 2, 6, 52));
            cellBase.set(kn, clamp(Math.round(b * 2) / 2, 6, 52));
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    /* ---- 阶段 B：逐街区生成建筑 ---- */
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const info = cellInfo.get(ck(i, j));
        if (!info) continue;
        const { cx, cz, bw, bd, district, nearCorridor } = info;
        const r0 = hash2(i * 3 + 11, j * 5 + 7);
        const r1 = hash2(i * 7 + 3, j * 11 + 5);
        const r2 = hash2(i * 13 + 7, j * 17 + 11);
        const base = cellBase.get(ck(i, j));
        const style = district.glass > r2 ? (r2 < district.glass * 0.55 ? 'glass' : 'ribbon') : 'grid';
        const variant = Math.floor(hash2(i + 91, j + 97) * 2);
        const accent = hash2(i + 211, j + 223) < (district.key === 'OLDTOWN' || district.key === 'DOCKS' ? 0.16 : 0.08)
          ? district.hex : null;
        const pat = r2;
        let subs = [];
        if (pat < 0.34) {
          subs.push({ x0: cx - bw / 2, x1: cx + bw / 2, z0: cz - bd / 2, z1: cz + bd / 2, h: base });
        } else if (pat < 0.55) {
          const alley = 3 + hash2(i * 5, j * 3) * 2;
          const w2 = (bw - alley) / 2;
          const hi1 = hash2(i, j + 1) < 0.5 ? 2.5 : -1.5;
          subs.push({ x0: cx - bw / 2, x1: cx - bw / 2 + w2, z0: cz - bd / 2, z1: cz + bd / 2, h: base + hi1 });
          subs.push({ x0: cx + alley / 2, x1: cx + bw / 2, z0: cz - bd / 2, z1: cz + bd / 2, h: base - hi1 });
        } else if (pat < 0.72) {
          const alley = 3 + hash2(i * 9, j * 7) * 2;
          const d2 = (bd - alley) / 2;
          const hi2 = hash2(i + 2, j) < 0.5 ? 2.5 : -1.5;
          subs.push({ x0: cx - bw / 2, x1: cx + bw / 2, z0: cz - bd / 2, z1: cz - bd / 2 + d2, h: base + hi2 });
          subs.push({ x0: cx - bw / 2, x1: cx + bw / 2, z0: cz + alley / 2, z1: cz + bd / 2, h: base - hi2 });
        } else if (pat < 0.86) {
          const alley = 3.5 + hash2(i * 11, j * 13) * 1.5;
          const w2 = (bw - alley) / 2, d2 = (bd - alley) / 2;
          const hs = [-1.5, 1, -0.5, 1.5].map((k) => base + k);
          let si = 0;
          for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
            subs.push({
              x0: cx + sx * (alley / 2) + (sx < 0 ? -w2 : 0), x1: cx + sx * (alley / 2) + (sx < 0 ? 0 : w2),
              z0: cz + sz * (alley / 2) + (sz < 0 ? -d2 : 0), z1: cz + sz * (alley / 2) + (sz < 0 ? 0 : d2),
              h: clamp(hs[si++], district.min, district.max),
            });
          }
          subs = subs.map((s) => ({ ...s, h: Math.round(s.h * 2) / 2 }));
        } else {
          /* L 形：主楼 + 侧楼，形成内凹屋顶 */
          const dMain = bd * 0.6;
          subs.push({ x0: cx - bw / 2, x1: cx + bw / 2, z0: cz - bd / 2, z1: cz - bd / 2 + dMain, h: base });
          subs.push({ x0: cx - bw / 2, x1: cx - bw / 2 + bw * 0.45, z0: cz - bd / 2 + dMain, z1: cz + bd / 2, h: base + (hash2(i + 5, j + 5) - 0.5) * 1.5 });
        }
        /* 塔楼：底盘 + 高塔（塔楼靠 +x 侧，-x 面留底盘屋顶放攀爬管） */
        let towerInfo = null;
        const towerRoll = hash2(i + 301, j + 307);
        if (!nearCorridor && towerRoll < district.tower && subs.length <= 2) {
          const hub0 = subs.reduce((a, b) => ((b.x1 - b.x0) * (b.z1 - b.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? b : a));
          const tw = Math.min(11 + hash2(i + 401, j + 409) * 5, (hub0.x1 - hub0.x0) * 0.55, (hub0.z1 - hub0.z0) * 0.55);
          const td = tw;
          const tx = hub0.x1 - tw / 2 - 0.9;
          const tz = clamp((hub0.z0 + hub0.z1) / 2 + (hash2(i + 411, j + 419) - 0.5) * ((hub0.z1 - hub0.z0) - td - 2), hub0.z0 + td / 2 + 0.8, hub0.z1 - td / 2 - 0.8);
          const th = clamp(Math.round((base + 16 + hash2(i + 421, j + 431) * 30) * 2) / 2, 18, 96);
          subs.push({ x0: tx - tw / 2, x1: tx + tw / 2, z0: tz - td / 2, z1: tz + td / 2, h: th, tower: true });
          towerInfo = { x0: tx - tw / 2, x1: tx + tw / 2, z0: tz - td / 2, z1: tz + td / 2, h: th, baseY: hub0.h, cz: tz };
        }
        for (const s of subs) {
          s.h = clamp(Math.round(s.h * 2) / 2, 6, 96);
          s.style = s.tower && district.glass > 0.2 ? 'glass' : style;
          s.variant = variant;
          s.accent = accent;
        }
        const hubBox = subs.reduce((a, b) => ((b.x1 - b.x0) * (b.z1 - b.z0) > (a.x1 - a.x0) * (a.z1 - a.z0) ? b : a));
        const topBox = subs.reduce((a, b) => (b.h > a.h ? b : a));
        cellList.push({ i, j, cx, cz, main: hubBox, top: topBox, towerInfo });
        for (const s of subs) {
          buildingBoxes.push(s);
          addStyleBox(s.style, s.variant, s.accent, s.x0, s.x1, s.z0, s.z1, s.h);
          addCollider(s.x0, s.x1, 0, s.h, s.z0, s.z1, 'solid', { mantle: true, building: true, open: true, name: `b-${i}-${j}` });
          /* 女儿墙 */
          const ph = 0.85, pt = 0.22, py = s.h + ph / 2;
          batcher.box(s.x1 - s.x0, ph, pt, (s.x0 + s.x1) / 2, py, s.z0, whiteMat);
          batcher.box(s.x1 - s.x0, ph, pt, (s.x0 + s.x1) / 2, py, s.z1, whiteMat);
          batcher.box(pt, ph, s.z1 - s.z0, s.x0, py, (s.z0 + s.z1) / 2, whiteMat);
          batcher.box(pt, ph, s.z1 - s.z0, s.x1, py, (s.z0 + s.z1) / 2, whiteMat);
          addCollider(s.x0, s.x1, s.h, s.h + ph, s.z0 - pt / 2, s.z0 + pt / 2, 'solid', { surface: 'concrete', name: 'parapet' });
          addCollider(s.x0, s.x1, s.h, s.h + ph, s.z1 - pt / 2, s.z1 + pt / 2, 'solid', { surface: 'concrete', name: 'parapet' });
          addCollider(s.x0 - pt / 2, s.x0 + pt / 2, s.h, s.h + ph, s.z0, s.z1, 'solid', { surface: 'concrete', name: 'parapet' });
          addCollider(s.x1 - pt / 2, s.x1 + pt / 2, s.h, s.h + ph, s.z0, s.z1, 'solid', { surface: 'concrete', name: 'parapet' });
        }
      }
    }
  }
  progress(0.10); await yieldFrame();
  generateCity();

  /* 供路线 / 统计使用的楼顶列表 */
  world.openCity.buildings = buildingBoxes.map((s, idx) => ({
    i: idx, j: idx,
    x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1, top: s.h,
    cx: (s.x0 + s.x1) / 2, cz: (s.z0 + s.z1) / 2,
    w: s.x1 - s.x0, d: s.z1 - s.z0,
  }));
  progress(0.30); await yieldFrame();

  /* 实例化立面 + 屋顶 */
  {
    const m = new THREE.Matrix4();
    const roofCount = buildingBoxes.length;
    const roofInst = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), roofMat, roofCount);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const col = new THREE.Color();
    let roofIdx = 0;
    for (const [, entry] of styleBoxes) {
      const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), entry.mat, entry.list.length);
      entry.list.forEach((s, k) => {
        const w = s.x1 - s.x0, d = s.z1 - s.z0;
        m.makeScale(w, s.h, d);
        m.setPosition((s.x0 + s.x1) / 2, s.h / 2, (s.z0 + s.z1) / 2);
        inst.setMatrixAt(k, m);
        const tint = 0.93 + hash2(s.x0 | 0, s.z0 | 0) * 0.12;
        col.setRGB(tint, tint, Math.min(1.04, tint + 0.02));
        inst.setColorAt(k, col);
      });
      inst.instanceMatrix.needsUpdate = true;
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      scene.add(inst);
    }
    for (const s of buildingBoxes) {
      const w = s.x1 - s.x0, d = s.z1 - s.z0;
      m.compose(new THREE.Vector3((s.x0 + s.x1) / 2, s.h + 0.012, (s.z0 + s.z1) / 2), q, new THREE.Vector3(w, d, 1));
      roofInst.setMatrixAt(roofIdx, m);
      /* 屋顶色板：白混凝土 / 暖灰 / 深色沥青 / 冷青，避免整片城市同色 */
      const rr = hash2(s.z0 | 0, s.x0 | 0);
      let tr, tg, tb;
      if (rr < 0.12) { tr = 0.62; tg = 0.64; tb = 0.66; }
      else if (rr < 0.3) { tr = 0.79; tg = 0.78; tb = 0.75; }
      else if (rr < 0.46) { tr = 0.9; tg = 0.88; tb = 0.83; }
      else if (rr < 0.54) { tr = 0.82; tg = 0.87; tb = 0.88; }
      else { tr = 0.95; tg = 0.955; tb = 0.96; }
      const jitter = 0.94 + hash2(s.x0 | 0, s.z1 | 0) * 0.1;
      col.setRGB(tr * jitter, tg * jitter, tb * jitter);
      roofInst.setColorAt(roofIdx, col);
      roofIdx++;
    }
    roofInst.instanceMatrix.needsUpdate = true;
    if (roofInst.instanceColor) roofInst.instanceColor.needsUpdate = true;
    roofInst.receiveShadow = true;
    roofInst.frustumCulled = false;
    scene.add(roofInst);
  }

  /* ---------------------------------------------------------- 地面 */
  {
    const blocks = buildingBoxes.map((s) => ({ x0: s.x0, x1: s.x1, z0: s.z0, z1: s.z1 }));
    const tex = groundCanvas(blocks, corridor);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1100, 1100), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.02 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    scene.add(ground);
    addCollider(-550, 550, -0.7, 0, -550, 550, 'solid', { street: true });
  }

  /* ------------------------------------------------- 屋顶机械与道具 */
  const smokeVents = [];

  function findRoofSpot(b, spanX, spanZ) {
    for (const [ox, oz] of [[0, 0], [0, 6], [0, -6], [6, 0], [-6, 0], [6, 6], [-6, -6], [6, -6], [-6, 6], [0, 11], [0, -11]]) {
      if (Math.abs(ox) > (b.x1 - b.x0) / 2 - spanX || Math.abs(oz) > (b.z1 - b.z0) / 2 - spanZ) continue;
      const x = (b.x0 + b.x1) / 2 + ox, z = (b.z0 + b.z1) / 2 + oz;
      if (!pointInsideProp(x, b.h + 0.8, z, 1.6)) return [x, z];
    }
    return null;
  }

  function addCoolingUnit(x, y, z, big = true) {
    const s = big ? 2.6 : 1.7;
    const h = big ? 1.7 : 1.15;
    batcher.box(s, h, s, x, y + h / 2, z, acMat);
    batcher.box(s * 0.9, 0.08, s * 0.9, x, y + h + 0.04, z, metalTopMat);
    addCollider(x - s / 2, x + s / 2, y, y + h, z - s / 2, z + s / 2, 'solid', { noMantle: true, name: 'cooling', surface: 'metal' });
  }
  function addAcUnit(x, y, z) {
    const w = 1.9, h = 1.25, d = 1.5;
    batcher.box(w, h, d, x, y + h / 2, z, acMat);
    addCollider(x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2, 'solid', { noMantle: true, name: 'ac', surface: 'metal' });
  }
  function addHvacFarm(b) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const rows = Math.max(1, Math.floor((w - 6) / 6));
    const cols = Math.max(1, Math.floor((d - 6) / 6));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = b.x0 + 3 + r * ((w - 6) / Math.max(1, rows - 1 || 1));
        const z = b.z0 + 3 + c * ((d - 6) / Math.max(1, cols - 1 || 1));
        if (hash2(Math.round(x * 3), Math.round(z * 5)) < 0.35) continue;
        if (pointInsideProp(x, b.h + 0.9, z, 1.8)) continue;
        addCoolingUnit(x, b.h + 0.02, z, hash2(Math.round(x), Math.round(z)) > 0.25);
      }
    }
  }
  function addRoofHut(b) {
    const w = 2.6 + hash2(Math.round(b.x0), Math.round(b.z0) + 41) * 1.6;
    const d = 2.0 + hash2(Math.round(b.z0) + 43, Math.round(b.x0)) * 1.2;
    const h = 2.6;
    const spot = findRoofSpot(b, w / 2 + 0.4, d / 2 + 0.4);
    if (!spot) return false;
    const x = spot[0], z = spot[1];
    batcher.box(w, h, d, x, b.h + h / 2, z, panelMat);
    batcher.box(w + 0.12, 0.12, d + 0.12, x, b.h + h + 0.06, z, roofMat);
    batcher.plane(0.9, 1.9, x, b.h + 0.97, z - d / 2 - 0.03, darkTrimMat, 0, Math.PI);
    addCollider(x - w / 2, x + w / 2, b.h, b.h + h, z - d / 2, z + d / 2, 'solid', { mantle: true, name: 'roofhut' });
    return true;
  }
  function addDuctRun(b) {
    const along = (b.x1 - b.x0) >= (b.z1 - b.z0);
    const n = 3 + Math.floor(hash2(Math.round(b.x0), Math.round(b.z0)) * 2);
    const spot = findRoofSpot(b, 6, 2);
    if (!spot) return;
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * 2.8;
      const dx = along ? off : 0, dz = along ? 0 : off;
      batcher.box(1.1, 0.92, 1.1, spot[0] + dx, b.h + 0.46, spot[1] + dz, acMat);
      addCollider(spot[0] + dx - 0.55, spot[0] + dx + 0.55, b.h, b.h + 0.92, spot[1] + dz - 0.55, spot[1] + dz + 0.55, 'solid', { noMantle: true, name: 'duct', surface: 'metal' });
    }
  }
  function addVentPipe(b, x, z) {
    const h = 2.2 + hash2(Math.round(x), Math.round(z)) * 2;
    batcher.cyl(0.28, 0.34, h, 10, x, b.h + h / 2, z, concreteMat);
    batcher.cyl(0.44, 0.44, 0.18, 10, x, b.h + h, z, darkTrimMat);
    addCollider(x - 0.45, x + 0.45, b.h, b.h + h, z - 0.45, z + 0.45, 'solid', { surface: 'metal', noMantle: true, name: 'vent' });
    smokeVents.push({ x, y: b.h + h, z });
  }
  function addWaterTank(b, x, z) {
    const ty = b.h;
    for (const [lx, lz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
      batcher.cyl(0.09, 0.11, 2.2, 6, x + lx, ty + 1.1, z + lz, darkTrimMat);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 2.2, 16), whiteMat);
    tank.position.set(x, ty + 3.3, z);
    tank.castShadow = tank.receiveShadow = true;
    scene.add(tank);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.36, 0.9, 16), concreteMat);
    cap.position.set(x, ty + 4.85, z);
    cap.castShadow = true;
    scene.add(cap);
    addCollider(x - 1.3, x + 1.3, ty + 2.2, ty + 4.4, z - 1.3, z + 1.3, 'solid', { mantle: true, name: 'tank', surface: 'metal' });
  }
  function addTelecomMast(b, x, z) {
    const h = 9 + hash2(Math.round(x), Math.round(z)) * 6;
    batcher.cyl(0.16, 0.26, h, 8, x, b.h + h / 2, z, concreteMat);
    for (let k = 1; k < 4; k++) {
      batcher.cyl(0.06, 0.06, 1.6, 6, x + 0.5, b.h + k * (h / 4), z, darkTrimMat, 0, 0, 0.5);
      batcher.cyl(0.06, 0.06, 1.6, 6, x - 0.5, b.h + k * (h / 4), z, darkTrimMat, 0, 0, -0.5);
    }
    const dishMat = new THREE.MeshStandardMaterial({ color: 0xe8edef, roughness: 0.5, metalness: 0.2 });
    for (let k = 0; k < 3; k++) {
      const dish = new THREE.Mesh(new THREE.CircleGeometry(0.55, 12), dishMat);
      dish.position.set(x + Math.cos(k * 2.1) * 0.9, b.h + h * 0.55 + k * 1.4, z + Math.sin(k * 2.1) * 0.9);
      dish.rotation.y = k * 2.1;
      dish.rotation.x = -0.3;
      dish.castShadow = true;
      scene.add(dish);
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), stripMat);
    beacon.position.set(x, b.h + h + 0.15, z);
    scene.add(beacon);
    addCollider(x - 0.3, x + 0.3, b.h, b.h + h, z - 0.3, z + 0.3, 'solid', { name: 'mast' });
  }
  function addDavit(b, x, z) {
    const armLen = 3.2;
    batcher.cyl(0.12, 0.16, 2.6, 8, x, b.h + 1.3, z, runnerMatPlain);
    batcher.cyl(0.09, 0.09, armLen, 8, x + armLen / 2 - 0.3, b.h + 2.5, z, runnerMatPlain, 0, 0, Math.PI / 2);
    addCollider(x - 0.25, x + 0.25, b.h, b.h + 2.5, z - 0.25, z + 0.25, 'solid', { name: 'davit' });
  }
  function addRoofSign(b, x, z, text, bg, fg) {
    const w = Math.min(9, Math.max(5, (b.x1 - b.x0) * 0.5));
    const h = 1.6;
    const mat = new THREE.MeshBasicMaterial({ map: signCanvas(text, bg, fg), side: THREE.DoubleSide });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    const yaw = hash2(Math.round(x), Math.round(z)) < 0.5 ? 0 : Math.PI / 2;
    panel.position.set(x, b.h + h / 2 + 0.9, z);
    panel.rotation.y = yaw;
    panel.castShadow = true;
    scene.add(panel);
    if (yaw === 0) {
      batcher.box(0.12, 1.1, 0.12, x - w * 0.3, b.h + 0.55, z, darkTrimMat);
      batcher.box(0.12, 1.1, 0.12, x + w * 0.3, b.h + 0.55, z, darkTrimMat);
    } else {
      batcher.box(0.12, 1.1, 0.12, x, b.h + 0.55, z - w * 0.3, darkTrimMat);
      batcher.box(0.12, 1.1, 0.12, x, b.h + 0.55, z + w * 0.3, darkTrimMat);
    }
  }
  function addBillboard(b, seed) {
    const face = Math.floor(hash2(Math.round(b.x0) + 761, Math.round(b.z0) + 769) * 4);
    const w = Math.min(8.5, Math.max(4.5, (b.x1 - b.x0) * 0.7));
    const h = 4.4;
    const hexArr = ['#f2c02a', '#ef8527', '#2f7fc4', '#e8563a', '#f4f6f7'];
    const hex = hexArr[seed % hexArr.length];
    const mat = new THREE.MeshBasicMaterial({ map: adCanvas(seed, hex) });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    let px = (b.x0 + b.x1) / 2, pz = (b.z0 + b.z1) / 2, ry = 0;
    const margin = 1.2;
    if (face === 0) { px = b.x0 + margin; ry = -Math.PI / 2; }
    else if (face === 1) { px = b.x1 - margin; ry = Math.PI / 2; }
    else if (face === 2) { pz = b.z0 + margin; ry = Math.PI; }
    else { pz = b.z1 - margin; ry = 0; }
    panel.position.set(px, b.h + h / 2 + 1.4, pz);
    panel.rotation.y = ry;
    panel.castShadow = true;
    scene.add(panel);
    const rx = ry === 0 || ry === Math.PI ? 1 : 0;
    if (rx) {
      batcher.box(0.16, 1.6, 0.16, px - w * 0.32, b.h + 0.8, pz, darkTrimMat);
      batcher.box(0.16, 1.6, 0.16, px + w * 0.32, b.h + 0.8, pz, darkTrimMat);
    } else {
      batcher.box(0.16, 1.6, 0.16, px, b.h + 0.8, pz - w * 0.32, darkTrimMat);
      batcher.box(0.16, 1.6, 0.16, px, b.h + 0.8, pz + w * 0.32, darkTrimMat);
    }
  }
  function addHelipad(b) {
    const r = Math.min(b.x1 - b.x0, b.z1 - b.z0) * 0.34;
    if (r < 3.5) return false;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    if (pointInsideProp(cx, b.h + 0.5, cz, r * 0.7)) return false;
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 28), new THREE.MeshStandardMaterial({ map: heliTex, roughness: 0.9 }));
    pad.position.set(cx, b.h + 0.15, cz);
    pad.castShadow = pad.receiveShadow = true;
    scene.add(pad);
    addCollider(cx - r * 0.72, cx + r * 0.72, b.h, b.h + 0.3, cz - r * 0.72, cz + r * 0.72, 'solid', { mantle: true, name: 'hpad', surface: 'metal' });
    return true;
  }
  function addSkylight(b, x, z) {
    const sky = addBoxMesh(x - 1.9, x + 1.9, b.h, b.h + 0.5, z - 1.45, z + 1.45,
      [glassMat, glassMat, glassMat, glassMat, glassMat, glassMat], { extra: { mantle: true, name: 'skylight', surface: 'glass' } });
    registerHighlight(sky, 9);
    for (const [fx, fz, fw, fd] of [[0, -1.45, 3.9, 0.12], [0, 1.45, 3.9, 0.12], [-1.9, 0, 0.12, 2.9], [1.9, 0, 0.12, 2.9]]) {
      batcher.box(fw, 0.1, fd, x + fx, b.h + 0.54, z + fz, darkTrimMat);
    }
  }
  function addPipeRail(b) {
    const len = (b.x1 - b.x0) - 9;
    if (len < 6) return false;
    const z = b.z1 - 0.7;
    batcher.cyl(0.09, 0.09, len, 8, (b.x0 + b.x1) / 2, b.h + 1.0, z, runnerMatPlain, 0, 0, Math.PI / 2);
    for (const px of [(b.x0 + b.x1) / 2 - len / 2 + 1, (b.x0 + b.x1) / 2, (b.x0 + b.x1) / 2 + len / 2 - 1]) {
      batcher.cyl(0.05, 0.05, 1.0, 6, px, b.h + 0.5, z, darkTrimMat);
    }
    addCollider((b.x0 + b.x1) / 2 - len / 2, (b.x0 + b.x1) / 2 + len / 2, b.h + 0.9, b.h + 1.08, z - 0.12, z + 0.12, 'solid', { mantle: true, surface: 'metal', name: 'pipeRail' });
    return true;
  }
  function addContainer(x, y, z, yaw, mat) {
    batcher.box(6, 2.6, 2.44, x, y + 1.3, z, mat, yaw);
    const hx = Math.abs(Math.cos(yaw)) * 3 + Math.abs(Math.sin(yaw)) * 1.22;
    const hz = Math.abs(Math.sin(yaw)) * 3 + Math.abs(Math.cos(yaw)) * 1.22;
    addCollider(x - hx, x + hx, y, y + 2.6, z - hz, z + hz, 'solid', { mantle: true, name: 'container', surface: 'metal' });
  }

  function decorateRoofs() {
    let hvac = 0, tanks = 0, masts = 0, signsN = 0, boards = 0, pads = 0, skies = 0, rails = 0, ducts = 0, vents = 0, davitN = 0, cont = 0, huts = 0;
    for (const b of buildingBoxes) {
      const area = (b.x1 - b.x0) * (b.z1 - b.z0);
      const r = hash2(Math.round(b.x0) + 17, Math.round(b.z0) + 23);
      const dq = districtAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      /* 1) 屋顶楼梯间：原版最有辨识度、也最适合跑酷的屋顶物件 */
      if (huts < 170 && area > 230 && hash2(Math.round(b.x0) + 811, Math.round(b.z0) + 813) < 0.62) {
        if (addRoofHut(b)) huts++;
      }
      /* 2) 特殊道具（失败则继续往下走） */
      if (tanks < 16 && area > 280 && r < 0.05) {
        const s = findRoofSpot(b, 3.2, 3.2);
        if (s) { addWaterTank(b, s[0], s[1]); tanks++; }
      } else if (masts < 18 && b.h > 16 && r >= 0.05 && r < 0.1) {
        const s = findRoofSpot(b, 2, 2);
        if (s) { addTelecomMast(b, s[0], s[1]); masts++; }
      } else if (pads < 9 && area > 360 && b.h > 15 && r >= 0.1 && r < 0.15) {
        if (addHelipad(b)) pads++;
      } else if (cont < 80 && (dq.key === 'DOCKS' || dq.key === 'DOWNTOWN') && area > 230 && r >= 0.15 && r < 0.33) {
        const s = findRoofSpot(b, 4, 3);
        if (s) {
          const yaw = hash2(Math.round(s[0]), Math.round(s[1])) < 0.5 ? 0 : Math.PI / 2;
          addContainer(s[0], b.h + 0.02, s[1], yaw, hash2(Math.round(s[0]) + 3, Math.round(s[1]) + 5) < 0.6 ? orangeMat : blueCrateMat);
          if (hash2(Math.round(s[0]) + 7, Math.round(s[1]) + 9) < 0.4) addContainer(s[0], b.h + 2.62, s[1], yaw, orangeMat);
          cont++;
        }
      } else if (signsN < 34 && area > 260 && r >= 0.33 && r < 0.43) {
        const s = findRoofSpot(b, 5, 2);
        if (s) {
          const texts = ['NICAix', 'RAPOSA', 'CITY 08', 'PK', 'URBS', 'MONO', 'ARIA', 'FLY'];
          const cols = [['#f2c02a', '#171b1e'], ['#ef8527', '#ffffff'], ['#2f7fc4', '#ffffff'], ['#f4f6f7', '#e8563a']];
          const c = cols[signsN % cols.length];
          addRoofSign(b, s[0], s[1], texts[signsN % texts.length], c[0], c[1]);
          signsN++;
        }
      } else if (boards < 30 && area > 260 && r >= 0.43 && r < 0.51) {
        addBillboard(b, Math.round(b.x0 * 3 + b.z0 * 7) + 11);
        boards++;
      } else if (davitN < 20 && area > 300 && r >= 0.51 && r < 0.57) {
        const s = findRoofSpot(b, 3, 2);
        if (s) { addDavit(b, s[0], s[1]); davitN++; }
      } else if (vents < 52 && area > 200 && r >= 0.57 && r < 0.67) {
        const s = findRoofSpot(b, 1.2, 1.2);
        if (s) { addVentPipe(b, s[0], s[1]); vents++; }
      } else if (skies < 22 && r >= 0.67 && r < 0.75 && area > 260) {
        const s = findRoofSpot(b, 2.6, 2.2);
        if (s) { addSkylight(b, s[0], s[1]); skies++; }
      } else if (hvac < 120 && area > 600 && r >= 0.75 && r < 0.88) {
        addHvacFarm(b);
        hvac++;
        if (hash2(Math.round(b.x0) + 71, Math.round(b.z0) + 73) < 0.5) { addDuctRun(b); ducts++; }
      }
      /* 3) 通用屋顶设备：几乎每个屋顶都有空调 / 冷却塔 / 格栅箱 */
      if (area > 150) {
        const n = area > 620 ? 3 : area > 340 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const span = 2 + k * 2.6;
          const spot = findRoofSpot(b, span, span);
          if (!spot) continue;
          if (k === 0) addCoolingUnit(spot[0], b.h + 0.02, spot[1], false);
          else addAcUnit(spot[0], b.h + 0.02, spot[1]);
          hvac++;
        }
      }
      if (rails < 32 && area > 220 && hash2(Math.round(b.z0) + 653, Math.round(b.x0) + 661) < 0.1) {
        if (addPipeRail(b)) rails++;
      }
      /* 4) 立面外挂空调 */
      if (hash2(Math.round(b.x0) + 11, Math.round(b.z0) + 13) < 0.3 && b.h > 8) {
        const n = 2 + Math.floor(hash2(Math.round(b.x0) + 5, Math.round(b.z0) + 1) * 3);
        for (let k = 0; k < n; k++) {
          const yy = 4 + hash2(k + 1, Math.round(b.x0)) * Math.max(2, b.h - 6);
          const side = Math.floor(hash2(k + 3, Math.round(b.z0)) * 4);
          const off = (hash2(k + 9, Math.round(b.x0) + 2) - 0.5) * 0.7;
          if (side === 0) batcher.box(0.9, 0.66, 0.5, b.x0 - 0.3, yy, (b.z0 + b.z1) / 2 + off * (b.z1 - b.z0), acMat);
          else if (side === 1) batcher.box(0.9, 0.66, 0.5, b.x1 + 0.3, yy, (b.z0 + b.z1) / 2 + off * (b.z1 - b.z0), acMat);
          else if (side === 2) batcher.box(0.5, 0.66, 0.9, (b.x0 + b.x1) / 2 + off * (b.x1 - b.x0), yy, b.z0 - 0.3, acMat);
          else batcher.box(0.5, 0.66, 0.9, (b.x0 + b.x1) / 2 + off * (b.x1 - b.x0), yy, b.z1 + 0.3, acMat);
        }
      }
    }
    return { hvac, tanks, masts, signsN, boards, pads, skies, rails, ducts, vents, davitN, cont, huts };
  }
  progress(0.42); await yieldFrame();
  const roofStats = decorateRoofs();

  /* ------------------------------------------------ 街道峡谷装饰 */
  function decorateStreets() {
    const awningCols = [new THREE.MeshStandardMaterial({ color: 0xef8527, roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.7 }), new THREE.MeshStandardMaterial({ color: 0xf2c02a, roughness: 0.7 })];
    for (const b of buildingBoxes) {
      const area = (b.x1 - b.x0) * (b.z1 - b.z0);
      if (area < 200) continue;
      const r = hash2(Math.round(b.x0) + 301, Math.round(b.z0) + 307);
      /* 斜挑雨棚（贴墙、无支柱，原版沿街店面样式） */
      if (r < 0.45) {
        const w = 3.5 + r * 4;
        const x = b.x0 + 2 + hash2(Math.round(b.x0) + 7, Math.round(b.z0) + 9) * (b.x1 - b.x0 - w - 4);
        batcher.boxR(w, 0.12, 1.7, x, 3.35, b.z1 + 0.75, awningCols[Math.floor(r * 7) % 3], -0.22, 0, 0);
        batcher.boxR(w, 0.1, 0.12, x, 3.55, b.z1 + 0.12, darkTrimMat, 0, 0, 0);
      }
      if (r > 0.55) {
        const w = 3.5 + (r - 0.55) * 6;
        const z = b.z0 + 2 + hash2(Math.round(b.x0) + 21, Math.round(b.z0) + 23) * (b.z1 - b.z0 - w - 4);
        batcher.boxR(1.7, 0.12, w, b.x1 + 0.75, 3.35, z, awningCols[Math.floor(r * 11) % 3], 0, 0, 0.22);
        batcher.boxR(0.12, 0.1, w, b.x1 + 0.12, 3.55, z, darkTrimMat, 0, 0, 0);
      }
    }
  }
  decorateStreets();

  /* 路灯 / 车辆 / 树（实例化） */
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.85 });
  const signBlueMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.5, metalness: 0.2 });
  const signWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f7, roughness: 0.5 });
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0xbfc7cc, roughness: 0.6, metalness: 0.3 });
  const manholeMat = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.85 });
  const planterMat = new THREE.MeshStandardMaterial({ color: 0xb7bfc4, roughness: 0.9 });

  /* 屋顶栏杆：原版镜之边缘最有辨识度的屋面细节 */
  function addRoofRailing(b) {
    const y = b.h, inset = 0.42, H = 0.95;
    const x0 = b.x0 + inset, x1 = b.x1 - inset, z0 = b.z0 + inset, z1 = b.z1 - inset;
    const run = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 2.4) return;
      const n = Math.max(1, Math.round(len / 2.6));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        batcher.box(0.07, H, 0.07, ax + (bx - ax) * t, y + H / 2, az + (bz - az) * t, darkTrimMat);
      }
      const cx = (ax + bx) / 2, czz = (az + bz) / 2;
      if (Math.abs(bx - ax) > Math.abs(bz - az)) {
        batcher.box(len, 0.05, 0.05, cx, y + H - 0.04, czz, darkTrimMat);
        batcher.box(len, 0.045, 0.045, cx, y + H * 0.52, czz, darkTrimMat);
      } else {
        batcher.box(0.05, 0.05, len, cx, y + H - 0.04, czz, darkTrimMat);
        batcher.box(0.045, 0.045, len, cx, y + H * 0.52, czz, darkTrimMat);
      }
    };
    run(x0, z0, x1, z0); run(x1, z0, x1, z1); run(x1, z1, x0, z1); run(x0, z1, x0, z0);
  }
  function addRoofHatch(b, x, z) {
    const y = b.h;
    batcher.box(2.0, 0.36, 1.4, x, y + 0.18, z, panelMat);
    batcher.box(1.72, 0.07, 1.12, x + 0.12, y + 0.40, z, darkTrimMat);
    batcher.box(0.56, 0.05, 0.05, x - 0.6, y + 0.43, z, darkTrimMat);
    addCollider(x - 1.0, x + 1.0, y, y + 0.38, z - 0.7, z + 0.7, 'solid', { mantle: true, name: 'roofhatch', surface: 'metal' });
  }
  function addPipeCluster(b, x, z) {
    const y = b.h;
    const h = 1.5 + hash2(Math.round(x) + 3, Math.round(z) + 7) * 1.3;
    for (let i = 0; i < 3; i++) {
      const ox = (i - 1) * 0.24;
      batcher.cyl(0.08, 0.08, h, 6, x + ox, y + h / 2, z + ox * 0.4, darkTrimMat);
      batcher.box(0.3, 0.06, 0.3, x + ox, y + h + 0.03, z + ox * 0.4, darkTrimMat);
    }
    batcher.box(0.9, 0.07, 0.9, x, y + 0.035, z, concreteMat);
  }
  function addSatDish(b, x, z) {
    const y = b.h, s = 0.45 + hash2(Math.round(x) + 11, Math.round(z) + 13) * 0.4;
    batcher.cyl(0.06, 0.09, 1.0, 6, x, y + 0.5, z, darkTrimMat);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-1.05, 0.7, 0));
    m.setPosition(x, y + 1.05, z);
    batcher.add(new THREE.CircleGeometry(s, 14), panelMat, m);
  }
  function addAntennaCluster(b, x, z) {
    const y = b.h;
    for (let i = 0; i < 3; i++) {
      const h = 1.5 + i * 0.55, ox = (i - 1) * 0.32;
      batcher.cyl(0.025, 0.035, h, 5, x + ox, y + h / 2, z, darkTrimMat);
      if (i < 2) batcher.box(0.78, 0.04, 0.04, x + ox, y + h - 0.22, z, darkTrimMat);
    }
  }
  function addCrates(b, x, z) {
    const y = b.h;
    const n = 2 + Math.floor(hash2(Math.round(x) + 17, Math.round(z) + 19) * 2);
    for (let i = 0; i < n; i++) {
      const sz = 0.65 + hash2(i + 1, Math.round(x)) * 0.35;
      batcher.box(sz * 1.35, sz, sz, x + (i % 2) * 0.5 - 0.25, y + sz / 2 + (i > 1 ? sz : 0), z + (i > 1 ? 0.3 : 0), i % 2 ? woodMat : orangeMat);
    }
    addCollider(x - 0.75, x + 0.75, y, y + 1.5, z - 0.6, z + 0.6, 'solid', { mantle: true, name: 'crates', surface: 'wood' });
  }

  /* 塔顶红色障碍灯：黑夜/远景里最像“点光源”的元素 */
  function addBeacons() {
    const tall = buildingBoxes.filter((b) => b.h > 32);
    if (!tall.length) return;
    const geo = new THREE.SphereGeometry(0.45, 8, 6);
    world._beacons = [];
    const m = new THREE.Matrix4();
    for (let gi = 0; gi < 3; gi++) {
      const group = tall.filter((b, i) => i % 3 === gi);
      if (!group.length) continue;
      const inst = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xff3b30, fog: false }), group.length);
      group.forEach((b, i) => {
        m.identity();
        m.setPosition((b.x0 + b.x1) / 2, b.h + 1.1, (b.z0 + b.z1) / 2);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      scene.add(inst);
      world._beacons.push(inst);
    }
  }

  function decorateDetails() {
    let rails = 0, hatches = 0, pipes = 0, dishes = 0, antennas = 0, crates = 0;
    for (const b of buildingBoxes) {
      const area = (b.x1 - b.x0) * (b.z1 - b.z0);
      if (area < 150) continue;
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      /* 檐口压顶：给每栋楼一条出挑的阴影线，天际线更“建模化” */
      if (b.h > 9) {
        batcher.box(w + 0.5, 0.3, 0.42, cx, b.h - 0.22, b.z0 - 0.11, whiteMat);
        batcher.box(w + 0.5, 0.3, 0.42, cx, b.h - 0.22, b.z1 + 0.11, whiteMat);
        batcher.box(0.42, 0.3, d + 0.5, b.x0 - 0.11, b.h - 0.22, cz, whiteMat);
        batcher.box(0.42, 0.3, d + 0.5, b.x1 + 0.11, b.h - 0.22, cz, whiteMat);
      }
      const r = hash2(Math.round(b.x0) + 31, Math.round(b.z0) + 37);
      if (rails < 150 && area > 210 && r < 0.34) { addRoofRailing(b); rails++; continue; }
      if (hatches < 120 && area > 180 && r >= 0.34 && r < 0.52) {
        const sp = findRoofSpot(b, 2.4, 1.8);
        if (sp) { addRoofHatch(b, sp[0], sp[1]); hatches++; continue; }
      }
      if (pipes < 130 && area > 200 && r >= 0.52 && r < 0.7) {
        const sp = findRoofSpot(b, 2.2, 1.4);
        if (sp) { addPipeCluster(b, sp[0], sp[1]); pipes++; continue; }
      }
      if (dishes < 110 && area > 200 && r >= 0.7 && r < 0.83) {
        const sp = findRoofSpot(b, 1.8, 1.8);
        if (sp) { addSatDish(b, sp[0], sp[1]); dishes++; continue; }
      }
      if (antennas < 90 && area > 220 && r >= 0.83 && r < 0.93) {
        const sp = findRoofSpot(b, 1.6, 1.6);
        if (sp) { addAntennaCluster(b, sp[0], sp[1]); antennas++; continue; }
      }
      if (crates < 100 && area > 240) {
        const sp = findRoofSpot(b, 2.8, 2.8);
        if (sp) { addCrates(b, sp[0], sp[1]); crates++; }
      }
    }

    /* ---- 街道细节：防撞柱 / 井盖 / 指示牌 / 花坛 ---- */
    {
      const bolGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.92, 6);
      bolGeo.translate(0, 0.46, 0);
      const bollards = new THREE.InstancedMesh(bolGeo, bollardMat, 420);
      const mhGeo = new THREE.CircleGeometry(0.55, 12);
      mhGeo.rotateX(-Math.PI / 2);
      const manholes = new THREE.InstancedMesh(mhGeo, manholeMat, 300);
      const plantGeoA = new THREE.BoxGeometry(1.7, 0.55, 0.9);
      plantGeoA.translate(0, 0.275, 0);
      const plantGeoB = new THREE.IcosahedronGeometry(0.52, 0);
      plantGeoB.translate(0, 0.85, 0);
      const plantGeoA2 = plantGeoA.toNonIndexed(); plantGeoA2.dispose && plantGeoA.dispose();
      const planterGeo = mergeGeometries([plantGeoA2, plantGeoB], false);
      const planters = new THREE.InstancedMesh(planterGeo, leafMat, 160);
      const m = new THREE.Matrix4();
      let nb = 0, nm = 0, np = 0, signs = 0;
      for (const cell of cellList) {
        const r1 = hash2(cell.i + 701, cell.j + 703);
        /* 井盖：路面上 */
        if (nm < 300 && r1 < 0.9) {
          const x = cell.cx + (r1 - 0.5) * 26;
          const z = cell.cz + PITCH / 2 + (hash2(cell.i + 3, cell.j + 711) - 0.5) * 5;
          if (Math.abs(z) < BAY_Z - 40) {
            m.makeRotationY(r1 * 6.28);
            m.setPosition(x, 0.03, z);
            manholes.setMatrixAt(nm++, m);
          }
        }
        /* 防撞柱：转角人行道 */
        if (nb < 420 && r1 >= 0.2 && r1 < 0.75) {
          const corner = (cell.i + cell.j) % 4;
          const sx = corner === 0 || corner === 3 ? -1 : 1;
          const sz = corner < 2 ? -1 : 1;
          const x0 = cell.cx + sx * 19.5, z0 = cell.cz + sz * 19.5;
          const cnt = 4;
          for (let k = 0; k < cnt && nb < 420; k++) {
            const alongX = k % 2 === 0;
            const x = x0 + (alongX ? (k - 1.5) * 2.1 : 0);
            const z = z0 + (alongX ? 0 : (k - 1.5) * 2.1);
            if (Math.abs(z) > BAY_Z - 40) continue;
            m.identity();
            m.setPosition(x, 0, z);
            bollards.setMatrixAt(nb++, m);
          }
        }
        /* 花坛 + 指示牌 */
        if (np < 160 && r1 >= 0.78 && r1 < 0.88) {
          const x = cell.cx + (hash2(cell.i + 5, cell.j + 717) - 0.5) * 26;
          const z = cell.cz + PITCH / 2 - (hash2(cell.i + 7, cell.j + 719) < 0.5 ? 4.4 : -4.4);
          if (Math.abs(z) < BAY_Z - 40) {
            m.makeRotationY(hash2(cell.i + 9, cell.j + 721) < 0.5 ? 0 : Math.PI / 2);
            m.setPosition(x, 0, z);
            planters.setMatrixAt(np++, m);
            addCollider(x - 0.85, x + 0.85, 0, 0.62, z - 0.45, z + 0.45, 'solid', { mantle: true, name: 'planter', surface: 'concrete' });
          }
        }
        if (signs < 140 && hash2(cell.i + 723, cell.j + 727) < 0.42) {
          const x = cell.cx + (hash2(cell.i + 11, cell.j + 729) - 0.5) * 30;
          const z = cell.cz + PITCH / 2 - 1.0;
          if (Math.abs(z) < BAY_Z - 40) {
            batcher.cyl(0.05, 0.06, 2.6, 6, x, 1.3, z, darkTrimMat);
            batcher.box(0.95, 0.55, 0.06, x + 0.48, 2.5, z, signs % 2 ? signBlueMat : signWhiteMat);
            signs++;
          }
        }
      }
      bollards.count = nb; bollards.instanceMatrix.needsUpdate = true; bollards.frustumCulled = false;
      manholes.count = nm; manholes.instanceMatrix.needsUpdate = true; manholes.frustumCulled = false;
      planters.count = np; planters.instanceMatrix.needsUpdate = true; planters.frustumCulled = false;
      scene.add(bollards); scene.add(manholes); scene.add(planters);
    }
  }

  function streetProps() {
    const lampGeos = [];
    {
      const pole = new THREE.CylinderGeometry(0.09, 0.13, 5.4, 6);
      pole.translate(0, 2.7, 0);
      const arm = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
      arm.rotateZ(Math.PI / 2);
      arm.translate(0.8, 5.3, 0);
      const head = new THREE.BoxGeometry(0.7, 0.16, 0.3);
      head.translate(1.5, 5.25, 0);
      lampGeos.push(pole, arm, head);
    }
    const lampGeo = mergeGeometries(lampGeos, false);
    const lampCount = 260;
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshStandardMaterial({ color: 0x8f9aa2, roughness: 0.6, metalness: 0.5 }), lampCount);
    /* 暖色灯头 + 体积光锥（点光源的可见光迹） */
    const lampHeadGeo = new THREE.BoxGeometry(0.8, 0.2, 0.36);
    const lampHeads = new THREE.InstancedMesh(lampHeadGeo,
      new THREE.MeshStandardMaterial({ color: 0xfff3d2, emissive: 0xffc678, emissiveIntensity: 1.5, roughness: 0.4 }), lampCount);
    const lampConeGeo = new THREE.ConeGeometry(2.35, 5.0, 14, 1, true);
    const lampCones = new THREE.InstancedMesh(lampConeGeo,
      new THREE.MeshBasicMaterial({ color: 0xffe0ad, transparent: true, opacity: 0.075, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }), lampCount);
    {
      const m = new THREE.Matrix4();
      let n = 0;
      for (const cell of cellList) {
        if (n >= lampCount) break;
        const r = hash2(cell.i + 501, cell.j + 503);
        if (r > 0.75) continue;
        const x = cell.cx + (r - 0.5) * 30;
        const z = cell.cz + PITCH / 2 - 1.2;
        if (Math.abs(z) > BAY_Z - 40) continue;
        const yaw = r * 6.28;
        m.makeRotationY(yaw);
        m.setPosition(x, 0, z);
        lamps.setMatrixAt(n, m);
        const hx = x + Math.cos(yaw) * 1.5, hz = z - Math.sin(yaw) * 1.5;
        m.makeRotationY(yaw);
        m.setPosition(hx, 5.26, hz);
        lampHeads.setMatrixAt(n, m);
        m.identity();
        m.setPosition(hx, 2.75, hz);
        lampCones.setMatrixAt(n, m);
        n++;
      }
      lamps.count = n;
      lampHeads.count = n;
      lampCones.count = n;
      for (const inst of [lamps, lampHeads, lampCones]) {
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        scene.add(inst);
      }
    }
    /* 停靠车辆 */
    const carBody = new THREE.BoxGeometry(4.1, 0.9, 1.85);
    carBody.translate(0, 0.72, 0);
    const carCab = new THREE.BoxGeometry(2.1, 0.7, 1.7);
    carCab.translate(-0.2, 1.5, 0);
    const carGeo = mergeGeometries([carBody, carCab], false);
    const carCount = 170;
    const cars = new THREE.InstancedMesh(carGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.4 }), carCount);
    const carCols = [new THREE.Color(0xd8dde0), new THREE.Color(0xb9c2c7), new THREE.Color(0x37424a), new THREE.Color(0xef8527), new THREE.Color(0x2f6fb0), new THREE.Color(0xe8e2d4)];
    {
      const m = new THREE.Matrix4();
      const col = new THREE.Color();
      let n = 0;
      for (const cell of cellList) {
        if (n >= carCount) break;
        const r = hash2(cell.i + 601, cell.j + 607);
        if (r > 0.55) continue;
        const k = 1 + Math.floor(r * 3);
        for (let c = 0; c < k && n < carCount; c++) {
          const alongX = hash2(cell.i + c, cell.j + 5) < 0.5;
          const off = (hash2(cell.i + c * 3, cell.j + 7) - 0.5) * 30;
          const x = alongX ? cell.cx + off : cell.cx + PITCH / 2 - 2.6;
          const z = alongX ? cell.cz + PITCH / 2 - 2.6 : cell.cz + off;
          if (Math.abs(z) > BAY_Z - 30) continue;
          m.makeRotationY(alongX ? 0 : Math.PI / 2);
          m.setPosition(x, 0, z);
          cars.setMatrixAt(n, m);
          col.copy(carCols[Math.floor(hash2(cell.i + c * 11, cell.j + 13) * carCols.length) % carCols.length]);
          cars.setColorAt(n, col);
          n++;
        }
      }
      cars.count = n;
      cars.instanceMatrix.needsUpdate = true;
      if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
      cars.castShadow = true;
      cars.frustumCulled = false;
      scene.add(cars);
    }
    /* 老城 / 公园区树木 */
    const treeGeos = [];
    {
      const trunk = new THREE.CylinderGeometry(0.16, 0.22, 3.2, 6).toNonIndexed();
      trunk.translate(0, 1.6, 0);
      const crown = new THREE.IcosahedronGeometry(1.9, 1);
      crown.translate(0, 4.2, 0);
      treeGeos.push(trunk, crown);
    }
    const treeGeo = mergeGeometries(treeGeos, false);
    const treeCount = 90;
    const trees = new THREE.InstancedMesh(treeGeo, leafMat, treeCount);
    {
      const m = new THREE.Matrix4();
      let n = 0;
      for (const cell of cellList) {
        if (n >= treeCount) break;
        const dq = districtAt(cell.cx, cell.cz);
        if (dq.key !== 'OLDTOWN' && dq.key !== 'GREEN') continue;
        if (hash2(cell.i + 701, cell.j + 707) > 0.4) continue;
        const s = 1 + hash2(cell.i + 4, cell.j + 9) * 0.7;
        m.makeScale(s, s, s);
        m.setPosition(cell.cx + (hash2(cell.i + 8, cell.j) - 0.5) * PITCH, 0, cell.cz + PITCH / 2 - 2);
        trees.setMatrixAt(n++, m);
      }
      trees.count = n;
      trees.instanceMatrix.needsUpdate = true;
      trees.castShadow = true;
      trees.frustumCulled = false;
      scene.add(trees);
    }
  }

  /* ------------------------------------------------ 街道生活 / 屋顶杂物 */
  function streetLife() {
    const benchWood = new THREE.MeshStandardMaterial({ color: 0x9a6b3f, roughness: 0.85 });
    const binMat = new THREE.MeshStandardMaterial({ color: 0x39424a, roughness: 0.7, metalness: 0.3 });
    const hydrantMat = new THREE.MeshStandardMaterial({ color: 0xd8402e, roughness: 0.5 });
    const shelterMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ea, roughness: 0.4, metalness: 0.2 });
    const trafficMat = new THREE.MeshStandardMaterial({ color: 0x242b31, roughness: 0.6 });
    const ledR = new THREE.MeshBasicMaterial({ color: 0xff3b30, fog: false });
    const ledG = new THREE.MeshBasicMaterial({ color: 0x3bf08a, fog: false });
    const wireMat = new THREE.MeshStandardMaterial({ color: 0x1f2428, roughness: 0.6 });
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffe2ad, fog: false });
    let bench = 0, bins = 0, hyd = 0, sig = 0, shel = 0, cable = 0;
    for (const cell of cellList) {
      const r = hash2(cell.i + 811, cell.j + 823);
      const zEdge = cell.cz + PITCH / 2 - 1.0;
      const zFar = cell.cz - PITCH / 2 + 1.0;
      const xEdge = cell.cx + PITCH / 2 - 1.0;
      if (Math.abs(zEdge) > BAY_Z - 40) continue;
      if (r < 0.3 && bench < 120) {
        const x = cell.cx + (hash2(cell.i + 3, cell.j + 5) - 0.5) * 22;
        batcher.box(1.9, 0.09, 0.46, x, 0.5, zEdge, benchWood);
        batcher.box(1.9, 0.34, 0.06, x, 0.72, zEdge - 0.22, benchWood);
        for (const ox of [-0.74, 0.74]) batcher.box(0.07, 0.52, 0.44, x + ox, 0.26, zEdge, wireMat);
        bench++;
      }
      if (r >= 0.3 && r < 0.44 && bins < 130) {
        const x = cell.cx + (hash2(cell.i + 7, cell.j + 9) - 0.5) * 24;
        batcher.cyl(0.3, 0.26, 1.0, 10, x, 0.5, zEdge, binMat);
        batcher.cyl(0.33, 0.33, 0.07, 10, x, 1.03, zEdge, wireMat);
        bins++;
      }
      if (r >= 0.44 && r < 0.55 && hyd < 90) {
        const x = cell.cx + (hash2(cell.i + 11, cell.j + 13) - 0.5) * 20;
        batcher.cyl(0.14, 0.17, 0.66, 8, x, 0.33, zEdge, hydrantMat);
        batcher.cyl(0.1, 0.1, 0.2, 8, x, 0.76, zEdge, hydrantMat);
        batcher.box(0.42, 0.1, 0.12, x, 0.5, zEdge, hydrantMat);
        hyd++;
      }
      if (r >= 0.55 && r < 0.63 && sig < 70) {
        const x = cell.cx + (hash2(cell.i + 17, cell.j + 19) - 0.5) * 16;
        batcher.cyl(0.09, 0.12, 4.6, 8, x, 2.3, zEdge, trafficMat);
        batcher.box(2.2, 0.11, 0.11, x + Math.sign(xEdge - x || 1) * 1.1, 4.5, zEdge, trafficMat);
        const hx = x + Math.sign(xEdge - x || 1) * 2.1;
        batcher.box(0.3, 0.86, 0.2, hx, 4.15, zEdge, trafficMat);
        for (let k = 0; k < 3; k++) {
          const lm = k === 2 ? ledG : (k === 0 ? ledR : bulbMat);
          batcher.box(0.16, 0.16, 0.06, hx - 0.18, 4.42 - k * 0.26, zEdge, lm);
        }
        sig++;
      }
      if (r >= 0.63 && r < 0.68 && shel < 26) {
        const x = cell.cx + (hash2(cell.i + 23, cell.j + 29) - 0.5) * 18;
        for (const ox of [-1.7, 1.7]) batcher.box(0.1, 2.5, 0.1, x + ox, 1.25, zEdge, wireMat);
        batcher.box(3.9, 0.12, 1.5, x, 2.55, zEdge + 0.35, shelterMat);
        batcher.box(3.9, 0.06, 1.5, x, 2.63, zEdge + 0.35, glassDarkMat);
        batcher.box(3.4, 0.09, 0.42, x, 0.52, zEdge + 0.5, benchWood);
        batcher.box(2.4, 1.6, 0.06, x - 0.7, 1.35, zEdge - 0.5, glassDarkMat);
        shel++;
      }
      /* 跨街灯串：两段悬垂线 + 小灯泡，黄昏时最有城市味 */
      if (r >= 0.7 && r < 0.74 && cable < 40) {
        const x0 = cell.cx - 8, x1 = cell.cx + 8;
        const yTop = 5.6, sag = 1.4;
        for (let s = 0; s < 6; s++) {
          const t0 = s / 6, t1 = (s + 1) / 6;
          const xa = x0 + (x1 - x0) * t0, xb = x0 + (x1 - x0) * t1;
          const ya = yTop - Math.sin(t0 * Math.PI) * sag;
          const yb = yTop - Math.sin(t1 * Math.PI) * sag;
          const cx2 = (xa + xb) / 2, cy2 = (ya + yb) / 2;
          const len = Math.hypot(xb - xa, yb - ya);
          batcher.cyl(0.02, 0.02, len, 4, cx2, cy2, zEdge, wireMat, 0, 0, Math.PI / 2 - Math.atan2(yb - ya, xb - xa));
          if (s % 2 === 1) batcher.box(0.1, 0.12, 0.1, xa, ya - 0.12, zEdge, bulbMat);
        }
        cable++;
      }
    }
    /* 街道另一侧：再铺一遍，让街面真正有生活密度 */
    for (const cell of cellList) {
      const r2 = hash2(cell.i + 941, cell.j + 947);
      const zFar = cell.cz - PITCH / 2 + 1.0;
      if (Math.abs(zFar) > BAY_Z - 40) continue;
      if (r2 < 0.34 && bench < 120) {
        const x = cell.cx + (hash2(cell.i + 13, cell.j + 14) - 0.5) * 22;
        batcher.box(1.9, 0.09, 0.46, x, 0.5, zFar, benchWood);
        batcher.box(1.9, 0.34, 0.06, x, 0.72, zFar + 0.22, benchWood);
        for (const ox of [-0.74, 0.74]) batcher.box(0.07, 0.52, 0.44, x + ox, 0.26, zFar, wireMat);
        bench++;
      }
      if (r2 >= 0.34 && r2 < 0.5 && bins < 130) {
        const x = cell.cx + (hash2(cell.i + 15, cell.j + 16) - 0.5) * 24;
        batcher.cyl(0.3, 0.26, 1.0, 10, x, 0.5, zFar, binMat);
        batcher.cyl(0.33, 0.33, 0.07, 10, x, 1.03, zFar, wireMat);
        bins++;
      }
      if (r2 >= 0.5 && r2 < 0.62 && hyd < 90) {
        const x = cell.cx + (hash2(cell.i + 19, cell.j + 21) - 0.5) * 20;
        batcher.cyl(0.14, 0.17, 0.66, 8, x, 0.33, zFar, hydrantMat);
        batcher.cyl(0.1, 0.1, 0.2, 8, x, 0.76, zFar, hydrantMat);
        batcher.box(0.42, 0.1, 0.12, x, 0.5, zFar, hydrantMat);
        hyd++;
      }
      if (r2 >= 0.62 && r2 < 0.72 && sig < 70) {
        const x = cell.cx + (hash2(cell.i + 25, cell.j + 27) - 0.5) * 16;
        batcher.cyl(0.09, 0.12, 4.6, 8, x, 2.3, zFar, trafficMat);
        batcher.box(2.2, 0.11, 0.11, x + 1.1, 4.5, zFar, trafficMat);
        batcher.box(0.3, 0.86, 0.2, x + 2.1, 4.15, zFar, trafficMat);
        for (let k = 0; k < 3; k++) {
          const lm = k === 2 ? ledG : (k === 0 ? ledR : bulbMat);
          batcher.box(0.16, 0.16, 0.06, x + 1.92, 4.42 - k * 0.26, zFar, lm);
        }
        sig++;
      }
      if (r2 >= 0.72 && r2 < 0.77 && shel < 26) {
        const x = cell.cx + (hash2(cell.i + 31, cell.j + 33) - 0.5) * 18;
        for (const ox of [-1.7, 1.7]) batcher.box(0.1, 2.5, 0.1, x + ox, 1.25, zFar, wireMat);
        batcher.box(3.9, 0.12, 1.5, x, 2.55, zFar - 0.35, shelterMat);
        batcher.box(3.9, 0.06, 1.5, x, 2.63, zFar - 0.35, glassDarkMat);
        batcher.box(3.4, 0.09, 0.42, x, 0.52, zFar - 0.5, benchWood);
        batcher.box(2.4, 1.6, 0.06, x - 0.7, 1.35, zFar + 0.5, glassDarkMat);
        shel++;
      }
    }
    return { bench, bins, hyd, sig, shel, cable };
  }

  /* 屋顶晾衣/遮阳棚、托盘、线缆盘：让屋顶像真的有人生活过 */
  function roofClutter() {
    const tarpMats = [
      new THREE.MeshStandardMaterial({ color: 0xdf7a2a, roughness: 0.85, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.85, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0x3f8f6a, roughness: 0.85, side: THREE.DoubleSide }),
      new THREE.MeshStandardMaterial({ color: 0xd8d2c2, roughness: 0.9, side: THREE.DoubleSide }),
    ];
    const palletMat = new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.9 });
    const reelMat = new THREE.MeshStandardMaterial({ color: 0x6a737a, roughness: 0.7, metalness: 0.3 });
    let tarps = 0, pallets = 0, reels = 0;
    for (const b of buildingBoxes) {
      const area = (b.x1 - b.x0) * (b.z1 - b.z0);
      if (area < 180) continue;
      const r = hash2(Math.round(b.x0) + 881, Math.round(b.z0) + 883);
      const spot = findRoofSpot(b, 3.4, 3.4);
      if (!spot) continue;
      const x = spot[0], z = spot[1], y = b.h;
      if (r < 0.16 && tarps < 90) {
        const mat = tarpMats[Math.floor(r * 997) % tarpMats.length];
        const w = 2.6 + r * 2, d = 2.2 + r * 1.6, hgt = 1.3 + r * 0.7;
        for (const [ox, oz] of [[-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
          batcher.box(0.07, hgt, 0.07, x + ox, y + hgt / 2, z + oz, darkTrimMat);
        }
        batcher.boxR(w + 0.5, 0.07, d + 0.5, x, y + hgt, z, mat, 0.12, 0, 0.08);
        tarps++;
      } else if (r >= 0.16 && r < 0.3 && pallets < 90) {
        for (let k = 0; k < 3; k++) {
          batcher.box(1.6, 0.1, 1.2, x, y + 0.08 + k * 0.16, z, palletMat);
          if (k < 2) batcher.box(1.5, 0.06, 0.16, x, y + 0.15 + k * 0.16, z - 0.4, palletMat);
        }
        addCollider(x - 0.85, x + 0.85, y, y + 0.8, z - 0.65, z + 0.65, 'solid', { mantle: true, name: 'pallets', surface: 'wood' });
        pallets++;
      } else if (r >= 0.3 && r < 0.38 && reels < 55) {
        batcher.cyl(1.0, 1.0, 0.16, 14, x, y + 0.9, z, reelMat, Math.PI / 2, 0, 0);
        batcher.cyl(1.0, 1.0, 0.16, 14, x, y + 0.9, z + 0.7, reelMat, Math.PI / 2, 0, 0);
        batcher.cyl(0.18, 0.18, 0.7, 8, x, y + 0.9, z + 0.35, darkTrimMat, Math.PI / 2, 0, 0);
        addCollider(x - 0.9, x + 0.9, y, y + 1.9, z - 0.5, z + 1.2, 'solid', { mantle: true, name: 'reel', surface: 'metal' });
        reels++;
      }
    }
    return { tarps, pallets, reels };
  }

  /* ------------------------------------------------ 动态广告牌 */
  function addAnimatedBillboards() {
    const ADS = [
      { text: 'PK', sub: 'PROTECT THE CITY', bg: '#12171d', accent: '#e8462a' },
      { text: 'NICA', sub: 'RUN THE ROOFLINES', bg: '#0e1620', accent: '#5ad7ff' },
      { text: 'CITY 08', sub: 'LIVE THE FLOW', bg: '#101418', accent: '#ffd75e' },
      { text: 'RAPOSA', sub: 'MOVE DIFFERENT', bg: '#140f16', accent: '#b18cff' },
      { text: 'MERIDIAN', sub: 'CLEAN LINES', bg: '#0d1418', accent: '#7dffb0' },
      { text: 'DAILY CITY', sub: 'NO STREETS ONLY ROOFS', bg: '#12161a', accent: '#ef8527' },
    ];
    const boards = [];
    const tall = buildingBoxes.filter((b) => b.h > 16 && (b.x1 - b.x0) > 12 && (b.z1 - b.z0) > 12);
    if (!tall.length) return;
    const count = Math.min(12, tall.length);
    for (let i = 0; i < count; i++) {
      const b = tall[(i * 53 + 17) % tall.length];
      if (!b) continue;
      const ad = ADS[i % ADS.length];
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 160;
      const ctx = canvas.getContext('2d');
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: true, side: THREE.DoubleSide });
      const w = 8.6, h = 4.3;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const face = i % 4;
      let x = cx, z = cz, ry = 0;
      if (face === 0) { z = b.z0 - 0.4; ry = Math.PI; }
      else if (face === 1) { z = b.z1 + 0.4; ry = 0; }
      else if (face === 2) { x = b.x0 - 0.4; ry = -Math.PI / 2; }
      else { x = b.x1 + 0.4; ry = Math.PI / 2; }
      mesh.position.set(x, b.h + h / 2 + 2.0, z);
      mesh.rotation.y = ry;
      scene.add(mesh);
      /* 支撑腿 */
      const tx = Math.cos(ry), tz = -Math.sin(ry);
      for (const s of [-1, 1]) {
        batcher.box(0.14, 2.2, 0.14, x + tx * s * w * 0.34, b.h + 1.1, z + tz * s * w * 0.34, darkTrimMat);
      }
      const draw = () => {
        const t = performance.now() * 0.001;
        ctx.fillStyle = ad.bg;
        ctx.fillRect(0, 0, 320, 160);
        /* 移动斜条纹 */
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = ad.accent;
        const shift = (t * 26 + i * 40) % 80;
        for (let sx = -160; sx < 480; sx += 80) {
          ctx.beginPath();
          ctx.moveTo(sx + shift, 0);
          ctx.lineTo(sx + shift + 26, 0);
          ctx.lineTo(sx + shift - 26, 160);
          ctx.lineTo(sx + shift - 52, 160);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
        /* 主标 */
        ctx.fillStyle = '#ffffff';
        ctx.font = '900 74px "Segoe UI", "PingFang SC", sans-serif';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(ad.text, 18, 92);
        /* 副标 */
        ctx.fillStyle = ad.accent;
        ctx.font = '600 17px "Segoe UI", "PingFang SC", sans-serif';
        ctx.fillText(ad.sub, 20, 122);
        /* 底部进度条 */
        const barW = 140 + Math.sin(t * 1.3 + i) * 40;
        ctx.fillStyle = ad.accent;
        ctx.fillRect(20, 136, Math.max(20, barW), 5);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(20 + Math.max(20, barW) + 6, 136, 260, 5);
        /* 扫描线 */
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        for (let yy = 0; yy < 160; yy += 4) ctx.fillRect(0, yy, 320, 1);
        tex.needsUpdate = true;
      };
      draw();
      boards.push({ draw, tex });
    }
    world.boards = boards;
    let acc = 0, idx = 0;
    world.updateBoards = (dt) => {
      acc += dt;
      if (acc < 0.1) return;
      acc = 0;
      const b = boards[idx++ % boards.length];
      if (b) b.draw();
    };
  }

  progress(0.54); await yieldFrame();
  streetProps();
  decorateDetails();
  addBeacons();
  const lifeStats = streetLife();
  const clutterStats = roofClutter();
  addAnimatedBillboards();

  /* ------------------------------------------------ 楼间跨越设施 */
  const cellMap = new Map();
  for (const c of cellList) cellMap.set(`${c.i},${c.j}`, c);

  function addBridge(a, b) {
    const top = Math.max(a.main.h, b.main.h);
    const alongX = a.j === b.j;
    if (alongX) {
      /* 只跨两楼之间的街道（楼缘到楼缘），不再横跨整个屋顶 */
      const x0 = Math.min(a.main.x1, b.main.x0) - 0.6;
      const x1 = Math.max(a.main.x1, b.main.x0) + 0.6;
      if (x1 - x0 > 40) return false;
      const z = (a.cz + b.cz) / 2;
      if (pathBlocked(new THREE.Vector3(a.cx, top + 1, z), new THREE.Vector3(b.cx, top + 1, z), 10)) return false;
      batcher.box(x1 - x0, 0.24, 1.8, (x0 + x1) / 2, top - 0.06, z, whiteMat);
      batcher.plane(x1 - x0, 1.8, (x0 + x1) / 2, top + 0.065, z, roofMat);
      addCollider(x0, x1, top - 0.18, top + 0.06, z - 0.9, z + 0.9, 'solid', { mantle: true, name: 'skybridge', surface: 'metal' });
      batcher.box(x1 - x0, 0.06, 0.06, (x0 + x1) / 2, top + 1.0, z - 0.88, whiteMat);
      batcher.box(x1 - x0, 0.06, 0.06, (x0 + x1) / 2, top + 1.0, z + 0.88, whiteMat);
      for (let bx = x0 + 0.6; bx < x1 - 0.4; bx += 2.2) {
        batcher.box(0.06, 0.95, 0.06, bx, top + 0.5, z - 0.88, whiteMat);
        batcher.box(0.06, 0.95, 0.06, bx, top + 0.5, z + 0.88, whiteMat);
      }
    } else {
      const z0 = Math.min(a.main.z1, b.main.z0) - 0.6;
      const z1 = Math.max(a.main.z1, b.main.z0) + 0.6;
      if (z1 - z0 > 40) return false;
      const x = (a.cx + b.cx) / 2;
      if (pathBlocked(new THREE.Vector3(x, top + 1, a.cz), new THREE.Vector3(x, top + 1, b.cz), 10)) return false;
      batcher.box(1.8, 0.24, z1 - z0, x, top - 0.06, (z0 + z1) / 2, whiteMat);
      batcher.plane(1.8, z1 - z0, x, top + 0.065, (z0 + z1) / 2, roofMat);
      addCollider(x - 0.9, x + 0.9, top - 0.18, top + 0.06, z0, z1, 'solid', { mantle: true, name: 'skybridge', surface: 'metal' });
      batcher.box(0.06, 0.06, z1 - z0, x - 0.88, top + 1.0, (z0 + z1) / 2, whiteMat);
      batcher.box(0.06, 0.06, z1 - z0, x + 0.88, top + 1.0, (z0 + z1) / 2, whiteMat);
      for (let bz = z0 + 0.6; bz < z1 - 0.4; bz += 2.2) {
        batcher.box(0.06, 0.95, 0.06, x - 0.88, top + 0.5, bz, whiteMat);
        batcher.box(0.06, 0.95, 0.06, x + 0.88, top + 0.5, bz, whiteMat);
      }
    }
    return true;
  }

  /* 沿楼缘向内找锚点：确保该点正下方就是本楼屋顶（而不是别的楼/空中） */
  function roofAnchor(box, dirX, dirZ, expectH) {
    const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
    const hw = (box.x1 - box.x0) / 2, hd = (box.z1 - box.z0) / 2;
    const ax = Math.abs(dirX) >= Math.abs(dirZ);
    for (let step = 0; step <= 9; step++) {
      const inset = 0.5 + step * 0.7;
      let x, z;
      if (ax) {
        const sx = Math.sign(dirX) || 1;
        x = cx + sx * Math.max(0.4, hw - inset);
        z = cz;
      } else {
        const sz = Math.sign(dirZ) || 1;
        x = cx;
        z = cz + sz * Math.max(0.4, hd - inset);
      }
      if ((ax && Math.abs(x - cx) > hw - 0.3) || (!ax && Math.abs(z - cz) > hd - 0.3)) continue;
      const g = world.rayDown(x, z, expectH + 16, 80);
      if (g !== null && Math.abs(g - expectH) < 1.2) return { x, z, ground: g };
    }
    return null;
  }

  function addCrossZip(a, b) {
    const hCell = a.main.h >= b.main.h ? a : b;
    const lCell = hCell === a ? b : a;
    const hb = hCell.main, lb = lCell.main;
    const hcx = (hb.x0 + hb.x1) / 2, hcz = (hb.z0 + hb.z1) / 2;
    const lcx = (lb.x0 + lb.x1) / 2, lcz = (lb.z0 + lb.z1) / 2;
    const dx = lcx - hcx, dz = lcz - hcz;
    /* 端点必须落在本楼屋顶上（自动向内扫描） */
    const ha = roofAnchor(hb, dx, dz, hb.h);
    const la = roofAnchor(lb, -dx, -dz, lb.h);
    if (!ha || !la) return false;
    const from = new THREE.Vector3(ha.x, ha.ground + 1.1, ha.z);
    const to = new THREE.Vector3(la.x, la.ground + 2.0, la.z);
    const drop = from.y - to.y;
    if (drop < 2.5 || drop > 95) return false;
    const ignores = new Set([`b-${hCell.i}-${hCell.j}`, `b-${lCell.i}-${lCell.j}`]);
    if (pathBlocked(from, to, 24, ignores)) return false;
    if (!addZipEntry([from.x, from.y, from.z], [to.x, to.y, to.z], 0.94)) return false;
    return true;
  }

  function addCrossSpring(a, b) {
    const hiCell = a.main.h >= b.main.h ? a : b;
    const loCell = hiCell === a ? b : a;
    const hb = hiCell.main, lb = loCell.main;
    const dy = hb.h - lb.h;
    if (dy < 0.8 || dy > 6.5) return false;
    const hcx = (hb.x0 + hb.x1) / 2, hcz = (hb.z0 + hb.z1) / 2;
    const lcx = (lb.x0 + lb.x1) / 2, lcz = (lb.z0 + lb.z1) / 2;
    const dx = hcx - lcx, dz = hcz - lcz;
    const adx = Math.abs(dx), adz = Math.abs(dz);
    const hw = (hb.x1 - hb.x0) / 2, hd = (hb.z1 - hb.z0) / 2;
    const lw = (lb.x1 - lb.x0) / 2, ld = (lb.z1 - lb.z0) / 2;
    let px, pz, tx, tz;
    if (adx >= adz) {
      const sx = Math.sign(dx) || 1;
      px = lcx + sx * (lw + 0.7); pz = lcz;
      tx = hcx - sx * (hw + 0.9); tz = hcz;
    } else {
      const sz = Math.sign(dz) || 1;
      px = lcx; pz = lcz + sz * (ld + 0.7);
      tx = hcx; tz = hcz - sz * (hd + 0.9);
    }
    const dist = Math.hypot(tx - px, tz - pz);
    if (dist < 4 || dist > 34) return false;
    /* 选择水平速度，使所需垂直速度 ≤ 24（保证真能落到对面） */
    let chosen = null;
    for (let vx = 16; vx >= 8; vx -= 1) {
      const t = dist / vx;
      const vy = (dy + 0.5 * PHYS.GRAVITY * t * t) / t;
      if (vy <= 24) { chosen = { vx, vy }; break; }
    }
    if (!chosen) return false;
    const nx = (tx - px) / dist, nz = (tz - pz) / dist;
    if (pathBlocked(new THREE.Vector3(px, lb.h + 1.2, pz), new THREE.Vector3(tx, hb.h + 1.6, tz), 24)) return false;
    addSpringboard(px - 0.8, px + 0.8, lb.h, lb.h + 0.35, pz - 1.2, pz + 1.2, [nx * chosen.vx, chosen.vy, nz * chosen.vx]);
    return true;
  }

  function connectCells() {
    let bridges = 0, zips = 0, springs = 0, wallruns = 0, towerZips = 0, repairs = 0, deadends = 0;
    const key = (c) => `${c.i},${c.j}`;
    const edges = new Map();
    const touch = (c) => { let set = edges.get(key(c)); if (!set) { set = new Set(); edges.set(key(c), set); } return set; };
    const addEdge = (a, b) => { if (a !== b) touch(a).add(key(b)); };
    const hasEdge = (a, b) => { const set = edges.get(key(a)); return !!set && set.has(key(b)); };

    /* 有向连接：只有确实建立了 from → to 的通路才记账 */
    function tryDirected(a, b, relaxed = false) {
      if (hasEdge(a, b)) return false;
      const dy = a.main.h - b.main.h;
      const ady = Math.abs(dy);
      if (dy > 2.5 && addCrossZip(a, b)) { addEdge(a, b); zips++; return true; }            // 高楼 → 低楼：滑索
      if (ady <= 2.2 && addBridge(a, b)) { addEdge(a, b); addEdge(b, a); bridges++; return true; } // 高差很小：天桥（双向）
      /* 低楼 → 高楼：弹簧板（初始只放一部分，修复阶段会补齐必需项，避免满城弹板） */
      if (dy < 0 && ady <= 12 && (relaxed || hash2(a.i * 7 + b.i, a.j * 11 + b.j) < 0.4) && addCrossSpring(a, b)) {
        addEdge(a, b); springs++; return true;
      }
      if (relaxed && dy < 0 && ady <= 16 && addCrossSpring(a, b)) { addEdge(a, b); springs++; return true; }
      return false;
    }
    const neighborsOf = (c) => [[1, 0], [0, 1], [-1, 0], [0, -1]]
      .map(([di, dj]) => cellMap.get(`${c.i + di},${c.j + dj}`)).filter(Boolean);

    /* 1) 初始连接：右 / 下邻居，两个方向各试一次 */
    for (const cell of cellList) {
      for (const [di, dj] of [[1, 0], [0, 1]]) {
        const nb = cellMap.get(`${cell.i + di},${cell.j + dj}`);
        if (!nb) continue;
        const r = hash2(cell.i * 31 + nb.j * 17, cell.j * 13 + nb.i * 7);
        if (r < 0.5) { tryDirected(cell, nb); tryDirected(nb, cell); }
        else { tryDirected(nb, cell); tryDirected(cell, nb); }
      }
    }
    /* 2) 教学区连接桥：走廊两侧的街区作为连通根 */
    const roots = new Set();
    for (const cell of cellList) {
      if (Math.abs(cell.cz) > PITCH + 2) continue;
      if (cell.cx > corridor.x0 - 30 && cell.cx < corridor.x1 + 30) {
        const courseH = courseHeightAtX(clamp(cell.cx, -6, 170));
        const top = Math.max(cell.main.h, courseH);
        const zEdge = cell.cz > 0 ? corridor.z1 : corridor.z0;
        const zNear = cell.cz > 0 ? cell.main.z0 : cell.main.z1;
        if (pathBlocked(new THREE.Vector3(cell.cx, top + 1, zEdge), new THREE.Vector3(cell.cx, top + 1, zNear), 10)) { roots.add(key(cell)); continue; }
        batcher.box(1.8, 0.24, Math.abs(zNear - zEdge), cell.cx, top - 0.06, (zEdge + zNear) / 2, whiteMat);
        batcher.plane(1.8, Math.abs(zNear - zEdge), cell.cx, top + 0.065, (zEdge + zNear) / 2, roofMat);
        addCollider(cell.cx - 0.9, cell.cx + 0.9, top - 0.18, top + 0.06, Math.min(zEdge, zNear), Math.max(zEdge, zNear), 'solid', { mantle: true, name: 'skybridge', surface: 'metal' });
        bridges++;
        roots.add(key(cell));
      }
    }
    /* 3) 塔顶滑索：从塔顶滑向邻区（配合塔身攀爬管，上下都有路） */
    for (const cell of cellList) {
      if (towerZips >= 40 || !cell.towerInfo) continue;
      if (hash2(cell.i + 907, cell.j + 911) > 0.55) continue;
      const ti = cell.towerInfo;
      let best = null, bestScore = 1e9;
      for (const nb of neighborsOf(cell)) {
        const dx = nb.cx - cell.cx, dz = nb.cz - cell.cz;
        const dist = Math.hypot(dx, dz);
        if (dist < 20 || dist > 84) continue;
        const drop = ti.h - nb.main.h;
        if (drop < 8 || drop > 90) continue;
        const score = Math.abs(dist - 42) + Math.abs(drop - 26) * 0.5;
        if (score < bestScore) { bestScore = score; best = nb; }
      }
      if (!best) continue;
      const dx = best.cx - cell.cx, dz = best.cz - cell.cz;
      const ha = roofAnchor(ti, dx, dz, ti.h);
      const la = roofAnchor(best.main, -dx, -dz, best.main.h);
      if (!ha || !la) continue;
      const from = new THREE.Vector3(ha.x, ha.ground + 1.2, ha.z);
      const to = new THREE.Vector3(la.x, la.ground + 2.0, la.z);
      const ignores = new Set([`b-${cell.i}-${cell.j}`, `b-${best.i}-${best.j}`]);
      if (pathBlocked(from, to, 18, ignores)) continue;
      if (!addZipEntry([from.x, from.y, from.z], [to.x, to.y, to.z], 0.94)) continue;
      addEdge(cell, best);
      zips++;
      towerZips++;
    }
    /* 4) 可达性修复：从教学区出发 BFS，给够不到的街区补一条进路 */
    const bfs = () => {
      const seen = new Set(roots);
      const queue = [...roots];
      while (queue.length) {
        const k = queue.shift();
        const outs = edges.get(k);
        if (!outs) continue;
        for (const nk of outs) if (!seen.has(nk)) { seen.add(nk); queue.push(nk); }
      }
      return seen;
    };
    let seen = bfs();
    for (let pass = 0; pass < 4; pass++) {
      let fixed = 0;
      for (const cell of cellList) {
        if (seen.has(key(cell))) continue;
        for (const nb of neighborsOf(cell)) {
          if (!seen.has(key(nb))) continue;
          if (tryDirected(nb, cell, true)) { fixed++; seen = bfs(); break; }
        }
      }
      repairs += fixed;
      if (!fixed) break;
    }
    /* 反向可达：能出去的楼也应该能"回家"（从任何屋顶都能回到教学区） */
    const revEdges = new Map();
    for (const [from, set] of edges) {
      for (const to of set) {
        let rs = revEdges.get(to);
        if (!rs) { rs = new Set(); revEdges.set(to, rs); }
        rs.add(from);
      }
    }
    const reachRoots = () => {
      const can = new Set(roots);
      const queue = [...roots];
      while (queue.length) {
        const k = queue.shift();
        const rs = revEdges.get(k);
        if (!rs) continue;
        for (const rk of rs) if (!can.has(rk)) { can.add(rk); queue.push(rk); }
      }
      return can;
    };
    let home = reachRoots();
    for (let pass = 0; pass < 6; pass++) {
      let fixed = 0;
      for (const cell of cellList) {
        if (home.has(key(cell))) continue;
        for (const nb of neighborsOf(cell)) {
          if (!home.has(key(nb))) continue;
          if (tryDirected(cell, nb, true)) {
            /* 新边加入后重建反向表 */
            let rs = revEdges.get(key(nb));
            if (!rs) { rs = new Set(); revEdges.set(key(nb), rs); }
            rs.add(key(cell));
            fixed++;
            home = reachRoots();
            break;
          }
        }
      }
      repairs += fixed;
      if (!fixed) break;
    }
    /* 最后兜底：极个别街区仍不可达时，忽略遮挡强接一条 */
    const finalSeen = bfs();
    for (const cell of cellList) {
      if (finalSeen.has(key(cell))) continue;
      ignorePathCheck = true;
      for (const nb of neighborsOf(cell)) {
        if (!finalSeen.has(key(nb))) continue;
        if (tryDirected(nb, cell, true)) { repairs++; break; }
      }
      ignorePathCheck = false;
    }
    const trapped = cellList.length - home.size;
    /* 5) 死路保证：任何街区至少有一条出边，避免 "上得去下不来" */
    for (const cell of cellList) {
      if (hasEdge(cell, cell)) continue;
      const outs = edges.get(key(cell));
      if (outs && outs.size > 0) continue;
      for (const nb of neighborsOf(cell)) {
        if (tryDirected(cell, nb, true)) { deadends++; break; }
      }
    }
    /* 6) 屋顶红色跑道墙（原版红色管道动线） */
    for (const b of buildingBoxes) {
      if (wallruns >= 34) break;
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      if (w < 18 || d < 18) continue;
      const r = hash2(Math.round(b.x0) + 431, Math.round(b.z0) + 433);
      if (r > 0.18) continue;
      const side = Math.floor(hash2(Math.round(b.x0) + 101, Math.round(b.z0) + 103) * 4);
      const inset = 1.0, h = 4.3;
      const dir = hash2(Math.round(b.x0) + 211, Math.round(b.z0) + 223) < 0.5 ? 1 : -1;
      if (side === 0) {
        addWallrunX({ x0: b.x0 + inset, x1: b.x1 - inset, faceZ: b.z0 + 0.28, thickness: 0.5, y0: b.h, y1: b.h + h, normalZ: 1, direction: dir,
          zoneX0: b.x0 + inset - 0.3, zoneX1: b.x1 - inset + 0.3, zoneY0: b.h + 0.5, zoneY1: b.h + h - 0.5, zoneZ0: b.z0 - 0.6, zoneZ1: b.z0 + 2.4 });
      } else if (side === 1) {
        addWallrunX({ x0: b.x0 + inset, x1: b.x1 - inset, faceZ: b.z1 - 0.28, thickness: 0.5, y0: b.h, y1: b.h + h, normalZ: -1, direction: dir,
          zoneX0: b.x0 + inset - 0.3, zoneX1: b.x1 - inset + 0.3, zoneY0: b.h + 0.5, zoneY1: b.h + h - 0.5, zoneZ0: b.z1 - 2.4, zoneZ1: b.z1 + 0.6 });
      } else if (side === 2) {
        addWallrunZ({ z0: b.z0 + inset, z1: b.z1 - inset, faceX: b.x0 + 0.28, thickness: 0.5, y0: b.h, y1: b.h + h, normalX: 1, direction: dir,
          zoneZ0: b.z0 + inset - 0.3, zoneZ1: b.z1 - inset + 0.3, zoneY0: b.h + 0.5, zoneY1: b.h + h - 0.5, zoneX0: b.x0 - 0.6, zoneX1: b.x0 + 2.4 });
      } else {
        addWallrunZ({ z0: b.z0 + inset, z1: b.z1 - inset, faceX: b.x1 - 0.28, thickness: 0.5, y0: b.h, y1: b.h + h, normalX: -1, direction: dir,
          zoneZ0: b.z0 + inset - 0.3, zoneZ1: b.z1 - inset + 0.3, zoneY0: b.h + 0.5, zoneY1: b.h + h - 0.5, zoneX0: b.x1 - 2.4, zoneX1: b.x1 + 0.6 });
      }
      wallruns++;
    }
    return { bridges, zips, springs, wallruns, towerZips, repairs, deadends, reachable: bfs().size, canReturn: home.size, trapped, cells: cellList.length };
  }
  progress(0.70); await yieldFrame();
  buildLandmarks();
  progress(0.80); await yieldFrame();
  const connectStats = connectCells();

  /* 攀爬管道（楼间高差） */
  function addClimbs() {
    let n = 0;
    for (const b of buildingBoxes) {
      if (n >= 44) break;
      if ((b.x1 - b.x0) < 12 || (b.z1 - b.z0) < 12) continue;
      const r = hash2(Math.round(b.x0) + 23, Math.round(b.z0) + 29);
      if (r > 0.52) continue;
      let higher = null, best = 1e9;
      for (const o of buildingBoxes) {
        if (o === b) continue;
        const dx = Math.abs((o.x0 + o.x1) / 2 - (b.x0 + b.x1) / 2);
        const dz = Math.abs((o.z0 + o.z1) / 2 - (b.z0 + b.z1) / 2);
        const gap = Math.max(dx - ((o.x1 - o.x0) + (b.x1 - b.x0)) / 2, dz - ((o.z1 - o.z0) + (b.z1 - b.z0)) / 2);
        if (gap > -6 && gap < 17 && o.h - b.h > 2.5 && o.h - b.h < 26) {
          const score = Math.abs(gap) + Math.abs(o.h - b.h - 6);
          if (score < best) { best = score; higher = o; }
        }
      }
      if (!higher) continue;
      const towardX = Math.sign((higher.x0 + higher.x1) / 2 - (b.x0 + b.x1) / 2) || 1;
      const towardZ = Math.sign((higher.z0 + higher.z1) / 2 - (b.z0 + b.z1) / 2) || 0;
      const px = towardZ === 0 ? (b.x1 + b.x0) / 2 + towardX * ((b.x1 - b.x0) / 2 - 1.2) : (b.x0 + b.x1) / 2;
      const pz = towardZ !== 0 ? (b.z0 + b.z1) / 2 + towardZ * ((b.z1 - b.z0) / 2 - 1.2) : (b.z0 + b.z1) / 2;
      if (pointInsideProp(px, b.h + 1, pz, 1.2)) continue;
      const disX = towardZ === 0 ? (towardX > 0 ? higher.x0 + 1.0 : higher.x1 - 1.0) : (higher.x0 + higher.x1) / 2;
      const disZ = towardZ !== 0 ? (towardZ > 0 ? higher.z0 + 1.0 : higher.z1 - 1.0) : (higher.z0 + higher.z1) / 2;
      if (pointInsideProp(disX, higher.h + 0.6, disZ, 0.8)) continue;
      addClimbEntry(px, pz, b.h, higher.h, disX, disZ, (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2);
      n++;
    }
    return n;
  }
  progress(0.86); await yieldFrame();
  const climbStats = addClimbs();

  /* ---------------------------------------------- 道路标线 / 入口 / 街具 */
  function streetMarkingsAndEntrances() {
    /* 1) 黄色中线 + 斑马线 + 路缘石：真实几何（贴图在近处会糊） */
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xe6b932, roughness: 0.65 });
    const zebraMat = new THREE.MeshStandardMaterial({ color: 0xeef2f4, roughness: 0.72 });
    const curbMat = new THREE.MeshStandardMaterial({ color: 0xb6bfc5, roughness: 0.9 });
    const dashes = [];
    const zebras = [];
    const curbs = [];
    const dashLen = 3.0, dashGap = 3.2;
    for (let j = 0; j < N - 1; j++) {
      const z = -HALF + (j + 0.5) * PITCH;
      if (z > BAY_Z - 10) continue;
      for (let x = -HALF - 10; x < HALF + 10; x += dashLen + dashGap) {
        if (z > HIGHWAY_Z - 10 && z < HIGHWAY_Z + 10) continue;
        const mod = ((x + HALF) % PITCH + PITCH) % PITCH;
        if (Math.abs(mod - PITCH / 2) < 4.2) continue;   // 路口内不画中线
        dashes.push([x + dashLen / 2, z, dashLen, 0.3, 0]);
      }
    }
    for (let i = 0; i < N - 1; i++) {
      const x = -HALF + (i + 0.5) * PITCH;
      for (let z = -HALF - 10; z < Math.min(BAY_Z - 10, HALF + 10); z += dashLen + dashGap) {
        if (z > corridor.z0 - 6 && z < corridor.z1 + 6 && x > corridor.x0 - 6 && x < corridor.x1 + 6) continue;
        const mod = ((z + HALF) % PITCH + PITCH) % PITCH;
        if (Math.abs(mod - PITCH / 2) < 4.2) continue;
        dashes.push([x, z + dashLen / 2, 0.3, dashLen, 0]);
      }
    }
    for (let j = 0; j < N - 1; j++) {
      const z = -HALF + (j + 0.5) * PITCH;
      if (z > BAY_Z - 12) continue;
      for (let i = 0; i < N - 1; i++) {
        const x = -HALF + (i + 0.5) * PITCH;
        if (z > corridor.z0 - 8 && z < corridor.z1 + 8 && x > corridor.x0 - 8 && x < corridor.x1 + 8) continue;
        /* 每个路口两条过街线，分别退到路口外，避免中心叠成棋盘 */
        for (let k = -2; k <= 2; k++) {
          zebras.push([x - 6.8 + k * 1.7, z, 0.75, 9.0]);
          zebras.push([x, z + 6.8 + k * 1.7, 9.0, 0.75]);
        }
      }
    }
    for (const b of buildingBoxes) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      curbs.push([(b.x0 + b.x1) / 2, b.z0 - 0.5, w + 1.0, 0.5]);
      curbs.push([(b.x0 + b.x1) / 2, b.z1 + 0.5, w + 1.0, 0.5]);
      curbs.push([b.x0 - 0.5, (b.z0 + b.z1) / 2, 0.5, d + 1.0]);
      curbs.push([b.x1 + 0.5, (b.z0 + b.z1) / 2, 0.5, d + 1.0]);
    }
    function fillInst(list, geo, mat, y, h) {
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      const m = new THREE.Matrix4();
      list.forEach((it, i) => {
        m.makeScale(it[2], h, it[3]);
        m.setPosition(it[0], y, it[1]);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.receiveShadow = true;
      inst.frustumCulled = false;
      scene.add(inst);
    }
    fillInst(dashes, new THREE.BoxGeometry(1, 1, 1), dashMat, -0.05, 0.02);
    fillInst(zebras, new THREE.BoxGeometry(1, 1, 1), zebraMat, -0.05, 0.02);
    fillInst(curbs, new THREE.BoxGeometry(1, 1, 1), curbMat, 0.08, 0.16);

    /* 2) 底层墙裙 + 店面玻璃 + 入口（门/雨棚/台阶/招牌） */
    const plinthMat = new THREE.MeshStandardMaterial({ color: 0x7a858d, roughness: 0.62, metalness: 0.08 });
    const shopGlass = new THREE.MeshStandardMaterial({
      map: shopfrontCanvas(false),
      emissiveMap: shopfrontCanvas(true),
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      roughness: 0.22,
      metalness: 0.42,
      envMapIntensity: 0.9,
    });
    applyWorldUV(shopGlass, { scale: 1 / 7.2, bump: makeBumpTexture(shopfrontCanvas(false), 128), bumpScale: 0.2 });
    const canopyMats = [
      new THREE.MeshStandardMaterial({ color: 0xef8527, roughness: 0.65 }),
      new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.65 }),
      new THREE.MeshStandardMaterial({ color: 0xe6b932, roughness: 0.65 }),
    ];
    let doors = 0;
    for (const b of buildingBoxes) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      if (w < 10 || d < 10 || b.h < 6) continue;
      const faceMat = Math.round(b.x0) + Math.round(b.z0);
      const r0 = hash2(faceMat + 13, faceMat * 7 + 5);
      /* 四面：墙裙 + 店面玻璃带 */
      batcher.box(w, 3.9, 0.14, (b.x0 + b.x1) / 2, 1.95, b.z0 - 0.07, plinthMat);
      batcher.box(w, 3.9, 0.14, (b.x0 + b.x1) / 2, 1.95, b.z1 + 0.07, plinthMat);
      batcher.box(0.14, 3.9, d, b.x0 - 0.07, 1.95, (b.z0 + b.z1) / 2, plinthMat);
      batcher.box(0.14, 3.9, d, b.x1 + 0.07, 1.95, (b.z0 + b.z1) / 2, plinthMat);
      batcher.box(w * 0.86, 2.5, 0.1, (b.x0 + b.x1) / 2, 1.45, b.z0 - 0.15, shopGlass);
      batcher.box(w * 0.86, 2.5, 0.1, (b.x0 + b.x1) / 2, 1.45, b.z1 + 0.15, shopGlass);
      batcher.box(0.1, 2.5, d * 0.86, b.x0 - 0.15, 1.45, (b.z0 + b.z1) / 2, shopGlass);
      batcher.box(0.1, 2.5, d * 0.86, b.x1 + 0.15, 1.45, (b.z0 + b.z1) / 2, shopGlass);
      /* 入口：1-2 个门洞（含门框、雨棚、台阶、招牌） */
      const nDoors = w * d > 420 ? 2 : 1;
      for (let k = 0; k < nDoors; k++) {
        const side = Math.floor(hash2(faceMat + k * 31 + 7, faceMat + k * 17 + 11) * 4);
        const along = hash2(faceMat + k * 53, faceMat + k * 29) * 0.6 + 0.2;
        const cm = canopyMats[Math.floor(hash2(faceMat + k * 71, faceMat + k * 41) * 3) % 3];
        let dx = 0, dz = 0, nx = 0, nz = 0;
        if (side === 0) { dx = b.x0 + 1.5 + along * (w - 3); dz = b.z0; nz = -1; }
        else if (side === 1) { dx = b.x0 + 1.5 + along * (w - 3); dz = b.z1; nz = 1; }
        else if (side === 2) { dx = b.x0; dz = b.z0 + 1.5 + along * (d - 3); nx = -1; }
        else { dx = b.x1; dz = b.z0 + 1.5 + along * (d - 3); nx = 1; }
        /* 门前没有别的楼才留门 */
        const probeX = dx + nx * 2.4, probeZ = dz + nz * 2.4;
        const blocked = buildingBoxes.some((o) => o !== b
          && probeX > o.x0 - 1 && probeX < o.x1 + 1 && probeZ > o.z0 - 1 && probeZ < o.z1 + 1);
        if (blocked) continue;
        const ox = dx + nx * 0.2, oz = dz + nz * 0.2;
        /* 门框 */
        batcher.box(nx ? 0.24 : 3.4, 0.32, nz ? 0.24 : 3.4, ox, 3.6, oz, whiteMat);
        if (nx) {
          batcher.box(0.26, 3.6, 0.16, ox + nx * 0.02, 1.8, oz - 1.55, whiteMat);
          batcher.box(0.26, 3.6, 0.16, ox + nx * 0.02, 1.8, oz + 1.55, whiteMat);
          batcher.box(0.12, 3.3, 2.9, ox + nx * 0.12, 1.65, oz, glassDarkMat);
          batcher.box(1.5, 0.12, 3.5, ox + nx * 0.75, 3.85, oz, cm);
          batcher.box(0.9, 0.9, 3.1, ox + nx * 1.3, 0.45, oz, concreteMat);
          batcher.box(0.12, 0.55, 2.6, ox + nx * 0.2, 4.35, oz, cm);
        } else {
          batcher.box(0.16, 3.6, 0.26, ox - 1.55, 1.8, oz + nz * 0.02, whiteMat);
          batcher.box(0.16, 3.6, 0.26, ox + 1.55, 1.8, oz + nz * 0.02, whiteMat);
          batcher.box(2.9, 3.3, 0.12, ox, 1.65, oz + nz * 0.12, glassDarkMat);
          batcher.box(3.5, 0.12, 1.5, ox, 3.85, oz + nz * 0.75, cm);
          batcher.box(3.1, 0.9, 0.9, ox, 0.45, oz + nz * 1.3, concreteMat);
          batcher.box(2.6, 0.55, 0.12, ox, 4.35, oz + nz * 0.2, cm);
        }
        doors++;
      }
    }
    return { dashes: dashes.length, zebras: zebras.length, curbs: curbs.length, doors };
  }
  progress(0.90); await yieldFrame();
  const streetStats = streetMarkingsAndEntrances();

  /* ---------------------------------------------------- 地标工程 */
  function buildLandmarks() {
    /* The Shard —— 全城最高摩天楼（原版终章地标） */
    {
      const sx = 138, sz = -184;
      const base = new THREE.Mesh(new THREE.BoxGeometry(26, 44, 26), facadeMat('glass', 0, null));
      base.position.set(sx, 22, sz);
      base.castShadow = base.receiveShadow = true;
      scene.add(base);
      addCollider(sx - 13, sx + 13, 0, 44, sz - 13, sz + 13, 'solid', { mantle: true, building: true, name: 'shard' });
      const mid = new THREE.Mesh(new THREE.BoxGeometry(18, 40, 18), facadeMat('glass', 1, null));
      mid.position.set(sx, 64, sz);
      mid.castShadow = true;
      scene.add(mid);
      addCollider(sx - 9, sx + 9, 44, 84, sz - 9, sz + 9, 'solid', { mantle: true, building: true, name: 'shard' });
      const top = new THREE.Mesh(new THREE.BoxGeometry(11, 34, 11), facadeMat('ribbon', 0, null));
      top.position.set(sx, 101, sz);
      top.castShadow = true;
      scene.add(top);
      addCollider(sx - 5.5, sx + 5.5, 84, 118, sz - 5.5, sz + 5.5, 'solid', { mantle: true, building: true, name: 'shard' });
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(5.4, 5.4, 0.35, 24), new THREE.MeshStandardMaterial({ map: heliTex, roughness: 0.9 }));
      pad.position.set(sx, 118.2, sz);
      pad.castShadow = true;
      scene.add(pad);
      addCollider(sx - 5.4, sx + 5.4, 118, 118.35, sz - 5.4, sz + 5.4, 'solid', { mantle: true, name: 'shardPad', surface: 'metal' });
      batcher.cyl(0.25, 0.5, 22, 8, sx, 129, sz, concreteMat);
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), stripMat);
      beacon.position.set(sx, 140, sz);
      scene.add(beacon);
      /* 楼顶红色信号旗 */
      batcher.cyl(0.06, 0.1, 4, 6, sx + 4, 120, sz - 4, darkTrimMat);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.0), flagMat);
      flag.position.set(sx + 4.9, 123, sz - 4);
      scene.add(flag);
    }
    /* 高架路（贯穿东西的混凝土高架 + 蓝色护栏） */
    {
      const z = HIGHWAY_Z;
      const deck = new THREE.Mesh(new THREE.BoxGeometry(620, 1.4, 17), new THREE.MeshStandardMaterial({ color: 0xb9c3c9, roughness: 0.8 }));
      deck.position.set(60, HIGHWAY_Y, z);
      deck.castShadow = deck.receiveShadow = true;
      scene.add(deck);
      addCollider(-250, 370, HIGHWAY_Y - 1.4, HIGHWAY_Y, z - 8.5, z + 8.5, 'solid', { mantle: true, building: true, name: 'highway', surface: 'concrete' });
      const railMat = new THREE.MeshStandardMaterial({ color: 0x2f6fb0, roughness: 0.5, metalness: 0.2 });
      for (const rz of [z - 8.4, z + 8.4]) {
        batcher.box(620, 0.35, 0.3, 60, HIGHWAY_Y + 1.2, rz, railMat);
        batcher.box(620, 0.12, 0.14, 60, HIGHWAY_Y + 0.8, rz, railMat);
      }
      for (let x = -240; x < 370; x += 26) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(2.4, HIGHWAY_Y - 1.4, 2.4), concreteMat);
        col.position.set(x, (HIGHWAY_Y - 1.4) / 2, z);
        col.castShadow = true;
        scene.add(col);
        addCollider(x - 1.2, x + 1.2, 0, HIGHWAY_Y - 1.4, z - 1.2, z + 1.2, 'solid', { name: 'highwayColumn' });
      }
      /* 高架上的车 */
      for (let k = 0; k < 6; k++) {
        const x = -180 + k * 92 + hash2(k * 7, 3) * 30;
        const car = new THREE.Mesh(new THREE.BoxGeometry(4.1, 1.5, 1.85), new THREE.MeshStandardMaterial({ color: [0xd8dde0, 0x37424a, 0xef8527][k % 3], roughness: 0.35, metalness: 0.4 }));
        car.position.set(x, HIGHWAY_Y + 0.75, z + (k % 2 ? 3.4 : -3.4));
        car.castShadow = true;
        scene.add(car);
      }
    }
    /* 码头：栈桥 + 龙门吊 + 集装箱船 */
    {
      const pierMat = new THREE.MeshStandardMaterial({ color: 0xb3adb2, roughness: 0.85 });
      const water = new THREE.Mesh(new THREE.PlaneGeometry(1200, 420), new THREE.MeshStandardMaterial({ color: 0x3f83b4, roughness: 0.12, metalness: 0.45 }));
      water.rotation.x = -Math.PI / 2;
      water.position.set(0, 0.02, BAY_Z + 190);
      scene.add(water);
      const foam = new THREE.Mesh(new THREE.PlaneGeometry(1100, 3), new THREE.MeshBasicMaterial({ color: 0xe8f2f6, transparent: true, opacity: 0.7 }));
      foam.rotation.x = -Math.PI / 2;
      foam.position.set(0, 0.05, BAY_Z + 2);
      scene.add(foam);
      /* 混凝土岸墙，收住城市与海面的交界 */
      for (const [sx0, sx1] of [[-540, -250], [-230, 230], [250, 540]]) {
        const quay = new THREE.Mesh(new THREE.BoxGeometry(sx1 - sx0, 3.2, 2.4), concreteMat);
        quay.position.set((sx0 + sx1) / 2, 0.4, BAY_Z - 1.2);
        quay.castShadow = quay.receiveShadow = true;
        scene.add(quay);
        addCollider(sx0, sx1, -1.2, 2.0, BAY_Z - 2.4, BAY_Z, 'solid', { mantle: true, building: true, name: 'quay' });
      }
      for (let px = -240; px <= 240; px += 120) {
        const pw = 60;
        const deck = new THREE.Mesh(new THREE.BoxGeometry(pw, 1.2, 34), pierMat);
        deck.position.set(px, 2.2, BAY_Z + 26);
        deck.castShadow = deck.receiveShadow = true;
        scene.add(deck);
        addCollider(px - pw / 2, px + pw / 2, 1.6, 2.8, BAY_Z + 9, BAY_Z + 43, 'solid', { mantle: true, building: true, name: 'pier', surface: 'concrete' });
        for (let k = 0; k < 4; k++) {
          batcher.cyl(0.35, 0.35, 6, 8, px - pw / 2 + 6 + k * (pw - 12) / 3, 1.2, BAY_Z + 12, darkTrimMat);
          batcher.cyl(0.35, 0.35, 6, 8, px - pw / 2 + 6 + k * (pw - 12) / 3, 1.2, BAY_Z + 40, darkTrimMat);
        }
        for (let k = 0; k < 4; k++) {
          const cx2 = px - pw / 2 + 8 + (k % 2) * 18;
          const cz2 = BAY_Z + 18 + Math.floor(k / 2) * 12;
          addContainer(cx2, 2.9, cz2, hash2(px + k, k) < 0.5 ? 0 : Math.PI / 2, k % 2 ? orangeMat : blueCrateMat);
        }
      }
      /* 龙门吊 */
      const gantryMat = new THREE.MeshStandardMaterial({ color: 0xef8527, roughness: 0.55, metalness: 0.3 });
      function gantry(x, z) {
        const g = new THREE.Group();
        for (const [lx, lz] of [[-9, -5], [9, -5], [-9, 5], [9, 5]]) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(1.1, 16, 1.1), gantryMat);
          leg.position.set(lx, 8, lz);
          leg.castShadow = true;
          g.add(leg);
        }
        const beam = new THREE.Mesh(new THREE.BoxGeometry(26, 1.6, 1.6), gantryMat);
        beam.position.set(0, 16.5, -5);
        beam.castShadow = true;
        g.add(beam);
        const beam2 = beam.clone();
        beam2.position.z = 5;
        g.add(beam2);
        const trolley = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 2), darkTrimMat);
        trolley.position.set(2, 15.6, 0);
        g.add(trolley);
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 8, 5), darkTrimMat);
        cable.position.set(2, 11.4, 0);
        g.add(cable);
        const hook = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2.2), concreteMat);
        hook.position.set(2, 7, 0);
        g.add(hook);
        g.position.set(x, 2.8, z);
        scene.add(g);
        addCollider(x - 9.6, x + 9.6, 2.8, 18.5, z - 5.6, z + 5.6, 'solid', { name: 'gantryLeg' });
      }
      gantry(-180, BAY_Z + 24);
      gantry(60, BAY_Z + 24);
      /* 货轮 */
      const ship = new THREE.Group();
      const hullMat = new THREE.MeshStandardMaterial({ color: 0x31424e, roughness: 0.6, metalness: 0.2 });
      const hull = new THREE.Mesh(new THREE.BoxGeometry(70, 6, 14), hullMat);
      hull.position.y = 3;
      ship.add(hull);
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 11), whiteMat);
      bridge.position.set(-26, 9, 0);
      ship.add(bridge);
      for (let k = 0; k < 10; k++) {
        const c = new THREE.Mesh(new THREE.BoxGeometry(5.8, 2.5, 2.4), k % 2 ? orangeMat : blueCrateMat);
        c.position.set(-18 + (k % 5) * 7, 7.2, k < 5 ? -3.4 : 3.4);
        ship.add(c);
      }
      ship.position.set(-60, 0, BAY_Z + 60);
      ship.rotation.y = Math.PI / 2 * 0.06;
      ship.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      scene.add(ship);
    }
    /* 施工区：围挡 + 圆井 + 集装箱 + 塔吊 + 脚手架 */
    {
      const bx = 92, bz = 92;
      const siteFloor = new THREE.Mesh(new THREE.PlaneGeometry(38, 38), new THREE.MeshStandardMaterial({ color: 0x8f989e, roughness: 0.95 }));
      siteFloor.rotation.x = -Math.PI / 2;
      siteFloor.position.set(bx, 0.02, bz);
      siteFloor.receiveShadow = true;
      scene.add(siteFloor);
      /* 圆形作业井 */
      const wellWall = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.4, 3.2, 32, 1, true), hazardMat);
      wellWall.position.set(bx, 1.6, bz);
      wellWall.material.side = THREE.DoubleSide;
      wellWall.castShadow = true;
      scene.add(wellWall);
      const wellFloor = new THREE.Mesh(new THREE.CircleGeometry(6.4, 32), new THREE.MeshStandardMaterial({ color: 0x1d2429, roughness: 1 }));
      wellFloor.rotation.x = -Math.PI / 2;
      wellFloor.position.set(bx, 0.06, bz);
      scene.add(wellFloor);
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.6, 2.2, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x5a656d, roughness: 0.9, side: THREE.DoubleSide }));
      inner.position.set(bx, 1.1, bz);
      scene.add(inner);
      addCollider(bx - 6.4, bx - 5.6, 0, 3.2, bz - 6.4, bz + 6.4, 'solid', { name: 'wellWall' });
      addCollider(bx + 5.6, bx + 6.4, 0, 3.2, bz - 6.4, bz + 6.4, 'solid', { name: 'wellWall' });
      addCollider(bx - 6.4, bx + 6.4, 0, 3.2, bz - 6.4, bz - 5.6, 'solid', { name: 'wellWall' });
      addCollider(bx - 6.4, bx + 6.4, 0, 3.2, bz + 5.6, bz + 6.4, 'solid', { name: 'wellWall' });
      /* 集装箱与工棚 */
      for (const [cx2, cz2, yaw] of [[-12, -10, 0], [-12, -3, 0], [-12, 4, 0], [12, 8, Math.PI / 2], [12, 1, Math.PI / 2], [4, 13, 0]]) {
        addContainer(bx + cx2, 0.02, bz + cz2, yaw, hash2(cx2 + 9, cz2 + 7) < 0.6 ? orangeMat : blueCrateMat);
      }
      const cabin = addBoxMesh(bx - 4, bx + 2, 0, 2.6, bz - 15, bz - 11, [whitePanelMat, whitePanelMat, whitePanelMat, whitePanelMat, whitePanelMat, whitePanelMat], { extra: { mantle: true, name: 'siteCabin' } });
      batcher.box(6.2, 0.5, 0.3, bx - 1, 1.2, bz - 15.2, hazardMat);
      /* 塔吊 */
      const craneMat = new THREE.MeshStandardMaterial({ color: 0xf4c53a, roughness: 0.5, metalness: 0.3 });
      const mastH = 34;
      for (let k = 0; k < mastH / 2; k++) {
        batcher.box(1.6, 0.16, 1.6, bx + 14, 0.9 + k * 2, bz - 14, craneMat);
      }
      addCollider(bx + 13.2, bx + 14.8, 0, mastH, bz - 14.8, bz - 13.2, 'solid', { mantle: true, name: 'craneMast' });
      const jib = new THREE.Group();
      const arm = new THREE.Mesh(new THREE.BoxGeometry(30, 1.1, 1.1), craneMat);
      arm.position.x = 12;
      arm.castShadow = true;
      const cw = new THREE.Mesh(new THREE.BoxGeometry(6, 1.4, 1.4), concreteMat);
      cw.position.x = -5;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), whiteMat);
      cab.position.set(0, -1.6, 0);
      jib.add(arm, cw, cab);
      jib.position.set(bx + 14, mastH, bz - 14);
      jib.rotation.y = -0.6;
      scene.add(jib);
      /* 脚手架平台 */
      for (let k = 0; k < 3; k++) {
        const y = 2 + k * 3;
        addBoxMesh(bx - 16, bx - 10, y, y + 0.2, bz + 8 + k * 2, bz + 12 + k * 2, [metalSideMat, metalSideMat, metalTopMat, metalTopMat, metalSideMat, metalSideMat], { extra: { mantle: true, name: 'scaffold' } });
      }
    }
    /* 公园区：广场 + 花坛 */
    {
      const px = -184, pz = 138;
      const plaza = new THREE.Mesh(new THREE.PlaneGeometry(34, 34), new THREE.MeshStandardMaterial({ color: 0xb9c3c7, roughness: 0.95 }));
      plaza.rotation.x = -Math.PI / 2;
      plaza.position.set(px, 0.03, pz);
      plaza.receiveShadow = true;
      scene.add(plaza);
      for (const [ox, oz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
        const planter = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.8, 16), concreteMat);
        planter.position.set(px + ox, 0.4, pz + oz);
        planter.castShadow = true;
        scene.add(planter);
        const tree = new THREE.Mesh(new THREE.IcosahedronGeometry(2.6, 1), leafMat);
        tree.position.set(px + ox, 4, pz + oz);
        tree.castShadow = true;
        scene.add(tree);
        batcher.cyl(0.24, 0.3, 3.4, 6, px + ox, 1.7, pz + oz, concreteMat);
      }
    }
  }
  /* 屋顶旗帜（红白跑者旗） */
  {
    let flagN = 0;
    for (const b of buildingBoxes) {
      if (flagN >= 26) break;
      if (hash2(Math.round(b.x0) + 151, Math.round(b.z0) + 157) < 0.022) {
        const x = (b.x0 + b.x1) / 2 + (hash2(Math.round(b.x0), Math.round(b.z0) + 3) - 0.5) * (b.x1 - b.x0) * 0.4;
        const z = (b.z0 + b.z1) / 2 + (hash2(Math.round(b.z0) + 5, Math.round(b.x0)) - 0.5) * (b.z1 - b.z0) * 0.4;
        batcher.cyl(0.05, 0.08, 3.6, 6, x, b.h + 1.8 + 0.5, z, darkTrimMat);
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.95), flagMat);
        flag.position.set(x + 0.82, b.h + 3.6, z);
        scene.add(flag);
        flagN++;
      }
    }
  }

  /* ------------------------------------------------------- 金币 */
  function coinColor(value) {
    if (value >= 10) return new THREE.Color(0x7de3ff);
    if (value >= 5) return new THREE.Color(0xff9a3c);
    if (value >= 3) return new THREE.Color(0xdfe9f2);
    return new THREE.Color(0xffc83a);
  }

  function scatterCoins() {
    const defs = [];
    let idx = 0;
    for (const b of buildingBoxes) {
      const w = b.x1 - b.x0, d = b.z1 - b.z0;
      if (w * d < 160) continue;
      if (hash2(idx + 31, 7) > 0.42) { idx++; continue; }
      const count = w * d > 520 ? 3 : w * d > 260 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        idx++;
        const x = b.x0 + 2 + hash2(idx + 500, k + 17) * (w - 4);
        const z = b.z0 + 2 + hash2(idx + 900, k + 71) * (d - 4);
        const y = b.h + 1.1 + (idx % 3) * 0.3;
        if (!pointInsideProp(x, y, z, 0.5)) defs.push({ x, y, z, id: `coin-${Math.round(b.x0)}-${Math.round(b.z0)}-${k}` });
      }
    }
    world.coins = defs.map((d, i) => ({
      ...d,
      taken: false,
      phase: Math.random() * Math.PI * 2,
      value: hash2(i + 77, 5) < 0.18 ? 3 : 1,
    }));
    const geo = new THREE.CylinderGeometry(0.52, 0.52, 0.12, 18);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x4a3300, emissiveIntensity: 0.5, metalness: 0.85, roughness: 0.2 });
    const capacity = world.coins.length + 320;
    const inst = new THREE.InstancedMesh(geo, mat, capacity);
    inst.frustumCulled = false;
    for (let i = 0; i < world.coins.length; i++) inst.setColorAt(i, coinColor(world.coins[i].value || 1));
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
    world.coinMesh = inst;
    world.coinCapacity = capacity;
    world.addCoin = (x, y, z, id, value = 1) => {
      if (world.coins.length >= world.coinCapacity) return -1;
      const c = { x, y, z, id, value, taken: false, phase: Math.random() * Math.PI * 2 };
      const i = world.coins.length;
      world.coins.push(c);
      setCoinInstance(i, x, y, z, Math.random() * 6.28);
      inst.setColorAt(i, coinColor(value));
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.instanceMatrix.needsUpdate = true;
      return i;
    };
    world.syncCoins = () => {
      const t = performance.now() * 0.001;
      for (let i = 0; i < world.coins.length; i++) {
        const c = world.coins[i];
        if (c.taken) setCoinInstance(i, 0, 0, 0, null);
        else setCoinInstance(i, c.x, c.y, c.z, t * 2.2 + c.phase);
      }
      inst.instanceMatrix.needsUpdate = true;
    };
    world.syncCoins();
  }
  progress(0.95); await yieldFrame();
  scatterCoins();

  /* 屋顶蒸汽（原版烟囱白雾） */
  const smoke = [];
  {
    const pool = [];
    for (let i = 0; i < 42; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, transparent: true, opacity: 0, depthWrite: false, color: 0xf4f7f8 }));
      sp.layers.set(1);
      sp.visible = false;
      scene.add(sp);
      pool.push({ sprite: sp, life: 0, maxLife: 0, vy: 0 });
    }
    world.smokePool = pool;
  }

  /* 合批落盘 */
  batcher.flush(true);

  /* 金币动画：节流到 ~20Hz，且只更新玩家附近的金币，
     避免每帧重建数百个实例矩阵并整块上传到 GPU。 */
  let coinAccum = 0;
  const COIN_ANIM_R2 = 72 * 72;
  world.updateCoins = (dt, focus) => {
    if (!world.coinMesh) return;
    coinAccum += dt;
    if (coinAccum < 0.05) return;
    coinAccum = 0;
    const t = performance.now() * 0.001;
    const fx = focus ? focus.x : 0;
    const fz = focus ? focus.z : 0;
    let dirty = false;
    for (let i = 0; i < world.coins.length; i++) {
      const c = world.coins[i];
      if (c.taken) continue;
      const dx = c.x - fx, dz = c.z - fz;
      if (dx * dx + dz * dz > COIN_ANIM_R2) continue;
      setCoinInstance(i, c.x, c.y + Math.sin(t * 2.2 + c.phase) * 0.14, c.z, t * 2.2 + c.phase);
      dirty = true;
    }
    if (dirty) world.coinMesh.instanceMatrix.needsUpdate = true;
  };
  world.takeCoin = (i) => {
    const c = world.coins[i];
    if (c.taken) return false;
    c.taken = true;
    setCoinInstance(i, 0, 0, 0, null);
    world.coinMesh.instanceMatrix.needsUpdate = true;
    return true;
  };

  world.burst = (pos, color, count = 24, opts = {}) => {
    if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) return;
    count = Math.max(1, Math.round(count));
    if (world.quality === 'low' && count > 18) count = Math.floor(count / 2);
    if (world.bursts.length > 60) return;
    world.bursts.push(new Burst(scene, pos, color, count, opts));
  };
  world.updateBursts = (dt) => {
    for (let i = world.bursts.length - 1; i >= 0; i--) {
      if (!world.bursts[i].update(dt)) { world.bursts[i].dispose(scene); world.bursts.splice(i, 1); }
    }
  };

  let smokeTimer = 0;
  world.updateAmbient = (dt, t) => {
    if (world._beacons) {
      for (let i = 0; i < world._beacons.length; i++) {
        world._beacons[i].visible = Math.sin(t * 3.6 + i * 2.1) > -0.25;
      }
    }
    if (world.skyUniforms) world.skyUniforms.uTime.value = t;
    if (world.updateBoards) world.updateBoards(dt);
    for (const b of birds) {
      b.sprite.position.y += Math.sin(t * 2.4 + b.phase) * dt * 0.8;
      b.sprite.material.opacity = 0.6 + Math.sin(t * 3 + b.phase) * 0.15;
    }
    for (const f of flocks) {
      const a = t * f.speed + f.phase;
      f.group.position.set(f.cx + Math.cos(a) * f.r, f.cy + Math.sin(a * 1.7) * 5, f.cz + Math.sin(a) * f.r);
      f.group.rotation.y = -a + Math.PI / 2;
    }
    if (heli) {
      const a = t * 0.045 + heli.phase;
      heli.group.position.set(Math.cos(a) * 210, 96 + Math.sin(a * 2.3) * 6, Math.sin(a) * 210 - 30);
      heli.group.rotation.y = -a - Math.PI / 2;
      heli.group.rotation.z = -0.08;
      heli.rotor.rotation.y += dt * 26;
      heli.tailRotor.rotation.x += dt * 30;
    }
    /* 蒸汽 */
    smokeTimer -= dt;
    const pool = world.smokePool;
    if (pool) {
      for (const p of pool) {
        if (p.life > 0) {
          p.life -= dt;
          p.sprite.position.y += p.vy * dt;
          const k = 1 - p.life / p.maxLife;
          p.sprite.material.opacity = Math.sin(Math.min(1, k) * Math.PI) * 0.55;
          p.sprite.scale.setScalar(1.6 + k * 3.4);
          if (p.life <= 0) p.sprite.visible = false;
        } else if (smokeTimer <= 0 && smokeVents.length) {
          const v = smokeVents[Math.floor(Math.random() * smokeVents.length)];
          p.sprite.position.set(v.x + rand(-0.3, 0.3), v.y, v.z + rand(-0.3, 0.3));
          p.maxLife = rand(1.6, 2.6);
          p.life = p.maxLife;
          p.vy = rand(0.8, 1.4);
          p.sprite.visible = true;
          p.sprite.scale.setScalar(1.4);
          smokeTimer = 0.16;
        }
      }
    }
  };

  world.generationStats = {
    buildings: buildingBoxes.length,
    cells: cellList.length,
    colliders: world.colliders.length,
    climbs: world.climbs.length,
    zips: world.zips.length,
    zones: world.zones.length,
    highlights: world.highlight.length,
    coins: world.coins.length,
    ...roofStats,
    ...connectStats,
    climbPipes: climbStats,
    streetDoors: streetStats.doors,
    laneDashes: streetStats.dashes,
    crosswalks: streetStats.zebras,
    benches: lifeStats.bench,
    bins: lifeStats.bins,
    hydrants: lifeStats.hyd,
    streetLights: lifeStats.sig,
    shelters: lifeStats.shel,
    stringLights: lifeStats.cable,
    tarps: clutterStats.tarps,
    pallets: clutterStats.pallets,
    reels: clutterStats.reels,
    animatedBoards: world.boards ? world.boards.length : 0,
  };

  progress(1);
  return world;
}
