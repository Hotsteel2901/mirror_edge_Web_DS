import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { Pass } from '../vendor/addons/postprocessing/Pass.js';
import { clamp, damp } from './util.js';

/* =========================================================================
   图形管线 —— 光照 / 阴影 / 大气 / 色彩
   ------------------------------------------------------------------------
   · 单一太阳方向贯穿：天空着色器、平行光、镜头光晕、体积光、大气透视
   · 阴影：按需重绘 + 光照空间纹素吸附（消除相机移动时的阴影闪烁）
   · 天空环境：用同一套天空着色器烘 PMREM，玻璃 / 金属反射真实天光
   · 大气透视：半分辨率法线+深度预通道 → 逐像素按视线方向混合天空色，
     太阳前向散射（Mie）与高度雾同时生效，远景有真实空气感
   · 后期：SSAO → 体积光 → Bloom → ACES / 调色 / 暗角 / 颗粒 / 色差
   ========================================================================= */

const SUN_DIR_DEFAULT = new THREE.Vector3(0.58, 0.34, 0.47).normalize();

/* ------------------------------------------------------------------ 阴影 */
class ShadowRig {
  constructor(renderer, scene, sunDir) {
    this.renderer = renderer;
    this.scene = scene;
    this.dir = sunDir.clone();
    this.half = 90;
    this.mapSize = 4096;
    this.tier = 'high';
    this._keyX = Infinity; this._keyY = Infinity; this._keyZ = Infinity;
    this._right = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._target = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xfff2da, 3.45);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.mapSize, this.mapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -this.half; cam.right = this.half;
    cam.top = this.half; cam.bottom = -this.half;
    cam.near = 1; cam.far = 620;
    this.sun.shadow.bias = -0.00028;
    this.sun.shadow.normalBias = 0.035;
    cam.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0x9dc4ea, 0x6f6a60, 0.22);
    scene.add(this.hemi);
  }

  setTier(tier) {
    this.tier = tier;
    const spec = tier === 'high' ? { size: 4096, half: 96 }
      : tier === 'medium' ? { size: 2048, half: 74 }
        : { size: 1024, half: 52 };
    this.half = spec.half;
    if (this.mapSize !== spec.size) {
      this.mapSize = spec.size;
      this.sun.shadow.mapSize.set(spec.size, spec.size);
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
      this._keyX = Infinity;
    }
    const cam = this.sun.shadow.camera;
    cam.left = -this.half; cam.right = this.half;
    cam.top = this.half; cam.bottom = -this.half;
    cam.updateProjectionMatrix();
    this.renderer.shadowMap.needsUpdate = true;
  }

  setSunDir(d) {
    this.dir.copy(d).normalize();
    this._keyX = Infinity;
    this.renderer.shadowMap.needsUpdate = true;
  }

  /* 光照空间基：与相机 lookAt 一致（z 轴指向太阳，x = up × z） */
  basis() {
    const z = this.dir;
    this._right.set(0, 1, 0).cross(z).normalize();
    if (this._right.lengthSq() < 1e-6) this._right.set(1, 0, 0);
    this._up.crossVectors(z, this._right).normalize();
  }

  /* 把阴影相机锚点吸附到「纹素整数倍」的网格上：
     纹素边界永远与屏幕对齐，相机平移时阴影不会蠕动（shadow shimmer）。 */
  follow(target) {
    this.basis();
    const texel = (this.half * 2) / this.mapSize;
    const stepTexels = Math.max(1, Math.round(0.85 / texel));
    const g = texel * stepTexels;
    const u = Math.round(target.dot(this._right) / g) * g;
    const v = Math.round(target.dot(this._up) / g) * g;
    const w = target.dot(this.dir);
    const su = Math.round(u / texel) * texel;
    const sv = Math.round(v / texel) * texel;

    const kx = Math.round(su * 100), ky = Math.round(sv * 100), kz = Math.round(w * 100);
    if (kx === this._keyX && ky === this._keyY && kz === this._keyZ) return false;
    this._keyX = kx; this._keyY = ky; this._keyZ = kz;

    const t = this._target
      .copy(this._right).multiplyScalar(su)
      .addScaledVector(this._up, sv)
      .addScaledVector(this.dir, w);

    this.sun.position.copy(t).addScaledVector(this.dir, 320);
    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
    this.renderer.shadowMap.needsUpdate = true;
    return true;
  }
}

