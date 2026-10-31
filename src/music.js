import { audio } from './audio.js';
import { clamp, rand, midiHz, mulberry32, pick, damp } from './util.js';

/* =========================================================================
   全新 BGM 引擎 —— 镜之边缘风格
   ------------------------------------------------------------------------
   · 7 首原创曲目（环境电子 / 合成器浪潮 / 追逐鼓打贝斯），全部实时合成
   · 竖向分层混音：pad / bass / drums / arp / lead / fx 六条独立声部母线，
     随玩家速度与 FLOW 动态淡入淡出（跑得越快，层次越丰富）
   · 独立压缩器、卷积混响、乒乓延迟、侧链抽吸、卡农式人性化力度
   · 曲目间自动交叉淡化，永不重复播放
   ========================================================================= */

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  penta: [0, 3, 5, 7, 10],
};
const QUAL = {
  min: [0, 3, 7],
  maj: [0, 4, 7],
  sus: [0, 5, 7],
  dim: [0, 3, 6],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  add9: [0, 4, 7, 14],
};

/* 7 首原创曲目：调式 / 和声进行 / 段落 / 鼓型 / 贝斯 / 主奏均不同 */
const TRACK_DEFS = [
  {
    name: 'White Horizon', mood: 'CALM', bpm: 100, root: 38, scale: 'dorian', seed: 101,
    chords: [[0, 'min'], [5, 'maj'], [2, 'maj'], [6, 'maj'], [0, 'min'], [5, 'maj'], [3, 'min7'], [4, 'maj']],
    sections: [[0, 16, 0.10, 'intro'], [16, 48, 0.5, 'a'], [48, 80, 0.72, 'b'], [80, 112, 0.5, 'a2'], [112, 128, 0.18, 'outro']],
    drums: 'soft', hats: 'shaker', bass: 'sub', lead: 'bell', extra: 'none', leadWave: 'sine', swing: 0.08,
  },
  {
    name: "Runner's Vision", mood: 'FLOW', bpm: 128, root: 45, scale: 'minor', seed: 202,
    chords: [[0, 'min'], [5, 'maj'], [2, 'maj'], [6, 'maj'], [0, 'min'], [3, 'maj'], [5, 'min7'], [4, 'maj']],
    sections: [[0, 8, 0.12, 'intro'], [8, 24, 0.55, 'build'], [24, 56, 1.0, 'drop'], [56, 72, 0.3, 'break'], [72, 104, 1.0, 'drop2'], [104, 116, 0.3, 'outro']],
    drums: 'four', hats: 'offbeat', bass: 'rolling', lead: 'melody', extra: 'stabs', leadWave: 'sawtooth', swing: 0,
  },
  {
    name: 'Rooftop Circuit', mood: 'FLOW', bpm: 140, root: 42, scale: 'minor', seed: 303,
    chords: [[0, 'min'], [6, 'maj'], [5, 'maj'], [3, 'maj'], [0, 'min'], [4, 'maj'], [5, 'min7'], [6, 'maj']],
    sections: [[0, 8, 0.15, 'intro'], [8, 24, 0.6, 'build'], [24, 64, 1.0, 'drop'], [64, 80, 0.28, 'break'], [80, 112, 1.0, 'drop2'], [112, 120, 0.35, 'outro']],
    drums: 'break', hats: '16th', bass: 'reese', lead: 'pluckSeq', extra: 'stabs', leadWave: 'triangle', swing: 0,
  },
  {
    name: 'Vertigo Chase', mood: 'CHASE', bpm: 172, root: 40, scale: 'phrygian', seed: 404,
    chords: [[0, 'min'], [1, 'maj'], [5, 'min'], [6, 'maj'], [0, 'min'], [3, 'maj'], [5, 'min7'], [6, 'maj']],
    sections: [[0, 12, 0.18, 'intro'], [12, 28, 0.6, 'build'], [28, 72, 1.0, 'drop'], [72, 88, 0.25, 'break'], [88, 128, 1.0, 'drop2'], [128, 136, 0.4, 'outro']],
    drums: 'twoStep', hats: 'rolling', bass: 'neuro', lead: 'melody', extra: 'none', leadWave: 'square', swing: 0,
  },
  {
    name: 'Shard', mood: 'CALM', bpm: 92, root: 45, scale: 'minor', seed: 505,
    chords: [[0, 'min'], [3, 'maj'], [5, 'maj'], [4, 'maj'], [0, 'min'], [6, 'maj'], [3, 'maj'], [4, 'maj7']],
    sections: [[0, 12, 0.10, 'intro'], [12, 40, 0.45, 'a'], [40, 68, 0.7, 'b'], [68, 96, 0.45, 'a2'], [96, 108, 0.2, 'outro']],
    drums: 'soft', hats: 'shaker', bass: 'sub', lead: 'choir', extra: 'none', leadWave: 'sine', swing: 0.05,
  },
  {
    name: 'Cold Glass', mood: 'FLOW', bpm: 120, root: 47, scale: 'dorian', seed: 606,
    chords: [[0, 'min'], [3, 'maj'], [6, 'maj'], [4, 'maj'], [0, 'min'], [5, 'min7'], [3, 'maj'], [6, 'maj']],
    sections: [[0, 8, 0.14, 'intro'], [8, 24, 0.5, 'build'], [24, 60, 1.0, 'drop'], [60, 76, 0.3, 'break'], [76, 104, 1.0, 'drop2'], [104, 112, 0.3, 'outro']],
    drums: 'techno', hats: 'offbeat', bass: 'offbeat', lead: 'melody', extra: 'stabs', leadWave: 'triangle', swing: 0,
  },
  {
    name: 'Final Ascent', mood: 'CHASE', bpm: 174, root: 43, scale: 'minor', seed: 707,
    chords: [[0, 'min'], [5, 'maj'], [3, 'maj'], [6, 'maj'], [0, 'min'], [4, 'maj'], [5, 'min7'], [6, 'maj']],
    sections: [[0, 10, 0.2, 'intro'], [10, 26, 0.6, 'build'], [26, 66, 1.0, 'drop'], [66, 82, 0.3, 'break'], [82, 126, 1.0, 'drop2'], [126, 144, 0.4, 'outro']],
    drums: 'break', hats: '16th', bass: 'rolling', lead: 'anthem', extra: 'stabs', leadWave: 'sawtooth', swing: 0,
  },
  {
    name: 'Under Watch', mood: 'STEALTH', bpm: 96, root: 41, scale: 'phrygian', seed: 808,
    chords: [[0, 'min'], [1, 'maj'], [5, 'min'], [4, 'maj'], [0, 'min'], [3, 'maj'], [6, 'maj'], [5, 'min7']],
    sections: [[0, 8, 0.08, 'intro'], [8, 24, 0.32, 'a'], [24, 44, 0.58, 'b'], [44, 56, 0.3, 'a2'], [56, 64, 0.1, 'outro']],
    drums: 'soft', hats: 'shaker', bass: 'sub', lead: 'choir', extra: 'none', leadWave: 'sine', swing: 0.06,
  },
  {
    name: 'Blackout Run', mood: 'CHASE', bpm: 178, root: 41, scale: 'minor', seed: 909,
    chords: [[0, 'min'], [3, 'maj'], [5, 'min7'], [4, 'maj'], [0, 'min'], [6, 'maj'], [5, 'min'], [3, 'maj']],
    sections: [[0, 8, 0.14, 'intro'], [8, 24, 0.62, 'build'], [24, 68, 1.0, 'drop'], [68, 84, 0.26, 'break'], [84, 132, 1.0, 'drop2'], [132, 144, 0.4, 'outro']],
    drums: 'twoStep', hats: 'rolling', bass: 'neuro', lead: 'anthem', extra: 'stabs', leadWave: 'sawtooth', swing: 0,
  },
];

