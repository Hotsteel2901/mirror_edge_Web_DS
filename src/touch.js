import { clamp, isMobileDevice, settings, saveSettings } from './util.js';

/* =========================================================================
   移动端与触屏控制系统
   ------------------------------------------------------------------------
   · 多点触控独立追踪：左半屏浮动虚拟摇杆 + 右半屏自由划动视角 + 右下角跑酷动作弧
   · 动作键支持“按住并划动转向”（拇指跳/滑铲同时转视角不断触）
   · 推到底自动冲刺（可在设置开关）+ 冲刺锁定胶囊 + 轻点蹲伏潜行切换
   · 场景上下文高亮：靠近滑索/攀爬管高亮「互动」，靠近守卫高亮「缴械」
   · 横屏建议提示与一键全屏（支持 Screen Orientation 锁定的浏览器自动切横屏）
   ========================================================================= */

const DEADZONE = 0.10;
const AUTO_SPRINT_THRESHOLD = 0.72;

export class TouchControls {
  constructor(hooks) {
    this.hooks = hooks;
    this.active = false;
    this.detectedTouch = isMobileDevice();

    /* 左摇杆状态 */
    this.joyPointerId = null;
    this.joyOriginX = 0;
    this.joyOriginY = 0;
    this.joyMaxR = 52;
    this.stick = { x: 0, y: 0, len: 0 };
    this.joySprint = false;
    this.sprintLock = false;

    /* 视角触控状态 */
    this.lookPointerId = null;
    this.lookLastX = 0;
    this.lookLastY = 0;

    /* 动作键状态（支持按键同时拖动视角） */
    this.btnPointers = new Map();
    this.crouchDown = false;
    this.crouchToggle = false;
    this.crouchDownAt = 0;
    this.crouchWasFast = false;

    /* DOM 引用 */
    this.dom = {
      root: document.getElementById('touch-ui'),
      lookZone: document.getElementById('touch-look-zone'),
      joyZone: document.getElementById('touch-joy-zone'),
      joyBase: document.getElementById('touch-joy-base'),
      joyKnob: document.getElementById('touch-joy-knob'),
      btnSprint: document.getElementById('btn-touch-sprint'),
      btnJump: document.getElementById('btn-touch-jump'),
      btnCrouch: document.getElementById('btn-touch-crouch'),
      btnCrouchSub: document.getElementById('btn-touch-crouch-sub'),
      btnUse: document.getElementById('btn-touch-use'),
      btnMelee: document.getElementById('btn-touch-melee'),
      btnTurn: document.getElementById('btn-touch-turn'),
      quickbar: document.getElementById('touch-quickbar'),
      qbMission: document.getElementById('btn-qb-mission'),
      qbMissionDot: document.getElementById('qb-mission-dot'),
      qbShop: document.getElementById('btn-qb-shop'),
      qbTrial: document.getElementById('btn-qb-trial'),
      qbRecords: document.getElementById('btn-qb-records'),
      qbChat: document.getElementById('btn-qb-chat'),
      qbPause: document.getElementById('btn-qb-pause'),
      portraitTip: document.getElementById('portrait-tip'),
      btnPortraitFs: document.getElementById('btn-portrait-fs'),
      btnPortraitClose: document.getElementById('btn-portrait-close'),
      prompt: document.getElementById('prompt'),
    };

    this._portraitDismissed = false;
    this._lastInteractGlow = false;
    this._lastMeleeGlow = false;
    this._lastTrialActive = false;
    this._lastMissionDot = false;
    this._lastHudVisible = null;

    this._bindEvents();
    this.refreshMode();
    this._updatePortraitTip();
  }

  /* ------------------------------------------------ 模式判定与显隐 */
  shouldBeActive() {
    const pref = settings.touch || 'auto';
    if (pref === 'on') return true;
    if (pref === 'off') return false;
    return this.detectedTouch;
  }

  refreshMode() {
    const next = this.shouldBeActive();
    if (next !== this.active) {
      this.active = next;
      if (!next) this.reset();
    }
    document.body.classList.toggle('touch-mode', this.active);
    this._updatePortraitTip();
    if (this.hooks.onModeChange) this.hooks.onModeChange(this.active);
  }

  setGameplayVisible(visible) {
    const show = this.active && visible;
    if (show === this._lastHudVisible) return;
    this._lastHudVisible = show;
    if (this.dom.root) this.dom.root.classList.toggle('hidden', !show);
    if (!show) this.reset();
  }

  /* ------------------------------------------------ 输入输出接口 */
  getMove() {
    return this.stick;
  }

  isSprinting() {
    if (!this.active) return false;
    if (this.crouchDown || this.crouchToggle) return false;
    return this.joySprint || this.sprintLock;
  }

  isCrouching() {
    if (!this.active) return false;
    return this.crouchDown || this.crouchToggle;
  }

