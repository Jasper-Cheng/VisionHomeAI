/**
 * 家具 JSON：config.materials（材质光照 + textures + colors）
 * 顶层 skus[]（价格/库存），selection: { skuId }
 */

/**
 * @param {object | null | undefined} item
 * @returns {boolean}
 */
export function hasFurnitureMaterialConfig(item) {
  const m = item?.config?.materials;
  return Array.isArray(m) && m.length > 0;
}

/** @param {object | null | undefined} item */
export function getConfigMaterials(item) {
  const m = item?.config?.materials;
  return Array.isArray(m) ? m : [];
}

/**
 * @param {object} material
 * @param {string} textureId
 * @returns {object | null}
 */
export function findTextureInMaterial(material, textureId) {
  const list = material?.textures;
  if (!Array.isArray(list)) return null;
  const id = String(textureId ?? "").trim();
  return list.find((t) => t && String(t.id ?? "").trim() === id) ?? null;
}

/**
 * @param {object} texture
 * @param {string} colorId
 * @returns {object | null}
 */
export function findColorInTexture(texture, colorId) {
  const list = texture?.colors;
  if (!Array.isArray(list)) return null;
  const id = String(colorId ?? "").trim();
  return list.find((c) => c && String(c.id ?? "").trim() === id) ?? null;
}

/**
 * @param {object | null | undefined} item
 * @param {string} skuId
 * @returns {object | null}
 */
export function findSkuById(item, skuId) {
  const skus = item?.skus;
  if (!Array.isArray(skus) || skuId == null) return null;
  const id = String(skuId).trim();
  return skus.find((s) => s && String(s.id ?? "").trim() === id) ?? null;
}

/**
 * @param {object | null | undefined} item
 * @param {string} materialId
 * @param {string} textureId
 * @param {string} colorId
 * @returns {object | null}
 */
export function findSkuByTriple(item, materialId, textureId, colorId) {
  const skus = item?.skus;
  if (!Array.isArray(skus)) return null;
  const mid = String(materialId ?? "").trim();
  const tid = String(textureId ?? "").trim();
  const cid = String(colorId ?? "").trim();
  return (
    skus.find(
      (s) =>
        s &&
        String(s.materialId ?? "").trim() === mid &&
        String(s.textureId ?? "").trim() === tid &&
        String(s.colorId ?? "").trim() === cid,
    ) ?? null
  );
}

/**
 * @returns {{ skuId: string, materialId: string, textureId: string, colorId: string } | null}
 */
export function getDefaultSelectionFromConfig(item) {
  if (!hasFurnitureMaterialConfig(item)) return null;
  const skus = item.skus;
  if (Array.isArray(skus) && skus.length > 0) {
    const s0 = skus[0];
    return {
      skuId: String(s0.id ?? "").trim(),
      materialId: String(s0.materialId ?? "").trim(),
      textureId: String(s0.textureId ?? "").trim(),
      colorId: String(s0.colorId ?? "").trim(),
    };
  }
  const mats = getConfigMaterials(item);
  const m0 = mats[0];
  if (!m0) return null;
  const mid = String(m0.id ?? "").trim();
  const t0 = m0.textures?.[0];
  const tid = String(t0?.id ?? "").trim();
  const c0 = t0?.colors?.[0];
  const cid = String(c0?.id ?? "").trim();
  return { skuId: "", materialId: mid, textureId: tid, colorId: cid };
}

function tripleFromSku(sku) {
  if (!sku) return null;
  return {
    skuId: String(sku.id ?? "").trim(),
    materialId: String(sku.materialId ?? "").trim(),
    textureId: String(sku.textureId ?? "").trim(),
    colorId: String(sku.colorId ?? "").trim(),
  };
}

/**
 * @param {object | null | undefined} item
 * @param {{ skuId?: string, materialId?: string, textureId?: string, colorId?: string } | null | undefined} override
 * @returns {{ skuId: string, materialId: string, textureId: string, colorId: string } | null}
 */
