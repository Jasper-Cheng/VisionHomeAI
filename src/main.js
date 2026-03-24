/**
 * 应用入口：加载户型库 / 家具库 → 渲染侧栏 → 2D SVG 编辑 → 3D 视口
 */
import { loadFurnitureCatalog, mountFurnitureLibrary } from "./furniture/furnitureManager.js";
import { loadFloorPlanCatalog, mountFloorplanLibrary } from "./floorplan/floorPlanManager.js";
import { initSvgEditor } from "./editor2d/svgEditor.js";

async function boot() {
  let fpCatalog = { items: [], byId: new Map() };
  let fpLoadError = false;
  try {
    fpCatalog = await loadFloorPlanCatalog();
  } catch (err) {
    console.error("[VisionHomeAI] 户型库加载失败:", err);
    fpLoadError = true;
  }
  window.__floorPlanCatalog = fpCatalog;
  mountFloorplanLibrary(fpCatalog, { loadError: fpLoadError });

  let catalog = { items: [], byId: new Map() };
  let loadError = false;
  try {
    catalog = await loadFurnitureCatalog();
  } catch (err) {
    console.error("[VisionHomeAI] 家具库加载失败:", err);
    loadError = true;
  }

  window.__furnitureCatalog = catalog;
  mountFurnitureLibrary(catalog, { loadError });

  await import("./editor3d/viewer.js");
  initSvgEditor(catalog);
}

boot();
