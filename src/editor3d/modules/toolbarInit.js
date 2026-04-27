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
    const exposure = parseFloat(document.getElementById("svgLightingExposure")?.value ?? "1.0");
    const ambient = parseFloat(document.getElementById("svgLightingAmbient")?.value ?? "0.26");
    const hemi = parseFloat(document.getElementById("svgLightingHemi")?.value ?? "0.36");
    const dir = parseFloat(document.getElementById("svgLightingDir")?.value ?? "1.0");
    const env = parseFloat(document.getElementById("svgLightingEnv")?.value ?? "0.35");

    renderer.toneMappingExposure = exposure;
    ambientLight.intensity = ambient;
    hemiLight.intensity = hemi;
    dirLight.intensity = dir;
    setSceneLightingEnvMapIntensity(env);

    document.getElementById("svgLightingExposureVal").textContent = exposure.toFixed(2);
    document.getElementById("svgLightingAmbientVal").textContent = ambient.toFixed(2);
    document.getElementById("svgLightingHemiVal").textContent = hemi.toFixed(2);
    document.getElementById("svgLightingDirVal").textContent = dir.toFixed(2);
    document.getElementById("svgLightingEnvVal").textContent = env.toFixed(2);
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
    const btn = document.getElementById("svgRenderQualityBtn");
    const dropdown = document.getElementById("svgRenderQualityDropdown");
    if (btn) btn.textContent = `渲染·${getCurrentRenderQualityLabel()}`;
    if (!dropdown) return;
    dropdown.querySelectorAll(".svg-render-quality-option").forEach((el) => {
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
    const btn = document.getElementById("svgLightingBtn");
    const dropdown = document.getElementById("svgLightingDropdown");
    if (!btn || !dropdown) return;

    function openDropdown() {
      const cfg = getCurrentLightingConfig();
      const expEl = document.getElementById("svgLightingExposure");
      const ambEl = document.getElementById("svgLightingAmbient");
      const hemiEl = document.getElementById("svgLightingHemi");
      const dirEl = document.getElementById("svgLightingDir");
      const envEl = document.getElementById("svgLightingEnv");

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

    for (const id of ["svgLightingExposure", "svgLightingAmbient", "svgLightingHemi", "svgLightingDir", "svgLightingEnv"]) {
      document.getElementById(id)?.addEventListener("input", () => {
        applyLightingFromSliders();
        renderEditorScene();
      });
    }

    document.getElementById("svgLightingReset")?.addEventListener("click", () => {
      const fallback = mergeSceneLighting(null);
      document.getElementById("svgLightingExposure").value = fallback.toneMappingExposure;
      document.getElementById("svgLightingAmbient").value = fallback.ambient.intensity;
      document.getElementById("svgLightingHemi").value = fallback.hemisphere.intensity;
      document.getElementById("svgLightingDir").value = fallback.directional.intensity;
      document.getElementById("svgLightingEnv").value = fallback.envMapIntensity;
      applyLightingFromSliders();
      renderEditorScene();
    });
  }

  function initRenderQualityToolbar() {
    const btn = document.getElementById("svgRenderQualityBtn");
    const dropdown = document.getElementById("svgRenderQualityDropdown");
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
      const option = e.target.closest(".svg-render-quality-option");
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
    window.svgEditorAddFurniture = addFurniture;
    window.svgEditorGetLayout = getLayout;
    window.svgEditorApplyFloorplanAtWorld = ctx.applyFloorplanEntryAtWorld;
    window.svgEditorClearFloorplan = clearFloorplan;
    window.svgEditorCommitSavedBaseline = () => {
      window.__designLayoutBaseline = serializeDesignBaseline();
      window.__designSaveBaseline = serializeDesignForSave();
      emitLayoutChanged();
    };
    window.svgEditorGetDesignBaselineFingerprint = serializeDesignForSave;
    window.svgEditorGetViewSize = () => ({ width: VIEW_W, height: VIEW_H });
    window.svgEditorResetView = resetCameraView;
    window.svgEditorGetViewTransform = getViewTransform;
    window.svgEditorSetViewTransform = setViewTransform;
    window.svgEditorToggleGrid = () => setGridVisible(!getGridVisible());
    window.svgEditorGetGridVisible = getGridVisible;
    window.svgEditorSetGridVisible = setGridVisible;
    window.svgEditorToggleDimensions = () => setDimensionsVisible(!getShowDimensions());
    window.svgEditorSetDimensionsVisible = setDimensionsVisible;
    window.svgEditorToggleWallSnap = () => setWallSnapEnabled(!getWallSnapEnabled());
    window.svgEditorSetWallSnapEnabled = setWallSnapEnabled;
    window.svgEditorGetWallSnapEnabled = getWallSnapEnabled;
    window.svgEditorToggleShadows = () => setShadowsEnabled(!getShadowsEnabled());
    window.svgEditorSetShadowsEnabled = setShadowsEnabled;
    window.svgEditorGetShadowsEnabled = getShadowsEnabled;
    window.svgEditorGetRenderQualityMode = getRenderQualityMode;
    window.svgEditorSetRenderQualityMode = (mode) => {
      setRenderQualityMode(mode, { rerender: true });
      syncRenderQualityToolbarUi();
    };
    window.svgEditorGetLightingConfig = getCurrentLightingConfig;
    window.svgEditorApplyLightingConfig = applyLightingConfig;

    document.getElementById("svgDimToggleBtn")?.addEventListener("click", () => setDimensionsVisible(!getShowDimensions()));
    document.getElementById("svgWallSnapToggleBtn")?.addEventListener("click", () => setWallSnapEnabled(!getWallSnapEnabled()));
    document.getElementById("svgShadowToggleBtn")?.addEventListener("click", () => setShadowsEnabled(!getShadowsEnabled()));
    document.getElementById("svgNameToggleBtn")?.addEventListener("click", () => setNamesVisible(!getShowNames()));

    window.svgEditorGetCurrentFloorplanId = getCurrentFloorplanId;
    window.svgEditorGetCurrentFloorLevelIndex = getCurrentFloorLevelIndex;
    window.svgEditorGetCurrentFloorId = getCurrentFloorId;
    window.svgEditorGetFloorplanStyleKey = getEffectiveFloorplanStyleKey;
    window.svgEditorRestoreSession = getWindowRestoreSession();
    window.svgEditorGetUndoHistory = getUndoHistory;
    window.svgEditorFlushHistoryDebounce = flushHistoryDebounce;
    window.svgEditorGetSurfaceOverrides = getGetSurfaceOverrides();
    window.svgEditorDeselect = () => {
      deselectVisualOnly();
      clearFloorplanSurfaceSelection();
      syncPropertiesPanelForSelection(null);
      setFloorplanSelected(false);
    };
    window.svgEditorApplyPropertiesFromPanel = ctx.applyPropertiesFromPanel;
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