  reset() {
    this.joyPointerId = null;
    this.lookPointerId = null;
    this.btnPointers.clear();
    this.stick.x = 0;
    this.stick.y = 0;
    this.stick.len = 0;
    this.joySprint = false;
    this.crouchDown = false;
    this._resetJoyVisual();
    this._syncSprintVisual();
    this._syncCrouchVisual();
    if (this.dom.root) {
      this.dom.root.querySelectorAll('.tbtn.pressed').forEach((el) => el.classList.remove('pressed'));
    }
  }

  /* 每帧同步上下文高亮（零 DOM 抖动：仅状态变化时切换 class） */
  updateContext({ canInteract = false, canMelee = false, inTrial = false, needMissionDot = false }) {
    if (!this.active) return;
    if (canInteract !== this._lastInteractGlow) {
      this._lastInteractGlow = canInteract;
      if (this.dom.btnUse) this.dom.btnUse.classList.toggle('ctx-glow', canInteract);
    }
    if (canMelee !== this._lastMeleeGlow) {
      this._lastMeleeGlow = canMelee;
      if (this.dom.btnMelee) this.dom.btnMelee.classList.toggle('ctx-danger', canMelee);
    }
    if (inTrial !== this._lastTrialActive) {
      this._lastTrialActive = inTrial;
      if (this.dom.qbTrial) this.dom.qbTrial.classList.toggle('active', inTrial);
    }
    if (needMissionDot !== this._lastMissionDot) {
      this._lastMissionDot = needMissionDot;
      if (this.dom.qbMissionDot) this.dom.qbMissionDot.classList.toggle('show', needMissionDot);
    }
  }

