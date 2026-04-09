/**
 * 户型装饰 JSON（assets/floorplans/style/<floorplanId>.json）：根级 defaultStyleKey 为默认风格键；缺省时用 styles 中第一个风格。loadStyleConfig 未传 styleKey 时用该默认。
 * 可选根级 mapping：与户型元素 id 对应；各风格未写 mapping 时沿用根级，避免重复。
 * 各风格可选 sceneLighting：曝光、环境光/半球光/主光强度与色温、户型 PBR envMapIntensity（见 apt 风格 JSON）。
 * loadStyleConfig(floorplanId, styleKey) 返回合并后的单套风格，供 getMaterialDef。
 * styles.{styleKey}.decorations：写在具体风格内；loadStyleConfig 合并后挂在返回对象 decorations（无根级 decorations）。
 *   placements：装饰实例列表，每项含 model（装饰库 id）、floorId、平面坐标 x/y（cm，编辑区中心原点）、rotation（度）；可选 decorationLiftCm、furnitureSelection。
 * floors[].walls|doors|windows：优先用风格包 mapping.walls|doors|windows 中以元素 id 为键的条目；若无则回退到 style 短键或直连材质 id。
 * floors[].rooms：优先 mapping.rooms[room.id]（{ floor, wall }）；否则 rooms[].style → mapping.rooms 短键。
 */
import { DATA_PATHS } from "../core/schema.js";

const styleCache = new Map();
/** @type {Map<string, object>} */
const stylePackJsonCache = new Map();
/** 与风格包 JSON 同步：该户型默认风格键（供无户型 styleKey 时回退） */
const styleDefaultKeyByFloorplanId = new Map();
let materialsLibraryCache = null;

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

/** 共享材质表（当前项目不请求网络文件，恒为空对象；风格包用内联 materials；与 editEditor 中合并 style.materials 配合使用）
 * @returns {Promise<Record<string, object>>} */
export async function loadMaterialsLibrary() {
  if (materialsLibraryCache) return materialsLibraryCache;
  materialsLibraryCache = {};
  return materialsLibraryCache;
}

function clonePlain(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * 将风格包中的 decorations 转为与编辑器 rebuildFromLayout 兼容的行（仅装饰条目；可与家具 layout 拼接）。
 * @param {object | null | undefined} style loadStyleConfig 返回的单套风格
 * @returns {object[]}
 */
export function decorationPlacementsToLayoutRows(style) {
  const d = style?.decorations;
  if (!isPlainObject(d)) return [];
  const placements = Array.isArray(d.placements) ? d.placements : [];
  const rows = [];
  for (const p of placements) {
    if (!isPlainObject(p)) continue;
    const model = String(p.model ?? "").trim();
    if (!model) continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    /** @type {Record<string, unknown>} */
    const row = { model, x, y };
    let rot = Math.round(Number(p.rotation) || 0) % 360;
    if (rot < 0) rot += 360;
    row.rotation = rot;
    const fid = p.floorId != null ? String(p.floorId).trim() : "";
    if (fid) row.floorId = fid;
    const lift = p.decorationLiftCm != null ? Number(p.decorationLiftCm) : NaN;
    if (Number.isFinite(lift)) row.decorationLiftCm = Math.round(lift);
    if (p.furnitureSelection != null && isPlainObject(p.furnitureSelection)) {
      row.furnitureSelection = clonePlain(p.furnitureSelection);
    }
    rows.push(row);
  }
  return rows;
}

function parseMaterialRefId(raw) {
  if (typeof raw === "string") {
    const s = raw.trim();
    return s || "";
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const s = String(raw.$ref ?? "").trim();
    return s || "";
  }
  return "";
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 从风格包根对象解析默认风格键：优先 defaultStyleKey 且须在 styles 内；否则取 styles 中第一条目。
 * @param {object} data
 * @returns {string}
 */
export function resolveDefaultStyleKeyFromPack(data) {
  if (!data || typeof data !== "object") return "";
  const styles = data.styles;
  if (!styles || typeof styles !== "object") return "";
  const explicit = safeStyleKey(data.defaultStyleKey);
  if (explicit && isPlainObject(styles[explicit])) return explicit;
  for (const key of Object.keys(styles)) {
    if (isPlainObject(styles[key])) return safeStyleKey(key) || key;
  }
  return "";
}

/**
 * 拉取并缓存户型装饰包 JSON（按 floorplanId 仅请求一次，直至 clearStyleConfigCache）。
 * @param {string} floorplanId
 * @returns {Promise<object>}
 */
async function fetchStylePackJson(floorplanId) {
  const fp = safeStyleId(floorplanId);
  if (!fp) throw new Error("Invalid floorplanId for decor");
  if (stylePackJsonCache.has(fp)) return stylePackJsonCache.get(fp);
  const url = `./${DATA_PATHS.stylesDir}/${fp}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Decor fetch failed: ${res.status} ${url}`);
  const data = await res.json();
  stylePackJsonCache.set(fp, data);
  const def = resolveDefaultStyleKeyFromPack(data) || "modern_minimal_v1";
  styleDefaultKeyByFloorplanId.set(fp, def);
  return data;
}

/**
 * 已加载过的户型装饰包默认风格键（需先 loadStyleConfig / loadStylePackIndex / fetchStylePackJson 成功）
 * @param {string} floorplanId
 * @returns {string}
 */
export function getDefaultStyleKeyForFloorplan(floorplanId) {
  const fp = safeStyleId(floorplanId);
  if (!fp) return "";
  return styleDefaultKeyByFloorplanId.get(fp) ?? "";
}

/**
 * 从材质表（可选 materials.library.json 的 materials）解析某 id（支持 $ref 链）
 * @param {Record<string, object>} library
 * @param {string} id
 * @returns {object | null}
 */
export function resolveMaterialDefFromLibrary(library, id) {
  const bag = library && typeof library === "object" ? library : {};
  const seen = new Set();
  let cur = String(id ?? "").trim();
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const entry = bag[cur];
    if (!isPlainObject(entry)) return null;
    const nestedRefId = parseMaterialRefId(entry);
    if (nestedRefId) {
      cur = nestedRefId;
      continue;
    }
    return clonePlain(entry);
  }
  return null;
}

