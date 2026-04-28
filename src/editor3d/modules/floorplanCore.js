import * as THREE from "three";

import {
  decorationPlacementsToLayoutRows,
  getDefaultStyleKeyForFloorplan,
  getMaterialDef,
  loadStyleConfig,
  loadStylePackIndex,
  resolveDoorMaterialKey,
  resolveRoomFloorMaterialKey,
  resolveWallMaterialKey,
  resolveWindowMaterialKey,
} from "../../floorplan/floorplanStyle.js";
import { preloadStyleTextures, stylePreloadPromises } from "../utils/cacheUtils.js";
import {
  FLOOR_SURFACE_Y_M,
  canvasCmToSceneXZ,
  computeFloorplanCanvasPlacement,
  getCurrentFloorFromEntry,
  getEntryBBoxCm,
  getFloorsFromEntry,
  normalizeFloorIndex,
  normalizeFloorKey,
  sceneXZToCenteredCm,
} from "../utils/coordUtils.js";
import { applySceneLightingConfig, mergeSceneLighting } from "../utils/lightingUtils.js";

export function createFloorplanCore(ctx) {
  const {
    activeFloorPickMeshes,
    ambientLight,
    applyFloorplanSurfaceAlpha,
    applySurfaceOverridesToFloorplan,
    appendFurnitureItem,
    buildDoorFillGroup,
    buildFloorDimensions,
    buildFloorNameAnnotations,
    buildRoomMesh,
    buildWallMesh,
    buildWindowGlassGroup,
    clampDecorationLiftMForGroup,
    clearInteractiveList,
    createFloorplanMaterialFromStyleDef,
    dirLight,
    disposeObject3D,
    doorFillMaterialFromNs,
    floorplanRoot,
    furnitureRoot,
    getActiveLayerOpacity,
    getEffectiveFloorplanStyleKey,
    getLayout,
    hemiLight,
    modelIdIsDecoration,
    normalizeStyleKeyForSurfaceOverrides,
    pushHistorySnapshot,
    queueStylePackTextures,
    rebuildFurnitureDimAnnotations,
    rebuildFurnitureNameAnnotations,
    rebuildWallSnapData,
    renderer,
    selectFurniture,
    serializeDesignBaseline,
    serializeDesignForSave,
    setFurnitureFromLayoutCm,
    setFloorLevelsVisible,
    state,
    syncFloorAnnotationVisibility,
    syncOtherOpacityUi,
    tagFloorplanLayerOpacity,
    unregisterFurnitureGroup,
    updateBottomUI,
    windowGlassMaterialFromNs,
  } = ctx;

  function disposeMaterialSafely(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach((m) => {
        if (m && typeof m.dispose === "function") m.dispose();
      });
    } else if (typeof material.dispose === "function") {
      material.dispose();
    }
  }

  function effectiveFloorplanStyleKeyFromEntryAndOverride(entry, overrideVal) {
    if (!entry) return "modern_minimal_v1";
    const overrideKey = overrideVal != null ? String(overrideVal).trim() : "";
    if (overrideKey) return overrideKey;
    const fromEntry = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
    if (fromEntry) return fromEntry;
    const floorplanId = String(entry?.id ?? "").trim();
    const fromPack = floorplanId ? getDefaultStyleKeyForFloorplan(floorplanId) : "";
    return fromPack || "modern_minimal_v1";
  }

  function applyFloorplanLayerOpacityToScene() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const child of gWorld.children) {
      if (child.userData?.floorplanFloorGroup) floorGroups.push(child);
    }
    if (floorGroups.length !== floors.length) return false;

    const floorIdxActive = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    let needFullRebuild = false;

    for (let fi = 0; fi < floorGroups.length; fi++) {
      const newLayerOp = floorIdxActive < 0
        ? 0.2
        : fi === floorIdxActive
          ? getActiveLayerOpacity()
          : state.otherLayersOpacity;

      floorGroups[fi].traverse((obj) => {
        const mats = [];
        if (obj.material) {
          if (Array.isArray(obj.material)) mats.push(...obj.material);
          else mats.push(obj.material);
        }
        for (const mat of mats) {
          if (!mat) continue;
          let perUnit = mat.userData.__floorplanOpacityPerUnitLayer;
          if (!Number.isFinite(perUnit)) {
            const oldLayerOp = mat.userData.__floorplanLayerOpacity;
            if (oldLayerOp == null || !Number.isFinite(oldLayerOp)) continue;
            if (oldLayerOp > 1e-9 && mat.opacity > 1e-9) {
              perUnit = mat.opacity / oldLayerOp;
              mat.userData.__floorplanOpacityPerUnitLayer = perUnit;
            } else {
              needFullRebuild = true;
              continue;
            }
          }
          const newOp = Math.max(0, Math.min(1, perUnit * newLayerOp));
          mat.userData.__floorplanLayerOpacity = newLayerOp;
          applyFloorplanSurfaceAlpha(mat, newOp);
          mat.needsUpdate = true;
        }
      });
    }
    return !needFullRebuild;
  }

  function syncHideOtherFloorsFloorplanVisibility() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const child of gWorld.children) {
      if (child.userData?.floorplanFloorGroup) floorGroups.push(child);
    }
    if (floorGroups.length !== floors.length) return;
    const floorIndex = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    for (let i = 0; i < floorGroups.length; i++) {
      const isActive = floorIndex >= 0 && i === floorIndex;
      floorGroups[i].visible = !state.hideOtherFloors || floorIndex < 0 || isActive;
    }
  }

  function applyFloorLevelSelectionChange() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return;
    const floorIdx = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    const floor = floorIdx >= 0 ? getCurrentFloorFromEntry(entry, floorIdx) : null;
    state.activeFloorId =
      floor?.id != null && String(floor.id).trim() ? String(floor.id).trim() : null;
    rebuildWallSnapData(entry);
    updateBottomUI();
    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-layout", {
        detail: {
          id: entry?.id != null ? String(entry.id) : "",
          floorIndex: floorIdx,
          floorId: String(floor?.id ?? ""),
        },
      }),
    );

    if (!applyFloorplanLayerOpacityToScene()) {
      void rebuildFloorplan3D();
      updateFurnitureFloorVisibility();
      selectFurniture(null);
      return;
    }
    syncHideOtherFloorsFloorplanVisibility();
    syncFloorAnnotationVisibility();
    updateFurnitureFloorVisibility();
    selectFurniture(null);
  }

  async function fastStyleSwitch(newStyleKey) {
    if (!state.currentFloorplanEntry) return false;

    const entry = state.currentFloorplanEntry;
    const floorplanId = String(entry?.id ?? "").trim();
    if (!floorplanId) return false;

    let newStyle = null;
    try {
      newStyle = await loadStyleConfig(floorplanId, newStyleKey);
    } catch (error) {
      console.warn("[VisionHome] 快速切换风格失败:", newStyleKey, error);
      return false;
    }
    if (!newStyle) return false;

    preloadStyleTextures(newStyle).catch((error) => {
      console.warn("[VisionHome] 纹理预加载失败:", error);
    });

    const lightingMerged = mergeSceneLighting(newStyle?.sceneLighting ?? null);
    applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, lightingMerged);
    state.sceneLightingEnvMapIntensity = lightingMerged.envMapIntensity;

    const floorIndex = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    const opacity = floorIndex >= 0 ? getActiveLayerOpacity() : 0.2;
    let needFullRebuild = false;
    const newStyleHasRoomWalls = Object.keys(newStyle?.materials || {}).some((key) => key.endsWith("_wall"));

    floorplanRoot.traverse((obj) => {
      if (!obj.isMesh) return;

      const userData = obj.userData;

      if (userData.floorplanRoomFloor && userData.roomId) {
        const room = { id: userData.roomId };
        const floorKey = resolveRoomFloorMaterialKey(newStyle, room);
        const def = floorKey ? getMaterialDef(newStyle, floorKey) : null;
        if (def) {
          const newMat = createFloorplanMaterialFromStyleDef(def, opacity, {
            forGlass: false,
            envMapIntensity: state.sceneLightingEnvMapIntensity,
            side: THREE.DoubleSide,
          });
          newMat.userData.__floorplanRoomFloorDepthWrite = true;
          applyFloorplanSurfaceAlpha(newMat, opacity);
          queueStylePackTextures(newMat, def, { applyUvScale: true });
          disposeMaterialSafely(obj.material);
          obj.material = newMat;
        } else {
          disposeMaterialSafely(obj.material);
          const defaultMat = ctx.floorplanStdMat();
          defaultMat.userData.__floorplanRoomFloorDepthWrite = true;
          defaultMat.side = THREE.DoubleSide;
          applyFloorplanSurfaceAlpha(defaultMat, opacity);
          obj.material = defaultMat;
        }
      } else if (userData.floorplanWall && userData.wallId) {
        if (Array.isArray(obj.material) || newStyleHasRoomWalls) {
          needFullRebuild = true;
        } else {
          const wall = { id: userData.wallId };
          const wallKey = resolveWallMaterialKey(newStyle, wall);
          const def = wallKey ? getMaterialDef(newStyle, wallKey) : null;
          if (def) {
            const newMat = createFloorplanMaterialFromStyleDef(def, opacity, {
              forGlass: false,
              envMapIntensity: state.sceneLightingEnvMapIntensity,
              side: THREE.FrontSide,
            });
            queueStylePackTextures(newMat, def, { applyUvScale: false });
            disposeMaterialSafely(obj.material);
            obj.material = newMat;
          } else {
            disposeMaterialSafely(obj.material);
            const defaultMat = ctx.floorplanStdMat();
            applyFloorplanSurfaceAlpha(defaultMat, opacity);
            defaultMat.side = THREE.FrontSide;
            tagFloorplanLayerOpacity(defaultMat, opacity);
            obj.material = defaultMat;
          }
        }
      } else if (userData.floorplanDoor && userData.doorId) {
        const door = { id: userData.doorId };
        const doorKey = resolveDoorMaterialKey(newStyle, door);
        const def = doorKey ? getMaterialDef(newStyle, doorKey) : null;
        if (def) {
          const newMat = createFloorplanMaterialFromStyleDef(def, opacity, {
            forGlass: false,
            envMapIntensity: state.sceneLightingEnvMapIntensity,
            side: THREE.FrontSide,
          });
          queueStylePackTextures(newMat, def, { applyUvScale: false });
          disposeMaterialSafely(obj.material);
          obj.material = newMat;
        } else if (userData.floorplanDoorStyle) {
          disposeMaterialSafely(obj.material);
          obj.material = doorFillMaterialFromNs(userData.floorplanDoorStyle, opacity);
        }
      } else if (userData.floorplanWindow && userData.windowId) {
        const win = { id: userData.windowId };
        const windowKey = resolveWindowMaterialKey(newStyle, win);
        const def = windowKey ? getMaterialDef(newStyle, windowKey) : null;
        if (def) {
          const newMat = createFloorplanMaterialFromStyleDef(def, opacity, {
            forGlass: true,
            envMapIntensity: 0.9,
            side: THREE.FrontSide,
          });
          queueStylePackTextures(newMat, def, { applyUvScale: false });
          disposeMaterialSafely(obj.material);
          obj.material = newMat;
        } else if (userData.floorplanWindowStyle) {
          disposeMaterialSafely(obj.material);
          obj.material = windowGlassMaterialFromNs(userData.floorplanWindowStyle, opacity);
        }
      }
    });

    state.lastMergedFloorplanStyle = newStyle;

    const styleKey = normalizeStyleKeyForSurfaceOverrides(newStyleKey);
    const roomFloorMats = newStyle?.roomFloorMaterials;
    state.roomFloorOverridesByStyleKey[styleKey] =
      roomFloorMats && typeof roomFloorMats === "object"
        ? JSON.parse(JSON.stringify(roomFloorMats))
        : state.roomFloorOverridesByStyleKey[styleKey] || {};

    const doorMats = newStyle?.doorOverrides;
    state.doorOverridesByStyleKey[styleKey] =
      doorMats && typeof doorMats === "object"
        ? JSON.parse(JSON.stringify(doorMats))
        : state.doorOverridesByStyleKey[styleKey] || {};

    const windowMats = newStyle?.windowOverrides;
    state.windowOverridesByStyleKey[styleKey] =
      windowMats && typeof windowMats === "object"
        ? JSON.parse(JSON.stringify(windowMats))
        : state.windowOverridesByStyleKey[styleKey] || {};

    if (needFullRebuild) {
      console.log("[VisionHome] 快速切换需要完全重建（多材质墙体或房间专属墙面材质）");
      return false;
    }

    return true;
  }

  async function rebuildFloorplan3D(opts = {}) {
    const applyDecorFromStyle = Boolean(opts.applyDecorFromStyle);
    const gen = state.floorplanRebuildGen + 1;
    state.floorplanRebuildGen = gen;
    clearInteractiveList();
    disposeObject3D(floorplanRoot);
    floorplanRoot.clear();
    ctx.setFloorplanSelected(false);
    if (!state.currentFloorplanEntry) {
      state.lastMergedFloorplanStyle = null;
      state.floorYOffsetById = new Map();
      state.floorElevationBaseCm = 0;
      rebuildWallSnapData(null);
      const fallbackLight = mergeSceneLighting(null);
      applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, fallbackLight);
      state.sceneLightingEnvMapIntensity = fallbackLight.envMapIntensity;
      return;
    }

    const entry = state.currentFloorplanEntry;
    const floorplanId = String(entry?.id ?? "").trim();
    if (floorplanId) {
      const packIndex = await loadStylePackIndex(floorplanId);
      if (packIndex?.styles?.length) {
        const topStyles = packIndex.styles.slice(0, 3);
        for (const styleInfo of topStyles) {
          const preloadKey = `${floorplanId}::${styleInfo.key}`;
          if (!stylePreloadPromises.has(preloadKey)) {
            const promise = loadStyleConfig(floorplanId, styleInfo.key)
              .then((style) => preloadStyleTextures(style))
              .catch((error) => console.warn("[VisionHome] 风格预加载失败:", styleInfo.key, error));
            stylePreloadPromises.set(preloadKey, promise);
          }
        }
      }
    }

    const styleKey = getEffectiveFloorplanStyleKey();
    let style = null;
    try {
      style = await loadStyleConfig(floorplanId, styleKey);
      if (style) {
        preloadStyleTextures(style).catch((error) => {
          console.warn("[VisionHome] 纹理预加载失败:", error);
        });
      }
    } catch (error) {
      console.warn("[VisionHome] 风格包加载失败:", styleKey, error);
    }

    if (!style && entry) {
      const fallbackStyleKey = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
      if (fallbackStyleKey && fallbackStyleKey !== styleKey) {
        try {
          style = await loadStyleConfig(floorplanId, fallbackStyleKey);
          if (style) {
            state.floorplanStyleKeyOverride = null;
            window.dispatchEvent(
              new CustomEvent("visionhome:floorplan-applied-to-layout", {
                detail: {
                  id: floorplanId,
                  floorIndex: state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1,
                  floorId: String(state.activeFloorId ?? ""),
                  styleFallbackFrom: styleKey,
                  styleFallbackTo: fallbackStyleKey,
                },
              }),
            );
          }
        } catch (error) {
          console.warn("[VisionHome] 风格包回退加载失败:", fallbackStyleKey, error);
        }
      }
    }
    state.lastMergedFloorplanStyle = style;
    if (gen !== state.floorplanRebuildGen) return;

    const styleBucketKey = normalizeStyleKeyForSurfaceOverrides(styleKey);
    if (!state.isRestoring) {
      const roomFloorMats = style?.roomFloorMaterials;
      state.roomFloorOverridesByStyleKey[styleBucketKey] =
        roomFloorMats && typeof roomFloorMats === "object"
          ? JSON.parse(JSON.stringify(roomFloorMats))
          : state.roomFloorOverridesByStyleKey[styleBucketKey] || {};

      const doorMats = style?.doorOverrides;
      state.doorOverridesByStyleKey[styleBucketKey] =
        doorMats && typeof doorMats === "object"
          ? JSON.parse(JSON.stringify(doorMats))
          : state.doorOverridesByStyleKey[styleBucketKey] || {};

      const windowMats = style?.windowOverrides;
      state.windowOverridesByStyleKey[styleBucketKey] =
        windowMats && typeof windowMats === "object"
          ? JSON.parse(JSON.stringify(windowMats))
          : state.windowOverridesByStyleKey[styleBucketKey] || {};
    }

    const lightingMerged = mergeSceneLighting(style?.sceneLighting ?? null);
    applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, lightingMerged);
    state.sceneLightingEnvMapIntensity = lightingMerged.envMapIntensity;

    const floorIndex = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    const floor = floorIndex >= 0 ? getCurrentFloorFromEntry(entry, floorIndex) : null;
    if (floorIndex >= 0 && !floor) return;
    const placement = computeFloorplanCanvasPlacement(entry);
    if (!placement) return;
    const { worldX, worldY, s, cx, cy } = placement;
    const bbox = getEntryBBoxCm(entry);
    if (!bbox) return;
    const gWorld = new THREE.Group();
    gWorld.userData.floorplanGWorld = true;
    const pos = canvasCmToSceneXZ(worldX, worldY);
    gWorld.position.set(pos.x, 0, pos.z);
    floorplanRoot.add(gWorld);

    const floors = getFloorsFromEntry(entry);
    const elevationsCm = floors
      .map((fl) => (Number.isFinite(Number(fl?.elevation)) ? Number(fl.elevation) : 0))
      .filter((value) => Number.isFinite(value));
    state.floorElevationBaseCm = elevationsCm.length ? Math.min(...elevationsCm) : 0;
    const nextFloorOffsets = new Map();
    floors.forEach((fl, index) => {
      const keyRaw = String(fl?.id ?? "").trim() || `floor${index + 1}`;
      const key = normalizeFloorKey(keyRaw);
      const elevationCm = Number.isFinite(Number(fl?.elevation)) ? Number(fl.elevation) : 0;
      nextFloorOffsets.set(key, (elevationCm - state.floorElevationBaseCm) / 100);
    });
    state.floorYOffsetById = nextFloorOffsets;

    floors.forEach((fl, index) => {
      const floorG = new THREE.Group();
      floorG.userData.floorplanFloorGroup = true;
      const isActive = floorIndex >= 0 && index === floorIndex;
      const opacity = floorIndex >= 0
        ? (isActive ? getActiveLayerOpacity() : state.otherLayersOpacity)
        : 0.2;

      const styleMatCache = new Map();
      function getMaterialForKey(key, opts = {}) {
        if (!style || !key) return null;
        const cacheKey = `${key}|${opts.forGlass ? "g" : ""}|${opts.floorUv ? "f" : ""}`;
        if (styleMatCache.has(cacheKey)) return styleMatCache.get(cacheKey);
        const def = getMaterialDef(style, key);
        if (!def) return null;
        const side = opts.floorUv ? THREE.DoubleSide : THREE.FrontSide;
        const mat = createFloorplanMaterialFromStyleDef(def, opacity, {
          forGlass: opts.forGlass,
          envMapIntensity: opts.forGlass ? 0.9 : state.sceneLightingEnvMapIntensity,
          side,
        });
        if (opts.floorUv) {
          mat.userData.__floorplanRoomFloorDepthWrite = true;
          applyFloorplanSurfaceAlpha(mat, opacity);
        }
        styleMatCache.set(cacheKey, mat);
        queueStylePackTextures(mat, def, { applyUvScale: Boolean(opts.floorUv) });
        return mat;
      }

      const floorLevelId = String(fl?.id ?? "").trim() || `floor${index + 1}`;
      (fl.rooms || []).forEach((room, roomIdx) => {
        const floorKey = resolveRoomFloorMaterialKey(style, room);
        const floorMat = floorKey ? getMaterialForKey(floorKey, { floorUv: true }) : null;
        const mesh = buildRoomMesh(room, cx, cy, s, opacity, floorMat, floorLevelId);
        if (mesh) {
          mesh.position.y = 0.02 + roomIdx * 0.0002;
          floorG.add(mesh);
        }
      });

      const floorHeight = Number(fl.height);
      const defaultH = Number.isFinite(floorHeight) && floorHeight > 0 ? floorHeight : 280;
      for (const wall of fl.walls || []) {
        const wallKey = resolveWallMaterialKey(style, wall);
        const wallMat = wallKey ? getMaterialForKey(wallKey) : null;
        const mesh = buildWallMesh(wall, fl, cx, cy, s, defaultH, opacity, wallMat, style, getMaterialForKey, floorLevelId);
        if (mesh) floorG.add(mesh);
      }
      for (const door of fl.doors || []) {
        const wallId = String(door.wallId ?? "").trim();
        const wall = wallId ? (fl.walls || []).find((item) => String(item?.id ?? "") === wallId) : null;
        if (!wall) continue;
        const doorKey = resolveDoorMaterialKey(style, door);
        const doorMat = doorKey ? getMaterialForKey(doorKey) : null;
        const fillG = buildDoorFillGroup(door, wall, fl.walls || [], cx, cy, s, defaultH, opacity, doorMat, floorLevelId);
        if (fillG) floorG.add(fillG);
      }
      for (const win of fl.windows || []) {
        const wallId = String(win.wallId ?? "").trim();
        const wall = wallId ? (fl.walls || []).find((item) => String(item?.id ?? "") === wallId) : null;
        if (!wall) continue;
        const windowKey = resolveWindowMaterialKey(style, win);
        const winMat = windowKey ? getMaterialForKey(windowKey, { forGlass: true }) : null;
        const winG = buildWindowGlassGroup(win, wall, fl.walls || [], cx, cy, s, defaultH, opacity, winMat, floorLevelId);
        if (winG) floorG.add(winG);
      }

      const dimG = buildFloorDimensions(fl, cx, cy, s);
      if (dimG) {
        dimG.visible = state.showDimensions && (!state.floorSelectionEnabled || isActive);
        floorG.add(dimG);
      }
      const nameG = buildFloorNameAnnotations(fl, cx, cy, s);
      if (nameG) {
        nameG.visible = state.showNames && (!state.floorSelectionEnabled || isActive);
        floorG.add(nameG);
      }

      floorG.position.y = state.floorYOffsetById.get(normalizeFloorKey(floorLevelId)) ?? 0;
      floorG.visible = !state.hideOtherFloors || floorIndex < 0 || isActive;
      gWorld.add(floorG);
    });

    const hitW = (Math.max(bbox.w, 1) * s) / 100;
    const hitD = (Math.max(bbox.h, 1) * s) / 100;
    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(hitW, hitD),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.rotation.x = -Math.PI / 2;
    hit.userData.floorplanPick = true;
    gWorld.add(hit);

    state.activeFloorId =
      floor?.id != null && String(floor.id).trim() ? String(floor.id).trim() : null;
    await applySurfaceOverridesToFloorplan();
    rebuildWallSnapData(entry);
    updateBottomUI();

    if (applyDecorFromStyle && style && gen === state.floorplanRebuildGen) {
      await mergeLayoutWithStyleDecorations(style);
      if (gen !== state.floorplanRebuildGen) return;
    }

    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-layout", {
        detail: {
          id: entry?.id != null ? String(entry.id) : "",
          floorIndex,
          floorId: String(floor?.id ?? ""),
        },
      }),
    );
  }

  function clearFloorplan() {
    state.currentFloorplanEntry = null;
    state.floorplanStyleKeyOverride = null;
    state.floorplanSurfaceOverridesByStyleKey = {};
    state.currentFloorIndex = 0;
    state.floorSelectionEnabled = true;
    syncOtherOpacityUi();
    void rebuildFloorplan3D();
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (state.historyReady && !state.isRestoring) pushHistorySnapshot();
  }

  async function applyFloorplanEntryAtWorld(entry, _wx, _wy, options = {}) {
    if (!entry) return;
    if (!options.preserveSurfaceOverrides) {
      state.floorplanSurfaceOverridesByStyleKey = {};
      state.roomFloorOverridesByStyleKey = {};
      state.doorOverridesByStyleKey = {};
      state.windowOverridesByStyleKey = {};
      state.wallFaceOverridesByStyleKey = {};
    }
    state.currentFloorplanEntry = entry;
    state.currentFloorIndex = normalizeFloorIndex(entry, options.floorIndex);
    if (!options.preserveStyleKeyOverride) state.floorplanStyleKeyOverride = null;
    state.floorSelectionEnabled = true;
    syncOtherOpacityUi();
    await rebuildFloorplan3D({ applyDecorFromStyle: !options.skipDecorFromStyleMerge });
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (state.historyReady && !state.isRestoring) {
      pushHistorySnapshot();
      window.__designLayoutBaseline = serializeDesignBaseline();
      window.__designSaveBaseline = serializeDesignForSave();
    }
  }

  async function rebuildFromLayout(layout) {
    const targetRows = Array.isArray(layout) ? layout.filter((row) => row && row.model) : [];
    const currentGroups = furnitureRoot.children.filter((child) => child.userData?.isFurniture);
    const exactBuckets = new Map();
    const unused = new Set(currentGroups);

    const normalizeRow = (row) => {
      let rot = Math.round(Number(row?.rotation ?? 0) || 0) % 360;
      if (rot < 0) rot += 360;
      const lift = row?.decorationLiftCm != null ? Math.round(Number(row.decorationLiftCm) || 0) : 0;
      return {
        model: String(row?.model ?? "").trim(),
        floorId: String(row?.floorId ?? "").trim() || null,
        x: Math.round(Number(row?.x) || 0),
        y: Math.round(Number(row?.y) || 0),
        rotation: rot,
        decorationLiftCm: lift,
      };
    };
    const keyForRow = (row) => {
      const r = normalizeRow(row);
      return JSON.stringify({
        m: r.model,
        f: r.floorId,
        x: r.x,
        y: r.y,
        r: r.rotation,
        l: r.decorationLiftCm,
      });
    };
    const rowForGroup = (group) => {
      const cm = sceneXZToCenteredCm(group.position.x, group.position.z);
      return {
        model: group.userData.modelType,
        floorId: String(group.userData.floorId || "").trim() || null,
        x: Math.round(cm.x),
        y: Math.round(cm.y),
        rotation: Math.round(group.userData.rotDeg ?? 0),
        decorationLiftCm: Math.round((Number(group.userData.decorationLiftM) || 0) * 100),
      };
    };

    currentGroups.forEach((group) => {
      const key = keyForRow(rowForGroup(group));
      if (!exactBuckets.has(key)) exactBuckets.set(key, []);
      exactBuckets.get(key).push(group);
    });

    const assignments = targetRows.map((row) => ({ row, group: null }));
    assignments.forEach((entry) => {
      const bucket = exactBuckets.get(keyForRow(entry.row));
      while (bucket?.length) {
        const group = bucket.shift();
        if (!unused.has(group)) continue;
        entry.group = group;
        unused.delete(group);
        break;
      }
    });

    assignments.forEach((entry) => {
      if (entry.group) return;
      const target = normalizeRow(entry.row);
      let fallback = null;
      for (const group of unused) {
        if (String(group.userData.modelType || "").trim() !== target.model) continue;
        if (String(group.userData.floorId || "").trim() === String(target.floorId || "").trim()) {
          fallback = group;
          break;
        }
        if (!fallback) fallback = group;
      }
      if (!fallback) return;
      entry.group = fallback;
      unused.delete(fallback);
    });

    if (unused.has(state.selectedGroup)) selectFurniture(null);
    unused.forEach((group) => {
      unregisterFurnitureGroup(group);
      furnitureRoot.remove(group);
      disposeObject3D(group);
      state.shadowCacheDirty = true;
    });

    for (const entry of assignments) {
      const row = normalizeRow(entry.row);
      let group = entry.group;
      if (!group) {
        group = await appendFurnitureItem(row.model, row.x, row.y, row.rotation, row.floorId, {
          wallSnap: false,
          decorationLiftCm: row.decorationLiftCm,
        });
        entry.group = group;
        continue;
      }
      if (keyForRow(rowForGroup(group)) !== keyForRow(row)) state.shadowCacheDirty = true;
      group.userData.floorId = row.floorId || "floor1";
      group.userData.rotDeg = row.rotation;
      setFurnitureFromLayoutCm(group, row.x, row.y, row.rotation, { wallSnap: false });
      group.userData.decorationLiftM = clampDecorationLiftMForGroup(group, row.decorationLiftCm / 100);
      furnitureRoot.add(group);
    }

    updateFurnitureFloorVisibility();
    updateBottomUI();
  }

  async function mergeLayoutWithStyleDecorations(style) {
    const layout = getLayout();
    const furnitureOnly = layout.filter((row) => !modelIdIsDecoration(row.model));
    const decorRows = decorationPlacementsToLayoutRows(style);
    await rebuildFromLayout([...furnitureOnly, ...decorRows]);
  }

  function updateFurnitureFloorVisibility() {
    const hasFloor = Boolean(state.activeFloorId);
    const activeKey = state.activeFloorId != null ? normalizeFloorKey(state.activeFloorId) : null;
    activeFloorPickMeshes.length = 0;
    furnitureRoot.children.forEach((group) => {
      if (!group.userData?.isFurniture) return;
      const floorId = String(group.userData.floorId || "").trim();
      const key = normalizeFloorKey(floorId);
      const yOffset = state.floorYOffsetById.get(key) ?? 0;
      const liftM = clampDecorationLiftMForGroup(group, group.userData.decorationLiftM ?? 0);
      group.userData.decorationLiftM = liftM;
      group.position.y = yOffset + FLOOR_SURFACE_Y_M + liftM;
      const isActiveFloor = !hasFloor || !floorId || key === activeKey;
      group.userData.isFloorActive = isActiveFloor;
      group.visible = !state.hideOtherFloors || isActiveFloor;
      group.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        if (isActiveFloor) activeFloorPickMeshes.push(obj);
        const opacity = isActiveFloor ? 1 : Math.min(1, state.otherLayersOpacity * 2);
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          if (!mat) return;
          applyFloorplanSurfaceAlpha(mat, opacity);
          mat.needsUpdate = true;
        });
      });
    });
    if (state.selectedGroup && state.selectedGroup.userData?.isFloorActive === false) {
      selectFurniture(null);
    }
    rebuildFurnitureDimAnnotations();
    rebuildFurnitureNameAnnotations();
  }

  return {
    applyFloorLevelSelectionChange,
    applyFloorplanEntryAtWorld,
    applyFloorplanLayerOpacityToScene,
    clearFloorplan,
    effectiveFloorplanStyleKeyFromEntryAndOverride,
    fastStyleSwitch,
    mergeLayoutWithStyleDecorations,
    rebuildFloorplan3D,
    rebuildFromLayout,
    syncHideOtherFloorsFloorplanVisibility,
    updateFurnitureFloorVisibility,
  };
}