/* ------------------------------------------------------- 预通道（法线+深度） */
const PREPASS_VERT = `
  varying vec3 vN;
  varying float vZ;
  void main() {
    vec4 pos = vec4(position, 1.0);
    vec3 nrm = normal;
    #ifdef USE_INSTANCING
      pos = instanceMatrix * pos;
      nrm = mat3(instanceMatrix) * nrm;
    #endif
    vec4 mv = modelViewMatrix * pos;
    vN = normalMatrix * nrm;
    vZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const PREPASS_FRAG = `
  varying vec3 vN;
  varying float vZ;
  void main() {
    vec3 n = normalize(vN);
    gl_FragColor = vec4(n * 0.5 + 0.5, vZ);
  }
`;

/* ------------------------------------------------------------------ 管线 */

/* ------------------------------------------------------- 体积光（半分辨率 + 模糊） */
class GodRayPass extends Pass {
  constructor(prepassTexture, width, height) {
    super();
    this.needsSwap = true;
    this.enabled = true;
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.rtA = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.uniforms = {
      tDiffuse: { value: null },
      tPrepass: { value: prepassTexture },
      uSun: { value: new THREE.Vector2(0.5, 0.5) },
      uOn: { value: 0 },
      uIntensity: { value: 0.5 },
      uSamples: { value: 18 },
      uColor: { value: new THREE.Color(0xffe9c8) },
      uTime: { value: 0 },
    };
    this.rayMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tPrepass;
        uniform vec2 uSun;
        uniform float uOn;
        uniform float uIntensity;
        uniform float uSamples;
        uniform vec3 uColor;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
        void main() {
          if (uOn <= 0.002) { gl_FragColor = vec4(0.0); return; }
          vec2 delta = (uSun - vUv) / uSamples;
          vec2 uv = vUv;
          float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          uv += delta * ign;
          vec3 sum = vec3(0.0);
          float w = 1.0;
          float total = 0.0;
          for (int i = 0; i < 32; i++) {
            if (float(i) >= uSamples) break;
            uv += delta;
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
            vec3 c = texture2D(tDiffuse, uv).rgb;
            float lum = dot(c, vec3(0.299, 0.587, 0.114));
            float m = smoothstep(0.72, 1.6, lum);
            float d = texture2D(tPrepass, uv).w;
            float sky = d < 0.05 ? 1.0 : 0.3;
            sum += c * m * w * sky;
            total += w;
            w *= 0.966;
          }
          vec3 rays = (sum / max(total, 0.001)) * uIntensity * uOn * uColor;
          gl_FragColor = vec4(rays, 1.0);
        }
      `,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: this.rtA.texture }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) } },
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec3 s = vec3(0.0);
          float wsum = 0.0;
          for (int y = -2; y <= 2; y++) {
            for (int x = -2; x <= 2; x++) {
              float w = exp(-float(x * x + y * y) * 0.3);
              s += texture2D(tDiffuse, vUv + vec2(float(x), float(y)) * uTexel * 1.35).rgb * w;
              wsum += w;
            }
          }
          gl_FragColor = vec4(s / max(wsum, 0.0001), 1.0);
        }
      `,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, tRays: { value: this.rtA.texture } },
      depthTest: false,
      depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform sampler2D tRays;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          c.rgb += texture2D(tRays, vUv).rgb;
          gl_FragColor = c;
        }
      `,
    });
  }

  setSize(w, h) {
    const pw = Math.max(1, Math.floor(w / 2)), ph = Math.max(1, Math.floor(h / 2));
    this.rtA.setSize(pw, ph);
    this.rtB.setSize(pw, ph);
    this.blurMat.uniforms.uTexel.value.set(1 / pw, 1 / ph);
  }

  render(renderer, writeBuffer, readBuffer) {
    const r = renderer;
    /* 1. 半分辨率体积光 */
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.rayMat;
    r.setRenderTarget(this.rtA);
    r.clear(true, false, false);
    r.render(this.scene, this.cam);
    /* 2. 两次 5x5 高斯模糊（乒乓），彻底消除射线步进噪声 */
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
    r.setRenderTarget(this.rtB);
    r.clear(true, false, false);
    r.render(this.scene, this.cam);
    this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
    r.setRenderTarget(this.rtA);
    r.clear(true, false, false);
    r.render(this.scene, this.cam);
    /* 3. 合成回主链 */
    this.compMat.uniforms.tRays.value = this.rtA.texture;
    this.compMat.uniforms.tDiffuse.value = readBuffer.texture;
    this.quad.material = this.compMat;
    r.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    r.clear(true, false, false);
    r.render(this.scene, this.cam);
    r.setRenderTarget(null);
  }
}

