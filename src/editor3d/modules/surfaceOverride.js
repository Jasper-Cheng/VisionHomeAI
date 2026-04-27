import * as THREE from "three";

import { resolveMaterialDefFromLibrary } from "../../floorplan/floorplanStyle.js";

export function createSurfaceOverrideModule(ctx) {
  const {
    applyFloorplanSurfaceAlpha,
    createFloorplanMaterialFromStyleDef,
    floorplanRoot,
    getCurrentSurfaceOverridesBucket,
    getDoorOverride,
    getEffectiveFloorplanStyleKey,
    getFloorplanMaterialsLibraryBag,
    getRoomFloorOverride,
    getWallFaceOverride,
    getWindowOverride,
    normalizeStyleKeyForSurfaceOverrides,
    queueStylePackTextures,
    state,
  } = ctx;

  function disposeFloorplanOverrideMaterial(mesh) {
    if (!mesh?.material) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m) => {
      if (!m?.userData?.__floorplanOverrideOwned) return;
      if (m.map) m.map.dispose();
      if (m.normalMap) m.normalMap.dispose();
      if (m.roughnessMap) m.roughnessMap.dispose();
      if (m.metalnessMap) m.metalnessMap.dispose();
      m.dispose();
    });
  }

  /**
   * 多段墙体共用同一 override 材质时，每张 mesh dispose 一次会误删共享贴图；先按材质引用去重再 dispose。
   * @param {import("three").Mesh[]} meshes
   */
  function disposeUniqueOverrideMaterialsOnMeshes(meshes) {
    const seen = new Set();
    for (const mesh of meshes) {
      if (!mesh?.material) continue;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        if (!m.userData?.__floorplanOverrideOwned) continue;
        if (m.map) m.map.dispose();
        if (m.normalMap) m.normalMap.dispose();
        if (m.roughnessMap) m.roughnessMap.dispose();
        if (m.metalnessMap) m.metalnessMap.dispose();
        m.dispose();
      }
    }
  }

  /**
   * 由库材质 + 面板覆盖生成一份 Three 材质，同一楼层同 scope 下所有 mesh 可共用。
   * @returns {{ mat: import("three").Material, mergedDef: object } | null}
   */
  function createFloorplanSurfaceOverrideMaterialOnce(ov, libraryBag, opacity, isRoomFloor) {
    if (!ov?.materialId) return null;
    const def = resolveMaterialDefFromLibrary(libraryBag, ov.materialId);
    if (!def) return null;
    const mergedDef = mergeMaterialOverrideIntoDef(def, ov);
    const side = isRoomFloor ? THREE.DoubleSide : THREE.FrontSide;
    const mat = createFloorplanMaterialFromStyleDef(mergedDef, opacity, {
      forGlass: false,
      side,
    });
    mat.userData.__floorplanOverrideOwned = true;
    if (isRoomFloor) {
      mat.userData.__floorplanRoomFloorDepthWrite = true;
    }
    applyFloorplanSurfaceAlpha(mat, mat.opacity);
    const applyUvOpts =
      isRoomFloor ||
      (Array.isArray(ov.uvScale) && ov.uvScale.length >= 2) ||
      (ov.textureRotation != null && Number.isFinite(Number(ov.textureRotation)));
    queueStylePackTextures(mat, mergedDef, { applyUvScale: applyUvOpts });
    mat.needsUpdate = true;
    return { mat, mergedDef };
  }

  /**
   * 将旧版 { rooms:{id}, walls:{id} } 转为 allFloors / allWalls（取各组第一条，仅迁移兼容）
   * @param {Record<string, object>} raw
   */
  function migrateFloorplanSurfaceOverridesBucket(raw) {
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const [fid, bag] of Object.entries(raw)) {
      if (!bag || typeof bag !== "object") continue;
      if (bag.allWalls || bag.allFloors || bag.allDoors || bag.allWindows) {
        out[fid] = { ...bag };
        continue;
      }
      const next = {};
      if (bag.walls && typeof bag.walls === "object") {
        const vals = Object.values(bag.walls).filter((v) => v && typeof v === "object");
        if (vals.length) next.allWalls = { ...vals[0] };
      }
      if (bag.rooms && typeof bag.rooms === "object") {
        const vals = Object.values(bag.rooms).filter((v) => v && typeof v === "object");
        if (vals.length) next.allFloors = { ...vals[0] };
      }
      if (next.allWalls || next.allFloors) out[fid] = next;
    }
    if (raw.roomFloors && typeof raw.roomFloors === "object") {
      out.roomFloors = JSON.parse(JSON.stringify(raw.roomFloors));
    }
    if (raw.doorOverrides && typeof raw.doorOverrides === "object") {
      out.doorOverrides = JSON.parse(JSON.stringify(raw.doorOverrides));
    }
    if (raw.windowOverrides && typeof raw.windowOverrides === "object") {
      out.windowOverrides = JSON.parse(JSON.stringify(raw.windowOverrides));
    }
    if (raw.wallFaceOverrides && typeof raw.wallFaceOverrides === "object") {
      out.wallFaceOverrides = JSON.parse(JSON.stringify(raw.wallFaceOverrides));
    }
    return out;
  }

  /**
   * 将面板中的数值覆盖合并到库材质定义。
   * @param {object} def
   * @param {object} ov
   */
  function mergeMaterialOverrideIntoDef(def, ov) {
    if (!def || typeof def !== "object") return def;
    const out = { ...def };
    if (def.texture && typeof def.texture === "object") {
      out.texture = { ...def.texture };
    }
    if (ov.color != null && String(ov.color).trim()) {
      const h = String(ov.color).trim();
      out.color = h.startsWith("#") ? h : `#${h.replace(/^#/, "")}`;
    }
    if (ov.roughness != null && Number.isFinite(Number(ov.roughness))) {
      out.roughness = Math.min(1, Math.max(0, Number(ov.roughness)));
    }
    if (ov.metalness != null && Number.isFinite(Number(ov.metalness))) {
      out.metalness = Math.min(1, Math.max(0, Number(ov.metalness)));
    }
    if (ov.opacity != null && Number.isFinite(Number(ov.opacity))) {
      out.opacity = Math.min(1, Math.max(0, Number(ov.opacity)));
    }
    if (ov.transmission != null && Number.isFinite(Number(ov.transmission))) {
      out.transmission = Math.min(1, Math.max(0, Number(ov.transmission)));
    }
    if (ov.ior != null && Number.isFinite(Number(ov.ior))) {
      out.ior = Math.min(2.5, Math.max(1, Number(ov.ior)));
    }
    if (Array.isArray(ov.uvScale) && ov.uvScale.length >= 2) {
      const u = Number(ov.uvScale[0]);
      const v = Number(ov.uvScale[1]);
      if (Number.isFinite(u) && Number.isFinite(v)) {
        out.uvScale = [u, v];
      }
    }
    if (ov.textureRotation != null && Number.isFinite(Number(ov.textureRotation))) {
      out.textureRotation = Number(ov.textureRotation);
    }
    if (ov.textureAlbedo != null && String(ov.textureAlbedo).trim()) {
      const raw = String(ov.textureAlbedo).trim();
      const path = raw.includes("/") ? raw : `textures/${raw}`;
      if (!out.texture) out.texture = {};
      else out.texture = { ...out.texture };
      out.texture.albedo = path;
    }
    return out;
  }

  function windowSurfaceOverrideForApply(ov) {
    if (!ov || typeof ov !== "object") return null;
    const next = { ...ov };
    delete next.materialId;
    delete next.textureAlbedo;
    delete next.materialPresetCleared;
    delete next.uvScale;
    delete next.textureRotation;
    return next;
  }

  function surfaceOverrideIsActive(ov) {
    if (!ov || typeof ov !== "object") return false;
    if (ov.color || ov.materialId) return true;
    if (ov.textureAlbedo != null && String(ov.textureAlbedo).trim()) return true;
    if (ov.materialPresetCleared) return true;
    if (ov.roughness != null && Number.isFinite(Number(ov.roughness))) return true;
    if (ov.metalness != null && Number.isFinite(Number(ov.metalness))) return true;
    if (Array.isArray(ov.uvScale) && ov.uvScale.length >= 2) return true;
    if (ov.textureRotation != null && Number.isFinite(Number(ov.textureRotation))) return true;
    if (ov.opacity != null && Number.isFinite(Number(ov.opacity))) return true;
    if (ov.transmission != null && Number.isFinite(Number(ov.transmission))) return true;
    if (ov.ior != null && Number.isFinite(Number(ov.ior))) return true;
    return false;
  }

  function applySurfaceOverrideToMesh(mesh, ov, libraryBag) {
    if (!mesh?.isMesh || !ov) return;
    const opacity = Number.isFinite(mesh.userData.floorplanSurfaceOpacity)
      ? mesh.userData.floorplanSurfaceOpacity
      : 1;
    const isRoomFloor = mesh.userData.floorplanRoomFloor === true;
    if (ov.materialId) {
      disposeFloorplanOverrideMaterial(mesh);
      const built = createFloorplanSurfaceOverrideMaterialOnce(ov, libraryBag, opacity, isRoomFloor);
      if (!built) return;
      mesh.material = built.mat;
      return;
    }
    const useColorPath =
      ov.color ||
      ov.roughness != null ||
      ov.metalness != null ||
      ov.opacity != null ||
      ov.transmission != null ||
      ov.ior != null ||
      ov.materialPresetCleared;
    if (!useColorPath) return;
    const layerOp = Number.isFinite(mesh.userData.floorplanSurfaceOpacity) ? mesh.userData.floorplanSurfaceOpacity : 1;
    const isRoomFloorMesh = mesh.userData.floorplanRoomFloor === true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((m) => {
      if (!m?.isMeshStandardMaterial && !m?.isMeshPhysicalMaterial) return m;
      const c = m.clone();
      c.userData.__floorplanOverrideOwned = true;
      if (ov.materialPresetCleared) {
        c.map = null;
        c.normalMap = null;
        c.roughnessMap = null;
        c.metalnessMap = null;
        c.aoMap = null;
      }
      if (ov.color) {
        try {
          const h = String(ov.color).trim();
          c.color.setStyle(h.startsWith("#") ? h : `#${h}`);
        } catch {
          /* ignore */
        }
      }
      if (ov.roughness != null && Number.isFinite(Number(ov.roughness))) {
        c.roughness = Math.min(1, Math.max(0, Number(ov.roughness)));
      }
      if (ov.metalness != null && Number.isFinite(Number(ov.metalness))) {
        c.metalness = Math.min(1, Math.max(0, Number(ov.metalness)));
      }
      if (c.isMeshPhysicalMaterial) {
        if (ov.transmission != null && Number.isFinite(Number(ov.transmission))) {
          c.transmission = Math.min(1, Math.max(0, Number(ov.transmission)));
        }
        if (ov.ior != null && Number.isFinite(Number(ov.ior))) {
          c.ior = Math.min(2.5, Math.max(1, Number(ov.ior)));
        }
      }
      if (ov.opacity != null && Number.isFinite(Number(ov.opacity))) {
        const op = Math.min(1, Math.max(0, Number(ov.opacity))) * layerOp;
        if (isRoomFloorMesh) {
          c.userData.__floorplanRoomFloorDepthWrite = true;
        } else {
          delete c.userData.__floorplanRoomFloorDepthWrite;
        }
        applyFloorplanSurfaceAlpha(c, op);
      }
      c.needsUpdate = true;
      return c;
    });
    disposeFloorplanOverrideMaterial(mesh);
    mesh.material = next.length === 1 ? next[0] : next;
  }

  function applySurfaceOverrideToMeshFace(mesh, faceId, ov, libraryBag) {
    if (!mesh?.isMesh || !ov) return;
    if (!surfaceOverrideIsActive(ov)) return;

    const opacity = Number.isFinite(mesh.userData.floorplanSurfaceOpacity)
      ? mesh.userData.floorplanSurfaceOpacity
      : 1;

    function ensureMaterialArray(targetMesh) {
      if (Array.isArray(targetMesh.material)) return targetMesh.material;
      const base = targetMesh.material;
      const arr = [base, base, base, base, base.clone ? base.clone() : base, base.clone ? base.clone() : base];
      arr[4].userData = { ...arr[4].userData };
      arr[5].userData = { ...arr[5].userData };
      targetMesh.material = arr;
      return arr;
    }

    function buildFaceMat(existingMat) {
      if (ov.materialId) {
        const built = createFloorplanSurfaceOverrideMaterialOnce(ov, libraryBag, opacity, false);
        return built ? built.mat : existingMat;
      }
      const useColorPath =
        ov.color ||
        ov.roughness != null ||
        ov.metalness != null ||
        ov.opacity != null ||
        ov.materialPresetCleared;
      if (!useColorPath) return existingMat;
      const m = existingMat;
      if (!m?.isMeshStandardMaterial && !m?.isMeshPhysicalMaterial) return existingMat;
      const c = m.clone();
      c.userData.__floorplanOverrideOwned = true;
      if (ov.materialPresetCleared) {
        c.map = null;
        c.normalMap = null;
        c.roughnessMap = null;
        c.metalnessMap = null;
        c.aoMap = null;
      }
      if (ov.color) {
        try {
          const h = String(ov.color).trim();
          c.color.setStyle(h.startsWith("#") ? h : `#${h}`);
        } catch {
          /* ignore */
        }
      }
      if (ov.roughness != null && Number.isFinite(Number(ov.roughness))) {
        c.roughness = Math.min(1, Math.max(0, Number(ov.roughness)));
      }
      if (ov.metalness != null && Number.isFinite(Number(ov.metalness))) {
        c.metalness = Math.min(1, Math.max(0, Number(ov.metalness)));
      }
      const us = ov.uvScale;
      if (Array.isArray(us) && us.length >= 2 && Number.isFinite(us[0]) && Number.isFinite(us[1])) {
        c.userData.__uvScaleX = us[0];
        c.userData.__uvScaleY = us[1];
      }
      if (ov.textureRotation != null && Number.isFinite(Number(ov.textureRotation))) {
        c.userData.__textureRotation = Number(ov.textureRotation);
      }
      c.needsUpdate = true;
      return c;
    }

    const mats = ensureMaterialArray(mesh);
    if (faceId === null) {
      mats[4] = buildFaceMat(mats[4]);
      mats[5] = buildFaceMat(mats[5]);
    } else if (faceId === "face_a") {
      mats[4] = buildFaceMat(mats[4]);
    } else if (faceId === "face_b") {
      mats[5] = buildFaceMat(mats[5]);
    }
    mesh.material = mats;
  }

  async function applyRoomFloorOverridesForMultiple(floorLevelId, roomIds) {
    if (!floorplanRoot.children.length) return;
    if (!Array.isArray(roomIds) || !roomIds.length) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const roomIdSet = new Set(roomIds.map((r) => String(r).trim()));
    const meshes = [];
    floorplanRoot.traverse((o) => {
      if (!o.isMesh) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (!o.userData.floorplanRoomFloor) return;
      const rid = String(o.userData.floorplanRoomId ?? "").trim();
      if (!rid || !roomIdSet.has(rid)) return;
      meshes.push(o);
    });
    if (!meshes.length) return;
    for (const mesh of meshes) {
      const rid = String(mesh.userData.floorplanRoomId ?? "").trim();
      const ov = getRoomFloorOverride(fid, rid);
      if (ov && surfaceOverrideIsActive(ov)) {
        applySurfaceOverrideToMesh(mesh, ov, libraryBag);
      }
    }
  }

  async function applyDoorOverridesForMultiple(floorLevelId, doorIds) {
    if (!floorplanRoot.children.length) return;
    if (!Array.isArray(doorIds) || !doorIds.length) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const doorIdSet = new Set(doorIds.map((d) => String(d).trim()));
    const meshes = [];
    floorplanRoot.traverse((o) => {
      if (!o.isMesh) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (!o.userData.floorplanDoorFill || o.userData.floorplanDoorHandle) return;
      const did = String(o.userData.floorplanDoorId ?? "").trim();
      if (!did || !doorIdSet.has(did)) return;
      meshes.push(o);
    });
    if (!meshes.length) return;
    for (const mesh of meshes) {
      const did = String(mesh.userData.floorplanDoorId ?? "").trim();
      const ov = getDoorOverride(fid, did);
      if (ov && surfaceOverrideIsActive(ov)) {
        applySurfaceOverrideToMesh(mesh, ov, libraryBag);
      }
    }
  }

  async function applyWindowOverridesForMultiple(floorLevelId, windowIds) {
    if (!floorplanRoot.children.length) return;
    if (!Array.isArray(windowIds) || !windowIds.length) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const windowIdSet = new Set(windowIds.map((w) => String(w).trim()));
    const meshes = [];
    floorplanRoot.traverse((o) => {
      if (!o.isMesh) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (!o.userData.floorplanWindowFill) return;
      const wid = String(o.userData.floorplanWindowId ?? "").trim();
      if (!wid || !windowIdSet.has(wid)) return;
      meshes.push(o);
    });
    if (!meshes.length) return;
    for (const mesh of meshes) {
      const wid = String(mesh.userData.floorplanWindowId ?? "").trim();
      const ov = getWindowOverride(fid, wid);
      if (ov && surfaceOverrideIsActive(ov)) {
        applySurfaceOverrideToMesh(mesh, ov, libraryBag);
      }
    }
  }

  async function applyWallFaceOverridesToScene(floorLevelId, wallFacePairs) {
    if (!floorplanRoot.children.length) return;
    if (!Array.isArray(wallFacePairs) || !wallFacePairs.length) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    for (const { wallId, faceId } of wallFacePairs) {
      const wid = String(wallId ?? "").trim();
      if (!wid) continue;
      const ov = getWallFaceOverride(fid, wid, faceId);
      if (!ov || !surfaceOverrideIsActive(ov)) continue;
      floorplanRoot.traverse((o) => {
        if (!o.isMesh) return;
        if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
        if (String(o.userData.floorplanWallId ?? "").trim() !== wid) return;
        applySurfaceOverrideToMeshFace(o, faceId, ov, libraryBag);
      });
    }
  }

  async function applyWallFaceOverridesFromMemoryToScene(libraryBag) {
    if (!floorplanRoot.children.length) return;
    const wallFaceData = state.wallFaceOverridesByStyleKey[
      normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey())
    ];
    if (!wallFaceData || typeof wallFaceData !== "object") return;
    for (const [floorLevelId, wallsData] of Object.entries(wallFaceData)) {
      if (!wallsData || typeof wallsData !== "object") continue;
      for (const [wallId, faces] of Object.entries(wallsData)) {
        if (!faces || typeof faces !== "object") continue;
        const wid = String(wallId ?? "").trim();
        if (!wid) continue;
        if (faces.face_a && surfaceOverrideIsActive(faces.face_a)) {
          floorplanRoot.traverse((o) => {
            if (!o.isMesh) return;
            if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== floorLevelId) return;
            if (String(o.userData.floorplanWallId ?? "").trim() !== wid) return;
            applySurfaceOverrideToMeshFace(o, "face_a", faces.face_a, libraryBag);
          });
        }
        if (faces.face_b && surfaceOverrideIsActive(faces.face_b)) {
          floorplanRoot.traverse((o) => {
            if (!o.isMesh) return;
            if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== floorLevelId) return;
            if (String(o.userData.floorplanWallId ?? "").trim() !== wid) return;
            applySurfaceOverrideToMeshFace(o, "face_b", faces.face_b, libraryBag);
          });
        }
      }
    }
  }

  async function applyAllOverridesToScene() {
    if (!floorplanRoot.children.length) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());

    const roomFloorsData = state.roomFloorOverridesByStyleKey[key];
    if (roomFloorsData && typeof roomFloorsData === "object") {
      for (const [floorLevelId, roomsData] of Object.entries(roomFloorsData)) {
        if (!roomsData || typeof roomsData !== "object") continue;
        for (const [roomId, override] of Object.entries(roomsData)) {
          if (!override || !surfaceOverrideIsActive(override)) continue;
          floorplanRoot.traverse((o) => {
            if (!o.isMesh) return;
            if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== floorLevelId) return;
            if (!o.userData.floorplanRoomFloor) return;
            if (String(o.userData.floorplanRoomId ?? "").trim() !== roomId) return;
            applySurfaceOverrideToMesh(o, override, libraryBag);
          });
        }
      }
    }

    const doorData = state.doorOverridesByStyleKey[key];
    if (doorData && typeof doorData === "object") {
      for (const [floorLevelId, doorsData] of Object.entries(doorData)) {
        if (!doorsData || typeof doorsData !== "object") continue;
        for (const [doorId, override] of Object.entries(doorsData)) {
          if (!override || !surfaceOverrideIsActive(override)) continue;
          floorplanRoot.traverse((o) => {
            if (!o.isMesh) return;
            if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== floorLevelId) return;
            if (!o.userData.floorplanDoorFill || o.userData.floorplanDoorHandle) return;
            if (String(o.userData.floorplanDoorId ?? "").trim() !== doorId) return;
            applySurfaceOverrideToMesh(o, override, libraryBag);
          });
        }
      }
    }

    const windowData = state.windowOverridesByStyleKey[key];
    if (windowData && typeof windowData === "object") {
      for (const [floorLevelId, windowsData] of Object.entries(windowData)) {
        if (!windowsData || typeof windowsData !== "object") continue;
        for (const [windowId, override] of Object.entries(windowsData)) {
          if (!override || !surfaceOverrideIsActive(override)) continue;
          floorplanRoot.traverse((o) => {
            if (!o.isMesh) return;
            if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== floorLevelId) return;
            if (!o.userData.floorplanWindowFill) return;
            if (String(o.userData.floorplanWindowId ?? "").trim() !== windowId) return;
            applySurfaceOverrideToMesh(o, override, libraryBag);
          });
        }
      }
    }

    await applyWallFaceOverridesFromMemoryToScene(libraryBag);
  }

  async function applySurfaceOverridesToFloorplan() {
    if (!floorplanRoot.children.length) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const overrides = getCurrentSurfaceOverridesBucket();
    const batches = new Map();
    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      const fid = String(o.userData.floorplanFloorLevelId ?? "").trim();
      if (!fid) return;
      const bag = overrides[fid];
      if (!bag) return;
      if (o.userData.floorplanRoomFloor && bag.allFloors && surfaceOverrideIsActive(bag.allFloors)) {
        const key = `${fid}\0allFloors`;
        if (!batches.has(key)) {
          batches.set(key, { ov: bag.allFloors, meshes: [], isRoomFloor: true });
        }
        batches.get(key).meshes.push(o);
      } else if (o.userData.floorplanWallId && bag.allWalls && surfaceOverrideIsActive(bag.allWalls)) {
        const key = `${fid}\0allWalls`;
        if (!batches.has(key)) {
          batches.set(key, { ov: bag.allWalls, meshes: [], isRoomFloor: false });
        }
        batches.get(key).meshes.push(o);
      } else if (
        o.userData.floorplanDoorFill &&
        !o.userData.floorplanDoorHandle &&
        bag.allDoors &&
        surfaceOverrideIsActive(bag.allDoors)
      ) {
        const key = `${fid}\0allDoors`;
        if (!batches.has(key)) {
          batches.set(key, { ov: bag.allDoors, meshes: [], isRoomFloor: false });
        }
        batches.get(key).meshes.push(o);
      } else if (o.userData.floorplanWindowFill && bag.allWindows) {
        const ovApply = windowSurfaceOverrideForApply(bag.allWindows);
        if (!ovApply || !surfaceOverrideIsActive(ovApply)) return;
        const key = `${fid}\0allWindows`;
        if (!batches.has(key)) {
          batches.set(key, { ov: ovApply, meshes: [], isRoomFloor: false });
        }
        batches.get(key).meshes.push(o);
      }
    });
    for (const { ov, meshes, isRoomFloor } of batches.values()) {
      if (!meshes.length) continue;
      const opacity0 = Number.isFinite(meshes[0].userData.floorplanSurfaceOpacity)
        ? meshes[0].userData.floorplanSurfaceOpacity
        : 1;
      const opMismatch = meshes.some(
        (m) =>
          (Number.isFinite(m.userData.floorplanSurfaceOpacity) ? m.userData.floorplanSurfaceOpacity : 1) !==
          opacity0,
      );
      if (ov.materialId && !opMismatch) {
        const built = createFloorplanSurfaceOverrideMaterialOnce(ov, libraryBag, opacity0, isRoomFloor);
        if (!built) continue;
        disposeUniqueOverrideMaterialsOnMeshes(meshes);
        for (const mesh of meshes) {
          mesh.material = built.mat;
        }
        continue;
      }
      for (const mesh of meshes) {
        applySurfaceOverrideToMesh(mesh, ov, libraryBag);
      }
    }

    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.floorplanRoomFloor) return;
      const fid = String(o.userData.floorplanFloorLevelId ?? "").trim();
      const rid = String(o.userData.floorplanRoomId ?? "").trim();
      if (!fid || !rid) return;
      const roomOv = getRoomFloorOverride(fid, rid);
      if (roomOv && surfaceOverrideIsActive(roomOv)) {
        applySurfaceOverrideToMesh(o, roomOv, libraryBag);
      }
    });

    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.floorplanDoorFill || o.userData.floorplanDoorHandle) return;
      const fid = String(o.userData.floorplanFloorLevelId ?? "").trim();
      const did = String(o.userData.floorplanDoorId ?? "").trim();
      if (!fid || !did) return;
      const doorOv = getDoorOverride(fid, did);
      if (doorOv && surfaceOverrideIsActive(doorOv)) {
        applySurfaceOverrideToMesh(o, doorOv, libraryBag);
      }
    });

    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.userData.floorplanWindowFill) return;
      const fid = String(o.userData.floorplanFloorLevelId ?? "").trim();
      const wid = String(o.userData.floorplanWindowId ?? "").trim();
      if (!fid || !wid) return;
      const winOv = getWindowOverride(fid, wid);
      if (winOv && surfaceOverrideIsActive(winOv)) {
        applySurfaceOverrideToMesh(o, winOv, libraryBag);
      }
    });

    await applyWallFaceOverridesFromMemoryToScene(libraryBag);
  }

  async function applySurfaceOverridesForFloorScope(floorLevelId, scope) {
    if (!floorplanRoot.children.length) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const overrides = getCurrentSurfaceOverridesBucket();
    const bag = overrides[fid];
    let ov = null;
    if (scope === "allWalls" && bag?.allWalls && surfaceOverrideIsActive(bag.allWalls)) ov = bag.allWalls;
    else if (scope === "allFloors" && bag?.allFloors && surfaceOverrideIsActive(bag.allFloors)) ov = bag.allFloors;
    else if (scope === "allDoors" && bag?.allDoors && surfaceOverrideIsActive(bag.allDoors)) ov = bag.allDoors;
    else if (scope === "allWindows" && bag?.allWindows) {
      const win = windowSurfaceOverrideForApply(bag.allWindows);
      if (win && surfaceOverrideIsActive(win)) ov = win;
    }
    if (!ov) return;
    const meshes = [];
    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (scope === "allWalls" && o.userData.floorplanWallId) {
        meshes.push(o);
      } else if (scope === "allFloors" && o.userData.floorplanRoomFloor) {
        meshes.push(o);
      } else if (scope === "allDoors" && o.userData.floorplanDoorFill && !o.userData.floorplanDoorHandle) {
        meshes.push(o);
      } else if (scope === "allWindows" && o.userData.floorplanWindowFill) {
        meshes.push(o);
      }
    });
    if (!meshes.length) return;
    const isRoomFloor = scope === "allFloors";
    const opacity0 = Number.isFinite(meshes[0].userData.floorplanSurfaceOpacity)
      ? meshes[0].userData.floorplanSurfaceOpacity
      : 1;
    const opMismatch = meshes.some(
      (m) =>
        (Number.isFinite(m.userData.floorplanSurfaceOpacity) ? m.userData.floorplanSurfaceOpacity : 1) !== opacity0,
    );
    if (ov.materialId && !opMismatch) {
      const built = createFloorplanSurfaceOverrideMaterialOnce(ov, libraryBag, opacity0, isRoomFloor);
      if (!built) return;
      disposeUniqueOverrideMaterialsOnMeshes(meshes);
      for (const mesh of meshes) {
        mesh.material = built.mat;
      }
      return;
    }
    for (const mesh of meshes) {
      applySurfaceOverrideToMesh(mesh, ov, libraryBag);
    }
  }

  return {
    applyAllOverridesToScene,
    applyDoorOverridesForMultiple,
    applyRoomFloorOverridesForMultiple,
    applySurfaceOverrideToMesh,
    applySurfaceOverrideToMeshFace,
    applySurfaceOverridesForFloorScope,
    applySurfaceOverridesToFloorplan,
    applyWallFaceOverridesFromMemoryToScene,
    applyWallFaceOverridesToScene,
    applyWindowOverridesForMultiple,
    mergeMaterialOverrideIntoDef,
    migrateFloorplanSurfaceOverridesBucket,
    surfaceOverrideIsActive,
    windowSurfaceOverrideForApply,
  };
}
