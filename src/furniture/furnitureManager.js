import { loadFurnitureLibrary } from "../core/projectManager.js";

let cache = null;

export async function getFurnitureLibrary() {
  if (!cache) cache = await loadFurnitureLibrary();
  return cache;
}

export function resolveModelUrl(modelPathFromRoot) {
  if (!modelPathFromRoot) return "";
  const clean = modelPathFromRoot.replace(/^\//, "");
  return `/${clean}`;
}
