export function createProjectIoModule(ctx) {
  const {
    applyAllOverridesToScene,
    applyFloorplanEntryAtWorld,
    applyHistorySnapshotState,
    applyLightingConfig,
    clearFloorplan,
    emitLayoutChanged,
    floorplanRoot,
    initHistory,
    maxHistory = 80,
    migrateFloorplanSurfaceOverridesBucket,
    normalizeHistorySnapshot,
    normalizeStyleKeyForSurfaceOverrides,
    rebuildFromLayout,
    resetCameraView,
    resolveFloorplanCatalogEntry,
    selectFurniture,
    selectFloorplanLibraryCardById,
    serializeDesignBaseline,
    serializeDesignForSave,
    setGridVisible,
    setRenderQualityMode,
    setViewTransform,
    state,
    syncRenderQualityToolbarUi,
    syncUndoRedoButtons,
  } = ctx;

  function normalizeSavedFurnitureLayout(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .map((row) => ({
        model: String(row?.model ?? row?.furnitureId ?? "").trim(),
        floorId: row?.floorId != null && String(row.floorId).trim() ? String(row.floorId).trim() : "floor1",
        x: Math.round(Number(row?.x)),
        y: Math.round(Number(row?.y)),
        rotation: Math.round(Number(row?.rotation ?? row?.rotationDeg ?? 0) || 0),
      }))
      .filter((r) => r.model && Number.isFinite(r.x) && Number.isFinite(r.y));
  }

  function cloneByJson(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }

  function syncNestedOverridesBuckets(styleKey) {
    const sk = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const surfaceBag = state.floorplanSurfaceOverridesByStyleKey[sk];

    const roomFloorsData = surfaceBag?.roomFloors;
    if (roomFloorsData && typeof roomFloorsData === "object") {
      state.roomFloorOverridesByStyleKey[sk] = cloneByJson(roomFloorsData, {});
    } else {
      state.roomFloorOverridesByStyleKey[sk] = {};
    }

    const doorData = surfaceBag?.doorOverrides;
    if (doorData && typeof doorData === "object") {
      state.doorOverridesByStyleKey[sk] = cloneByJson(doorData, {});
    } else {
      state.doorOverridesByStyleKey[sk] = {};
    }

    const windowData = surfaceBag?.windowOverrides;
    if (windowData && typeof windowData === "object") {
      state.windowOverridesByStyleKey[sk] = cloneByJson(windowData, {});
    } else {
      state.windowOverridesByStyleKey[sk] = {};
    }

    const wallFaceData = surfaceBag?.wallFaceOverrides;
    if (wallFaceData && typeof wallFaceData === "object") {
      state.wallFaceOverridesByStyleKey[sk] = cloneByJson(wallFaceData, {});
    } else {
      state.wallFaceOverridesByStyleKey[sk] = {};
    }
  }

  async function applyFromDesignProject(project) {
    if (!project || typeof project !== "object") return;
    const gridWasVisible = state.gridVisible;
    const se = project.layoutEditor;
    const hasLayoutEditor = se && typeof se === "object" && Number(se.version) === 1;
    if (!hasLayoutEditor) return;
    const layout = normalizeSavedFurnitureLayout(se.furniture);

    let fpId = null;
    let floorLevelIndex = 0;
    if (Object.prototype.hasOwnProperty.call(se, "floorPlanId")) {
      const v = se.floorPlanId;
      fpId = v != null && String(v).trim() ? String(v).trim() : null;
      const lv = Math.trunc(Number(se.floorLevelIndex));
      if (Number.isFinite(lv) && lv >= 0) floorLevelIndex = lv;
    }

    state.isRestoring = true;
    try {
      if (Object.prototype.hasOwnProperty.call(se, "floorplanStyleKey")) {
        const sk = se.floorplanStyleKey;
        state.floorplanStyleKeyOverride = sk != null && String(sk).trim() ? String(sk).trim() : null;
      } else {
        state.floorplanStyleKeyOverride = null;
      }

      const rawByStyleKey = se.surfaceOverridesByStyleKey && typeof se.surfaceOverridesByStyleKey === "object"
        ? se.surfaceOverridesByStyleKey
        : null;

      if (rawByStyleKey) {
        const raw = cloneByJson(rawByStyleKey, {});
        const next = {};
        for (const [sk, bucket] of Object.entries(raw)) {
          if (!bucket || typeof bucket !== "object") continue;
          next[normalizeStyleKeyForSurfaceOverrides(sk)] = migrateFloorplanSurfaceOverridesBucket(bucket);
        }
        state.floorplanSurfaceOverridesByStyleKey = next;
      } else {
        state.floorplanSurfaceOverridesByStyleKey = {};
      }

      if (fpId) {
        const entry = resolveFloorplanCatalogEntry(fpId);
        if (entry) {
          await applyFloorplanEntryAtWorld(entry, undefined, undefined, {
            floorIndex: floorLevelIndex,
            preserveStyleKeyOverride: true,
            preserveSurfaceOverrides: true,
            skipDecorFromStyleMerge: true,
          });
        } else {
          clearFloorplan();
        }
      } else {
        clearFloorplan();
      }

      syncNestedOverridesBuckets(state.floorplanStyleKeyOverride);

      if (fpId && floorplanRoot.children.length > 0) {
        await applyAllOverridesToScene();
      }

      await rebuildFromLayout(layout);
      resetCameraView();
      setGridVisible(gridWasVisible);
      if (se.lightingConfig && typeof se.lightingConfig === "object") {
        applyLightingConfig?.(se.lightingConfig);
      }
      if (typeof se.renderQualityMode === "string") {
        setRenderQualityMode(se.renderQualityMode, { rerender: false });
        syncRenderQualityToolbarUi();
      }
    } finally {
      state.isRestoring = false;
    }
    selectFurniture(null);
    initHistory();
    state.historyReady = true;
    window.__designLayoutBaseline = serializeDesignBaseline();
    window.__designSaveBaseline = serializeDesignForSave();
    emitLayoutChanged();
    selectFloorplanLibraryCardById?.(fpId || "");
  }

  async function applyExternalLayout(layout, options = {}) {
    state.isRestoring = true;
    try {
      await rebuildFromLayout(Array.isArray(layout) ? layout : []);
    } finally {
      state.isRestoring = false;
    }
    selectFurniture(null);
    initHistory();
    state.historyReady = true;
    window.__designLayoutBaseline =
      typeof options.designLayoutBaseline === "string" ? options.designLayoutBaseline : serializeDesignBaseline();
    window.__designSaveBaseline = serializeDesignForSave();
    emitLayoutChanged();
  }

  function isValidUndoHistoryPayload(uh) {
    if (!uh || typeof uh !== "object") return false;
    const { entries, index } = uh;
    if (!Array.isArray(entries) || entries.length === 0 || !Number.isFinite(Number(index))) return false;
    const idx = Math.trunc(Number(index));
    if (idx < 0 || idx >= entries.length) return false;
    for (const s of entries) {
      if (typeof s !== "string") return false;
      try {
        if (normalizeHistorySnapshot(JSON.parse(s)) == null) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  async function restoreEditorSession(payload) {
    async function applyFloorplanByPayload() {
      const fpId = payload.floorPlanId != null ? String(payload.floorPlanId).trim() : "";
      const floorLevelIndex = Math.max(0, Math.trunc(Number(payload.floorLevelIndex) || 0));
      if (fpId) {
        const entry = resolveFloorplanCatalogEntry(fpId);
        if (entry) {
          await applyFloorplanEntryAtWorld(entry, undefined, undefined, {
            floorIndex: floorLevelIndex,
            skipDecorFromStyleMerge: true,
          });
          return;
        }
      }
      clearFloorplan();
    }

    if (!payload || Number(payload.version) !== 1) return;
    if (typeof payload.renderQualityMode === "string") {
      setRenderQualityMode(payload.renderQualityMode, { rerender: false });
      syncRenderQualityToolbarUi();
    }

    const v = payload.view;
    if (v && Number.isFinite(Number(v.tx)) && Number.isFinite(Number(v.ty)) && Number.isFinite(Number(v.scale))) {
      setViewTransform(v);
    }
    if (typeof payload.gridVisible === "boolean") setGridVisible(payload.gridVisible);

    clearTimeout(state.historyDebounceTimer);
    state.historyDebounceTimer = null;

    const layout = Array.isArray(payload.furnitureLayout) ? payload.furnitureLayout : [];
    const uh = payload.undoHistory;

    if (isValidUndoHistoryPayload(uh)) {
      let entries = uh.entries.slice();
      let idx = Math.trunc(Number(uh.index));
      if (entries.length > maxHistory) {
        const drop = entries.length - maxHistory;
        entries = entries.slice(drop);
        idx -= drop;
      }
      if (idx < 0 || idx >= entries.length) {
        state.isRestoring = true;
        try {
          await applyFloorplanByPayload();
        } finally {
          state.isRestoring = false;
        }
        await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        if (payload.lightingConfig) applyLightingConfig?.(payload.lightingConfig);
        return;
      }
      state.historyReady = false;
      state.isRestoring = true;
      state.history.splice(0, state.history.length, ...entries);
      state.historyIndex = idx;
      try {
        const snapshotState = normalizeHistorySnapshot(JSON.parse(state.history[state.historyIndex]));
        if (!snapshotState) throw new Error("bad");
        await applyHistorySnapshotState(snapshotState);
      } catch {
        state.historyReady = true;
        state.isRestoring = true;
        try {
          await applyFloorplanByPayload();
        } finally {
          state.isRestoring = false;
        }
        await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        if (payload.lightingConfig) applyLightingConfig?.(payload.lightingConfig);
        return;
      }
      state.isRestoring = false;
      selectFurniture(null);
      state.historyReady = true;
      window.__designLayoutBaseline =
        typeof payload.designLayoutBaseline === "string" ? payload.designLayoutBaseline : serializeDesignBaseline();
      window.__designSaveBaseline = serializeDesignForSave();
      syncUndoRedoButtons();
      if (payload.lightingConfig) applyLightingConfig?.(payload.lightingConfig);
      emitLayoutChanged();
    } else {
      state.isRestoring = true;
      try {
        await applyFloorplanByPayload();
      } finally {
        state.isRestoring = false;
      }
      await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
      if (payload.lightingConfig) applyLightingConfig?.(payload.lightingConfig);
    }
  }

  return {
    applyExternalLayout,
    applyFromDesignProject,
    restoreEditorSession,
  };
}
