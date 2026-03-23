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
  const res = await fetch(DATA_PATHS.furnitureLibrary);
  if (!res.ok) throw new Error("loadFurnitureLibrary failed");
  return res.json();
}

export async function loadTemplate(filename) {
  const url = `${DATA_PATHS.templates}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`loadTemplate failed: ${url}`);
  return res.json();
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
