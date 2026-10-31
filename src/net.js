import { clamp, sanitizeText } from './util.js';

/* =========================================================================
   联机系统 —— 无需自建服务器
   ------------------------------------------------------------------------
   传输链路（自动降级）：
     1. 公共 MQTT 中继（HiveMQ → Mosquitto → EMQX，WebSocket Secure）
     2. 同设备 BroadcastChannel（多标签页 / 本地同屏，永远可用）
   协议：mirrorweb/v1/{room}/st/{id}  状态 12Hz
         mirrorweb/v1/{room}/ev/{id}  事件（加入 / 离开 / 光门 / 路线 / 纪录）
   ========================================================================= */

const BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const MQTT_CDN = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
const PROTO = 1;
const PALETTE = [0xff3b30, 0xff9f0a, 0x30d158, 0x0a84ff, 0xbf5af2, 0xffd60a, 0x64d2ff, 0xff6482];

function loadMqtt() {
  if (window.mqtt) return Promise.resolve(window.mqtt);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MQTT_CDN;
    s.async = true;
    s.onload = () => (window.mqtt ? resolve(window.mqtt) : reject(new Error('mqtt missing')));
    s.onerror = () => reject(new Error('mqtt load failed'));
    document.head.appendChild(s);
  });
}

function tryBroker(mqttLib, url, onMsg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client;
    try {
      client = mqttLib.connect(url, {
        clientId: `mw_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(36)}`,
        clean: true,
        keepalive: 25,
        connectTimeout: 6500,
        reconnectPeriod: 0,
        protocolVersion: 4,
        resubscribe: true,
      });
    } catch (e) { reject(e); return; }
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { client.end(true); } catch (e) { /* ignore */ }
      reject(err || new Error('broker failed'));
    };
    client.on('connect', () => {
      if (settled) return;
      settled = true;
      client.options.reconnectPeriod = 4000;
      resolve(client);
    });
    client.on('message', onMsg);
    client.on('error', (e) => fail(e));
    client.on('close', () => fail(new Error('closed')));
    setTimeout(() => fail(new Error('timeout')), 6800);
  });
}

export class Net {
  constructor() {
    this.status = 'off'; // off | connecting | online | local | error
    this.mode = '';
    this.room = '';
    this.id = `r${Math.random().toString(36).slice(2, 10)}`;
    this.name = '';
    this.color = PALETTE[0];
    this.players = new Map();
    this.client = null;
    this.channel = null;
    this.listeners = new Map();
    this.lastSend = 0;
    this.lastPrune = 0;
    this.lastHello = 0;
    this.manualClose = false;
    this.selfBest = 0;
    this.brokerIndex = -1;
    this.upgrading = false;
    this.upgradeTimer = null;
    this.mqttLib = null;
  }

