import { DATA_PATHS, SCHEMA_VERSION } from "./schema.js";

/**
 * 用户工程 JSON 读写（静态站点下用 fetch + 下载；后续可接 IndexedDB）
 */
export async function loadProject(projectId) {
  const url = `${DATA_PATHS.projects}/${projectId}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadProject failed: ${url}`);
  return res.json();
}

export async function loadFurnitureLibrary() {
  const res = await fetch(DATA_PATHS.furnitureLibrary, { cache: "no-store" });
  if (!res.ok) throw new Error("loadFurnitureLibrary failed");
  return res.json();
}

/** 加载户型模板库（`data/templates/floorPlanLibrary.json`） */
export async function loadFloorPlanLibrary() {
  const res = await fetch(DATA_PATHS.floorPlanLibrary, { cache: "no-store" });
  if (!res.ok) throw new Error(`loadFloorPlanLibrary failed: ${DATA_PATHS.floorPlanLibrary}`);
  return res.json();
}

/**
 * 按 id 取模板条目（含 id、project、floors、connections）
 * @param {object} data loadFloorPlanLibrary() 的返回值
 * @param {string} templateId 如 apartment_2b1l
 */
export function getFloorPlanTemplateEntry(data, templateId) {
  const list = data?.floorPlanLibrary;
  if (!Array.isArray(list) || !templateId) return null;
  return list.find((item) => item.id === templateId) ?? null;
}

/**
 * 去掉条目上的 `id`，得到与原单文件相同的 `{ project, floors, connections }`
 * @param {object} entry getFloorPlanTemplateEntry 的返回值
 */
export function floorPlanTemplatePayload(entry) {
  if (!entry || typeof entry !== "object") return null;
  const { id: _omit, ...payload } = entry;
  return payload;
}

/** 触发浏览器下载 project JSON（本地保存占位） */
export function downloadProjectJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export { SCHEMA_VERSION };
