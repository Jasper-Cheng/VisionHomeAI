import { mergeSceneLighting } from "../utils/lightingUtils.js";

export function createToolbarInit(ctx) {
  const {
    RENDER_QUALITY_CONFIGS,
    addFurniture,
    animate,
    applyRendererPixelRatio,
    applyRendererQualityDetails,
    clearFloorplan,
    clearFloorplanSurfaceSelection,
    deselectVisualOnly,
    emitLayoutChanged,
    flushHistoryDebounce,
    getCurrentFloorId,
    getCurrentFloorLevelIndex,
    getCurrentFloorplanId,
    getEffectiveFloorplanStyleKey,
    getGetSurfaceOverrides,
    getLayout,
    getRenderQualityMode,
    getShadowsEnabled,
    getShowDimensions,
    getShowNames,
    getUndoHistory,
    getViewTransform,
    getWallSnapEnabled,
    getGridVisible,
    getWindowRestoreSession,
    initStylePackSaveDialogs,
    initFloorplanStyleToolbar,
    renderer,
    ambientLight,
    hemiLight,
    dirLight,
    getSceneLightingEnvMapIntensity,
    setSceneLightingEnvMapIntensity,
    renderEditorScene,
    resetCameraView,
    resizeRenderer,
    selectFurniture,
    serializeDesignBaseline,
    serializeDesignForSave,
    setDimensionsVisible,
    setFloorplanSelected,
    setGridVisible,
    setNamesVisible,
    setRenderQualityModeRaw,
    setShadowsEnabled,
    setViewTransform,
    setWallSnapEnabled,
    syncPropertiesPanelForSelection,
    VIEW_H,
    VIEW_W,
  } = ctx;

  function getCurrentLightingConfig() {
    return {
      toneMappingExposure: renderer.toneMappingExposure,
      ambient: { intensity: ambientLight.intensity },
      hemisphere: { intensity: hemiLight.intensity },
      directional: { intensity: dirLight.intensity },
      envMapIntensity: getSceneLightingEnvMapIntensity(),
    };
  }

  function applyLightingFromSliders() {
    const exposure = parseFloat(document.getElementById("layoutLightingExposure")?.value ?? "1.0");
    const ambient = parseFloat(document.getElementById("layoutLightingAmbient")?.value ?? "0.26");
    const hemi = parseFloat(document.getElementById("layoutLightingHemi")?.value ?? "0.36");
    const dir = parseFloat(document.getElementById("layoutLightingDir")?.value ?? "1.0");
    const env = parseFloat(document.getElementById("layoutLightingEnv")?.value ?? "0.35");

    renderer.toneMappingExposure = exposure;
    ambientLight.intensity = ambient;
    hemiLight.intensity = hemi;
    dirLight.intensity = dir;
    setSceneLightingEnvMapIntensity(env);

    document.getElementById("layoutLightingExposureVal").textContent = exposure.toFixed(2);
    document.getElementById("layoutLightingAmbientVal").textContent = ambient.toFixed(2);
    document.getElementById("layoutLightingHemiVal").textContent = hemi.toFixed(2);
    document.getElementById("layoutLightingDirVal").textContent = dir.toFixed(2);
    document.getElementById("layoutLightingEnvVal").textContent = env.toFixed(2);
  }

  function getCurrentRenderQualityLabel() {
    return (RENDER_QUALITY_CONFIGS[getRenderQualityMode()] || RENDER_QUALITY_CONFIGS.standard).label;
  }

  function setRenderQualityMode(mode, opts = {}) {
    const next = mode === "ultra" ? "ultra" : mode === "high" ? "high" : "standard";
    setRenderQualityModeRaw(next);
    applyRendererPixelRatio();
    applyRendererQualityDetails();
    resizeRenderer();
    if (opts.rerender !== false) renderEditorScene();
  }

  function syncRenderQualityToolbarUi() {
    const btn = document.getElementById("layoutRenderQualityBtn");
    const dropdown = document.getElementById("layoutRenderQualityDropdown");
    if (btn) btn.textContent = `渲染·${getCurrentRenderQualityLabel()}`;
    if (!dropdown) return;
    dropdown.querySelectorAll(".layout-render-quality-option").forEach((el) => {
      const mode = String(el.getAttribute("data-render-quality") || "");
      el.classList.toggle("is-active", mode === getRenderQualityMode());
    });
  }

  function applyLightingConfig(cfg) {
    if (!cfg || typeof cfg !== "object") return;
    if (Number.isFinite(cfg.toneMappingExposure)) renderer.toneMappingExposure = cfg.toneMappingExposure;
    if (cfg.ambient && Number.isFinite(cfg.ambient.intensity)) ambientLight.intensity = cfg.ambient.intensity;
    if (cfg.hemisphere && Number.isFinite(cfg.hemisphere.intensity)) hemiLight.intensity = cfg.hemisphere.intensity;
    if (cfg.directional && Number.isFinite(cfg.directional.intensity)) dirLight.intensity = cfg.directional.intensity;
    if (Number.isFinite(cfg.envMapIntensity)) setSceneLightingEnvMapIntensity(cfg.envMapIntensity);
    renderEditorScene();
  }

  function initLightingToolbar() {
    const btn = document.getElementById("layoutLightingBtn");
    const dropdown = document.getElementById("layoutLightingDropdown");
    if (!btn || !dropdown) return;

    function openDropdown() {
      const cfg = getCurrentLightingConfig();
      const expEl = document.getElementById("layoutLightingExposure");
      const ambEl = document.getElementById("layoutLightingAmbient");
      const hemiEl = document.getElementById("layoutLightingHemi");
      const dirEl = document.getElementById("layoutLightingDir");
      const envEl = document.getElementById("layoutLightingEnv");

      if (expEl) expEl.value = cfg.toneMappingExposure;
      if (ambEl) ambEl.value = cfg.ambient.intensity;
      if (hemiEl) hemiEl.value = cfg.hemisphere.intensity;
      if (dirEl) dirEl.value = cfg.directional.intensity;
      if (envEl) envEl.value = cfg.envMapIntensity;

      applyLightingFromSliders();
      dropdown.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      btn.classList.add("is-active");
    }
    function closeDropdown() {
      dropdown.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("is-active");
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.hidden ? openDropdown() : closeDropdown();
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== btn) closeDropdown();
    });

    for (const id of ["layoutLightingExposure", "layoutLightingAmbient", "layoutLightingHemi", "layoutLightingDir", "layoutLightingEnv"]) {
      document.getElementById(id)?.addEventListener("input", () => {
        applyLightingFromSliders();
        renderEditorScene();
      });
    }

    document.getElementById("layoutLightingReset")?.addEventListener("click", () => {
      const fallback = mergeSceneLighting(null);
      document.getElementById("layoutLightingExposure").value = fallback.toneMappingExposure;
      document.getElementById("layoutLightingAmbient").value = fallback.ambient.intensity;
      document.getElementById("layoutLightingHemi").value = fallback.hemisphere.intensity;
      document.getElementById("layoutLightingDir").value = fallback.directional.intensity;
      document.getElementById("layoutLightingEnv").value = fallback.envMapIntensity;
      applyLightingFromSliders();
      renderEditorScene();
    });
  }

  function initRenderQualityToolbar() {
    const btn = document.getElementById("layoutRenderQualityBtn");
    const dropdown = document.getElementById("layoutRenderQualityDropdown");
    if (!btn || !dropdown) return;

    function openDropdown() {
      syncRenderQualityToolbarUi();
      dropdown.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      btn.classList.add("is-active");
    }
    function closeDropdown() {
      dropdown.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("is-active");
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.hidden ? openDropdown() : closeDropdown();
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== btn) closeDropdown();
    });
    dropdown.addEventListener("click", (e) => {
      const option = e.target.closest(".layout-render-quality-option");
      if (!option || !dropdown.contains(option)) return;
      const mode = String(option.getAttribute("data-render-quality") || "");
      if (mode !== "standard" && mode !== "high" && mode !== "ultra") return;
      setRenderQualityMode(mode);
      syncRenderQualityToolbarUi();
      closeDropdown();
    });

    syncRenderQualityToolbarUi();
  }

  function bindWindowApis() {
    window.layoutEditorAddFurniture = addFurniture;
    window.layoutEditorGetLayout = getLayout;
    window.layoutEditorApplyFloorplanAtWorld = ctx.applyFloorplanEntryAtWorld;
    window.layoutEditorClearFloorplan = clearFloorplan;
    window.layoutEditorCommitSavedBaseline = () => {
      window.__designLayoutBaseline = serializeDesignBaseline();
      window.__designSaveBaseline = serializeDesignForSave();
      emitLayoutChanged();
    };
    window.layoutEditorGetDesignBaselineFingerprint = serializeDesignForSave;
    window.layoutEditorGetViewSize = () => ({ width: VIEW_W, height: VIEW_H });
    window.layoutEditorResetView = resetCameraView;
    window.layoutEditorGetViewTransform = getViewTransform;
    window.layoutEditorSetViewTransform = setViewTransform;
    window.layoutEditorToggleGrid = () => setGridVisible(!getGridVisible());
    window.layoutEditorGetGridVisible = getGridVisible;
    window.layoutEditorSetGridVisible = setGridVisible;
    window.layoutEditorToggleDimensions = () => setDimensionsVisible(!getShowDimensions());
    window.layoutEditorSetDimensionsVisible = setDimensionsVisible;
    window.layoutEditorToggleWallSnap = () => setWallSnapEnabled(!getWallSnapEnabled());
    window.layoutEditorSetWallSnapEnabled = setWallSnapEnabled;
    window.layoutEditorGetWallSnapEnabled = getWallSnapEnabled;
    window.layoutEditorToggleShadows = () => setShadowsEnabled(!getShadowsEnabled());
    window.layoutEditorSetShadowsEnabled = setShadowsEnabled;
    window.layoutEditorGetShadowsEnabled = getShadowsEnabled;
    window.layoutEditorGetRenderQualityMode = getRenderQualityMode;
    window.layoutEditorSetRenderQualityMode = (mode) => {
      setRenderQualityMode(mode, { rerender: true });
      syncRenderQualityToolbarUi();
    };
    window.layoutEditorGetLightingConfig = getCurrentLightingConfig;
    window.layoutEditorApplyLightingConfig = applyLightingConfig;

    document.getElementById("layoutDimToggleBtn")?.addEventListener("click", () => setDimensionsVisible(!getShowDimensions()));
    document.getElementById("layoutWallSnapToggleBtn")?.addEventListener("click", () => setWallSnapEnabled(!getWallSnapEnabled()));
    document.getElementById("layoutShadowToggleBtn")?.addEventListener("click", () => setShadowsEnabled(!getShadowsEnabled()));
    document.getElementById("layoutNameToggleBtn")?.addEventListener("click", () => setNamesVisible(!getShowNames()));

    window.layoutEditorGetCurrentFloorplanId = getCurrentFloorplanId;
    window.layoutEditorGetCurrentFloorLevelIndex = getCurrentFloorLevelIndex;
    window.layoutEditorGetCurrentFloorId = getCurrentFloorId;
    window.layoutEditorGetFloorplanStyleKey = getEffectiveFloorplanStyleKey;
    window.layoutEditorRestoreSession = getWindowRestoreSession();
    window.layoutEditorGetUndoHistory = getUndoHistory;
    window.layoutEditorFlushHistoryDebounce = flushHistoryDebounce;
    window.layoutEditorGetSurfaceOverrides = getGetSurfaceOverrides();
    window.layoutEditorDeselect = () => {
      deselectVisualOnly();
      clearFloorplanSurfaceSelection();
      syncPropertiesPanelForSelection(null);
      setFloorplanSelected(false);
    };
    window.layoutEditorApplyPropertiesFromPanel = ctx.applyPropertiesFromPanel;
  }

  function initializeToolbarsAndApis() {
    initFloorplanStyleToolbar();
    initStylePackSaveDialogs();
    initLightingToolbar();
    initRenderQualityToolbar();
    bindWindowApis();
  }

  return {
    applyLightingConfig,
    getCurrentLightingConfig,
    getCurrentRenderQualityLabel,
    initializeToolbarsAndApis,
    setRenderQualityMode,
    syncRenderQualityToolbarUi,
  };
}