/**
 * 沿材质表的 $ref 链解析到**顶层表中的叶子 id**（供属性面板与库键对齐）
 * @param {Record<string, object>} library
 * @param {string} startId
 * @returns {string}
 */
function resolveLibraryMaterialLeafKey(library, startId) {
  const bag = library && typeof library === "object" ? library : {};
  const seen = new Set();
  let cur = String(startId ?? "").trim();
  while (cur) {
    if (seen.has(cur)) return "";
    seen.add(cur);
    const entry = bag[cur];
    if (!isPlainObject(entry)) return "";
    const next = parseMaterialRefId(entry);
    if (!next) return cur;
    cur = next;
  }
  return "";
}

function resolveStyleMaterialRefs(style, library, floorplanId, styleKey) {
  if (!style || typeof style !== "object") return style;
  const materials = style.materials;
  if (!isPlainObject(materials)) return style;
  const resolved = {};
  const inProgress = new Set();
  const refs = [];

  const resolveById = (id) => {
    const entry = library[id];
    if (!isPlainObject(entry)) return null;
    const nestedRefId = parseMaterialRefId(entry);
    if (nestedRefId) {
      if (inProgress.has(id)) {
        throw new Error(`Circular material ref: ${id}`);
      }
      inProgress.add(id);
      const nested = resolveById(nestedRefId);
      inProgress.delete(id);
      return nested ? clonePlain(nested) : null;
    }
    return clonePlain(entry);
  };

  for (const [materialKey, materialDef] of Object.entries(materials)) {
    const refId = parseMaterialRefId(materialDef);
    if (!refId) {
      resolved[materialKey] = materialDef;
      continue;
    }
    const ref = resolveById(refId);
    if (!ref) refs.push(refId);
    resolved[materialKey] = ref;
    if (ref && typeof ref === "object" && !Array.isArray(ref)) {
      const leafKey = resolveLibraryMaterialLeafKey(library, refId);
      if (leafKey) ref.__libraryMaterialId = leafKey;
    }
  }

  if (refs.length) {
    throw new Error(
      `Missing material refs in ${floorplanId}/${styleKey}: ${Array.from(new Set(refs)).join(", ")}`
    );
  }
  return { ...style, materials: resolved };
}

/**
 * @param {string} floorplanId 与户型 id 一致，对应 assets/floorplans/style/<floorplanId>.json
 * @param {string} [styleKey] 装饰文件内 styles 的键，缺省为该文件 defaultStyleKey（或第一套风格）
 * @returns {Promise<object>}
 */
