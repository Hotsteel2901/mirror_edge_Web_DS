
import * as THREE from '../vendor/three.module.js';

/* =========================================================================
   材质增强
   ------------------------------------------------------------------------
   · 世界空间 UV（triplanar，无需切线）：所有立面 / 屋顶使用真实米制纹理密度，
     30m 宽的楼与 8m 宽的楼窗户一样大，彻底消除 BoxGeometry 1×1 贴图的拉伸。
   · 由反照率自动生成凹凸贴图：窗洞内凹、板缝凸起，低角度阳光下层次立现。
   ========================================================================= */

function patchWorldUV(mat, scale, bumpScale) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWorldUV = { value: scale };
    shader.uniforms.uBumpUV = { value: scale };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        vec3 wNrm0 = objectNormal;
        #ifdef USE_INSTANCING
          wNrm0 = mat3( instanceMatrix ) * wNrm0;
        #endif
        vWNrm = normalize( mat3( modelMatrix ) * wNrm0 );`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 wPos0 = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          wPos0 = instanceMatrix * wPos0;
        #endif
        vWPos = ( modelMatrix * wPos0 ).xyz;`);

    const worldUVFn = `
        varying vec3 vWPos;
        varying vec3 vWNrm;
        uniform float uWorldUV;
        uniform float uBumpUV;
        vec2 worldUV() {
          vec3 an = abs( normalize( vWNrm ) );
          if ( an.y > 0.5 ) return vWPos.xz;
          if ( an.x > 0.5 ) return vWPos.zy;
          return vWPos.xy;
        }`;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + worldUVFn)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, worldUV() * uWorldUV );
        diffuseColor *= sampledDiffuseColor;
      #endif`);

    if (bumpScale > 0) {
      shader.fragmentShader = shader.fragmentShader
        .replace(/vBumpMapUv/g, '( worldUV() * uBumpUV )');
    }
    /* 自发光贴图（店面暖光）也使用同一套世界空间 UV */
    shader.fragmentShader = shader.fragmentShader
      .replace(/vEmissiveMapUv/g, '( worldUV() * uWorldUV )');
  };
  mat.customProgramCacheKey = () => 'worlduv';
}

/* 给材质启用世界空间 UV；opts: { scale: 1/tileMeters, bump: 纹理, bumpScale } */
export function applyWorldUV(mat, opts = {}) {
  const scale = opts.scale || 1 / 16;
  const bumpScale = opts.bump ? (opts.bumpScale !== undefined ? opts.bumpScale : 0.35) : 0;
  if (opts.bump) {
    mat.bumpMap = opts.bump;
    mat.bumpScale = bumpScale;
  }
  patchWorldUV(mat, scale, bumpScale);
  mat.needsUpdate = true;
  return mat;
}

/* 由反照率画布生成灰度高程图（窗洞暗 → 内凹），供 bumpMap 使用 */
export function makeBumpTexture(sourceTex, size = 256) {
  try {
    const src = sourceTex && sourceTex.image;
    if (!src) return null;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, size, size);
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    const lum = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      lum[i] = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) / 255;
    }
    /* 3×3 盒式模糊，去掉噪点，保留结构 */
    const out = g.createImageData(size, size);
    const o = out.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let s = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = (x + dx + size) % size;
            const yy = (y + dy + size) % size;
            s += lum[yy * size + xx];
            n++;
          }
        }
        const v = Math.round((s / n) * 255);
        const i4 = (y * size + x) * 4;
        o[i4] = o[i4 + 1] = o[i4 + 2] = v;
        o[i4 + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  } catch (e) {
    return null;
  }
}
