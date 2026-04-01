/**
 * 户型门 style：对象 { roughness, metalness, color, texture?, glass? }；缺省或无效时统一为白色漆面（不解析外部风格包）
 * texture: { albedo, roughness, normal } 可缺省，缺省视为空字符串
 */

/** 无 style 或数据无效时的门扇材质（白） */
export function defaultDoorStyleWhite() {
  return {
    roughness: 0.85,
    metalness: 0.02,
    color: "#ffffff",
    texture: { albedo: "", roughness: "", normal: "" },
    isGlass: false,
  };
}

/**
 * @param {unknown} raw
 * @returns {{
 *   roughness: number,
 *   metalness: number,
 *   color: string,
 *   texture: { albedo: string, roughness: string, normal: string },
 *   isGlass: boolean,
 * }}
 */
export function normalizeDoorStyle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultDoorStyleWhite();
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const roughness = Number(o.roughness);
  const metalness = Number(o.metalness);
  if (!Number.isFinite(roughness) || !Number.isFinite(metalness)) {
    return defaultDoorStyleWhite();
  }
  if (typeof o.color !== "string" || !o.color.trim()) {
    return defaultDoorStyleWhite();
  }
  const tex = o.texture && typeof o.texture === "object" && !Array.isArray(o.texture) ? o.texture : {};
  const t = /** @type {Record<string, unknown>} */ (tex);
  return {
    roughness,
    metalness,
    color: o.color.trim(),
    texture: {
      albedo: t.albedo != null ? String(t.albedo) : "",
      roughness: t.roughness != null ? String(t.roughness) : "",
      normal: t.normal != null ? String(t.normal) : "",
    },
    isGlass: o.glass === true || o.transparent === true,
  };
}
