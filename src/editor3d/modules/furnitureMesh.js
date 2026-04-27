import * as THREE from "three";

import { GLTFLoader } from "../../../assets/vendor/GLTFLoader.js";
import { resolveModelUrl } from "../../furniture/furnitureManager.js";

function createFallbackFurnitureMaterial(color) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.55,
    metalness: 0.05,
    emissive: new THREE.Color(0x000000),
  });
}

export function createFurnitureMeshModule(ctx) {
  const {
    byId,
    applyFurnitureAppearanceToGroup,
    applyFurnitureGltfPbrMaps,
    clampDecorationLiftMForGroup,
    extractFurnitureFootprintCm,
    fitGltfToFootprint,
    furnitureRoot,
    getActiveFloorIdForFurniture,
    hasFurnitureMaterialConfig,
    markShadowCacheDirty,
    normalizeFurnitureSelection,
    registerFurnitureMeshes,
    setFurnitureFromLayoutCm,
  } = ctx;

  async function createFurnitureMesh(furnitureId) {
    const item = byId.get(furnitureId);
    const fp = extractFurnitureFootprintCm(item);
    const w = fp.w / 100;
    const d = fp.d / 100;
    const h = fp.h / 100;
    const g = new THREE.Group();
    g.userData.modelType = furnitureId;
    const modelPath = item?.model != null ? String(item.model).trim() : "";
    if (modelPath) {
      try {
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(resolveModelUrl(modelPath));
        const root = gltf.scene;
        fitGltfToFootprint(root, w, h, d);
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = false;
        });
        g.add(root);
        g.userData.gltfRoot = root;
        if (hasFurnitureMaterialConfig(item)) {
          g.userData.furnitureSelection = normalizeFurnitureSelection(item, null);
          await applyFurnitureGltfPbrMaps(THREE, root, item, g.userData.furnitureSelection);
          applyFurnitureAppearanceToGroup(THREE, g, item);
        }
        return g;
      } catch (err) {
        console.warn("[VisionHome] 家具模型加载失败:", furnitureId, err);
      }
    }
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = createFallbackFurnitureMaterial(0x8c7cff);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.position.y = h / 2;
    g.add(mesh);
    if (hasFurnitureMaterialConfig(item)) {
      g.userData.furnitureSelection = normalizeFurnitureSelection(item, null);
      applyFurnitureAppearanceToGroup(THREE, g, item);
    }
    return g;
  }

  /** 属性面板切换材质/面料/颜色后：重新套 PBR 贴图（GLB）并应用 hex/粗糙度 */
  async function refreshFurnitureVisualForConfig(group, item) {
    if (!group || !item || !hasFurnitureMaterialConfig(item)) return;
    const root = group.userData.gltfRoot;
    if (root) {
      await applyFurnitureGltfPbrMaps(THREE, root, item, group.userData.furnitureSelection);
    }
    applyFurnitureAppearanceToGroup(THREE, group, item);
  }

  async function appendFurnitureItem(modelId, xCm, yCm, rotationDeg = 0, floorId = null, opts = {}) {
    if (!byId.has(modelId)) return null;
    const item = byId.get(modelId);
    const fp = extractFurnitureFootprintCm(item);
    const group = await createFurnitureMesh(modelId);
    group.userData.isFurniture = true;
    group.userData.footprint = { hw: fp.hw, hh: fp.hh, h: fp.h };
    group.userData.floorId = String(floorId ?? getActiveFloorIdForFurniture()).trim() || "floor1";
    let rot = Math.round(Number(rotationDeg) || 0) % 360;
    if (rot < 0) rot += 360;
    group.userData.rotDeg = rot;
    setFurnitureFromLayoutCm(group, xCm, yCm, rot, opts);
    const cm = opts.decorationLiftCm != null ? Number(opts.decorationLiftCm) : 0;
    const liftM = Number.isFinite(cm) ? cm / 100 : 0;
    group.userData.decorationLiftM = clampDecorationLiftMForGroup(group, liftM);
    furnitureRoot.add(group);
    registerFurnitureMeshes(group);
    markShadowCacheDirty();
    return group;
  }

  return {
    appendFurnitureItem,
    createFurnitureMesh,
    refreshFurnitureVisualForConfig,
  };
}