export function normalizeFurnitureSelection(item, override) {
  if (!hasFurnitureMaterialConfig(item)) return null;
  const mats = getConfigMaterials(item);
  const o = override && typeof override === "object" ? override : {};
  const catalogSel = item.selection && typeof item.selection === "object" ? item.selection : {};

  if (o.skuId != null && String(o.skuId).trim()) {
    const sku = findSkuById(item, o.skuId);
    if (sku) return tripleFromSku(sku);
  }

  let materialId = String(o.materialId ?? "").trim();
  let textureId = o.textureId != null ? String(o.textureId).trim() : "";
  let colorId = o.colorId != null ? String(o.colorId).trim() : "";

  const overrideHasAny =
    (o.skuId != null && String(o.skuId).trim()) ||
    (o.materialId != null && String(o.materialId).trim()) ||
    o.textureId != null ||
    o.colorId != null;

  if (!overrideHasAny) {
    if (catalogSel.skuId) {
      const sku = findSkuById(item, catalogSel.skuId);
      if (sku) return tripleFromSku(sku);
    }
    materialId = String(catalogSel.materialId ?? "").trim();
    textureId = catalogSel.textureId != null ? String(catalogSel.textureId).trim() : "";
    colorId = catalogSel.colorId != null ? String(catalogSel.colorId).trim() : "";
  }

  if (!materialId && !textureId && !colorId) {
    return getDefaultSelectionFromConfig(item);
  }

  let mat = mats.find((m) => m && String(m.id ?? "").trim() === materialId);
  if (!mat) {
    return getDefaultSelectionFromConfig(item);
  }
  materialId = String(mat.id ?? "").trim();

  if (!textureId || o.textureId === "") {
    const t0 = mat.textures?.[0];
    textureId = String(t0?.id ?? "").trim();
  }
  let tex = findTextureInMaterial(mat, textureId);
  if (!tex && mat.textures?.[0]) {
    tex = mat.textures[0];
    textureId = String(tex.id ?? "").trim();
  }

  if (!colorId || o.colorId === "") {
    colorId = String(tex?.colors?.[0]?.id ?? "").trim();
  }

  const sku = findSkuByTriple(item, materialId, textureId, colorId);
  if (sku) return tripleFromSku(sku);

  return {
    skuId: "",
    materialId,
    textureId: textureId || "",
    colorId: colorId || "",
  };
}

/**
 * @param {object | null | undefined} item
 * @param {{ skuId: string, materialId: string, textureId: string, colorId: string }} sel
 */
export function resolveFurnitureSelectionDetail(item, sel) {
  const empty = {
    material: null,
    texture: null,
    color: null,
    materialName: "",
    textureName: "",
    colorName: "",
    hex: "#888888",
    skuId: "",
    skuName: "",
    /** 相对家具条目 `price` 的加价（元），可负；无 SKU 或未定义时为 null */
    skuMarkup: null,
    materialParams: null,
  };
  if (!item || !sel) return empty;
  const mats = getConfigMaterials(item);
  const mat = mats.find((m) => m && String(m.id ?? "").trim() === sel.materialId) ?? null;
  if (!mat) return empty;
  const tex = findTextureInMaterial(mat, sel.textureId);
  const col = tex ? findColorInTexture(tex, sel.colorId) : null;
  const hexRaw = col?.hex != null ? String(col.hex).trim() : "#888888";
  const hex = /^#?[0-9a-fA-F]{3,8}$/.test(hexRaw) ? (hexRaw.startsWith("#") ? hexRaw : `#${hexRaw}`) : "#888888";

  const sku = sel.skuId ? findSkuById(item, sel.skuId) : findSkuByTriple(item, sel.materialId, sel.textureId, sel.colorId);

  const matLayer = mat.material && typeof mat.material === "object" ? mat.material : {};
  const materialParams = {
    roughness: Number.isFinite(matLayer.roughness) ? matLayer.roughness : undefined,
    metalness: Number.isFinite(matLayer.metalness) ? matLayer.metalness : undefined,
  };

  return {
    material: mat,
    texture: tex,
    color: col,
    materialName: String(mat.name ?? mat.id ?? "").trim() || sel.materialId,
    textureName: tex ? String(tex.name ?? tex.id ?? "").trim() || sel.textureId : "",
    colorName: col ? String(col.name ?? col.id ?? "").trim() || sel.colorId : "",
    hex,
    skuId: sku ? String(sku.id ?? "").trim() : String(sel.skuId ?? "").trim(),
    skuName: sku != null ? String(sku.name ?? "").trim() : "",
    skuMarkup: (() => {
      if (sku == null) return null;
      if (!Object.prototype.hasOwnProperty.call(sku, "markup")) return 0;
      const n = Number(sku.markup);
      return Number.isFinite(n) ? n : 0;
    })(),
    materialParams,
  };
}

