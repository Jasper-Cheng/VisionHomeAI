/**
 * 编辑模式 Three.js：户型挤出 + 家具交互，并暴露 window.layoutEditor* API
 */
import * as THREE from "three";
import { OrbitControls } from "../../assets/vendor/OrbitControls.js";
import {
  loadStyleConfig,
  loadStylePackIndex,
  getDefaultStyleKeyForFloorplan,
  resolveDefaultStyleKeyFromPack,
  clearStyleConfigCache,
  getMaterialDef,
  resolveStyleTextureUrl,
  resolveWallMaterialKey,
  resolveRoomFloorMaterialKey,
  resolveRoomWallMaterialKey,
  resolveDoorMaterialKey,
  resolveWindowMaterialKey,
  findWallSideRoomsAt,
  loadMaterialsLibrary,
  resolveMaterialDefFromLibrary,
  decorationPlacementsToLayoutRows,
} from "../floorplan/floorplanStyle.js";
import { getFurnitureDisplayName, getFurnitureTags } from "../furniture/furnitureManager.js";
import {
  applyFurnitureAppearanceToGroup,
  applyFurnitureGltfPbrMaps,
  formatSkuMarkupLabel,
  hasFurnitureMaterialConfig,
  normalizeFurnitureSelection,
  resolveFurnitureSelectionDetail,
  resolveTextureAssetUrl,
} from "../furniture/furnitureConfig.js";
import { RoomEnvironment } from "../../assets/vendor/RoomEnvironment.js";
import { mountFloorplanColorPicker } from "../ui/floorplanColorPicker.js";
import { DATA_PATHS } from "../core/schema.js";
import { createAnnotations } from "./modules/annotations.js";
import { createBomPanel } from "./modules/bomPanel.js";
import { createFloorplanCore } from "./modules/floorplanCore.js?v=doorframe6";
import { createFurnitureMeshModule } from "./modules/furnitureMesh.js";
import { createHistoryModule } from "./modules/history.js";
import { createMaterialFactory } from "./modules/materialFactory.js";
import { createMeshBuilder } from "./modules/meshBuilder.js?v=doorframe6";
import { createProjectIoModule } from "./modules/projectIo.js";
import { createRenderLoop } from "./modules/renderLoop.js?v=doorframe6";
import { createStylePackTools } from "./modules/stylePackTools.js";
import { createSurfaceOverrideModule } from "./modules/surfaceOverride.js";
import { createToolbarInit } from "./modules/toolbarInit.js";
import { createWallMeshBuilder } from "./modules/wallMeshBuilder.js";
import { DEFAULT_SCENE_LIGHTING, applySceneLightingConfig, mergeSceneLighting } from "./utils/lightingUtils.js";
import {
  FLOOR_SURFACE_Y_M,
  GRID,
  VIEW_H,
  VIEW_W,
  canvasCmToSceneXZ,
  centeredCmToSceneXZ,
  centeredToCanvasCm,
  clampFurnitureCentered,
  closestPointOnSegment2D,
  computeFloorplanCanvasPlacement,
  extractFurnitureFootprintCm,
  fitGltfToFootprint,
  furnitureWallSnapSamplePointsCm,
  getCurrentFloorFromEntry,
  getEntryBBoxCm,
  getFloorsFromEntry,
  normalizeFloorIndex,
  normalizeFloorKey,
  sceneXZToCenteredCm,
  snap,
} from "./utils/coordUtils.js";

const MAX_HISTORY = 80;
/** 户型墙/地/顶面：略偏灰，避免与 IBL 叠加后发白糊成一片 */
const FLOORPLAN_SURFACE_COLOR = 0xc9c4be;
const WALL_HOLE_EPS = 1e-5;

/**
 * @typedef {object} SurfaceScopeOverride
 * @property {string} [color] 覆盖库材质 `color`（与 roughness 等一并并入 mergeMaterialOverrideIntoDef）
 * @property {string} [materialId]
 * @property {boolean} [materialPresetCleared] 用户点击「清除」后不再使用库材质预设（与未设置 materialId 区分，避免同步时回退到风格包默认）
 * @property {string} [textureAlbedo] 仅覆盖库材质 `texture.albedo` 的文件名（如 `wood_floor_diff.jpg`）或 `textures/...` 路径
 * @property {number} [roughness]
 * @property {number} [metalness]
 * @property {number} [opacity] 库材质「不透明度」乘子（0–1，与玻璃材质定义中的 opacity 一致）
 * @property {number} [transmission]
 * @property {number} [ior]
 * @property {[number, number]} [uvScale]
 * @property {number} [textureRotation]
 */