export async function loadStyleConfig(floorplanId, styleKey) {
  const fp = safeStyleId(floorplanId);
  if (!fp) throw new Error("Invalid floorplanId for decor");
  const data = await fetchStylePackJson(fp);
  const styles = data.styles;
  if (!styles || typeof styles !== "object") throw new Error("Decor JSON missing styles");
  const defaultSk = resolveDefaultStyleKeyFromPack(data) || "modern_minimal_v1";
  const sk = safeStyleKey(styleKey) || defaultSk;
  const cacheKey = `${fp}::${sk}::libMatId1`;
  if (styleCache.has(cacheKey)) return styleCache.get(cacheKey);

  const inner = styles[sk];
  if (!inner || typeof inner !== "object") throw new Error(`Unknown styleKey: ${sk}`);
  const materialsLibrary = await loadMaterialsLibrary();
  const merged = resolveStyleMaterialRefs({ ...inner }, materialsLibrary, fp, sk);
  if (merged.mapping === undefined && data.mapping != null && typeof data.mapping === "object") {
    merged.mapping = data.mapping;
  }
  styleCache.set(cacheKey, merged);
  return merged;
}

export function clearStyleConfigCache() {
  styleCache.clear();
  stylePackJsonCache.clear();
  styleDefaultKeyByFloorplanId.clear();
  materialsLibraryCache = null;
}

/**
 * 列出某户型装饰包中的全部风格（工具栏下拉）
 * @param {string} floorplanId
 * @returns {Promise<{ floorplanId: string, styles: { key: string, id: string, name: string }[], defaultStyleKey: string }>}
 */
export async function loadStylePackIndex(floorplanId) {
  const fp = safeStyleId(floorplanId);
  if (!fp) return { floorplanId: "", styles: [], defaultStyleKey: "" };

  let data;
  try {
    data = await fetchStylePackJson(fp);
  } catch {
    return { floorplanId: fp, styles: [], defaultStyleKey: "" };
  }
  const stylesObj = data.styles;
  if (!stylesObj || typeof stylesObj !== "object") {
    return { floorplanId: fp, styles: [], defaultStyleKey: "" };
  }

  const styles = [];
  for (const key of Object.keys(stylesObj)) {
    const s = stylesObj[key];
    if (!s || typeof s !== "object" || Array.isArray(s)) continue;
    const id = String(s.id ?? key).trim() || key;
    const name = String(s.name ?? key).trim() || key;
    styles.push({ key, id, name });
  }
  const defaultStyleKey = resolveDefaultStyleKeyFromPack(data) || "modern_minimal_v1";
  return { floorplanId: fp, styles, defaultStyleKey };
}

const STYLE_ROOT_RESERVED = new Set([
  "id",
  "name",
  "mapping",
  "decorations",
  "furniturePreset",
  "materials",
  "sceneLighting",
]);

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
  const bag = style.materials;
  const fromBag =
    bag && typeof bag === "object" && !Array.isArray(bag) ? bag[k] : undefined;
  const def = fromBag !== undefined ? fromBag : style[k];
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
 * 沿墙参数 t∈[0,1]（从 start→end）在法线 ± 偏移处取点，判定 +Z/−Z 两侧房间。
 * @param {object} floor 单层
 * @param {object} wall 墙条目
 * @param {number} t 0～1
 * @param {number} [epsCm]
 * @returns {{ roomPosZ: object | null, roomNegZ: object | null }}
 */
export function findWallSideRoomsAt(floor, wall, t, epsCm = 4) {
  if (!wall || !floor) return { roomPosZ: null, roomNegZ: null };
  if (!Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
    return { roomPosZ: null, roomNegZ: null };
  }
  const x1 = Number(wall.start[0]);
  const y1 = Number(wall.start[1]);
  const x2 = Number(wall.end[0]);
  const y2 = Number(wall.end[1]);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return { roomPosZ: null, roomNegZ: null };
  const u = Math.max(0, Math.min(1, Number(t)));
  const mx = x1 + u * (x2 - x1);
  const my = y1 + u * (y2 - y1);
  const ux = (y2 - y1) / len;
  const uy = (x2 - x1) / len;
  const eps = Number(epsCm);
  const e = Number.isFinite(eps) && eps > 0 ? eps : 4;
  const roomPosZ = findRoomContainingPointCm(mx + ux * e, my + uy * e, floor);
  const roomNegZ = findRoomContainingPointCm(mx - ux * e, my - uy * e, floor);
  return { roomPosZ, roomNegZ };
}

/**
 * 墙中点（t=0.5）两侧房间，等价于 {@link findWallSideRoomsAt}(floor, wall, 0.5, epsCm)。
 * @param {object} floor 单层
 * @param {object} wall 墙条目
 * @param {number} [epsCm]
 * @returns {{ roomPosZ: object | null, roomNegZ: object | null }}
 */
