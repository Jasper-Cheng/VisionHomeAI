import * as THREE from "three";

import { resolveStyleTextureUrl } from "../../floorplan/floorplanStyle.js";
import { getCachedTexture } from "../utils/cacheUtils.js";

export function createMaterialFactory(ctx) {
  const { applyFloorplanSurfaceAlpha, getSceneLightingEnvMapIntensity } = ctx;

  /**
   * 记录楼层透明度系数与当前 effective opacity 的比例（opacity / 层透明度），
   * 供滑块只改材质时使用：newOpacity = perUnit * newLayerOpacity。
   * 避免层透明度或 effective opacity 曾为 0 时，用 ratio=mat.opacity*new/old 无法恢复。
   */
  function tagFloorplanLayerOpacity(mat, layerOpacity) {
    if (!mat) return;
    const layer = Number.isFinite(Number(layerOpacity)) ? Number(layerOpacity) : 1;
    mat.userData.__floorplanLayerOpacity = layer;
    if (layer > 1e-9) {
      mat.userData.__floorplanOpacityPerUnitLayer = mat.opacity / layer;
    } else {
      mat.userData.__floorplanOpacityPerUnitLayer = 1;
    }
  }

  /**
   * 从风格包 materials 条目创建 Three 材质（可先显示颜色，贴图异步叠加）
   * @param {object} def
   * @param {number} floorOpacity
   * @param {{ forGlass?: boolean, envMapIntensity?: number, side?: import("three").Side }} [options]
   */
  function createFloorplanMaterialFromStyleDef(def, floorOpacity, options = {}) {
    const envMapIntensity = options.envMapIntensity ?? getSceneLightingEnvMapIntensity();
    const floorOp = floorOpacity ?? 1;
    const color = new THREE.Color();
    try {
      const h = String(def.color ?? "#cccccc").trim();
      color.setStyle(h.startsWith("#") ? h : `#${h}`);
    } catch {
      color.setHex(0xcccccc);
    }
    const roughness = Number(def.roughness);
    const metalness = Number(def.metalness);
    const tr = Number(def.transmission);
    const usePhysical =
      options.forGlass !== true &&
      String(def.type ?? "") === "glass" &&
      Number.isFinite(tr) &&
      tr > 0.02;

    if (usePhysical) {
      const baseOp = Number(def.opacity);
      const opMult = Number.isFinite(baseOp) ? baseOp : 1;
      const mat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: Number.isFinite(roughness) ? roughness : 0.05,
        metalness: Number.isFinite(metalness) ? metalness : 0,
        transmission: Math.min(1, tr),
        thickness: 0.03,
        ior: Number.isFinite(Number(def.ior)) ? Number(def.ior) : 1.45,
        transparent: true,
        opacity: Math.min(1, opMult * floorOp),
        envMapIntensity: 0.9,
        emissive: new THREE.Color(0x000000),
      });
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
      mat.side = options.side ?? THREE.DoubleSide;
      tagFloorplanLayerOpacity(mat, floorOp);
      return mat;
    }

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: Number.isFinite(roughness) ? roughness : 0.55,
      metalness: Number.isFinite(metalness) ? metalness : 0.05,
      envMapIntensity,
      emissive: new THREE.Color(0x000000),
    });
    const baseOp = Number(def.opacity);
    const opMult = Number.isFinite(baseOp) ? baseOp : 1;
    const isGlass = String(def.type ?? "") === "glass";
    if (isGlass) {
      mat.transparent = true;
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
    } else {
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
    }
    mat.side = options.side ?? THREE.FrontSide;
    tagFloorplanLayerOpacity(mat, floorOp);
    return mat;
  }

  /**
   * 风格包 PBR 贴图异步加载（路径相对 assets/floorplans/style/）
   * @param {import("three").MeshStandardMaterial | import("three").MeshPhysicalMaterial} mat
   * @param {object} def
   * @param {{ applyUvScale?: boolean }} [opts]
   */
  function queueStylePackTextures(mat, def, opts = {}) {
    const t = def.texture;
    if (!t || typeof t !== "object") return;
    const albedo = String(t.albedo ?? "").trim();
    const rough = String(t.roughness ?? "").trim();
    const normal = String(t.normal ?? "").trim();
    const metalnessMapPath = String(t.metalnessMap ?? "").trim();
    if (!albedo && !rough && !normal && !metalnessMapPath) return;

    const loader = new THREE.TextureLoader();
    const applyUv = Boolean(opts.applyUvScale && Array.isArray(def.uvScale) && def.uvScale.length >= 2);
    const rotDeg = Number(def.textureRotation);
    const rotRad = Number.isFinite(rotDeg) && rotDeg !== 0 ? (rotDeg * Math.PI) / 180 : 0;

    function applyStyleTextureMapOpts(tex) {
      if (!tex) return;
      if (applyUv) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(def.uvScale[0], def.uvScale[1]);
      }
      if (rotRad !== 0) {
        tex.center.set(0.5, 0.5);
        tex.rotation = rotRad;
      }
    }

    (async () => {
      if (!mat?.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;
      let metalnessTex = null;

      if (albedo) {
        const au = resolveStyleTextureUrl(albedo);
        diffTex = await getCachedTexture(au, loader, true);
      }
      if (rough) {
        const ru = resolveStyleTextureUrl(rough);
        roughTex = await getCachedTexture(ru, loader, false);
        if (roughTex) roughTex.colorSpace = THREE.LinearSRGBColorSpace;
      }
      if (normal) {
        const nu = resolveStyleTextureUrl(normal);
        normalTex = await getCachedTexture(nu, loader, false);
        if (normalTex) normalTex.colorSpace = THREE.NoColorSpace;
      }
      if (metalnessMapPath) {
        const mu = resolveStyleTextureUrl(metalnessMapPath);
        metalnessTex = await getCachedTexture(mu, loader, false);
        if (metalnessTex) {
          metalnessTex.colorSpace = THREE.LinearSRGBColorSpace;
        }
      }

      if (!diffTex && !roughTex && !normalTex && !metalnessTex) return;

      if (diffTex) {
        applyStyleTextureMapOpts(diffTex);
        mat.map = diffTex;
        try {
          const h = String(def.color ?? "#ffffff").trim();
          mat.color.setStyle(h.startsWith("#") ? h : `#${h}`);
        } catch {
          mat.color.setHex(0xffffff);
        }
      }
      if (roughTex) {
        applyStyleTextureMapOpts(roughTex);
        mat.roughnessMap = roughTex;
      }
      if (normalTex) {
        applyStyleTextureMapOpts(normalTex);
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      if (metalnessTex) {
        applyStyleTextureMapOpts(metalnessTex);
        mat.metalnessMap = metalnessTex;
      }
      mat.needsUpdate = true;
    })();
  }

  return {
    createFloorplanMaterialFromStyleDef,
    queueStylePackTextures,
    tagFloorplanLayerOpacity,
  };
}
