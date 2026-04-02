/**
 * 户型装饰 JSON（assets/style/<floorplanId>.json）：含 styles.{styleKey} 多套风格；单套为根级材质定义。
 * loadStyleConfig(floorplanId, styleKey) 返回其中一套，供 getMaterialDef。
 * floors[].rooms|walls|doors|windows[].style 为材质 id（与该套内根级条目同名）。
 */
import { DATA_PATHS } from "../core/schema.js";

const styleCache = new Map();

function snapCm(v) {
  return Math.round(Number(v) * 1000) / 1000;
}

function safeStyleId(styleId) {
  const s = String(styleId ?? "").trim();
  if (!s || !/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

function safeStyleKey(key) {
  const s = String(key ?? "").trim();
  if (!s || !/^[a-zA-Z0-9_-]+$/.test(s)) return "";
  return s;
}

/**
 * 风格包内贴图路径 → 可 fetch 的 URL（相对站点根）
 * @param {string} relPath
 * @returns {string}
 */
export function resolveStyleTextureUrl(relPath) {
  if (!relPath || !String(relPath).trim()) return "";
  const clean = String(relPath).replace(/^\//, "");
  if (clean.startsWith("assets/")) return `./${clean}`;
  return `./${DATA_PATHS.stylesDir}/${clean}`;
}

/**
 * @param {string} floorplanId 与户型 id 一致，对应 assets/style/<floorplanId>.json
 * @param {string} [styleKey] 装饰文件内 styles 的键，缺省为 modern_minimal_v1
 * @returns {Promise<object>}
 */
export async function loadStyleConfig(floorplanId, styleKey) {
  const fp = safeStyleId(floorplanId);
  if (!fp) throw new Error("Invalid floorplanId for decor");
  const sk = safeStyleKey(styleKey) || "modern_minimal_v1";
  const cacheKey = `${fp}::${sk}`;
  if (styleCache.has(cacheKey)) return styleCache.get(cacheKey);

  const url = `./${DATA_PATHS.stylesDir}/${fp}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Decor fetch failed: ${res.status} ${url}`);
  const data = await res.json();
  const styles = data.styles;
  if (!styles || typeof styles !== "object") throw new Error("Decor JSON missing styles");
  const inner = styles[sk];
  if (!inner || typeof inner !== "object") throw new Error(`Unknown styleKey: ${sk}`);
  styleCache.set(cacheKey, inner);
  return inner;
}

export function clearStyleConfigCache() {
  styleCache.clear();
}

const STYLE_ROOT_RESERVED = new Set(["id", "name", "mapping", "furniturePreset", "materials"]);

/**
 * @param {object | null} style
 * @param {string} key
 * @returns {object | null}
 */
export function getMaterialDef(style, key) {
  if (!style || !key) return null;
  const k = String(key).trim();
  if (!k) return null;
  if (STYLE_ROOT_RESERVED.has(k)) return null;
  const def = style[k];
  return def && typeof def === "object" && !Array.isArray(def) ? def : null;
}

/**
 * @param {object | null} style
 * @param {unknown} raw
 * @returns {string | null}
 */
function materialKeyIfDefined(style, raw) {
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) return null;
  const k = String(raw ?? "").trim();
  if (!k) return null;
  return getMaterialDef(style, k) ? k : null;
}

/**
 * 门/窗洞口中心（户型 cm 平面）
 * @param {object} obj
 * @param {object[]} walls
 * @returns {{ x: number, y: number } | null}
 */
export function openingMidpointCm(obj, walls) {
  if (!obj || typeof obj !== "object") return null;
  const wid = String(obj.wallId ?? "").trim();
  if (!wid || !Array.isArray(walls)) return null;
  const wall = walls.find((w) => String(w?.id ?? "") === wid);
  if (!wall || !Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
    return null;
  }
  const pos = Number(obj.pos);
  const width = Number(obj.width);
  if (!Number.isFinite(pos) || !Number.isFinite(width) || width <= 0) return null;
  const x1 = Number(wall.start[0]);
  const y1 = Number(wall.start[1]);
  const x2 = Number(wall.end[0]);
  const y2 = Number(wall.end[1]);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return null;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const cx = x1 + ux * pos;
  const cy = y1 + uy * pos;
  return { x: cx, y: cy };
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number[][]} polygon
 * @returns {boolean}
 */
export function pointInPolygon2d(x, y, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i][0]);
    const yi = Number(polygon[i][1]);
    const xj = Number(polygon[j][0]);
    const yj = Number(polygon[j][1]);
    const intersect = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * @param {number} px
 * @param {number} py
 * @param {object} floor
 * @returns {object | null}
 */
export function findRoomContainingPointCm(px, py, floor) {
  for (const room of floor?.rooms || []) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const pts = poly.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [snapCm(p[0]), snapCm(p[1])]);
    if (pts.length < 3) continue;
    if (pointInPolygon2d(px, py, pts)) return room;
  }
  return null;
}

/**
 * @param {object | null} style
 * @param {object} wall
 * @returns {string | null}
 */
export function resolveWallMaterialKey(style, wall) {
  return materialKeyIfDefined(style, wall?.style);
}

/**
 * @param {object | null} style
 * @param {object} room
 * @returns {string | null}
 */
export function resolveRoomFloorMaterialKey(style, room) {
  return materialKeyIfDefined(style, room?.style);
}

/**
 * @param {object | null} style
 * @param {object} door
 * @returns {string | null}
 */
export function resolveDoorMaterialKey(style, door) {
  return materialKeyIfDefined(style, door?.style);
}

/**
 * @param {object | null} style
 * @param {object} win
 * @returns {string | null}
 */
export function resolveWindowMaterialKey(style, win) {
  return materialKeyIfDefined(style, win?.style);
}