export class Graphics {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.sunDir = SUN_DIR_DEFAULT.clone();
    this.skyCols = {
      zenith: new THREE.Color(0x2f6cb4),
      horizon: new THREE.Color(0xd7e9f4),
      ground: new THREE.Color(0xb9c8d2),
      sun: new THREE.Color(0xfff0cf),
    };
    this.quality = 'high';
    this.rt = 'low';
    this.time = 0;
    this.exposure = 1.02;
    this.renderScale = 1;
    this._scaleTimer = 0;
    this._frameAcc = 0;
    this._frameCount = 0;
    this.fpsAvg = 60;

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;

    this.shadow = new ShadowRig(renderer, scene, this.sunDir);

    this._buildSunVisuals();
    this._buildPrepass();
    this._buildPasses();
    this.setQuality('high');
    this.setRT('low');
  }

  /* ---------------------------------------------------- 太阳视觉 */
  _buildSunVisuals() {
    const tex = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.12, 'rgba(255,250,232,0.98)');
      g.addColorStop(0.3, 'rgba(255,226,168,0.42)');
      g.addColorStop(0.62, 'rgba(255,206,140,0.11)');
      g.addColorStop(1, 'rgba(255,190,110,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 256, 256);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    this.sunCore = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xfffaf0, transparent: true, opacity: 0.62,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
    }));
    this.sunCore.layers.set(1);
    this.sunCore.scale.setScalar(115);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0xffe2b4, transparent: true, opacity: 0.17,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, fog: false,
    }));
    this.sunGlow.layers.set(1);
    this.sunGlow.scale.setScalar(360);
    this.scene.add(this.sunCore);
    this.scene.add(this.sunGlow);
  }

  /* ---------------------------------------------------- 预通道 */
  _buildPrepass() {
    const w = Math.max(1, Math.floor(window.innerWidth / 2));
    const h = Math.max(1, Math.floor(window.innerHeight / 2));
    this.prepassRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.prepassMat = new THREE.ShaderMaterial({
      vertexShader: PREPASS_VERT,
      fragmentShader: PREPASS_FRAG,
    });
    this._clearColor = new THREE.Color();
    this._clearAlpha = 1;
  }

  _renderPrepass() {
    const r = this.renderer;
    r.getClearColor(this._clearColor);
    this._clearAlpha = r.getClearAlpha();
    this.camera.layers.disable(1);
    this.scene.overrideMaterial = this.prepassMat;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.prepassRT);
    r.clear(true, true, false);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.setClearColor(this._clearColor, this._clearAlpha);
    this.scene.overrideMaterial = null;
    this.camera.layers.enable(1);
  }

  /* ---------------------------------------------------- 后期各 pass */
  _buildPasses() {
    const renderer = this.renderer;
    const scene = this.scene;
    const camera = this.camera;
    const composer = new EffectComposer(renderer);
    this.composer = composer;
    composer.addPass(new RenderPass(scene, camera));

    /* --- SSAO（屏幕空间环境光遮蔽） --- */
    const aoShader = {
      uniforms: {
        tDiffuse: { value: null },
        tPrepass: { value: null },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uFovTan: { value: 0.6 },
        uAspect: { value: window.innerWidth / window.innerHeight },
        uProj: { value: new THREE.Matrix4() },
        uRadius: { value: 0.9 },
        uAO: { value: 0.62 },
        uAOSamples: { value: 8 },
        uMaxDist: { value: 90 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tPrepass;
        uniform vec2 uResolution;
        uniform float uFovTan;
        uniform float uAspect;
        uniform mat4 uProj;
        uniform float uRadius;
        uniform float uAO;
        uniform float uAOSamples;
        uniform float uMaxDist;
        varying vec2 vUv;

        vec3 viewPosFrom(vec2 uv, float vz) {
          vec2 ndc = uv * 2.0 - 1.0;
          return vec3(ndc.x * uFovTan * uAspect, ndc.y * uFovTan, -1.0) * vz;
        }
        vec2 project(vec3 vp) {
          vec4 c = uProj * vec4(vp, 1.0);
          return (c.xy / c.w) * 0.5 + 0.5;
        }
        float hash12(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main() {
          vec4 color = texture2D(tDiffuse, vUv);
          vec4 pd = texture2D(tPrepass, vUv);
          float vz = pd.w;
          if (!(vz > 0.05) || vz > uMaxDist) { gl_FragColor = color; return; }
          vec3 n = pd.xyz * 2.0 - 1.0;
          float nl = length(n);
          if (!(nl > 0.5)) { gl_FragColor = color; return; }
          n /= nl;
          vec3 vp = viewPosFrom(vUv, vz);

          float ang = hash12(vUv * uResolution) * 6.2831853;
          vec3 rvec = normalize(vec3(cos(ang), sin(ang), 0.42));
          vec3 tangent = normalize(rvec - n * dot(rvec, n));
          vec3 bitan = cross(n, tangent);
          mat3 tbn = mat3(tangent, bitan, n);
          float aoRadius = uRadius * clamp(vz * 0.16, 0.28, 1.5);
          float occ = 0.0;
          float wsum = 0.0;
          for (int i = 0; i < 16; i++) {
            if (float(i) >= uAOSamples) break;
            float fi = float(i);
            float a = fi * 2.3999632 + ang;
            float r = aoRadius * (0.22 + 0.78 * fract(fi * 0.6180339));
            vec3 dir = normalize(vec3(cos(a), sin(a), 0.55 + 0.65 * fract(fi * 0.3183)));
            dir = tbn * dir;
            vec3 sp = vp + dir * r;
            vec2 suv = project(sp);
            if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
            float sz = texture2D(tPrepass, suv).w;
            if (!(sz > 0.05)) continue;
            float svz = -sz;
            float dz = sp.z - svz;
            float w = 1.0 - clamp(abs(vp.z - svz) / (aoRadius * 4.0), 0.0, 1.0);
            wsum += w;
            if (dz < -0.05) occ += w * clamp(1.0 - abs(dz) / (aoRadius * 2.5), 0.0, 1.0);
          }
          float ao = 1.0 - (occ / max(wsum, 0.001)) * uAO;
          ao = clamp(ao, 0.42, 1.0);
          float fade = smoothstep(uMaxDist, uMaxDist * 0.55, vz);
          color.rgb *= mix(1.0, ao, fade);
          gl_FragColor = color;
        }
      `,
    };
    this.aoPass = new ShaderPass(aoShader);
    this.aoPass.material.depthTest = false;
    this.aoPass.material.depthWrite = false;
    this.aoPass.uniforms.tPrepass.value = this.prepassRT.texture;
    composer.addPass(this.aoPass);

    /* --- 体积光 / 上帝光：半分辨率射线 + 5x5 高斯模糊（消除逐像素噪声） --- */
    this.godPass = new GodRayPass(this.prepassRT.texture, window.innerWidth, window.innerHeight);
    composer.addPass(this.godPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.26, 0.62, 0.86);
    composer.addPass(this.bloomPass);

    this._buildGradePass();
  }

  /* --- ACES + 空气透视 + 调色 + 暗角 + 颗粒 + 色差 --- */
  _buildGradePass() {
    const gradeShader = {
      uniforms: {
        tDiffuse: { value: null },
        tPrepass: { value: null },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uInvProj: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uExposure: { value: 1.02 },
        uSkyZenith: { value: this.skyCols.zenith.clone() },
        uSkyHorizon: { value: this.skyCols.horizon.clone() },
        uSkyGround: { value: this.skyCols.ground.clone() },
        uSunColor: { value: this.skyCols.sun.clone() },
        uSunDir: { value: this.sunDir.clone() },
        uFogDensity: { value: 0.00042 },
        uFogFalloff: { value: 1.55 },
        uFogStrength: { value: 0.9 },
        uSat: { value: 1.13 },
        uContrast: { value: 1.17 },
        uGradeMix: { value: 1.0 },
        uVignette: { value: 0.32 },
        uGrain: { value: 0.0038 },
        uChroma: { value: 0.0 },
        uSpeed: { value: 0.0 },
        uTime: { value: 0 },
        uDamage: { value: 0.0 },
        uFlash: { value: 0.0 },
        uFlow: { value: 0.0 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tPrepass;
        uniform vec2 uResolution;
        uniform mat4 uInvProj;
        uniform mat4 uCamWorld;
        uniform float uExposure;
        uniform vec3 uSkyZenith;
        uniform vec3 uSkyHorizon;
        uniform vec3 uSkyGround;
        uniform vec3 uSunColor;
        uniform vec3 uSunDir;
        uniform float uFogDensity;
        uniform float uFogFalloff;
        uniform float uFogStrength;
        uniform float uSat;
        uniform float uContrast;
        uniform float uGradeMix;
        uniform float uVignette;
        uniform float uGrain;
        uniform float uChroma;
        uniform float uSpeed;
        uniform float uTime;
        uniform float uDamage;
        uniform float uFlash;
        uniform float uFlow;
        varying vec2 vUv;

        /* 与天空着色器一致的解析天空色（用于空气透视） */
        vec3 skyColor(vec3 d) {
          float h = d.y;
          vec3 col = mix(uSkyHorizon, uSkyZenith, pow(clamp(h, 0.0, 1.0), 0.52));
          if (h < 0.0) col = mix(uSkyHorizon, uSkyGround, smoothstep(0.0, -0.22, h));
          float cosT = dot(d, uSunDir);
          col += uSunColor * (pow(max(cosT, 0.0), 6.0) * 0.16 + pow(max(cosT, 0.0), 90.0) * 0.55);
          return col;
        }
        vec3 acesFilm(vec3 x) {
          x *= 0.9;
          return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
        }
        vec3 sRGB(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
        float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

        void main() {
          vec2 dir = vUv - 0.5;
          float r2 = dot(dir, dir);
          float k = uChroma * (0.5 + r2 * 2.6);
          vec3 hdr;
          hdr.r = texture2D(tDiffuse, vUv + dir * k).r;
          hdr.g = texture2D(tDiffuse, vUv).g;
          hdr.b = texture2D(tDiffuse, vUv - dir * k).b;

          /* ---- 空气透视 ---- */
          float vz = texture2D(tPrepass, vUv).w;
          if (vz > 0.05) {
            vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
            vec4 vp = uInvProj * ndc;
            vp.xyz /= vp.w;
            vec3 worldDir = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
            vec3 camFwd = normalize((uCamWorld * vec4(0.0, 0.0, -1.0, 0.0)).xyz);
            float dist = vz / max(0.18, dot(worldDir, camFwd));
            float fog = 1.0 - exp(-pow(dist * uFogDensity, uFogFalloff) * uFogStrength);
            fog = clamp(fog, 0.0, 0.94);
            float sunAmt = pow(max(dot(worldDir, uSunDir), 0.0), 5.0);
            vec3 air = skyColor(worldDir) * (1.0 + sunAmt * 0.55);
            hdr = mix(hdr, air, fog);
          }

          hdr *= uExposure;
          vec3 col = acesFilm(hdr);

          /* ---- 调色：分离色调 + 对比 + 饱和 ---- */
          vec3 graded = col;
          graded = mix(vec3(0.5), graded, uContrast);
          float lum = dot(graded, vec3(0.2126, 0.7152, 0.0722));
          vec3 cool = vec3(0.94, 0.99, 1.07);
          vec3 warm = vec3(1.05, 1.01, 0.95);
          vec3 tone = mix(cool, warm, smoothstep(0.15, 0.85, lum));
          graded *= tone;
          graded = mix(vec3(lum), graded, uSat);
          col = mix(col, clamp(graded, 0.0, 1.0), uGradeMix);

          /* ---- 暗角 ---- */
          float vig = 1.0 - smoothstep(0.28, 0.95, r2 * 1.9) * uVignette;
          col *= vig;
          col *= mix(1.0, 0.94, uSpeed * smoothstep(0.2, 1.0, r2 * 2.0));

          /* ---- 受击 / 高光闪白 ---- */
          col = mix(col, col * vec3(1.0, 0.55, 0.5), uDamage * smoothstep(0.02, 0.85, r2 * 3.0));
          col += uFlash * 0.22;

          /* ---- 胶片颗粒 ---- */
          float g = hash(vUv * uResolution + fract(uTime) * 517.0) - 0.5;
          col += g * uGrain * (1.0 - lum * 0.65);

          col = clamp(col, 0.0, 1.0);
          gl_FragColor = vec4(sRGB(col), 1.0);
        }
      `,
    };
    this.gradePass = new ShaderPass(gradeShader);
    this.gradePass.material.depthTest = false;
    this.gradePass.material.depthWrite = false;
    this.gradePass.uniforms.tPrepass.value = this.prepassRT.texture;
    this.composer.addPass(this.gradePass);
  }

  /* ---------------------------------------------------- 设置 */
  setQuality(q) {
    this.quality = q;
    const shadowTier = q === 'high' ? 'high' : q === 'medium' ? 'medium' : 'low';
    this.shadow.setTier(shadowTier);
    if (q === 'low') {
      for (let i = 1; i < this.composer.passes.length; i++) this.composer.passes[i].enabled = false;
      this.shadow.sun.castShadow = false;
      this.renderer.shadowMap.enabled = false;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.0;
      this.renderScale = 1;
      return;
    }
    this.renderer.shadowMap.enabled = true;
    this.shadow.sun.castShadow = true;
    this.shadow.setTier(shadowTier);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.aoPass.enabled = this.rt !== 'off';
    this.godPass.enabled = this.rt !== 'off';
    this.bloomPass.enabled = true;
    this.bloomPass.strength = q === 'medium' ? 0.16 : 0.26;
    this.bloomPass.radius = q === 'medium' ? 0.5 : 0.62;
    this.gradePass.enabled = true;
    this.applyRT(this.rt);
  }

  applyRT(mode) {
    this.rt = mode;
    if (this.quality === 'low' || mode === 'off') {
      this.aoPass.enabled = false;
      this.godPass.enabled = false;
      return;
    }
    this.aoPass.enabled = true;
    this.godPass.enabled = true;
    if (mode === 'high') {
      this.aoPass.uniforms.uAOSamples.value = 14;
      this.aoPass.uniforms.uAO.value = 0.74;
      this.aoPass.uniforms.uRadius.value = 1.05;
      this.aoPass.uniforms.uMaxDist.value = 130;
      this.godPass.uniforms.uSamples.value = 26;
      this.godPass.uniforms.uIntensity.value = 0.5;
    } else {
      this.aoPass.uniforms.uAOSamples.value = 8;
      this.aoPass.uniforms.uAO.value = 0.56;
      this.aoPass.uniforms.uRadius.value = 0.78;
      this.aoPass.uniforms.uMaxDist.value = 95;
      this.godPass.uniforms.uSamples.value = 16;
      this.godPass.uniforms.uIntensity.value = 0.34;
    }
  }
  setRT(mode) { this.applyRT(mode); }

  /* 用天空材质烘 PMREM 环境贴图：玻璃/金属反射真实天光 */
  bakeEnvironment(skyMat) {
    try {
      const skyScene = new THREE.Scene();
      const mat = skyMat.clone();
      mat.side = THREE.BackSide;
      mat.depthWrite = false;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 16), mat);
      skyScene.add(mesh);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const rt = pmrem.fromScene(skyScene, 0.015);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
      this.scene.environmentIntensity = 0.72;
      pmrem.dispose();
      mesh.geometry.dispose();
      mat.dispose();
    } catch (e) {
      console.warn('[graphics] env bake failed', e);
    }
  }

  setSkyPalette(zenith, horizon, ground, sun) {
    this.skyCols.zenith.set(zenith);
    this.skyCols.horizon.set(horizon);
    this.skyCols.ground.set(ground);
    this.skyCols.sun.set(sun);
    const u = this.gradePass.uniforms;
    u.uSkyZenith.value.copy(this.skyCols.zenith);
    u.uSkyHorizon.value.copy(this.skyCols.horizon);
    u.uSkyGround.value.copy(this.skyCols.ground);
    u.uSunColor.value.copy(this.skyCols.sun);
  }

  setSunDir(dir) {
    this.sunDir.copy(dir).normalize();
    this.shadow.setSunDir(this.sunDir);
    this.gradePass.uniforms.uSunDir.value.copy(this.sunDir);
  }

  /* 时段预设：太阳角度 / 色温 / 天空调色 / 空气密度 / 曝光，一套切换 */
  setPreset(name) {
    const PRESETS = {
      morning: {
        /* 顺光：太阳位于默认朝向（+x）背后偏右，城市正面受光、天空深蓝、无直射眩光 */
        dir: [-0.42, 0.40, 0.62], sun: 0xfff4e0, sunI: 4.0, hemiI: 0.16,
        zenith: 0x2a67b2, horizon: 0xd2e6f2, ground: 0xb4c4ce,
        exposure: 0.95, fog: [0.0005, 1.52, 0.8], bloom: 0.22,
      },
      noon: {
        dir: [0.42, 0.72, 0.46], sun: 0xfffaf0, sunI: 4.1, hemiI: 0.40,
        zenith: 0x2a6bc0, horizon: 0xd8ecf7, ground: 0xbcc9d2,
        exposure: 1.0, fog: [0.00050, 1.5, 0.86], bloom: 0.22,
      },
      golden: {
        dir: [0.78, 0.18, 0.34], sun: 0xffb277, sunI: 3.0, hemiI: 0.24,
        zenith: 0x244a80, horizon: 0xf0bd8e, ground: 0xa8856f,
        exposure: 1.02, fog: [0.00062, 1.55, 0.95], bloom: 0.3,
      },
      overcast: {
        dir: [0.32, 0.55, 0.62], sun: 0xe6eef4, sunI: 1.55, hemiI: 0.62,
        zenith: 0x8195a8, horizon: 0xd6e1e8, ground: 0xb2bec6,
        exposure: 1.06, fog: [0.0009, 1.4, 1.0], bloom: 0.18,
      },
    };
    const p = PRESETS[name];
    if (!p) return null;
    this.setSunDir(new THREE.Vector3(p.dir[0], p.dir[1], p.dir[2]));
    this.shadow.sun.color.setHex(p.sun);
    this.shadow.sun.intensity = p.sunI;
    this.shadow.hemi.intensity = p.hemiI;
    this.shadow.hemi.color.setHex(p.horizon);
    this.setSkyPalette(p.zenith, p.horizon, p.ground, p.sun);
    this.exposure = p.exposure;
    const u = this.gradePass.uniforms;
    u.uFogDensity.value = p.fog[0];
    u.uFogFalloff.value = p.fog[1];
    u.uFogStrength.value = p.fog[2];
    this.bloomPass.strength = p.bloom * (this.quality === 'medium' ? 0.62 : 1);
    this.sunCore.material.color.setHex(p.sun);
    this.sunGlow.material.color.setHex(p.sun);
    this.renderer.shadowMap.needsUpdate = true;
    return p;
  }

  /* ---------------------------------------------------- 每帧 */
  update(dt, ctx) {
    this.time += dt;
    const camera = this.camera;
    const P = ctx && ctx.P;
    if (P) this.shadow.follow(P.pos);

    const d = this.sunDir;
    const camPos = camera.position;
    this.sunCore.position.copy(camPos).addScaledVector(d, 1250);
    this.sunGlow.position.copy(this.sunCore.position);

    const ndc = this._ndc || (this._ndc = new THREE.Vector3());
    ndc.copy(this.sunCore.position).project(camera);
    const fwd = this._camDir || (this._camDir = new THREE.Vector3());
    camera.getWorldDirection(fwd);
    const facing = fwd.dot(d);
    let on = 0;
    if (ndc.z < 1 && facing > 0.02) on = clamp((facing - 0.02) * 2.4, 0, 1);
    const sx = ndc.x * 0.5 + 0.5, sy = ndc.y * 0.5 + 0.5;
    this.godPass.uniforms.uSun.value.set(sx, sy);
    this.godPass.uniforms.uOn.value = this.aoPass.enabled ? on : 0;
    this.godPass.uniforms.uTime.value = this.time;

    const u = this.gradePass.uniforms;
    u.uTime.value = this.time;
    u.uInvProj.value.copy(camera.projectionMatrixInverse);
    u.uCamWorld.value.copy(camera.matrixWorld);
    u.uExposure.value = this.exposure;
    const speed01 = ctx ? clamp((ctx.speed || 0) / 12, 0, 1) : 0;
    u.uSpeed.value = damp(u.uSpeed.value, speed01, 4, dt);
    u.uChroma.value = damp(u.uChroma.value, 0.0009 + speed01 * 0.0032 + (ctx && ctx.flow ? 0.0012 : 0), 3, dt);
    u.uDamage.value = damp(u.uDamage.value, ctx && ctx.damage ? ctx.damage : 0, 6, dt);
    u.uFlash.value = damp(u.uFlash.value, ctx && ctx.flash ? ctx.flash : 0, 8, dt);
    u.uFlow.value = ctx && ctx.flow ? 1 : 0;

    this.aoPass.uniforms.uProj.value.copy(camera.projectionMatrix);
    this.aoPass.uniforms.uFovTan.value = Math.tan((camera.fov * Math.PI) / 360);
    this.aoPass.uniforms.uAspect.value = camera.aspect;

    /* 自适应分辨率（仅高画质；缓慢、带滞回） */
    if (this.quality === 'high' && ctx && ctx.adaptive !== false) {
      this._frameAcc += dt;
      this._frameCount++;
      this._scaleTimer -= dt;
      if (this._frameAcc > 0.75) {
        this.fpsAvg = this._frameCount / this._frameAcc;
        this._frameAcc = 0; this._frameCount = 0;
        if (this._scaleTimer <= 0) {
          if (this.fpsAvg < 48 && this.renderScale > 0.7) {
            this.renderScale = Math.max(0.7, this.renderScale - 0.1);
            this._applyRenderScale();
            this._scaleTimer = 2.5;
          } else if (this.fpsAvg > 58 && this.renderScale < 1) {
            this.renderScale = Math.min(1, this.renderScale + 0.05);
            this._applyRenderScale();
            this._scaleTimer = 4;
          }
        }
      }
    }
  }

  _applyRenderScale() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer.setPixelRatio(this.renderer.getPixelRatio() * this.renderScale);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  render() {
    if (this.quality === 'low') {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.aoPass.enabled || this.godPass.enabled) this._renderPrepass();
    this.composer.render();
  }

  snap() {
    if (this.aoPass.enabled || this.godPass.enabled) this._renderPrepass();
    this.composer.render();
    return this.renderer.domElement.toDataURL('image/png');
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    const pw = Math.max(1, Math.floor(w / 2)), ph = Math.max(1, Math.floor(h / 2));
    this.prepassRT.setSize(pw, ph);
    this.aoPass.uniforms.tPrepass.value = this.prepassRT.texture;
    this.godPass.uniforms.tPrepass.value = this.prepassRT.texture;
    this.gradePass.uniforms.tPrepass.value = this.prepassRT.texture;
    this.godPass.setSize(w, h);
    for (const p of [this.aoPass, this.godPass, this.gradePass]) {
      if (p.uniforms.uResolution) p.uniforms.uResolution.value.set(w, h);
    }
    this.aoPass.uniforms.uAspect.value = w / h;
  }
}

export { SUN_DIR_DEFAULT };