const MEL_RHYTHMS = {
  melody: [[0, 3, 6, 10, 12, 14], [0, 4, 7, 10, 12], [0, 2, 5, 8, 10, 14], [0, 3, 7, 11, 14]],
  anthem: [[0, 2, 4, 8, 12], [0, 2, 8, 10, 12], [0, 4, 6, 8, 12], [0, 2, 6, 8, 14]],
  pluckSeq: [[0, 2, 4, 6, 8, 10, 12, 14]],
  bell: [[0, 6, 10], [0, 8], [2, 8, 12]],
  choir: [[0, 8], [0, 4, 8, 12]],
};

function makeTrack(def) {
  const bars = def.sections[def.sections.length - 1][1];
  const S = 16;
  const total = bars * S;
  const scale = SCALES[def.scale];
  const rnd = mulberry32(def.seed * 7919 + 13);

  const sectionForBar = new Uint8Array(bars);
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < def.sections.length; i++) {
      if (b >= def.sections[i][0] && b < def.sections[i][1]) { sectionForBar[b] = i; break; }
    }
  }
  const barInten = new Float32Array(bars);
  const barKind = [];
  for (let b = 0; b < bars; b++) {
    const sec = def.sections[sectionForBar[b]];
    barInten[b] = sec[2];
    barKind[b] = sec[3];
  }

  const ev = {
    kick: new Float32Array(total),
    snare: new Float32Array(total),
    clap: new Float32Array(total),
    hat: new Float32Array(total),
    openHat: new Float32Array(total),
    ride: new Float32Array(total),
    perc: new Float32Array(total),
    percKind: new Uint8Array(total),
    bass: new Int16Array(total).fill(-999),
    bassLen: new Float32Array(total),
    bassGlide: new Uint8Array(total),
    stab: new Int16Array(total).fill(-999),
    lead: new Int16Array(total).fill(-999),
    leadLen: new Float32Array(total),
    leadVel: new Float32Array(total),
    arp: new Int16Array(total).fill(-999),
    pad: new Int16Array(total).fill(-999),
    padQual: new Uint8Array(total),
    fx: new Uint8Array(total),
    fxLen: new Float32Array(total),
  };

  const chordOf = (bar) => def.chords[bar % def.chords.length];
  const chordRootMidi = (bar) => {
    const ch = chordOf(bar);
    const deg = ((ch[0] % 7) + 7) % 7;
    const oct = Math.floor(ch[0] / 7);
    return def.root + scale[deg] + oct * 12;
  };
  const chordNotes = (bar, oct = 0) => {
    const root = chordRootMidi(bar) + oct * 12;
    return (QUAL[chordOf(bar)[1]] || QUAL.min).map((s) => root + s);
  };
  const degToMidi = (deg) => def.root + 12 + scale[((deg % 7) + 7) % 7] + Math.floor(deg / 7) * 12;
  const snapDeg = (bar, deg, lo, hi) => {
    const ch = chordOf(bar);
    const rootDeg = ((ch[0] % 7) + 7) % 7 + Math.floor(ch[0] / 7) * 7;
    let best = deg; let bd = Infinity;
    for (const base of [rootDeg, rootDeg + 2, rootDeg + 4]) {
      for (let o = -7; o <= 14; o += 7) {
        const cand = base + o;
        if (cand < lo || cand > hi) continue;
        const d = Math.abs(cand - deg);
        if (d < bd) { bd = d; best = cand; }
      }
    }
    return clamp(best, lo, hi);
  };

  /* ---------------- 鼓组 ---------------- */
  const style = def.drums;
  for (let step = 0; step < total; step++) {
    const bar = Math.floor(step / S);
    const s = step % S;
    const inten = barInten[bar];
    const kind = barKind[bar];
    if (kind === 'intro' && inten < 0.15) continue;
    const fillBar = bar % 8 === 7;
    const accent = s === 0 ? 1.0 : 0.82;
    if (style === 'soft') {
      if (s === 0) ev.kick[step] = 0.5 * inten;
      if (s === 8 && inten > 0.4) ev.kick[step] = 0.34 * inten;
      if (s === 4 || s === 12) ev.perc[step] = 0.35, ev.percKind[step] = 2;
    } else if (style === 'four' || style === 'techno') {
      if ([0, 4, 8, 12].includes(s)) ev.kick[step] = (s === 0 ? 0.98 : 0.86) * Math.max(0.55, inten);
      if (s === 4 || s === 12) ev.clap[step] = 0.62 * inten;
      if (style === 'techno' && (s === 2 || s === 6 || s === 10 || s === 14)) ev.openHat[step] = 0.26 * inten;
      if (fillBar && s >= 12) ev.snare[step] = Math.max(ev.snare[step], (0.3 + (s - 11) * 0.16) * inten);
    } else if (style === 'break') {
      if (s === 0) ev.kick[step] = 1.0 * Math.max(0.6, inten);
      if (s === 10) ev.kick[step] = 0.82 * inten;
      if (s === 3 && bar % 2 === 1) ev.kick[step] = 0.5 * inten;
      if (s === 4 || s === 12) ev.snare[step] = 0.86 * inten;
      if (s === 8) ev.snare[step] = 0.5 * inten;
      if ((s === 6 || s === 14) && bar % 2 === 0) ev.snare[step] = 0.26 * inten;
      if (fillBar && s >= 12) ev.snare[step] = Math.max(ev.snare[step], (0.32 + (s - 11) * 0.17) * inten);
      if (s === 15 && bar % 4 === 3) ev.kick[step] = 0.55 * inten;
    } else if (style === 'twoStep') {
      if (s === 0) ev.kick[step] = 1.0 * Math.max(0.6, inten);
      if (s === 10) ev.kick[step] = 0.8 * inten;
      if (s === 4 || s === 12) ev.snare[step] = 0.85 * inten;
      if (fillBar && s >= 12) ev.snare[step] = Math.max(ev.snare[step], (0.3 + (s - 11) * 0.16) * inten);
    } else if (style === 'half') {
      if (s === 0) ev.kick[step] = 0.95 * inten;
      if (s === 8) ev.snare[step] = 0.8 * inten;
    }
    /* 踩镲 */
    if (inten > 0.16) {
      const hs = def.hats;
      if (hs === 'offbeat') {
        if ([2, 6, 10, 14].includes(s)) ev.openHat[step] = 0.3 * inten;
        if ([0, 4, 8, 12].includes(s)) ev.hat[step] = 0.16 * inten;
      } else if (hs === '16th') {
        if (s % 2 === 0) ev.hat[step] = (s % 4 === 0 ? 0.2 : 0.12) * inten;
      } else if (hs === 'rolling') {
        if (s % 2 === 1) ev.hat[step] = (s % 4 === 3 ? 0.2 : 0.13) * inten;
        if (s % 8 === 7) ev.openHat[step] = 0.22 * inten;
      } else if (hs === 'shaker') {
        if (s % 2 === 0) ev.hat[step] = (s % 4 === 0 ? 0.11 : 0.07) * inten;
      }
      if (kind === 'drop2' && bar % 4 === 3 && s % 4 === 2) ev.ride[step] = 0.14 * inten;
    }
  }

  /* ---------------- 贝斯 ---------------- */
  for (let bar = 0; bar < bars; bar++) {
    const inten = barInten[bar];
    const kind = barKind[bar];
    if (inten < 0.2) continue;
    if (kind === 'break' && bar % 2 === 1) continue;
    const root = chordRootMidi(bar) - 12;
    const st = def.bass;
    const put = (s, midi, len, glide = 0) => {
      const step = bar * S + s;
      ev.bass[step] = midi;
      ev.bassLen[step] = len;
      ev.bassGlide[step] = glide;
    };
    if (st === 'sub') {
      put(0, root, 15.5);
      if (bar % 2 === 1) put(10, root + 12, 4.5);
    } else if (st === 'rolling') {
      for (let s = 0; s < 16; s += 2) {
        const up = (s === 6 || s === 14) ? 12 : (s === 10 ? 7 : 0);
        put(s, root + up, 1.7, s !== 0 && (s === 6 || s === 14) ? 1 : 0);
      }
    } else if (st === 'offbeat') {
      for (const s of [2, 6, 10, 14]) put(s, root + (s >= 10 ? 12 : 0), 2.4);
    } else if (st === 'reese') {
      put(0, root, 7.5, 0);
      put(8, root + (bar % 2 ? 3 : 5), 7.5, 1);
    } else if (st === 'neuro') {
      for (const s of [0, 3, 6, 10, 12, 14]) {
        const up = (s === 6 || s === 14) ? 12 : (s === 3 ? -2 : 0);
        put(s, root + up, s === 0 ? 3 : 1.6, (bar % 2 === 1 && s === 10) ? 1 : 0);
      }
    } else if (st === 'pluck') {
      for (let s = 0; s < 16; s += 2) put(s, root + ((s / 2) % 4 === 3 ? 12 : 0), 1.2);
    }
  }

  /* ---------------- 和弦断奏 / 铺底 ---------------- */
  for (let bar = 0; bar < bars; bar++) {
    const inten = barInten[bar];
    if (inten > 0.3 && def.extra === 'stabs') {
      const pat = bar % 2 === 0 ? [2, 6, 10, 14] : [3, 7, 11, 15];
      for (const s of pat) {
        const step = bar * S + s;
        ev.stab[step] = chordRootMidi(bar) + 12;
      }
    }
    if (bar % 2 === 0) {
      const step = bar * S;
      ev.pad[step] = chordRootMidi(bar) + 12;
      ev.padQual[step] = def.chords[bar % def.chords.length][1] === 'min7' || def.chords[bar % def.chords.length][1] === 'maj7' ? 1 : 0;
    }
  }

  /* ---------------- 主旋律 ----------------
     动机式写作：固定节奏动机 + 相对和弦根音的级数移调
     · 强拍落在和弦音（根音 / 三音 / 五音），弱拍以级进（±1 级）连接
     · 每 8 小节乐句重复动机 A，下一乐句用倒影变体 B，句尾长音落回根音或五音
     · 音程以二度为主，跳进仅在强拍出现并随即级进解决                     */
  const leadStyle = def.lead;
  const rangeLo = def.lead === 'choir' ? 6 : def.lead === 'bell' ? 7 : 6;
  const rangeHi = rangeLo + 10;
  const melRand = mulberry32(def.seed * 104729 + 31);
  const pick2 = (arr) => arr[Math.floor(melRand() * arr.length)];
  const chordDegAt = (bar) => {
    const ch = chordOf(bar);
    return ((ch[0] % 7) + 7) % 7 + Math.floor(ch[0] / 7) * 7;
  };
  if (MEL_RHYTHMS[leadStyle]) {
    const rhythm = MEL_RHYTHMS[leadStyle][0];
    /* 动机 A：相对和弦根音的音级偏移；强拍和弦音，弱拍级进 */
    const motifA = [];
    {
      let off = leadStyle === 'bell' || leadStyle === 'choir' ? 4 : 2;
      for (let i = 0; i < rhythm.length; i++) {
        const st = rhythm[i];
        const strong = st % 8 === 0;
        if (strong) off = pick2([0, 2, 4, 7, 9]);
        else {
          const dir = pick2([-1, -1, -1, 0, 1, 1, 1, 2 * (melRand() < 0.3 ? 1 : 0)]);
          off = clamp(off + (dir || 0), -2, 10);
        }
        const nextS = rhythm[i + 1] !== undefined ? rhythm[i + 1] : 16;
        motifA.push({ s: st, off, len: Math.max(1.6, nextS - 0.7) });
      }
    }
    /* 动机 B：A 的温和变体（乐句起音抬高一个三度、结尾下行解决），保持轮廓一致 */
    const motifB = motifA.map((n, i) => {
      let off = n.off;
      if (i === 0) off += 2;
      if (i === motifA.length - 1) off -= 2;
      if (i === Math.floor(motifA.length / 2)) off += (melRand() < 0.5 ? 1 : -1);
      return { s: n.s, off: clamp(off, -2, 10), len: n.len };
    });
    const midiLo = degToMidi(rangeLo);
    const midiHi = degToMidi(rangeHi);
    const smoothLimit = (leadStyle === 'bell' || leadStyle === 'choir') ? 5 : 10;
    let phrase = 0;
    for (let start = 0; start < total; start += 32) {
      const bar = Math.floor(start / S);
      const inten = barInten[bar];
      const kind = barKind[bar];
      if (kind === 'intro' && inten < 0.2) { phrase++; continue; }
      if (inten < 0.3) { phrase++; continue; }
      if (kind === 'break' && leadStyle !== 'bell' && leadStyle !== 'choir') {
        /* 间歇段落：单长音，落在根音 */
        const rd = chordDegAt(bar);
        ev.lead[start] = degToMidi(clamp(rd + 7, rangeLo, rangeHi));
        ev.leadLen[start] = 14;
        ev.leadVel[start] = 0.6;
        phrase++;
        continue;
      }
      const motif = (Math.floor(phrase / 4) % 2 === 0) ? motifA : motifB;
      const isQuestion = (Math.floor(phrase / 4) % 2 === 0);
      let prevMidi = null;   // 每句首音自由，随后就近解决
      for (let ni = 0; ni < motif.length; ni++) {
        const n = motif[ni];
        const step = start + n.s;
        if (step >= total) break;
        const b = Math.floor(step / S);
        const rd = chordDegAt(b);
        let deg = clamp(rd + 7 + n.off, rangeLo, rangeHi);
        const isLast = ni === motif.length - 1;
        /* 句尾：问句落在五音（悬停），答句落回根音（解决） */
        if (isLast) {
          const target = isQuestion ? 4 : 0;
          deg = clamp(rd + 7 + target, rangeLo, rangeHi);
        }
        let midi = degToMidi(deg);
        /* 大跳就近八度解决，保持旋律线条连贯 */
        if (prevMidi !== null && Math.abs(midi - prevMidi) > smoothLimit) {
          while (midi - prevMidi > smoothLimit) midi -= 12;
          while (prevMidi - midi > smoothLimit) midi += 12;
          while (midi < midiLo) midi += 12;
          while (midi > midiHi) midi -= 12;
        }
        prevMidi = midi;
        ev.lead[step] = midi;
        ev.leadLen[step] = isLast ? n.len + 8 : ['bell', 'choir'].includes(leadStyle) ? Math.max(5, n.len + 2) : n.len;
        ev.leadVel[step] = n.s % 8 === 0 ? 1 : rand(0.62, 0.78);
      }
      phrase++;
    }
  }
  if (leadStyle === 'arp' || def.extra === 'arp') {
    /* 琶音：和弦音按 0-2-4-2 的上行往返，强拍在低音 */
    const arpPattern = [0, 1, 2, 3, 2, 1];
    for (let step = 0; step < total; step += 1) {
      const bar = Math.floor(step / S);
      if (barInten[bar] < 0.3) continue;
      const s = step % S;
      if (s % 2 !== 0) continue;
      const tones = chordNotes(bar, 1);
      const idx = arpPattern[(step / 2) % arpPattern.length] % tones.length;
      ev.arp[step] = tones[idx];
    }
  }

  /* ---------------- FX：上升音 / 冲击 ---------------- */
  for (let i = 1; i < def.sections.length; i++) {
    const prev = def.sections[i - 1];
    const sec = def.sections[i];
    if (sec[2] - prev[2] > 0.3) {
      const startBar = Math.max(prev[1] - 2, prev[0]);
      const step = startBar * S;
      const len = (prev[1] - startBar) * S;
      ev.fx[step] = 1;
      ev.fxLen[step] = len;
      ev.fx[sec[0] * S] = 2;
    }
  }
  return { def, bars, total, stepDur: 60 / def.bpm / 4, sectionForBar, barInten, barKind, ev, chordRootMidi };
}

