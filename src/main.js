/**
 * 应用入口：加载户型库 / 家具库 → 渲染侧栏 → 3D 编辑（Three.js）→ 全景 3D 视口
 */
import { loadFurnitureCatalog, mountFurnitureLibrary } from "./furniture/furnitureManager.js";
import { loadFloorPlanCatalog, mountFloorplanLibrary } from "./floorplan/floorPlanManager.js";
import {
  loadDesignProjectsFromManifest,
  mountDesignFileList,
  mountHeaderCurrentDesignLabel,
  mountSaveDesignFlow,
  mountSwitchDesignUnsavedFlow,
} from "./files/designFilesManager.js";
import { initThreeEditor } from "./editor3d/editEditor.js";

/** 与 user.html 等来回导航时保留当前标签页内的编辑态（关闭标签后清除） */
const EDIT_SESSION_STORAGE_KEY = "visionhome:editSession:v1";

function captureEditSessionForStorage() {
  const getLayout = window.svgEditorGetLayout;
  if (typeof getLayout !== "function") return null;
  try {
    const layout = getLayout();
    const getFp = window.svgEditorGetCurrentFloorplanId;
    const getFloorLevel = window.svgEditorGetCurrentFloorLevelIndex;
    const getView = window.svgEditorGetViewTransform;
    const getGrid = window.svgEditorGetGridVisible;
    const getLighting = window.svgEditorGetLightingConfig;
    const getUndo = window.svgEditorGetUndoHistory;
    const undoHistory =
      typeof getUndo === "function"
        ? (() => {
            const u = getUndo();
            if (!u || !Array.isArray(u.entries) || u.entries.length === 0) return undefined;
            const idx = Math.trunc(Number(u.index));
            if (!Number.isFinite(idx) || idx < 0 || idx >= u.entries.length) return undefined;
            return { entries: u.entries.slice(), index: idx };
          })()
        : undefined;
    return {
      version: 1,
      furnitureLayout: layout,
      undoHistory,
      floorPlanId: typeof getFp === "function" ? getFp() : null,
      floorLevelIndex: typeof getFloorLevel === "function" ? getFloorLevel() : null,
      view: typeof getView === "function" ? getView() : { tx: 0, ty: 0, scale: 1 },
      gridVisible: typeof getGrid === "function" ? getGrid() : true,
      lightingConfig: typeof getLighting === "function" ? getLighting() : null,
      designLayoutBaseline: window.__designLayoutBaseline,
      design: {
        file: window.__activeDesignFile ?? null,
        id: window.__activeDesignId ?? null,
        project:
          window.__activeDesignProject && typeof window.__activeDesignProject === "object"
            ? JSON.parse(JSON.stringify(window.__activeDesignProject))
            : null,
      },
    };
  } catch (err) {
    console.warn("[VisionHomeAI] capture edit session failed", err);
    return null;
  }
}

function persistEditSession() {
  if (typeof window.svgEditorFlushHistoryDebounce === "function") {
    window.svgEditorFlushHistoryDebounce();
  }
  const data = captureEditSessionForStorage();
  if (!data) return;
  try {
    sessionStorage.setItem(EDIT_SESSION_STORAGE_KEY, JSON.stringify(data));
  } catch (err) {
    console.warn("[VisionHomeAI] persist edit session failed", err);
  }
}

function tryRestoreEditSession() {
  let raw;
  try {
    raw = sessionStorage.getItem(EDIT_SESSION_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  if (!data || Number(data.version) !== 1 || typeof window.svgEditorRestoreSession !== "function") return;

  const des = data.design;
  if (des && typeof des === "object") {
    window.__activeDesignFile = des.file ?? null;
    window.__activeDesignId = des.id ?? null;
    window.__activeDesignProject = des.project ?? null;
  }

  void window.svgEditorRestoreSession(data).catch((err) => console.warn("[VisionHome] restore session:", err));

  window.dispatchEvent(new CustomEvent("visionhome:design-metadata-updated"));

  const fpId = data.floorPlanId != null ? String(data.floorPlanId).trim() : "";
  if (typeof window.__selectFloorplanLibraryCardById === "function") {
    window.__selectFloorplanLibraryCardById(fpId);
  }
}

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

  try {
    initThreeEditor(catalog);
  } catch (err) {
    console.error(err);
    window.__visionHomeSvgEditor = { ok: false, reason: "threw", error: String(err) };
  }
  /* 须在恢复会话之前挂载：恢复时会 emit layout-changed，保存按钮才能同步 */
  mountSaveDesignFlow();
  mountSwitchDesignUnsavedFlow();
  tryRestoreEditSession();

  window.addEventListener("pagehide", () => persistEditSession());

  try {
    await import("./editor3d/viewer.js");
  } catch (err) {
    console.error(err);
  }
}

boot().catch((err) => {
  console.error(err);
});