/**
 * 加价展示文案（非 0 时用于面板右侧）；正数 +¥n，负数 −¥|n|
 * @param {number} markup
 * @returns {string}
 */
export function formatSkuMarkupLabel(markup) {
  if (!Number.isFinite(markup) || markup === 0) return "";
  if (markup > 0) return `+¥${Math.round(markup)}`;
  return `−¥${Math.round(Math.abs(markup))}`;
}

export function resolveTextureAssetUrl(pathFromRoot) {
  if (!pathFromRoot) return "";
  const clean = String(pathFromRoot).replace(/^\//, "");
  if (clean.startsWith("assets/")) return `./${clean}`;
  return `./assets/textures/${clean}`;
}

/**
 * 多色共用同一张 albedo 时，漫反射为 map×color；普通 hex 乘在偏棕纹理上色相很弱。
 * 提高饱和度并略抬强度，使换色时差异更明显（有 map 时使用）。
 * @param {typeof import("three")} THREE
 * @param {string} hex
 * @returns {import("three").Color}
 */
function tintColorForSharedAlbedoMap(THREE, hex) {
  const c = new THREE.Color();
  try {
    const h = String(hex ?? "").trim();
    c.setStyle(/^#/.test(h) ? h : `#${h}`);
  } catch {
    c.set(0x888888);
  }
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);

  if (hsl.l > 0.72) {
    c.setHSL(hsl.h, Math.min(0.28, hsl.s + 0.1), 0.93);
  } else {
    hsl.s = Math.min(1, hsl.s * 1.62 + 0.12);
    hsl.l = THREE.MathUtils.clamp(hsl.l * 1.06, 0.2, 0.56);
    c.setHSL(hsl.h, hsl.s, hsl.l);
  }

  c.multiplyScalar(1.32);
  return c;
}

/**
 * GLB 载入后：用条目中的 albedo + roughness（及可选 normal）路径替换为 MeshStandardMaterial。
 * diffuse：sRGB；roughness：线性数据；normal：NoColorSpace（切线空间法线，如 OpenGL / gl 朝向）。
 * 多 mesh 常共享同一材质实例：必须先全部换完新材质，再按材质引用去重后 dispose，否则会提前销毁共享贴图。
 * @param {object | null | undefined} selectionOverride 与 `group.userData.furnitureSelection` 一致；不传则回落到条目 `selection`（勿用于已选实例）
 * @returns {Promise<boolean>} 是否成功应用外部 PBR
 */
export async function applyFurnitureGltfPbrMaps(THREE, root, item, selectionOverride = null) {
  if (!root || !item || !hasFurnitureMaterialConfig(item)) return false;
  const sel = normalizeFurnitureSelection(item, selectionOverride);
  if (!sel) return false;
  const det = resolveFurnitureSelectionDetail(item, sel);
  const texLayer = det.texture?.texture;
  const colorAlbedoPath = det.color?.assets?.albedo;
  const textureAlbedoPath =
    texLayer && typeof texLayer === "object" && texLayer.albedo != null
      ? String(texLayer.albedo).trim()
      : "";
  const albedoPath = colorAlbedoPath || textureAlbedoPath;
  const roughnessPath =
    texLayer && typeof texLayer === "object" && texLayer.roughness != null
      ? String(texLayer.roughness).trim()
      : "";
  const normalPath =
    texLayer && typeof texLayer === "object" && texLayer.normal != null
      ? String(texLayer.normal).trim()
      : "";
  if (!albedoPath && !roughnessPath && !normalPath) return false;

  const loader = new THREE.TextureLoader();
  const au = albedoPath ? resolveTextureAssetUrl(albedoPath) : "";
  const ru = roughnessPath ? resolveTextureAssetUrl(roughnessPath) : "";
  let diffTex = null;
  let roughTex = null;
  let normalTex = null;

  if (au) {
    try {
      diffTex = await loader.loadAsync(au);
    } catch (e) {
      console.warn("[VisionHome] albedo 贴图加载失败:", au, e);
    }
  }
  if (ru) {
    try {
      roughTex = await loader.loadAsync(ru);
    } catch (e) {
      console.warn("[VisionHome] roughness 贴图加载失败:", ru, e);
    }
  }

  if (diffTex) {
    diffTex.colorSpace = THREE.SRGBColorSpace;
    diffTex.flipY = false;
  }
  if (roughTex) {
    roughTex.colorSpace = THREE.LinearSRGBColorSpace;
    roughTex.flipY = false;
  }

  if (normalPath) {
    try {
      normalTex = await loader.loadAsync(resolveTextureAssetUrl(normalPath));
      normalTex.colorSpace = THREE.NoColorSpace;
      normalTex.flipY = false;
    } catch (e) {
      console.warn("[VisionHome] normal 贴图加载失败:", e);
    }
  }

  if (!diffTex && !roughTex && !normalTex) return false;

  const normalScale = new THREE.Vector2(1, 1);
  const roughness = Number.isFinite(det.materialParams?.roughness) ? det.materialParams.roughness : 1.0;
  const metalness = Number.isFinite(det.materialParams?.metalness) ? det.materialParams.metalness : 0.0;
  let color;
  if (diffTex) {
    color = tintColorForSharedAlbedoMap(THREE, det.hex);
  } else {
    try {
      color = new THREE.Color(det.hex);
    } catch {
      color = new THREE.Color(0x888888);
    }
  }
  /** @type {Set<import("three").Material>} */
  const oldMaterials = new Set();
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    list.forEach((m) => {
      if (m) oldMaterials.add(m);
    });
  });

  root.traverse((o) => {
    if (!o.isMesh) return;
    const old = o.material;
    const list = Array.isArray(old) ? old : [old];
    const next = list.map(() =>
      new THREE.MeshStandardMaterial({
        color,
        ...(diffTex ? { map: diffTex } : {}),
        ...(roughTex ? { roughnessMap: roughTex } : {}),
        roughness,
        metalness,
        ...(normalTex
          ? {
              normalMap: normalTex,
              normalScale,
            }
          : {}),
      })
    );
    o.material = next.length === 1 ? next[0] : next;
  });

  oldMaterials.forEach((m) => {
    disposeSingleMaterialMaps(m);
    m.dispose?.();
  });

  return true;
}

