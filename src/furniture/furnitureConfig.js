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
      if (m.color) m.color.copy(c);
      const mp = det.materialParams;
      if (mp && typeof mp === "object") {
        if (Number.isFinite(mp.roughness)) m.roughness = mp.roughness;
        if (Number.isFinite(mp.metalness)) m.metalness = mp.metalness;
      }
    });
  });
}
