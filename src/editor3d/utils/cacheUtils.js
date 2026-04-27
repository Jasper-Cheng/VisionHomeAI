import * as THREE from "three";

import { resolveStyleTextureUrl } from "../../floorplan/floorplanStyle.js";

/** 纹理缓存：key = 纹理URL，value = THREE.Texture */
export const globalTextureCache = new Map();
/** 材质缓存：key = 材质定义的哈希，value = THREE.Material */
export const globalMaterialCache = new Map();
/** 风格预加载状态：key = styleKey，value = Promise */
export const stylePreloadPromises = new Map();

/**
 * 生成材质定义的哈希 key（用于材质缓存）
 * @param {object} def 材质定义
 * @param {number} opacity 透明度
 * @param {object} options 选项
 * @returns {string}
 */
export function getMaterialCacheKey(def, opacity, options = {}) {
  const parts = [
    def.type || "standard",
    def.color || "#ffffff",
    def.roughness ?? 0.55,
    def.metalness ?? 0.05,
    def.opacity ?? 1,
    def.transmission ?? 0,
    def.ior ?? 1.45,
    opacity,
    options.forGlass ? "glass" : "",
    options.floorUv ? "floor" : "",
    options.side || "front",
    JSON.stringify(def.uvScale || []),
    def.textureRotation || 0,
    JSON.stringify(def.texture || {}),
  ];
  return parts.join("|");
}

/**
 * 从缓存获取或创建纹理
 * @param {string} url 纹理URL
 * @param {THREE.TextureLoader} loader 纹理加载器
 * @param {boolean} isSRGB 是否为 sRGB 颜色空间
 * @returns {Promise<THREE.Texture | null>}
 */
export async function getCachedTexture(url, loader, isSRGB = false) {
  const cacheKey = `${url}|${isSRGB ? "srgb" : "linear"}`;
  if (globalTextureCache.has(cacheKey)) {
    return globalTextureCache.get(cacheKey).clone();
  }

  try {
    const tex = await loader.loadAsync(url);
    if (isSRGB) {
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.flipY = false;
    globalTextureCache.set(cacheKey, tex);
    return tex.clone();
  } catch (e) {
    console.warn("[VisionHome] 纹理加载失败:", url, e);
    return null;
  }
}

/**
 * 预加载风格的所有纹理
 * @param {object} style 风格对象
 * @returns {Promise<void>}
 */
export async function preloadStyleTextures(style) {
  if (!style?.materials) return;

  const loader = new THREE.TextureLoader();
  const promises = [];

  for (const def of Object.values(style.materials)) {
    if (!def?.texture || typeof def.texture !== "object") continue;

    const t = def.texture;
    if (t.albedo) {
      const url = resolveStyleTextureUrl(String(t.albedo).trim());
      promises.push(getCachedTexture(url, loader, true));
    }
    if (t.roughness) {
      const url = resolveStyleTextureUrl(String(t.roughness).trim());
      promises.push(getCachedTexture(url, loader, false));
    }
    if (t.normal) {
      const url = resolveStyleTextureUrl(String(t.normal).trim());
      promises.push(getCachedTexture(url, loader, false));
    }
    if (t.metalnessMap) {
      const url = resolveStyleTextureUrl(String(t.metalnessMap).trim());
      promises.push(getCachedTexture(url, loader, false));
    }
  }

  await Promise.allSettled(promises);
}

/**
 * 清理缓存（在切换项目或需要释放内存时调用）
 */
export function clearGlobalCaches() {
  for (const tex of globalTextureCache.values()) {
    tex.dispose();
  }
  globalTextureCache.clear();

  for (const mat of globalMaterialCache.values()) {
    mat.dispose();
  }
  globalMaterialCache.clear();

  stylePreloadPromises.clear();
}
