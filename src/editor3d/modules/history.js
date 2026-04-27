export function createHistoryModule(ctx) {
  const {
    applyFloorplanEntryAtWorld,
    applySurfaceOverridesToFloorplan,
    clearFloorplan,
    effectiveFloorplanStyleKeyFromEntryAndOverride,
    emitLayoutChanged,
    floorplanRoot,
    getCurrentFloorLevelIndex,
    getCurrentFloorplanId,
    getCurrentSurfaceOverridesBucket,
    getEffectiveFloorplanStyleKey,
    getLayout,
    getRedoButton,
    getUndoButton,
    maxHistory = 80,
    migrateFloorplanSurfaceOverridesBucket,
    normalizeStyleKeyForSurfaceOverrides,
    rebuildFloorplan3D,
    rebuildFromLayout,
    resolveFloorplanCatalogEntry,
    selectFurniture,
    state,
    updateBottomUI,
  } = ctx;

  function syncUndoRedoButtons() {
    const undoBtn = getUndoButton?.() ?? null;
    const redoBtn = getRedoButton?.() ?? null;
    if (undoBtn) undoBtn.disabled = state.historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = state.historyIndex >= state.history.length - 1;
  }

  function cloneSurfaceOverridesPayload(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {
      return undefined;
    }
  }

  function serializeEditorSnapshot() {
    return JSON.stringify({
      v: 1,
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
      floorplanStyleKey: getEffectiveFloorplanStyleKey(),
      surfaceOverrides: JSON.parse(JSON.stringify(getCurrentSurfaceOverridesBucket())),
      surfaceOverridesByStyleKey: JSON.parse(JSON.stringify(state.floorplanSurfaceOverridesByStyleKey)),
      roomFloorOverridesByStyleKey: JSON.parse(JSON.stringify(state.roomFloorOverridesByStyleKey)),
      doorOverridesByStyleKey: JSON.parse(JSON.stringify(state.doorOverridesByStyleKey)),
      windowOverridesByStyleKey: JSON.parse(JSON.stringify(state.windowOverridesByStyleKey)),
      wallFaceOverridesByStyleKey: JSON.parse(JSON.stringify(state.wallFaceOverridesByStyleKey)),
    });
  }

  function normalizeHistorySnapshot(parsed) {
    if (Array.isArray(parsed)) {
      return { furniture: parsed, floorPlanId: undefined, floorLevelIndex: undefined, surfaceOverrides: undefined };
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.furniture)) {
      const id = parsed.floorPlanId;
      let floorLevelIndex = undefined;
      if (parsed.floorLevelIndex === null) floorLevelIndex = null;
      else if (parsed.floorLevelIndex !== undefined) {
        const n = Math.trunc(Number(parsed.floorLevelIndex));
        floorLevelIndex = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      let floorplanStyleKey = undefined;
      if (Object.prototype.hasOwnProperty.call(parsed, "floorplanStyleKey")) {
        const sk = parsed.floorplanStyleKey;
        floorplanStyleKey = sk != null && String(sk).trim() ? String(sk).trim() : null;
      }
      const surfaceOverrides = Object.prototype.hasOwnProperty.call(parsed, "surfaceOverrides")
        ? cloneSurfaceOverridesPayload(parsed.surfaceOverrides)
        : undefined;
      const surfaceOverridesByStyleKey = Object.prototype.hasOwnProperty.call(parsed, "surfaceOverridesByStyleKey")
        ? cloneSurfaceOverridesPayload(parsed.surfaceOverridesByStyleKey)
        : undefined;
      const roomFloorOverridesByStyleKey = Object.prototype.hasOwnProperty.call(parsed, "roomFloorOverridesByStyleKey")
        ? cloneSurfaceOverridesPayload(parsed.roomFloorOverridesByStyleKey)
        : undefined;
      const doorOverridesByStyleKey = Object.prototype.hasOwnProperty.call(parsed, "doorOverridesByStyleKey")
        ? cloneSurfaceOverridesPayload(parsed.doorOverridesByStyleKey)
        : undefined;
      const windowOverridesByStyleKey = Object.prototype.hasOwnProperty.call(parsed, "windowOverridesByStyleKey")
        ? cloneSurfaceOverridesPayload(parsed.windowOverridesByStyleKey)
        : undefined;
      const wallFaceOverridesByStyleKey = Object.prototype.hasOwnProperty.call(parsed, "wallFaceOverridesByStyleKey")
        ? cloneSurfaceOverridesPayload(parsed.wallFaceOverridesByStyleKey)
        : undefined;
      if (id === undefined) {
        return {
          furniture: parsed.furniture,
          floorPlanId: undefined,
          floorLevelIndex,
          floorplanStyleKey,
          surfaceOverrides,
          surfaceOverridesByStyleKey,
          roomFloorOverridesByStyleKey,
          doorOverridesByStyleKey,
          windowOverridesByStyleKey,
          wallFaceOverridesByStyleKey,
        };
      }
      if (id === null || String(id).trim() === "") {
        return {
          furniture: parsed.furniture,
          floorPlanId: null,
          floorLevelIndex,
          floorplanStyleKey,
          surfaceOverrides,
          surfaceOverridesByStyleKey,
          roomFloorOverridesByStyleKey,
          doorOverridesByStyleKey,
          windowOverridesByStyleKey,
          wallFaceOverridesByStyleKey,
        };
      }
      return {
        furniture: parsed.furniture,
        floorPlanId: String(id).trim(),
        floorLevelIndex,
        floorplanStyleKey,
        surfaceOverrides,
        surfaceOverridesByStyleKey,
        roomFloorOverridesByStyleKey,
        doorOverridesByStyleKey,
        windowOverridesByStyleKey,
        wallFaceOverridesByStyleKey,
      };
    }
    return null;
  }

  function floorLevelIndexEqualsForHistory(stateIdx, currentIdx) {
    if (stateIdx === undefined && currentIdx === undefined) return true;
    if (stateIdx === null && currentIdx === null) return true;
    if (stateIdx === undefined || currentIdx === undefined) return false;
    if (stateIdx === null || currentIdx === null) return stateIdx === currentIdx;
    return Math.trunc(Number(stateIdx)) === Math.trunc(Number(currentIdx));
  }

  function layoutRowKeyForHistory(row) {
    if (!row || typeof row !== "object") return "";
    return JSON.stringify({
      m: row.model,
      x: row.x,
      y: row.y,
      r: row.rotation ?? 0,
      f: row.floorId ?? null,
      l: row.decorationLiftCm,
    });
  }

  function layoutsEqualForHistory(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    const sa = a.map(layoutRowKeyForHistory).sort();
    const sb = b.map(layoutRowKeyForHistory).sort();
    for (let i = 0; i < sa.length; i++) {
      if (sa[i] !== sb[i]) return false;
    }
    return true;
  }

  async function applyHistorySnapshotState(snapshotState) {
    if (!snapshotState) return;
    let restoredSurfaceByStyleKey = {};
    if (Object.prototype.hasOwnProperty.call(snapshotState, "surfaceOverridesByStyleKey")) {
      const raw = snapshotState.surfaceOverridesByStyleKey && typeof snapshotState.surfaceOverridesByStyleKey === "object"
        ? JSON.parse(JSON.stringify(snapshotState.surfaceOverridesByStyleKey))
        : {};
      const next = {};
      for (const [sk, bucket] of Object.entries(raw)) {
        if (!bucket || typeof bucket !== "object") continue;
        next[normalizeStyleKeyForSurfaceOverrides(sk)] = migrateFloorplanSurfaceOverridesBucket(bucket);
      }
      restoredSurfaceByStyleKey = next;
    } else if (Object.prototype.hasOwnProperty.call(snapshotState, "surfaceOverrides")) {
      const legacy = migrateFloorplanSurfaceOverridesBucket(
        snapshotState.surfaceOverrides && typeof snapshotState.surfaceOverrides === "object"
          ? JSON.parse(JSON.stringify(snapshotState.surfaceOverrides))
          : {},
      );
      const sk = normalizeStyleKeyForSurfaceOverrides(snapshotState.floorplanStyleKey);
      restoredSurfaceByStyleKey = { [sk]: legacy };
    }
    state.floorplanSurfaceOverridesByStyleKey = restoredSurfaceByStyleKey;

    const readStyleBucketMap = (payload) => {
      const out = {};
      if (!payload || typeof payload !== "object") return out;
      for (const [sk, bucket] of Object.entries(payload)) {
        if (!bucket || typeof bucket !== "object") continue;
        out[normalizeStyleKeyForSurfaceOverrides(sk)] = JSON.parse(JSON.stringify(bucket));
      }
      return out;
    };
    const extractNestedByStyle = (surfaceByStyle, nestedKey) => {
      const out = {};
      for (const [sk, bucket] of Object.entries(surfaceByStyle || {})) {
        if (!bucket || typeof bucket !== "object") continue;
        const nested = bucket[nestedKey];
        out[normalizeStyleKeyForSurfaceOverrides(sk)] = nested && typeof nested === "object"
          ? JSON.parse(JSON.stringify(nested))
          : {};
      }
      return out;
    };
    state.roomFloorOverridesByStyleKey = Object.prototype.hasOwnProperty.call(snapshotState, "roomFloorOverridesByStyleKey")
      ? readStyleBucketMap(snapshotState.roomFloorOverridesByStyleKey)
      : extractNestedByStyle(restoredSurfaceByStyleKey, "roomFloors");
    state.doorOverridesByStyleKey = Object.prototype.hasOwnProperty.call(snapshotState, "doorOverridesByStyleKey")
      ? readStyleBucketMap(snapshotState.doorOverridesByStyleKey)
      : extractNestedByStyle(restoredSurfaceByStyleKey, "doorOverrides");
    state.windowOverridesByStyleKey = Object.prototype.hasOwnProperty.call(snapshotState, "windowOverridesByStyleKey")
      ? readStyleBucketMap(snapshotState.windowOverridesByStyleKey)
      : extractNestedByStyle(restoredSurfaceByStyleKey, "windowOverrides");
    state.wallFaceOverridesByStyleKey = Object.prototype.hasOwnProperty.call(snapshotState, "wallFaceOverridesByStyleKey")
      ? readStyleBucketMap(snapshotState.wallFaceOverridesByStyleKey)
      : extractNestedByStyle(restoredSurfaceByStyleKey, "wallFaceOverrides");

    let floorplanSurfacesRefreshed = false;
    const targetFurn = Array.isArray(snapshotState.furniture) ? snapshotState.furniture : [];
    const skipFurnitureRebuild = layoutsEqualForHistory(targetFurn, getLayout());

    if (snapshotState.floorPlanId !== undefined) {
      if (snapshotState.floorPlanId) {
        const entry = resolveFloorplanCatalogEntry?.(snapshotState.floorPlanId) ?? null;
        if (entry) {
          let nextStyleOverride;
          if (Object.prototype.hasOwnProperty.call(snapshotState, "floorplanStyleKey")) {
            const sk = snapshotState.floorplanStyleKey;
            nextStyleOverride = sk != null && String(sk).trim() ? String(sk).trim() : null;
          } else {
            nextStyleOverride = null;
          }
          const canSkipFloorplanRebuild =
            getCurrentFloorplanId() === snapshotState.floorPlanId
            && state.currentFloorplanEntry
            && String(state.currentFloorplanEntry.id ?? "").trim() === String(entry.id ?? "").trim()
            && floorLevelIndexEqualsForHistory(snapshotState.floorLevelIndex, getCurrentFloorLevelIndex())
            && normalizeStyleKeyForSurfaceOverrides(
              effectiveFloorplanStyleKeyFromEntryAndOverride(state.currentFloorplanEntry, nextStyleOverride),
            ) === normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());

          if (canSkipFloorplanRebuild) {
            state.floorplanStyleKeyOverride = nextStyleOverride;
            await rebuildFloorplan3D({ applyDecorFromStyle: false });
            floorplanSurfacesRefreshed = true;
          } else {
            state.floorplanStyleKeyOverride = nextStyleOverride;
            await applyFloorplanEntryAtWorld(entry, undefined, undefined, {
              floorIndex: snapshotState.floorLevelIndex,
              preserveStyleKeyOverride: true,
              preserveSurfaceOverrides: true,
              skipDecorFromStyleMerge: true,
            });
            floorplanSurfacesRefreshed = true;
          }
        } else {
          clearFloorplan();
          floorplanSurfacesRefreshed = true;
        }
      } else if (getCurrentFloorplanId()) {
        clearFloorplan();
        floorplanSurfacesRefreshed = true;
      }
    } else if (floorplanRoot.children.length && state.currentFloorplanEntry) {
      await rebuildFloorplan3D({ applyDecorFromStyle: false });
      floorplanSurfacesRefreshed = true;
    } else if (floorplanRoot.children.length) {
      await applySurfaceOverridesToFloorplan();
      floorplanSurfacesRefreshed = true;
    }

    if (!skipFurnitureRebuild) {
      await rebuildFromLayout(targetFurn);
    } else {
      if (!floorplanSurfacesRefreshed && floorplanRoot.children.length) {
        if (state.currentFloorplanEntry) {
          await rebuildFloorplan3D({ applyDecorFromStyle: false });
        } else {
          await applySurfaceOverridesToFloorplan();
        }
      }
      updateBottomUI();
    }
  }

  function pushHistorySnapshot() {
    if (!state.historyReady || state.isRestoring) return;
    const snapshot = serializeEditorSnapshot();
    if (state.history.length && state.history[state.historyIndex] === snapshot) return;
    state.history.splice(state.historyIndex + 1);
    state.history.push(snapshot);
    state.historyIndex = state.history.length - 1;
    while (state.history.length > maxHistory) {
      state.history.shift();
      state.historyIndex -= 1;
    }
    syncUndoRedoButtons();
    emitLayoutChanged();
  }

  function schedulePushHistory() {
    if (!state.historyReady || state.isRestoring) return;
    clearTimeout(state.historyDebounceTimer);
    state.historyDebounceTimer = setTimeout(() => {
      state.historyDebounceTimer = null;
      pushHistorySnapshot();
    }, 300);
  }

  function flushHistoryDebounce() {
    if (state.historyDebounceTimer) {
      clearTimeout(state.historyDebounceTimer);
      state.historyDebounceTimer = null;
      pushHistorySnapshot();
    }
  }

  function initHistory() {
    state.history.splice(0, state.history.length, serializeEditorSnapshot());
    state.historyIndex = 0;
    syncUndoRedoButtons();
  }

  async function applyHistoryIndex(i) {
    let snapshotState;
    try {
      snapshotState = normalizeHistorySnapshot(JSON.parse(state.history[i]));
    } catch {
      snapshotState = null;
    }
    if (!snapshotState) return;
    state.isRestoring = true;
    try {
      await applyHistorySnapshotState(snapshotState);
    } finally {
      state.isRestoring = false;
    }
    selectFurniture(null);
    syncUndoRedoButtons();
    emitLayoutChanged();
  }

  async function undo() {
    if (state.historyIndex <= 0) return;
    if (state.historyReady) flushHistoryDebounce();
    state.historyIndex -= 1;
    await applyHistoryIndex(state.historyIndex);
  }

  async function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    if (state.historyReady) flushHistoryDebounce();
    state.historyIndex += 1;
    await applyHistoryIndex(state.historyIndex);
  }

  return {
    applyHistorySnapshotState,
    flushHistoryDebounce,
    initHistory,
    normalizeHistorySnapshot,
    pushHistorySnapshot,
    redo,
    schedulePushHistory,
    syncUndoRedoButtons,
    undo,
  };
}