export function initThreeEditor(catalog = { items: [], byId: new Map() }) {
  const container = document.getElementById("threeEditorViewport");
  if (!container) {
    const r = { ok: false, reason: "missing-threeEditorViewport" };
    window.__visionHomeLayoutEditor = r;
    return r;
  }
  const byId = catalog.byId instanceof Map ? catalog.byId : new Map();
  const canvasWrap = container.closest(".layout-editor-canvas-wrap") ?? container.parentElement;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d0d);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  // Default view: 正前上方 60 度（相机始终看向原点，且 x=0）
  // 保持与旧默认视角相同的 target->camera 距离，避免缩放/视图变换取值抖动。
  const CAMERA_DEFAULT_TARGET_DISTANCE = Math.sqrt(12 * 12 + 14 * 14 + 18 * 18);
  const CAMERA_DEFAULT_ELEVATION_RAD = (60 * Math.PI) / 180; // elevation above horizontal
  const CAMERA_DEFAULT_Y = CAMERA_DEFAULT_TARGET_DISTANCE * Math.sin(CAMERA_DEFAULT_ELEVATION_RAD);
  const CAMERA_DEFAULT_Z = CAMERA_DEFAULT_TARGET_DISTANCE * Math.cos(CAMERA_DEFAULT_ELEVATION_RAD);
  camera.position.set(0, CAMERA_DEFAULT_Y, CAMERA_DEFAULT_Z);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    // 大场景深度精度更好，减轻近共面/阴影条纹带来的“花屏”感
    logarithmicDepthBuffer: true,
  });
  /**
   * 渲染质量：
   * - standard: 性能优先（较低 DPR 上限）
   * - high: 画质优先
   * - ultra: 更高分辨率，显著增加 GPU 开销
   */
  const RENDER_QUALITY_CONFIGS = {
    standard: {
      pixelRatioScale: 0.65,
      pixelRatioCap: 1.0,
      label: "标准",
      shadowMapSize: 512,
      shadowRadius: 0,
      shadowType: THREE.BasicShadowMap,
      anisotropy: 1,
    },
    high: {
      pixelRatioScale: 1.15,
      pixelRatioCap: 1.8,
      label: "高精度",
      shadowMapSize: 2048,
      shadowRadius: 3,
      shadowType: THREE.PCFSoftShadowMap,
      anisotropy: 8,
    },
    ultra: {
      pixelRatioScale: 2.2,
      pixelRatioCap: 3.5,
      label: "超清",
      shadowMapSize: 4096,
      shadowRadius: 5,
      shadowType: THREE.PCFSoftShadowMap,
      anisotropy: 16,
    },
  };
  /** @type {"standard" | "high" | "ultra"} */
  let renderQualityMode = "standard";
  function applyRendererPixelRatio() {
    const cfg = RENDER_QUALITY_CONFIGS[renderQualityMode] || RENDER_QUALITY_CONFIGS.standard;
    const baseDpr = Math.max(1, Number(window.devicePixelRatio || 1));
    const scaled = baseDpr * (Number(cfg.pixelRatioScale) || 1);
    const nextPixelRatio = Math.max(0.5, Math.min(scaled, Number(cfg.pixelRatioCap) || 2));
    renderer.setPixelRatio(nextPixelRatio);
  }
  function applyRendererQualityDetails() {
    const cfg = RENDER_QUALITY_CONFIGS[renderQualityMode] || RENDER_QUALITY_CONFIGS.standard;
    renderer.shadowMap.type = cfg.shadowType;
    dirLight.shadow.radius = cfg.shadowRadius;
    const prevSize = dirLight.shadow.mapSize.x;
    if (prevSize !== cfg.shadowMapSize) {
      dirLight.shadow.mapSize.set(cfg.shadowMapSize, cfg.shadowMapSize);
      if (dirLight.shadow.map) {
        dirLight.shadow.map.dispose();
        dirLight.shadow.map = null;
      }
    }
    dirLight.shadow.needsUpdate = true;

    const maxSupported = Number(renderer.capabilities.getMaxAnisotropy?.() || 1);
    const targetAnisotropy = Math.max(1, Math.min(maxSupported, cfg.anisotropy));
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        if (!mat || typeof mat !== "object") continue;
        for (const key of [
          "map",
          "normalMap",
          "roughnessMap",
          "metalnessMap",
          "aoMap",
          "alphaMap",
          "emissiveMap",
          "bumpMap",
        ]) {
          const tex = mat[key];
          if (!tex || typeof tex !== "object") continue;
          if (tex.anisotropy !== targetAnisotropy) {
            tex.anisotropy = targetAnisotropy;
            tex.needsUpdate = true;
          }
        }
      }
    });
  }
  applyRendererPixelRatio();
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = DEFAULT_SCENE_LIGHTING.toneMappingExposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  /** IBL：室内环境贴图，提升 MeshStandard / PBR 漫反射与高光填充，减轻“发灰发黑” */
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment(renderer);
  /* fromScene 第二参为模糊半径（弧度）；过大时 PMREM 内部高斯核采样数会超过 MAX_SAMPLES(20) 并 console.warn */
  const envRt = pmremGenerator.fromScene(roomEnvironment, 0.04);
  roomEnvironment.dispose();
  scene.environment = envRt.texture;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // 交互约定：按住滚轮（中键）拖动执行平移
  controls.enablePan = true;
  controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
  controls.target.set(0, 0, 0);
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 2;
  controls.maxDistance = 120;
  controls.update();

  const grid = new THREE.GridHelper(80, 80, 0x3b3b3b, 0x222222);
  grid.position.y = 0.001;
  scene.add(grid);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1);
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(14, 24, 16);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = 0.00015;
  dirLight.shadow.normalBias = 0.045;
  dirLight.shadow.radius = 3;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 500;
  dirLight.shadow.camera.left = -40;
  dirLight.shadow.camera.right = 40;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  dirLight.shadow.camera.updateProjectionMatrix();
  applyRendererQualityDetails();
  dirLight.target.position.set(0, 0, 0);
  scene.add(ambientLight);
  scene.add(hemiLight);
  scene.add(dirLight.target);
  scene.add(dirLight);

  const initialSceneLighting = mergeSceneLighting(null);
  applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, initialSceneLighting);
  let sceneLightingEnvMapIntensity = initialSceneLighting.envMapIntensity;

  /** 户型半透明分层渲染：深度预写入（与 applyFloorplanSurfaceAlpha 的 polygonOffset 对齐） */
  const floorplanDepthPrepassMat = new THREE.MeshDepthMaterial({
    depthPacking: renderer.capabilities.logarithmicDepthBuffer ? THREE.RGBADepthPacking : THREE.BasicDepthPacking,
  });
  floorplanDepthPrepassMat.colorWrite = false;
  floorplanDepthPrepassMat.polygonOffset = true;
  floorplanDepthPrepassMat.polygonOffsetFactor = 1;
  floorplanDepthPrepassMat.polygonOffsetUnits = 1;

  /** 方向光阴影开关（与工具栏「光影」同步） */
  let shadowsEnabled = true;

  /** 阴影拟合缓存：场景物体变化时标记为脏 */
  let shadowCacheDirty = true;
  const shadowCachedBbox = new THREE.Box3();

  const floorplanRoot = new THREE.Group();
  scene.add(floorplanRoot);
  const furnitureRoot = new THREE.Group();
  scene.add(furnitureRoot);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const placementPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const tmpVecA = new THREE.Vector3();
  const tmpVecB = new THREE.Vector3();
  const tmpVecC = new THREE.Vector3();
  const shadowFitCam = new THREE.Camera();
  const shadowCorner = new THREE.Vector3();
  const shadowSceneBbox = new THREE.Box3();

  /** 将方向光正交阴影范围收紧到户型+家具包围盒（光照空间），避免 ±80m 浪费 texel 导致边缘锯齿 */
  function fitDirectionalShadowFrustum() {
    if (!shadowsEnabled) return;

    // 缓存：只在场景物体变化时重算包围盒
    if (shadowCacheDirty) {
      shadowCachedBbox.makeEmpty();
      if (floorplanRoot.children.length) shadowCachedBbox.expandByObject(floorplanRoot);
      if (furnitureRoot.children.length) {
        const b2 = new THREE.Box3().setFromObject(furnitureRoot);
        if (shadowCachedBbox.isEmpty()) shadowCachedBbox.copy(b2);
        else shadowCachedBbox.union(b2);
      }
      shadowCacheDirty = false;
    }

    if (shadowCachedBbox.isEmpty()) return;
    shadowSceneBbox.copy(shadowCachedBbox);

    const cam = dirLight.shadow.camera;
    shadowFitCam.position.copy(dirLight.position);
    shadowFitCam.lookAt(dirLight.target.position);
    shadowFitCam.updateMatrixWorld(true);
    const viewMat = shadowFitCam.matrixWorldInverse;

    const min = shadowSceneBbox.min;
    const max = shadowSceneBbox.max;
    const ax = [min.x, max.x];
    const ay = [min.y, max.y];
    const az = [min.z, max.z];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        for (let k = 0; k < 2; k++) {
          shadowCorner.set(ax[i], ay[j], az[k]);
          shadowCorner.applyMatrix4(viewMat);
          minX = Math.min(minX, shadowCorner.x);
          maxX = Math.max(maxX, shadowCorner.x);
          minY = Math.min(minY, shadowCorner.y);
          maxY = Math.max(maxY, shadowCorner.y);
          minZ = Math.min(minZ, shadowCorner.z);
          maxZ = Math.max(maxZ, shadowCorner.z);
        }
      }
    }

    const marginXY = 2.5;
    const marginZ = 6;
    const minSpan = 6;
    let spanX = maxX - minX;
    let spanY = maxY - minY;
    if (spanX < minSpan) {
      const cx = (minX + maxX) * 0.5;
      minX = cx - minSpan * 0.5;
      maxX = cx + minSpan * 0.5;
    }
    if (spanY < minSpan) {
      const cy = (minY + maxY) * 0.5;
      minY = cy - minSpan * 0.5;
      maxY = cy + minSpan * 0.5;
    }

    cam.left = minX - marginXY;
    cam.right = maxX + marginXY;
    cam.bottom = minY - marginXY;
    cam.top = maxY + marginXY;
    cam.near = Math.max(0.1, -maxZ - marginZ);
    cam.far = Math.max(cam.near + 1, -minZ + marginZ);
    cam.updateProjectionMatrix();
  }

  const interactiveMeshes = [];
  const activeFloorPickMeshes = [];

  let currentFloorplanEntry = null;
  /** 覆盖户型 JSON 的 styleKey；null 表示使用 entry.styleKey */
  let floorplanStyleKeyOverride = null;
  /** 最近一次成功应用到场景的风格包单套风格（用于「覆盖 / 新建」写回 JSON） */
  let lastMergedFloorplanStyle = null;
  let currentFloorIndex = 0;
  let floorSelectionEnabled = true;
  let activeFloorId = null;
  let selectedGroup = null;
  let floorplanSelected = false;
  /** @type {{ kind: "allWalls" | "allFloors" | "allDoors" | "allWindows", floorLevelId: string } | null} */
  let selectedFloorplanSurface = null;

  /** @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} kind */
  function floorplanSurfaceScopeFromKind(kind) {
    if (kind === "allFloors") return "allFloors";
    if (kind === "allDoors") return "allDoors";
    if (kind === "allWindows") return "allWindows";
    return "allWalls";
  }
  /**
   * 按风格键 + 楼层 id 记录**整层**墙/地/门窗材质覆盖（与风格包材质叠加）
   * 需求：切换风格时，不应沿用其它风格下的覆盖。
   * @type {Record<string, Record<string, { allWalls?: SurfaceScopeOverride, allFloors?: SurfaceScopeOverride, allDoors?: SurfaceScopeOverride, allWindows?: SurfaceScopeOverride }>>}
   */
  let floorplanSurfaceOverridesByStyleKey = {};

  function normalizeStyleKeyForSurfaceOverrides(styleKey) {
    const k = styleKey != null ? String(styleKey).trim() : "";
    return k || "__default__";
  }

  /**
   * @param {string | null | undefined} styleKey
   * @param {{ create?: boolean }} [opts]
   */
  function getSurfaceOverridesBucketForStyle(styleKey, opts = {}) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const create = Boolean(opts.create);
    const hit = floorplanSurfaceOverridesByStyleKey[key];
    if (hit && typeof hit === "object") return hit;
    if (!create) return {};
    const next = {};
    floorplanSurfaceOverridesByStyleKey[key] = next;
    return next;
  }

  function getCurrentSurfaceOverridesBucket() {
    return getSurfaceOverridesBucketForStyle(getEffectiveFloorplanStyleKey(), { create: true });
  }

  function clearSurfaceOverridesForStyle(styleKey) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    if (floorplanSurfaceOverridesByStyleKey && typeof floorplanSurfaceOverridesByStyleKey === "object") {
      delete floorplanSurfaceOverridesByStyleKey[key];
    }
  }

  // --- 多选房间地板 ---
  /** @type {Set<string>} 当前选中的房间地板 ID 集合 */
  let selectedRoomFloorIds = new Set();

  function toggleRoomFloorSelection(roomId) {
    if (!roomId) return;
    const id = String(roomId).trim();
    if (selectedRoomFloorIds.has(id)) {
      selectedRoomFloorIds.delete(id);
    } else {
      selectedRoomFloorIds.add(id);
    }
  }

  function clearRoomFloorSelection() {
    selectedRoomFloorIds.clear();
  }

  function isRoomFloorSelected(roomId) {
    return selectedRoomFloorIds.has(String(roomId).trim());
  }

  function getSelectedRoomFloorIds() {
    return [...selectedRoomFloorIds];
  }

  // --- 多选门 ---
  /** @type {Set<string>} 当前选中的门 ID 集合 */
  let selectedDoorIds = new Set();

  function toggleDoorSelection(doorId) {
    if (!doorId) return;
    const id = String(doorId).trim();
    if (selectedDoorIds.has(id)) {
      selectedDoorIds.delete(id);
    } else {
      selectedDoorIds.add(id);
    }
  }

  function clearDoorSelection() {
    selectedDoorIds.clear();
  }

  function isDoorSelected(doorId) {
    return selectedDoorIds.has(String(doorId).trim());
  }

  function getSelectedDoorIds() {
    return [...selectedDoorIds];
  }

  // --- 按房间地板覆盖（内存） ---
  // 格式: { [styleKey]: { [floorLevelId]: { [roomId]: { color, materialId, roughness, metalness, uvScale, textureRotation, textureAlbedo } } } }
  let roomFloorOverridesByStyleKey = {};

  function getRoomFloorOverridesBucket(styleKey, opts = {}) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const create = Boolean(opts.create);
    const hit = roomFloorOverridesByStyleKey[key];
    if (hit && typeof hit === "object") return hit;
    if (!create) return {};
    const next = {};
    roomFloorOverridesByStyleKey[key] = next;
    return next;
  }

  function getCurrentRoomFloorOverridesBucket() {
    return getRoomFloorOverridesBucket(getEffectiveFloorplanStyleKey(), { create: true });
  }

  /**
   * @param {string} floorLevelId
   * @param {string} roomId
   * @returns {object | null}
   */
  function getRoomFloorOverride(floorLevelId, roomId) {
    const fid = String(floorLevelId ?? "").trim();
    const rid = String(roomId ?? "").trim();
    if (!fid || !rid) return null;
    const bucket = getCurrentRoomFloorOverridesBucket();
    const floorBag = bucket[fid];
    if (!floorBag) return null;
    return floorBag[rid] ?? null;
  }

  /**
   * @param {string} floorLevelId
   * @param {string} roomId
   * @param {object | null} override
   */
  function setRoomFloorOverride(floorLevelId, roomId, override) {
    const fid = String(floorLevelId ?? "").trim();
    const rid = String(roomId ?? "").trim();
    if (!fid || !rid) return;
    const bucket = getCurrentRoomFloorOverridesBucket();
    if (!bucket[fid]) bucket[fid] = {};
    if (override && typeof override === "object" && Object.keys(override).length > 0) {
      bucket[fid][rid] = { ...override };
    } else {
      delete bucket[fid][rid];
    }
  }

  /**
   * 批量设置多个房间的地板覆盖
   * @param {string} floorLevelId
   * @param {string[]} roomIds
   * @param {object} override
   */
  function setRoomFloorOverridesForMultiple(floorLevelId, roomIds, override) {
    if (!Array.isArray(roomIds)) return;
    for (const rid of roomIds) {
      setRoomFloorOverride(floorLevelId, rid, override);
    }
  }

  /**
   * 将材质覆盖同步到当前活跃方案对象，保持与保存文件使用的 surfaceOverridesByStyleKey schema 一致。
   * @param {"roomFloors" | "doorOverrides" | "windowOverrides" | "wallFaceOverrides"} nestedKey
   * @param {object} payload
   */
  function syncNestedSurfaceOverridesToActiveDesignProject(nestedKey, payload) {
    const proj = window.__activeDesignProject;
    if (!proj || typeof proj !== "object") return;
    if (!proj.layoutEditor || typeof proj.layoutEditor !== "object") proj.layoutEditor = {};
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
    if (!proj.layoutEditor.surfaceOverridesByStyleKey || typeof proj.layoutEditor.surfaceOverridesByStyleKey !== "object") {
      proj.layoutEditor.surfaceOverridesByStyleKey = {};
    }
    if (!proj.layoutEditor.surfaceOverridesByStyleKey[key] || typeof proj.layoutEditor.surfaceOverridesByStyleKey[key] !== "object") {
      proj.layoutEditor.surfaceOverridesByStyleKey[key] = {};
    }
    proj.layoutEditor.surfaceOverridesByStyleKey[key][nestedKey] = JSON.parse(JSON.stringify(payload || {}));
  }

  /**
   * 同步房间地板覆盖到当前活跃 Design JSON（修改地板时调用）
   */
  function syncRoomFloorOverridesToDesignJson() {
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
    syncNestedSurfaceOverridesToActiveDesignProject("roomFloors", roomFloorOverridesByStyleKey[key] || {});
  }

  /**
   * 从 Design JSON 加载房间地板覆盖（加载项目时调用）
   * @param {object} designSurfaceOverrides - layoutEditor.surfaceOverridesByStyleKey 中当前风格的覆盖桶
   */
  function loadRoomFloorOverridesFromDesignJson(designSurfaceOverrides) {
    if (!designSurfaceOverrides || typeof designSurfaceOverrides !== "object") return;
    const sk = getEffectiveFloorplanStyleKey();
    const key = normalizeStyleKeyForSurfaceOverrides(sk);
    const styleBag = designSurfaceOverrides[key];
    if (!styleBag || typeof styleBag !== "object") return;
    const roomFloors = styleBag.roomFloors;
    if (!roomFloors || typeof roomFloors !== "object") return;
    // roomFloors 格式: { [floorLevelId]: { [roomId]: override } }
    roomFloorOverridesByStyleKey[key] = JSON.parse(JSON.stringify(roomFloors));
  }

  // --- 按门覆盖（内存） ---
  // 格式: { [styleKey]: { [floorLevelId]: { [doorId]: { color, materialId, roughness, metalness, opacity, transmission, ior } } } }
  let doorOverridesByStyleKey = {};

  function getDoorOverridesBucket(styleKey, opts = {}) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const create = Boolean(opts.create);
    const hit = doorOverridesByStyleKey[key];
    if (hit && typeof hit === "object") return hit;
    if (!create) return {};
    const next = {};
    doorOverridesByStyleKey[key] = next;
    return next;
  }

  function getCurrentDoorOverridesBucket() {
    return getDoorOverridesBucket(getEffectiveFloorplanStyleKey(), { create: true });
  }

  /**
   * @param {string} floorLevelId
   * @param {string} doorId
   * @returns {object | null}
   */
  function getDoorOverride(floorLevelId, doorId) {
    const fid = String(floorLevelId ?? "").trim();
    const did = String(doorId ?? "").trim();
    if (!fid || !did) return null;
    const bucket = getCurrentDoorOverridesBucket();
    const floorBag = bucket[fid];
    if (!floorBag) return null;
    return floorBag[did] ?? null;
  }

  /**
   * @param {string} floorLevelId
   * @param {string} doorId
   * @param {object | null} override
   */
  function setDoorOverride(floorLevelId, doorId, override) {
    const fid = String(floorLevelId ?? "").trim();
    const did = String(doorId ?? "").trim();
    if (!fid || !did) return;
    const bucket = getCurrentDoorOverridesBucket();
    if (!bucket[fid]) bucket[fid] = {};
    if (!override || (typeof override === "object" && Object.keys(override).length === 0)) {
      delete bucket[fid][did];
      if (Object.keys(bucket[fid]).length === 0) delete bucket[fid];
    } else {
      bucket[fid][did] = JSON.parse(JSON.stringify(override));
    }
  }

  /**
   * 对多个门应用覆盖（不重建几何体）
   * @param {string} floorLevelId
   * @param {string[]} doorIds
   * @param {object} override
   */
  function setDoorOverridesForMultiple(floorLevelId, doorIds, override) {
    if (!Array.isArray(doorIds)) return;
    for (const did of doorIds) {
      setDoorOverride(floorLevelId, did, override);
    }
  }

  /**
   * 同步门覆盖到当前活跃 Design JSON（修改门时调用）
   */
  function syncDoorOverridesToDesignJson() {
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
    syncNestedSurfaceOverridesToActiveDesignProject("doorOverrides", doorOverridesByStyleKey[key] || {});
  }

  /**
   * 从 Design JSON 加载门覆盖（加载项目时调用）
   */
  function loadDoorOverridesFromDesignJson(designSurfaceOverrides) {
    if (!designSurfaceOverrides || typeof designSurfaceOverrides !== "object") return;
    const sk = getEffectiveFloorplanStyleKey();
    const key = normalizeStyleKeyForSurfaceOverrides(sk);
    const styleBag = designSurfaceOverrides[key];
    if (!styleBag || typeof styleBag !== "object") return;
    const doorOverrides = styleBag.doorOverrides;
    if (!doorOverrides || typeof doorOverrides !== "object") return;
    doorOverridesByStyleKey[key] = JSON.parse(JSON.stringify(doorOverrides));
  }

  // --- 多选窗户 ---
  /** @type {Set<string>} 当前选中的窗户 ID 集合 */
  let selectedWindowIds = new Set();

  function toggleWindowSelection(windowId) {
    if (!windowId) return;
    const id = String(windowId).trim();
    if (selectedWindowIds.has(id)) {
      selectedWindowIds.delete(id);
    } else {
      selectedWindowIds.add(id);
    }
  }

  function clearWindowSelection() {
    selectedWindowIds.clear();
  }

  function isWindowSelected(windowId) {
    return selectedWindowIds.has(String(windowId).trim());
  }

  function getSelectedWindowIds() {
    return [...selectedWindowIds];
  }

  // --- 按窗户覆盖（内存） ---
  // 格式: { [styleKey]: { [floorLevelId]: { [windowId]: { color, roughness, metalness, opacity, transmission, ior } } } }
  let windowOverridesByStyleKey = {};

  function getWindowOverridesBucket(styleKey, opts = {}) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const create = Boolean(opts.create);
    const hit = windowOverridesByStyleKey[key];
    if (hit && typeof hit === "object") return hit;
    if (!create) return {};
    const next = {};
    windowOverridesByStyleKey[key] = next;
    return next;
  }

  function getCurrentWindowOverridesBucket() {
    return getWindowOverridesBucket(getEffectiveFloorplanStyleKey(), { create: true });
  }

  /**
   * @param {string} floorLevelId
   * @param {string} windowId
   * @returns {object | null}
   */
  function getWindowOverride(floorLevelId, windowId) {
    const fid = String(floorLevelId ?? "").trim();
    const wid = String(windowId ?? "").trim();
    if (!fid || !wid) return null;
    const bucket = getCurrentWindowOverridesBucket();
    const floorBag = bucket[fid];
    if (!floorBag) return null;
    return floorBag[wid] ?? null;
  }

  /**
   * @param {string} floorLevelId
   * @param {string} windowId
   * @param {object | null} override
   */
  function setWindowOverride(floorLevelId, windowId, override) {
    const fid = String(floorLevelId ?? "").trim();
    const wid = String(windowId ?? "").trim();
    if (!fid || !wid) return;
    const bucket = getCurrentWindowOverridesBucket();
    if (!bucket[fid]) bucket[fid] = {};
    if (!override || (typeof override === "object" && Object.keys(override).length === 0)) {
      delete bucket[fid][wid];
      if (Object.keys(bucket[fid]).length === 0) delete bucket[fid];
    } else {
      bucket[fid][wid] = JSON.parse(JSON.stringify(override));
    }
  }

  /**
   * 对多个窗户应用覆盖（不重建几何体）
   * @param {string} floorLevelId
   * @param {string[]} windowIds
   * @param {object} override
   */
  function setWindowOverridesForMultiple(floorLevelId, windowIds, override) {
    if (!Array.isArray(windowIds)) return;
    for (const wid of windowIds) {
      setWindowOverride(floorLevelId, wid, override);
    }
  }

  /**
   * 同步窗户覆盖到当前活跃 Design JSON（修改窗户时调用）
   */
  function syncWindowOverridesToDesignJson() {
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
    syncNestedSurfaceOverridesToActiveDesignProject("windowOverrides", windowOverridesByStyleKey[key] || {});
  }

  /**
   * 从 Design JSON 加载窗户覆盖（加载项目时调用）
   */
  function loadWindowOverridesFromDesignJson(designSurfaceOverrides) {
    if (!designSurfaceOverrides || typeof designSurfaceOverrides !== "object") return;
    const sk = getEffectiveFloorplanStyleKey();
    const key = normalizeStyleKeyForSurfaceOverrides(sk);
    const styleBag = designSurfaceOverrides[key];
    if (!styleBag || typeof styleBag !== "object") return;
    const windowOverrides = styleBag.windowOverrides;
    if (!windowOverrides || typeof windowOverrides !== "object") return;
    windowOverridesByStyleKey[key] = JSON.parse(JSON.stringify(windowOverrides));
  }

  // --- 多选墙面 ---
  /**
   * 当前选中的墙面集合，key 格式为 "wallId::faceId"（如 "w_ext_left_n::face_a"）
   * faceId 为 null 时 key 为 "wallId::null"（整段，两面都选）
   * @type {Set<string>}
   */
  let selectedWallFaceIds = new Set();

  function makeWallFaceKey(wallId, faceId) {
    return `${String(wallId ?? "").trim()}::${faceId ?? "null"}`;
  }

  function toggleWallFaceSelection(wallId, faceId) {
    if (!wallId) return;
    const key = makeWallFaceKey(wallId, faceId);
    if (selectedWallFaceIds.has(key)) {
      selectedWallFaceIds.delete(key);
    } else {
      selectedWallFaceIds.add(key);
    }
  }

  function clearWallFaceSelection() {
    selectedWallFaceIds.clear();
  }

  function isWallFaceSelected(wallId, faceId) {
    return selectedWallFaceIds.has(makeWallFaceKey(wallId, faceId));
  }

  /** @returns {{ wallId: string, faceId: string | null }[]} */
  function getSelectedWallFaces() {
    return [...selectedWallFaceIds].map((key) => {
      const idx = key.lastIndexOf("::");
      const wallId = key.slice(0, idx);
      const faceIdRaw = key.slice(idx + 2);
      return { wallId, faceId: faceIdRaw === "null" ? null : faceIdRaw };
    });
  }

  // --- 按墙面覆盖（内存） ---
  // 格式: { [styleKey]: { [floorLevelId]: { [wallId]: { face_a?: SurfaceScopeOverride, face_b?: SurfaceScopeOverride } } } }
  // face_a 对应 Box materialIndex 4 (+Z 面)，face_b 对应 materialIndex 5 (-Z 面)
  let wallFaceOverridesByStyleKey = {};

  function getWallFaceOverridesBucket(styleKey, opts = {}) {
    const key = normalizeStyleKeyForSurfaceOverrides(styleKey);
    const create = Boolean(opts.create);
    const hit = wallFaceOverridesByStyleKey[key];
    if (hit && typeof hit === "object") return hit;
    if (!create) return {};
    const next = {};
    wallFaceOverridesByStyleKey[key] = next;
    return next;
  }

  function getCurrentWallFaceOverridesBucket() {
    return getWallFaceOverridesBucket(getEffectiveFloorplanStyleKey(), { create: true });
  }

  /**
   * @param {string} floorLevelId
   * @param {string} wallId
   * @param {string | null} faceId - "face_a" | "face_b" | null
   * @returns {object | null}
   */
  function getWallFaceOverride(floorLevelId, wallId, faceId) {
    const fid = String(floorLevelId ?? "").trim();
    const wid = String(wallId ?? "").trim();
    if (!fid || !wid) return null;
    const bucket = getCurrentWallFaceOverridesBucket();
    const floorBag = bucket[fid];
    if (!floorBag) return null;
    const wallBag = floorBag[wid];
    if (!wallBag) return null;
    if (faceId === null) {
      // 整段：优先返回 face_a（两面相同）
      return wallBag.face_a ?? wallBag.face_b ?? null;
    }
    return wallBag[faceId] ?? null;
  }

  /**
   * @param {string} floorLevelId
   * @param {string} wallId
   * @param {string | null} faceId
   * @param {object | null} override
   */
  function setWallFaceOverride(floorLevelId, wallId, faceId, override) {
    const fid = String(floorLevelId ?? "").trim();
    const wid = String(wallId ?? "").trim();
    if (!fid || !wid) return;
    const bucket = getCurrentWallFaceOverridesBucket();
    if (!bucket[fid]) bucket[fid] = {};
    if (!bucket[fid][wid]) bucket[fid][wid] = {};
    const hasData = override && typeof override === "object" && Object.keys(override).length > 0;
    if (faceId === null) {
      // 整段：同时写两面
      if (hasData) {
        bucket[fid][wid].face_a = JSON.parse(JSON.stringify(override));
        bucket[fid][wid].face_b = JSON.parse(JSON.stringify(override));
      } else {
        delete bucket[fid][wid].face_a;
        delete bucket[fid][wid].face_b;
      }
    } else {
      if (hasData) {
        bucket[fid][wid][faceId] = JSON.parse(JSON.stringify(override));
      } else {
        delete bucket[fid][wid][faceId];
      }
    }
    // 清理空对象
    if (Object.keys(bucket[fid][wid]).length === 0) delete bucket[fid][wid];
    if (Object.keys(bucket[fid]).length === 0) delete bucket[fid];
  }

  /**
   * 批量设置多个墙面的覆盖
   * @param {string} floorLevelId
   * @param {{ wallId: string, faceId: string | null }[]} wallFacePairs
   * @param {object} override
   */
  function setWallFaceOverridesForMultiple(floorLevelId, wallFacePairs, override) {
    if (!Array.isArray(wallFacePairs)) return;
    for (const { wallId, faceId } of wallFacePairs) {
      setWallFaceOverride(floorLevelId, wallId, faceId, override);
    }
  }

  /**
   * 同步墙面覆盖到当前活跃 Design JSON（修改墙面时调用）
   */
  function syncWallFaceOverridesToDesignJson() {
    const key = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
    syncNestedSurfaceOverridesToActiveDesignProject("wallFaceOverrides", wallFaceOverridesByStyleKey[key] || {});
  }

  /**
   * 从 Design JSON 加载墙面覆盖（加载项目时调用）
   */
  function loadWallFaceOverridesFromDesignJson(designSurfaceOverrides) {
    if (!designSurfaceOverrides || typeof designSurfaceOverrides !== "object") return;
    const sk = getEffectiveFloorplanStyleKey();
    const key = normalizeStyleKeyForSurfaceOverrides(sk);
    const styleBag = designSurfaceOverrides[key];
    if (!styleBag || typeof styleBag !== "object") return;
    const wallFaceOverrides = styleBag.wallFaceOverrides;
    if (!wallFaceOverrides || typeof wallFaceOverrides !== "object") return;
    wallFaceOverridesByStyleKey[key] = JSON.parse(JSON.stringify(wallFaceOverrides));
  }

  let dragState = null;
  /** Alt+左键调节装饰模型高度：{ pointerId, group, startClientY, startLiftM } */
  let altDragState = null;
  /** 墙/地：短按才打开属性面板；长按或滑动取消（与 pointerup 配对） */
  let pendingSurfacePick = null;
  /** 点击空白/户型时延迟清除选中，拖拽旋转时取消（与 pointerup 配对） */
  let pendingClearSelection = null;
  const history = [];
  let historyIndex = -1;
  let historyReady = false;
  let isRestoring = false;
  let historyDebounceTimer = null;
  let gridVisible = false;
  let showDimensions = false;
  let showNames = false;
  /** 家具拖曳/方向键/放置时是否沿墙磁吸 */
  let wallSnapEnabled = true;
  let floorLevelDock = null;
  let floorLevelRow = null;
  // 楼层垂直偏移（场景单位：米）。key 对齐 furniture 的 floorId（如 "floor1"）。
  let floorYOffsetById = new Map();
  let floorElevationBaseCm = 0;
  const editorState = {
    get currentFloorIndex() {
      return currentFloorIndex;
    },
    set currentFloorIndex(v) {
      currentFloorIndex = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;
    },
    get currentFloorplanEntry() {
      return currentFloorplanEntry;
    },
    set currentFloorplanEntry(v) {
      currentFloorplanEntry = v ?? null;
    },
    get floorplanStyleKeyOverride() {
      return floorplanStyleKeyOverride;
    },
    set floorplanStyleKeyOverride(v) {
      floorplanStyleKeyOverride = v != null && String(v).trim() ? String(v).trim() : null;
    },
    get floorSelectionEnabled() {
      return floorSelectionEnabled;
    },
    set floorSelectionEnabled(v) {
      floorSelectionEnabled = Boolean(v);
    },
    get gridVisible() {
      return gridVisible;
    },
    get hideOtherFloors() {
      return hideOtherFloors;
    },
    get activeFloorId() {
      return activeFloorId;
    },
    set activeFloorId(v) {
      activeFloorId = v != null && String(v).trim() ? String(v).trim() : null;
    },
    get otherLayersOpacity() {
      return otherLayersOpacity;
    },
    get showDimensions() {
      return showDimensions;
    },
    set showDimensions(v) {
      showDimensions = Boolean(v);
    },
    get showNames() {
      return showNames;
    },
    set showNames(v) {
      showNames = Boolean(v);
    },
    get floorplanSurfaceOverridesByStyleKey() {
      return floorplanSurfaceOverridesByStyleKey;
    },
    set floorplanSurfaceOverridesByStyleKey(v) {
      floorplanSurfaceOverridesByStyleKey = v && typeof v === "object" ? v : {};
    },
    get roomFloorOverridesByStyleKey() {
      return roomFloorOverridesByStyleKey;
    },
    set roomFloorOverridesByStyleKey(v) {
      roomFloorOverridesByStyleKey = v && typeof v === "object" ? v : {};
    },
    get doorOverridesByStyleKey() {
      return doorOverridesByStyleKey;
    },
    set doorOverridesByStyleKey(v) {
      doorOverridesByStyleKey = v && typeof v === "object" ? v : {};
    },
    get windowOverridesByStyleKey() {
      return windowOverridesByStyleKey;
    },
    set windowOverridesByStyleKey(v) {
      windowOverridesByStyleKey = v && typeof v === "object" ? v : {};
    },
    get wallFaceOverridesByStyleKey() {
      return wallFaceOverridesByStyleKey;
    },
    set wallFaceOverridesByStyleKey(v) {
      wallFaceOverridesByStyleKey = v && typeof v === "object" ? v : {};
    },
    get history() {
      return history;
    },
    get historyIndex() {
      return historyIndex;
    },
    set historyIndex(v) {
      historyIndex = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : -1;
    },
    get historyReady() {
      return historyReady;
    },
    set historyReady(v) {
      historyReady = Boolean(v);
    },
    get isRestoring() {
      return isRestoring;
    },
    set isRestoring(v) {
      isRestoring = Boolean(v);
    },
    get historyDebounceTimer() {
      return historyDebounceTimer;
    },
    set historyDebounceTimer(v) {
      historyDebounceTimer = v;
    },
    get floorYOffsetById() {
      return floorYOffsetById;
    },
    set floorYOffsetById(v) {
      floorYOffsetById = v instanceof Map ? v : new Map();
    },
    get floorElevationBaseCm() {
      return floorElevationBaseCm;
    },
    set floorElevationBaseCm(v) {
      floorElevationBaseCm = Number.isFinite(Number(v)) ? Number(v) : 0;
    },
    get floorplanRebuildGen() {
      return floorplanRebuildGen;
    },
    set floorplanRebuildGen(v) {
      floorplanRebuildGen = Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;
    },
    get lastMergedFloorplanStyle() {
      return lastMergedFloorplanStyle;
    },
    set lastMergedFloorplanStyle(v) {
      lastMergedFloorplanStyle = v ?? null;
    },
    get sceneLightingEnvMapIntensity() {
      return sceneLightingEnvMapIntensity;
    },
    set sceneLightingEnvMapIntensity(v) {
      sceneLightingEnvMapIntensity = Number.isFinite(Number(v)) ? Number(v) : sceneLightingEnvMapIntensity;
    },
    get shadowCacheDirty() {
      return shadowCacheDirty;
    },
    set shadowCacheDirty(v) {
      shadowCacheDirty = Boolean(v);
    },
    get selectedGroup() {
      return selectedGroup;
    },
  };
  const {
    buildFloorDimensions,
    buildFloorNameAnnotations,
    rebuildFurnitureDimAnnotations,
    rebuildFurnitureNameAnnotations,
    setDimensionsVisible,
    setNamesVisible,
    syncFloorAnnotationVisibility,
  } = createAnnotations({
    byId,
    disposeObject3D,
    extractFurnitureFootprintCm,
    floorplanRoot,
    furnitureRoot,
    getFloorsFromEntry,
    getFurnitureDisplayName,
    normalizeFloorIndex,
    rebuildFloorplan3D: (...args) => rebuildFloorplan3DFromCore(...args),
    snap,
    state: editorState,
    updateFurnitureFloorVisibility: (...args) => updateFurnitureFloorVisibilityFromCore(...args),
  });
  const { initBomPanel, updateBottomUI } = createBomPanel({
    applyFloorLevelSelectionChange: (...args) => applyFloorLevelSelectionChangeFromCore(...args),
    byId,
    extractFurnitureFootprintCm,
    formatSkuMarkupLabel,
    furnitureRoot,
    getFloorsFromEntry,
    getFurnitureDisplayName,
    hasFurnitureMaterialConfig,
    normalizeFloorIndex,
    normalizeFloorKey,
    normalizeFurnitureSelection,
    resolveFurnitureSelectionDetail,
    selectFurniture,
    setFloorLevelsVisible,
    state: editorState,
    syncOtherOpacityUi,
  });
  initBomPanel();
  const {
    appendFurnitureItem,
    refreshFurnitureVisualForConfig,
  } = createFurnitureMeshModule({
    byId,
    applyFurnitureAppearanceToGroup,
    applyFurnitureGltfPbrMaps,
    clampDecorationLiftMForGroup,
    extractFurnitureFootprintCm,
    fitGltfToFootprint,
    furnitureRoot,
    getActiveFloorIdForFurniture,
    hasFurnitureMaterialConfig,
    markShadowCacheDirty: () => {
      shadowCacheDirty = true;
    },
    normalizeFurnitureSelection,
    registerFurnitureMeshes,
    setFurnitureFromLayoutCm,
  });
  const {
    createFloorplanMaterialFromStyleDef,
    queueStylePackTextures,
    tagFloorplanLayerOpacity,
  } = createMaterialFactory({
    applyFloorplanSurfaceAlpha,
    getSceneLightingEnvMapIntensity: () => sceneLightingEnvMapIntensity,
  });
  const {
    applyAllOverridesToScene,
    applyDoorOverridesForMultiple,
    applyRoomFloorOverridesForMultiple,
    applySurfaceOverrideToMesh,
    applySurfaceOverridesForFloorScope,
    applySurfaceOverridesToFloorplan,
    applyWallFaceOverridesToScene,
    applyWindowOverridesForMultiple,
    mergeMaterialOverrideIntoDef,
    migrateFloorplanSurfaceOverridesBucket,
    surfaceOverrideIsActive,
    windowSurfaceOverrideForApply,
  } = createSurfaceOverrideModule({
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
    state: editorState,
  });
  const {
    buildDoorFillGroup: buildDoorFillGroupFromMeshBuilder,
    buildRoomMesh: buildRoomMeshFromMeshBuilder,
    buildWindowGlassGroup: buildWindowGlassGroupFromMeshBuilder,
    doorFillMaterialFromNs: doorFillMaterialFromMeshBuilder,
    windowGlassMaterialFromNs: windowGlassMaterialFromMeshBuilder,
  } = createMeshBuilder({
    applyFloorplanSurfaceAlpha,
    computeWallEndpointExtensionsCm,
    floorplanStdMat,
    getRoomFloorOverride,
    snap,
    surfaceOverrideIsActive,
    tagFloorplanLayerOpacity,
  });
  const { buildWallMesh: buildWallMeshFromModule } = createWallMeshBuilder({
    WALL_HOLE_EPS,
    applyFloorplanSurfaceAlpha,
    cellFullyInsideAnyHole,
    clipLocalPolygonByLineKeepPoint,
    clipLocalPolygonByXRange,
    collectWallOpeningHolesLocal,
    computeParallelWallSideOverlapRangesLocal,
    computeWallEndpointExtensionsCm,
    convexHull2d,
    floorplanStdMat,
    intervalRangeCovers,
    makeWallPlanPrismGeometryLocal,
    mergeSplitEdges,
    polygonAabbCm,
    remapWallBoxUvToWallSpan,
    snap,
    suppressWallBoxFaces,
    tagFloorplanLayerOpacity,
    wallEndCapCoveredByOtherWallCm,
  });
  const {
    applyFloorLevelSelectionChange: applyFloorLevelSelectionChangeFromCore,
    applyFloorplanEntryAtWorld: applyFloorplanEntryAtWorldFromCore,
    applyFloorplanLayerOpacityToScene: applyFloorplanLayerOpacityToSceneFromCore,
    clearFloorplan: clearFloorplanFromCore,
    effectiveFloorplanStyleKeyFromEntryAndOverride: effectiveFloorplanStyleKeyFromEntryAndOverrideFromCore,
    fastStyleSwitch: fastStyleSwitchFromCore,
    mergeLayoutWithStyleDecorations: mergeLayoutWithStyleDecorationsFromCore,
    rebuildFloorplan3D: rebuildFloorplan3DFromCore,
    rebuildFromLayout: rebuildFromLayoutFromCore,
    syncHideOtherFloorsFloorplanVisibility: syncHideOtherFloorsFloorplanVisibilityFromCore,
    updateFurnitureFloorVisibility: updateFurnitureFloorVisibilityFromCore,
  } = createFloorplanCore({
    activeFloorPickMeshes,
    ambientLight,
    applyFloorplanSurfaceAlpha,
    applySurfaceOverridesToFloorplan,
    appendFurnitureItem,
    buildDoorFillGroup: buildDoorFillGroupFromMeshBuilder,
    buildFloorDimensions,
    buildFloorNameAnnotations,
    buildRoomMesh: buildRoomMeshFromMeshBuilder,
    buildWallMesh: buildWallMeshFromModule,
    buildWindowGlassGroup: buildWindowGlassGroupFromMeshBuilder,
    clampDecorationLiftMForGroup,
    clearInteractiveList,
    createFloorplanMaterialFromStyleDef,
    dirLight,
    disposeObject3D,
    doorFillMaterialFromNs: doorFillMaterialFromMeshBuilder,
    floorplanRoot,
    floorplanStdMat,
    furnitureRoot,
    getActiveLayerOpacity: () => activeLayerOpacity,
    getEffectiveFloorplanStyleKey,
    getLayout,
    hemiLight,
    modelIdIsDecoration,
    normalizeStyleKeyForSurfaceOverrides,
    pushHistorySnapshot: (...args) => pushHistorySnapshot(...args),
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
    setFloorplanSelected: (v) => {
      floorplanSelected = Boolean(v);
    },
    state: editorState,
    syncFloorAnnotationVisibility,
    syncOtherOpacityUi,
    tagFloorplanLayerOpacity,
    unregisterFurnitureGroup,
    updateBottomUI,
    windowGlassMaterialFromNs: windowGlassMaterialFromMeshBuilder,
  });
  const undoRedoButtons = { undo: null, redo: null };
  const {
    applyHistorySnapshotState,
    flushHistoryDebounce,
    initHistory,
    normalizeHistorySnapshot,
    pushHistorySnapshot,
    redo,
    schedulePushHistory,
    syncUndoRedoButtons,
    undo,
  } = createHistoryModule({
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
    getRedoButton: () => undoRedoButtons.redo,
    getUndoButton: () => undoRedoButtons.undo,
    maxHistory: MAX_HISTORY,
    migrateFloorplanSurfaceOverridesBucket,
    normalizeStyleKeyForSurfaceOverrides,
    rebuildFloorplan3D,
    rebuildFromLayout,
    resolveFloorplanCatalogEntry: (id) => {
      const cat = window.__floorPlanCatalog;
      return cat?.byId instanceof Map ? cat.byId.get(id) : null;
    },
    selectFurniture,
    state: editorState,
    updateBottomUI,
  });
  const {
    applyExternalLayout,
    applyFromDesignProject,
    restoreEditorSession,
  } = createProjectIoModule({
    applyAllOverridesToScene,
    applyFloorplanEntryAtWorld,
    applyHistorySnapshotState,
    applyLightingConfig: (cfg) => {
      window.layoutEditorApplyLightingConfig?.(cfg);
    },
    clearFloorplan,
    emitLayoutChanged,
    floorplanRoot,
    getFloorsFromEntry,
    initHistory,
    maxHistory: MAX_HISTORY,
    migrateFloorplanSurfaceOverridesBucket,
    normalizeHistorySnapshot,
    normalizeStyleKeyForSurfaceOverrides,
    rebuildFromLayout,
    resetCameraView,
    resolveFloorplanCatalogEntry: (id) => {
      const cat = window.__floorPlanCatalog;
      return cat?.byId instanceof Map ? cat.byId.get(id) : null;
    },
    selectFurniture,
    selectFloorplanLibraryCardById: (id) => {
      window.__selectFloorplanLibraryCardById?.(id);
    },
    serializeDesignBaseline,
    serializeDesignForSave,
    setGridVisible,
    setRenderQualityMode,
    setViewTransform,
    state: editorState,
    syncRenderQualityToolbarUi,
    syncUndoRedoButtons,
  });
  const propertiesPanel = document.getElementById("propertiesPanel");
  const {
    initFloorplanStyleToolbar,
    initStylePackSaveDialogs,
  } = createStylePackTools({
    ambientLight,
    clearFloorplanSurfaceSelection,
    clearSurfaceOverridesForStyle,
    fastStyleSwitch,
    getCurrentFloorplanId,
    getCurrentSurfaceOverridesBucket,
    getEffectiveFloorplanStyleKey,
    getFloorplanMaterialsLibraryBag,
    getFloorsFromEntry,
    getLastMergedFloorplanStyle: () => lastMergedFloorplanStyle,
    getLayout,
    getSceneLightingEnvMapIntensity: () => sceneLightingEnvMapIntensity,
    hemiLight,
    loadStylePackIndexFromMain: loadStylePackIndex,
    mergeLayoutWithStyleDecorations,
    mergeMaterialOverrideIntoDef,
    modelIdIsDecoration,
    normalizeFloorKey,
    normalizeStyleKeyForSurfaceOverrides,
    propertiesPanel,
    pushHistorySnapshot,
    rebuildFloorplan3D,
    schedulePushHistory,
    selectFurniture,
    serializeDesignBaseline,
    serializeDesignForSave,
    setFloorplanSelected: (v) => {
      floorplanSelected = Boolean(v);
    },
    state: editorState,
    surfaceOverrideIsActive,
    windowSurfaceOverrideForApply,
    renderer,
    dirLight,
    getSurfaceOverridesBucketForStyle,
  });
  const {
    applyLightingConfig: applyLightingConfigFromToolbar,
    getCurrentLightingConfig: getCurrentLightingConfigFromToolbar,
    initializeToolbarsAndApis,
    setRenderQualityMode: setRenderQualityModeFromToolbar,
    syncRenderQualityToolbarUi: syncRenderQualityToolbarUiFromToolbar,
  } = createToolbarInit({
    RENDER_QUALITY_CONFIGS,
    addFurniture,
    animate: () => animate(),
    applyFloorplanEntryAtWorld,
    applyPropertiesFromPanel,
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
    getGetSurfaceOverrides: () => () => {
      const result = {};
      const allKeys = new Set([
        ...Object.keys(floorplanSurfaceOverridesByStyleKey),
        ...Object.keys(roomFloorOverridesByStyleKey),
        ...Object.keys(doorOverridesByStyleKey),
        ...Object.keys(windowOverridesByStyleKey),
        ...Object.keys(wallFaceOverridesByStyleKey),
      ]);
      for (const key of allKeys) {
        result[key] = {
          ...JSON.parse(JSON.stringify(floorplanSurfaceOverridesByStyleKey[key] || {})),
          roomFloors: JSON.parse(JSON.stringify(roomFloorOverridesByStyleKey[key] || {})),
          doorOverrides: JSON.parse(JSON.stringify(doorOverridesByStyleKey[key] || {})),
          windowOverrides: JSON.parse(JSON.stringify(windowOverridesByStyleKey[key] || {})),
          wallFaceOverrides: JSON.parse(JSON.stringify(wallFaceOverridesByStyleKey[key] || {})),
        };
      }
      return result;
    },
    getGridVisible: () => gridVisible,
    getRenderQualityMode: () => renderQualityMode,
    getSceneLightingEnvMapIntensity: () => sceneLightingEnvMapIntensity,
    getShadowsEnabled: () => shadowsEnabled,
    getShowDimensions: () => showDimensions,
    getShowNames: () => showNames,
    getUndoHistory: () => ({ entries: [...history], index: historyIndex }),
    getViewTransform,
    getWallSnapEnabled: () => wallSnapEnabled,
    getWindowRestoreSession: () => restoreEditorSession,
    getLayout,
    ambientLight,
    hemiLight,
    dirLight,
    initFloorplanStyleToolbar,
    initStylePackSaveDialogs,
    renderer,
    renderEditorScene: () => renderEditorScene(),
    resetCameraView,
    resizeRenderer,
    selectFurniture,
    serializeDesignBaseline,
    serializeDesignForSave,
    setDimensionsVisible,
    setFloorplanSelected: (v) => {
      floorplanSelected = Boolean(v);
    },
    setGridVisible,
    setNamesVisible,
    setRenderQualityModeRaw: (mode) => {
      renderQualityMode = mode;
    },
    setSceneLightingEnvMapIntensity: (v) => {
      sceneLightingEnvMapIntensity = v;
    },
    setShadowsEnabled,
    setViewTransform,
    setWallSnapEnabled,
    syncPropertiesPanelForSelection,
    VIEW_H,
    VIEW_W,
  });
  /** 墙体中心线（画布 cm），按楼层 id 缓存，用于家具拖曳磁吸 */
  const WALL_SNAP_THRESHOLD_CM = 32;
  const wallSnapSegmentsByFloorId = new Map();

  function rebuildWallSnapData(entry) {
    wallSnapSegmentsByFloorId.clear();
    if (!entry) return;
    const placement = computeFloorplanCanvasPlacement(entry);
    if (!placement) return;
    const { worldX, worldY, s, cx, cy } = placement;
    const floors = getFloorsFromEntry(entry);
    floors.forEach((fl, i) => {
      const fidRaw = String(fl?.id ?? "").trim() || `floor${i + 1}`;
      const key = normalizeFloorKey(fidRaw);
      const list = [];
      for (const w of fl.walls || []) {
        if (!Array.isArray(w?.start) || w.start.length < 2 || !Array.isArray(w?.end) || w.end.length < 2) continue;
        const x1 = snap(Number(w.start[0]));
        const y1 = snap(Number(w.start[1]));
        const x2 = snap(Number(w.end[0]));
        const y2 = snap(Number(w.end[1]));
        const th = Number(w.thickness);
        const thickCm = Number.isFinite(th) && th > 0 ? th : 12;
        const halfThick = thickCm / 2;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-3) continue;
        const faces = Array.isArray(w.faces) ? w.faces : [];
        for (const face of faces) {
          if (face.side === "exterior") continue;
          if (!Array.isArray(face.normal) || face.normal.length < 2) continue;
          const fnx = Number(face.normal[0]);
          const fny = Number(face.normal[1]);
          if (!Number.isFinite(fnx) || !Number.isFinite(fny)) continue;
          const ox1 = x1 + fnx * halfThick;
          const oy1 = y1 + fny * halfThick;
          const ox2 = x2 + fnx * halfThick;
          const oy2 = y2 + fny * halfThick;
          const ax = worldX + s * (ox1 - cx);
          const ay = worldY + s * (oy1 - cy);
          const bx = worldX + s * (ox2 - cx);
          const by = worldY + s * (oy2 - cy);
          if (Math.hypot(bx - ax, by - ay) < 1e-3) continue;
          list.push({ ax, ay, bx, by });
        }
      }
      wallSnapSegmentsByFloorId.set(key, list);
    });
  }

  function snapFurnitureCenterToWalls(cx, cy, rotDeg, hw, hh, floorId) {
    const key = normalizeFloorKey(floorId ?? "floor1");
    const segments = wallSnapSegmentsByFloorId.get(key);
    if (!segments || !segments.length) return { x: cx, y: cy };
    const cc = centeredToCanvasCm(cx, cy);
    const pts = furnitureWallSnapSamplePointsCm(cc.x, cc.y, rotDeg, hw, hh);
    let best = null;
    for (const p of pts) {
      for (const seg of segments) {
        const q = closestPointOnSegment2D(p.x, p.y, seg.ax, seg.ay, seg.bx, seg.by);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < WALL_SNAP_THRESHOLD_CM && (!best || d < best.d)) {
          best = { dx: q.x - p.x, dy: q.y - p.y, d };
        }
      }
    }
    if (!best) return { x: cx, y: cy };
    return { x: cx + best.dx, y: cy + best.dy };
  }

  const propertiesName = propertiesPanel?.querySelector(".properties-name");
  const propInputX = propertiesPanel?.querySelector('input[data-prop="x"]');
  const propInputZ = propertiesPanel?.querySelector('input[data-prop="z"]');
  const propInputRotY = propertiesPanel?.querySelector('input[data-prop="rotY"]');
  const propDimW = document.getElementById("propDimW");
  const propDimD = document.getElementById("propDimD");
  const propDimH = document.getElementById("propDimH");
  const propTagsSection = document.getElementById("propTagsSection");
  const propFurnitureTags = document.getElementById("propFurnitureTags");
  const propAppearanceBody = document.getElementById("propAppearanceBody");
  const propAppearanceHint = document.getElementById("propAppearanceHint");
  const propFurnitureFields = document.getElementById("propFurnitureFields");
  const propSurfaceFields = document.getElementById("propSurfaceFields");
  const propSurfaceTitle = document.getElementById("propSurfaceTitle");
  const propSurfaceIdHint = document.getElementById("propSurfaceIdHint");
  const propSurfaceColorPickerMount = document.getElementById("propSurfaceColorPickerMount");
  const propSurfaceColor = document.getElementById("propSurfaceColor");
  const surfaceColorPicker =
    propSurfaceColorPickerMount && propSurfaceColor
      ? mountFloorplanColorPicker(propSurfaceColorPickerMount, propSurfaceColor)
      : null;
  const propSurfaceMaterial = document.getElementById("propSurfaceMaterial");
  const propSurfaceTextureAlbedo = document.getElementById("propSurfaceTextureAlbedo");
  const propSurfaceMaterialName = document.getElementById("propSurfaceMaterialName");
  const propSurfaceMaterialFilters = document.getElementById("propSurfaceMaterialFilters");
  const propSurfaceMaterialGrid = document.getElementById("propSurfaceMaterialGrid");
  const propSurfaceMaterialSection = document.getElementById("propSurfaceMaterialSection");
  const propSurfaceUvTextureSection = document.getElementById("propSurfaceUvTextureSection");
  const propSurfaceMaterialClear = document.getElementById("propSurfaceMaterialClear");
  const propSurfaceRoughness = document.getElementById("propSurfaceRoughness");
  const propSurfaceMetalness = document.getElementById("propSurfaceMetalness");
  const propSurfaceUvScaleX = document.getElementById("propSurfaceUvScaleX");
  const propSurfaceUvScaleY = document.getElementById("propSurfaceUvScaleY");
  const propSurfaceTextureRotation = document.getElementById("propSurfaceTextureRotation");
  const propSurfaceGlassFields = document.getElementById("propSurfaceGlassFields");
  const propSurfacePbrFields = document.getElementById("propSurfacePbrFields");
  const propSurfaceOpacity = document.getElementById("propSurfaceOpacity");
  const propSurfaceTransmission = document.getElementById("propSurfaceTransmission");
  const propSurfaceIor = document.getElementById("propSurfaceIor");
  const propSurfaceColorReset = document.getElementById("propSurfaceColorReset");
  const propSurfaceResetDefault = document.getElementById("propSurfaceResetDefault");
  let surfaceMaterialGridClickBound = false;
  let surfaceMaterialCategoryFilter = "全部";
  /** 材质预设「清除」点击后下一次 commit 需写入 materialPresetCleared */
  let pendingSurfaceMaterialPresetClear = false;
  let colorTextureIndexPromise = null;

  function syncPropPanelAppearance(group, item) {
    if (!propAppearanceBody) return;
    propAppearanceBody.replaceChildren();
    if (propAppearanceHint) propAppearanceHint.hidden = true;
    if (!item || !hasFurnitureMaterialConfig(item)) {
      if (propAppearanceHint) propAppearanceHint.hidden = false;
      return;
    }
    if (!group) return;
    if (!group.userData.furnitureSelection) {
      group.userData.furnitureSelection = normalizeFurnitureSelection(item, null);
    }
    const sel = normalizeFurnitureSelection(item, group.userData.furnitureSelection);
    group.userData.furnitureSelection = sel;
    const det = resolveFurnitureSelectionDetail(item, sel);

    const cur = document.createElement("div");
    cur.className = "prop-appearance-current";
    const skuNameOnly =
      (det.skuName && String(det.skuName).trim()) ||
      [det.materialName, det.textureName, det.colorName].filter(Boolean).join(" · ") ||
      "—";
    const line = document.createElement("div");
    line.className = "prop-appearance-sku-line";
    const nameEl = document.createElement("span");
    nameEl.className = "prop-appearance-sku-name";
    nameEl.textContent = skuNameOnly;
    line.appendChild(nameEl);
    const markupLabel =
      det.skuMarkup != null ? formatSkuMarkupLabel(det.skuMarkup) : "";
    if (markupLabel) {
      const mk = document.createElement("span");
      mk.className =
        "prop-appearance-sku-markup" +
        (det.skuMarkup != null && det.skuMarkup < 0 ? " is-negative" : "");
      mk.textContent = markupLabel;
      line.appendChild(mk);
    }
    cur.appendChild(line);
    propAppearanceBody.appendChild(cur);

    const pick = document.createElement("div");
    pick.className = "prop-appearance-pick";

    const mats = item.config.materials ?? [];
    const matRow = document.createElement("div");
    matRow.className = "prop-appearance-row";
    matRow.appendChild(Object.assign(document.createElement("span"), { className: "prop-appearance-row-label", textContent: "材质" }));
    const matBtns = document.createElement("div");
    matBtns.className = "prop-appearance-chips";
    for (const m of mats) {
      if (!m?.id) continue;
      const id = String(m.id).trim();
      const b = document.createElement("button");
      b.type = "button";
      b.className = "prop-appearance-chip" + (id === sel.materialId ? " is-selected" : "");
      b.textContent = String(m.name ?? m.id);
      b.addEventListener("click", () => {
        const next = normalizeFurnitureSelection(item, { materialId: id, textureId: "", colorId: "" });
        group.userData.furnitureSelection = next;
        void refreshFurnitureVisualForConfig(group, item).then(() => {
          syncPropPanelAppearance(group, item);
          updateBottomUI();
          if (historyReady) schedulePushHistory();
        });
      });
      matBtns.appendChild(b);
    }
    matRow.appendChild(matBtns);
    pick.appendChild(matRow);

    const mat = mats.find((m) => m && String(m.id ?? "").trim() === sel.materialId);
    const textures = Array.isArray(mat?.textures) ? mat.textures : [];
    if (textures.length) {
      const texRow = document.createElement("div");
      texRow.className = "prop-appearance-row";
      texRow.appendChild(Object.assign(document.createElement("span"), { className: "prop-appearance-row-label", textContent: "款式" }));
      const texBtns = document.createElement("div");
      texBtns.className = "prop-appearance-chips";
      for (const t of textures) {
        if (!t?.id) continue;
        const tid = String(t.id).trim();
        const b = document.createElement("button");
        b.type = "button";
        b.className = "prop-appearance-chip" + (tid === sel.textureId ? " is-selected" : "");
        b.textContent = String(t.name ?? t.id);
        b.addEventListener("click", () => {
          const next = normalizeFurnitureSelection(item, { materialId: sel.materialId, textureId: tid, colorId: "" });
          group.userData.furnitureSelection = next;
          void refreshFurnitureVisualForConfig(group, item).then(() => {
            syncPropPanelAppearance(group, item);
            updateBottomUI();
            if (historyReady) schedulePushHistory();
          });
        });
        texBtns.appendChild(b);
      }
      texRow.appendChild(texBtns);
      pick.appendChild(texRow);
    }

    const tex = textures.find((t) => t && String(t.id ?? "").trim() === sel.textureId);
    const colors = Array.isArray(tex?.colors) ? tex.colors : [];
    if (colors.length) {
      const colRow = document.createElement("div");
      colRow.className = "prop-appearance-row prop-appearance-row--colors";
      colRow.appendChild(Object.assign(document.createElement("span"), { className: "prop-appearance-row-label", textContent: "颜色" }));
      const sw = document.createElement("div");
      sw.className = "prop-appearance-swatches";
      for (const col of colors) {
        if (!col?.id) continue;
        const cid = String(col.id).trim();
        const hex = col.hex != null ? String(col.hex).trim() : "#888";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "prop-appearance-swatch" + (cid === sel.colorId ? " is-selected" : "");
        b.style.setProperty("--swatch", hex.startsWith("#") ? hex : `#${hex}`);
        b.title = `${String(col.name ?? col.id)} ${hex}`;
        b.addEventListener("click", () => {
          const next = normalizeFurnitureSelection(item, {
            materialId: sel.materialId,
            textureId: sel.textureId,
            colorId: cid,
          });
          group.userData.furnitureSelection = next;
          void refreshFurnitureVisualForConfig(group, item).then(() => {
            syncPropPanelAppearance(group, item);
            updateBottomUI();
            if (historyReady) schedulePushHistory();
          });
        });
        sw.appendChild(b);
      }
      colRow.appendChild(sw);
      pick.appendChild(colRow);
    }

    propAppearanceBody.appendChild(pick);
  }

  function syncPropPanelTagsFromItem(item) {
    if (!propTagsSection || !propFurnitureTags) return;
    propFurnitureTags.replaceChildren();
    const tags = getFurnitureTags(item);
    if (!tags.length) {
      propTagsSection.hidden = true;
      return;
    }
    propTagsSection.hidden = false;
    for (const text of tags) {
      const span = document.createElement("span");
      span.className = "prop-tag";
      span.textContent = text;
      propFurnitureTags.appendChild(span);
    }
  }

  function syncPropPanelDimsFromItem(item) {
    const dash = "—";
    if (!propDimW && !propDimD && !propDimH) return;
    if (!item) {
      if (propDimW) propDimW.textContent = dash;
      if (propDimD) propDimD.textContent = dash;
      if (propDimH) propDimH.textContent = dash;
      syncPropPanelTagsFromItem(null);
      return;
    }
    const fp = extractFurnitureFootprintCm(item);
    if (propDimW) propDimW.textContent = String(Math.round(fp.w));
    if (propDimD) propDimD.textContent = String(Math.round(fp.d));
    if (propDimH) propDimH.textContent = String(Math.round(fp.h));
    syncPropPanelTagsFromItem(item);
  }
  const undoBtn = document.querySelector("[data-layout-undo]");
  const redoBtn = document.querySelector("[data-layout-redo]");
  undoRedoButtons.undo = undoBtn;
  undoRedoButtons.redo = redoBtn;
  const gridToggleBtn = document.getElementById("layoutGridToggleBtn");
  const floorHideOthersToggleBtn = document.querySelector("[data-layout-floor-hide-others-toggle]");
  // 快速操作：只显示当前楼层，其它楼层/家具隐藏
  let hideOtherFloors = false;
  const otherLayersOpacityWrap = document.getElementById("otherLayersOpacityWrap");
  const otherLayersOpacityRange = document.getElementById("otherLayersOpacityRange");
  // 当前选中层透明度（0~1），其余层固定 0.2
  let activeLayerOpacity = 1.0;
  const otherLayersOpacity = 0.2; // 非选中层固定值
  /** 户型 3D 重建代数：异步加载 style.json 完成后若已发起更新则放弃写入 */
  let floorplanRebuildGen = 0;
  floorHideOthersToggleBtn?.classList.toggle("is-active", hideOtherFloors);
  floorHideOthersToggleBtn?.setAttribute("aria-pressed", hideOtherFloors ? "true" : "false");
  function syncOtherOpacityUi() {
    if (!otherLayersOpacityWrap) return;
    // 有楼层选中时显示滑块，与"仅当前层"无关
    const show = floorSelectionEnabled;
    otherLayersOpacityWrap.hidden = !show;
    otherLayersOpacityWrap.setAttribute("aria-hidden", show ? "false" : "true");
    otherLayersOpacityWrap.style.display = show ? "flex" : "none";
    if (otherLayersOpacityRange) {
      const v = Math.round(activeLayerOpacity * 100);
      otherLayersOpacityRange.value = String(Math.max(0, Math.min(100, v)));
    }
  }
  syncOtherOpacityUi();
  otherLayersOpacityRange?.addEventListener("input", () => {
    if (!floorSelectionEnabled) return;
    const v = Number(otherLayersOpacityRange.value);
    if (!Number.isFinite(v)) return;
    activeLayerOpacity = Math.max(0, Math.min(1, v / 100));
    if (!applyFloorplanLayerOpacityToScene()) {
      rebuildFloorplan3D();
    }
    updateFurnitureFloorVisibility();
  });

  function emitLayoutChanged() {
    window.dispatchEvent(new CustomEvent("visionhome:layout-editor-changed"));
  }
  function getActiveFloorIdForFurniture() {
    if (activeFloorId && String(activeFloorId).trim()) return String(activeFloorId).trim();
    const floor = getCurrentFloorFromEntry(currentFloorplanEntry, currentFloorIndex);
    if (floor?.id != null && String(floor.id).trim()) return String(floor.id).trim();
    return "floor1";
  }

  function modelIdIsDecoration(modelId) {
    const dec = window.__decorationCatalog;
    return dec?.byId instanceof Map && dec.byId.has(modelId);
  }

  /** 某楼层净空高度（米），与户型墙高 defaultH 一致 */
  function getFloorHeightMForFloorId(floorIdStr) {
    if (!currentFloorplanEntry) return 2.8;
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    const want = normalizeFloorKey(floorIdStr);
    for (let i = 0; i < floors.length; i++) {
      const fl = floors[i];
      const fidRaw = String(fl?.id ?? "").trim() || `floor${i + 1}`;
      if (normalizeFloorKey(fidRaw) !== want) continue;
      const fh = Number(fl?.height);
      return Number.isFinite(fh) && fh > 0 ? fh / 100 : 2.8;
    }
    return 2.8;
  }

  /** 装饰物在楼板之上的抬升（米），顶面不高于本层天花板 */
  function clampDecorationLiftMForGroup(group, liftM) {
    const fp = group?.userData?.footprint;
    const hM = fp && Number.isFinite(fp.h) ? fp.h / 100 : 0.8;
    const floorH = getFloorHeightMForFloorId(String(group?.userData?.floorId ?? ""));
    const maxLift = Math.max(0, floorH - hM);
    const v = Number(liftM);
    if (!Number.isFinite(v)) return 0;
    return Math.min(maxLift, Math.max(0, v));
  }
  function clearInteractiveList() {
    for (let i = interactiveMeshes.length - 1; i >= 0; i--) {
      if (!interactiveMeshes[i]?.userData?.__furnitureRoot) interactiveMeshes.splice(i, 1);
    }
  }
  function registerFurnitureMeshes(group) {
    group.traverse((obj) => {
      if (obj.isMesh) {
        obj.userData.__furnitureRoot = group;
        interactiveMeshes.push(obj);
      }
    });
  }
  function unregisterFurnitureGroup(group) {
    for (let i = interactiveMeshes.length - 1; i >= 0; i--) {
      if (interactiveMeshes[i].userData.__furnitureRoot === group) interactiveMeshes.splice(i, 1);
    }
    for (let i = activeFloorPickMeshes.length - 1; i >= 0; i--) {
      if (activeFloorPickMeshes[i].userData.__furnitureRoot === group) activeFloorPickMeshes.splice(i, 1);
    }
  }
  function disposeMaterialMaps(material) {
    if (!material || typeof material !== "object") return;
    for (const key of Object.keys(material)) {
      const v = material[key];
      if (v && typeof v === "object" && v.isTexture) v.dispose?.();
    }
  }
  function disposeObject3D(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          disposeMaterialMaps(m);
          m.dispose?.();
        });
      }
    });
  }

  /** 仅用于户型挤出：压低环境反射，减轻「户型过亮、立面无层次」 */
  function floorplanStdMat() {
    return new THREE.MeshStandardMaterial({
      color: FLOORPLAN_SURFACE_COLOR,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: sceneLightingEnvMapIntensity,
      emissive: new THREE.Color(0x000000),
    });
  }

  /**
   * 户型实体/门扇等半透明表面：不写入深度，由透明队列按距相机排序，减轻旋转时与其它半透明面叠加导致的变色、发黑。
   * 轻微 polygonOffset 减轻 T 字墙接缝处共面 Z-fighting。
   * 房间地面（userData.__floorplanRoomFloorDepthWrite）在层透明度 < 1 时仍写深度，否则共边处后绘木纹会盖住厨卫瓷砖。
   */
  function applyFloorplanSurfaceAlpha(mat, opacity) {
    const op = Math.max(0, Math.min(1, opacity ?? 1));
    mat.opacity = op;
    mat.transparent = op < 1;
    const roomFloor = mat.userData?.__floorplanRoomFloorDepthWrite === true;
    if (op < 1) {
      if (roomFloor) {
        mat.depthWrite = true;
        mat.depthTest = true;
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = -2;
        mat.polygonOffsetUnits = -2;
      } else {
        mat.depthWrite = false;
        mat.depthTest = true;
        mat.polygonOffset = true;
        mat.polygonOffsetFactor = 1;
        mat.polygonOffsetUnits = 1;
      }
    } else {
      mat.depthWrite = true;
      mat.depthTest = true;
      mat.polygonOffset = false;
      mat.polygonOffsetFactor = 0;
      mat.polygonOffsetUnits = 0;
    }
  }

  let floorplanSurfaceBoxHelpers = []; // 存储户型表面选中框

  /**
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   * @param {boolean} on
   * @param {Set<string>} [roomIdFilter] 可选的房间 ID 过滤器，用于多选时只高亮选中的房间
   */
  /**
   * 为墙体 mesh 的某个面创建平面矩形线框。
   * BoxGeometry 局部坐标中：face_a(materialIndex 4) 是 +Z 面，face_b(5) 是 -Z 面。
   * @param {import("three").Mesh} mesh
   * @param {"face_a" | "face_b" | null} faceId null 表示整堵墙（用 BoxHelper 包围盒）
   * @returns {import("three").LineLoop | import("three").BoxHelper}
   */
  function createWallFaceHelper(mesh, faceId) {
    const LINE_COLOR = 0x00aaff;
    const matLine = new THREE.LineBasicMaterial({
      color: LINE_COLOR,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
    });

    if (!faceId || !mesh.geometry?.parameters) {
      // 整堵墙：用普通 BoxHelper
      const box = new THREE.BoxHelper(mesh, LINE_COLOR);
      box.material.transparent = true;
      box.material.opacity = 0.8;
      box.material.depthTest = true;
      box.material.depthWrite = false;
      matLine.dispose();
      return box;
    }

    // 从 BoxGeometry 参数取宽/高/厚（局部坐标）
    const params = mesh.geometry.parameters;
    const hw = (params.width ?? 1) / 2;   // 半宽
    const hh = (params.height ?? 1) / 2;  // 半高
    const hd = (params.depth ?? 0.1) / 2; // 半厚
    // face_a = +Z 面，face_b = -Z 面
    const z = faceId === "face_a" ? hd : -hd;

    // 四角在局部坐标（逆时针，法线朝外）
    const pts = faceId === "face_a"
      ? [
          new THREE.Vector3(-hw, -hh, z),
          new THREE.Vector3( hw, -hh, z),
          new THREE.Vector3( hw,  hh, z),
          new THREE.Vector3(-hw,  hh, z),
          new THREE.Vector3(-hw, -hh, z), // 闭合
        ]
      : [
          new THREE.Vector3( hw, -hh, z),
          new THREE.Vector3(-hw, -hh, z),
          new THREE.Vector3(-hw,  hh, z),
          new THREE.Vector3( hw,  hh, z),
          new THREE.Vector3( hw, -hh, z), // 闭合
        ];

    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, matLine);

    // 将局部坐标转换到世界坐标：复制 mesh 的世界矩阵
    mesh.updateWorldMatrix(true, false);
    line.applyMatrix4(mesh.matrixWorld);

    return line;
  }

  /**
   * 将同一 wallId 的多个分段 mesh 合并为“单一墙面线框”（仅当前面，不含上下左右）。
   * @param {import("three").Mesh[]} meshes
   * @param {"face_a" | "face_b" | null} faceId
   * @returns {import("three").LineLoop | null}
   */
  function createMergedWallFaceHelper(meshes, faceId) {
    if (!Array.isArray(meshes) || meshes.length === 0) return null;
    const base = meshes.find((m) => m?.isMesh);
    if (!base) return null;
    base.updateWorldMatrix(true, false);
    const worldToLocal = new THREE.Matrix4().copy(base.matrixWorld).invert();
    const localToWorld = base.matrixWorld.clone();
    const v = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const mesh of meshes) {
      if (!mesh?.isMesh || !mesh.geometry) continue;
      mesh.updateWorldMatrix(true, false);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const bb = mesh.geometry.boundingBox;
      if (!bb) continue;
      const clampXMin = Number(mesh.userData?.floorplanWallSelectionClampXMin);
      const clampXMax = Number(mesh.userData?.floorplanWallSelectionClampXMax);
      const shouldClampX = Number.isFinite(clampXMin) && Number.isFinite(clampXMax) && clampXMin < clampXMax;
      for (const x of [bb.min.x, bb.max.x]) {
        for (const y of [bb.min.y, bb.max.y]) {
          for (const z of [bb.min.z, bb.max.z]) {
            v.set(x, y, z).applyMatrix4(mesh.matrixWorld).applyMatrix4(worldToLocal);
            if (shouldClampX) {
              v.x = Math.max(clampXMin, Math.min(clampXMax, v.x));
            }
            minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
            minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
            minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
          }
        }
      }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null;
    const zFace = faceId === "face_b" ? minZ : maxZ;
    const pts = faceId === "face_b"
      ? [
          new THREE.Vector3(maxX, minY, zFace),
          new THREE.Vector3(minX, minY, zFace),
          new THREE.Vector3(minX, maxY, zFace),
          new THREE.Vector3(maxX, maxY, zFace),
        ]
      : [
          new THREE.Vector3(minX, minY, zFace),
          new THREE.Vector3(maxX, minY, zFace),
          new THREE.Vector3(maxX, maxY, zFace),
          new THREE.Vector3(minX, maxY, zFace),
        ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.9,
      depthTest: true,
      depthWrite: false,
    });
    const loop = new THREE.LineLoop(geo, mat);
    loop.applyMatrix4(localToWorld);
    return loop;
  }

  function setFloorplanGlobalSurfaceHighlight(floorLevelId, scope, on, roomIdFilter, doorIdFilter, windowIdFilter, wallFaceFilter) {
    // 移除旧的选中框
    floorplanSurfaceBoxHelpers.forEach((helper) => {
      if (helper.parent) {
        helper.parent.remove(helper);
      }
      helper.geometry?.dispose();
      if (Array.isArray(helper.material)) {
        helper.material.forEach((m) => m?.dispose());
      } else {
        helper.material?.dispose();
      }
    });
    floorplanSurfaceBoxHelpers = [];

    if (!on) return;

    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;

    if (scope === "wallFace") {
      /** @type {Map<string, import("three").Mesh[]>} */
      const wallMeshes = new Map();
      floorplanRoot.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
        const meshWallId = String(o.userData.floorplanWallId ?? "").trim();
        if (!meshWallId) return;
        if (wallFaceFilter && wallFaceFilter.size > 0 && !wallFaceFilter.has(meshWallId)) return;
        if (!wallMeshes.has(meshWallId)) wallMeshes.set(meshWallId, []);
        wallMeshes.get(meshWallId).push(o);
      });
      for (const [wallId, meshes] of wallMeshes.entries()) {
        const faceIds = wallFaceFilter?.get(wallId);
        let targets = ["face_a", "face_b"];
        if (faceIds && faceIds.size > 0) {
          targets = [];
          for (const fidSel of faceIds) {
            if (fidSel === null) {
              targets.push("face_a", "face_b");
            } else {
              targets.push(fidSel);
            }
          }
        }
        targets = [...new Set(targets)];
        for (const faceId of targets) {
          const helper = createMergedWallFaceHelper(meshes, faceId);
          if (!helper) continue;
          scene.add(helper);
          floorplanSurfaceBoxHelpers.push(helper);
        }
      }
      return;
    }

    // 收集匹配的网格并创建选中框
    floorplanRoot.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (scope === "allWalls" && !o.userData.floorplanWallId) return;
      if (scope === "wallFace" && !o.userData.floorplanWallId) return;
      if (scope === "allFloors" && !o.userData.floorplanRoomFloor) return;
      if (scope === "allDoors" && !o.userData.floorplanDoorFill) return;
      if (scope === "allWindows" && !o.userData.floorplanWindowFill) return;

      if (scope === "wallFace") {
        // wallFaceFilter: Map<wallId, Set<faceId | null>>
        const meshWallId = String(o.userData.floorplanWallId ?? "").trim();
        if (!meshWallId) return;
        if (wallFaceFilter && wallFaceFilter.size > 0 && !wallFaceFilter.has(meshWallId)) return;

        // 为每个选中的 faceId 创建单面线框
        const faceIds = wallFaceFilter?.get(meshWallId);
        if (faceIds && faceIds.size > 0) {
          for (const faceId of faceIds) {
            const helper = createWallFaceHelper(o, faceId);
            scene.add(helper);
            floorplanSurfaceBoxHelpers.push(helper);
          }
        } else {
          // 没有 faceId 信息（整堵墙）
          const helper = createWallFaceHelper(o, null);
          scene.add(helper);
          floorplanSurfaceBoxHelpers.push(helper);
        }
        return;
      }

      // 多选房间地板时，检查是否在选中列表中
      if (scope === "allFloors" && roomIdFilter && roomIdFilter.size > 0) {
        const meshRoomId = String(o.userData.floorplanRoomId ?? "").trim();
        if (!meshRoomId || !roomIdFilter.has(meshRoomId)) return;
      }

      // 多选门时，检查是否在选中列表中
      if (scope === "allDoors" && doorIdFilter && doorIdFilter.size > 0) {
        const meshDoorId = String(o.userData.floorplanDoorId ?? "").trim();
        if (!meshDoorId || !doorIdFilter.has(meshDoorId)) return;
      }

      // 多选窗户时，检查是否在选中列表中
      if (scope === "allWindows" && windowIdFilter && windowIdFilter.size > 0) {
        const meshWindowId = String(o.userData.floorplanWindowId ?? "").trim();
        if (!meshWindowId || !windowIdFilter.has(meshWindowId)) return;
      }

      // 为每个匹配的网格创建边框
      const box = new THREE.BoxHelper(o, 0x00aaff); // 青蓝色
      box.material.linewidth = 2;
      box.material.transparent = true;
      box.material.opacity = 0.8;
      box.material.depthTest = true;
      box.material.depthWrite = false;

      scene.add(box);
      floorplanSurfaceBoxHelpers.push(box);
    });
  }

  /**
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   */
  function getFloorplanSurfaceGlobalOverride(floorLevelId, scope) {
    const overrides = getCurrentSurfaceOverridesBucket();
    const bag = overrides[String(floorLevelId ?? "").trim()];
    if (!bag) return null;
    if (scope === "allWalls") return bag.allWalls ?? null;
    if (scope === "allFloors") return bag.allFloors ?? null;
    if (scope === "allDoors") return bag.allDoors ?? null;
    if (scope === "allWindows") return bag.allWindows ?? null;
    return null;
  }

  /**
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   * @param {SurfaceScopeOverride | null} data null 表示删除该条
   */
  function setFloorplanSurfaceGlobalOverride(floorLevelId, scope, data) {
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const overrides = getCurrentSurfaceOverridesBucket();
    if (!overrides[fid]) overrides[fid] = {};
    const key =
      scope === "allWalls"
        ? "allWalls"
        : scope === "allFloors"
          ? "allFloors"
          : scope === "allDoors"
            ? "allDoors"
            : scope === "allWindows"
              ? "allWindows"
              : "";
    if (!key) return;
    if (data && typeof data === "object" && Object.keys(data).length > 0) {
      overrides[fid][key] = data;
    } else {
      delete overrides[fid][key];
    }
  }

  /**
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   * @returns {import("three").Mesh | null}
   */
  function findFirstFloorplanSurfaceMesh(floorLevelId, scope) {
    const fid = String(floorLevelId ?? "").trim();
    let found = null;
    floorplanRoot.traverse((o) => {
      if (found || !o.isMesh) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (scope === "allWalls" && o.userData.floorplanWallId) found = o;
      if (scope === "allFloors" && o.userData.floorplanRoomFloor) found = o;
      if (scope === "allDoors" && o.userData.floorplanDoorFill && !o.userData.floorplanDoorHandle) found = o;
      if (scope === "allWindows" && o.userData.floorplanWindowFill) found = o;
    });
    return found;
  }

  function buildRoomMesh(room, cx, cy, s, floorOpacity, floorStyleMat, floorLevelId) {
    return buildRoomMeshFromMeshBuilder(room, cx, cy, s, floorOpacity, floorStyleMat, floorLevelId);
  }

  const WALL_JOIN_POINT_EPS_CM = 0.8;
  /** 沿墙段归一化参数：离开端点小邻域后才视为线段内部（T 型竖墙落在横墙中点） */
  const WALL_JOIN_SEGMENT_INTERIOR_T = 0.04;
  /** 两墙单位方向叉积 |sin θ| 小于此值视为同向共线（直线相接），不做 L 补角 */
  const WALL_JOIN_PARALLEL_CROSS_MAX = 0.06;

  function emptyWallEndpointExtensionsCm() {
    return {
      startExtCm: 0,
      endExtCm: 0,
      startMiterFill: null,
      endMiterFill: null,
      startTrimClip: null,
      endTrimClip: null,
    };
  }

  function dist2PointToSegmentCm(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    if (vv < 1e-12) {
      const dx = px - ax;
      const dy = py - ay;
      return { dist2: dx * dx + dy * dy, t: 0 };
    }
    const wx = px - ax;
    const wy = py - ay;
    const tRaw = (wx * vx + wy * vy) / vv;
    const t = Math.max(0, Math.min(1, tRaw));
    const qx = ax + vx * t;
    const qy = ay + vy * t;
    const dx = px - qx;
    const dy = py - qy;
    return { dist2: dx * dx + dy * dy, t };
  }

  /**
   * L 型：恰两堵墙在一点交汇，且两墙走向不共线（非同一直线延伸）。
   * T 型：≥3 堵墙共点（本检测下 incident 墙数 ≠ 2）不补角。
   */
  /**
   * 检测 L 型角落交汇，并返回当前墙在该角点应保留的补角三角。
   * @param {number} px - 端点x坐标
   * @param {number} py - 端点y坐标
   * @param {any[]} floorWalls - 所有墙体数组
   * @param {string} currentWallOrientation - 当前墙的方向 ("vertical" | "horizontal")
   */
  function getLCornerMiterInfoAtPlanPoint(px, py, floorWalls, currentWallOrientation) {
    if (!Array.isArray(floorWalls)) return null;
    const eps2 = WALL_JOIN_POINT_EPS_CM * WALL_JOIN_POINT_EPS_CM;
    const tMin = WALL_JOIN_SEGMENT_INTERIOR_T;
    /** @type {Map<string, { ux: number, uy: number, thickness: number, orientation: string, ax: number, ay: number, bx: number, by: number }>} */
    const byId = new Map();
    for (let i = 0; i < floorWalls.length; i++) {
      const w = floorWalls[i];
      if (!w || !Array.isArray(w.start) || w.start.length < 2 || !Array.isArray(w.end) || w.end.length < 2) continue;
      const wid = String(w.id ?? "").trim() || `__wall_${i}`;
      const ax = snap(Number(w.start[0]));
      const ay = snap(Number(w.start[1]));
      const bx = snap(Number(w.end[0]));
      const by = snap(Number(w.end[1]));
      if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen < 1e-6) continue;
      const ux = (bx - ax) / segLen;
      const uy = (by - ay) / segLen;
      let touch = false;
      const dA2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      if (dA2 <= eps2) touch = true;
      const dB2 = (px - bx) * (px - bx) + (py - by) * (py - by);
      if (dB2 <= eps2) touch = true;
      const hit = dist2PointToSegmentCm(px, py, ax, ay, bx, by);
      if (hit.dist2 <= eps2 && hit.t > tMin && hit.t < 1 - tMin) touch = true;
      if (touch) {
        const wallTh = Number(w.thickness);
        const th = Number.isFinite(wallTh) && wallTh > 0 ? wallTh : 10;
        const ori = String(w.orientation ?? "").trim().toLowerCase();
        byId.set(wid, { ux, uy, thickness: th, orientation: ori, ax, ay, bx, by });
      }
    }
    if (byId.size !== 2) return null;
    const entries = Array.from(byId.entries());
    const [u, v] = [entries[0][1], entries[1][1]];
    const cross = Math.abs(u.ux * v.uy - u.uy * v.ux);
    if (cross <= WALL_JOIN_PARALLEL_CROSS_MAX) return null;

    function resolveWallAxis(info) {
      if (info.orientation === "vertical" || info.orientation === "horizontal") return info.orientation;
      return Math.abs(info.uy) >= Math.abs(info.ux) ? "vertical" : "horizontal";
    }

    const wall1 = entries[0][1];
    const wall2 = entries[1][1];
    const wall1Axis = resolveWallAxis(wall1);
    const wall2Axis = resolveWallAxis(wall2);
    const vWall = wall1Axis === "vertical" ? wall1 : wall2Axis === "vertical" ? wall2 : null;
    const hWall = wall1Axis === "horizontal" ? wall1 : wall2Axis === "horizontal" ? wall2 : null;
    if (!vWall || !hWall) return null;

    const n1 = vWall.thickness;
    const n2 = hWall.thickness;
    const halfN1 = n1 / 2;
    const halfN2 = n2 / 2;
    const q1MinX = Math.min(vWall.ax, vWall.bx);
    const q1MaxX = Math.max(vWall.ax, vWall.bx);
    const q2MinX = Math.min(hWall.ax, hWall.bx);
    const q2MaxX = Math.max(hWall.ax, hWall.bx);
    const q1MinY = Math.min(vWall.ay, vWall.by);
    const q2MaxY = Math.max(hWall.ay, hWall.by);
    const isLeft = q1MaxX <= q2MinX;
    const isTop = q1MinY >= q2MaxY;
    let cornerPt;
    let cornerType;
    let triPt1;
    let triPt2;
    if (isLeft && isTop) {
      cornerType = "左上";
      cornerPt = [px - halfN1, py - halfN2];
      if (currentWallOrientation === "vertical") {
        triPt1 = [px - halfN1, py + halfN2];
        triPt2 = [px + halfN1, py + halfN2];
      } else {
        triPt1 = [px + halfN1, py - halfN2];
        triPt2 = [px + halfN1, py + halfN2];
      }
    } else if (isLeft && !isTop) {
      cornerType = "左下";
      cornerPt = [px - halfN1, py + halfN2];
      if (currentWallOrientation === "vertical") {
        triPt1 = [px - halfN1, py - halfN2];
        triPt2 = [px + halfN1, py - halfN2];
      } else {
        triPt1 = [px + halfN1, py - halfN2];
        triPt2 = [px + halfN1, py + halfN2];
      }
    } else if (!isLeft && isTop) {
      cornerType = "右上";
      cornerPt = [px + halfN1, py - halfN2];
      if (currentWallOrientation === "vertical") {
        triPt1 = [px - halfN1, py + halfN2];
        triPt2 = [px + halfN1, py + halfN2];
      } else {
        triPt1 = [px - halfN1, py - halfN2];
        triPt2 = [px - halfN1, py + halfN2];
      }
    } else {
      cornerType = "右下";
      cornerPt = [px + halfN1, py + halfN2];
      if (currentWallOrientation === "vertical") {
        triPt1 = [px - halfN1, py - halfN2];
        triPt2 = [px + halfN1, py - halfN2];
      } else {
        triPt1 = [px - halfN1, py - halfN2];
        triPt2 = [px - halfN1, py + halfN2];
      }
    }

    return {
      cornerType,
      wallIds: Array.from(byId.keys()),
      cornerPt,
      triPt1,
      triPt2,
      seamCm: [
        [cornerPt[0], cornerPt[1]],
        [2 * px - cornerPt[0], 2 * py - cornerPt[1]],
      ],
      triangleCm: [
        [cornerPt[0], cornerPt[1]],
        [triPt1[0], triPt1[1]],
        [triPt2[0], triPt2[1]],
      ],
    };
  }

  /**
   * L 型角落：墙身主体回退交墙半厚度，并额外补一个三角柱，避免拐角体块双重重叠。
   * T 型（≥3 堵墙共点）不补角。
   * @returns {{
   *   startExtCm: number,
   *   endExtCm: number,
   *   startMiterFill: { endpoint: "start", cornerType: string, triangleCm: number[][], seamCm: number[][] } | null,
   *   endMiterFill: { endpoint: "end", cornerType: string, triangleCm: number[][], seamCm: number[][] } | null,
   *   startTrimClip: { pointCm: number[], dirCm: number[], keepPointCm: number[] } | null,
   *   endTrimClip: { pointCm: number[], dirCm: number[], keepPointCm: number[] } | null
   * }}
   */
  function computeWallEndpointExtensionsCm(wall, floorWalls) {
    if (!wall || !Array.isArray(floorWalls)) {
      return emptyWallEndpointExtensionsCm();
    }
    if (!Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
      return emptyWallEndpointExtensionsCm();
    }
    const wid = String(wall.id ?? "").trim();
    const sx = snap(Number(wall.start[0]));
    const sy = snap(Number(wall.start[1]));
    const ex = snap(Number(wall.end[0]));
    const ey = snap(Number(wall.end[1]));
    if (![sx, sy, ex, ey].every((v) => Number.isFinite(v))) {
      return emptyWallEndpointExtensionsCm();
    }
    const wdx = ex - sx;
    const wdy = ey - sy;
    const wlen = Math.hypot(wdx, wdy);
    if (wlen < 1e-6) return emptyWallEndpointExtensionsCm();
    const ux = wdx / wlen;
    const uy = wdy / wlen;
    const wallOrientationRaw = String(wall.orientation ?? "").trim().toLowerCase();
    const wallOrientation =
      wallOrientationRaw === "vertical" || wallOrientationRaw === "horizontal"
        ? wallOrientationRaw
        : Math.abs(wdy) >= Math.abs(wdx)
          ? "vertical"
          : "horizontal";

    let startExtCm = 0;
    let endExtCm = 0;
    let startTrimCm = 0;
    let endTrimCm = 0;
    let startMiterFill = null;
    let endMiterFill = null;
    let startTrimClip = null;
    let endTrimClip = null;
    const eps2 = WALL_JOIN_POINT_EPS_CM * WALL_JOIN_POINT_EPS_CM;
    const tMin = WALL_JOIN_SEGMENT_INTERIOR_T;
    const startMiterInfo = getLCornerMiterInfoAtPlanPoint(sx, sy, floorWalls, wallOrientation);
    const endMiterInfo = getLCornerMiterInfoAtPlanPoint(ex, ey, floorWalls, wallOrientation);
    const startMiter = !!startMiterInfo;
    const endMiter = !!endMiterInfo;

    function trimClipForOtherWallSide(px, py, dirIntoWallX, dirIntoWallY, otherUx, otherUy, otherHalfTh) {
      const cross = Math.abs(dirIntoWallX * otherUy - dirIntoWallY * otherUx);
      if (cross <= WALL_JOIN_PARALLEL_CROSS_MAX) return null;
      const nx = -otherUy;
      const ny = otherUx;
      const sideSign = dirIntoWallX * nx + dirIntoWallY * ny >= 0 ? 1 : -1;
      const sideX = px + nx * sideSign * otherHalfTh;
      const sideY = py + ny * sideSign * otherHalfTh;
      const keepOffset = Math.max(otherHalfTh + 1, 2);
      return {
        pointCm: [sideX, sideY],
        dirCm: [otherUx, otherUy],
        keepPointCm: [px + dirIntoWallX * keepOffset, py + dirIntoWallY * keepOffset],
      };
    }

    function endpointTrimForSplitMain(px, py, dirIntoWallX, dirIntoWallY) {
      /** @type {{ ux: number, uy: number, halfTh: number }[]} */
      const touches = [];
      for (const other of floorWalls) {
        if (!other || !Array.isArray(other.start) || !Array.isArray(other.end) || other.start.length < 2 || other.end.length < 2) {
          continue;
        }
        const oid = String(other.id ?? "").trim();
        if (wid && oid && wid === oid) continue;
        const ax = snap(Number(other.start[0]));
        const ay = snap(Number(other.start[1]));
        const bx = snap(Number(other.end[0]));
        const by = snap(Number(other.end[1]));
        if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
        const segLen = Math.hypot(bx - ax, by - ay);
        if (segLen < 1e-6) continue;
        const dA2 = (px - ax) * (px - ax) + (py - ay) * (py - ay);
        const dB2 = (px - bx) * (px - bx) + (py - by) * (py - by);
        if (dA2 > eps2 && dB2 > eps2) continue;
        const othTh = Number(other.thickness);
        const halfTh = Math.max(0, (Number.isFinite(othTh) && othTh > 0 ? othTh : 10) / 2);
        if (halfTh < 1e-6) continue;
        touches.push({ ux: (bx - ax) / segLen, uy: (by - ay) / segLen, halfTh });
      }
      if (touches.length < 2) return { trim: 0, clip: null };
      let trim = 0;
      let clip = null;
      for (let i = 0; i < touches.length; i++) {
        for (let j = i + 1; j < touches.length; j++) {
          const a = touches[i];
          const b = touches[j];
          const pairCross = Math.abs(a.ux * b.uy - a.uy * b.ux);
          if (pairCross > WALL_JOIN_PARALLEL_CROSS_MAX) continue;
          const alignA = Math.abs(ux * a.uy - uy * a.ux);
          const alignB = Math.abs(ux * b.uy - uy * b.ux);
          if (alignA <= WALL_JOIN_PARALLEL_CROSS_MAX || alignB <= WALL_JOIN_PARALLEL_CROSS_MAX) continue;
          const other = a.halfTh >= b.halfTh ? a : b;
          const trimCandidate = other.halfTh / Math.max(alignA, 1e-6);
          if (trimCandidate > trim) {
            trim = trimCandidate;
            clip = trimClipForOtherWallSide(px, py, dirIntoWallX, dirIntoWallY, other.ux, other.uy, other.halfTh);
          }
        }
      }
      return { trim, clip };
    }

    for (const other of floorWalls) {
      if (!other || !Array.isArray(other.start) || !Array.isArray(other.end) || other.start.length < 2 || other.end.length < 2) {
        continue;
      }
      const oid = String(other.id ?? "").trim();
      if (wid && oid && wid === oid) continue;

      const ax = snap(Number(other.start[0]));
      const ay = snap(Number(other.start[1]));
      const bx = snap(Number(other.end[0]));
      const by = snap(Number(other.end[1]));
      if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
      const otherLen = Math.hypot(bx - ax, by - ay);
      if (otherLen < 1e-6) continue;
      const otherUx = (bx - ax) / otherLen;
      const otherUy = (by - ay) / otherLen;

      const otherTh = Number(other.thickness);
      const candidate = Math.max(0, (Number.isFinite(otherTh) && otherTh > 0 ? otherTh : 10) / 2);
      if (candidate < 1e-6) continue;
      const crossMag = Math.abs(ux * otherUy - uy * otherUx);
      const trimCandidate = crossMag > WALL_JOIN_PARALLEL_CROSS_MAX
        ? candidate / Math.max(crossMag, 1e-6)
        : candidate;

      const sHit = dist2PointToSegmentCm(sx, sy, ax, ay, bx, by);
      const eHit = dist2PointToSegmentCm(ex, ey, ax, ay, bx, by);

      if (startMiter || sHit.dist2 <= eps2) {
        const startOnOtherSegment = sHit.dist2 <= eps2;
        const startOnOtherInterior = startOnOtherSegment && sHit.t > tMin && sHit.t < 1 - tMin;
        const startOnOtherEndpoint =
          startOnOtherSegment &&
          (((sx - ax) * (sx - ax) + (sy - ay) * (sy - ay) <= eps2) ||
            ((sx - bx) * (sx - bx) + (sy - by) * (sy - by) <= eps2));
        if (startMiter && startOnOtherEndpoint) {
          startExtCm = Math.max(startExtCm, candidate);
        }
        if (startOnOtherInterior) {
          if (trimCandidate > -startTrimCm) {
            startTrimCm = -trimCandidate;
            startTrimClip = trimClipForOtherWallSide(sx, sy, ux, uy, otherUx, otherUy, candidate);
          }
        }
      }

      if (endMiter || eHit.dist2 <= eps2) {
        const endOnOtherSegment = eHit.dist2 <= eps2;
        const endOnOtherInterior = endOnOtherSegment && eHit.t > tMin && eHit.t < 1 - tMin;
        const endOnOtherEndpoint =
          endOnOtherSegment &&
          (((ex - ax) * (ex - ax) + (ey - ay) * (ey - ay) <= eps2) ||
            ((ex - bx) * (ex - bx) + (ey - by) * (ey - by) <= eps2));
        if (endMiter && endOnOtherEndpoint) {
          endExtCm = Math.max(endExtCm, candidate);
        }
        if (endOnOtherInterior) {
          if (trimCandidate > -endTrimCm) {
            endTrimCm = -trimCandidate;
            endTrimClip = trimClipForOtherWallSide(ex, ey, -ux, -uy, otherUx, otherUy, candidate);
          }
        }
      }
    }

    if (startTrimCm < 0) startExtCm = startTrimCm;
    if (endTrimCm < 0) endExtCm = endTrimCm;
    if (startMiterInfo && startExtCm > WALL_HOLE_EPS) {
      startMiterFill = {
        endpoint: "start",
        cornerType: startMiterInfo.cornerType,
        triangleCm: startMiterInfo.triangleCm.map((pt) => [pt[0], pt[1]]),
        seamCm: startMiterInfo.seamCm.map((pt) => [pt[0], pt[1]]),
      };
      startExtCm = -startExtCm;
    }
    if (endMiterInfo && endExtCm > WALL_HOLE_EPS) {
      endMiterFill = {
        endpoint: "end",
        cornerType: endMiterInfo.cornerType,
        triangleCm: endMiterInfo.triangleCm.map((pt) => [pt[0], pt[1]]),
        seamCm: endMiterInfo.seamCm.map((pt) => [pt[0], pt[1]]),
      };
      endExtCm = -endExtCm;
    }
    if (startExtCm >= 0) {
      const tTrim = endpointTrimForSplitMain(sx, sy, ux, uy);
      if (tTrim.trim > 1e-6) {
        startExtCm = -tTrim.trim;
        startTrimClip = tTrim.clip;
      }
    }
    if (endExtCm >= 0) {
      const tTrim = endpointTrimForSplitMain(ex, ey, -ux, -uy);
      if (tTrim.trim > 1e-6) {
        endExtCm = -tTrim.trim;
        endTrimClip = tTrim.clip;
      }
    }

    return { startExtCm, endExtCm, startMiterFill, endMiterFill, startTrimClip, endTrimClip };
  }

  /**
   * 门/窗：wallId + pos（cm，从墙 start 沿中心线到洞口中心）+ width/height（cm）
   * 转为墙体局部 X（沿墙）× Y（向上）的矩形洞，用于从墙盒体中挖空（网格剖分）。
   */
  function collectWallOpeningHolesLocal(wall, floor, lenWorld, lenCm, hM, s, startOffsetCm = 0) {
    const wid = String(wall?.id ?? "").trim();
    if (!wid || !Number.isFinite(lenCm) || lenCm < 1e-6) return [];
    const holes = [];
    const halfLen = lenWorld / 2;

    function pushHole(x0m, x1m, y0m, y1m) {
      const x0 = Math.max(-halfLen, Math.min(x0m, x1m));
      const x1 = Math.min(halfLen, Math.max(x0m, x1m));
      const ya = Math.max(0, Math.min(y0m, y1m));
      const yb = Math.min(hM, Math.max(y0m, y1m));
      if (x1 - x0 < WALL_HOLE_EPS || yb - ya < WALL_HOLE_EPS) return;
      holes.push({ x0, x1, y0: ya, y1: yb });
    }

    for (const d of floor?.doors || []) {
      if (String(d?.wallId ?? "").trim() !== wid) continue;
      const pos = Number(d.pos);
      const wcm = Number(d.width);
      const hcm = Number(d.height);
      if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) continue;
      const openingClearanceCm = 0.03;
      const wM = ((wcm + openingClearanceCm * 2) * s) / 100;
      const hMWithClearance = Math.min(((hcm + openingClearanceCm) * s) / 100, hM);
      const centerX = -halfLen + ((startOffsetCm + pos) / lenCm) * lenWorld;
      pushHole(centerX - wM / 2, centerX + wM / 2, 0, hMWithClearance);
    }
    for (const win of floor?.windows || []) {
      if (String(win?.wallId ?? "").trim() !== wid) continue;
      const pos = Number(win.pos);
      const wcm = Number(win.width);
      const hcm = Number(win.height);
      const altCm = Number(win.altitude ?? win.alt ?? win.sillHeightCm ?? 0);
      if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) continue;
      const wM = (wcm * s) / 100;
      const centerX = -halfLen + ((startOffsetCm + pos) / lenCm) * lenWorld;
      const y0 = (altCm * s) / 100;
      const y1 = y0 + (hcm * s) / 100;
      pushHole(centerX - wM / 2, centerX + wM / 2, y0, y1);
    }
    return holes;
  }

  function mergeSplitEdges(a, b, extra) {
    const set = new Set([a, b]);
    for (const x of extra) {
      if (Number.isFinite(x)) set.add(x);
    }
    return [...set].sort((u, v) => u - v);
  }

  function mergeIntervalRanges(ranges, tol = 1e-6) {
    const clean = (ranges || [])
      .map((r) => {
        const x0 = Number(r?.x0);
        const x1 = Number(r?.x1);
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
        return x0 <= x1 ? { x0, x1 } : { x0: x1, x1: x0 };
      })
      .filter((r) => r && r.x1 - r.x0 > tol)
      .sort((a, b) => a.x0 - b.x0);
    if (!clean.length) return [];
    const out = [clean[0]];
    for (let i = 1; i < clean.length; i++) {
      const prev = out[out.length - 1];
      const cur = clean[i];
      if (cur.x0 <= prev.x1 + tol) {
        prev.x1 = Math.max(prev.x1, cur.x1);
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  function intervalRangeCovers(rangeList, x0, x1, tol = WALL_HOLE_EPS) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    return (rangeList || []).some((r) => a >= r.x0 - tol && b <= r.x1 + tol);
  }

  function mergeIntervalRanges(ranges, tol = 1e-6) {
    const clean = (ranges || [])
      .map((r) => {
        const x0 = Number(r?.x0);
        const x1 = Number(r?.x1);
        if (!Number.isFinite(x0) || !Number.isFinite(x1)) return null;
        return x0 <= x1 ? { x0, x1 } : { x0: x1, x1: x0 };
      })
      .filter((r) => r && r.x1 - r.x0 > tol)
      .sort((a, b) => a.x0 - b.x0);
    if (!clean.length) return [];
    const out = [clean[0]];
    for (let i = 1; i < clean.length; i++) {
      const prev = out[out.length - 1];
      const cur = clean[i];
      if (cur.x0 <= prev.x1 + tol) {
        prev.x1 = Math.max(prev.x1, cur.x1);
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  function intervalRangeCovers(rangeList, x0, x1, tol = WALL_HOLE_EPS) {
    const a = Math.min(x0, x1);
    const b = Math.max(x0, x1);
    return (rangeList || []).some((r) => a >= r.x0 - tol && b <= r.x1 + tol);
  }

  /**
   * 将墙体分段 box 的 UV 重映射到整堵墙统一坐标：
   * U 沿墙长 [u0,u1]，V 沿墙高 [v0,v1]，避免门窗切段后贴图断裂。
   * @param {import("three").BoxGeometry} geo
   * @param {number} u0
   * @param {number} u1
   * @param {number} v0
   * @param {number} v1
   */
  function remapWallBoxUvToWallSpan(geo, u0, u1, v0 = 0, v1 = 1) {
    if (!geo?.attributes?.position || !geo?.attributes?.uv) return;
    const w = Number(geo.parameters?.width);
    const h = Number(geo.parameters?.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || Math.abs(w) < 1e-9 || Math.abs(h) < 1e-9) return;
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const tx = x / w + 0.5;
      const ty = y / h + 0.5;
      uv.setXY(i, u0 + tx * (u1 - u0), v0 + ty * (v1 - v0));
    }
    uv.needsUpdate = true;
  }

  function removeGeometryGroupsByMaterialIndex(geo, materialIndices) {
    if (!geo?.index || !Array.isArray(geo.groups) || !geo.groups.length) return;
    const skip = new Set((materialIndices || []).map(Number).filter((v) => Number.isFinite(v)));
    if (!skip.size) return;
    const oldIndex = geo.index.array;
    const kept = [];
    const groups = [];
    for (const group of geo.groups) {
      if (skip.has(group.materialIndex)) continue;
      const start = kept.length;
      const end = group.start + group.count;
      for (let i = group.start; i < end; i++) kept.push(oldIndex[i]);
      groups.push({ start, count: group.count, materialIndex: group.materialIndex });
    }
    geo.setIndex(kept);
    geo.clearGroups();
    for (const group of groups) geo.addGroup(group.start, group.count, group.materialIndex);
  }

  function suppressWallBoxFaces(geo, opts = {}) {
    const skip = [];
    if (opts.skipEndCap) skip.push(0);
    if (opts.skipStartCap) skip.push(1);
    if (opts.skipTopCap) skip.push(2);
    if (opts.skipBottomCap) skip.push(3);
    if (opts.skipFaceA) skip.push(4);
    if (opts.skipFaceB) skip.push(5);
    removeGeometryGroupsByMaterialIndex(geo, skip);
  }

  /** @param {number[][]} pts */
  function polygonSignedAreaCm2(pts) {
    if (!Array.isArray(pts) || pts.length < 3) return 0;
    let s = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      s += x1 * y2 - x2 * y1;
    }
    return s / 2;
  }

  function polygonAabbCm(pts) {
    if (!Array.isArray(pts) || !pts.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  function lineIntersection2d(a1, a2, b1, b2) {
    const x1 = a1[0];
    const y1 = a1[1];
    const x2 = a2[0];
    const y2 = a2[1];
    const x3 = b1[0];
    const y3 = b1[1];
    const x4 = b2[0];
    const y4 = b2[1];
    const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(den) < 1e-9) return null;
    const n1 = x1 * y2 - y1 * x2;
    const n2 = x3 * y4 - y3 * x4;
    const x = (n1 * (x3 - x4) - (x1 - x2) * n2) / den;
    const y = (n1 * (y3 - y4) - (y1 - y2) * n2) / den;
    return [x, y];
  }

  function clipPolygonByEdge(subject, cp1, cp2, clipIsCcw) {
    const out = [];
    if (!Array.isArray(subject) || !subject.length) return out;
    const ex = cp2[0] - cp1[0];
    const ey = cp2[1] - cp1[1];
    const edgeEps = 1e-7;
    function isInside(p) {
      const cross = ex * (p[1] - cp1[1]) - ey * (p[0] - cp1[0]);
      return clipIsCcw ? cross >= -edgeEps : cross <= edgeEps;
    }
    let s = subject[subject.length - 1];
    for (const e of subject) {
      const sIn = isInside(s);
      const eIn = isInside(e);
      if (eIn) {
        if (!sIn) {
          const ip = lineIntersection2d(s, e, cp1, cp2);
          if (ip) out.push(ip);
        }
        out.push(e);
      } else if (sIn) {
        const ip = lineIntersection2d(s, e, cp1, cp2);
        if (ip) out.push(ip);
      }
      s = e;
    }
    return out;
  }

  function intersectConvexPolygons(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return [];
    let out = a.slice();
    const clipIsCcw = polygonSignedAreaCm2(b) >= 0;
    for (let i = 0; i < b.length; i++) {
      const cp1 = b[i];
      const cp2 = b[(i + 1) % b.length];
      out = clipPolygonByEdge(out, cp1, cp2, clipIsCcw);
      if (!out.length) return [];
    }
    return out;
  }

  function makeWallQuadFromSegmentCm(seg, thicknessCm) {
    const x1 = Number(seg?.x1);
    const y1 = Number(seg?.y1);
    const x2 = Number(seg?.x2);
    const y2 = Number(seg?.y2);
    if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const half = (Number.isFinite(thicknessCm) && thicknessCm > 0 ? thicknessCm : 10) / 2;
    const nx = (-dy / len) * half;
    const ny = (dx / len) * half;
    return [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ];
  }

  function pointOnSegmentCm(p, a, b, tol = WALL_JOIN_POINT_EPS_CM) {
    const px = Number(p?.[0]);
    const py = Number(p?.[1]);
    const ax = Number(a?.[0]);
    const ay = Number(a?.[1]);
    const bx = Number(b?.[0]);
    const by = Number(b?.[1]);
    if (![px, py, ax, ay, bx, by].every((v) => Number.isFinite(v))) return false;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(px - ax, py - ay) <= tol;
    const cross = Math.abs((px - ax) * dy - (py - ay) * dx);
    if (cross > tol * len) return false;
    const dot = (px - ax) * dx + (py - ay) * dy;
    return dot >= -tol * len && dot <= len * len + tol * len;
  }

  function segmentOnSegmentCm(a, b, c, d, tol = WALL_JOIN_POINT_EPS_CM) {
    return pointOnSegmentCm(a, c, d, tol) && pointOnSegmentCm(b, c, d, tol);
  }

  function pointOnSegmentCm(p, a, b, tol = WALL_JOIN_POINT_EPS_CM) {
    const px = Number(p?.[0]);
    const py = Number(p?.[1]);
    const ax = Number(a?.[0]);
    const ay = Number(a?.[1]);
    const bx = Number(b?.[0]);
    const by = Number(b?.[1]);
    if (![px, py, ax, ay, bx, by].every((v) => Number.isFinite(v))) return false;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(px - ax, py - ay) <= tol;
    const cross = Math.abs((px - ax) * dy - (py - ay) * dx);
    if (cross > tol * len) return false;
    const dot = (px - ax) * dx + (py - ay) * dy;
    return dot >= -tol * len && dot <= len * len + tol * len;
  }

  function segmentOnSegmentCm(a, b, c, d, tol = WALL_JOIN_POINT_EPS_CM) {
    return pointOnSegmentCm(a, c, d, tol) && pointOnSegmentCm(b, c, d, tol);
  }

  function polygonArea2d(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return area / 2;
  }

  function convexHull2d(points) {
    const clean = [];
    const seen = new Set();
    for (const p of points || []) {
      const x = Number(p?.[0]);
      const y = Number(p?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const key = `${Math.round(x * 1e7)}|${Math.round(y * 1e7)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push([x, y]);
    }
    if (clean.length < 3) return clean;
    clean.sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
    function cross(o, a, b) {
      return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    }
    const lower = [];
    for (const p of clean) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = clean.length - 1; i >= 0; i--) {
      const p = clean[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
      upper.push(p);
    }
    const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
    return polygonArea2d(hull) < 0 ? hull.reverse() : hull;
  }

  function clipLocalPolygonByXRange(poly, xMin, xMax) {
    if (!Array.isArray(poly) || poly.length < 3) return [];
    const eps = 1e-8;
    function clip(subject, inside, intersect) {
      const out = [];
      if (!subject.length) return out;
      let s = subject[subject.length - 1];
      for (const e of subject) {
        const sIn = inside(s);
        const eIn = inside(e);
        if (eIn) {
          if (!sIn) out.push(intersect(s, e));
          out.push(e);
        } else if (sIn) {
          out.push(intersect(s, e));
        }
        s = e;
      }
      return out;
    }
    function intersectAtX(a, b, x) {
      const dx = b[0] - a[0];
      if (Math.abs(dx) < eps) return [x, a[1]];
      const t = (x - a[0]) / dx;
      return [x, a[1] + (b[1] - a[1]) * t];
    }
    let out = poly.slice();
    out = clip(out, (p) => p[0] >= xMin - eps, (a, b) => intersectAtX(a, b, xMin));
    out = clip(out, (p) => p[0] <= xMax + eps, (a, b) => intersectAtX(a, b, xMax));
    return out.length >= 3 && Math.abs(polygonArea2d(out)) > 1e-10 ? out : [];
  }

  function clipLocalPolygonByLineKeepPoint(poly, lineA, lineB, keepPoint) {
    if (!Array.isArray(poly) || poly.length < 3) return [];
    const ax = Number(lineA?.[0]);
    const az = Number(lineA?.[1]);
    const bx = Number(lineB?.[0]);
    const bz = Number(lineB?.[1]);
    const kx = Number(keepPoint?.[0]);
    const kz = Number(keepPoint?.[1]);
    if (![ax, az, bx, bz, kx, kz].every((v) => Number.isFinite(v))) return poly;
    const lx = bx - ax;
    const lz = bz - az;
    if (Math.hypot(lx, lz) < 1e-9) return poly;
    const eps = 1e-8;
    const keepCross = lx * (kz - az) - lz * (kx - ax);
    const keepSign = keepCross >= 0 ? 1 : -1;
    function side(p) {
      return keepSign * (lx * (p[1] - az) - lz * (p[0] - ax));
    }
    const out = [];
    let s = poly[poly.length - 1];
    for (const e of poly) {
      const sIn = side(s) >= -eps;
      const eIn = side(e) >= -eps;
      if (eIn) {
        if (!sIn) {
          const ip = lineIntersection2d(s, e, [ax, az], [bx, bz]);
          if (ip) out.push(ip);
        }
        out.push(e);
      } else if (sIn) {
        const ip = lineIntersection2d(s, e, [ax, az], [bx, bz]);
        if (ip) out.push(ip);
      }
      s = e;
    }
    return out.length >= 3 && Math.abs(polygonArea2d(out)) > 1e-10 ? out : [];
  }

  function makeWallPlanPrismGeometryLocal(polyXZ, y0, y1, lenWorld, hM, options = {}) {
    if (!Array.isArray(polyXZ) || polyXZ.length < 3) return null;
    if (!Number.isFinite(y0) || !Number.isFinite(y1) || y1 - y0 < WALL_HOLE_EPS) return null;
    let poly = polyXZ.map((p) => [Number(p?.[0]), Number(p?.[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (poly.length < 3) return null;
    if (polygonArea2d(poly) < 0) poly = poly.slice().reverse();
    if (Math.abs(polygonArea2d(poly)) < 1e-10) return null;
    const positions = [];
    const uvs = [];
    const groups = [];
    const halfSpan = Math.max(1e-9, lenWorld / 2);
    const edgeSkipTol = Math.max(WALL_HOLE_EPS, 1e-7);
    const skipCapAtX = Array.isArray(options?.skipCapAtX)
      ? options.skipCapAtX.map(Number).filter((x) => Number.isFinite(x))
      : [];
    const skipSideEdges = Array.isArray(options?.skipSideEdges)
      ? options.skipSideEdges.map((seg) => {
          if (!Array.isArray(seg) || seg.length < 2) return null;
          const a = seg[0];
          const b = seg[1];
          const out = [
            [Number(a?.[0]), Number(a?.[1])],
            [Number(b?.[0]), Number(b?.[1])],
          ];
          return out.flat().every((v) => Number.isFinite(v)) ? out : null;
        }).filter(Boolean)
      : [];
    const skipBottomFace = !!options?.skipBottomFace;
    const skipTopFace = !!options?.skipTopFace;

    function uvFor(v) {
      return [(v[0] + halfSpan) / Math.max(1e-9, lenWorld), Number.isFinite(hM) && hM > 1e-9 ? v[1] / hM : 0];
    }
    function pushVertex(v) {
      positions.push(v[0], v[1], v[2]);
      const uv = uvFor(v);
      uvs.push(uv[0], uv[1]);
    }
    function pushTri(a, b, c, materialIndex) {
      const start = positions.length / 3;
      pushVertex(a);
      pushVertex(b);
      pushVertex(c);
      groups.push({ start, count: 3, materialIndex });
    }
    function materialIndexForEdge(a, b) {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      if (Math.abs(dz) <= 1e-8 && Math.abs(dx) > 1e-8) {
        return (a[1] + b[1]) / 2 >= 0 ? 4 : 5;
      }
      if (Math.abs(dx) <= 1e-8) return 0;
      const extreme = (a[0] + b[0]) / 2 < 0
        ? (a[0] <= b[0] ? a : b)
        : (a[0] >= b[0] ? a : b);
      return extreme[1] >= 0 ? 4 : 5;
    }
    function edgeMatchesSkipSegment(a, b, seg) {
      const sx = seg[0][0];
      const sz = seg[0][1];
      const ex = seg[1][0];
      const ez = seg[1][1];
      const svx = ex - sx;
      const svz = ez - sz;
      const evx = b[0] - a[0];
      const evz = b[1] - a[1];
      const sLen2 = svx * svx + svz * svz;
      const eLen2 = evx * evx + evz * evz;
      if (sLen2 < 1e-12 || eLen2 < 1e-12) return false;
      const sLen = Math.sqrt(sLen2);
      const eLen = Math.sqrt(eLen2);
      const dirTol = edgeSkipTol * Math.max(1, sLen * eLen);
      if (Math.abs(evx * svz - evz * svx) > dirTol) return false;
      const lineTol = edgeSkipTol * Math.max(1, sLen);
      const crossA = Math.abs((a[0] - sx) * svz - (a[1] - sz) * svx);
      const crossB = Math.abs((b[0] - sx) * svz - (b[1] - sz) * svx);
      if (crossA > lineTol || crossB > lineTol) return false;
      const ta = ((a[0] - sx) * svx + (a[1] - sz) * svz) / sLen2;
      const tb = ((b[0] - sx) * svx + (b[1] - sz) * svz) / sLen2;
      const tTol = edgeSkipTol / Math.max(sLen, 1e-9) + 1e-6;
      return Math.min(ta, tb) >= -tTol && Math.max(ta, tb) <= 1 + tTol;
    }
    function shouldSkipSideFace(a, b) {
      if (skipCapAtX.length && Math.abs(a[0] - b[0]) <= edgeSkipTol) {
        const edgeX = (a[0] + b[0]) / 2;
        if (skipCapAtX.some((x) => Math.abs(edgeX - x) <= edgeSkipTol)) return true;
      }
      return skipSideEdges.some((seg) => edgeMatchesSkipSegment(a, b, seg));
    }

    for (let i = 1; i < poly.length - 1; i++) {
      const p0 = poly[0];
      const p1 = poly[i];
      const p2 = poly[i + 1];
      if (!skipBottomFace) {
        pushTri([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p2[0], y0, p2[1]], 3);
      }
      if (!skipTopFace) {
        pushTri([p0[0], y1, p0[1]], [p2[0], y1, p2[1]], [p1[0], y1, p1[1]], 2);
      }
    }
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (shouldSkipSideFace(a, b)) continue;
      const mi = materialIndexForEdge(a, b);
      const ab = [a[0], y0, a[1]];
      const bb = [b[0], y0, b[1]];
      const bt = [b[0], y1, b[1]];
      const at = [a[0], y1, a[1]];
      pushTri(ab, bt, bb, mi);
      pushTri(ab, at, bt, mi);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
    geo.computeVertexNormals();
    return geo;
  }

  function getExtendedWallSegmentCm(wall, floorWalls) {
    if (!wall || !Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
      return null;
    }
    const sx = snap(Number(wall.start[0]));
    const sy = snap(Number(wall.start[1]));
    const ex = snap(Number(wall.end[0]));
    const ey = snap(Number(wall.end[1]));
    const dx = ex - sx;
    const dy = ey - sy;
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || len < 1e-6) return null;
    const ux = dx / len;
    const uy = dy / len;
    const { startExtCm, endExtCm } = computeWallEndpointExtensionsCm(wall, floorWalls || []);
    return {
      x1: sx - ux * startExtCm,
      y1: sy - uy * startExtCm,
      x2: ex + ux * endExtCm,
      y2: ey + uy * endExtCm,
    };
  }

  function wallEndCapCoveredByOtherWallCm(wall, floorWalls, capCenterX, capCenterY, ux, uy, thicknessCm) {
    if (!Array.isArray(floorWalls) || !Number.isFinite(capCenterX) || !Number.isFinite(capCenterY)) return false;
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) return false;
    const half = Math.max(0, (Number.isFinite(thicknessCm) && thicknessCm > 0 ? thicknessCm : 10) / 2);
    if (half < 1e-6) return false;
    const nx = -uy * half;
    const ny = ux * half;
    const capA = [capCenterX + nx, capCenterY + ny];
    const capB = [capCenterX - nx, capCenterY - ny];
    const wid = String(wall?.id ?? "").trim();
    const tol = Math.max(WALL_JOIN_POINT_EPS_CM, half * 0.05);
    for (const other of floorWalls) {
      if (!other || other === wall) continue;
      const oid = String(other?.id ?? "").trim();
      if (wid && oid && wid === oid) continue;
      const seg = getExtendedWallSegmentCm(other, floorWalls);
      if (!seg) continue;
      const othTh = Number(other?.thickness);
      const quad = makeWallQuadFromSegmentCm(seg, Number.isFinite(othTh) && othTh > 0 ? othTh : 10);
      if (!quad || quad.length < 3) continue;
      for (let i = 0; i < quad.length; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % quad.length];
        if (segmentOnSegmentCm(capA, capB, a, b, tol)) return true;
      }
    }
    return false;
  }

  function wallEndCapCoveredByOtherWallCm(wall, floorWalls, capCenterX, capCenterY, ux, uy, thicknessCm) {
    if (!Array.isArray(floorWalls) || !Number.isFinite(capCenterX) || !Number.isFinite(capCenterY)) return false;
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) return false;
    const half = Math.max(0, (Number.isFinite(thicknessCm) && thicknessCm > 0 ? thicknessCm : 10) / 2);
    if (half < 1e-6) return false;
    const nx = -uy * half;
    const ny = ux * half;
    const capA = [capCenterX + nx, capCenterY + ny];
    const capB = [capCenterX - nx, capCenterY - ny];
    const wid = String(wall?.id ?? "").trim();
    const tol = Math.max(WALL_JOIN_POINT_EPS_CM, half * 0.05);
    for (const other of floorWalls) {
      if (!other || other === wall) continue;
      const oid = String(other?.id ?? "").trim();
      if (wid && oid && wid === oid) continue;
      const seg = getExtendedWallSegmentCm(other, floorWalls);
      if (!seg) continue;
      const othTh = Number(other?.thickness);
      const quad = makeWallQuadFromSegmentCm(seg, Number.isFinite(othTh) && othTh > 0 ? othTh : 10);
      if (!quad || quad.length < 3) continue;
      for (let i = 0; i < quad.length; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % quad.length];
        if (segmentOnSegmentCm(capA, capB, a, b, tol)) return true;
      }
    }
    return false;
  }

  function computeParallelWallSideOverlapRangesLocal(wall, floorWalls, seg, lenCm, ux, uy, thicknessCm, scaleMetersPerCm) {
    const empty = { faceA: [], faceB: [], splitXs: [] };
    if (!wall || !Array.isArray(floorWalls) || !seg) return empty;
    if (!Number.isFinite(lenCm) || lenCm < 1e-6) return empty;
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) return empty;
    const half = Math.max(0, (Number.isFinite(thicknessCm) && thicknessCm > 0 ? thicknessCm : 10) / 2);
    if (half < 1e-6) return empty;
    const wid = String(wall?.id ?? "").trim();
    const tol = Math.max(WALL_JOIN_POINT_EPS_CM, half * 0.05);
    const currentStart = [Number(seg.x1), Number(seg.y1)];
    const currentEnd = [Number(seg.x2), Number(seg.y2)];
    if (!currentStart.concat(currentEnd).every((v) => Number.isFinite(v))) return empty;
    const lenScale = Number(scaleMetersPerCm);
    if (!Number.isFinite(lenScale) || lenScale <= 0) return empty;

    function makeSideSegment(baseStart, baseEnd, nx, ny, faceKey, halfTh) {
      return {
        faceKey,
        a: [baseStart[0] + nx * halfTh, baseStart[1] + ny * halfTh],
        b: [baseEnd[0] + nx * halfTh, baseEnd[1] + ny * halfTh],
      };
    }

    function lineOverlapOnCurrent(currentSide, otherSide) {
      const crossA = Math.abs((otherSide.a[0] - currentSide.a[0]) * uy - (otherSide.a[1] - currentSide.a[1]) * ux);
      const crossB = Math.abs((otherSide.b[0] - currentSide.a[0]) * uy - (otherSide.b[1] - currentSide.a[1]) * ux);
      if (crossA > tol || crossB > tol) return null;
      const ta = (otherSide.a[0] - currentSide.a[0]) * ux + (otherSide.a[1] - currentSide.a[1]) * uy;
      const tb = (otherSide.b[0] - currentSide.a[0]) * ux + (otherSide.b[1] - currentSide.a[1]) * uy;
      const start = Math.max(0, Math.min(ta, tb));
      const end = Math.min(lenCm, Math.max(ta, tb));
      return end - start > tol ? { start, end } : null;
    }

    const currentNormalPos = [-uy, ux];
    const currentSides = {
      faceA: makeSideSegment(currentStart, currentEnd, currentNormalPos[0], currentNormalPos[1], "faceA", half),
      faceB: makeSideSegment(currentStart, currentEnd, -currentNormalPos[0], -currentNormalPos[1], "faceB", half),
    };
    const rangesCm = { faceA: [], faceB: [] };

    for (const other of floorWalls) {
      if (!other || other === wall) continue;
      const oid = String(other?.id ?? "").trim();
      if (wid && oid && wid === oid) continue;
      const otherSeg = getExtendedWallSegmentCm(other, floorWalls);
      if (!otherSeg) continue;
      const ox1 = Number(otherSeg.x1);
      const oy1 = Number(otherSeg.y1);
      const ox2 = Number(otherSeg.x2);
      const oy2 = Number(otherSeg.y2);
      if (![ox1, oy1, ox2, oy2].every((v) => Number.isFinite(v))) continue;
      const odx = ox2 - ox1;
      const ody = oy2 - oy1;
      const otherLen = Math.hypot(odx, ody);
      if (otherLen < 1e-6) continue;
      const oux = odx / otherLen;
      const ouy = ody / otherLen;
      const cross = Math.abs(ux * ouy - uy * oux);
      if (cross > WALL_JOIN_PARALLEL_CROSS_MAX) continue;
      const otherTh = Number(other?.thickness);
      const otherHalf = Math.max(0, (Number.isFinite(otherTh) && otherTh > 0 ? otherTh : 10) / 2);
      if (otherHalf < 1e-6) continue;
      const otherNormalPos = [-ouy, oux];
      const otherSides = [
        makeSideSegment([ox1, oy1], [ox2, oy2], otherNormalPos[0], otherNormalPos[1], "faceA", otherHalf),
        makeSideSegment([ox1, oy1], [ox2, oy2], -otherNormalPos[0], -otherNormalPos[1], "faceB", otherHalf),
      ];
      for (const faceKey of ["faceA", "faceB"]) {
        const currentSide = currentSides[faceKey];
        for (const otherSide of otherSides) {
          const overlap = lineOverlapOnCurrent(currentSide, otherSide);
          if (!overlap) continue;
          rangesCm[faceKey].push({
            x0: (-lenCm / 2 + overlap.start) * lenScale,
            x1: (-lenCm / 2 + overlap.end) * lenScale,
          });
        }
      }
    }

    const faceA = mergeIntervalRanges(rangesCm.faceA, WALL_HOLE_EPS);
    const faceB = mergeIntervalRanges(rangesCm.faceB, WALL_HOLE_EPS);
    const splitXs = mergeSplitEdges(
      -((lenCm * lenScale) / 2),
      (lenCm * lenScale) / 2,
      faceA.concat(faceB).flatMap((r) => [r.x0, r.x1]),
    ).filter((x) => x > -((lenCm * lenScale) / 2) + WALL_HOLE_EPS && x < (lenCm * lenScale) / 2 - WALL_HOLE_EPS);
    return { faceA, faceB, splitXs };
  }

  function buildWallOverlapHighlightGroup(floor, cx, cy, s, wallHeightCm, floorOpacity, floorLevelId) {
    const walls = floor?.walls || [];
    if (!walls.length) return null;

    const op = floorOpacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xff3b30),
      emissive: new THREE.Color(0x4a0600),
      emissiveIntensity: 0.32,
      transparent: true,
      opacity: Math.min(0.74, Math.max(0.4, op * 0.7)),
      roughness: 0.58,
      metalness: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    tagFloorplanLayerOpacity(mat, op);

    const g = new THREE.Group();
    g.userData.floorplanWallOverlapGroup = true;
    g.userData.floorplanFloorLevelId = String(floorLevelId ?? "").trim();
    g.renderOrder = 20;
    const seen = new Set();

    const hM = Math.max(0.02, Number(wallHeightCm) / 100);
    const k = s / 100;
    for (const wall of walls) {
      if (!Array.isArray(wall?.start) || wall.start.length < 2 || !Array.isArray(wall?.end) || wall.end.length < 2) continue;
      const sx = snap(Number(wall.start[0]));
      const sy = snap(Number(wall.start[1]));
      const ex = snap(Number(wall.end[0]));
      const ey = snap(Number(wall.end[1]));
      const lenCm = Math.hypot(ex - sx, ey - sy);
      if (!Number.isFinite(lenCm) || lenCm < 1e-6) continue;
      const ux = (ex - sx) / lenCm;
      const uy = (ey - sy) / lenCm;
      const { startExtCm, endExtCm } = computeWallEndpointExtensionsCm(wall, walls);
      const th = Number(wall?.thickness);
      const thickM = Math.max(0.03, ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100);
      const markerThickM = Math.max(0.02, thickM * 0.98);
      const wid = String(wall?.id || "");

      if (startExtCm > WALL_HOLE_EPS) {
        const keyStart = [
          Math.round(sx * 10),
          Math.round(sy * 10),
          Math.round(Math.abs(ux) * 1000),
          Math.round(Math.abs(uy) * 1000),
          Math.round(startExtCm * 10),
          "start",
        ].join("|");
        if (!seen.has(keyStart)) {
          seen.add(keyStart);
          const segLen = ((startExtCm * 2) * s) / 100;
          const geo = new THREE.BoxGeometry(Math.max(0.01, segLen), hM, markerThickM);
          const mesh = new THREE.Mesh(geo, mat);
          const cxCm = sx;
          const cyCm = sy;
          mesh.position.set((cxCm - cx) * k, hM / 2, (cyCm - cy) * k);
          mesh.rotation.y = Math.atan2(uy, ux);
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.renderOrder = 21;
          mesh.userData.floorplanWallOverlap = true;
          mesh.userData.floorplanWallExtension = true;
          mesh.userData.floorplanWallEndpoint = "start";
          mesh.userData.floorplanWallId = wid;
          mesh.userData.floorplanFloorLevelId = String(floorLevelId ?? "").trim();
          g.add(mesh);
        }
      }

      if (endExtCm > WALL_HOLE_EPS) {
        const keyEnd = [
          Math.round(ex * 10),
          Math.round(ey * 10),
          Math.round(Math.abs(ux) * 1000),
          Math.round(Math.abs(uy) * 1000),
          Math.round(endExtCm * 10),
          "end",
        ].join("|");
        if (!seen.has(keyEnd)) {
          seen.add(keyEnd);
          const segLen = ((endExtCm * 2) * s) / 100;
          const geo = new THREE.BoxGeometry(Math.max(0.01, segLen), hM, markerThickM);
          const mesh = new THREE.Mesh(geo, mat);
          const cxCm = ex;
          const cyCm = ey;
          mesh.position.set((cxCm - cx) * k, hM / 2, (cyCm - cy) * k);
          mesh.rotation.y = Math.atan2(uy, ux);
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          mesh.renderOrder = 21;
          mesh.userData.floorplanWallOverlap = true;
          mesh.userData.floorplanWallExtension = true;
          mesh.userData.floorplanWallEndpoint = "end";
          mesh.userData.floorplanWallId = wid;
          mesh.userData.floorplanFloorLevelId = String(floorLevelId ?? "").trim();
          g.add(mesh);
        }
      }
    }
    return g.children.length ? g : null;
  }

  function cellFullyInsideAnyHole(xa, xb, ya, yb, holes) {
    for (const h of holes) {
      if (xa >= h.x0 - WALL_HOLE_EPS && xb <= h.x1 + WALL_HOLE_EPS && ya >= h.y0 - WALL_HOLE_EPS && yb <= h.y1 + WALL_HOLE_EPS) {
        return true;
      }
    }
    return false;
  }

  /**
   * 墙盒：使用墙体 ID 作为材质 key；+Z/−Z 大面按「沿墙位置」取两侧房间，叠加房间墙面材质（roomId_wall）（分段采样，避免整墙只用中点导致卫生间瓷砖铺满相邻房间）。
   */
  function buildWallMesh(wall, floor, cx, cy, s, defaultHeightCm, floorOpacity, wallStyleMat, style, getMaterialForKey, floorLevelId) {
    return buildWallMeshFromModule(
      wall,
      floor,
      cx,
      cy,
      s,
      defaultHeightCm,
      floorOpacity,
      wallStyleMat,
      style,
      getMaterialForKey,
      floorLevelId,
    );
  }

  /**
   * 门洞填充材质（ns 来自 normalizeDoorStyle，缺省为白）
   */
  function doorFillMaterialFromNs(ns, floorOpacity) {
    return doorFillMaterialFromMeshBuilder(ns, floorOpacity);
  }

  /** 与 doorFillMaterialFromNs 中门扇 alpha 一致，供执手同步透明度 */
  function effectiveDoorPanelOpacity(ns, floorOpacity) {
    const op = floorOpacity ?? 1;
    if (ns.isGlass) return Math.min(1, 0.42 * op);
    return op;
  }

  function doorHandleMetalMaterial(panelOpacity, layerOpacityTag) {
    const op = Math.max(0, Math.min(1, panelOpacity));
    const mat = new THREE.MeshStandardMaterial({
      color: 0xa8a8ad,
      metalness: 0.88,
      roughness: 0.32,
      envMapIntensity: 0.55,
      emissive: new THREE.Color(0x000000),
    });
    applyFloorplanSurfaceAlpha(mat, op);
    if (layerOpacityTag != null && Number.isFinite(layerOpacityTag)) {
      tagFloorplanLayerOpacity(mat, layerOpacityTag);
    }
    return mat;
  }

  /**
   * 门执手：薄圆柱底座 + 水平拉条，门扇两面各一组（±Z）
   * @param {THREE.Group} group
   * @param {number} centerX 门扇中心沿墙局部 X
   * @param {number} wM 门宽（m）
   * @param {number} hDoor 门高（m）
   * @param {number} doorDepth 门扇厚度（m）
   * @param {number} panelOpacity 与门扇 mesh 相同的有效透明度（含楼层与玻璃系数）
   */
  function addDoorHandleMeshes(group, centerX, wM, hDoor, doorDepth, panelOpacity, layerOpacityTag, floorLevelIdStr) {
    const hMat = doorHandleMetalMaterial(panelOpacity, layerOpacityTag);
    const handleY = Math.min(Math.max(hDoor * 0.45, 0.35), Math.min(1.0, hDoor - 0.05));
    const handleX = centerX + wM * 0.5 - 0.08;
    const faceOut = doorDepth * 0.5 + 0.008;

    const roseGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.012, 16);
    roseGeo.rotateX(Math.PI / 2);
    const levGeo = new THREE.BoxGeometry(0.12, 0.018, 0.024);

    for (const zSign of [1, -1]) {
      const faceZ = zSign * faceOut;
      const roseZ = faceZ + zSign * 0.006;
      const levZ = faceZ + zSign * 0.02;
      const levCenterX = handleX + zSign * -0.055;

      const rose = new THREE.Mesh(roseGeo, hMat);
      rose.position.set(handleX, handleY, roseZ);
      rose.castShadow = true;
      rose.userData.floorplanDoorFill = true;
      rose.userData.floorplanDoorHandle = true;
      rose.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      group.add(rose);

      const lev = new THREE.Mesh(levGeo, hMat);
      lev.position.set(levCenterX, handleY, levZ);
      lev.castShadow = true;
      lev.userData.floorplanDoorFill = true;
      lev.userData.floorplanDoorHandle = true;
      lev.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      group.add(lev);
    }
  }

  /** texture 路径非空时异步加载 PBR 贴图到门洞填充 mesh */
  function queueDoorFillTextures(mesh, ns) {
    if (!ns) return;
    const t = ns.texture;
    if (!t) return;
    const albedo = String(t.albedo ?? "").trim();
    const rough = String(t.roughness ?? "").trim();
    const normal = String(t.normal ?? "").trim();
    if (!albedo && !rough && !normal) return;

    const loader = new THREE.TextureLoader();
    (async () => {
      const mat = mesh.material;
      if (!mat || !mat.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;

      if (albedo) {
        try {
          const au = resolveTextureAssetUrl(albedo);
          diffTex = await loader.loadAsync(au);
          diffTex.colorSpace = THREE.SRGBColorSpace;
          diffTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] door albedo 贴图加载失败:", e);
        }
      }
      if (rough) {
        try {
          const ru = resolveTextureAssetUrl(rough);
          roughTex = await loader.loadAsync(ru);
          roughTex.colorSpace = THREE.LinearSRGBColorSpace;
          roughTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] door roughness 贴图加载失败:", e);
        }
      }
      if (normal) {
        try {
          const nu = resolveTextureAssetUrl(normal);
          normalTex = await loader.loadAsync(nu);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] door normal 贴图加载失败:", e);
        }
      }

      if (!diffTex && !roughTex && !normalTex) return;

      if (diffTex) mat.map = diffTex;
      if (roughTex) mat.roughnessMap = roughTex;
      if (normalTex) {
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      mat.needsUpdate = true;
    })();
  }

  function buildDoorFillGroup(
    door,
    doorFrame,
    wall,
    floorWalls,
    cx,
    cy,
    s,
    defaultHeightCm,
    floorOpacity,
    styleDoorMat,
    styleDoorFrameMat,
    floorLevelIdStr,
  ) {
    return buildDoorFillGroupFromMeshBuilder(
      door,
      doorFrame,
      wall,
      floorWalls,
      cx,
      cy,
      s,
      defaultHeightCm,
      floorOpacity,
      styleDoorMat,
      styleDoorFrameMat,
      floorLevelIdStr,
    );
  }

  function windowGlassMaterialFromNs(ns, floorOpacity) {
    return windowGlassMaterialFromMeshBuilder(ns, floorOpacity);
  }

  /** 窗玻璃贴图（与门洞逻辑一致） */
  function queueWindowFillTextures(mesh, ns) {
    if (!ns) return;
    const t = ns.texture;
    if (!t) return;
    const albedo = String(t.albedo ?? "").trim();
    const rough = String(t.roughness ?? "").trim();
    const normal = String(t.normal ?? "").trim();
    if (!albedo && !rough && !normal) return;

    const loader = new THREE.TextureLoader();
    (async () => {
      const mat = mesh.material;
      if (!mat || !mat.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;

      if (albedo) {
        try {
          const au = resolveTextureAssetUrl(albedo);
          diffTex = await loader.loadAsync(au);
          diffTex.colorSpace = THREE.SRGBColorSpace;
          diffTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] window albedo 贴图加载失败:", e);
        }
      }
      if (rough) {
        try {
          const ru = resolveTextureAssetUrl(rough);
          roughTex = await loader.loadAsync(ru);
          roughTex.colorSpace = THREE.LinearSRGBColorSpace;
          roughTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] window roughness 贴图加载失败:", e);
        }
      }
      if (normal) {
        try {
          const nu = resolveTextureAssetUrl(normal);
          normalTex = await loader.loadAsync(nu);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] window normal 贴图加载失败:", e);
        }
      }

      if (!diffTex && !roughTex && !normalTex) return;

      if (diffTex) mat.map = diffTex;
      if (roughTex) mat.roughnessMap = roughTex;
      if (normalTex) {
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      mat.needsUpdate = true;
    })();
  }

  /**
   * 窗洞玻璃片（与墙体洞口一致）；无 style 时 normalizeWindowStyle 为白 clear
   */
  function buildWindowGlassGroup(win, wall, floorWalls, cx, cy, s, defaultHeightCm, floorOpacity, styleWinMat, floorLevelIdStr) {
    return buildWindowGlassGroupFromMeshBuilder(
      win,
      wall,
      floorWalls,
      cx,
      cy,
      s,
      defaultHeightCm,
      floorOpacity,
      styleWinMat,
      floorLevelIdStr,
    );
  }

  function setWallSnapEnabled(v) {
    wallSnapEnabled = Boolean(v);
    const btn = document.getElementById("layoutWallSnapToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", wallSnapEnabled);
      btn.setAttribute("aria-pressed", String(wallSnapEnabled));
    }
  }

  function setShadowsEnabled(v) {
    shadowsEnabled = Boolean(v);
    renderer.shadowMap.enabled = shadowsEnabled;
    dirLight.castShadow = shadowsEnabled;
    const btn = document.getElementById("layoutShadowToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", shadowsEnabled);
      btn.setAttribute("aria-pressed", String(shadowsEnabled));
    }
  }

  // ============================================================

  /**
   * 仅更新各楼层「层透明度」系数对应的材质 opacity，避免拖动滑块时全量 rebuild 卡顿。
   * 使用 `__floorplanOpacityPerUnitLayer`（= opacity/层透明度）计算 newOpacity = perUnit * newLayer，
   * 避免层透明度或 opacity 曾为 0 时 ratio 失效；无有效 perUnit 且无法推断时退回 rebuild。
   */
  function applyFloorplanLayerOpacityToScene() {
    return applyFloorplanLayerOpacityToSceneFromCore();
  }

  /**
   * 「仅当前层」开关：只更新各楼层 floor group 的 visible，不 rebuild（避免重复贴图加载）。
   */
  function syncHideOtherFloorsFloorplanVisibility() {
    return syncHideOtherFloorsFloorplanVisibilityFromCore();
  }

  /**
   * 点击楼层 Tab：更新 activeFloor、透明度、仅当前层与标注显隐；仅在 cheap 路径失败时全量 rebuild。
   */
  function applyFloorLevelSelectionChange() {
    return applyFloorLevelSelectionChangeFromCore();
  }

  function effectiveFloorplanStyleKeyFromEntryAndOverride(entry, overrideVal) {
    if (!entry) return "modern_minimal_v1";
    const o = overrideVal != null ? String(overrideVal).trim() : "";
    if (o) return o;
    const fromEntry = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
    if (fromEntry) return fromEntry;
    const fpId = String(entry?.id ?? "").trim();
    const fromPack = fpId ? getDefaultStyleKeyForFloorplan(fpId) : "";
    return fromPack || "modern_minimal_v1";
  }

  function getEffectiveFloorplanStyleKey() {
    return effectiveFloorplanStyleKeyFromEntryAndOverride(currentFloorplanEntry, floorplanStyleKeyOverride);
  }


  /**
   * 安全释放材质（处理单个材质和材质数组）
   * @param {THREE.Material | THREE.Material[]} material
   */
  function disposeMaterialSafely(material) {
    if (!material) return;
    if (Array.isArray(material)) {
      material.forEach(m => {
        if (m && typeof m.dispose === 'function') m.dispose();
      });
    } else if (typeof material.dispose === 'function') {
      material.dispose();
    }
  }

  /**
   * 快速切换风格：只更新材质和光照，不重建几何体
   * @param {string} newStyleKey 新风格key
   * @returns {Promise<boolean>} 是否成功切换
   */
  async function fastStyleSwitch(newStyleKey) {
    return fastStyleSwitchFromCore(newStyleKey);
  }

  /**
   * @param {{ applyDecorFromStyle?: boolean }} [opts]
   *        applyDecorFromStyle：用当前风格 JSON 中的装饰替换场景装饰（切换风格、首次加载户型时）；undo/设计恢复时不要开启。
   */
  async function rebuildFloorplan3D(opts = {}) {
    return rebuildFloorplan3DFromCore(opts);
  }


  function setFloorLevelsVisible() {
    if (!floorLevelRow) return;
    floorLevelRow.replaceChildren();
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    if (!floors.length) {
      if (floorLevelDock) floorLevelDock.hidden = true;
      return;
    }
    if (floorLevelDock) floorLevelDock.hidden = false;
    const active = floorSelectionEnabled ? normalizeFloorIndex(currentFloorplanEntry, currentFloorIndex) : -1;
    for (let i = floors.length - 1; i >= 0; i--) {
      const fl = floors[i];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "layout-floor-level-tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", i === active ? "true" : "false");
      const name = String(fl?.name || "").trim() || `第 ${i + 1} 层`;
      btn.textContent = name;
      btn.title = `切换到 ${name}`;
      if (i === active) btn.classList.add("is-active");
      btn.addEventListener("click", () => {
        if (currentFloorplanEntry) {
          if (i === active) floorSelectionEnabled = false;
          else {
            floorSelectionEnabled = true;
            currentFloorIndex = i;
          }
          syncOtherOpacityUi();
          setFloorLevelsVisible();
          applyFloorLevelSelectionChange();
        }
      });
      floorLevelRow.appendChild(btn);
    }
  }

  function ensureFloorLevelControls() {
    const slot = document.getElementById("layoutEditorSlot");
    if (!slot || floorLevelDock) return;
    const dock = document.createElement("div");
    dock.className = "layout-floor-level-dock";
    dock.hidden = true;
    dock.setAttribute("aria-label", "楼层");
    const row = document.createElement("div");
    row.className = "layout-floor-level-row";
    row.setAttribute("role", "tablist");
    row.setAttribute("aria-label", "选择楼层");
    floorLevelDock = dock;
    floorLevelRow = row;
    dock.appendChild(row);
    // 挂在 slot 上、属性面板之后，z-index 可高于 .properties-panel，避免被遮挡
    slot.appendChild(dock);
    setFloorLevelsVisible();
  }

  function clearFloorplan() {
    return clearFloorplanFromCore();
  }

  /** @param {{ preserveSurfaceOverrides?: boolean, preserveStyleKeyOverride?: boolean, floorIndex?: number, skipDecorFromStyleMerge?: boolean }} [options] */
  async function applyFloorplanEntryAtWorld(entry, _wx, _wy, options = {}) {
    return applyFloorplanEntryAtWorldFromCore(entry, _wx, _wy, options);
  }

  /** x,y 为以编辑区中心为原点的 cm（约 [-1500,1500]） */
  function setFurnitureFromLayoutCm(group, cx, cy, rotDeg, opts = {}) {
    const wallSnap = Boolean(opts.wallSnap);
    const fp = group.userData.footprint;
    let c = clampFurnitureCentered(cx, cy, rotDeg, fp.hw, fp.hh);
    if (wallSnap) {
      c = snapFurnitureCenterToWalls(c.x, c.y, rotDeg, fp.hw, fp.hh, group.userData.floorId);
      c = clampFurnitureCentered(c.x, c.y, rotDeg, fp.hw, fp.hh);
    }
    const p = centeredCmToSceneXZ(c.x, c.y);
    group.position.x = p.x;
    group.position.z = p.z;
    group.rotation.y = (-rotDeg * Math.PI) / 180;
  }

  async function rebuildFromLayout(layout) {
    return rebuildFromLayoutFromCore(layout);
  }

  /**
   * 用当前风格包中的装饰实例替换场景里的装饰（家具行保留）。切换风格时必须调用，否则装饰一直停留在全局 layout 中。
   * @param {object | null | undefined} style loadStyleConfig 的合并结果
   */
  async function mergeLayoutWithStyleDecorations(style) {
    return mergeLayoutWithStyleDecorationsFromCore(style);
  }

  function updateFurnitureFloorVisibility() {
    return updateFurnitureFloorVisibilityFromCore();
  }

  function getLayout() {
    const out = [];
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const cm = sceneXZToCenteredCm(g.position.x, g.position.z);
      const row = {
        instanceId: String(g.userData.layoutInstanceId || "").trim() || null,
        model: g.userData.modelType,
        floorId: String(g.userData.floorId || "").trim() || null,
        x: Math.round(cm.x),
        y: Math.round(cm.y),
        rotation: Math.round(g.userData.rotDeg ?? 0),
      };
      // 所有家具和装饰都保存垂直偏移（如果有的话）
      const liftCm = Math.round((Number(g.userData.decorationLiftM) || 0) * 100);
      if (liftCm !== 0) {
        row.decorationLiftCm = liftCm;
      }
      out.push(row);
    });
    return out;
  }

  function setGridVisible(visible) {
    gridVisible = !!visible;
    grid.visible = gridVisible;
    if (gridToggleBtn) {
      gridToggleBtn.classList.toggle("is-active", gridVisible);
      gridToggleBtn.setAttribute("aria-pressed", String(gridVisible));
    }
  }

  function getCurrentFloorplanId() {
    return currentFloorplanEntry?.id != null && String(currentFloorplanEntry.id).trim()
      ? String(currentFloorplanEntry.id).trim() : null;
  }
  function getCurrentFloorLevelIndex() {
    if (!currentFloorplanEntry || !floorSelectionEnabled) return null;
    return normalizeFloorIndex(currentFloorplanEntry, currentFloorIndex);
  }
  function getCurrentFloorId() { return activeFloorId; }

  function rayPickFloorplanSurface(clientX, clientY) {
    if (!floorSelectionEnabled) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return null;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(floorplanRoot.children, true);
    for (const h of hits) {
      const o = h.object;
      if (!o.visible) continue;
      const fid = String(o.userData?.floorplanFloorLevelId ?? "").trim();
      const rid = o.userData?.floorplanRoomId;
      if (rid && fid) {
        return {
          kind: "allFloors",
          floorLevelId: fid,
          roomId: rid,
        };
      }
      if (o.userData?.floorplanWindowFill && fid) {
        const wid = o.userData?.floorplanWindowId;
        return {
          kind: "allWindows",
          floorLevelId: fid,
          windowId: wid || null,
        };
      }
      if (o.userData?.floorplanDoorFill && fid) {
        const did = o.userData?.floorplanDoorId;
        return {
          kind: "allDoors",
          floorLevelId: fid,
          doorId: did || null,
        };
      }
      const wid = o.userData?.floorplanWallId;
      if (wid && fid) {
        // 根据射线命中的三角面材质索引识别正面(face_a=索引4)或反面(face_b=索引5)
        const mi = h.face?.materialIndex;
        let faceId = null;
        if (mi === 4) faceId = "face_a";
        else if (mi === 5) faceId = "face_b";
        return {
          kind: "wallFace",
          floorLevelId: fid,
          wallId: wid,
          faceId,
        };
      }
    }
    return null;
  }

  function clearFloorplanSurfaceSelection() {
    if (selectedFloorplanSurface) {
      setFloorplanGlobalSurfaceHighlight(
        selectedFloorplanSurface.floorLevelId,
        selectedFloorplanSurface.kind,
        false,
      );
    }
    selectedFloorplanSurface = null;
    clearRoomFloorSelection();
    clearDoorSelection();
    clearWindowSelection();
    clearWallFaceSelection();
    if (propSurfaceFields) propSurfaceFields.hidden = true;
    if (propFurnitureFields) propFurnitureFields.hidden = false;
  }

  function sampleMeshColorHex(mesh) {
    if (!mesh?.material) return "#e8dcc8";
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (m?.color?.getHexString) return `#${m.color.getHexString()}`;
    }
    return "#e8dcc8";
  }

  /** 与 rebuild 一致：用于属性面板解析风格包中的默认材质 id（库表键） */
  async function getCurrentFloorplanStyleForPanel() {
    const entry = currentFloorplanEntry;
    const fpId = getCurrentFloorplanId();
    if (!entry || !fpId) return null;
    const skEffective = getEffectiveFloorplanStyleKey();
    let style = null;
    try {
      style = await loadStyleConfig(fpId, skEffective);
    } catch {
      /* ignore */
    }
    if (!style) {
      const skFallback = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
      if (skFallback && skFallback !== skEffective) {
        try {
          style = await loadStyleConfig(fpId, skFallback);
        } catch {
          /* ignore */
        }
      }
    }
    return style;
  }

  /** 可选 materials.library.json + 当前风格包 materials（无库文件时仅内联材质，供面板与覆盖解析） */
  async function getFloorplanMaterialsLibraryBag() {
    let lib = {};
    try {
      lib = await loadMaterialsLibrary();
    } catch {
      lib = {};
    }
    const style = await getCurrentFloorplanStyleForPanel();
    const mats =
      style?.materials && typeof style.materials === "object" && !Array.isArray(style.materials) ? style.materials : {};
    return { ...lib, ...mats };
  }

  /**
   * 本层第一个房间地面 / 第一条墙在风格包中对应的材质键（与渲染时 resolve*MaterialKey 一致）。
   * @param {{ floorLevelId: string }} sel
   * @param {"allWalls" | "allFloors"} scope
   * @param {object | null} style
   */
  function resolveStyleMaterialKeyForSurfaceScope(sel, scope, style) {
    if (!style || !currentFloorplanEntry) return "";
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    const wantFid = normalizeFloorKey(sel.floorLevelId);
    const fl = floors.find((f) => normalizeFloorKey(f?.id ?? "") === wantFid) ?? null;
    if (!fl) return "";
    if (scope === "allFloors") {
      for (const room of fl.rooms || []) {
        const k = resolveRoomFloorMaterialKey(style, room);
        if (k) return k;
      }
      return "";
    }
    for (const w of fl.walls || []) {
      const k = resolveWallMaterialKey(style, w);
      if (k) return k;
    }
    return "";
  }

  /**
   * 本层第一扇门在风格包中对应的材质键（与 buildDoorFillGroup 中 resolveDoorMaterialKey 一致）。
   * @param {{ floorLevelId: string }} sel
   * @param {object | null} style
   */
  function resolveStyleMaterialKeyForDoorScope(sel, style) {
    if (!style || !currentFloorplanEntry) return "";
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    const wantFid = normalizeFloorKey(sel.floorLevelId);
    const fl = floors.find((f) => normalizeFloorKey(f?.id ?? "") === wantFid) ?? null;
    if (!fl) return "";
    for (const d of fl.doors || []) {
      const k = resolveDoorMaterialKey(style, d);
      if (k) return k;
    }
    return "";
  }

  /**
   * 本层第一扇窗在风格包中对应的材质键（与 buildWindowGlassGroup 中 resolveWindowMaterialKey 一致）。
   * @param {{ floorLevelId: string }} sel
   * @param {object | null} style
   */
  function resolveStyleMaterialKeyForWindowScope(sel, style) {
    if (!style || !currentFloorplanEntry) return "";
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    const wantFid = normalizeFloorKey(sel.floorLevelId);
    const fl = floors.find((f) => normalizeFloorKey(f?.id ?? "") === wantFid) ?? null;
    if (!fl) return "";
    for (const win of fl.windows || []) {
      const k = resolveWindowMaterialKey(style, win);
      if (k) return k;
    }
    return "";
  }

  function materialTypeMatchesSurfaceScope(type, scope) {
    const t = String(type ?? "");
    if (scope === "allFloors") return t === "wood_floor";
    if (scope === "allWindows") return t === "glass";
    if (scope === "allDoors") return t === "paint_wood" || t === "paint" || t === "wood_floor" || t === "glass";
    return t === "paint" || t === "paint_wood" || t === "glass";
  }

  /**
   * 解析当前墙面/地面在库中的基准材质 id（与 sync 面板、渲染一致）。
   * @param {{ floorLevelId: string }} sel
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   * @param {SurfaceScopeOverride | null | undefined} ov
   * @param {Record<string, object>} lib
   * @param {{ ignoreMaterialPresetCleared?: boolean }} [opts] 为 true 时仍按风格包解析默认库 id（用于清除预设后用户点选色板，需有基准材质承载贴图）
   */
  async function resolveBaseMaterialIdForSurfacePanel(sel, scope, ov, lib, opts) {
    const isFloor = scope === "allFloors";
    const ignorePresetCleared = opts?.ignoreMaterialPresetCleared === true;
    let selectVal = String(ov?.materialId ?? "").trim();
    if (!ignorePresetCleared && ov?.materialPresetCleared) {
      selectVal = "";
    } else if (!selectVal) {
      const style = await getCurrentFloorplanStyleForPanel();
      const sk =
        scope === "allDoors"
          ? resolveStyleMaterialKeyForDoorScope(sel, style)
          : scope === "allWindows"
            ? resolveStyleMaterialKeyForWindowScope(sel, style)
            : resolveStyleMaterialKeyForSurfaceScope(sel, scope, style);
      if (sk) {
        const styleMat = getMaterialDef(style, sk);
        const libMatId =
          styleMat && typeof styleMat === "object"
            ? String(styleMat.__libraryMaterialId ?? "").trim()
            : "";
        const key = libMatId || sk;
        const entryDef = lib[key];
        if (materialTypeMatchesSurfaceScope(entryDef?.type, scope)) selectVal = key;
      }
    }
    return selectVal;
  }

  function texturePathBasename(path) {
    const s = String(path ?? "").replace(/\\/g, "/").trim();
    const i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function getDefAlbedoBasename(def) {
    const alb = def?.texture?.albedo && String(def.texture.albedo).trim();
    return alb ? texturePathBasename(alb) : "";
  }

  /**
   * 面板「材质预设」旁展示用：优先显示 textureAlbedo 覆盖；否则库 albedo 文件名去掉扩展名；无 albedo 时返回 null（显示「无」）
   * @param {string} matId
   * @param {Record<string, object>} lib
   * @param {string} [textureAlbedoOverride]
   * @returns {string | null}
   */
  function materialPresetDisplayName(matId, lib, textureAlbedoOverride) {
    if (!matId) return "";
    const ta = String(textureAlbedoOverride ?? "").trim();
    if (ta) {
      const base = texturePathBasename(ta);
      const noExt = base.replace(/\.(jpe?g|png|webp)$/i, "");
      return noExt || null;
    }
    if (!lib || typeof lib !== "object") return matId;
    const def = lib[matId];
    if (!def) return matId;
    const base = getDefAlbedoBasename(def);
    if (!base) return null;
    const noExt = base.replace(/\.(jpe?g|png|webp)$/i, "");
    return noExt || null;
  }

  async function loadColorTextureIndex() {
    if (!colorTextureIndexPromise) {
      const url = `./${DATA_PATHS.stylesDir}/textures/colorTextures.index.json`;
      colorTextureIndexPromise = fetch(url)
        .then((r) => (r.ok ? r.json() : { files: [] }))
        .then((d) => (Array.isArray(d?.files) ? d.files : []))
        .catch(() => []);
    }
    return colorTextureIndexPromise;
  }

  /**
   * @param {string} matId
   * @param {Record<string, object>} [lib]
   * @param {string} [textureAlbedoOverride]
   */
  function updateSurfaceMaterialNameLabel(matId, lib, textureAlbedoOverride) {
    if (!propSurfaceMaterialName) return;
    if (!matId) {
      propSurfaceMaterialName.textContent = "无";
      propSurfaceMaterialName.removeAttribute("title");
      return;
    }
    let shown = matId;
    if (lib && typeof lib === "object") {
      const disp = materialPresetDisplayName(matId, lib, textureAlbedoOverride);
      shown = disp === null ? "无" : disp;
    }
    propSurfaceMaterialName.textContent = shown;
    propSurfaceMaterialName.title = shown.length > 0 && shown !== "无" ? shown : "";
  }

  /**
   * @param {SurfaceScopeOverride | null | undefined} ov
   * @param {string} selectVal
   * @param {Record<string, object>} lib
   * @param {boolean} [isWindowSurface] 本层全部窗洞玻璃：显示 Opacity / Transmission / IOR
   */
  function syncSurfacePbrInputs(ov, selectVal, lib, isWindowSurface) {
    const matId = String(selectVal ?? "").trim();
    const displayName = materialPresetDisplayName(matId, lib, ov?.textureAlbedo);
    // 面板上显示为“无”时，按“无材质”处理：隐藏材质参数区
    const hasSelectedMaterial = matId.length > 0 && displayName !== null;
    if (propSurfacePbrFields) propSurfacePbrFields.hidden = !hasSelectedMaterial;
    if (!hasSelectedMaterial) {
      if (propSurfaceGlassFields) propSurfaceGlassFields.hidden = true;
      if (propSurfaceUvTextureSection) propSurfaceUvTextureSection.hidden = true;
      return;
    }

    const base = selectVal && lib[selectVal] ? lib[selectVal] : null;
    const r =
      ov?.roughness != null && Number.isFinite(Number(ov.roughness))
        ? Number(ov.roughness)
        : base && Number.isFinite(Number(base.roughness))
          ? Number(base.roughness)
          : 0.55;
    const m =
      ov?.metalness != null && Number.isFinite(Number(ov.metalness))
        ? Number(ov.metalness)
        : base && Number.isFinite(Number(base.metalness))
          ? Number(base.metalness)
          : 0;
    const us = Array.isArray(ov?.uvScale) && ov.uvScale.length >= 2
      ? [Number(ov.uvScale[0]), Number(ov.uvScale[1])]
      : Array.isArray(base?.uvScale) && base.uvScale.length >= 2
        ? [Number(base.uvScale[0]), Number(base.uvScale[1])]
        : [1, 1];
    const rot =
      ov?.textureRotation != null && Number.isFinite(Number(ov.textureRotation))
        ? Number(ov.textureRotation)
        : base && Number.isFinite(Number(base.textureRotation))
          ? Number(base.textureRotation)
          : 0;
    if (propSurfaceRoughness) propSurfaceRoughness.value = String(Math.round(r * 1000) / 1000);
    if (propSurfaceMetalness) propSurfaceMetalness.value = String(Math.round(m * 1000) / 1000);

    if (propSurfaceGlassFields) propSurfaceGlassFields.hidden = !isWindowSurface;
    if (propSurfaceUvTextureSection) propSurfaceUvTextureSection.hidden = isWindowSurface;
    if (isWindowSurface && propSurfaceOpacity && propSurfaceTransmission && propSurfaceIor) {
      const oOp =
        ov?.opacity != null && Number.isFinite(Number(ov.opacity))
          ? Number(ov.opacity)
          : base && Number.isFinite(Number(base.opacity))
            ? Number(base.opacity)
            : 0.5;
      const oTr =
        ov?.transmission != null && Number.isFinite(Number(ov.transmission))
          ? Number(ov.transmission)
          : base && Number.isFinite(Number(base.transmission))
            ? Number(base.transmission)
            : 0.5;
      const oIor =
        ov?.ior != null && Number.isFinite(Number(ov.ior))
          ? Number(ov.ior)
          : base && Number.isFinite(Number(base.ior))
            ? Number(base.ior)
            : 1.45;
      propSurfaceOpacity.value = String(Math.round(oOp * 1000) / 1000);
      propSurfaceTransmission.value = String(Math.round(oTr * 1000) / 1000);
      propSurfaceIor.value = String(Math.round(oIor * 1000) / 1000);
    }

    if (!isWindowSurface) {
      if (propSurfaceUvScaleX) propSurfaceUvScaleX.value = String(Math.round(us[0] * 1000) / 1000);
      if (propSurfaceUvScaleY) propSurfaceUvScaleY.value = String(Math.round(us[1] * 1000) / 1000);
      if (propSurfaceTextureRotation) propSurfaceTextureRotation.value = String(Math.round(rot * 10) / 10);
    }
  }

  function surfaceTextureCategoryLabel(fileName) {
    const name = String(fileName ?? "").toLowerCase();
    if (/(wood|parquet|plank|laminate|cabinet|table)/.test(name)) return "木质";
    if (/(brick|pavement|sandstone|asphalt|concrete|gravel)/.test(name)) return "石材 / 砖石";
    if (/(metal|rust|shutter|plate)/.test(name)) return "金属";
    if (/(tile|marble|linoleum)/.test(name)) return "瓷砖 / 石纹";
    if (/(wall|plaster|paint)/.test(name)) return "墙面";
    return "其他";
  }

  function groupSurfaceTextureFiles(files) {
    const order = ["木质", "石材 / 砖石", "金属", "瓷砖 / 石纹", "墙面", "其他"];
    const map = new Map(order.map((label) => [label, []]));
    for (const fn of files) {
      const label = surfaceTextureCategoryLabel(fn);
      if (!map.has(label)) map.set(label, []);
      map.get(label).push(fn);
    }
    return order
      .map((label) => ({ label, files: map.get(label) || [] }))
      .filter((group) => group.files.length > 0);
  }

  function listSurfaceTextureCategories(files) {
    const groups = groupSurfaceTextureFiles(files);
    return ["全部", ...groups.map((g) => g.label)];
  }

  function ensureSurfaceMaterialGridClick() {
    if (
      surfaceMaterialGridClickBound ||
      !propSurfaceMaterialGrid ||
      !propSurfaceMaterial ||
      !propSurfaceTextureAlbedo
    ) {
      return;
    }
    surfaceMaterialGridClickBound = true;
    propSurfaceMaterialGrid.addEventListener("click", async (e) => {
      const btn = e.target.closest(".prop-surface-material__cell");
      if (!btn || !propSurfaceMaterialGrid.contains(btn)) return;
      const albedoFn = String(btn.dataset.albedoFile ?? "").trim();
      if (!albedoFn) return;
      const sel = selectedFloorplanSurface;
      if (!sel || !propSurfaceMaterial || !propSurfaceTextureAlbedo) return;
      const lib = await getFloorplanMaterialsLibraryBag();
      const scope = floorplanSurfaceScopeFromKind(sel.kind);
      const baseOv = getFloorplanSurfaceGlobalOverride(sel.floorLevelId, scope);
      let mid =
        String(propSurfaceMaterial.value ?? "").trim() ||
        (await resolveBaseMaterialIdForSurfacePanel(sel, scope, baseOv, lib, {
          ignoreMaterialPresetCleared: true,
        }));
      if (!mid) return;
      propSurfaceMaterial.value = mid;
      propSurfaceTextureAlbedo.value = albedoFn;
      updateSurfaceMaterialNameLabel(mid, lib, albedoFn);
      propSurfaceMaterialGrid.querySelectorAll(".prop-surface-material__cell").forEach((el) => {
        const fn = String(el.dataset.albedoFile ?? "").trim();
        el.classList.toggle("is-selected", fn !== "" && fn === albedoFn);
      });
      const mergeOv = { ...baseOv, materialId: mid, textureAlbedo: albedoFn };
      delete mergeOv.materialPresetCleared;
      syncSurfacePbrInputs(mergeOv, mid, lib, sel.kind === "allWindows");
      propSurfaceMaterial.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  async function syncPropertiesPanelForFloorplanSurface(sel) {
    if (!sel || !propertiesPanel) return;
    const isFloor = sel.kind === "allFloors";
    const isDoor = sel.kind === "allDoors";
    const isWin = sel.kind === "allWindows";
    const isWallFace = sel.kind === "wallFace";
    const scope = floorplanSurfaceScopeFromKind(sel.kind);

    // 多选房间地板处理
    const hasMultiSelectFloor = selectedRoomFloorIds.size > 0 && isFloor && sel.roomId;
    const selectedRoomIds = hasMultiSelectFloor ? getSelectedRoomFloorIds() : [];

    // 多选门处理
    const hasMultiSelectDoor = selectedDoorIds.size > 0 && isDoor && sel.doorId;
    const selectedDoorIdsArr = hasMultiSelectDoor ? getSelectedDoorIds() : [];

    // 多选墙面处理
    const hasMultiSelectWallFace = isWallFace && selectedWallFaceIds.size > 0;
    const selectedWallFacesArr = isWallFace ? getSelectedWallFaces() : [];

    // 多选窗户处理
    const hasMultiSelectWindow = selectedWindowIds.size > 0 && isWin && sel.windowId;
    const selectedWindowIdsArr = hasMultiSelectWindow ? getSelectedWindowIds() : [];

    // 获取房间名称的辅助函数
    function getRoomName(roomId, floorLevelId) {
      if (!roomId || !floorLevelId) return null;
      const floors = getFloorsFromEntry(currentFloorplanEntry);
      for (const fl of floors) {
        if (String(fl?.id ?? "").trim() !== floorLevelId) continue;
        for (const room of fl?.rooms || []) {
          if (String(room?.id ?? "").trim() === roomId) {
            return room?.name || roomId;
          }
        }
      }
      return null;
    }

    // 获取楼层名称的辅助函数
    function getFloorName(floorLevelId) {
      if (!floorLevelId) return null;
      const floors = getFloorsFromEntry(currentFloorplanEntry);
      for (const fl of floors) {
        if (String(fl?.id ?? "").trim() === floorLevelId) {
          return fl?.name || floorLevelId;
        }
      }
      return floorLevelId;
    }

    // 获取门名称的辅助函数
    function getDoorName(doorId, floorLevelId) {
      if (!doorId || !floorLevelId) return null;
      const floors = getFloorsFromEntry(currentFloorplanEntry);
      for (const fl of floors) {
        if (String(fl?.id ?? "").trim() !== floorLevelId) continue;
        for (const door of fl?.doors || []) {
          if (String(door?.id ?? "").trim() === doorId) {
            return door?.name || doorId;
          }
        }
      }
      return null;
    }

    // 获取窗户名称的辅助函数
    function getWindowName(windowId, floorLevelId) {
      if (!windowId || !floorLevelId) return null;
      const floors = getFloorsFromEntry(currentFloorplanEntry);
      for (const fl of floors) {
        if (String(fl?.id ?? "").trim() !== floorLevelId) continue;
        for (const win of fl?.windows || []) {
          if (String(win?.id ?? "").trim() === windowId) {
            return win?.name || windowId;
          }
        }
      }
      return null;
    }

    // 获取墙体名称的辅助函数
    function getWallName(wallId, floorLevelId) {
      if (!wallId || !floorLevelId) return null;
      const floors = getFloorsFromEntry(currentFloorplanEntry);
      for (const fl of floors) {
        if (String(fl?.id ?? "").trim() !== floorLevelId) continue;
        for (const wall of fl?.walls || []) {
          if (String(wall?.id ?? "").trim() === wallId) {
            return wall?.name || wallId;
          }
        }
      }
      return null;
    }

    const currentFloorName = getFloorName(sel.floorLevelId);

    if (propertiesName) {
      if (hasMultiSelectFloor) {
        const names = selectedRoomIds.map((rid) => getRoomName(rid, sel.floorLevelId) || rid).join("、");
        propertiesName.textContent = names || `${selectedRoomIds.length} 个房间地面`;
      } else if (hasMultiSelectDoor) {
        const names = selectedDoorIdsArr.map((did) => getDoorName(did, sel.floorLevelId) || did).join("、");
        propertiesName.textContent = names || `${selectedDoorIdsArr.length} 个门`;
      } else if (hasMultiSelectWindow) {
        const names = selectedWindowIdsArr.map((wid) => getWindowName(wid, sel.floorLevelId) || wid).join("、");
        propertiesName.textContent = names || `${selectedWindowIdsArr.length} 个窗户`;
      } else if (isWallFace) {
        if (hasMultiSelectWallFace) {
          const names = selectedWallFacesArr.map(({ wallId, faceId }) => {
            const wn = getWallName(wallId, sel.floorLevelId) || wallId;
            const side = faceId === "face_a" ? "正面" : faceId === "face_b" ? "反面" : "";
            return side ? `${wn}(${side})` : wn;
          }).join("、");
          propertiesName.textContent = names || `${selectedWallFacesArr.length} 个墙面`;
        } else {
          const wn = getWallName(sel.wallId, sel.floorLevelId) || sel.wallId || "墙体";
          const side = sel.faceId === "face_a" ? "正面" : sel.faceId === "face_b" ? "反面" : "";
          propertiesName.textContent = side ? `${wn}（${side}）` : wn;
        }
      } else if (isFloor && sel.roomId) {
        const roomName = getRoomName(sel.roomId, sel.floorLevelId);
        propertiesName.textContent = roomName || "地面";
      } else if (isDoor && sel.doorId) {
        const doorName = getDoorName(sel.doorId, sel.floorLevelId);
        propertiesName.textContent = doorName || "门";
      } else if (isWin && sel.windowId) {
        const windowName = getWindowName(sel.windowId, sel.floorLevelId);
        propertiesName.textContent = windowName || "窗";
      } else {
        propertiesName.textContent = isFloor ? "全部地面" : isDoor ? "全部门" : isWin ? "全部窗" : "全部墙体";
      }
    }
    if (propSurfaceTitle) {
      const floorLabel = currentFloorName || sel.floorLevelId;
      if (hasMultiSelectFloor) {
        propSurfaceTitle.textContent = `地面属性（${selectedRoomIds.length} 个房间） · ${floorLabel}`;
      } else if (hasMultiSelectDoor) {
        propSurfaceTitle.textContent = `门属性（${selectedDoorIdsArr.length} 个门） · ${floorLabel}`;
      } else if (hasMultiSelectWindow) {
        propSurfaceTitle.textContent = `窗户属性（${selectedWindowIdsArr.length} 个窗户） · ${floorLabel}`;
      } else if (isWallFace) {
        if (hasMultiSelectWallFace) {
          propSurfaceTitle.textContent = `墙面属性（${selectedWallFacesArr.length} 个面） · ${floorLabel}`;
        } else {
          const wn = getWallName(sel.wallId, sel.floorLevelId) || sel.wallId || "墙体";
          const side = sel.faceId === "face_a" ? " 正面" : sel.faceId === "face_b" ? " 反面" : "";
          propSurfaceTitle.textContent = `${wn}${side} 属性 · ${floorLabel}`;
        }
      } else if (isFloor && sel.roomId) {
        const roomName = getRoomName(sel.roomId, sel.floorLevelId);
        propSurfaceTitle.textContent = roomName ? `${roomName} 地面属性 · ${floorLabel}` : `地面属性 · ${floorLabel}`;
      } else if (isDoor && sel.doorId) {
        const doorName = getDoorName(sel.doorId, sel.floorLevelId);
        propSurfaceTitle.textContent = doorName ? `${doorName} 属性 · ${floorLabel}` : `门属性 · ${floorLabel}`;
      } else if (isWin && sel.windowId) {
        const windowName = getWindowName(sel.windowId, sel.floorLevelId);
        propSurfaceTitle.textContent = windowName ? `${windowName} 属性 · ${floorLabel}` : `窗户属性 · ${floorLabel}`;
      } else {
        propSurfaceTitle.textContent = isFloor
          ? `地面属性（本层所有房间） · ${floorLabel}`
          : isDoor
            ? `门属性（本层全部门） · ${floorLabel}`
            : isWin
              ? `窗户属性（本层全部窗洞玻璃） · ${floorLabel}`
              : `墙体属性（本层全部墙） · ${floorLabel}`;
      }
    }
    if (propSurfaceIdHint) {
      if (hasMultiSelectFloor) {
        propSurfaceIdHint.textContent = `已选中 ${selectedRoomIds.length} 个房间地板 · 修改将应用于所有选中房间`;
      } else if (hasMultiSelectDoor) {
        propSurfaceIdHint.textContent = `已选中 ${selectedDoorIdsArr.length} 个门 · 修改将应用于所有选中门`;
      } else if (hasMultiSelectWindow) {
        propSurfaceIdHint.textContent = `已选中 ${selectedWindowIdsArr.length} 个窗户 · 修改将应用于所有选中窗户`;
      } else if (isWallFace) {
        if (hasMultiSelectWallFace) {
          propSurfaceIdHint.textContent = `已选中 ${selectedWallFacesArr.length} 个墙面 · 修改将应用于所有选中墙面`;
        } else {
          const wn = getWallName(sel.wallId, sel.floorLevelId) || sel.wallId || "该墙";
          const side = sel.faceId === "face_a" ? "正面" : sel.faceId === "face_b" ? "反面" : "两面";
          propSurfaceIdHint.textContent = `修改将应用于 ${wn} ${side}`;
        }
      } else {
        propSurfaceIdHint.textContent = `修改将应用于该层全部${isFloor ? "地面" : isDoor ? "门" : isWin ? "窗洞玻璃" : "墙体"}`;
      }
    }

    // 获取覆盖数据
    let ov = null;
    if (isWallFace) {
      // 墙面覆盖：按 wallId + faceId 读取
      if (hasMultiSelectWallFace) {
        // 多选：合并一致的字段
        const overrides = selectedWallFacesArr.map(({ wallId, faceId }) => getWallFaceOverride(sel.floorLevelId, wallId, faceId)).filter(Boolean);
        if (overrides.length === 1) {
          ov = overrides[0];
        } else if (overrides.length > 1) {
          ov = {};
          const fields = ["color", "materialId", "roughness", "metalness", "uvScale", "textureRotation", "textureAlbedo"];
          for (const field of fields) {
            const vals = overrides.map((o) => JSON.stringify(o?.[field]));
            const uniqueVals = [...new Set(vals)].filter((v) => v !== "undefined" && v !== "null");
            if (uniqueVals.length === 1) {
              ov[field] = JSON.parse(uniqueVals[0]);
            }
          }
          if (!Object.keys(ov).length) ov = null;
        }
      } else {
        ov = getWallFaceOverride(sel.floorLevelId, sel.wallId, sel.faceId);
      }
    } else if (hasMultiSelectFloor) {
      const overrides = selectedRoomIds.map((rid) => getRoomFloorOverride(sel.floorLevelId, rid)).filter(Boolean);
      if (overrides.length === 1) {
        ov = overrides[0];
      } else if (overrides.length > 1) {
        ov = {};
        const fields = ["color", "materialId", "roughness", "metalness", "uvScale", "textureRotation", "textureAlbedo"];
        for (const field of fields) {
          const vals = overrides.map((o) => JSON.stringify(o?.[field]));
          const uniqueVals = [...new Set(vals)].filter((v) => v !== "undefined" && v !== "null");
          if (uniqueVals.length === 1) {
            ov[field] = JSON.parse(uniqueVals[0]);
          }
        }
        if (!Object.keys(ov).length) ov = null;
      }
    } else if (hasMultiSelectDoor) {
      const overrides = selectedDoorIdsArr.map((did) => getDoorOverride(sel.floorLevelId, did)).filter(Boolean);
      if (overrides.length === 1) {
        ov = overrides[0];
      } else if (overrides.length > 1) {
        ov = {};
        const fields = ["color", "materialId", "roughness", "metalness", "opacity", "transmission", "ior"];
        for (const field of fields) {
          const vals = overrides.map((o) => JSON.stringify(o?.[field]));
          const uniqueVals = [...new Set(vals)].filter((v) => v !== "undefined" && v !== "null");
          if (uniqueVals.length === 1) {
            ov[field] = JSON.parse(uniqueVals[0]);
          }
        }
        if (!Object.keys(ov).length) ov = null;
      }
    } else if (hasMultiSelectWindow) {
      const overrides = selectedWindowIdsArr.map((wid) => getWindowOverride(sel.floorLevelId, wid)).filter(Boolean);
      if (overrides.length === 1) {
        ov = overrides[0];
      } else if (overrides.length > 1) {
        ov = {};
        const fields = ["color", "roughness", "metalness", "opacity", "transmission", "ior"];
        for (const field of fields) {
          const vals = overrides.map((o) => JSON.stringify(o?.[field]));
          const uniqueVals = [...new Set(vals)].filter((v) => v !== "undefined" && v !== "null");
          if (uniqueVals.length === 1) {
            ov[field] = JSON.parse(uniqueVals[0]);
          }
        }
        if (!Object.keys(ov).length) ov = null;
      }
    } else {
      ov = getFloorplanSurfaceGlobalOverride(sel.floorLevelId, scope);
    }

    const sampleMesh = (isWallFace || hasMultiSelectFloor || hasMultiSelectDoor || hasMultiSelectWindow) ? null : findFirstFloorplanSurfaceMesh(sel.floorLevelId, scope);
    const hex = ov?.color || (sampleMesh ? sampleMeshColorHex(sampleMesh) : "#e8dcc8");
    const normalizedHex = hex.length === 7 ? hex : `#${hex.replace(/^#/, "")}`;
    if (propSurfaceColor) propSurfaceColor.value = normalizedHex;
    surfaceColorPicker?.setHex(normalizedHex, true);

    const lib = await getFloorplanMaterialsLibraryBag();

    // wallFace 使用 "allWalls" scope 解析默认材质
    const resolveScope = isWallFace ? "allWalls" : scope;
    const selectVal = await resolveBaseMaterialIdForSurfacePanel(sel, resolveScope, ov, lib);
    const texAlbedoRaw = String(ov?.textureAlbedo ?? "").trim();
    if (propSurfaceMaterialSection) propSurfaceMaterialSection.hidden = isWin;
    if (propSurfaceUvTextureSection) propSurfaceUvTextureSection.hidden = isWin;
    if (!isWin) {
      if (propSurfaceMaterial) propSurfaceMaterial.value = selectVal || "";
      if (propSurfaceTextureAlbedo) propSurfaceTextureAlbedo.value = texAlbedoRaw;
      updateSurfaceMaterialNameLabel(selectVal, lib, texAlbedoRaw);
    }
    syncSurfacePbrInputs(ov, selectVal, lib, isWin);

    if (!isWin && propSurfaceMaterial && propSurfaceMaterialGrid) {
      const files = await loadColorTextureIndex();
      const effectiveBasename = texAlbedoRaw
        ? texturePathBasename(texAlbedoRaw)
        : selectVal && lib[selectVal]
          ? getDefAlbedoBasename(lib[selectVal])
          : "";
      const categories = listSurfaceTextureCategories(files);
      if (!categories.includes(surfaceMaterialCategoryFilter)) {
        surfaceMaterialCategoryFilter = "全部";
      }

      if (propSurfaceMaterialFilters) {
        propSurfaceMaterialFilters.replaceChildren();
        for (const label of categories) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "prop-surface-material-filter" + (label === surfaceMaterialCategoryFilter ? " is-active" : "");
          btn.textContent = label;
          btn.addEventListener("click", () => {
            if (surfaceMaterialCategoryFilter === label) return;
            surfaceMaterialCategoryFilter = label;
            if (selectedFloorplanSurface) {
              void syncPropertiesPanelForFloorplanSurface(selectedFloorplanSurface);
            }
          });
          propSurfaceMaterialFilters.appendChild(btn);
        }
      }

      propSurfaceMaterialGrid.replaceChildren();
      const visibleFiles =
        surfaceMaterialCategoryFilter === "全部"
          ? files
          : files.filter((fn) => surfaceTextureCategoryLabel(fn) === surfaceMaterialCategoryFilter);
      for (const fn of visibleFiles) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "prop-surface-material__cell";
        btn.dataset.albedoFile = fn;
        if (effectiveBasename && effectiveBasename === fn) {
          btn.classList.add("is-selected");
        }
        btn.title = fn;
        const img = document.createElement("img");
        img.src = resolveStyleTextureUrl(`textures/${fn}`);
        img.alt = "";
        img.loading = "lazy";
        btn.appendChild(img);
        propSurfaceMaterialGrid.appendChild(btn);
      }
      ensureSurfaceMaterialGridClick();
    } else if (propSurfaceMaterialFilters) {
      propSurfaceMaterialFilters.replaceChildren();
    }
  }

  async function selectFloorplanSurface(sel) {
    deselectVisualOnly();
    if (selectedFloorplanSurface) {
      setFloorplanGlobalSurfaceHighlight(
        selectedFloorplanSurface.floorLevelId,
        selectedFloorplanSurface.kind,
        false,
      );
    }
    selectedFloorplanSurface = sel;
    // 多选房间地板时传递 roomIdFilter，多选门时传递 doorIdFilter，多选窗户时传递 windowIdFilter，多选墙面时传递 wallFaceFilter
    if (sel) {
      const roomFilter = sel.kind === "allFloors" && selectedRoomFloorIds.size > 0 ? selectedRoomFloorIds : null;
      const doorFilter = sel.kind === "allDoors" && selectedDoorIds.size > 0 ? selectedDoorIds : null;
      const windowFilter = sel.kind === "allWindows" && selectedWindowIds.size > 0 ? selectedWindowIds : null;
      // wallFaceFilter: Map<wallId, Set<faceId | null>>
      let wallFaceFilter = null;
      if (sel.kind === "wallFace") {
        // 使用多选集合（至少包含当前选中面）
        const faces = selectedWallFaceIds.size > 0 ? getSelectedWallFaces() : [{ wallId: sel.wallId, faceId: sel.faceId }];
        wallFaceFilter = new Map();
        for (const { wallId, faceId } of faces) {
          if (!wallId) continue;
          if (!wallFaceFilter.has(wallId)) wallFaceFilter.set(wallId, new Set());
          wallFaceFilter.get(wallId).add(faceId);
        }
      }
      setFloorplanGlobalSurfaceHighlight(sel.floorLevelId, sel.kind, true, roomFilter, doorFilter, windowFilter, wallFaceFilter);
    }
    if (propFurnitureFields) propFurnitureFields.hidden = true;
    if (propSurfaceFields) propSurfaceFields.hidden = false;
    propertiesPanel?.classList.add("is-visible");
    await syncPropertiesPanelForFloorplanSurface(sel);
  }

  async function commitFloorplanSurfaceEdit() {
    const wasPendingMaterialPresetClear = pendingSurfaceMaterialPresetClear;
    pendingSurfaceMaterialPresetClear = false;
    const sel = selectedFloorplanSurface;
    if (!sel || !propSurfaceColor) {
      if (wasPendingMaterialPresetClear) pendingSurfaceMaterialPresetClear = true;
      return;
    }
    // 连续多次改材质/墙面时若仍处在防抖窗口内，只会产生一条历史；先 flush 再提交，保证「一步一快照」
    if (historyReady) flushHistoryDebounce();
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    const lib = await getFloorplanMaterialsLibraryBag();
    const fid = sel.floorLevelId;
    const prevOv = getFloorplanSurfaceGlobalOverride(fid, scope);

    // 多选房间地板处理
    const hasMultiSelectFloor = selectedRoomFloorIds.size > 0 && sel.kind === "allFloors" && sel.roomId;
    // 多选门处理
    const hasMultiSelectDoor = selectedDoorIds.size > 0 && sel.kind === "allDoors" && sel.doorId;
    // 多选窗户处理
    const hasMultiSelectWindow = selectedWindowIds.size > 0 && sel.kind === "allWindows" && sel.windowId;
    const selectedWindowIdsArr = hasMultiSelectWindow ? getSelectedWindowIds() : [];
    // 墙面处理（单选或多选）
    const isWallFaceEdit = sel.kind === "wallFace";

    /** 窗玻璃：不切换材质库预设，仅保存颜色与 PBR/玻璃参数（不写 materialId / textureAlbedo） */
    if (sel.kind === "allWindows") {
      const col = String(propSurfaceColor.value || "").trim();
      const next = {};
      if (col) next.color = col.startsWith("#") ? col : `#${col}`;
      const pr =
        propSurfaceRoughness?.value != null && String(propSurfaceRoughness.value).trim() !== ""
          ? Number(propSurfaceRoughness.value)
          : NaN;
      if (Number.isFinite(pr)) next.roughness = Math.min(1, Math.max(0, pr));
      const pm =
        propSurfaceMetalness?.value != null && String(propSurfaceMetalness.value).trim() !== ""
          ? Number(propSurfaceMetalness.value)
          : NaN;
      if (Number.isFinite(pm)) next.metalness = Math.min(1, Math.max(0, pm));
      const po =
        propSurfaceOpacity?.value != null && String(propSurfaceOpacity.value).trim() !== ""
          ? Number(propSurfaceOpacity.value)
          : NaN;
      if (Number.isFinite(po)) next.opacity = Math.min(1, Math.max(0, po));
      const ptm =
        propSurfaceTransmission?.value != null && String(propSurfaceTransmission.value).trim() !== ""
          ? Number(propSurfaceTransmission.value)
          : NaN;
      if (Number.isFinite(ptm)) next.transmission = Math.min(1, Math.max(0, ptm));
      const pior =
        propSurfaceIor?.value != null && String(propSurfaceIor.value).trim() !== ""
          ? Number(propSurfaceIor.value)
          : NaN;
      if (Number.isFinite(pior)) next.ior = Math.min(2.5, Math.max(1, pior));
      const hasScopeData = Object.keys(next).length > 0;
      
      // 多选窗户：批量设置覆盖
      if (hasMultiSelectWindow) {
        const windowIds = getSelectedWindowIds();
        setWindowOverridesForMultiple(fid, windowIds, hasScopeData ? next : null);
        // 同步到 Design JSON
        syncWindowOverridesToDesignJson();
        if (historyReady) pushHistorySnapshot();
        await applyWindowOverridesForMultiple(fid, windowIds);
        await selectFloorplanSurface(sel);
        emitLayoutChanged();
        return;
      }
      
      // 单选窗户：设置单个窗户覆盖
      if (sel.windowId) {
        setWindowOverride(fid, sel.windowId, hasScopeData ? next : null);
        // 同步到 Design JSON
        syncWindowOverridesToDesignJson();
        if (historyReady) pushHistorySnapshot();
        await applyWindowOverridesForMultiple(fid, [sel.windowId]);
        await selectFloorplanSurface(sel);
        emitLayoutChanged();
        return;
      }
      
      // 全部窗户：设置全局覆盖
      setFloorplanSurfaceGlobalOverride(fid, scope, hasScopeData ? next : null);
      if (historyReady) pushHistorySnapshot();
      if (!hasScopeData) {
        await rebuildFloorplan3D();
      } else {
        await applySurfaceOverridesForFloorScope(fid, scope);
      }
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    if (!propSurfaceMaterial) {
      if (wasPendingMaterialPresetClear) pendingSurfaceMaterialPresetClear = true;
      return;
    }
    let matId = String(propSurfaceMaterial.value || "").trim();
    if (!matId && !wasPendingMaterialPresetClear && !prevOv?.materialPresetCleared) {
      matId = await resolveBaseMaterialIdForSurfacePanel(sel, scope, prevOv, lib);
      if (matId && propSurfaceMaterial) propSurfaceMaterial.value = matId;
    }
    const col = String(propSurfaceColor.value || "").trim();
    const next = {};
    if (col) next.color = col.startsWith("#") ? col : `#${col}`;
    if (matId) {
      next.materialId = matId;
    } else if (wasPendingMaterialPresetClear || prevOv?.materialPresetCleared) {
      next.materialPresetCleared = true;
    }
    const pr =
      propSurfaceRoughness?.value != null && String(propSurfaceRoughness.value).trim() !== ""
        ? Number(propSurfaceRoughness.value)
        : NaN;
    if (Number.isFinite(pr)) next.roughness = Math.min(1, Math.max(0, pr));
    const pm =
      propSurfaceMetalness?.value != null && String(propSurfaceMetalness.value).trim() !== ""
        ? Number(propSurfaceMetalness.value)
        : NaN;
    if (Number.isFinite(pm)) next.metalness = Math.min(1, Math.max(0, pm));
    const ux =
      propSurfaceUvScaleX?.value != null && String(propSurfaceUvScaleX.value).trim() !== ""
        ? Number(propSurfaceUvScaleX.value)
        : NaN;
    const uy =
      propSurfaceUvScaleY?.value != null && String(propSurfaceUvScaleY.value).trim() !== ""
        ? Number(propSurfaceUvScaleY.value)
        : NaN;
    if (Number.isFinite(ux) && Number.isFinite(uy) && ux > 0 && uy > 0) {
      next.uvScale = [ux, uy];
    }
    const tr =
      propSurfaceTextureRotation?.value != null && String(propSurfaceTextureRotation.value).trim() !== ""
        ? Number(propSurfaceTextureRotation.value)
        : NaN;
    if (Number.isFinite(tr)) next.textureRotation = tr;
    const texAlbedo = String(propSurfaceTextureAlbedo?.value ?? "").trim();
    if (texAlbedo) next.textureAlbedo = texAlbedo;
    const hasScopeData = Object.keys(next).length > 0;

    // 多选房间地板：批量设置覆盖
    if (hasMultiSelectFloor) {
      const roomIds = getSelectedRoomFloorIds();
      setRoomFloorOverridesForMultiple(fid, roomIds, hasScopeData ? next : null);
      // 同步到 Design JSON
      syncRoomFloorOverridesToDesignJson();
      if (historyReady) pushHistorySnapshot();
      await applyRoomFloorOverridesForMultiple(fid, roomIds);
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    // 多选门：批量设置覆盖
    if (hasMultiSelectDoor) {
      const doorIds = getSelectedDoorIds();
      setDoorOverridesForMultiple(fid, doorIds, hasScopeData ? next : null);
      // 同步到 Design JSON
      syncDoorOverridesToDesignJson();
      if (historyReady) pushHistorySnapshot();
      await applyDoorOverridesForMultiple(fid, doorIds);
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    if (sel.kind === "allDoors" && sel.doorId) {
      setDoorOverride(fid, sel.doorId, hasScopeData ? next : null);
      syncDoorOverridesToDesignJson();
      if (historyReady) pushHistorySnapshot();
      await applyDoorOverridesForMultiple(fid, [sel.doorId]);
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    // 多选窗户：批量设置覆盖
    if (hasMultiSelectWindow) {
      const windowIds = getSelectedWindowIds();
      setWindowOverridesForMultiple(fid, windowIds, hasScopeData ? next : null);
      syncWindowOverridesToDesignJson();
      if (historyReady) pushHistorySnapshot();
      await applyWindowOverridesForMultiple(fid, windowIds);
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    // 墙面（单选或多选）：按 wallId + faceId 设置覆盖
    if (isWallFaceEdit) {
      const wallFacePairs = selectedWallFaceIds.size > 0
        ? getSelectedWallFaces()
        : [{ wallId: sel.wallId, faceId: sel.faceId }];
      setWallFaceOverridesForMultiple(fid, wallFacePairs, hasScopeData ? next : null);
      syncWallFaceOverridesToDesignJson();
      if (historyReady) pushHistorySnapshot();
      await applyWallFaceOverridesToScene(fid, wallFacePairs);
      await selectFloorplanSurface(sel);
      emitLayoutChanged();
      return;
    }

    setFloorplanSurfaceGlobalOverride(fid, scope, hasScopeData ? next : null);
    if (historyReady) pushHistorySnapshot();
    if (!hasScopeData) {
      await rebuildFloorplan3D();
    } else {
      await applySurfaceOverridesForFloorScope(fid, scope);
    }
    await selectFloorplanSurface(sel);
    emitLayoutChanged();
  }

  async function resetFloorplanSurfaceToDefault() {
    const sel = selectedFloorplanSurface;
    if (!sel || !propSurfaceColor || !propSurfaceMaterial) return;
    pendingSurfaceMaterialPresetClear = false;
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    const fid = sel.floorLevelId;

    const hasMultiSelectFloor = selectedRoomFloorIds.size > 0 && sel.kind === "allFloors" && sel.roomId;
    const hasMultiSelectDoor = selectedDoorIds.size > 0 && sel.kind === "allDoors" && sel.doorId;
    const hasMultiSelectWindow = selectedWindowIds.size > 0 && sel.kind === "allWindows" && sel.windowId;
    const isWallFaceEdit = sel.kind === "wallFace";

    if (hasMultiSelectFloor) {
      const roomIds = getSelectedRoomFloorIds();
      setRoomFloorOverridesForMultiple(fid, roomIds, null);
      syncRoomFloorOverridesToDesignJson();
    } else if (sel.kind === "allFloors" && sel.roomId) {
      setRoomFloorOverride(fid, sel.roomId, null);
      syncRoomFloorOverridesToDesignJson();
    } else if (hasMultiSelectDoor) {
      const doorIds = getSelectedDoorIds();
      setDoorOverridesForMultiple(fid, doorIds, null);
      syncDoorOverridesToDesignJson();
    } else if (sel.kind === "allDoors" && sel.doorId) {
      setDoorOverride(fid, sel.doorId, null);
      syncDoorOverridesToDesignJson();
    } else if (hasMultiSelectWindow) {
      const windowIds = getSelectedWindowIds();
      setWindowOverridesForMultiple(fid, windowIds, null);
      syncWindowOverridesToDesignJson();
    } else if (sel.kind === "allWindows" && sel.windowId) {
      setWindowOverride(fid, sel.windowId, null);
      syncWindowOverridesToDesignJson();
    } else if (isWallFaceEdit) {
      const wallFacePairs = selectedWallFaceIds.size > 0
        ? getSelectedWallFaces()
        : [{ wallId: sel.wallId, faceId: sel.faceId }];
      setWallFaceOverridesForMultiple(fid, wallFacePairs, null);
      syncWallFaceOverridesToDesignJson();
    } else {
      setFloorplanSurfaceGlobalOverride(fid, scope, null);
    }

    if (historyReady) pushHistorySnapshot();
    // 清空覆盖后必须重建：否则 mesh 仍可能保留上一次 override 材质实例
    await rebuildFloorplan3D();
    await selectFloorplanSurface(sel);
    emitLayoutChanged();
  }

  function overrideWithoutColor(ov) {
    if (!ov || typeof ov !== "object") return null;
    const next = { ...ov };
    delete next.color;
    return Object.keys(next).length ? next : null;
  }

  async function resetFloorplanSurfaceColorOnly() {
    const sel = selectedFloorplanSurface;
    if (!sel || !propSurfaceColor) return;
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    const fid = sel.floorLevelId;

    const hasMultiSelectFloor = selectedRoomFloorIds.size > 0 && sel.kind === "allFloors" && sel.roomId;
    const hasMultiSelectDoor = selectedDoorIds.size > 0 && sel.kind === "allDoors" && sel.doorId;
    const hasMultiSelectWindow = selectedWindowIds.size > 0 && sel.kind === "allWindows" && sel.windowId;
    const isWallFaceEdit = sel.kind === "wallFace";

    if (hasMultiSelectFloor) {
      for (const roomId of getSelectedRoomFloorIds()) {
        setRoomFloorOverride(fid, roomId, overrideWithoutColor(getRoomFloorOverride(fid, roomId)));
      }
      syncRoomFloorOverridesToDesignJson();
    } else if (sel.kind === "allFloors" && sel.roomId) {
      setRoomFloorOverride(fid, sel.roomId, overrideWithoutColor(getRoomFloorOverride(fid, sel.roomId)));
      syncRoomFloorOverridesToDesignJson();
    } else if (hasMultiSelectDoor) {
      for (const doorId of getSelectedDoorIds()) {
        setDoorOverride(fid, doorId, overrideWithoutColor(getDoorOverride(fid, doorId)));
      }
      syncDoorOverridesToDesignJson();
    } else if (sel.kind === "allDoors" && sel.doorId) {
      setDoorOverride(fid, sel.doorId, overrideWithoutColor(getDoorOverride(fid, sel.doorId)));
      syncDoorOverridesToDesignJson();
    } else if (hasMultiSelectWindow) {
      for (const windowId of getSelectedWindowIds()) {
        setWindowOverride(fid, windowId, overrideWithoutColor(getWindowOverride(fid, windowId)));
      }
      syncWindowOverridesToDesignJson();
    } else if (sel.kind === "allWindows" && sel.windowId) {
      setWindowOverride(fid, sel.windowId, overrideWithoutColor(getWindowOverride(fid, sel.windowId)));
      syncWindowOverridesToDesignJson();
    } else if (isWallFaceEdit) {
      const wallFacePairs = selectedWallFaceIds.size > 0
        ? getSelectedWallFaces()
        : [{ wallId: sel.wallId, faceId: sel.faceId }];
      for (const { wallId, faceId } of wallFacePairs) {
        setWallFaceOverride(fid, wallId, faceId, overrideWithoutColor(getWallFaceOverride(fid, wallId, faceId)));
      }
      syncWallFaceOverridesToDesignJson();
    } else {
      setFloorplanSurfaceGlobalOverride(
        fid,
        scope,
        overrideWithoutColor(getFloorplanSurfaceGlobalOverride(fid, scope)),
      );
    }

    if (historyReady) pushHistorySnapshot();
    await rebuildFloorplan3D();
    await selectFloorplanSurface(sel);
    emitLayoutChanged();
  }

  /**
   * 序列化设计基线（用于风格切换提示）
   * 只包含装饰物和材质覆盖，不包含家具
   */
  function serializeDesignBaseline() {
    const getSurf = window.layoutEditorGetSurfaceOverrides;
    const surfaceOverrides = typeof getSurf === "function" ? getSurf() : null;
    
    // 只包含装饰物，不包含家具（家具的变化不影响风格切换提示）
    const layout = getLayout();
    const decorationsOnly = layout.filter((row) => modelIdIsDecoration(row.model));
    
    return JSON.stringify({
      decorations: decorationsOnly,
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
      surfaceOverrides: surfaceOverrides,
    });
  }

  /**
   * 序列化完整设计（用于保存按钮状态检测）
   * 包含家具、装饰物和材质覆盖
   */
  function serializeDesignForSave() {
    const getSurf = window.layoutEditorGetSurfaceOverrides;
    const surfaceOverrides = typeof getSurf === "function" ? getSurf() : null;
    
    return JSON.stringify({
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
      surfaceOverrides: surfaceOverrides,
    });
  }

  function syncPropertiesPanelForSelection(group) {
    if (!propertiesPanel) return;
    clearFloorplanSurfaceSelection();
    if (!group || !group.userData?.isFurniture) {
      propertiesPanel.classList.remove("is-visible");
      if (propertiesName) propertiesName.textContent = "未选择";
      syncPropPanelDimsFromItem(null);
      syncPropPanelAppearance(null, null);
      return;
    }
    // 检查是否是装饰模型
    const modelType = group.userData.modelType;
    const decCatalog = window.__decorationCatalog;
    const isDecoration = decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType);
    if (isDecoration) {
      propertiesPanel.classList.remove("is-visible");
      return;
    }
    propertiesPanel.classList.add("is-visible");
    const item = byId.get(modelType);
    if (propertiesName) propertiesName.textContent = item ? getFurnitureDisplayName(item) : modelType || "家具";
    syncPropPanelDimsFromItem(item);
    syncPropPanelAppearance(group, item);
    const o = sceneXZToCenteredCm(group.position.x, group.position.z);
    const rot = group.userData.rotDeg ?? 0;
    if (propInputX) propInputX.value = String(Math.round(o.x));
    if (propInputZ) propInputZ.value = String(Math.round(o.y));
    if (propInputRotY) propInputRotY.value = String(Math.round(rot));
  }

  let selectionBoxHelper = null; // 选中框辅助对象

  function selectFurniture(group, skipPanelSync = false) {
    // 移除旧的选中框
    if (selectionBoxHelper) {
      if (selectionBoxHelper.parent) {
        selectionBoxHelper.parent.remove(selectionBoxHelper);
      }
      selectionBoxHelper.geometry?.dispose();
      selectionBoxHelper.material?.dispose();
      selectionBoxHelper = null;
    }

    selectedGroup = group || null;
    floorplanSelected = false;

    if (selectedGroup) {
      // 创建选中框
      const box = new THREE.BoxHelper(selectedGroup, 0xffaa00); // 橙黄色
      box.material.linewidth = 2;
      box.material.transparent = true;
      box.material.opacity = 0.8;
      box.material.depthTest = true;
      box.material.depthWrite = false;
      
      scene.add(box);
      selectionBoxHelper = box;
    }

    if (!skipPanelSync) {
      syncPropertiesPanelForSelection(selectedGroup);
    }
  }

  function deselectVisualOnly() {
    if (selectionBoxHelper) {
      if (selectionBoxHelper.parent) {
        selectionBoxHelper.parent.remove(selectionBoxHelper);
      }
      selectionBoxHelper.geometry?.dispose();
      selectionBoxHelper.material?.dispose();
      selectionBoxHelper = null;
    }
    selectedGroup = null;
  }

  function applyPropertiesFromPanel() {
    if (selectedFloorplanSurface) return false;
    if (!selectedGroup || !selectedGroup.userData?.isFurniture) return false;
    const x = parseFloat(propInputX?.value ?? "");
    const zField = parseFloat(propInputZ?.value ?? "");
    const deg = parseFloat(propInputRotY?.value ?? "");
    const cur = sceneXZToCenteredCm(selectedGroup.position.x, selectedGroup.position.z);
    const ox = Number.isFinite(x) ? Math.round(x) : Math.round(cur.x);
    const oy = Number.isFinite(zField) ? Math.round(zField) : Math.round(cur.y);
    let rot = selectedGroup.userData.rotDeg ?? 0;
    if (Number.isFinite(deg)) {
      rot = Math.round(deg) % 360;
      if (rot < 0) rot += 360;
    }
    selectedGroup.userData.rotDeg = rot;
    setFurnitureFromLayoutCm(selectedGroup, ox, oy, rot, { wallSnap: false });
    schedulePushHistory();
    return true;
  }

  function resizeRenderer() {
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    applyRendererPixelRatio();
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function resetCameraView() {
    controls.target.set(0, 0, 0);
    camera.position.set(0, CAMERA_DEFAULT_Y, CAMERA_DEFAULT_Z);
    controls.update();
  }

  function getViewTransform() {
    const d = camera.position.distanceTo(controls.target);
    return {
      tx: controls.target.x * 100,
      ty: controls.target.z * 100,
      scale: Math.min(8, Math.max(0.12, 36 / Math.max(0.4, d))),
    };
  }

  function setViewTransform(t) {
    if (!t) return;
    const tx = Number(t.tx), ty = Number(t.ty), sc = Number(t.scale);
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(sc)) return;
    const scl = Math.min(8, Math.max(0.12, sc));
    controls.target.set(tx / 100, 0, ty / 100);
    const d = 36 / scl;
    // 与 resetCameraView 的方向一致：x=0，y/z=tan(60)，并确保 distance(target,camera) = d
    const yOff = d * Math.sin(CAMERA_DEFAULT_ELEVATION_RAD);
    const zOff = d * Math.cos(CAMERA_DEFAULT_ELEVATION_RAD);
    camera.position.set(controls.target.x, controls.target.y + yOff, controls.target.z + zOff);
    controls.update();
  }

  function rayPickFurniture(clientX, clientY) {
    if (!floorSelectionEnabled) return null;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return null;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const pickTargets = activeFloorPickMeshes.length ? activeFloorPickMeshes : interactiveMeshes;
    const hits = raycaster.intersectObjects(pickTargets, true);
    if (!hits.length) return null;
    for (const hit of hits) {
      const root = hit.object.userData.__furnitureRoot;
      if (!root?.userData?.isFurniture) continue;
      if (root.userData.isFloorActive === false) continue;
      return root;
    }
    return null;
  }

  function rayPickFloorplan(clientX, clientY) {
    if (!floorSelectionEnabled) return false;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return false;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(floorplanRoot.children, true);
    return hits.some((h) => h.object.userData?.floorplanPick);
  }

  /** 当前选中楼层在世界坐标中的水平面高度（米），用于射线与“楼板平面”求交，与家具 group.position.y 一致 */
  function getPlacementPlaneWorldY() {
    if (!currentFloorplanEntry) return 0;
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    if (!floors.length) return 0;
    const idx = normalizeFloorIndex(currentFloorplanEntry, currentFloorIndex);
    const fl = floors[idx];
    if (!fl) return 0;
    const fidRaw = String(fl?.id ?? "").trim() || `floor${idx + 1}`;
    return floorYOffsetById.get(normalizeFloorKey(fidRaw)) ?? 0;
  }

  function intersectPlaneCm(clientX, clientY, planeY = 0) {
    const rect = container.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const pt = new THREE.Vector3();
    // Plane: normal.dot(point) + constant = 0
    placementPlane.constant = -planeY;
    if (!raycaster.ray.intersectPlane(placementPlane, pt)) return null;
    const cm = sceneXZToCenteredCm(pt.x, pt.z);
    return { x: snap(cm.x), y: snap(cm.y) };
  }

  async function addFurniture(modelId, xCm = 0, yCm = 0, skipPanelSync = false) {
    const g = await appendFurnitureItem(modelId, xCm, yCm, 0, null, { wallSnap: wallSnapEnabled });
    if (g) selectFurniture(g, skipPanelSync);
    updateFurnitureFloorVisibility();
    updateBottomUI();
    if (historyReady) pushHistorySnapshot();
    return g;
  }

  function removeSelectedFurniture() {
    if (!selectedGroup?.userData?.isFurniture) return;
    unregisterFurnitureGroup(selectedGroup);
    furnitureRoot.remove(selectedGroup);
    disposeObject3D(selectedGroup);
    shadowCacheDirty = true;
    selectFurniture(null); // 同时清除选中框和属性面板
    updateBottomUI();
    if (historyReady) pushHistorySnapshot();
  }

  function isEditViewActive() {
    return document.getElementById("appViewEdit")?.classList.contains("is-active");
  }

  const FLOORPLAN_SURFACE_LONG_PRESS_MS = 450;
  const FLOORPLAN_SURFACE_MOVE_CANCEL_PX2 = 12 * 12;

  function onPointerDown(e) {
    if (!isEditViewActive() || e.button !== 0) return;
    if (!floorSelectionEnabled) {
      // 无楼层选中态：仅预览，不允许选中户型或家具
      selectFurniture(null);
      floorplanSelected = false;
      return;
    }
    const fur = rayPickFurniture(e.clientX, e.clientY);
    if (fur && e.altKey) {
      selectFurniture(fur);
      altDragState = {
        pointerId: e.pointerId,
        group: fur,
        startClientY: e.clientY,
        startLiftM: Number(fur.userData.decorationLiftM) || 0,
      };
      controls.enabled = false;
      e.preventDefault();
      return;
    }
    if (fur) {
      const wasSelected = fur === selectedGroup;
      selectFurniture(fur);
      // 拖拽锚点：记录按下时鼠标射线与“家具所在楼层平面”的交点相对家具(x/z)的偏移
      // 避免切换楼层后，因为射线与不同高度平面求交导致的落点偏移
      const planeY = fur.position?.y ?? 0;
      const startCm = intersectPlaneCm(e.clientX, e.clientY, planeY);
      const curCm = sceneXZToCenteredCm(fur.position.x, fur.position.z);
      const offsetX = startCm ? startCm.x - curCm.x : 0;
      const offsetY = startCm ? startCm.y - curCm.y : 0;
      dragState = {
        pointerId: e.pointerId,
        group: fur,
        offsetCm: { x: offsetX, y: offsetY },
        startX: e.clientX,
        startY: e.clientY,
        wasSelected,
      };
      controls.enabled = false;
      e.preventDefault();
      return;
    }
    const surf = rayPickFloorplanSurface(e.clientX, e.clientY);
    if (surf) {
      // 多选状态的切换延迟到 pointerup（确认是短按后）再执行，避免长按旋转时误改选中集合
      pendingSurfacePick = {
        surf,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        isCtrl: e.ctrlKey || e.metaKey,
        timerId: setTimeout(() => {
          pendingSurfacePick = null;
        }, FLOORPLAN_SURFACE_LONG_PRESS_MS),
      };
      floorplanSelected = false;
      e.preventDefault();
      return;
    }
    if (rayPickFloorplan(e.clientX, e.clientY)) {
      // 延迟清除选中状态到 pointerup，避免拖拽旋转时误清除
      pendingClearSelection = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        floorplanSelected: true,
      };
      return;
    }
    // 点击完全空白区域：同样延迟到 pointerup
    pendingClearSelection = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      floorplanSelected: false,
    };
  }

  function onPointerMove(e) {
    if (pendingSurfacePick && e.pointerId === pendingSurfacePick.pointerId) {
      const dx = e.clientX - pendingSurfacePick.startX;
      const dy = e.clientY - pendingSurfacePick.startY;
      if (dx * dx + dy * dy > FLOORPLAN_SURFACE_MOVE_CANCEL_PX2) {
        clearTimeout(pendingSurfacePick.timerId);
        pendingSurfacePick = null;
      }
    }
    if (pendingClearSelection && e.pointerId === pendingClearSelection.pointerId) {
      const dx = e.clientX - pendingClearSelection.startX;
      const dy = e.clientY - pendingClearSelection.startY;
      if (dx * dx + dy * dy > FLOORPLAN_SURFACE_MOVE_CANCEL_PX2) {
        pendingClearSelection = null;
      }
    }
    if (altDragState && e.pointerId === altDragState.pointerId) {
      const dy = e.clientY - altDragState.startClientY;
      const sensitivity = 0.0025;
      const g = altDragState.group;
      if (g?.userData?.isFurniture) {
        const newLift = altDragState.startLiftM - dy * sensitivity;
        g.userData.decorationLiftM = clampDecorationLiftMForGroup(g, newLift);
        updateFurnitureFloorVisibility();
        selectionBoxHelper?.update();
      }
      return;
    }
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    // 拖拽时让交点平面跟随当前家具楼层高度，避免切层后“第一下跳动”
    const planeY = dragState.group?.position?.y ?? 0;
    const cm = intersectPlaneCm(e.clientX, e.clientY, planeY);
    if (!cm) return;
    const g = dragState.group;
    const fp = g.userData.footprint;
    const rot = g.userData.rotDeg ?? 0;
    // 使用初始 offset 保持拖拽锚点一致（不同楼层时避免落点偏移）
    const adjX = cm.x - (dragState.offsetCm?.x ?? 0);
    const adjY = cm.y - (dragState.offsetCm?.y ?? 0);
    const c = clampFurnitureCentered(adjX, adjY, rot, fp.hw, fp.hh);
    setFurnitureFromLayoutCm(g, c.x, c.y, rot, { wallSnap: wallSnapEnabled });
    selectionBoxHelper?.update();
    syncPropertiesPanelForSelection(g);
  }

  function onPointerUp(e) {
    if (pendingSurfacePick && e.pointerId === pendingSurfacePick.pointerId) {
      clearTimeout(pendingSurfacePick.timerId);
      const { surf, isCtrl } = pendingSurfacePick;
      pendingSurfacePick = null;
      if (e.type !== "pointercancel") {
        // 确认是短按后才执行多选切换，避免长按旋转时误改选中状态
        // 同一元素再次点击（非 Ctrl）→ toggle 后集合变空 → 取消选中
        let deselected = false;
        if (surf.kind === "allFloors" && surf.roomId) {
          if (isCtrl) {
            toggleRoomFloorSelection(surf.roomId);
          } else {
            clearRoomFloorSelection();
            clearDoorSelection();
            clearWallFaceSelection();
            toggleRoomFloorSelection(surf.roomId);
          }
          if (selectedRoomFloorIds.size === 0) deselected = true;
        } else if (surf.kind === "allDoors" && surf.doorId) {
          if (isCtrl) {
            toggleDoorSelection(surf.doorId);
          } else {
            clearDoorSelection();
            clearRoomFloorSelection();
            clearWindowSelection();
            clearWallFaceSelection();
            toggleDoorSelection(surf.doorId);
          }
          if (selectedDoorIds.size === 0) deselected = true;
        } else if (surf.kind === "allWindows" && surf.windowId) {
          if (isCtrl) {
            toggleWindowSelection(surf.windowId);
          } else {
            clearWindowSelection();
            clearRoomFloorSelection();
            clearDoorSelection();
            clearWallFaceSelection();
            toggleWindowSelection(surf.windowId);
          }
          if (selectedWindowIds.size === 0) deselected = true;
        } else if (surf.kind === "wallFace" && surf.wallId) {
          if (isCtrl) {
            clearRoomFloorSelection();
            clearDoorSelection();
            clearWindowSelection();
            toggleWallFaceSelection(surf.wallId, surf.faceId);
          } else {
            clearWallFaceSelection();
            clearRoomFloorSelection();
            clearDoorSelection();
            clearWindowSelection();
            toggleWallFaceSelection(surf.wallId, surf.faceId);
          }
          if (selectedWallFaceIds.size === 0) deselected = true;
        } else {
          // allWalls 等无多选 id 的类型：再次点击同层同类型 → 取消选中
          const prev = selectedFloorplanSurface;
          if (!isCtrl && prev && prev.kind === surf.kind && prev.floorLevelId === surf.floorLevelId) {
            deselected = true;
          }
          clearRoomFloorSelection();
          clearDoorSelection();
          clearWindowSelection();
          clearWallFaceSelection();
        }
        if (deselected) {
          clearFloorplanSurfaceSelection();
          propertiesPanel?.classList.remove("is-visible");
        } else {
          void selectFloorplanSurface(surf);
        }
      }
    }
    if (pendingClearSelection && e.pointerId === pendingClearSelection.pointerId) {
      const { floorplanSelected: willSelectFloorplan } = pendingClearSelection;
      pendingClearSelection = null;
      if (e.type !== "pointercancel") {
        clearFloorplanSurfaceSelection();
        selectFurniture(null);
        floorplanSelected = willSelectFloorplan;
        if (!willSelectFloorplan) propertiesPanel?.classList.remove("is-visible");
        else propertiesPanel?.classList.remove("is-visible");
      }
    }
    if (altDragState && e.pointerId === altDragState.pointerId) {
      altDragState = null;
      controls.enabled = true;
      if (historyReady) pushHistorySnapshot();
      return;
    }
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const ds = dragState;
    dragState = null;
    controls.enabled = true;
    if (e.type !== "pointercancel") {
      const dx = e.clientX - (ds.startX ?? e.clientX);
      const dy = e.clientY - (ds.startY ?? e.clientY);
      const didDrag = dx * dx + dy * dy > FLOORPLAN_SURFACE_MOVE_CANCEL_PX2;
      if (!didDrag && ds.wasSelected) {
        // 再次点击同一家具且没有拖拽：取消选中
        selectFurniture(null);
        return;
      }
    }
    if (historyReady) pushHistorySnapshot();
  }

  container.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  propSurfaceColor?.addEventListener("change", () => {
    void commitFloorplanSurfaceEdit();
  });
  propSurfaceMaterial?.addEventListener("change", () => {
    void commitFloorplanSurfaceEdit();
  });
  for (const el of [
    propSurfaceRoughness,
    propSurfaceMetalness,
    propSurfaceUvScaleX,
    propSurfaceUvScaleY,
    propSurfaceTextureRotation,
    propSurfaceOpacity,
    propSurfaceTransmission,
    propSurfaceIor,
  ]) {
    el?.addEventListener("change", () => {
      void commitFloorplanSurfaceEdit();
    });
  }
  propSurfaceMaterialClear?.addEventListener("click", () => {
    void (async () => {
      if (!propSurfaceMaterial || !selectedFloorplanSurface) return;
      pendingSurfaceMaterialPresetClear = true;
      propSurfaceMaterial.value = "";
      if (propSurfaceTextureAlbedo) propSurfaceTextureAlbedo.value = "";
      const lib = await getFloorplanMaterialsLibraryBag();
      updateSurfaceMaterialNameLabel("", lib);
      propSurfaceMaterialGrid?.querySelectorAll(".prop-surface-material__cell").forEach((el) => {
        el.classList.remove("is-selected");
      });
      const sel = selectedFloorplanSurface;
      const scope = floorplanSurfaceScopeFromKind(sel.kind);
      const ovRaw = getFloorplanSurfaceGlobalOverride(sel.floorLevelId, scope);
      const ovNoMat =
        ovRaw && typeof ovRaw === "object" ? { ...ovRaw } : {};
      delete ovNoMat.materialId;
      syncSurfacePbrInputs(ovNoMat, "", lib, sel.kind === "allWindows");
      propSurfaceMaterial.dispatchEvent(new Event("change", { bubbles: true }));
    })();
  });
  propSurfaceResetDefault?.addEventListener("click", () => {
    void resetFloorplanSurfaceToDefault();
  });
  propSurfaceColorReset?.addEventListener("click", () => {
    void resetFloorplanSurfaceColorOnly();
  });

  container.addEventListener("dblclick", (e) => {
    if (!isEditViewActive()) return;
    const fur = rayPickFurniture(e.clientX, e.clientY);
    if (!fur) return;
    e.preventDefault();
    let r = (fur.userData.rotDeg ?? 0) + 90;
    r %= 360;
    fur.userData.rotDeg = r;
    const cm = sceneXZToCenteredCm(fur.position.x, fur.position.z);
    const fp = fur.userData.footprint;
    const c = clampFurnitureCentered(cm.x, cm.y, r, fp.hw, fp.hh);
    setFurnitureFromLayoutCm(fur, c.x, c.y, r, { wallSnap: wallSnapEnabled });
    selectionBoxHelper?.update();
    syncPropertiesPanelForSelection(fur);
    if (historyReady) pushHistorySnapshot();
  });

  document.addEventListener("keydown", (e) => {
    if (!isEditViewActive()) return;
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "z") {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (
      selectedGroup?.userData?.isFurniture &&
      !dragState &&
      !altDragState &&
      !["INPUT", "TEXTAREA"].includes(e.target?.tagName || "") &&
      !e.target?.isContentEditable
    ) {
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        const cm = sceneXZToCenteredCm(selectedGroup.position.x, selectedGroup.position.z);
        let dx = 0, dy = 0;
        if (k === "ArrowLeft") dx = -GRID;
        else if (k === "ArrowRight") dx = GRID;
        else if (k === "ArrowUp") dy = -GRID;
        else if (k === "ArrowDown") dy = GRID;
        const rot = selectedGroup.userData.rotDeg ?? 0;
        const fp = selectedGroup.userData.footprint;
        const c = clampFurnitureCentered(cm.x + dx, cm.y + dy, rot, fp.hw, fp.hh);
        setFurnitureFromLayoutCm(selectedGroup, c.x, c.y, rot, { wallSnap: wallSnapEnabled });
        selectionBoxHelper?.update();
        syncPropertiesPanelForSelection(selectedGroup);
        schedulePushHistory();
        return;
      }
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    if (floorplanSelected && currentFloorplanEntry) {
      e.preventDefault();
      void tryClearCurrentFloorplanWithConfirm();
      return;
    }
    if (selectedGroup) {
      e.preventDefault();
      removeSelectedFurniture();
    }
  });

  document.querySelectorAll("[data-layout-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = camera.position.distanceTo(controls.target);
      const f = btn.dataset.layoutZoom === "in" ? 0.88 : 1.12;
      const nd = Math.min(controls.maxDistance, Math.max(controls.minDistance, d * f));
      camera.position.sub(controls.target).setLength(nd).add(controls.target);
      controls.update();
    });
  });

  document.querySelectorAll("[data-layout-pan]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = 0.35;
      const pan = new THREE.Vector3();
      const dir = btn.dataset.layoutPan;
      if (dir === "left") pan.x = -step;
      else if (dir === "right") pan.x = step;
      else if (dir === "up") pan.z = -step;
      else if (dir === "down") pan.z = step;
      controls.target.add(pan);
      camera.position.add(pan);
      controls.update();
    });
  });

  document.querySelectorAll("[data-layout-reset]").forEach((btn) => btn.addEventListener("click", () => resetCameraView()));
  gridToggleBtn?.addEventListener("click", () => setGridVisible(!gridVisible));
  floorHideOthersToggleBtn?.addEventListener("click", () => {
    hideOtherFloors = !hideOtherFloors;
    floorHideOthersToggleBtn.classList.toggle("is-active", hideOtherFloors);
    floorHideOthersToggleBtn.setAttribute("aria-pressed", hideOtherFloors ? "true" : "false");
    syncHideOtherFloorsFloorplanVisibility();
    updateFurnitureFloorVisibility();
    syncOtherOpacityUi();
  });
  undoBtn?.addEventListener("click", () => { void undo(); });
  redoBtn?.addEventListener("click", () => { void redo(); });
  document.querySelectorAll("[data-layout-floorplan-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (currentFloorplanEntry) void tryClearCurrentFloorplanWithConfirm();
    });
  });


  function requestDeleteFloorplanConfirm() {
    const dlg = document.getElementById("deleteFloorplanDialog");
    const cancelBtn = document.getElementById("deleteFloorplanCancel");
    const confirmBtn = document.getElementById("deleteFloorplanConfirm");
    if (!dlg || !cancelBtn || !confirmBtn) {
      return Promise.resolve(window.confirm("确定删除当前户型吗？"));
    }
    return new Promise((resolve) => {
      let settled = false;
      function cleanup() {
        cancelBtn.removeEventListener("click", onCancel);
        confirmBtn.removeEventListener("click", onConfirm);
        dlg.removeEventListener("cancel", onCancel);
      }
      function finish(ok) {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (typeof dlg.close === "function") dlg.close();
          else dlg.removeAttribute("open");
        } catch (_) {}
        resolve(ok);
      }
      function onCancel() { finish(false); }
      function onConfirm() { finish(true); }
      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
      dlg.addEventListener("cancel", onCancel);
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
  }

  function requestReplaceFloorplanConfirm() {
    const dlg = document.getElementById("replaceFloorplanDialog");
    const cancelBtn = document.getElementById("replaceFloorplanCancel");
    const confirmBtn = document.getElementById("replaceFloorplanConfirm");
    if (!dlg || !cancelBtn || !confirmBtn)
      return Promise.resolve(window.confirm("替换户型将清空当前场景家具。是否继续？"));
    return new Promise((resolve) => {
      let settled = false;
      function cleanup() {
        cancelBtn.removeEventListener("click", onCancel);
        confirmBtn.removeEventListener("click", onConfirm);
        dlg.removeEventListener("cancel", onCancel);
      }
      function finish(ok) {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          if (typeof dlg.close === "function") dlg.close();
          else dlg.removeAttribute("open");
        } catch (_) {}
        resolve(ok);
      }
      function onCancel() { finish(false); }
      function onConfirm() { finish(true); }
      cancelBtn.addEventListener("click", onCancel);
      confirmBtn.addEventListener("click", onConfirm);
      dlg.addEventListener("cancel", onCancel);
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    });
  }

  async function canReplaceExistingFloorplan(nextEntry) {
    if (!currentFloorplanEntry) return true;
    const nextId = String(nextEntry?.id ?? "").trim();
    const curId = String(getCurrentFloorplanId() ?? "").trim();
    if (nextId && curId && nextId === curId) return true;
    return requestReplaceFloorplanConfirm();
  }

  async function tryApplyFloorplanEntryAtCenter(entry) {
    if (!entry) return false;
    const nextId = String(entry?.id ?? "").trim();
    const curId = String(getCurrentFloorplanId() ?? "").trim();
    const isSameFloorplan = nextId && curId && nextId === curId;
    const hasFloorplan = Boolean(currentFloorplanEntry);
    const hasFurniture = furnitureRoot.children.some((c) => c.userData?.isFurniture);

    // 需要弹窗确认：① 替换不同户型，② 无户型但场景有家具
    const needsConfirm = (hasFloorplan && !isSameFloorplan) || (!hasFloorplan && hasFurniture);

    if (needsConfirm && !(await requestReplaceFloorplanConfirm())) return false;

    if (needsConfirm) {
      await rebuildFromLayout([]);
      selectFurniture(null);
    }
    await applyFloorplanEntryAtWorld(entry);
    return true;
  }

  async function tryClearCurrentFloorplanWithConfirm() {
    if (!currentFloorplanEntry) return false;
    const ok = await requestDeleteFloorplanConfirm();
    if (!ok) return false;
    clearFloorplan();
    return true;
  }

  function addFloorplanFromLibraryAtCenter(floorPlanId) {
    const cat = window.__floorPlanCatalog;
    const e = cat?.byId instanceof Map ? cat.byId.get(floorPlanId) : null;
    if (e) void tryApplyFloorplanEntryAtCenter(e);
  }

  const LIBRARY_DRAG_GHOST_THRESHOLD = 6;
  let pendingLibraryDrag = null;
  let pendingFloorplanDrag = null;

  function pushPtr() { document.body.classList.add("vision-home-pointer-dragging"); }
  function popPtr() { document.body.classList.remove("vision-home-pointer-dragging"); }

  function ensureGhost(pending) {
    if (!pending || pending.ghostEl) return;
    const ghost = document.createElement("div");
    ghost.className = "furniture-library-drag-ghost" + (pending.isDecoration ? " is-decoration" : "");
    ghost.setAttribute("aria-hidden", "true");
    const thumb = pending.sourceCard?.querySelector(".asset-thumb");
    if (thumb) ghost.appendChild(thumb.cloneNode(true));
    document.body.appendChild(ghost);
    pending.ghostEl = ghost;
  }
  function removeGhost(pending) {
    pending?.ghostEl?.remove();
    if (pending) pending.ghostEl = null;
  }
  function posGhost(ghost, cx, cy) {
    if (!ghost) return;
    const w = ghost.offsetWidth || 108, h = ghost.offsetHeight || 108;
    ghost.style.left = `${Math.round(cx - w / 2)}px`;
    ghost.style.top = `${Math.round(cy - h / 2)}px`;
  }

  function onLibMove(e) {
    if (!pendingLibraryDrag || e.pointerId !== pendingLibraryDrag.pointerId) return;
    const d = Math.hypot(e.clientX - pendingLibraryDrag.sx, e.clientY - pendingLibraryDrag.sy);
    if (d >= LIBRARY_DRAG_GHOST_THRESHOLD) {
      pendingLibraryDrag.didDrag = true;
      ensureGhost(pendingLibraryDrag);
      posGhost(pendingLibraryDrag.ghostEl, e.clientX, e.clientY);
    }
  }
  function endLibDrag(e) {
    if (!pendingLibraryDrag || e.pointerId !== pendingLibraryDrag.pointerId) return;
    removeGhost(pendingLibraryDrag);
    const p = pendingLibraryDrag;
    pendingLibraryDrag = null;
    popPtr();
    window.removeEventListener("pointermove", onLibMove);
    window.removeEventListener("pointerup", endLibDrag);
    window.removeEventListener("pointercancel", endLibDrag);
    if (!p.didDrag) return;
    const rect = container.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    if (!floorSelectionEnabled) return;
    if (!byId.has(p.model)) return;
    const cm = intersectPlaneCm(x, y, getPlacementPlaneWorldY());
    if (cm) void addFurniture(p.model, cm.x, cm.y, p.isDecoration).catch((err) => console.warn("[VisionHome] addFurniture:", err));
  }

  function onFpMove(e) {
    if (!pendingFloorplanDrag || e.pointerId !== pendingFloorplanDrag.pointerId) return;
    const d = Math.hypot(e.clientX - pendingFloorplanDrag.sx, e.clientY - pendingFloorplanDrag.sy);
    if (d >= LIBRARY_DRAG_GHOST_THRESHOLD) {
      pendingFloorplanDrag.didDrag = true;
      ensureGhost(pendingFloorplanDrag);
      posGhost(pendingFloorplanDrag.ghostEl, e.clientX, e.clientY);
    }
  }
  async function endFpDrag(e) {
    if (!pendingFloorplanDrag || e.pointerId !== pendingFloorplanDrag.pointerId) return;
    removeGhost(pendingFloorplanDrag);
    const p = pendingFloorplanDrag;
    pendingFloorplanDrag = null;
    popPtr();
    window.removeEventListener("pointermove", onFpMove);
    window.removeEventListener("pointerup", endFpDrag);
    window.removeEventListener("pointercancel", endFpDrag);
    if (!p.didDrag) return;
    const rect = container.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const cat = window.__floorPlanCatalog;
    const entry = cat?.byId instanceof Map ? cat.byId.get(p.floorPlanId) : null;
    if (entry) await tryApplyFloorplanEntryAtCenter(entry);
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      const card = e.target.closest?.(".asset-card[data-model]");
      if (card) {
        const furniturePanel = card.closest?.(".side-panel[data-panel='assets']");
        const decorationPanel = card.closest?.(".side-panel[data-panel='decorations']");

        if (furniturePanel && furniturePanel.classList.contains("is-visible") && isEditViewActive()) {
          // 家具库卡片拖动
          if (e.shiftKey) {
            if (!floorSelectionEnabled) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const n = Math.floor(Math.random() * 5) - 2, m = Math.floor(Math.random() * 5) - 2;
            void addFurniture(card.dataset.model, n * GRID, m * GRID, false).catch((err) => console.warn("[VisionHome] addFurniture:", err));
            return;
          }
          if (!e.isPrimary) return;
          window.__selectFurnitureLibraryCardByModel?.(card.dataset.model);
          pushPtr();
          pendingLibraryDrag = { model: card.dataset.model, sourceCard: card, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, didDrag: false, ghostEl: null, isDecoration: false };
          window.addEventListener("pointermove", onLibMove, { passive: true });
          window.addEventListener("pointerup", endLibDrag);
          window.addEventListener("pointercancel", endLibDrag);
          return;
        }

        if (decorationPanel && decorationPanel.classList.contains("is-visible") && isEditViewActive()) {
          // 装饰库卡片拖动
          if (e.shiftKey) {
            if (!floorSelectionEnabled) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            const n = Math.floor(Math.random() * 5) - 2, m = Math.floor(Math.random() * 5) - 2;
            void addFurniture(card.dataset.model, n * GRID, m * GRID, true).catch((err) => console.warn("[VisionHome] addDecoration:", err));
            return;
          }
          if (!e.isPrimary) return;
          window.__selectDecorationLibraryCardByModel?.(card.dataset.model);
          pushPtr();
          pendingLibraryDrag = { model: card.dataset.model, sourceCard: card, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, didDrag: false, ghostEl: null, isDecoration: true };
          window.addEventListener("pointermove", onLibMove, { passive: true });
          window.addEventListener("pointerup", endLibDrag);
          window.addEventListener("pointercancel", endLibDrag);
          return;
        }
        return;
      }
      const fpCard = e.target.closest?.(".asset-card[data-floor-plan-id]");
      if (fpCard) {
        const panel = fpCard.closest?.('.side-panel[data-panel="floorplans"]');
        if (!panel || !panel.classList.contains("is-visible") || !isEditViewActive()) return;
        const floorPlanId = String(fpCard.dataset.floorPlanId || "").trim();
        if (!floorPlanId) return;
        if (e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void addFloorplanFromLibraryAtCenter(floorPlanId);
          return;
        }
        if (!e.isPrimary) return;
        window.__selectFloorplanLibraryCardById?.(floorPlanId);
        // 拖动户型卡片：关闭属性面板，避免遮挡与误操作
        clearFloorplanSurfaceSelection();
        selectFurniture(null);
        floorplanSelected = false;
        propertiesPanel?.classList.remove("is-visible");
        pushPtr();
        pendingFloorplanDrag = { floorPlanId, sourceCard: fpCard, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, didDrag: false, ghostEl: null };
        window.addEventListener("pointermove", onFpMove, { passive: true });
        window.addEventListener("pointerup", endFpDrag);
        window.addEventListener("pointercancel", endFpDrag);
      }
    },
    true,
  );

  window.addEventListener("visionhome:design-select", (e) => {
    const project = e.detail?.project;
    if (project) void applyFromDesignProject(project);
  });
  window.addEventListener("visionhome:design-new", () => {
    clearFloorplan();
    void applyExternalLayout([]);
  });

  const ctx = {
    state: editorState,
    camera,
    controls,
    dirLight,
    fitDirectionalShadowFrustum,
    floorplanDepthPrepassMat,
    floorplanRoot,
    furnitureRoot,
    getFloorsFromEntry,
    grid,
    renderer,
    scene,
    tmpVecA,
    tmpVecB,
    tmpVecC,
  };

  const { animate, renderEditorScene } = createRenderLoop(ctx);

  window.addEventListener("resize", resizeRenderer);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeRenderer).observe(container);

  function getCurrentLightingConfig() {
    return getCurrentLightingConfigFromToolbar();
  }

  function setRenderQualityMode(mode, opts = {}) {
    return setRenderQualityModeFromToolbar(mode, opts);
  }

  function syncRenderQualityToolbarUi() {
    return syncRenderQualityToolbarUiFromToolbar();
  }

  initializeToolbarsAndApis();

  ensureFloorLevelControls();
  setGridVisible(false);
  rebuildFloorplan3D();
  resizeRenderer();
  resetCameraView();
  selectFurniture(null);
  initHistory();
  historyReady = true;
  window.__designLayoutBaseline = serializeDesignBaseline();
  window.__designSaveBaseline = serializeDesignForSave();
  emitLayoutChanged();
  animate();

  const okResult = { ok: true, reason: null, catalogSize: byId.size };
  window.__visionHomeLayoutEditor = okResult;
  return okResult;
}
