/**
 * 户型风格 JSON（assets/style/<styleId>.json）加载与 mapping → 材质 key 解析。
 * floors[].rooms[].style / walls[].style / doors[].style / windows[].style 与 mapping 中对应键一致；
 * rooms[].type、walls[].type 等为语义类型，不参与材质查表。
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
 * @param {string} styleId
 * @returns {Promise<object>}
 */
export async function loadStyleConfig(styleId) {
  const id = safeStyleId(styleId);
  if (!id) throw new Error("Invalid styleId");
  if (styleCache.has(id)) return styleCache.get(id);

  const url = `./${DATA_PATHS.stylesDir}/${id}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Style fetch failed: ${res.status} ${url}`);
  const data = await res.json();
  styleCache.set(id, data);
  return data;
}

export function clearStyleConfigCache() {
  styleCache.clear();
}

/**
 * @param {object | null} style
 * @param {string} key
 * @returns {object | null}
 */
export function getMaterialDef(style, key) {
  if (!style || !key) return null;
  const k = String(key).trim();
  const m = style.materials;
  if (!m || typeof m !== "object") return null;
  const def = m[k];
  return def && typeof def === "object" ? def : null;
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
  const wm = style?.mapping?.walls;
  if (!wm || typeof wm !== "object") return null;
  const k = String(wall?.style ?? "").trim();
  if (!k) return null;
  const key = wm[k];
  return key != null && String(key).trim() ? String(key).trim() : null;
}

/**
 * @param {object | null} style
 * @param {object} room
 * @returns {string | null}
 */
export function resolveRoomFloorMaterialKey(style, room) {
  const key = String(room?.style ?? "").trim();
  const row = style?.mapping?.rooms?.[key];
  return row?.floor ?? null;
}

/**
 * @param {object | null} style
 * @param {object} door
 * @returns {string | null}
 */
export function resolveDoorMaterialKey(style, door) {
  const dm = style?.mapping?.doors;
  if (!dm || typeof dm !== "object") return null;
  const raw = door?.style;
  if (raw != null && typeof raw !== "object" && !Array.isArray(raw)) {
    const k = String(raw).trim();
    if (k && dm[k] != null && String(dm[k]).trim()) return String(dm[k]).trim();
  }
  return dm.default != null && String(dm.default).trim() ? String(dm.default).trim() : null;
}

/**
 * @param {object | null} style
 * @param {object} win
 * @returns {string | null}
 */
export function resolveWindowMaterialKey(style, win) {
  const wm = style?.mapping?.windows;
  if (!wm || typeof wm !== "object") return null;
  const raw = win?.style;
  if (raw != null && typeof raw !== "object" && !Array.isArray(raw)) {
    const k = String(raw).trim();
    if (k && wm[k] != null && String(wm[k]).trim()) return String(wm[k]).trim();
  }
  return wm.default != null && String(wm.default).trim() ? String(wm.default).trim() : null;
}