  /* ------------------------------------------------ 全屏与横屏辅助 */
  canFullscreen() {
    const el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen);
  }

  isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  async toggleFullscreen(lockLandscape = true) {
    try {
      if (this.isFullscreen()) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        return false;
      }
      const el = document.documentElement;
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      if (lockLandscape && screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  _updatePortraitTip() {
    const tip = this.dom.portraitTip;
    if (!tip) return;
    const isPortrait = window.innerHeight > window.innerWidth * 1.08 && window.innerWidth < 760;
    const show = this.active && isPortrait && !this._portraitDismissed;
    tip.classList.toggle('show', show);
    if (this.dom.btnPortraitFs) {
      this.dom.btnPortraitFs.style.display = this.canFullscreen() ? '' : 'none';
    }
  }

  /* ------------------------------------------------ 内部视觉与手势 */
  _haptic(ms = 8) {
    try {
      if (navigator.vibrate) navigator.vibrate(ms);
    } catch (e) { /* ignore */ }
  }

  _resetJoyVisual() {
    const { joyBase, joyKnob } = this.dom;
    if (!joyBase || !joyKnob) return;
    joyBase.classList.remove('active', 'sprinting');
    joyBase.style.left = '';
    joyBase.style.top = '';
    joyBase.style.bottom = '';
    joyKnob.style.transform = 'translate(-50%, -50%)';
  }

  _syncSprintVisual() {
    if (this.dom.btnSprint) {
      this.dom.btnSprint.classList.toggle('active', this.sprintLock);
    }
    if (this.dom.joyBase) {
      this.dom.joyBase.classList.toggle('sprinting', this.joySprint || this.sprintLock);
    }
  }

  _syncCrouchVisual() {
    const on = this.crouchDown || this.crouchToggle;
    if (this.dom.btnCrouch) this.dom.btnCrouch.classList.toggle('active', on);
    if (this.dom.btnCrouchSub) {
      this.dom.btnCrouchSub.textContent = this.crouchToggle ? '潜行中' : '滑铲/蹲';
    }
  }

  _updateJoyFromPoint(clientX, clientY) {
    const dx = clientX - this.joyOriginX;
    const dy = clientY - this.joyOriginY;
    const maxR = this.joyMaxR;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, maxR);
    const ux = dist > 0.001 ? dx / dist : 0;
    const uy = dist > 0.001 ? dy / dist : 0;
    const kx = ux * clamped;
    const ky = uy * clamped;

    if (this.dom.joyKnob) {
      this.dom.joyKnob.style.transform = `translate(calc(-50% + ${kx.toFixed(1)}px), calc(-50% + ${ky.toFixed(1)}px))`;
    }

    const rawLen = clamp(dist / maxR, 0, 1);
    if (rawLen <= DEADZONE) {
      this.stick.x = 0;
      this.stick.y = 0;
      this.stick.len = 0;
      this.joySprint = false;
    } else {
      const norm = (rawLen - DEADZONE) / (1 - DEADZONE);
      this.stick.x = ux * norm;
      this.stick.y = -uy * norm;
      this.stick.len = norm;
      const autoSprintOn = settings.autoSprint !== false;
      this.joySprint = autoSprintOn && rawLen >= AUTO_SPRINT_THRESHOLD && this.stick.y > 0.22;
      if (this.stick.y < -0.35 && this.sprintLock) {
        this.sprintLock = false;
      }
      if (this.joySprint && this.crouchToggle) {
        this.crouchToggle = false;
        this._syncCrouchVisual();
      }
    }
    this._syncSprintVisual();
  }

  _applyLookDelta(dx, dy) {
    if (!this.hooks.onLook) return;
    /* 按屏幕短边自适应归一化，手机竖屏/横屏/平板手感一致 */
    const scale = 0.0046 * (settings.sens || 1);
    this.hooks.onLook(dx * scale, dy * scale);
  }

  _bindEvents() {
    /* 自动识别二合一/触屏设备首次触摸 */
    window.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.detectedTouch) {
        this.detectedTouch = true;
        this.refreshMode();
      }
      if (this.hooks.onUserGesture) this.hooks.onUserGesture();
    }, { passive: true });

    window.addEventListener('touchend', () => {
      if (this.hooks.onUserGesture) this.hooks.onUserGesture();
    }, { passive: true });

    window.addEventListener('resize', () => this._updatePortraitTip());
    window.addEventListener('orientationchange', () => setTimeout(() => this._updatePortraitTip(), 120));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
    window.addEventListener('blur', () => this.reset());

    const root = this.dom.root;
    if (!root) return;

    /* 阻止游戏触控层默认滚动、双指缩放与长按菜单 */
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    root.addEventListener('touchmove', (e) => {
      if (this.active) e.preventDefault();
    }, { passive: false });

    /* ---------------- 左半屏浮动摇杆 ---------------- */
    const joyZone = this.dom.joyZone;
    if (joyZone) {
      joyZone.addEventListener('pointerdown', (e) => {
        if (!this.active || this.joyPointerId !== null) return;
        e.preventDefault();
        e.stopPropagation();
        try { joyZone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        this.joyPointerId = e.pointerId;

        const rect = joyZone.getBoundingClientRect();
        this.joyMaxR = window.innerWidth < 420 ? 44 : 52;
        const pad = this.joyMaxR + 14;
        const cx = clamp(e.clientX, rect.left + pad, Math.max(rect.left + pad, rect.right - pad));
        const cy = clamp(e.clientY, rect.top + pad, Math.max(rect.top + pad, rect.bottom - pad));
        this.joyOriginX = cx;
        this.joyOriginY = cy;

        if (this.dom.joyBase) {
          this.dom.joyBase.classList.add('active');
          this.dom.joyBase.style.left = `${cx - rect.left}px`;
          this.dom.joyBase.style.top = `${cy - rect.top}px`;
          this.dom.joyBase.style.bottom = 'auto';
        }
        this._updateJoyFromPoint(e.clientX, e.clientY);
      });

      joyZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.joyPointerId) return;
        e.preventDefault();
        this._updateJoyFromPoint(e.clientX, e.clientY);
      });

      const endJoy = (e) => {
        if (e.pointerId !== this.joyPointerId) return;
        this.joyPointerId = null;
        this.stick.x = 0;
        this.stick.y = 0;
        this.stick.len = 0;
        this.joySprint = false;
        this._resetJoyVisual();
        this._syncSprintVisual();
      };
      joyZone.addEventListener('pointerup', endJoy);
      joyZone.addEventListener('pointercancel', endJoy);
      joyZone.addEventListener('lostpointercapture', endJoy);
    }

    /* 冲刺锁定胶囊 */
    if (this.dom.btnSprint) {
      this.dom.btnSprint.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.sprintLock = !this.sprintLock;
        if (this.sprintLock && this.crouchToggle) {
          this.crouchToggle = false;
          this._syncCrouchVisual();
        }
        this._haptic(8);
        this._syncSprintVisual();
      });
    }

    /* ---------------- 全屏自由视角区 ---------------- */
    const lookZone = this.dom.lookZone;
    if (lookZone) {
      lookZone.addEventListener('pointerdown', (e) => {
        if (!this.active || this.lookPointerId !== null) return;
        e.preventDefault();
        try { lookZone.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        this.lookPointerId = e.pointerId;
        this.lookLastX = e.clientX;
        this.lookLastY = e.clientY;
      });

      lookZone.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.lookPointerId) return;
        e.preventDefault();
        const dx = e.clientX - this.lookLastX;
        const dy = e.clientY - this.lookLastY;
        this.lookLastX = e.clientX;
        this.lookLastY = e.clientY;
        this._applyLookDelta(dx, dy);
      });

      const endLook = (e) => {
        if (e.pointerId !== this.lookPointerId) return;
        this.lookPointerId = null;
      };
      lookZone.addEventListener('pointerup', endLook);
      lookZone.addEventListener('pointercancel', endLook);
      lookZone.addEventListener('lostpointercapture', endLook);
    }

    /* ---------------- 右下角跑酷动作键（支持按住划动视角） ---------------- */
    const bindActionBtn = (el, { onPress, onRelease, allowLookDrag = true }) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        if (!this.active) return;
        e.preventDefault();
        e.stopPropagation();
        try { el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        el.classList.add('pressed');
        this.btnPointers.set(e.pointerId, { el, lastX: e.clientX, lastY: e.clientY, allowLookDrag, onRelease });
        if (onPress) onPress(e);
      });
      el.addEventListener('pointermove', (e) => {
        const rec = this.btnPointers.get(e.pointerId);
        if (!rec) return;
        e.preventDefault();
        const dx = e.clientX - rec.lastX;
        const dy = e.clientY - rec.lastY;
        rec.lastX = e.clientX;
        rec.lastY = e.clientY;
        if (rec.allowLookDrag && this.lookPointerId === null) {
          this._applyLookDelta(dx, dy);
        }
      });
      const finish = (e) => {
        const rec = this.btnPointers.get(e.pointerId);
        if (!rec) return;
        this.btnPointers.delete(e.pointerId);
        rec.el.classList.remove('pressed');
        if (rec.onRelease) rec.onRelease(e);
      };
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
      el.addEventListener('lostpointercapture', finish);
    };

    bindActionBtn(this.dom.btnJump, {
      onPress: () => {
        this._haptic(8);
        if (this.crouchToggle) {
          this.crouchToggle = false;
          this._syncCrouchVisual();
        }
        if (this.hooks.onJump) this.hooks.onJump();
      },
    });

    bindActionBtn(this.dom.btnCrouch, {
      onPress: () => {
        this._haptic(8);
        this.crouchDown = true;
        this.crouchDownAt = performance.now();
        this.crouchWasFast = (this.hooks.getSpeed ? this.hooks.getSpeed() : 0) > 7.0;
        if (this.crouchWasFast) this.crouchToggle = false;
        this._syncCrouchVisual();
      },
      onRelease: () => {
        this.crouchDown = false;
        const heldMs = performance.now() - this.crouchDownAt;
        if (!this.crouchWasFast && heldMs < 250) {
          this.crouchToggle = !this.crouchToggle;
          if (this.crouchToggle) this.sprintLock = false;
          this._syncSprintVisual();
        }
        this._syncCrouchVisual();
      },
    });

    bindActionBtn(this.dom.btnUse, {
      onPress: () => {
        this._haptic(10);
        if (this.hooks.onInteract) this.hooks.onInteract();
      },
    });

    bindActionBtn(this.dom.btnMelee, {
      onPress: () => {
        this._haptic(14);
        if (this.hooks.onMelee) this.hooks.onMelee();
      },
    });

    bindActionBtn(this.dom.btnTurn, {
      allowLookDrag: false,
      onPress: () => {
        this._haptic(8);
        if (this.hooks.onTurn180) this.hooks.onTurn180();
      },
    });

    /* ---------------- 顶部快捷栏 ---------------- */
    const bindQuick = (el, fn) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._haptic(6);
        fn();
      });
    };
    bindQuick(this.dom.qbMission, () => this.hooks.onToggleMissions && this.hooks.onToggleMissions());
    bindQuick(this.dom.qbShop, () => this.hooks.onToggleShop && this.hooks.onToggleShop());
    bindQuick(this.dom.qbTrial, () => this.hooks.onToggleTrial && this.hooks.onToggleTrial());
    bindQuick(this.dom.qbRecords, () => this.hooks.onToggleRecords && this.hooks.onToggleRecords());
    bindQuick(this.dom.qbChat, () => this.hooks.onOpenChat && this.hooks.onOpenChat());
    bindQuick(this.dom.qbPause, () => this.hooks.onTogglePause && this.hooks.onTogglePause());

    /* 点击中央互动提示条可直接触发对应动作（缴械或滑索/攀爬互动） */
    if (this.dom.prompt) {
      this.dom.prompt.addEventListener('pointerdown', (e) => {
        if (!this.active || !this.dom.prompt.classList.contains('show')) return;
        e.preventDefault();
        e.stopPropagation();
        this._haptic(10);
        if (this._lastMeleeGlow && this.hooks.onMelee) this.hooks.onMelee();
        else if (this.hooks.onInteract) this.hooks.onInteract();
      });
    }

    /* 竖屏提示条按钮 */
    if (this.dom.btnPortraitFs) {
      this.dom.btnPortraitFs.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleFullscreen(true);
      });
    }
    if (this.dom.btnPortraitClose) {
      this.dom.btnPortraitClose.addEventListener('click', (e) => {
        e.stopPropagation();
        this._portraitDismissed = true;
        this._updatePortraitTip();
      });
    }
  }
}