/* ============================ 引擎 ============================ */

const CALM_IDS = TRACK_DEFS.map((d, i) => (d.mood === 'CALM' ? i : -1)).filter((i) => i >= 0);
const CHASE_IDS = TRACK_DEFS.map((d, i) => (d.mood === 'CHASE' ? i : -1)).filter((i) => i >= 0);
const EXPLORE_IDS = TRACK_DEFS.map((d, i) => (d.mood === 'FLOW' ? i : -1)).filter((i) => i >= 0);

class MusicEngine {
  constructor() {
    this.tracks = TRACK_DEFS.map(makeTrack);
    this.catalog = TRACK_DEFS.map((d) => ({ name: d.name, mood: d.mood, bpm: d.bpm }));
    this.on = false;
    this.volume = 0;
    this.track = null;
    this.trackIndex = -1;
    this.nextStep = 0;
    this.trackStart = 0;
    this.timer = null;
    this.ctx = null;
    this.fade = null;
    this.duck = null;
    this.bus = null;
    this.swapTimeout = null;
    this.intensity = 0.15;
    this.targetIntensity = 0.15;
    this.gains = { pad: 0.9, bass: 0, drums: 0, lead: 0, arp: 0, fx: 0 };
    this.lastMix = 0;
    this.menuMode = false;
    this.swapping = false;
    this.pendingIndex = -1;
    this.mood = 'explore';
    this.time = 0;
    this.lastMoodSwitch = -99;
  }