export function findWallSideRooms(floor, wall, epsCm = 4) {
  return findWallSideRoomsAt(floor, wall, 0.5, epsCm);
}

/**
 * 风格包 `mapping.walls|doors|windows`：户型元素的 `style` 短键 → 根级材质 id（无 id 映射时）。
 * @param {object | null | undefined} style loadStyleConfig 返回的单套风格对象
 * @param {"walls"|"doors"|"windows"} category
 * @param {unknown} raw 元素上的 style 字段
 * @returns {string | null}
 */
export function resolveStyleSurfaceStyleId(style, category, raw) {
  if (raw == null) return null;
  const k = String(raw).trim();
  if (!k) return null;
  const mapRoot = style?.mapping;
  const table = mapRoot && typeof mapRoot === "object" && !Array.isArray(mapRoot) ? mapRoot[category] : null;
  if (table && typeof table === "object" && !Array.isArray(table) && Object.prototype.hasOwnProperty.call(table, k)) {
    const v = table[k];
    if (v == null) return null;
    const id = String(v).trim();
    return id || null;
  }
  return k;
}

/**
 * 优先 mapping.{category}[element.id]（材质 id 字符串），否则 {@link resolveStyleSurfaceStyleId}。
 * @param {object | null | undefined} style
 * @param {"walls"|"doors"|"windows"} category
 * @param {object | null | undefined} element
 * @param {unknown} legacyRaw 元素 style 字段（旧短键）
 * @returns {string | null}
 */
function resolveMappingSurfaceMaterialKey(style, category, element, legacyRaw) {
  const mapRoot = style?.mapping;
  const table = mapRoot && typeof mapRoot === "object" && !Array.isArray(mapRoot) ? mapRoot[category] : null;
  if (table && typeof table === "object" && !Array.isArray(table)) {
    const eid = element && String(element.id ?? "").trim();
    if (eid && Object.prototype.hasOwnProperty.call(table, eid)) {
      const v = table[eid];
      if (v == null) return null;
      const id = String(v).trim();
      return id || null;
    }
  }
  return resolveStyleSurfaceStyleId(style, category, legacyRaw);
}

/**
 * @param {object | null} style
 * @param {object} room
 * @returns {{ floor?: unknown, wall?: unknown } | null}
 */
function resolveRoomStyleSurface(style, room) {
  if (!room) return null;
  const map = style?.mapping?.rooms;
  const rid = String(room.id ?? "").trim();
  if (rid && map && typeof map === "object" && !Array.isArray(map) && Object.prototype.hasOwnProperty.call(map, rid)) {
    const entry = map[rid];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry;
  }
  const raw = room?.style;
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const k = raw.trim();
    if (!k) return null;
    const entry = map && typeof map === "object" && !Array.isArray(map) ? map[k] : null;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return entry;
    }
  }
  return null;
}

/**
 * @param {object | null} style
 * @param {object} wall
 * @returns {string | null}
 */
export function resolveWallMaterialKey(style, wall) {
  const id = resolveMappingSurfaceMaterialKey(style, "walls", wall, wall?.style);
  return materialKeyIfDefined(style, id);
}

/**
 * @param {object | null} style
 * @param {object} room
 * @returns {string | null}
 */
export function resolveRoomFloorMaterialKey(style, room) {
  const surf = resolveRoomStyleSurface(style, room);
  if (surf) return materialKeyIfDefined(style, surf.floor);
  return materialKeyIfDefined(style, room?.style);
}

/**
 * 房间关联的墙面材质 id（与户型墙条目的 style 独立，供数据/后续渲染使用）。
 * @param {object | null} style
 * @param {object} room
 * @returns {string | null}
 */
export function resolveRoomWallMaterialKey(style, room) {
  const surf = resolveRoomStyleSurface(style, room);
  if (surf) return materialKeyIfDefined(style, surf.wall);
  return null;
}

/**
 * @param {object | null} style
 * @param {object} door
 * @returns {string | null}
 */
export function resolveDoorMaterialKey(style, door) {
  const id = resolveMappingSurfaceMaterialKey(style, "doors", door, door?.style);
  return materialKeyIfDefined(style, id);
}

/**
 * @param {object | null} style
 * @param {object} win
 * @returns {string | null}
 */
export function resolveWindowMaterialKey(style, win) {
  const id = resolveMappingSurfaceMaterialKey(style, "windows", win, win?.style);
  return materialKeyIfDefined(style, id);
}
