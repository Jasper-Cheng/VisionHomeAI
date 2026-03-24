/**
 * 应用入口：加载户型库 / 家具库 → 渲染侧栏 → 2D SVG 编辑 → 3D 视口
 */
import { loadFurnitureCatalog, mountFurnitureLibrary } from "./furniture/furnitureManager.js";
import { loadFloorPlanCatalog, mountFloorplanLibrary } from "./floorplan/floorPlanManager.js";
import {
  loadDesignProjectsFromManifest,
  mountDesignFileList,
  mountHeaderCurrentDesignLabel,
} from "./files/designFilesManager.js";
import { initSvgEditor } from "./editor2d/svgEditor.js";

async function boot() {
  let fpCatalog = { items: [], byId: new Map() };
  let fpLoadError = false;
  try {
    fpCatalog = await loadFloorPlanCatalog();
  } catch (err) {
    console.error(err);
    fpLoadError = true;
  }
  window.__floorPlanCatalog = fpCatalog;
  mountFloorplanLibrary(fpCatalog, { loadError: fpLoadError });

  let catalog = { items: [], byId: new Map() };
  let loadError = false;
  try {
    catalog = await loadFurnitureCatalog();
  } catch (err) {
    console.error(err);
    loadError = true;
  }

  window.__furnitureCatalog = catalog;
  mountFurnitureLibrary(catalog, { loadError });

  let designEntries = [];
  let designLoadError = false;
  try {
    designEntries = await loadDesignProjectsFromManifest();
    window.__designProjects = designEntries;
  } catch (err) {
    console.error(err);
    designLoadError = true;
    window.__designProjects = [];
  }
  mountDesignFileList(designEntries, { loadError: designLoadError });
  mountHeaderCurrentDesignLabel();

  /* 2D 编辑不依赖 WebGL：先初始化 SVG，避免 viewer 抛错时工具栏（网格等）全部未绑定 */
  try {
    initSvgEditor(catalog);
  } catch (err) {
    console.error(err);
    window.__visionHomeSvgEditor = { ok: false, reason: "threw", error: String(err) };
  }

  try {
    await import("./editor3d/viewer.js");
  } catch (err) {
    console.error(err);
  }
}

boot().catch((err) => {
  console.error(err);
});