function disposeSingleMaterialMaps(material) {
  if (!material || typeof material !== "object") return;
  for (const key of Object.keys(material)) {
    const v = material[key];
    if (v && typeof v === "object" && v.isTexture) v.dispose?.();
  }
}

/**
 * @param {typeof import("three")} THREE
 * @param {import("three").Object3D} group
 * @param {object} item
 */
export function applyFurnitureAppearanceToGroup(THREE, group, item) {
  if (!group || !item || !hasFurnitureMaterialConfig(item)) return;
  const sel = group.userData.furnitureSelection ?? normalizeFurnitureSelection(item, null);
  if (!sel) return;
  const det = resolveFurnitureSelectionDetail(item, sel);
  let c;
  try {
    c = new THREE.Color(det.hex);
  } catch {
    c = new THREE.Color(0x888888);
  }
  group.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      /* MeshStandard：漫反射为 map × color。多色共用同一张 albedo 时需用目录 hex 乘色才能区分色款 */
      if (m.color) {
        const apply = m.map ? tintColorForSharedAlbedoMap(THREE, det.hex) : c;
        m.color.copy(apply);
        m.needsUpdate = true;
      }
      const mp = det.materialParams;
      if (mp && typeof mp === "object") {
        if (Number.isFinite(mp.roughness)) m.roughness = mp.roughness;
        if (Number.isFinite(mp.metalness)) m.metalness = mp.metalness;
      }
    });
  });
}