  ensure() {
    if (!audio.ctx) audio.ensure();
    this.ctx = audio.ctx;
    if (!this.ctx || this.fade) return;
    const ctx = this.ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -13;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    this.out = ctx.createGain();
    this.out.gain.value = this.volume;
    this.fade = ctx.createGain();
    this.fade.gain.value = 0.0001;
    this.fade.connect(comp);
    comp.connect(this.out);
    this.out.connect(ctx.destination);
    this.bus = ctx.createGain();
    this.duck = ctx.createGain();
    this.duck.gain.value = 1;
    this.bus.connect(this.duck);
    this.duck.connect(this.fade);
    this.dry = ctx.createGain();
    this.dry.connect(this.fade);

    this.stems = {};
    for (const key of ['pad', 'bass', 'drums', 'lead', 'arp', 'fx']) {
      const g = ctx.createGain();
      g.gain.value = key === 'pad' ? 0.9 : 0;
      if (key === 'drums') g.connect(this.dry);
      else g.connect(this.bus);
      this.stems[key] = g;
    }

    /* 乒乓延迟 */
    this.delayL = ctx.createDelay(1.2);
    this.delayR = ctx.createDelay(1.2);
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.34;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.24;
    const dPanL = ctx.createStereoPanner();
    dPanL.pan.value = -0.55;
    const dPanR = ctx.createStereoPanner();
    dPanR.pan.value = 0.55;
    this.delaySend.connect(this.delayL);
    this.delayL.connect(dPanL);
    this.delayR.connect(dPanR);
    dPanL.connect(this.bus);
    dPanR.connect(this.bus);
    this.delayL.connect(this.delayR);
    this.delayR.connect(this.delayFb);
    this.delayFb.connect(this.delayL);

    /* 卷积混响 */
    const rate = ctx.sampleRate;
    const irLen = Math.floor(rate * 2.8);
    const ir = ctx.createBuffer(2, irLen, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        const early = i < rate * 0.09 ? 1.6 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * early;
      }
    }
    this.rev = ctx.createConvolver();
    this.rev.buffer = ir;
    this.revGain = ctx.createGain();
    this.revGain.gain.value = 0.55;
    this.revSend = ctx.createGain();
    this.revSend.gain.value = 0.22;
    this.revSend.connect(this.rev);
    this.rev.connect(this.revGain);
    this.revGain.connect(this.bus);
  }

  setVolume(v) {
    this.volume = v;
    if (this.ctx && this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.06);
  }
  setIntensity(x) { this.targetIntensity = clamp(x, 0, 1); }

  mixCurve(I) {
    const rise = (a, b) => clamp((I - a) / (b - a), 0, 1);
    return {
      pad: 0.55 + 0.4 * I,
      drums: rise(0.12, 0.42),
      bass: rise(0.2, 0.5),
      arp: rise(0.34, 0.7),
      lead: rise(0.48, 0.86),
      fx: 0.55 + 0.45 * I,
    };
  }

  applyMix() {
    if (!this.stems || !this.ctx) return;
    const t = this.ctx.currentTime;
    const target = this.mixCurve(this.intensity);
    for (const key of Object.keys(target)) {
      this.gains[key] = damp(this.gains[key], target[key], 5.5, 0.1);
      this.stems[key].gain.setTargetAtTime(this.gains[key], t, 0.12);
    }
  }

  pickIndex(preferCalm) {
    const pool = preferCalm && CALM_IDS.length ? CALM_IDS : this.tracks.map((_, i) => i);
    let idx = pool[Math.floor(Math.random() * pool.length)];
    if (pool.length > 1 && idx === this.trackIndex) {
      idx = pool[(pool.indexOf(idx) + 1) % pool.length];
    }
    return idx;
  }

  start(menuMode = false) {
    this.ensure();
    if (!this.ctx) return;
    this.menuMode = menuMode;
    if (this.on) return;
    this.on = true;
    this.play(this.pickIndex(menuMode));
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.schedule(), 70);
  }

  stop() {
    if (!this.on) return;
    this.on = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ctx && this.fade) {
      const now = this.ctx.currentTime;
      this.fade.gain.cancelScheduledValues(now);
      this.fade.gain.setValueAtTime(this.fade.gain.value, now);
      this.fade.gain.linearRampToValueAtTime(0.0001, now + 1.0);
    }
  }

  toggle(menuMode = false) {
    if (this.on) this.stop(); else this.start(menuMode);
    return this.on;
  }

  next(menuMode = this.menuMode) {
    if (!this.on) { this.start(menuMode); return; }
    this.play(this.pickIndex(menuMode));
  }

  play(index) {
    this.ensure();
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const swap = () => {
      this.trackIndex = index;
      this.track = this.tracks[index];
      this.nextStep = 0;
      this.trackStart = this.ctx.currentTime + 0.1;
      this.swapPos = 0;
      this.swapping = false;
      this.delayL.delayTime.setTargetAtTime(this.track.stepDur * 3, this.ctx.currentTime, 0.3);
      this.delayR.delayTime.setTargetAtTime(this.track.stepDur * 4.5, this.ctx.currentTime, 0.3);
      const g = this.fade.gain;
      g.cancelScheduledValues(this.ctx.currentTime);
      g.setValueAtTime(Math.max(g.value, 0.0001), this.ctx.currentTime);
      g.linearRampToValueAtTime(1, this.ctx.currentTime + 1.6);
      if (this.onChange) this.onChange(this.catalog[index]);
    };
    if (!this.track) { swap(); return; }
    if (this.swapping && this.pendingIndex === index) return;
    this.pendingIndex = index;
    this.swapping = true;
    const g = this.fade.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(g.value, 0.0001), now);
    g.linearRampToValueAtTime(0.0001, now + 1.1);
    if (this.swapTimeout) clearTimeout(this.swapTimeout);
    this.swapTimeout = setTimeout(swap, 1160);
  }

  /* 情景音乐：探索 / 追捕。追捕时自动切到 CHASE 曲目并拉满强度。 */
  setMood(mode) {
    this.mood = mode;
    if (!this.on || !this.track) return;
    if (this.time - this.lastMoodSwitch < 2.0) return;
    const cur = this.catalog[this.trackIndex];
    if (!cur) return;
    const wantChase = mode === 'chase';
    const isChase = cur.mood === 'CHASE';
    if (wantChase === isChase) return;
    this.lastMoodSwitch = this.time;
    let pool = wantChase ? CHASE_IDS : (EXPLORE_IDS.length ? EXPLORE_IDS : CALM_IDS);
    if (!pool || !pool.length) return;
    let idx = pool[Math.floor(Math.random() * pool.length)];
    if (idx === this.trackIndex && pool.length > 1) idx = pool[(pool.indexOf(idx) + 1) % pool.length];
    this.play(idx);
  }

  update(dt) {
    if (!this.on) return;
    this.time += dt;
    this.intensity = damp(this.intensity, this.targetIntensity, 2.8, dt);
    this.lastMix -= dt;
    if (this.lastMix <= 0) {
      this.lastMix = 0.1;
      this.applyMix();
    }
  }

  schedule() {
    if (!this.on || !this.ctx || !this.track) return;
    const tr = this.track;
    const horizon = this.ctx.currentTime + 0.45;
    while (this.nextStep < tr.total) {
      const stepTime = this.trackStart + this.nextStep * tr.stepDur;
      if (stepTime > horizon) break;
      if (stepTime > this.ctx.currentTime - 0.25) {
        const swing = tr.def.swing && this.nextStep % 2 === 1 ? tr.stepDur * tr.def.swing * 0.6 : 0;
        this.playStep(this.nextStep, stepTime + swing);
      }
      this.nextStep++;
    }
    if (this.nextStep >= tr.total) {
      if (!this.swapping) this.next(this.menuMode);
    }
  }

  /* 事件游标（pad / fx 这类稀疏事件） */
  runSparse(step, t) {
    const tr = this.track;
    const ev = tr.ev;
    while (this.swapPos < tr.total && this.swapPos <= step) {
      const s = this.swapPos;
      if (ev.pad[s] > -999 && s <= step) {
        const notes = (QUAL[tr.def.chords[Math.floor(s / 16) % tr.def.chords.length][1]] || QUAL.min)
          .map((k) => ev.pad[s] + k);
        if (ev.padQual[s]) notes.push(ev.pad[s] + 10);
        this.pad(t, notes, tr.stepDur * 32);
      }
      if (ev.fx[s] === 1) this.riser(t, ev.fxLen[s] * tr.stepDur);
      if (ev.fx[s] === 2) this.impact(t);
      this.swapPos++;
    }
  }

  playStep(step, t) {
    const tr = this.track;
    const ev = tr.ev;
    const g = this.gains;
    this.runSparse(step, t);
    if (ev.kick[step] > 0.01 && g.drums > 0.02) this.kick(t, ev.kick[step]);
    if (ev.snare[step] > 0.01 && g.drums > 0.02) this.snare(t, ev.snare[step]);
    if (ev.clap[step] > 0.01 && g.drums > 0.02) this.clap(t, ev.clap[step]);
    if (ev.hat[step] > 0.01 && g.drums > 0.015) this.hat(t, ev.hat[step], false, step % 4 < 2 ? -0.3 : 0.3);
    if (ev.openHat[step] > 0.01 && g.drums > 0.015) this.hat(t, ev.openHat[step], true, step % 8 < 4 ? 0.25 : -0.25);
    if (ev.ride[step] > 0.01 && g.drums > 0.02) this.ride(t, ev.ride[step]);
    if (ev.perc[step] > 0.01 && g.drums > 0.02) this.perc(t, ev.perc[step], ev.percKind[step]);
    if (ev.bass[step] > -999 && g.bass > 0.02) {
      this.bass(t, ev.bass[step], ev.bassLen[step] * tr.stepDur, !!ev.bassGlide[step], tr.def.bass);
    }
    if (ev.lead[step] > -999 && g.lead > 0.02) {
      const style = tr.def.lead;
      const len = ev.leadLen[step] * tr.stepDur;
      if (style === 'bell') this.bell(t, ev.lead[step], ev.leadVel[step]);
      else if (style === 'choir') this.choir(t, ev.lead[step], len, ev.leadVel[step]);
      else this.lead(t, ev.lead[step], len, ev.leadVel[step], tr.def.leadWave);
    }
    if (ev.arp[step] > -999 && g.arp > 0.02) this.arp(t, ev.arp[step], rand(0.7, 1));
    if (ev.stab[step] > -999 && g.arp > 0.02) {
      const bar = Math.floor(step / 16);
      const ch = tr.def.chords[bar % tr.def.chords.length];
      this.stab(t, ev.stab[step], ch[1]);
    }
  }

  /* ---------------- 鼓组音色 ---------------- */
  env(when, peak, atk, hold, rel, dest) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(peak, when + atk);
    g.gain.setValueAtTime(peak, when + atk + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, when + atk + hold + rel);
    g.connect(dest);
    return g;
  }
  noiseSrc(when, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = audio.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(when, Math.random() * 1.4);
    return s;
  }
  duckPulse(when) {
    const d = this.duck.gain;
    d.cancelScheduledValues(when);
    d.setValueAtTime(1, when);
    d.linearRampToValueAtTime(0.55, when + 0.012);
    d.linearRampToValueAtTime(1, when + 0.16);
  }
  kick(when, vel) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(158, when);
    o.frequency.exponentialRampToValueAtTime(43, when + 0.1);
    const g = this.env(when, 0.92 * vel, 0.001, 0.085, 0.13, this.stems.drums);
    o.connect(g);
    o.start(when); o.stop(when + 0.26);
    const n = this.noiseSrc(when, 1.7);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3400;
    const ng = this.env(when, 0.13 * vel, 0.001, 0.003, 0.018, this.stems.drums);
    n.connect(f); f.connect(ng);
    n.stop(when + 0.05);
    this.duckPulse(when);
  }
  snare(when, vel) {
    const ctx = this.ctx;
    const n = this.noiseSrc(when, 0.95);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.7;
    const g = this.env(when, 0.36 * vel, 0.001, 0.05, 0.1, this.stems.drums);
    n.connect(f); f.connect(g); g.connect(this.revSend);
    n.stop(when + 0.2);
    const n2 = this.noiseSrc(when, 1.8);
    const f2 = ctx.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = 4800;
    const g2 = this.env(when, 0.11 * vel, 0.001, 0.015, 0.045, this.stems.drums);
    n2.connect(f2); f2.connect(g2);
    n2.stop(when + 0.09);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(212, when);
    o.frequency.exponentialRampToValueAtTime(144, when + 0.06);
    const g3 = this.env(when, 0.24 * vel, 0.001, 0.035, 0.055, this.stems.drums);
    o.connect(g3); o.start(when); o.stop(when + 0.13);
  }
  clap(when, vel) {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const t = when + i * 0.011;
      const n = this.noiseSrc(t, 1.1);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1250 + i * 220; f.Q.value = 0.9;
      const g = this.env(t, (0.3 - i * 0.05) * vel, 0.001, 0.004, i === 2 ? 0.12 : 0.03, this.stems.drums);
      n.connect(f); f.connect(g);
      if (i === 2) g.connect(this.revSend);
      n.stop(t + (i === 2 ? 0.2 : 0.04));
    }
  }
  hat(when, vel, open, pan) {
    const ctx = this.ctx;
    const n = this.noiseSrc(when, 1.2);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = open ? 7200 : 8800;
    const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1);
    const g = this.env(when, vel, 0.001, open ? 0.04 : 0.008, open ? 0.11 : 0.028, p);
    p.connect(this.stems.drums);
    n.connect(f); f.connect(g);
    n.stop(when + (open ? 0.22 : 0.06));
  }
  ride(when, vel) {
    const ctx = this.ctx;
    const n = this.noiseSrc(when, 1.35);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 5200;
    const g = this.env(when, vel, 0.001, 0.02, 0.3, this.stems.drums);
    n.connect(f); f.connect(g); g.connect(this.revSend);
    n.stop(when + 0.4);
  }
  perc(when, vel, kind) {
    const ctx = this.ctx;
    if (kind === 2) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(320, when);
      o.frequency.exponentialRampToValueAtTime(180, when + 0.09);
      const g = this.env(when, 0.16 * vel, 0.001, 0.03, 0.08, this.stems.drums);
      o.connect(g); o.start(when); o.stop(when + 0.16);
    } else {
      const n = this.noiseSrc(when, 1.4);
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2500; f.Q.value = 1.6;
      const p = ctx.createStereoPanner(); p.pan.value = 0.2;
      const g = this.env(when, 0.14 * vel, 0.001, 0.005, 0.05, p);
      p.connect(this.stems.drums);
      n.connect(f); f.connect(g);
      n.stop(when + 0.09);
    }
  }

  /* ---------------- 贝斯 / 和声 ---------------- */
  bass(when, midi, dur, glide, style) {
    const ctx = this.ctx;
    const dest = this.stems.bass;
    const freq = midiHz(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = style === 'reese' || style === 'neuro' ? 5.5 : 1.4;
    const peak = style === 'reese' || style === 'neuro' ? 420 : 760;
    f.frequency.setValueAtTime(peak, when);
    f.frequency.exponentialRampToValueAtTime(style === 'pluck' ? 120 : 190, when + Math.max(0.08, dur));
    const g = this.env(when, 0.2, 0.004, Math.max(0.02, dur - 0.01), 0.06, dest);
    f.connect(g);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      if (glide) {
        o.frequency.setValueAtTime(freq * 0.62, when);
        o.frequency.exponentialRampToValueAtTime(freq, when + 0.07);
      } else {
        o.frequency.setValueAtTime(freq, when);
      }
      o.detune.value = det;
      o.connect(f);
      o.start(when); o.stop(when + dur + 0.08);
    }
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    if (glide) {
      sub.frequency.setValueAtTime(freq * 0.62, when);
      sub.frequency.exponentialRampToValueAtTime(freq, when + 0.07);
    } else {
      sub.frequency.setValueAtTime(freq, when);
    }
    const sg = this.env(when, 0.24, 0.005, Math.max(0.02, dur - 0.01), 0.07, dest);
    sub.connect(sg);
    sub.start(when); sub.stop(when + dur + 0.1);
  }
  pad(when, notes, dur) {
    const ctx = this.ctx;
    const dest = this.stems.pad;
    const g = this.env(when, 0.035, 0.9, dur * 0.8, 1.4, dest);
    g.connect(this.revSend);
    for (const midi of notes) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 620 + Math.random() * 260;
      f.Q.value = 0.4;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = rand(0.06, 0.14);
      const lfoG = ctx.createGain();
      lfoG.gain.value = 220;
      lfo.connect(lfoG);
      lfoG.connect(f.frequency);
      lfo.start(when); lfo.stop(when + dur + 2);
      f.connect(g);
      for (const det of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(midi);
        o.detune.value = det;
        o.connect(f);
        o.start(when); o.stop(when + dur + 1.8);
      }
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = midiHz(midi + 12);
      const og = ctx.createGain();
      og.gain.value = 0.25;
      o2.connect(og); og.connect(f);
      o2.start(when); o2.stop(when + dur + 1.8);
    }
  }
  stab(when, root, quality) {
    const ctx = this.ctx;
    const dest = this.stems.arp;
    const g = this.env(when, 0.05, 0.004, 0.07, 0.12, dest);
    g.connect(this.revSend);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 1900; f.Q.value = 1.6;
    f.connect(g);
    const notes = (QUAL[quality] || QUAL.min).map((s) => root + s);
    for (const midi of notes) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiHz(midi);
      o.detune.value = rand(-8, 8);
      o.connect(f);
      o.start(when); o.stop(when + 0.26);
    }
  }

  /* ---------------- 主奏音色 ---------------- */
  lead(when, midi, dur, vel, wave) {
    const ctx = this.ctx;
    const dest = this.stems.lead;
    const g = this.env(when, 0.085 * (0.6 + vel * 0.4), 0.012, Math.max(0.03, dur - 0.02), 0.1, dest);
    g.connect(this.delaySend);
    g.connect(this.revSend);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = wave === 'sawtooth' ? 2600 : 1800;
    f.Q.value = 1.1;
    f.connect(g);
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = midiHz(midi);
    const o2 = ctx.createOscillator();
    o2.type = wave === 'sine' ? 'sine' : 'triangle';
    o2.frequency.value = midiHz(midi);
    o2.detune.value = 8;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.4;
    const vibG = ctx.createGain();
    vibG.gain.value = 6;
    vib.connect(vibG);
    vibG.connect(o.detune);
    vibG.connect(o2.detune);
    vib.start(when + 0.12); vib.stop(when + dur + 0.2);
    o.connect(f); o2.connect(f);
    o.start(when); o.stop(when + dur + 0.12);
    o2.start(when); o2.stop(when + dur + 0.12);
  }
  bell(when, midi, vel) {
    const ctx = this.ctx;
    const dest = this.stems.lead;
    const g = this.env(when, 0.1 * (0.5 + vel * 0.5), 0.004, 0.05, 1.3, dest);
    g.connect(this.revSend);
    g.connect(this.delaySend);
    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.value = midiHz(midi);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = midiHz(midi) * 3.01;
    const modG = ctx.createGain();
    modG.gain.setValueAtTime(midiHz(midi) * 2.2, when);
    modG.gain.exponentialRampToValueAtTime(1, when + 0.6);
    mod.connect(modG);
    modG.connect(carrier.frequency);
    carrier.connect(g);
    carrier.start(when); carrier.stop(when + 1.6);
    mod.start(when); mod.stop(when + 1.6);
  }
  choir(when, midi, dur, vel) {
    const ctx = this.ctx;
    const dest = this.stems.lead;
    const g = this.env(when, 0.055 * (0.5 + vel * 0.5), 0.35, Math.max(0.1, dur * 0.6), 0.8, dest);
    g.connect(this.revSend);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 720; f1.Q.value = 1.1;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1180; f2.Q.value = 1.4;
    const fg1 = ctx.createGain(); fg1.gain.value = 1.0;
    const fg2 = ctx.createGain(); fg2.gain.value = 0.5;
    f1.connect(fg1); f2.connect(fg2);
    fg1.connect(g); fg2.connect(g);
    for (const [harm, amp] of [[0, 1], [12, 0.4], [19, 0.16]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiHz(midi + harm);
      const og = ctx.createGain(); og.gain.value = amp;
      const vib = ctx.createOscillator(); vib.frequency.value = rand(4.4, 5.6);
      const vibG = ctx.createGain(); vibG.gain.value = 4.5;
      vib.connect(vibG); vibG.connect(o.detune);
      vib.start(when + 0.2); vib.stop(when + dur + 1);
      o.connect(og);
      og.connect(f1); og.connect(f2);
      o.start(when); o.stop(when + dur + 1);
    }
  }
  arp(when, midi, vel) {
    const ctx = this.ctx;
    const dest = this.stems.arp;
    const g = this.env(when, 0.045 * vel, 0.002, 0.03, 0.1, dest);
    g.connect(this.delaySend);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 2100; f.Q.value = 1;
    f.connect(g);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = midiHz(midi);
    o.connect(f);
    o.start(when); o.stop(when + 0.18);
  }

  /* ---------------- FX ---------------- */
  riser(when, dur) {
    const ctx = this.ctx;
    const dest = this.stems.fx;
    const n = this.noiseSrc(when, 1);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(320, when);
    f.frequency.exponentialRampToValueAtTime(6200, when + dur);
    f.Q.value = 2.2;
    const g = this.env(when, 0.1, dur * 0.7, 0.02, 0.25, dest);
    g.connect(this.revSend);
    n.connect(f); f.connect(g);
    n.stop(when + dur + 0.3);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(110, when);
    o.frequency.exponentialRampToValueAtTime(880, when + dur);
    const og = this.env(when, 0.02, dur * 0.8, 0.01, 0.2, dest);
    o.connect(og);
    o.start(when); o.stop(when + dur + 0.25);
  }
  impact(when) {
    const ctx = this.ctx;
    const dest = this.stems.fx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(62, when);
    o.frequency.exponentialRampToValueAtTime(27, when + 0.9);
    const g = this.env(when, 0.34, 0.002, 0.25, 0.8, dest);
    o.connect(g); o.start(when); o.stop(when + 1.2);
    const n = this.noiseSrc(when, 1);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1400;
    const ng = this.env(when, 0.16, 0.002, 0.1, 0.5, dest);
    n.connect(f); f.connect(ng); ng.connect(this.revSend);
    n.stop(when + 0.7);
  }
}

export const music = new MusicEngine();
export const TRACK_CATALOG = music.catalog;
