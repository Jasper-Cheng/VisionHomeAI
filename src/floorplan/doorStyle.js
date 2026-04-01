/**
 * 户型门 style：必须为对象 { roughness, metalness, color, texture?, glass? }，无内置默认值；无效则返回 null
 * texture: { albedo, roughness, normal } 可缺省，缺省视为空字符串
 */

/**
 * @param {unknown} raw
 * @returns {{
 *   roughness: number,
 *   metalness: number,
 *   color: string,
 *   texture: { albedo: string, roughness: string, normal: string },
 *   isGlass: boolean,
 * } | null}
 */
export function normalizeDoorStyle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const roughness = Number(o.roughness);
  const metalness = Number(o.metalness);
  if (!Number.isFinite(roughness) || !Number.isFinite(metalness)) {
    return null;
  }
  if (typeof o.color !== "string" || !o.color.trim()) {
    return null;
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
