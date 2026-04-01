/**
 * 户型窗 style：对象 { color, texture, type, opacity }，无默认值；无效则返回 null
 * type: clear | frosted | tinted
 * texture: { albedo, roughness, normal } 可空字符串
 */

const WINDOW_TYPES = new Set(["clear", "frosted", "tinted"]);

/**
 * @param {unknown} raw
 * @returns {{
 *   color: string,
 *   opacity: number,
 *   type: 'clear'|'frosted'|'tinted',
 *   texture: { albedo: string, roughness: string, normal: string },
 * } | null}
 */
export function normalizeWindowStyle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.color !== "string" || !o.color.trim()) {
    return null;
  }
  const op = Number(o.opacity);
  if (!Number.isFinite(op) || op < 0 || op > 1) {
    return null;
  }
  const typeStr = String(o.type ?? "").toLowerCase().trim();
  if (!WINDOW_TYPES.has(typeStr)) {
    return null;
  }
  const tex = o.texture && typeof o.texture === "object" && !Array.isArray(o.texture) ? o.texture : {};
  const t = /** @type {Record<string, unknown>} */ (tex);
  return {
    color: o.color.trim(),
    opacity: op,
    type: /** @type {"clear" | "frosted" | "tinted"} */ (typeStr),
    texture: {
      albedo: t.albedo != null ? String(t.albedo) : "",
      roughness: t.roughness != null ? String(t.roughness) : "",
      normal: t.normal != null ? String(t.normal) : "",
    },
  };
}