  on(evt, cb) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(cb);
    return () => this.listeners.get(evt).delete(cb);
  }
  emit(evt, ...args) {
    const set = this.listeners.get(evt);
    if (set) for (const cb of set) { try { cb(...args); } catch (e) { /* ignore */ } }
  }

  colorFor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }

  setStatus(s, mode) {
    this.status = s;
    if (mode !== undefined) this.mode = mode;
    this.emit('status', s, this.mode);
  }

  async connect(roomRaw, nameRaw) {
    const room = sanitizeText(roomRaw, 24).toLowerCase().replace(/[^a-z0-9-_]/g, '') || 'white-city';
    const name = sanitizeText(nameRaw, 12) || `RUNNER-${this.id.slice(1, 5).toUpperCase()}`;
    if (this.status === 'connecting' || this.status === 'online' || this.status === 'local') this.disconnect();
    const session = this.session = (this.session || 0) + 1;
    this.room = room;
    this.name = name;
    this.color = this.colorFor(name);
    this.manualClose = false;
    this.players.clear();
    this.setStatus('connecting', '');
    this.emit('room', room, name);

    /* 1. 公共 MQTT 中继 */
    try {
      const lib = await loadMqtt();
      if (this.manualClose || session !== this.session) return true;
      this.mqttLib = lib;
      for (let bi = 0; bi < BROKERS.length; bi++) {
        if (this.manualClose || session !== this.session) return true;
        try {
          const client = await tryBroker(lib, BROKERS[bi], (topic, payload) => this.onMessage(topic, payload.toString()));
          if (this.manualClose || session !== this.session) { try { client.end(true); } catch (e) { /* ignore */ } return true; }
          this.client = client;
          if (this.manualClose || session !== this.session) { try { client.end(true); } catch (e) { /* ignore */ } return true; }
          this.brokerIndex = bi;
          this._attachClient(client, room, session);
          this.setStatus('online', 'mqtt');
          this.sendEvent('join', {});
          this.sendState(true);
          this._startUpgradeTimer();
          return true;
        } catch (e) { /* try next broker */ }
      }
    } catch (e) { /* mqtt unavailable */ }

    /* 2. 本机广播：始终开启（同设备多标签直达，不受公网中继差异影响） */
    if (this.manualClose || session !== this.session) return true;
    try {
      this.channel = new BroadcastChannel(`mirrorweb/v1/${room}`);
      this.channel.onmessage = (e) => this.onMessage('local', JSON.stringify(e.data));
    } catch (e) { /* 本机广播不可用则仅公网 */ }
    if (this.client) {
      this.setStatus('online', 'mqtt');
      this.sendEvent('join', {});
      this.sendState(true);
      return true;
    }
    if (this.channel) {
      this.mode = 'local';
      this.setStatus('local', 'local');
      this.sendEvent('join', {});
      this.sendState(true);
      return true;
    }
    this.setStatus('error', '');
    return false;
  }

  _attachClient(client, room, session) {
    /* message 监听在 tryBroker 中已注册，这里只补订阅与状态回调，避免重复处理 */
    client.subscribe([
      `mirrorweb/v1/${room}/st/+`,
      `mirrorweb/v1/${room}/ev/+`,
    ], { qos: 0 });
    client.on('close', () => { if (!this.manualClose && this.client === client && session === this.session) this.setStatus('connecting'); });
    client.on('connect', () => { if (!this.manualClose && this.client === client && session === this.session) this.setStatus('online', 'mqtt'); });
  }

  /* 尽量让同房间玩家落在同一个（首选）中继上 */
  _startUpgradeTimer() {
    if (this.upgradeTimer) clearInterval(this.upgradeTimer);
    const session = this.session;
    this.upgradeTimer = setInterval(async () => {
      if (this.manualClose || session !== this.session || this.status !== 'online' || this.mode !== 'mqtt') return;
      if (this.brokerIndex === 0 || this.upgrading || !this.mqttLib) return;
      this.upgrading = true;
      try {
        const client = await tryBroker(this.mqttLib, BROKERS[0], (topic, payload) => this.onMessage(topic, payload.toString()));
        if (this.manualClose || session !== this.session) { client.end(true); return; }
        const old = this.client;
        this.client = client;
        this.brokerIndex = 0;
        this._attachClient(client, this.room, session);
        try { old.end(true); } catch (e) { /* ignore */ }
        this.sendEvent('join', {});
        this.sendState(true);
      } catch (e) { /* 保留当前中继 */ }
      this.upgrading = false;
    }, 42000);
  }

  disconnect() {
    this.manualClose = true;
    this.session = (this.session || 0) + 1;
    if (this.upgradeTimer) { clearInterval(this.upgradeTimer); this.upgradeTimer = null; }
    if (this.client) {
      try { this.publish(`mirrorweb/v1/${this.room}/ev/${this.id}`, JSON.stringify({ v: PROTO, t: 'ev', id: this.id, n: this.name, k: 'leave', d: {} })); } catch (e) { /* ignore */ }
      try { this.client.end(true); } catch (e) { /* ignore */ }
      this.client = null;
    }
    if (this.channel) {
      try { this.channel.close(); } catch (e) { /* ignore */ }
      this.channel = null;
    }
    this.players.clear();
    this.setStatus('off', '');
    this.emit('leaveAll');
  }

  publish(topic, str) {
    if (this.client) {
      try { this.client.publish(topic, str, { qos: 0 }); } catch (e) { /* ignore */ }
    }
    if (this.channel) {
      try { this.channel.postMessage(JSON.parse(str)); } catch (e) { /* ignore */ }
    }
  }

  /* [x, y, z, yaw, speed, stateCode, flowMult, best] */
  sendState(force = false, data = null) {
    if (this.status === 'off' || this.status === 'error') return;
    const now = performance.now();
    if (!force && now - this.lastSend < 72) return;
    this.lastSend = now;
    const payload = {
      v: PROTO, t: 'st', id: this.id, n: this.name, c: this.color,
      d: data || [0, 0, 0, 0, 0, 0, 1, this.selfBest],
    };
    this.publish(`mirrorweb/v1/${this.room}/st/${this.id}`, JSON.stringify(payload));
  }

  sendEvent(k, d = {}) {
    if (this.status === 'off' || this.status === 'error') return;
    this.seq = (this.seq || 0) + 1;
    this.publish(`mirrorweb/v1/${this.room}/ev/${this.id}`, JSON.stringify({
      v: PROTO, t: 'ev', id: this.id, n: this.name, c: this.color, k, d, seq: this.seq,
    }));
  }

  onMessage(topic, str) {
    let msg;
    try { msg = JSON.parse(str); } catch (e) { return; }
    if (!msg || msg.v !== PROTO || msg.id === this.id) return;
    const now = performance.now();
    if (msg.t === 'st') {
      const d = Array.isArray(msg.d) ? msg.d : [0, 0, 0, 0, 0, 0, 1, 0];
      let p = this.players.get(msg.id);
      if (!p) {
        p = {
          id: msg.id, name: sanitizeText(msg.n, 12) || 'RUNNER', color: msg.c || 0xffffff,
          pos: [0, -999, 0], yaw: 0, speed: 0, state: 0, flow: 1, best: 0,
          prev: [0, -999, 0], prevYaw: 0, last: now, phase: Math.random() * 10, joined: now, lastSeq: 0,
        };
        this.players.set(msg.id, p);
        this.emit('join', p);
      }
      p.prev[0] = p.pos[0]; p.prev[1] = p.pos[1]; p.prev[2] = p.pos[2];
      p.prevYaw = p.yaw;
      p.pos[0] = +d[0] || 0; p.pos[1] = +d[1] || 0; p.pos[2] = +d[2] || 0;
      p.yaw = +d[3] || 0;
      p.speed = clamp(+d[4] || 0, 0, 40);
      p.state = (+d[5] | 0);
      p.flow = clamp(+d[6] || 1, 1, 5);
      p.best = Math.max(p.best, +d[7] || 0);
      p.last = now;
    } else if (msg.t === 'ev') {
      const known = this.players.get(msg.id);
      if (known && msg.seq && known.lastSeq >= msg.seq) return;
      if (known && msg.seq) known.lastSeq = msg.seq;
      if (msg.k === 'join') {
        let p = this.players.get(msg.id);
        if (!p) {
          p = {
            id: msg.id, name: sanitizeText(msg.n, 12) || 'RUNNER', color: msg.c || 0xffffff,
            pos: [0, -999, 0], yaw: 0, speed: 0, state: 0, flow: 1, best: 0,
            prev: [0, -999, 0], prevYaw: 0, last: now, phase: Math.random() * 10, joined: now, lastSeq: 0,
          };
          p.lastSeq = msg.seq || 0;
          this.players.set(msg.id, p);
          this.emit('join', p);
        } else p.last = now;
      } else {
        const p = this.players.get(msg.id);
        if (p) p.last = now;
        this.emit('event', { id: msg.id, name: sanitizeText(msg.n, 12) || 'RUNNER', k: msg.k, d: msg.d || {} });
      }
    }
  }

  update(dt) {
    if (this.status === 'off' || this.status === 'error') return;
    const now = performance.now();
    if (now - this.lastPrune > 1500) {
      this.lastPrune = now;
      for (const [id, p] of [...this.players]) {
        if (now - p.last > 9000) {
          this.players.delete(id);
          this.emit('leave', p);
        }
      }
    }
    if (now - this.lastHello > 1000) {
      this.lastHello = now;
      if (this.players.size > 0 || Math.random() < 0.4) this.sendEvent('hello', {});
    }
  }

  get count() { return this.players.size; }
}

export const net = new Net();
