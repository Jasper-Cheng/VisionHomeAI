/**
 * 户型窗 style：对象 { color, texture, type, opacity }；缺省或无效时统一为白色 clear 玻璃（不解析外部风格包）
 * type: clear | frosted | tinted
 * texture: { albedo, roughness, normal } 可空字符串
 */

const WINDOW_TYPES = new Set(["clear", "frosted", "tinted"]);

/** 无 style 或数据无效时的窗玻璃（白 / clear） */
export function defaultWindowStyleWhite() {
  return {
    color: "#ffffff",
    opacity: 0.35,
    type: /** @type {"clear"} */ ("clear"),
    texture: { albedo: "", roughness: "", normal: "" },
  };
}

/**
 * @param {unknown} raw
 * @returns {{
 *   color: string,
 *   opacity: number,
 *   type: 'clear'|'frosted'|'tinted',
 *   texture: { albedo: string, roughness: string, normal: string },
 * }}
 */
export function normalizeWindowStyle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return defaultWindowStyleWhite();
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.color !== "string" || !o.color.trim()) {
    return defaultWindowStyleWhite();
  }
  const op = Number(o.opacity);
  if (!Number.isFinite(op) || op < 0 || op > 1) {
    return defaultWindowStyleWhite();
  }
  const typeStr = String(o.type ?? "").toLowerCase().trim();
  if (!WINDOW_TYPES.has(typeStr)) {
    return defaultWindowStyleWhite();
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
