/**
 * 编辑模式 Three.js：户型挤出 + 家具交互，兼容 window.svgEditor* API
 */
import * as THREE from "three";
import { ShapeUtils } from "three";
import { OrbitControls } from "../../assets/vendor/OrbitControls.js";
import { getFloorBBoxCm } from "../floorplan/floorplanSvg.js";
import { normalizeDoorStyle, defaultDoorStyleWhite } from "../floorplan/doorStyle.js";
import { normalizeWindowStyle, defaultWindowStyleWhite } from "../floorplan/windowStyle.js";
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
import { GLTFLoader } from "../../assets/vendor/GLTFLoader.js";
import { RoomEnvironment } from "../../assets/vendor/RoomEnvironment.js";
import { resolveModelUrl } from "../furniture/furnitureManager.js";
import { mountFloorplanColorPicker } from "../ui/floorplanColorPicker.js";
import { DATA_PATHS } from "../core/schema.js";

const VIEW_W = 3000;
const VIEW_H = 3000;
/** 编辑区平面半宽/半深（cm），原点在画布中心，与 Three 场景 XZ=0 对齐 */
const CENTER_HALF = VIEW_W / 2;
const GRID = 1;
const FLOORPLAN_PAD = 80;
const FLOORPLAN_SIZE_FACTOR = 0.38;
const MAX_HISTORY = 80;
/** 户型墙体与地面挤出块统一颜色 */
/** 户型墙/地/顶面：略偏灰，避免与 IBL 叠加后发白糊成一片 */
const FLOORPLAN_SURFACE_COLOR = 0xc9c4be;

/**
 * 风格包未配置 sceneLighting 时的默认曝光与灯光（偏中性）。
 * 户型风格包 `assets/floorplans/style/<floorplanId>.json` 中 `styles.<key>.sceneLighting` 可覆盖全局光照。
 */
const DEFAULT_SCENE_LIGHTING = {
  toneMappingExposure: 0.88,
  ambient: { color: "#ffffff", intensity: 0.26 },
  hemisphere: { sky: "#dbeafe", ground: "#0b1220", intensity: 0.36 },
  directional: { color: "#ffffff", intensity: 1.0 },
  envMapIntensity: 0.35,
};

/**
 * @param {object | null | undefined} over 风格 JSON 中的 sceneLighting
 */
function mergeSceneLighting(over) {
  const base = DEFAULT_SCENE_LIGHTING;
  if (!over || typeof over !== "object") {
    return {
      toneMappingExposure: base.toneMappingExposure,
      ambient: { ...base.ambient },
      hemisphere: { ...base.hemisphere },
      directional: { ...base.directional },
      envMapIntensity: base.envMapIntensity,
    };
  }
  return {
    toneMappingExposure: Number.isFinite(Number(over.toneMappingExposure))
      ? Number(over.toneMappingExposure)
      : base.toneMappingExposure,
    ambient: { ...base.ambient, ...(typeof over.ambient === "object" && over.ambient ? over.ambient : {}) },
    hemisphere: {
      ...base.hemisphere,
      ...(typeof over.hemisphere === "object" && over.hemisphere ? over.hemisphere : {}),
    },
    directional: {
      ...base.directional,
      ...(typeof over.directional === "object" && over.directional ? over.directional : {}),
    },
    envMapIntensity: Number.isFinite(Number(over.envMapIntensity))
      ? Number(over.envMapIntensity)
      : base.envMapIntensity,
  };
}

function applyHexToThreeColor(threeColor, hex, fallbackHexNum) {
  const s = String(hex ?? "").trim();
  try {
    threeColor.setStyle(s.startsWith("#") ? s : `#${s}`);
  } catch {
    threeColor.setHex(fallbackHexNum);
  }
}

/**
 * @param {import("three").WebGLRenderer} renderer
 * @param {import("three").AmbientLight} ambientLight
 * @param {import("three").HemisphereLight} hemiLight
 * @param {import("three").DirectionalLight} dirLight
 * @param {ReturnType<typeof mergeSceneLighting>} cfg
 */
function applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, cfg) {
  if (!cfg) return;
  const exp = cfg.toneMappingExposure;
  if (Number.isFinite(exp)) renderer.toneMappingExposure = exp;

  const amb = cfg.ambient;
  if (amb) {
    applyHexToThreeColor(ambientLight.color, amb.color, 0xffffff);
    const ai = Number(amb.intensity);
    if (Number.isFinite(ai)) ambientLight.intensity = ai;
  }

  const hemi = cfg.hemisphere;
  if (hemi) {
    const sky = hemi.sky ?? hemi.skyColor;
    const ground = hemi.ground ?? hemi.groundColor;
    applyHexToThreeColor(hemiLight.color, sky, 0xffffff);
    applyHexToThreeColor(hemiLight.groundColor, ground, 0x0b1220);
    const hi = Number(hemi.intensity);
    if (Number.isFinite(hi)) hemiLight.intensity = hi;
  }

  const dir = cfg.directional;
  if (dir) {
    applyHexToThreeColor(dirLight.color, dir.color, 0xffffff);
    const di = Number(dir.intensity);
    if (Number.isFinite(di)) dirLight.intensity = di;
  }
}

/** 户型世界摆放等：画布 cm（左上角为 0）↔ 场景米 */
function canvasCmToSceneXZ(xCm, yCm) {
  return { x: (xCm - VIEW_W / 2) / 100, z: (yCm - VIEW_H / 2) / 100 };
}
function sceneXZToCanvasCm(x, z) {
  return { x: x * 100 + VIEW_W / 2, y: z * 100 + VIEW_H / 2 };
}

/** 家具布局：以编辑区中心为原点的 cm（约 [-1500,1500]）↔ 场景米 */
function centeredCmToSceneXZ(cx, cy) {
  return { x: cx / 100, z: cy / 100 };
}
function sceneXZToCenteredCm(x, z) {
  return { x: x * 100, y: z * 100 };
}
function centeredToCanvasCm(cx, cy) {
  return { x: cx + CENTER_HALF, y: cy + CENTER_HALF };
}
function canvasCmToCentered(xCm, yCm) {
  return { x: xCm - CENTER_HALF, y: yCm - CENTER_HALF };
}

function clampFurnitureCentered(cx, cy, rotDeg, hw, hh) {
  const canvas = centeredToCanvasCm(cx, cy);
  const c = clampFurnitureToCanvas(canvas.x, canvas.y, rotDeg, hw, hh);
  return canvasCmToCentered(c.x, c.y);
}
function snap(v) {
  return Math.round(v / GRID) * GRID;
}
function getFloorsFromEntry(entry) {
  const floors = entry?.floors;
  return Array.isArray(floors) ? floors : [];
}
function normalizeFloorIndex(entry, indexLike) {
  const floors = getFloorsFromEntry(entry);
  if (!floors.length) return 0;
  const n = Math.trunc(Number(indexLike));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), floors.length - 1);
}
function getCurrentFloorFromEntry(entry, indexLike) {
  const floors = getFloorsFromEntry(entry);
  if (!floors.length) return null;
  return floors[normalizeFloorIndex(entry, indexLike)] ?? floors[0] ?? null;
}
function getEntryBBoxCm(entry) {
  const floors = getFloorsFromEntry(entry);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const fl of floors) {
    const b = getFloorBBoxCm(fl);
    if (!b) continue;
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** 与 rebuildFloorplan3D 中一致的户型在画布坐标系（cm）下的缩放与平移 */
function computeFloorplanCanvasPlacement(entry) {
  const bbox = getEntryBBoxCm(entry);
  if (!bbox) return null;
  const availW = Math.max(40, VIEW_W - 2 * FLOORPLAN_PAD);
  const availH = Math.max(40, VIEW_H - 2 * FLOORPLAN_PAD);
  let s = bbox.w > 1e-6 && bbox.h > 1e-6 ? Math.min(availW / bbox.w, availH / bbox.h) : 1;
  s *= FLOORPLAN_SIZE_FACTOR;
  s = Math.min(Math.max(s, 0.02), 4);
  if (bbox.w > 1e-6) {
    const nw = Math.max(1, Math.round((s * bbox.w) / GRID));
    s = (nw * GRID) / bbox.w;
    s = Math.min(Math.max(s, 0.02), 4);
  }
  let worldX = snap(VIEW_W / 2);
  let worldY = snap(VIEW_H / 2);
  const wxMin = worldX + s * (bbox.minX - bbox.cx);
  const wyMin = worldY + s * (bbox.minY - bbox.cy);
  worldX += Math.round(wxMin / GRID) * GRID - wxMin;
  worldY += Math.round(wyMin / GRID) * GRID - wyMin;
  return { worldX, worldY, s, cx: bbox.cx, cy: bbox.cy };
}

function closestPointOnSegment2D(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 < 1e-12) return { x: ax, y: ay };
  let t = (apx * abx + apy * aby) / ab2;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + t * abx, y: ay + t * aby };
}

/** 家具底面四角 + 四边中点（画布 cm），用于墙体磁吸 */
function furnitureWallSnapSamplePointsCm(cx, cy, rotDeg, hw, hh) {
  const lc = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const out = [];
  for (const [lx, ly] of lc) {
    const p = rotateYLocal(lx, ly, rotDeg);
    out.push({ x: cx + p.x, y: cy + p.z });
  }
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = lc[i];
    const [x2, y2] = lc[(i + 1) % 4];
    const p = rotateYLocal((x1 + x2) / 2, (y1 + y2) / 2, rotDeg);
    out.push({ x: cx + p.x, y: cy + p.z });
  }
  return out;
}

function extractFurnitureFootprintCm(item) {
  if (!item || typeof item !== "object") return { w: 100, d: 100, h: 80, hw: 50, hh: 50 };
  const raw = item.size;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { w: 100, d: 100, h: 80, hw: 50, hh: 50 };
  let w = Number(raw.widthCm ?? raw.width ?? raw.w);
  let d = Number(raw.depthCm ?? raw.depth ?? raw.d ?? raw.length);
  let h = Number(raw.heightCm ?? raw.height ?? raw.h);
  if (!Number.isFinite(w) || w <= 0) w = 210;
  if (!Number.isFinite(d) || d <= 0) d = 90;
  if (!Number.isFinite(h) || h <= 0) h = 80;
  if (w > 600 || d > 600) { w /= 10; d /= 10; }
  if (h > 600) h /= 10;
  return { w, d, h, hw: Math.max(8, w / 2), hh: Math.max(8, d / 2) };
}

/**
 * 将 GLTF 场景缩放到目标尺寸（米）并落底：底面 y=0，水平居中。
 * width→X，height→Y，depth→Z（与 BoxGeometry(w,h,d) 一致）
 */
function fitGltfToFootprint(root, widthM, heightM, depthM) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6) {
      const sx = widthM / size.x;
      const sy = heightM / size.y;
      const sz = depthM / size.z;
      root.scale.setScalar(Math.min(sx, sy, sz));
      root.updateMatrixWorld(true);
    }
  }
  const box2 = new THREE.Box3().setFromObject(root);
  if (box2.isEmpty()) return;
  const cx = (box2.min.x + box2.max.x) / 2;
  const cz = (box2.min.z + box2.max.z) / 2;
  root.position.x -= cx;
  root.position.z -= cz;
  root.position.y -= box2.min.y;
}

function rotateYLocal(x, z, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: c * x + s * z, z: -s * x + c * z };
}
function furnitureFootprintAabbCm(cx, cy, rotDeg, hw, hh) {
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [lx, ly] of corners) {
    const p = rotateYLocal(lx, ly, rotDeg);
    minX = Math.min(minX, p.x + cx);
    minY = Math.min(minY, p.z + cy);
    maxX = Math.max(maxX, p.x + cx);
    maxY = Math.max(maxY, p.z + cy);
  }
  return { minX, minY, maxX, maxY };
}
function clampFurnitureToCanvas(cx, cy, rotDeg, hw, hh) {
  const margin = 10;
  let x = cx, y = cy;
  for (let iter = 0; iter < 16; iter++) {
    let b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    x += Math.round(b.minX / GRID) * GRID - b.minX;
    y += Math.round(b.minY / GRID) * GRID - b.minY;
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    let adjusted = false;
    if (b.minX < margin) { x += margin - b.minX; adjusted = true; }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.minY < margin) { y += margin - b.minY; adjusted = true; }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.maxX > VIEW_W - margin) { x += VIEW_W - margin - b.maxX; adjusted = true; }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.maxY > VIEW_H - margin) { y += VIEW_H - margin - b.maxY; adjusted = true; }
    if (!adjusted) {
      b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
      x += Math.round(b.minX / GRID) * GRID - b.minX;
      y += Math.round(b.minY / GRID) * GRID - b.minY;
      break;
    }
  }
  return { x, y };
}

/**
 * @typedef {object} SurfaceScopeOverride
 * @property {string} [color] 覆盖库材质 `color`（与 roughness 等一并并入 mergeMaterialOverrideIntoDef）
 * @property {string} [materialId]
 * @property {boolean} [materialPresetCleared] 用户点击「清除」后不再使用库材质预设（与未设置 materialId 区分，避免同步时回退到风格包默认）
 * @property {string} [textureAlbedo] 仅覆盖库材质 `texture.albedo` 的文件名（如 `Concrete003_2K-JPG_Color.jpg`）或 `textures/...` 路径
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
    window.__visionHomeSvgEditor = r;
    return r;
  }
  const byId = catalog.byId instanceof Map ? catalog.byId : new Map();
  const canvasWrap = container.closest(".svg-editor-canvas-wrap") ?? container.parentElement;

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
  /** 户型/家具视图抗锯齿：MSAA + 较高 DPR 上限（过高会明显吃 GPU） */
  const PIXEL_RATIO_CAP = 2.5;
  function applyRendererPixelRatio() {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_CAP));
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
  dirLight.shadow.mapSize.set(4096, 4096);
  dirLight.shadow.bias = 0.00015;
  dirLight.shadow.normalBias = 0.045;
  dirLight.shadow.radius = 6;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 500;
  dirLight.shadow.camera.left = -40;
  dirLight.shadow.camera.right = 40;
  dirLight.shadow.camera.top = 40;
  dirLight.shadow.camera.bottom = -40;
  dirLight.shadow.camera.updateProjectionMatrix();
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
    shadowSceneBbox.makeEmpty();
    if (floorplanRoot.children.length) shadowSceneBbox.expandByObject(floorplanRoot);
    if (furnitureRoot.children.length) {
      const b2 = new THREE.Box3().setFromObject(furnitureRoot);
      if (shadowSceneBbox.isEmpty()) shadowSceneBbox.copy(b2);
      else shadowSceneBbox.union(b2);
    }
    if (shadowSceneBbox.isEmpty()) return;

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
  let dragState = null;
  /** Alt+左键调节装饰模型高度：{ pointerId, group, startClientY, startLiftM } */
  let altDragState = null;
  /** 墙/地：短按才打开属性面板；长按或滑动取消（与 pointerup 配对） */
  let pendingSurfacePick = null;
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
  const dimDepthTest = false; // 标注始终显示，不被模型遮挡
  let floorLevelDock = null;
  let floorLevelRow = null;
  // 楼层垂直偏移（场景单位：米）。key 对齐 furniture 的 floorId（如 "floor1"）。
  let floorYOffsetById = new Map();
  let floorElevationBaseCm = 0;
  function normalizeFloorKey(id) {
    return String(id ?? "").trim().toLowerCase();
  }

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
        const ax = worldX + s * (x1 - cx);
        const ay = worldY + s * (y1 - cy);
        const bx = worldX + s * (x2 - cx);
        const by = worldY + s * (y2 - cy);
        if (Math.hypot(bx - ax, by - ay) < 1e-3) continue;
        list.push({ ax, ay, bx, by });
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

  const propertiesPanel = document.getElementById("propertiesPanel");
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
  const propSurfaceOpacity = document.getElementById("propSurfaceOpacity");
  const propSurfaceTransmission = document.getElementById("propSurfaceTransmission");
  const propSurfaceIor = document.getElementById("propSurfaceIor");
  const propSurfaceResetDefault = document.getElementById("propSurfaceResetDefault");
  let surfaceMaterialGridClickBound = false;
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
  const undoBtn = document.querySelector("[data-svg-undo]");
  const redoBtn = document.querySelector("[data-svg-redo]");
  const gridToggleBtn = document.getElementById("svgGridToggleBtn");
  const floorHideOthersToggleBtn = document.querySelector("[data-svg-floor-hide-others-toggle]");
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
    window.dispatchEvent(new CustomEvent("visionhome:svg-layout-changed"));
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
  function clearInteractiveList() { interactiveMeshes.length = 0; }
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

  function stdMat(color) {
    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.05,
      emissive: new THREE.Color(0x000000),
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

  /**
   * 记录楼层透明度系数与当前 effective opacity 的比例（opacity / 层透明度），
   * 供滑块只改材质时使用：newOpacity = perUnit * newLayerOpacity。
   * 避免层透明度或 effective opacity 曾为 0 时，用 ratio=mat.opacity*new/old 无法恢复。
   */
  function tagFloorplanLayerOpacity(mat, layerOpacity) {
    if (!mat) return;
    const layer = Number.isFinite(Number(layerOpacity)) ? Number(layerOpacity) : 1;
    mat.userData.__floorplanLayerOpacity = layer;
    if (layer > 1e-9) {
      mat.userData.__floorplanOpacityPerUnitLayer = mat.opacity / layer;
    } else {
      mat.userData.__floorplanOpacityPerUnitLayer = 1;
    }
  }

  /**
   * 从风格包 materials 条目创建 Three 材质（可先显示颜色，贴图异步叠加）
   * @param {object} def
   * @param {number} floorOpacity
   * @param {{ forGlass?: boolean, envMapIntensity?: number, side?: import("three").Side }} [options]
   */
  function createFloorplanMaterialFromStyleDef(def, floorOpacity, options = {}) {
    const envMapIntensity = options.envMapIntensity ?? sceneLightingEnvMapIntensity;
    const floorOp = floorOpacity ?? 1;
    const color = new THREE.Color();
    try {
      const h = String(def.color ?? "#cccccc").trim();
      color.setStyle(h.startsWith("#") ? h : `#${h}`);
    } catch {
      color.setHex(0xcccccc);
    }
    const roughness = Number(def.roughness);
    const metalness = Number(def.metalness);
    const tr = Number(def.transmission);
    const usePhysical =
      options.forGlass !== true &&
      String(def.type ?? "") === "glass" &&
      Number.isFinite(tr) &&
      tr > 0.02;

    if (usePhysical) {
      const baseOp = Number(def.opacity);
      const opMult = Number.isFinite(baseOp) ? baseOp : 1;
      const mat = new THREE.MeshPhysicalMaterial({
        color,
        roughness: Number.isFinite(roughness) ? roughness : 0.05,
        metalness: Number.isFinite(metalness) ? metalness : 0,
        transmission: Math.min(1, tr),
        thickness: 0.03,
        ior: Number.isFinite(Number(def.ior)) ? Number(def.ior) : 1.45,
        transparent: true,
        opacity: Math.min(1, opMult * floorOp),
        envMapIntensity: 0.9,
        emissive: new THREE.Color(0x000000),
      });
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
      mat.side = options.side ?? THREE.DoubleSide;
      tagFloorplanLayerOpacity(mat, floorOp);
      return mat;
    }

    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: Number.isFinite(roughness) ? roughness : 0.55,
      metalness: Number.isFinite(metalness) ? metalness : 0.05,
      envMapIntensity,
      emissive: new THREE.Color(0x000000),
    });
    const baseOp = Number(def.opacity);
    const opMult = Number.isFinite(baseOp) ? baseOp : 1;
    const isGlass = String(def.type ?? "") === "glass";
    if (isGlass) {
      mat.transparent = true;
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
    } else {
      // 与玻璃一致：库/面板「不透明度」× 楼层透明度；仅压 floorOp 会让表面像被乘灰、而非真透明
      applyFloorplanSurfaceAlpha(mat, Math.min(1, opMult * floorOp));
    }
    mat.side = options.side ?? THREE.FrontSide;
    tagFloorplanLayerOpacity(mat, floorOp);
    return mat;
  }

  /**
   * 风格包 PBR 贴图异步加载（路径相对 assets/floorplans/style/）
   * @param {import("three").MeshStandardMaterial | import("three").MeshPhysicalMaterial} mat
   * @param {object} def
   * @param {{ applyUvScale?: boolean }} [opts]
   */
  function queueStylePackTextures(mat, def, opts = {}) {
    const t = def.texture;
    if (!t || typeof t !== "object") return;
    const albedo = String(t.albedo ?? "").trim();
    const rough = String(t.roughness ?? "").trim();
    const normal = String(t.normal ?? "").trim();
    const metalnessMapPath = String(t.metalnessMap ?? "").trim();
    if (!albedo && !rough && !normal && !metalnessMapPath) return;

    const loader = new THREE.TextureLoader();
    const applyUv = Boolean(opts.applyUvScale && Array.isArray(def.uvScale) && def.uvScale.length >= 2);
    const rotDeg = Number(def.textureRotation);
    const rotRad = Number.isFinite(rotDeg) && rotDeg !== 0 ? (rotDeg * Math.PI) / 180 : 0;

    function applyStyleTextureMapOpts(tex) {
      if (!tex) return;
      if (applyUv) {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(def.uvScale[0], def.uvScale[1]);
      }
      if (rotRad !== 0) {
        tex.center.set(0.5, 0.5);
        tex.rotation = rotRad;
      }
    }

    (async () => {
      if (!mat?.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;
      let metalnessTex = null;

      if (albedo) {
        try {
          const au = resolveStyleTextureUrl(albedo);
          diffTex = await loader.loadAsync(au);
          diffTex.colorSpace = THREE.SRGBColorSpace;
          diffTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] style albedo 贴图加载失败:", e);
        }
      }
      if (rough) {
        try {
          const ru = resolveStyleTextureUrl(rough);
          roughTex = await loader.loadAsync(ru);
          roughTex.colorSpace = THREE.LinearSRGBColorSpace;
          roughTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] style roughness 贴图加载失败:", e);
        }
      }
      if (normal) {
        try {
          const nu = resolveStyleTextureUrl(normal);
          normalTex = await loader.loadAsync(nu);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] style normal 贴图加载失败:", e);
        }
      }
      if (metalnessMapPath) {
        try {
          const mu = resolveStyleTextureUrl(metalnessMapPath);
          metalnessTex = await loader.loadAsync(mu);
          metalnessTex.colorSpace = THREE.LinearSRGBColorSpace;
          metalnessTex.flipY = false;
        } catch (e) {
          console.warn("[VisionHome] style metalnessMap 贴图加载失败:", e);
        }
      }

      if (!diffTex && !roughTex && !normalTex && !metalnessTex) return;

      if (diffTex) {
        applyStyleTextureMapOpts(diffTex);
        mat.map = diffTex;
        try {
          const h = String(def.color ?? "#ffffff").trim();
          mat.color.setStyle(h.startsWith("#") ? h : `#${h}`);
        } catch {
          mat.color.setHex(0xffffff);
        }
      }
      if (roughTex) {
        applyStyleTextureMapOpts(roughTex);
        mat.roughnessMap = roughTex;
      }
      if (normalTex) {
        applyStyleTextureMapOpts(normalTex);
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      if (metalnessTex) {
        applyStyleTextureMapOpts(metalnessTex);
        mat.metalnessMap = metalnessTex;
      }
      mat.needsUpdate = true;
    })();
  }

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
   * 由库材质 + 面板覆盖生成 **一份** Three 材质（同一楼层同 scope 下所有墙/地 mesh 可共用，避免每段墙重复 queueStylePackTextures）。
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
      envMapIntensity: sceneLightingEnvMapIntensity,
      side,
    });
    mat.userData.__floorplanOverrideOwned = true;
    if (isRoomFloor) {
      mat.userData.__floorplanRoomFloorDepthWrite = true;
    }
    // create 已写入 opMult×层透明度；此处用 mat.opacity 再跑一遍以应用「房间地面」depth 规则，避免被单层系数覆盖
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
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   * @param {boolean} on
   */
  function setFloorplanGlobalSurfaceHighlight(floorLevelId, scope, on) {
    if (on) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const emissiveHex = 0x000000;
    floorplanRoot.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      if (String(o.userData.floorplanFloorLevelId ?? "").trim() !== fid) return;
      if (scope === "allWalls" && !o.userData.floorplanWallId) return;
      if (scope === "allFloors" && !o.userData.floorplanRoomFloor) return;
      if (scope === "allDoors" && !o.userData.floorplanDoorFill) return;
      if (scope === "allWindows" && !o.userData.floorplanWindowFill) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        if (m?.emissive) m.emissive.setHex(emissiveHex);
      });
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
    return out;
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

  /**
   * 将面板中的数值覆盖合并到库材质定义（颜色、PBR、贴图 UV/旋转、albedo 等均在「该 materialId 对应材质」上生效）
   * @param {object} def
   * @param {SurfaceScopeOverride} ov
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

  /**
   * 窗玻璃不切换材质库：应用覆盖时去掉 materialId / 贴图预设 / UV 与旋转，仅保留颜色与 PBR/玻璃参数。
   * @param {SurfaceScopeOverride | null | undefined} ov
   * @returns {SurfaceScopeOverride | null}
   */
  function windowSurfaceOverrideForApply(ov) {
    if (!ov || typeof ov !== "object") return null;
    const o = { ...ov };
    delete o.materialId;
    delete o.textureAlbedo;
    delete o.materialPresetCleared;
    delete o.uvScale;
    delete o.textureRotation;
    return o;
  }

  /** @param {SurfaceScopeOverride | null | undefined} ov */
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

  async function applySurfaceOverridesToFloorplan() {
    if (!floorplanRoot.children.length) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const overrides = getCurrentSurfaceOverridesBucket();
    /** @type {Map<string, { ov: SurfaceScopeOverride, meshes: import("three").Mesh[], isRoomFloor: boolean }>} */
    const batches = new Map();
    gWorld.traverse((o) => {
      if (!o.isMesh) return;
      const fid = String(o.userData.floorplanFloorLevelId ?? "").trim();
      if (!fid) return;
      const bag = overrides[fid];
      if (!bag) return;
      if (o.userData.floorplanRoomFloor && bag.allFloors && surfaceOverrideIsActive(bag.allFloors)) {
        const k = `${fid}\0allFloors`;
        if (!batches.has(k)) {
          batches.set(k, { ov: bag.allFloors, meshes: [], isRoomFloor: true });
        }
        batches.get(k).meshes.push(o);
      } else if (o.userData.floorplanWallId && bag.allWalls && surfaceOverrideIsActive(bag.allWalls)) {
        const k = `${fid}\0allWalls`;
        if (!batches.has(k)) {
          batches.set(k, { ov: bag.allWalls, meshes: [], isRoomFloor: false });
        }
        batches.get(k).meshes.push(o);
      } else if (
        o.userData.floorplanDoorFill &&
        !o.userData.floorplanDoorHandle &&
        bag.allDoors &&
        surfaceOverrideIsActive(bag.allDoors)
      ) {
        const k = `${fid}\0allDoors`;
        if (!batches.has(k)) {
          batches.set(k, { ov: bag.allDoors, meshes: [], isRoomFloor: false });
        }
        batches.get(k).meshes.push(o);
      } else if (o.userData.floorplanWindowFill && bag.allWindows) {
        const ovApply = windowSurfaceOverrideForApply(bag.allWindows);
        if (!ovApply || !surfaceOverrideIsActive(ovApply)) return;
        const k = `${fid}\0allWindows`;
        if (!batches.has(k)) {
          batches.set(k, { ov: ovApply, meshes: [], isRoomFloor: false });
        }
        batches.get(k).meshes.push(o);
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
  }

  /**
   * 仅重应用某一楼层、墙面/地面/门洞范围的材质覆盖（不重建几何体）。用于属性面板改色/材质/PBR 时避免全量 rebuild。
   * @param {string} floorLevelId
   * @param {"allWalls" | "allFloors" | "allDoors" | "allWindows"} scope
   */
  async function applySurfaceOverridesForFloorScope(floorLevelId, scope) {
    if (!floorplanRoot.children.length) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const fid = String(floorLevelId ?? "").trim();
    if (!fid) return;
    const libraryBag = await getFloorplanMaterialsLibraryBag();
    const overrides = getCurrentSurfaceOverridesBucket();
    const bag = overrides[fid];
    /** @type {SurfaceScopeOverride | null} */
    let ov = null;
    if (scope === "allWalls" && bag?.allWalls && surfaceOverrideIsActive(bag.allWalls)) ov = bag.allWalls;
    else if (scope === "allFloors" && bag?.allFloors && surfaceOverrideIsActive(bag.allFloors)) ov = bag.allFloors;
    else if (scope === "allDoors" && bag?.allDoors && surfaceOverrideIsActive(bag.allDoors)) ov = bag.allDoors;
    else if (scope === "allWindows" && bag?.allWindows) {
      const w = windowSurfaceOverrideForApply(bag.allWindows);
      if (w && surfaceOverrideIsActive(w)) ov = w;
    }
    if (!ov) return;
    /** @type {import("three").Mesh[]} */
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

  function buildRoomMesh(room, cx, cy, s, floorOpacity, floorStyleMat, floorLevelId) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) return null;
    const pts = poly.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [snap(Number(p[0])), snap(Number(p[1]))]);
    if (pts.length < 3) return null;
    // 户型平面为屏幕坐标（Y 向下）；ShapeUtils.area / isClockWise / Earcut 按数学坐标（Y 向上）约定。
    // 若直接用向下 Y 做剖分，凹多边形（客厅）会三角化错误，木地面盖住厨卫。剖分时用 y' = -y，顶点再还原。
    const contourTri = pts.map((p) => {
      const xm = (p[0] - cx) * (s / 100);
      const ym = (p[1] - cy) * (s / 100);
      return new THREE.Vector2(xm, -ym);
    });
    if (ShapeUtils.isClockWise(contourTri) === false) {
      contourTri.reverse();
    }
    const faceList = ShapeUtils.triangulateShape(contourTri, []);
    if (!faceList.length) return null;
    const pos = new Float32Array(contourTri.length * 3);
    const uv = new Float32Array(contourTri.length * 2);
    for (let i = 0; i < contourTri.length; i++) {
      const v = contourTri[i];
      const px = v.x;
      const py = -v.y;
      pos[i * 3] = px;
      pos[i * 3 + 1] = py;
      pos[i * 3 + 2] = 0;
      uv[i * 2] = px;
      uv[i * 2 + 1] = py;
    }
    const idx = [];
    for (let fi = 0; fi < faceList.length; fi++) {
      const f = faceList[fi];
      idx.push(f[0], f[1], f[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    // 让地面 XZ 坐标系与墙体一致：墙体使用 mz=(y-cy)*s/100（不取反），
    // rotateX(-PI/2) 会导致 z 变号，造成地面相对墙体位置偏移。
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    const mat = floorStyleMat || floorplanStdMat();
    mat.userData.__floorplanRoomFloorDepthWrite = true;
    const op = floorOpacity ?? 1;
    applyFloorplanSurfaceAlpha(mat, op);
    if (!floorStyleMat) tagFloorplanLayerOpacity(mat, op);
    // ShapeGeometry 与挤出顶盖法线朝向可能不同；双面避免从上方只看到被剔除的一面
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.position.y = 0.02;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanRoomFloor = true;
    mesh.userData.floorplanRoomId = String(room?.id ?? "").trim();
    mesh.userData.floorplanFloorLevelId = String(floorLevelId ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
    return mesh;
  }

  const WALL_HOLE_EPS = 1e-5;

  /**
   * 门/窗：wallId + pos（cm，从墙 start 沿中心线到洞口中心）+ width/height（cm）
   * 转为墙体局部 X（沿墙）× Y（向上）的矩形洞，用于从墙盒体中挖空（网格剖分）。
   */
  function collectWallOpeningHolesLocal(wall, floor, lenWorld, lenCm, hM, s) {
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
      const wM = (wcm * s) / 100;
      const centerX = -halfLen + (pos / lenCm) * lenWorld;
      pushHole(centerX - wM / 2, centerX + wM / 2, 0, Math.min((hcm * s) / 100, hM));
    }
    for (const win of floor?.windows || []) {
      if (String(win?.wallId ?? "").trim() !== wid) continue;
      const pos = Number(win.pos);
      const wcm = Number(win.width);
      const hcm = Number(win.height);
      const altCm = Number(win.altitude ?? win.alt ?? win.sillHeightCm ?? 0);
      if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) continue;
      const wM = (wcm * s) / 100;
      const centerX = -halfLen + (pos / lenCm) * lenWorld;
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

  function cellFullyInsideAnyHole(xa, xb, ya, yb, holes) {
    for (const h of holes) {
      if (xa >= h.x0 - WALL_HOLE_EPS && xb <= h.x1 + WALL_HOLE_EPS && ya >= h.y0 - WALL_HOLE_EPS && yb <= h.y1 + WALL_HOLE_EPS) {
        return true;
      }
    }
    return false;
  }

  /**
   * 墙盒：基底为 walls[].style；+Z/−Z 大面按「沿墙位置」取两侧房间，叠加 mapping.rooms 的墙面材质（分段采样，避免整墙只用中点导致卫生间瓷砖铺满相邻房间）。
   */
  function buildWallMesh(wall, floor, cx, cy, s, defaultHeightCm, floorOpacity, wallStyleMat, style, getMaterialForKey, floorLevelId) {
    if (!Array.isArray(wall?.start) || wall.start.length < 2 || !Array.isArray(wall?.end) || wall.end.length < 2) return null;
    const x1 = snap(Number(wall.start[0])), y1 = snap(Number(wall.start[1]));
    const x2 = snap(Number(wall.end[0])), y2 = snap(Number(wall.end[1]));
    const dx = (x2 - x1) * (s / 100), dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const wallIdStr = String(wall?.id ?? "").trim();
    const floorIdStr = String(floorLevelId ?? "").trim();
    const lenCm = Math.hypot(x2 - x1, y2 - y1);
    const th = Number(wall.thickness);
    const thickMRaw = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const hM = defaultHeightCm / 100;
    const holes = collectWallOpeningHolesLocal(wall, floor, lenWorld, lenCm, hM, s);

    const rotY = Math.atan2(dz, dx);
    const op = floorOpacity ?? 1;

    function makeWallMaterial() {
      if (wallStyleMat) {
        wallStyleMat.side = THREE.FrontSide;
        return wallStyleMat;
      }
      const mat = floorplanStdMat();
      applyFloorplanSurfaceAlpha(mat, op);
      mat.side = THREE.FrontSide;
      tagFloorplanLayerOpacity(mat, op);
      return mat;
    }

    function wallFaceMaterialsAtT(t) {
      const baseMat = makeWallMaterial();
      const useRoomWalls = style && typeof getMaterialForKey === "function";
      if (!useRoomWalls) {
        return { mats: null, baseMat };
      }
      const { roomPosZ, roomNegZ } = findWallSideRoomsAt(floor, wall, t, 4);
      function faceMatForRoom(room) {
        if (!room) return baseMat;
        const rk = resolveRoomWallMaterialKey(style, room);
        if (!rk) return baseMat;
        const m = getMaterialForKey(rk);
        return m || baseMat;
      }
      const matPosZ = faceMatForRoom(roomPosZ);
      const matNegZ = faceMatForRoom(roomNegZ);
      const mats = [baseMat, baseMat, baseMat, baseMat, matPosZ, matNegZ];
      return { mats, baseMat };
    }

    function pushWallSegmentMesh(parent, segLenWorld, tMid, matsOrSingle) {
      const mxSeg = (x1 + tMid * (x2 - x1) - cx) * (s / 100);
      const mzSeg = (y1 + tMid * (y2 - y1) - cy) * (s / 100);
      const geo = new THREE.BoxGeometry(segLenWorld, hM, thickM);
      const mesh = new THREE.Mesh(geo, matsOrSingle);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.position.set(mxSeg, hM / 2, mzSeg);
      mesh.rotation.y = rotY;
      mesh.userData.floorplanPick = true;
      mesh.userData.floorplanWallFace = true;
      mesh.userData.floorplanWallId = wallIdStr;
      mesh.userData.floorplanFloorLevelId = floorIdStr;
      mesh.userData.floorplanSurfaceOpacity = op;
      parent.add(mesh);
    }

    if (!holes.length) {
      const useRoomWalls = style && typeof getMaterialForKey === "function";
      if (!useRoomWalls) {
        const geo = new THREE.BoxGeometry(lenWorld, hM, thickM);
        const mat = makeWallMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.position.set(((x1 + x2) / 2 - cx) * (s / 100), hM / 2, ((y1 + y2) / 2 - cy) * (s / 100));
        mesh.rotation.y = rotY;
        mesh.userData.floorplanPick = true;
        mesh.userData.floorplanWallFace = true;
        mesh.userData.floorplanWallId = wallIdStr;
        mesh.userData.floorplanFloorLevelId = floorIdStr;
        mesh.userData.floorplanSurfaceOpacity = op;
        return mesh;
      }
      const N = Math.min(256, Math.max(24, Math.ceil(lenCm / 4)));
      const samples = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const { roomPosZ, roomNegZ } = findWallSideRoomsAt(floor, wall, t, 4);
        const rk = `${String(roomPosZ?.id ?? "")}|${String(roomNegZ?.id ?? "")}`;
        samples.push({ t, roomPosZ, roomNegZ, rk });
      }
      /** 采样 i 与 i+1 之间 rk 变化时的分界 t = (i/N + (i+1)/N) / 2；区间 [tLeft(a), tRight(b)] 完全覆盖 [0,1] 无隙。 */
      const tLeft = (idx) => (idx === 0 ? 0 : (2 * idx - 1) / (2 * N));
      const tRight = (idx) => (idx === N ? 1 : (2 * idx + 1) / (2 * N));
      const intervals = [];
      let start = 0;
      for (let i = 1; i <= N + 1; i++) {
        if (i === N + 1 || (i <= N && samples[i].rk !== samples[start].rk)) {
          const b = i - 1;
          intervals.push({
            t0: tLeft(start),
            t1: tRight(b),
            roomPosZ: samples[start].roomPosZ,
            roomNegZ: samples[start].roomNegZ,
          });
          start = i;
        }
      }
      if (intervals.length === 1) {
        const it = intervals[0];
        const tMid = (it.t0 + it.t1) / 2;
        const { mats } = wallFaceMaterialsAtT(tMid);
        const geo = new THREE.BoxGeometry(lenWorld * (it.t1 - it.t0), hM, thickM);
        const mesh = new THREE.Mesh(geo, mats || makeWallMaterial());
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        const tm = (it.t0 + it.t1) / 2;
        mesh.position.set((x1 + tm * (x2 - x1) - cx) * (s / 100), hM / 2, (y1 + tm * (y2 - y1) - cy) * (s / 100));
        mesh.rotation.y = rotY;
        mesh.userData.floorplanPick = true;
        mesh.userData.floorplanWallFace = true;
        mesh.userData.floorplanWallId = wallIdStr;
        mesh.userData.floorplanFloorLevelId = floorIdStr;
        mesh.userData.floorplanSurfaceOpacity = op;
        return mesh;
      }
      const group = new THREE.Group();
      group.userData.floorplanPick = true;
      const baseMat = makeWallMaterial();
      function matsForInterval(roomPosZ, roomNegZ) {
        function faceMatForRoom(room) {
          if (!room) return baseMat;
          const rk = resolveRoomWallMaterialKey(style, room);
          if (!rk) return baseMat;
          const m = getMaterialForKey(rk);
          return m || baseMat;
        }
        return [baseMat, baseMat, baseMat, baseMat, faceMatForRoom(roomPosZ), faceMatForRoom(roomNegZ)];
      }
      for (const it of intervals) {
        const dt = it.t1 - it.t0;
        if (dt < 1e-8) continue;
        const segLen = lenWorld * dt;
        if (segLen < 0.015) continue;
        const tMid = (it.t0 + it.t1) / 2;
        pushWallSegmentMesh(group, segLen, tMid, matsForInterval(it.roomPosZ, it.roomNegZ));
      }
      return group.children.length ? group : null;
    }

    const halfSpan = lenWorld / 2;
    const xs = mergeSplitEdges(-halfSpan, halfSpan, holes.flatMap((h) => [h.x0, h.x1]));
    const ys = mergeSplitEdges(0, hM, holes.flatMap((h) => [h.y0, h.y1]));
    const group = new THREE.Group();
    group.position.set(((x1 + x2) / 2 - cx) * (s / 100), 0, ((y1 + y2) / 2 - cy) * (s / 100));
    group.rotation.y = rotY;
    group.userData.floorplanPick = true;

    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i];
      const xb = xs[i + 1];
      if (xb - xa < WALL_HOLE_EPS) continue;
      for (let j = 0; j < ys.length - 1; j++) {
        const ya = ys[j];
        const yb = ys[j + 1];
        if (yb - ya < WALL_HOLE_EPS) continue;
        if (cellFullyInsideAnyHole(xa, xb, ya, yb, holes)) continue;
        const cxLocal = (xa + xb) / 2;
        const cyLocal = (ya + yb) / 2;
        const gw = xb - xa;
        const gh = yb - ya;
        const geo = new THREE.BoxGeometry(gw, gh, thickM);
        const tAlong = (cxLocal + halfSpan) / lenWorld;
        const { mats } = wallFaceMaterialsAtT(tAlong);
        const mat = mats || makeWallMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.position.set(cxLocal, cyLocal, 0);
        mesh.userData.floorplanPick = true;
        mesh.userData.floorplanWallFace = true;
        mesh.userData.floorplanWallId = wallIdStr;
        mesh.userData.floorplanFloorLevelId = floorIdStr;
        mesh.userData.floorplanSurfaceOpacity = op;
        group.add(mesh);
      }
    }
    return group;
  }

  /**
   * 门洞填充材质（ns 来自 normalizeDoorStyle，缺省为白）
   */
  function doorFillMaterialFromNs(ns, floorOpacity) {
    let color;
    try {
      color = new THREE.Color(ns.color);
    } catch {
      return null;
    }
    const op = floorOpacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: ns.roughness,
      metalness: ns.metalness,
      envMapIntensity: 0.35,
      emissive: new THREE.Color(0x000000),
    });
    if (ns.isGlass) {
      applyFloorplanSurfaceAlpha(mat, Math.min(1, 0.42 * op));
    } else {
      applyFloorplanSurfaceAlpha(mat, op);
    }
    tagFloorplanLayerOpacity(mat, op);
    mat.side = THREE.FrontSide;
    return mat;
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

  function buildDoorFillGroup(door, wall, cx, cy, s, defaultHeightCm, floorOpacity, styleDoorMat, floorLevelIdStr) {
    if (!door || !wall) return null;
    const ns =
      door.style != null && typeof door.style === "object" && !Array.isArray(door.style)
        ? normalizeDoorStyle(door.style)
        : defaultDoorStyleWhite();
    const pos = Number(door.pos);
    const wcm = Number(door.width);
    const hcm = Number(door.height);
    if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) return null;
    const x1 = snap(Number(wall.start[0]));
    const y1 = snap(Number(wall.start[1]));
    const x2 = snap(Number(wall.end[0]));
    const y2 = snap(Number(wall.end[1]));
    const dx = (x2 - x1) * (s / 100);
    const dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const lenCm = Math.hypot(x2 - x1, y2 - y1);
    const hM = defaultHeightCm / 100;
    const wM = (wcm * s) / 100;
    const hDoor = Math.min((hcm * s) / 100, hM);
    if (hDoor < WALL_HOLE_EPS) return null;
    const th = Number(wall.thickness);
    const thickMRaw = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const halfLen = lenWorld / 2;
    const centerX = -halfLen + (pos / lenCm) * lenWorld;
    const mx = ((x1 + x2) / 2 - cx) * (s / 100);
    const mz = ((y1 + y2) / 2 - cy) * (s / 100);
    const rotY = Math.atan2(dz, dx);
    const group = new THREE.Group();
    group.position.set(mx, 0, mz);
    group.rotation.y = rotY;
    group.userData.floorplanDoorFill = true;
    group.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    const geo = new THREE.BoxGeometry(wM, hDoor, thickM * 0.22);
    const mat = styleDoorMat || doorFillMaterialFromNs(ns, floorOpacity);
    if (!mat) {
      geo.dispose();
      return null;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(centerX, hDoor / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanDoorFill = true;
    mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
    mesh.userData.floorplanDoorStyle = ns;
    if (!styleDoorMat) queueDoorFillTextures(mesh, ns);
    group.add(mesh);
    const doorDepth = thickM * 0.22;
    addDoorHandleMeshes(
      group,
      centerX,
      wM,
      hDoor,
      doorDepth,
      styleDoorMat ? (floorOpacity ?? 1) : effectiveDoorPanelOpacity(ns, floorOpacity),
      floorOpacity ?? 1,
      floorLevelIdStr,
    );
    return group;
  }

  function windowGlassMaterialFromNs(ns, floorOpacity) {
    let color;
    try {
      color = new THREE.Color(ns.color);
    } catch {
      return null;
    }
    const floorOp = floorOpacity ?? 1;
    const op = Math.max(0, Math.min(1, ns.opacity * floorOp));
    let roughness = 0.14;
    let envMapIntensity = 0.55;
    if (ns.type === "clear") {
      roughness = 0.04;
      envMapIntensity = 0.95;
    } else if (ns.type === "frosted") {
      roughness = 0.92;
      envMapIntensity = 0.28;
    } else if (ns.type === "tinted") {
      roughness = 0.12;
      envMapIntensity = 0.5;
    }
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0.02,
      transparent: true,
      opacity: op,
      envMapIntensity,
      emissive: new THREE.Color(0x000000),
    });
    applyFloorplanSurfaceAlpha(mat, op);
    tagFloorplanLayerOpacity(mat, floorOp);
    mat.side = THREE.FrontSide;
    return mat;
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
  function buildWindowGlassGroup(win, wall, cx, cy, s, defaultHeightCm, floorOpacity, styleWinMat, floorLevelIdStr) {
    if (!win || !wall) return null;
    const ns =
      win.style != null && typeof win.style === "object" && !Array.isArray(win.style)
        ? normalizeWindowStyle(win.style)
        : defaultWindowStyleWhite();
    const pos = Number(win.pos);
    const wcm = Number(win.width);
    const hcm = Number(win.height);
    const altCm = Number(win.altitude ?? win.alt ?? win.sillHeightCm ?? 0);
    if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) return null;
    if (!Number.isFinite(altCm)) return null;
    const x1 = snap(Number(wall.start[0]));
    const y1 = snap(Number(wall.start[1]));
    const x2 = snap(Number(wall.end[0]));
    const y2 = snap(Number(wall.end[1]));
    const dx = (x2 - x1) * (s / 100);
    const dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const lenCm = Math.hypot(x2 - x1, y2 - y1);
    const hM = defaultHeightCm / 100;
    const wM = (wcm * s) / 100;
    const y0 = (altCm * s) / 100;
    const hWin = (hcm * s) / 100;
    const hWinClamped = Math.max(0, Math.min(hWin, hM - y0));
    if (hWinClamped < WALL_HOLE_EPS) return null;
    const th = Number(wall.thickness);
    const thickMRaw = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const halfLen = lenWorld / 2;
    const centerX = -halfLen + (pos / lenCm) * lenWorld;
    const mx = ((x1 + x2) / 2 - cx) * (s / 100);
    const mz = ((y1 + y2) / 2 - cy) * (s / 100);
    const rotY = Math.atan2(dz, dx);
    const group = new THREE.Group();
    group.position.set(mx, 0, mz);
    group.rotation.y = rotY;
    group.userData.floorplanWindowFill = true;
    group.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    const geo = new THREE.BoxGeometry(wM, hWinClamped, thickM * 0.22);
    const mat = styleWinMat || windowGlassMaterialFromNs(ns, floorOpacity);
    if (!mat) {
      geo.dispose();
      return null;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 12;
    mesh.position.set(centerX, y0 + hWinClamped / 2, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanWindowFill = true;
    mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
    mesh.userData.floorplanWindowStyle = ns;
    if (!styleWinMat) queueWindowFillTextures(mesh, ns);
    group.add(mesh);
    return group;
  }

  // ============================================================
  // 尺寸标注辅助函数
  // ============================================================

  /** 画带圆角的矩形路径（canvas 2d ctx） */
  function _dimRoundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  /** 创建始终面向相机的文字 Sprite，用于尺寸标注 */
  function makeDimSprite(text, opts = {}) {
    const fontSize = opts.fontSize ?? 24;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const font = `bold ${fontSize}px sans-serif`;
    ctx.font = font;
    const tw = Math.ceil(ctx.measureText(text).width);
    const pad = 9;
    canvas.width = tw + pad * 2;
    canvas.height = fontSize + pad * 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = opts.bgColor ?? "rgba(8,14,40,0.80)";
    _dimRoundRect(ctx, 0, 0, canvas.width, canvas.height, 6);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = opts.textColor ?? "#cce0ff";
    ctx.fillText(text, pad, fontSize + pad * 0.45);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: dimDepthTest, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    const PX = opts.pxPerM ?? 180;
    sprite.scale.set(canvas.width / PX, canvas.height / PX, 1);
    return sprite;
  }

  /** 创建虚线 Line（LineDashedMaterial），depthTest=false 始终可见 */
  function makeDimLine(pts, color = 0x5599ee, dash = 0.14, gap = 0.0001) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity: 0.92, depthTest: dimDepthTest });
    const ln = new THREE.Line(geo, mat);
    ln.computeLineDistances();
    return ln;
  }

  /** 格式化 cm 为可读字符串（>=100cm 显示 m） */
  function fmtDimCm(cm) {
    return cm >= 100 ? `${(cm / 100).toFixed(2)}m` : `${Math.round(cm)}cm`;
  }

  /**
  /** 为指定楼层每个房间在中心放置名称标签 */
  function buildFloorNameAnnotations(fl, cx, cy, s) {
    const g = new THREE.Group();
    g.userData.isNameAnnotation = true;
    const LY = 0.12;
    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      const st = room?.style;
      const styleFallback =
        st != null && typeof st === "object" && !Array.isArray(st) ? st.floor ?? st.wall : st;
      const name = String(room?.name ?? room?.type ?? styleFallback ?? "").trim();
      if (!Array.isArray(poly) || poly.length < 3 || !name) continue;
      const pts2d = poly
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [(snap(Number(p[0])) - cx) * (s / 100), (snap(Number(p[1])) - cy) * (s / 100)]);
      if (pts2d.length < 3) continue;
      let cx2 = 0, cz2 = 0;
      for (const [x, z] of pts2d) { cx2 += x; cz2 += z; }
      cx2 /= pts2d.length; cz2 /= pts2d.length;
      const sp = makeDimSprite(name, { fontSize: 22, pxPerM: 160 });
      sp.position.set(cx2, LY, cz2);
      g.add(sp);
    }

    // 墙体名称标注：显示在墙体顶面中心
    const fh = Number(fl.height);
    const wallHeightCm = Number.isFinite(fh) && fh > 0 ? fh : 280;
    const wallTopY = (wallHeightCm * s) / 100 + 0.06;
    for (const wall of fl.walls ?? []) {
      const name = String(wall?.name ?? wall?.id ?? "").trim();
      if (!name) continue;
      if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end)) continue;
      const x1 = snap(Number(wall.start[0])), y1 = snap(Number(wall.start[1]));
      const x2 = snap(Number(wall.end[0])),   y2 = snap(Number(wall.end[1]));
      const mx = ((x1 + x2) / 2 - cx) * (s / 100);
      const mz = ((y1 + y2) / 2 - cy) * (s / 100);
      const sp = makeDimSprite(name, { fontSize: 16, pxPerM: 200, bgColor: "rgba(40,20,0,0.75)", textColor: "#ffe8a0" });
      sp.position.set(mx, wallTopY, mz);
      sp.userData.isWallNameAnnotation = true;
      g.add(sp);
    }

    return g;
  }

  /**
   * 为指定楼层构建尺寸标注 Group（作为 floorG 的子节点）。
   * 每个房间：虚线轮廓 + 宽/深标注线 + 文字 Sprite。
   */
  function buildFloorDimensions(fl, cx, cy, s) {
    const g = new THREE.Group();
    g.userData.isDimAnnotation = true;
    const LY   = 0.07;  // 略高于楼板
    const EXT1 = 0.18;  // 分段标注线延伸量（内层）
    const EXT2 = 0.50;  // 总标注线延伸量（外层）
    const TK   = 0.07;  // 刻度线半长
    const SNAP_TOL = 0.001; // 去重容差（米）

    // 收集楼层包围盒，以及每侧边界上紧贴的房间断点
    let fminX = Infinity, fminZ = Infinity, fmaxX = -Infinity, fmaxZ = -Infinity;

    /** 将浮点坐标归一化到 SNAP_TOL 精度 */
    const key = (v) => Math.round(v / SNAP_TOL) * SNAP_TOL;

    // 先第一遍：仅算楼层包围盒
    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      for (const p of poly) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const x = (snap(Number(p[0])) - cx) * (s / 100);
        const z = (snap(Number(p[1])) - cy) * (s / 100);
        fminX = Math.min(fminX, x); fmaxX = Math.max(fmaxX, x);
        fminZ = Math.min(fminZ, z); fmaxZ = Math.max(fmaxZ, z);
      }
    }

    if (!Number.isFinite(fminX)) return g;

    // 每侧各自的断点集合（只含紧贴该侧边界的房间端点）
    const EDGE_TOL = 0.05; // 判断"紧贴"的容差（米）
    const xSouth = new Set(); // 紧贴南侧（bmaxZ ≈ fmaxZ）的房间 X 端点
    const xNorth = new Set(); // 紧贴北侧（bminZ ≈ fminZ）的房间 X 端点
    const zEast  = new Set(); // 紧贴东侧（bmaxX ≈ fmaxX）的房间 Z 端点
    const zWest  = new Set(); // 紧贴西侧（bminX ≈ fminX）的房间 Z 端点

    // 确保端点包含楼层整体边界
    xSouth.add(key(fminX)); xSouth.add(key(fmaxX));
    xNorth.add(key(fminX)); xNorth.add(key(fmaxX));
    zEast.add(key(fminZ));  zEast.add(key(fmaxZ));
    zWest.add(key(fminZ));  zWest.add(key(fmaxZ));

    // 第二遍：绘制轮廓、面积，并按侧收集断点
    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      const pts2d = poly
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [(snap(Number(p[0])) - cx) * (s / 100), (snap(Number(p[1])) - cy) * (s / 100)]);
      if (pts2d.length < 3) continue;

      // 房间虚线轮廓
      const outPts = [...pts2d, pts2d[0]].map(([x, z]) => new THREE.Vector3(x, LY, z));
      g.add(makeDimLine(outPts, 0x7799cc, 0.07, 0.05));

      let bminX = Infinity, bminZ = Infinity, bmaxX = -Infinity, bmaxZ = -Infinity;
      for (const [x, z] of pts2d) {
        bminX = Math.min(bminX, x); bmaxX = Math.max(bmaxX, x);
        bminZ = Math.min(bminZ, z); bmaxZ = Math.max(bmaxZ, z);
      }

      // 按侧边收集该房间的端点
      if (bmaxZ >= fmaxZ - EDGE_TOL) { xSouth.add(key(bminX)); xSouth.add(key(bmaxX)); }
      if (bminZ <= fminZ + EDGE_TOL) { xNorth.add(key(bminX)); xNorth.add(key(bmaxX)); }
      if (bmaxX >= fmaxX - EDGE_TOL) { zEast.add(key(bminZ));  zEast.add(key(bmaxZ)); }
      if (bminX <= fminX + EDGE_TOL) { zWest.add(key(bminZ));  zWest.add(key(bmaxZ)); }

      // 用 Shoelace 公式计算真实面积
      let areaCm2 = 0;
      const rawPts = poly.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [snap(Number(p[0])), snap(Number(p[1]))]);
      for (let _i = 0; _i < rawPts.length; _i++) {
        const [ax, ay] = rawPts[_i];
        const [bx, by] = rawPts[(_i + 1) % rawPts.length];
        areaCm2 += ax * by - bx * ay;
      }
      const areaM2 = Math.abs(areaCm2) / 2 / 10000;

      // 面积标签置于下边中间（X 居中，Z 靠近南侧边），略往北（plan 上）移一点
      const INSET_Z = 0.18;
      const AREA_LABEL_UP = 0.46;
      const aSp = makeDimSprite(`${areaM2.toFixed(2)}㎡`, { fontSize: 20, pxPerM: 155 });
      aSp.position.set((bminX + bmaxX) / 2, LY + 0.1, bmaxZ - INSET_Z - AREA_LABEL_UP);
      g.add(aSp);
    }

    // 各侧断点排序
    const xs_south = [...xSouth].sort((a, b) => a - b);
    const xs_north = [...xNorth].sort((a, b) => a - b);
    const zs_east  = [...zEast].sort((a, b) => a - b);
    const zs_west  = [...zWest].sort((a, b) => a - b);

    /**
     * 画一组分段尺寸线。
     * side: 'south' | 'north' | 'east' | 'west'
     *   south/north → 沿 X 轴分段，固定 Z 位置
     *   east/west   → 沿 Z 轴分段，固定 X 位置
     */
    function drawSegments(breaks, side, fixedVal) {
      const tickH = TK * 0.8;
      // 向外偏移方向：south/east 为正，north/west 为负
      const sign = (side === 'south' || side === 'east') ? 1 : -1;
      const lineOff = sign * EXT1;
      const isHoriz = side === 'south' || side === 'north'; // 沿 X 轴方向

      for (let i = 0; i < breaks.length - 1; i++) {
        const a = breaks[i], b = breaks[i + 1];
        const segCm = (b - a) / (s / 100);
        if (segCm < 1) continue;

        const mid = (a + b) / 2;
        let p1, p2, pLead1, pLead2, pTick1a, pTick1b, pTick2a, pTick2b, pLabel;

        if (isHoriz) {
          // south / north：标注线沿 X，固定在 Z = fixedVal + lineOff
          const lineZ = fixedVal + lineOff;
          p1 = new THREE.Vector3(a, LY, lineZ);
          p2 = new THREE.Vector3(b, LY, lineZ);
          pLead1 = [new THREE.Vector3(a, LY, fixedVal), new THREE.Vector3(a, LY, lineZ + sign * tickH)];
          pLead2 = [new THREE.Vector3(b, LY, fixedVal), new THREE.Vector3(b, LY, lineZ + sign * tickH)];
          pTick1a = new THREE.Vector3(a, LY, lineZ - tickH); pTick1b = new THREE.Vector3(a, LY, lineZ + tickH);
          pTick2a = new THREE.Vector3(b, LY, lineZ - tickH); pTick2b = new THREE.Vector3(b, LY, lineZ + tickH);
          pLabel = new THREE.Vector3(mid, LY + 0.15, lineZ);
        } else {
          // east / west：标注线沿 Z，固定在 X = fixedVal + lineOff
          const lineX = fixedVal + lineOff;
          p1 = new THREE.Vector3(lineX, LY, a);
          p2 = new THREE.Vector3(lineX, LY, b);
          pLead1 = [new THREE.Vector3(fixedVal, LY, a), new THREE.Vector3(lineX + sign * tickH, LY, a)];
          pLead2 = [new THREE.Vector3(fixedVal, LY, b), new THREE.Vector3(lineX + sign * tickH, LY, b)];
          pTick1a = new THREE.Vector3(lineX - tickH, LY, a); pTick1b = new THREE.Vector3(lineX + tickH, LY, a);
          pTick2a = new THREE.Vector3(lineX - tickH, LY, b); pTick2b = new THREE.Vector3(lineX + tickH, LY, b);
          pLabel = new THREE.Vector3(lineX, LY + 0.15, mid);
        }

        g.add(makeDimLine([p1, p2]));
        g.add(makeDimLine(pLead1, 0x5599ee, 0.05, 0.04));
        g.add(makeDimLine(pLead2, 0x5599ee, 0.05, 0.04));
        g.add(makeDimLine([pTick1a, pTick1b]));
        g.add(makeDimLine([pTick2a, pTick2b]));
        const sp = makeDimSprite(fmtDimCm(segCm), { fontSize: 18, pxPerM: 140 });
        sp.position.copy(pLabel);
        g.add(sp);
      }
    }

    // 分段标注（内层，各侧只用紧贴该侧的房间断点）
    drawSegments(xs_south, 'south', fmaxZ); // 南
    drawSegments(xs_north, 'north', fminZ); // 北
    drawSegments(zs_east,  'east',  fmaxX); // 东
    drawSegments(zs_west,  'west',  fminX); // 西

    // 总尺寸（外层，更远一圈）
    const totalWCm = (fmaxX - fminX) / (s / 100);
    const totalDCm = (fmaxZ - fminZ) / (s / 100);

    // 总宽（南侧外层）
    const wZ = fmaxZ + EXT2;
    g.add(makeDimLine([new THREE.Vector3(fminX, LY, wZ), new THREE.Vector3(fmaxX, LY, wZ)]));
    g.add(makeDimLine([new THREE.Vector3(fminX, LY, fmaxZ), new THREE.Vector3(fminX, LY, wZ + TK)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, LY, fmaxZ), new THREE.Vector3(fmaxX, LY, wZ + TK)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fminX, LY, wZ - TK), new THREE.Vector3(fminX, LY, wZ + TK)]));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, LY, wZ - TK), new THREE.Vector3(fmaxX, LY, wZ + TK)]));
    const wSp = makeDimSprite(fmtDimCm(totalWCm));
    wSp.position.set((fminX + fmaxX) / 2, LY + 0.18, wZ);
    g.add(wSp);

    // 总深（东侧外层）
    const dX = fmaxX + EXT2;
    g.add(makeDimLine([new THREE.Vector3(dX, LY, fminZ), new THREE.Vector3(dX, LY, fmaxZ)]));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, LY, fminZ), new THREE.Vector3(dX + TK, LY, fminZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, LY, fmaxZ), new THREE.Vector3(dX + TK, LY, fmaxZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(dX, LY, fminZ - TK), new THREE.Vector3(dX, LY, fminZ + TK)]));
    g.add(makeDimLine([new THREE.Vector3(dX, LY, fmaxZ - TK), new THREE.Vector3(dX, LY, fmaxZ + TK)]));
    const dSp = makeDimSprite(fmtDimCm(totalDCm));
    dSp.position.set(dX, LY + 0.18, (fminZ + fmaxZ) / 2);
    g.add(dSp);

    // —— 层高标注（西侧，竖向）——
    const flH = (Number.isFinite(Number(fl.height)) && fl.height > 0 ? Number(fl.height) : 280) / 100;
    const VEXT = EXT2;         // 与总宽/深一致，放在外层
    const VTK  = TK;
    const vX   = fminX - VEXT; // 西侧偏移位置
    const midZ = (fminZ + fmaxZ) / 2;

    // 竖向主标注线（从楼板面到墙顶）
    g.add(makeDimLine([new THREE.Vector3(vX, 0, midZ), new THREE.Vector3(vX, flH, midZ)]));
    // 底部引出线
    g.add(makeDimLine([new THREE.Vector3(fminX, 0, midZ), new THREE.Vector3(vX - VTK, 0, midZ)], 0x5599ee, 0.05, 0.04));
    // 顶部引出线
    g.add(makeDimLine([new THREE.Vector3(fminX, flH, midZ), new THREE.Vector3(vX - VTK, flH, midZ)], 0x5599ee, 0.05, 0.04));
    // 底部刻度线
    g.add(makeDimLine([new THREE.Vector3(vX - VTK, 0, midZ), new THREE.Vector3(vX + VTK, 0, midZ)]));
    // 顶部刻度线
    g.add(makeDimLine([new THREE.Vector3(vX - VTK, flH, midZ), new THREE.Vector3(vX + VTK, flH, midZ)]));
    // 层高标签
    const hSp = makeDimSprite(fmtDimCm(fl.height || 280));
    hSp.position.set(vX, flH / 2 + 0.15, midZ);
    g.add(hSp);

    return g;
  }

  /**
   * 为单个家具 Group 创建本地坐标系下的尺寸标注 Group。
   * 标注随家具旋转一起变化。
   */
  function buildFurnitureDimAnnotation(group) {
    const item = byId.get(group.userData.modelType);
    const fp = extractFurnitureFootprintCm(item);
    const hw = fp.hw / 100; // 半宽（米）
    const hh = fp.hh / 100; // 半深（米）
    const fh = fp.h  / 100; // 家具高度（米）

    const LY  = fh + 0.03; // 略高于家具顶面
    const EXT = 0.18; // 标注线外伸量
    const TK  = 0.06; // 刻度线半长

    const g = new THREE.Group();
    g.userData.isFurnitureDimAnnotation = true;

    // 虚线轮廓
    const corners = [
      new THREE.Vector3(-hw, LY, -hh),
      new THREE.Vector3( hw, LY, -hh),
      new THREE.Vector3( hw, LY,  hh),
      new THREE.Vector3(-hw, LY,  hh),
      new THREE.Vector3(-hw, LY, -hh),
    ];
    g.add(makeDimLine(corners, 0x7799cc, 0.07, 0.05));

    // 宽度标注（南侧）
    const wZ = hh + EXT;
    g.add(makeDimLine([new THREE.Vector3(-hw, LY, wZ), new THREE.Vector3(hw, LY, wZ)]));
    g.add(makeDimLine([new THREE.Vector3(-hw, LY, hh), new THREE.Vector3(-hw, LY, wZ + TK)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3( hw, LY, hh), new THREE.Vector3( hw, LY, wZ + TK)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(-hw, LY, wZ - TK), new THREE.Vector3(-hw, LY, wZ + TK)]));
    g.add(makeDimLine([new THREE.Vector3( hw, LY, wZ - TK), new THREE.Vector3( hw, LY, wZ + TK)]));
    const wSp = makeDimSprite(fmtDimCm(fp.w), { fontSize: 18, pxPerM: 140 });
    wSp.position.set(0, LY + 0.15, wZ);
    g.add(wSp);

    // 深度标注（东侧）
    const dX = hw + EXT;
    g.add(makeDimLine([new THREE.Vector3(dX, LY, -hh), new THREE.Vector3(dX, LY, hh)]));
    g.add(makeDimLine([new THREE.Vector3(hw, LY, -hh), new THREE.Vector3(dX + TK, LY, -hh)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(hw, LY,  hh), new THREE.Vector3(dX + TK, LY,  hh)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(dX - TK, LY, -hh), new THREE.Vector3(dX + TK, LY, -hh)]));
    g.add(makeDimLine([new THREE.Vector3(dX - TK, LY,  hh), new THREE.Vector3(dX + TK, LY,  hh)]));
    const dSp = makeDimSprite(fmtDimCm(fp.d), { fontSize: 18, pxPerM: 140 });
    dSp.position.set(dX, LY + 0.15, 0);
    g.add(dSp);

    // 高度标注（西侧，竖向，从地面到顶面）
    const midZ = 0;
    const vX = -hw - EXT;
    g.add(makeDimLine([new THREE.Vector3(vX, 0, midZ), new THREE.Vector3(vX, fh, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(-hw, 0, midZ), new THREE.Vector3(vX - TK, 0, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(-hw, fh, midZ), new THREE.Vector3(vX - TK, fh, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(vX - TK, 0, midZ), new THREE.Vector3(vX + TK, 0, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(vX - TK, fh, midZ), new THREE.Vector3(vX + TK, fh, midZ)]));
    const hSp = makeDimSprite(fmtDimCm(fp.h), { fontSize: 18, pxPerM: 140 });
    hSp.position.set(vX, fh / 2 + 0.15, midZ);
    g.add(hSp);

    return g;
  }

  /** 刷新所有家具的尺寸标注（showDimensions 切换或楼层切换时调用）。 */
  function rebuildFurnitureDimAnnotations() {
    furnitureRoot.children.forEach((group) => {
      if (!group.userData?.isFurniture) return;
      // 移除旧标注
      const old = group.children.filter((c) => c.userData?.isFurnitureDimAnnotation);
      old.forEach((c) => { group.remove(c); disposeObject3D(c); });
      // 仅当 showDimensions 且该楼层可选中时显示
      if (showDimensions && group.visible && group.userData.isFloorActive !== false) {
        group.add(buildFurnitureDimAnnotation(group));
      }
    });
  }

  function setDimensionsVisible(v) {
    showDimensions = Boolean(v);
    const btn = document.getElementById("svgDimToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", showDimensions);
      btn.setAttribute("aria-pressed", String(showDimensions));
    }
    if (showDimensions && !hasFloorplanDimAnnotationGroups()) {
      void rebuildFloorplan3D();
    } else {
      syncFloorAnnotationVisibility();
    }
    updateFurnitureFloorVisibility();
  }

  /** 刷新所有家具的名称标注 */
  function rebuildFurnitureNameAnnotations() {
    furnitureRoot.children.forEach((group) => {
      if (!group.userData?.isFurniture) return;
      const old = group.children.filter((c) => c.userData?.isFurnitureNameAnnotation);
      old.forEach((c) => { group.remove(c); disposeObject3D(c); });
      if (showNames && group.visible && group.userData.isFloorActive !== false) {
        const item = byId.get(group.userData.modelType);
        const name = item ? getFurnitureDisplayName(item) : (group.userData.modelType || "家具");
        const fp = extractFurnitureFootprintCm(item);
        const fh = fp.h / 100;
        const sp = makeDimSprite(name, { fontSize: 22, pxPerM: 160 });
        sp.position.set(0, fh + 0.08, 0);
        sp.userData.isFurnitureNameAnnotation = true;
        group.add(sp);
      }
    });
  }

  function setNamesVisible(v) {
    showNames = Boolean(v);
    const btn = document.getElementById("svgNameToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", showNames);
      btn.setAttribute("aria-pressed", String(showNames));
    }
    if (showNames && !hasFloorplanNameAnnotationGroups()) {
      void rebuildFloorplan3D();
    } else {
      syncFloorAnnotationVisibility();
    }
    updateFurnitureFloorVisibility();
  }

  function setWallSnapEnabled(v) {
    wallSnapEnabled = Boolean(v);
    const btn = document.getElementById("svgWallSnapToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", wallSnapEnabled);
      btn.setAttribute("aria-pressed", String(wallSnapEnabled));
    }
  }

  function setShadowsEnabled(v) {
    shadowsEnabled = Boolean(v);
    renderer.shadowMap.enabled = shadowsEnabled;
    dirLight.castShadow = shadowsEnabled;
    const btn = document.getElementById("svgShadowToggleBtn");
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
    const entry = currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const c of gWorld.children) {
      if (c.userData?.floorplanFloorGroup) floorGroups.push(c);
    }
    if (floorGroups.length !== floors.length) return false;

    const floorIdxActive = floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1;
    let needFullRebuild = false;

    for (let fi = 0; fi < floorGroups.length; fi++) {
      const newLayerOp =
        floorIdxActive < 0 ? 0.2 : fi === floorIdxActive ? activeLayerOpacity : otherLayersOpacity;

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

  /**
   * 「仅当前层」开关：只更新各楼层 floor group 的 visible，不 rebuild（避免重复贴图加载）。
   */
  function syncHideOtherFloorsFloorplanVisibility() {
    const entry = currentFloorplanEntry;
    if (!entry) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const c of gWorld.children) {
      if (c.userData?.floorplanFloorGroup) floorGroups.push(c);
    }
    if (floorGroups.length !== floors.length) return;
    const floorIndex = floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1;
    for (let i = 0; i < floorGroups.length; i++) {
      const isActive = floorIndex >= 0 && i === floorIndex;
      floorGroups[i].visible = !hideOtherFloors || floorIndex < 0 || isActive;
    }
  }

  /** 楼层选中切换时：只改尺寸/名称标注子 Group 的 visible（各层均已生成，避免 rebuild 贴图） */
  function syncFloorAnnotationVisibility() {
    const entry = currentFloorplanEntry;
    if (!entry) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const c of gWorld.children) {
      if (c.userData?.floorplanFloorGroup) floorGroups.push(c);
    }
    if (floorGroups.length !== floors.length) return;
    const floorIndex = floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1;
    for (let i = 0; i < floorGroups.length; i++) {
      const isActive = floorIndex >= 0 && i === floorIndex;
      const showAnnot = !floorSelectionEnabled || isActive;
      const fg = floorGroups[i];
      for (const ch of fg.children) {
        if (ch.userData?.isDimAnnotation) {
          ch.visible = showDimensions && showAnnot;
        } else if (ch.userData?.isNameAnnotation) {
          ch.visible = showNames && showAnnot;
        }
      }
    }
  }

  /** 场景里是否已有户型尺寸标注 Group（旧版仅在开启时生成；首次开启需 rebuild） */
  function hasFloorplanDimAnnotationGroups() {
    const entry = currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    for (const c of gWorld.children) {
      if (!c.userData?.floorplanFloorGroup) continue;
      for (const ch of c.children) {
        if (ch.userData?.isDimAnnotation) return true;
      }
    }
    return false;
  }

  function hasFloorplanNameAnnotationGroups() {
    const entry = currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    for (const c of gWorld.children) {
      if (!c.userData?.floorplanFloorGroup) continue;
      for (const ch of c.children) {
        if (ch.userData?.isNameAnnotation) return true;
      }
    }
    return false;
  }

  /**
   * 点击楼层 Tab：更新 activeFloor、透明度、仅当前层与标注显隐；仅在 cheap 路径失败时全量 rebuild。
   */
  function applyFloorLevelSelectionChange() {
    const entry = currentFloorplanEntry;
    if (!entry) return;
    const floorIdx = floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1;
    const floor = floorIdx >= 0 ? getCurrentFloorFromEntry(entry, floorIdx) : null;
    activeFloorId = floor?.id != null && String(floor.id).trim() ? String(floor.id).trim() : null;
    rebuildWallSnapData(entry);
    updateBottomUI();
    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-svg", {
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

  function getEffectiveFloorplanStyleKey() {
    const entry = currentFloorplanEntry;
    if (!entry) return "modern_minimal_v1";
    const o = floorplanStyleKeyOverride != null ? String(floorplanStyleKeyOverride).trim() : "";
    if (o) return o;
    const fromEntry = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
    if (fromEntry) return fromEntry;
    const fpId = String(entry?.id ?? "").trim();
    const fromPack = fpId ? getDefaultStyleKeyForFloorplan(fpId) : "";
    return fromPack || "modern_minimal_v1";
  }

  /**
   * @param {{ applyDecorFromStyle?: boolean }} [opts]
   *        applyDecorFromStyle：用当前风格 JSON 中的装饰替换场景装饰（切换风格、首次加载户型时）；undo/设计恢复时不要开启。
   */
  async function rebuildFloorplan3D(opts = {}) {
    const applyDecorFromStyle = Boolean(opts.applyDecorFromStyle);
    const gen = ++floorplanRebuildGen;
    clearInteractiveList();
    disposeObject3D(floorplanRoot);
    floorplanRoot.clear();
    floorplanSelected = false;
    if (!currentFloorplanEntry) {
      lastMergedFloorplanStyle = null;
      floorYOffsetById.clear();
      floorElevationBaseCm = 0;
      rebuildWallSnapData(null);
      const fallbackLight = mergeSceneLighting(null);
      applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, fallbackLight);
      sceneLightingEnvMapIntensity = fallbackLight.envMapIntensity;
      return;
    }

    const entry = currentFloorplanEntry;
    const fpId = String(entry?.id ?? "").trim();
    if (fpId) await loadStylePackIndex(fpId);
    const skEffective = getEffectiveFloorplanStyleKey();
    let style = null;
    try {
      style = await loadStyleConfig(fpId, skEffective);
    } catch (e) {
      console.warn("[VisionHome] 风格包加载失败:", skEffective, e);
    }
    if (!style && entry) {
      const skFallback = String(entry?.styleKey ?? entry?.styleId ?? "").trim();
      if (skFallback && skFallback !== skEffective) {
        try {
          style = await loadStyleConfig(fpId, skFallback);
          if (style) {
            floorplanStyleKeyOverride = null;
            window.dispatchEvent(
              new CustomEvent("visionhome:floorplan-applied-to-svg", {
                detail: {
                  id: fpId,
                  floorIndex: floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1,
                  floorId: String(activeFloorId ?? ""),
                  styleFallbackFrom: skEffective,
                  styleFallbackTo: skFallback,
                },
              }),
            );
          }
        } catch (e2) {
          console.warn("[VisionHome] 风格包回退加载失败:", skFallback, e2);
        }
      }
    }
    lastMergedFloorplanStyle = style;
    if (gen !== floorplanRebuildGen) return;

    const lightingMerged = mergeSceneLighting(style?.sceneLighting ?? null);
    applySceneLightingConfig(renderer, ambientLight, hemiLight, dirLight, lightingMerged);
    sceneLightingEnvMapIntensity = lightingMerged.envMapIntensity;

    const floorIndex = floorSelectionEnabled ? normalizeFloorIndex(entry, currentFloorIndex) : -1;
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
    // floors[].elevation 是 cm，转换到 Three.js Y 轴：/100
    const elevationsCm = floors
      .map((fl) => (Number.isFinite(Number(fl?.elevation)) ? Number(fl.elevation) : 0))
      .filter((n) => Number.isFinite(n));
    floorElevationBaseCm = elevationsCm.length ? Math.min(...elevationsCm) : 0;
    floorYOffsetById = new Map();
    floors.forEach((fl, i) => {
      const keyRaw = String(fl?.id ?? "").trim() || `floor${i + 1}`;
      const key = normalizeFloorKey(keyRaw);
      const eCm = Number.isFinite(Number(fl?.elevation)) ? Number(fl.elevation) : 0;
      floorYOffsetById.set(key, (eCm - floorElevationBaseCm) / 100);
    });
    floors.forEach((fl, i) => {
      const floorG = new THREE.Group();
      floorG.userData.floorplanFloorGroup = true;
      const isActive = floorIndex >= 0 && i === floorIndex;
      // 选中层更深、更清晰：提高不透明度
      // 未选中层更淡：降低透明度
      const opacity = floorIndex >= 0 ? (isActive ? activeLayerOpacity : otherLayersOpacity) : 0.2;

      const styleMatCache = new Map();
      /** @param {string} key @param {{ forGlass?: boolean, floorUv?: boolean }} [opts] */
      function getMaterialForKey(key, opts = {}) {
        if (!style || !key) return null;
        const ck = `${key}|${opts.forGlass ? "g" : ""}|${opts.floorUv ? "f" : ""}`;
        if (styleMatCache.has(ck)) return styleMatCache.get(ck);
        const def = getMaterialDef(style, key);
        if (!def) return null;
        const side = opts.floorUv ? THREE.DoubleSide : THREE.FrontSide;
        const mat = createFloorplanMaterialFromStyleDef(def, opacity, {
          forGlass: opts.forGlass,
          envMapIntensity: opts.forGlass ? 0.9 : sceneLightingEnvMapIntensity,
          side,
        });
        if (opts.floorUv) {
          mat.userData.__floorplanRoomFloorDepthWrite = true;
          applyFloorplanSurfaceAlpha(mat, opacity);
        }
        styleMatCache.set(ck, mat);
        queueStylePackTextures(mat, def, { applyUvScale: !!opts.floorUv });
        return mat;
      }

      const fidRaw = String(fl?.id ?? "").trim() || `floor${i + 1}`;
      (fl.rooms || []).forEach((room, roomIdx) => {
        const fk = resolveRoomFloorMaterialKey(style, room);
        const floorMat = fk ? getMaterialForKey(fk, { floorUv: true }) : null;
        const m = buildRoomMesh(room, cx, cy, s, opacity, floorMat, fidRaw);
        if (m) {
          // 凹多边形 / 共边时避免与地面 z-fighting：后建房间略抬高（毫米级）
          m.position.y = 0.02 + roomIdx * 0.0002;
          floorG.add(m);
        }
      });
      const fh = Number(fl.height);
      const defaultH = Number.isFinite(fh) && fh > 0 ? fh : 280;
      for (const w of fl.walls || []) {
        const wk = resolveWallMaterialKey(style, w);
        const wallMat = wk ? getMaterialForKey(wk) : null;
        const m = buildWallMesh(w, fl, cx, cy, s, defaultH, opacity, wallMat, style, getMaterialForKey, fidRaw);
        if (m) floorG.add(m);
      }
      for (const d of fl.doors || []) {
        const wid = String(d.wallId ?? "").trim();
        const w = wid ? (fl.walls || []).find((x) => String(x?.id ?? "") === wid) : null;
        if (!w) continue;
        const dk = resolveDoorMaterialKey(style, d);
        const doorMat = dk ? getMaterialForKey(dk) : null;
        const fillG = buildDoorFillGroup(d, w, cx, cy, s, defaultH, opacity, doorMat, fidRaw);
        if (fillG) floorG.add(fillG);
      }
      for (const win of fl.windows || []) {
        const wid = String(win.wallId ?? "").trim();
        const w = wid ? (fl.walls || []).find((x) => String(x?.id ?? "") === wid) : null;
        if (!w) continue;
        const wink = resolveWindowMaterialKey(style, win);
        const winMat = wink ? getMaterialForKey(wink, { forGlass: true }) : null;
        const winG = buildWindowGlassGroup(win, w, cx, cy, s, defaultH, opacity, winMat, fidRaw);
        if (winG) floorG.add(winG);
      }
            // 尺寸/名称：每层都生成，用 visible 控制开关与「仅选中楼层时只显示当前层」（点击开关不 rebuild）
      const dimG = buildFloorDimensions(fl, cx, cy, s);
      if (dimG) {
        dimG.visible = showDimensions && (!floorSelectionEnabled || isActive);
        floorG.add(dimG);
      }
      const nameG = buildFloorNameAnnotations(fl, cx, cy, s);
      if (nameG) {
        nameG.visible = showNames && (!floorSelectionEnabled || isActive);
        floorG.add(nameG);
      }
      // 每层楼的垂直高度（避免所有层重叠在 y=0）
      floorG.position.y = floorYOffsetById.get(normalizeFloorKey(fidRaw)) ?? 0;
      // 未开启“仅当前层”时：所有楼层都绘制（未选中透明弱化）
      // 开启“仅当前层”时：只显示当前楼层
      floorG.visible = !hideOtherFloors || floorIndex < 0 || isActive;
      gWorld.add(floorG);
    });

    const hitW = (Math.max(bbox.w, 1) * s) / 100;
    const hitD = (Math.max(bbox.h, 1) * s) / 100;
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(hitW, hitD), new THREE.MeshBasicMaterial({ visible: false }));
    hit.rotation.x = -Math.PI / 2;
    hit.userData.floorplanPick = true;
    gWorld.add(hit);

    activeFloorId = floor?.id != null && String(floor.id).trim() ? String(floor.id).trim() : null;
    await applySurfaceOverridesToFloorplan();
    rebuildWallSnapData(entry);
    updateBottomUI();

    if (applyDecorFromStyle && style && gen === floorplanRebuildGen) {
      await mergeLayoutWithStyleDecorations(style);
      if (gen !== floorplanRebuildGen) return;
    }

    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-svg", {
        detail: { id: entry?.id != null ? String(entry.id) : "", floorIndex, floorId: String(floor?.id ?? "") },
      }),
    );
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
      btn.className = "svg-floor-level-tab";
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
    const slot = document.getElementById("svgEditorSlot");
    if (!slot || floorLevelDock) return;
    const dock = document.createElement("div");
    dock.className = "svg-floor-level-dock";
    dock.hidden = true;
    dock.setAttribute("aria-label", "楼层");
    const row = document.createElement("div");
    row.className = "svg-floor-level-row";
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
    currentFloorplanEntry = null;
    floorplanStyleKeyOverride = null;
    floorplanSurfaceOverridesByStyleKey = {};
    currentFloorIndex = 0;
    floorSelectionEnabled = true;
    syncOtherOpacityUi();
    rebuildFloorplan3D();
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  /** @param {{ preserveSurfaceOverrides?: boolean, preserveStyleKeyOverride?: boolean, floorIndex?: number, skipDecorFromStyleMerge?: boolean }} [options] */
  async function applyFloorplanEntryAtWorld(entry, _wx, _wy, options = {}) {
    if (!entry) return;
    /** 从户型库拖入/替换户型时清空；从设计文件或 undo 恢复时已先写入 overrides 时需传 preserveSurfaceOverrides: true */
    if (!options.preserveSurfaceOverrides) {
      floorplanSurfaceOverridesByStyleKey = {};
    }
    currentFloorplanEntry = entry;
    currentFloorIndex = normalizeFloorIndex(entry, options.floorIndex);
    if (!options.preserveStyleKeyOverride) floorplanStyleKeyOverride = null;
    floorSelectionEnabled = true;
    syncOtherOpacityUi();
    await rebuildFloorplan3D({ applyDecorFromStyle: !options.skipDecorFromStyleMerge });
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  async function createFurnitureMesh(furnitureId) {
    const item = byId.get(furnitureId);
    const fp = extractFurnitureFootprintCm(item);
    const w = fp.w / 100, d = fp.d / 100, h = fp.h / 100;
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
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = false;
          }
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
    const mat = stdMat(0x8c7cff);
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

  async function appendFurnitureItem(modelId, xCm, yCm, rotationDeg = 0, floorId = null, opts = {}) {
    if (!byId.has(modelId)) return null;
    const item = byId.get(modelId);
    const fp = extractFurnitureFootprintCm(item);
    const group = await createFurnitureMesh(modelId);
    group.userData.isFurniture = true;
    group.userData.footprint = { hw: fp.hw, hh: fp.hh };
    group.userData.floorId = String(floorId ?? getActiveFloorIdForFurniture()).trim() || "floor1";
    let rot = Math.round(Number(rotationDeg) || 0) % 360;
    if (rot < 0) rot += 360;
    group.userData.rotDeg = rot;
    setFurnitureFromLayoutCm(group, xCm, yCm, rot, opts);
    if (modelIdIsDecoration(modelId)) {
      const cm = opts.decorationLiftCm != null ? Number(opts.decorationLiftCm) : 0;
      const liftM = Number.isFinite(cm) ? cm / 100 : 0;
      group.userData.decorationLiftM = clampDecorationLiftMForGroup(group, liftM);
    }
    furnitureRoot.add(group);
    registerFurnitureMeshes(group);
    return group;
  }

  async function rebuildFromLayout(layout) {
    furnitureRoot.children.slice().forEach((ch) => {
      if (ch.userData?.isFurniture) {
        unregisterFurnitureGroup(ch);
        furnitureRoot.remove(ch);
        disposeObject3D(ch);
      }
    });
    for (const row of layout) {
      await appendFurnitureItem(row.model, row.x, row.y, row.rotation ?? 0, row.floorId ?? null, {
        wallSnap: false,
        decorationLiftCm: row.decorationLiftCm,
      });
    }
    updateFurnitureFloorVisibility();
    updateBottomUI();
  }

  /**
   * 用当前风格包中的装饰实例替换场景里的装饰（家具行保留）。切换风格时必须调用，否则装饰一直停留在全局 layout 中。
   * @param {object | null | undefined} style loadStyleConfig 的合并结果
   */
  async function mergeLayoutWithStyleDecorations(style) {
    const layout = getLayout();
    const furnitureOnly = layout.filter((row) => !modelIdIsDecoration(row.model));
    const decRows = decorationPlacementsToLayoutRows(style);
    await rebuildFromLayout([...furnitureOnly, ...decRows]);
  }

  // ── 底部实时预算 & 空间利用率 ──────────────────────────────────────
  /** 单件：条目 `price` + 当前 SKU `markup`（有材质配置时） */
  function getFurnitureLinePrice(item, group) {
    const base = Number(item?.price ?? 0);
    if (!item || base <= 0) return 0;
    if (!hasFurnitureMaterialConfig(item)) return base;
    const sel = normalizeFurnitureSelection(item, group?.userData?.furnitureSelection);
    const det = resolveFurnitureSelectionDetail(item, sel);
    const m = det.skuMarkup != null ? det.skuMarkup : 0;
    return base + (Number.isFinite(m) ? m : 0);
  }

  function updateBottomUI() {
    const priceEl   = document.getElementById("bottomUiPrice");
    const pctEl     = document.getElementById("bottomUiRatePercent");
    const levelEl   = document.getElementById("bottomUiRateLevel");
    if (!priceEl && !pctEl) return;

    // 1. 家具总价（含 SKU 加价）
    let totalPrice = 0;
    let furnitureAreaCm2 = 0;
    const decCatalog = window.__decorationCatalog;
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const modelType = g.userData.modelType;
      const isDecoration = decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType);

      // 价格：只计入家具，装饰库组件不计入
      if (!isDecoration) {
        const item = byId.get(modelType);
        const price = getFurnitureLinePrice(item, g);
        if (price > 0) totalPrice += price;
      }

      // 面积：家具和装饰库都计入，各自从对应 catalog 取 footprint
      if (isDecoration) {
        const decItem = decCatalog.byId.get(modelType);
        const fp = extractFurnitureFootprintCm(decItem);
        furnitureAreaCm2 += fp.hw * fp.hh * 4;
      } else {
        const hw = g.userData.footprint?.hw ?? 0;
        const hh = g.userData.footprint?.hh ?? 0;
        furnitureAreaCm2 += hw * hh * 4;
      }
    });

    if (priceEl) {
      priceEl.textContent = `¥${totalPrice.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    // 2. 空间利用率 = 家具总面积 / 户型总房间面积
    let floorAreaCm2 = 0;
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    for (const fl of floors) {
      for (const room of fl.rooms ?? []) {
        const poly = room?.polygon;
        if (!Array.isArray(poly) || poly.length < 3) continue;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
          const [ax, ay] = poly[i];
          const [bx, by] = poly[(i + 1) % poly.length];
          area += ax * by - bx * ay;
        }
        floorAreaCm2 += Math.abs(area) / 2;
      }
    }

    if (pctEl || levelEl) {
      const pct = floorAreaCm2 > 0 ? Math.min(100, Math.round((furnitureAreaCm2 / floorAreaCm2) * 100)) : 0;
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (levelEl) {
        let level = "-";
        if (floorAreaCm2 > 0) {
          if      (pct >= 60) level = "拥挤";
          else if (pct >= 40) level = "紧凑";
          else if (pct >= 20) level = "优秀";
          else if (pct >= 8)  level = "适中";
          else                level = "稀疏";
        }
        levelEl.textContent = level;
      }
    }

    refreshBomPopupIfOpen();
  }

  // ── 预算明细弹出窗 ────────────────────────────────────────────────
  function setBomArrow(open) {
    const arrow = document.getElementById("bomArrow");
    if (arrow) arrow.textContent = open ? "▼" : "▲";
  }

  /** 重填 BOM 列表与合计（与底部总价口径一致：base + SKU markup） */
  function fillBomPopupContent() {
    const list = document.getElementById("bomPopupList");
    const total = document.getElementById("bomPopupTotal");
    if (!list) return 0;
    list.replaceChildren();
    let sum = 0;

    const tally = new Map(); // key → { name, line, count, skuName, markup, baseUnit }
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const modelType = g.userData.modelType;
      // 装饰库组件不计入预算明细
      const decCatalog = window.__decorationCatalog;
      if (decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType)) return;
      const item = byId.get(modelType);
      const name = item ? getFurnitureDisplayName(item) : (modelType || "家具");
      const line = getFurnitureLinePrice(item, g);
      const baseUnit = Number(item?.price ?? 0);
      let key = modelType;
      let skuName = "";
      let markup = 0;
      if (item && hasFurnitureMaterialConfig(item)) {
        const sel = normalizeFurnitureSelection(item, g.userData.furnitureSelection);
        key = `${modelType}\0${sel?.skuId ? String(sel.skuId) : ""}`;
        const det = resolveFurnitureSelectionDetail(item, sel);
        skuName = String(det.skuName ?? "").trim();
        markup = det.skuMarkup != null && Number.isFinite(det.skuMarkup) ? det.skuMarkup : 0;
      }
      if (tally.has(key)) {
        tally.get(key).count += 1;
      } else {
        tally.set(key, { name, line, count: 1, skuName, markup, baseUnit });
      }
    });

    if (tally.size === 0) {
      const empty = document.createElement("li");
      empty.className = "bom-popup__item";
      empty.style.justifyContent = "center";
      empty.style.color = "rgba(255,255,255,0.35)";
      empty.textContent = "暂无家具";
      list.appendChild(empty);
      if (total) total.textContent = "¥0.00";
      return 0;
    }

    const fmtBomYuan = (n) =>
      `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    for (const { name, line, count, skuName, markup, baseUnit } of tally.values()) {
      const li = document.createElement("li");
      li.className = "bom-popup__item";
      const label = skuName
        ? count > 1
          ? `${name}（${skuName}）×${count}`
          : `${name}（${skuName}）`
        : count > 1
          ? `${name} ×${count}`
          : name;
      const subtotal = line * count;
      sum += subtotal;
      const baseTotal = (Number.isFinite(baseUnit) ? baseUnit : 0) * count;
      const hasMk = Number.isFinite(markup) && markup !== 0;

      const nameCol = document.createElement("div");
      nameCol.className = "bom-popup__item-name";
      const titleEl = document.createElement("div");
      titleEl.className = "bom-popup__item-title";
      titleEl.textContent = label;
      nameCol.appendChild(titleEl);

      const priceCol = document.createElement("div");
      priceCol.className = "bom-popup__item-prices";

      if (hasMk) {
        const mkEl = document.createElement("div");
        mkEl.className = "bom-popup__item-markup" + (markup < 0 ? " is-negative" : "");
        const mkTotal = markup * count;
        mkEl.textContent =
          count <= 1
            ? `加价 ${formatSkuMarkupLabel(markup)}`
            : `加价 ${formatSkuMarkupLabel(markup)}/件，合计 ${formatSkuMarkupLabel(mkTotal)}`;
        nameCol.appendChild(mkEl);

        const strike = document.createElement("span");
        strike.className = "bom-popup__item-price bom-popup__item-price--strike";
        strike.textContent = baseTotal > 0 ? fmtBomYuan(baseTotal) : "—";
        const finalEl = document.createElement("span");
        finalEl.className = "bom-popup__item-price bom-popup__item-price--final";
        finalEl.textContent = subtotal > 0 ? fmtBomYuan(subtotal) : "—";
        priceCol.appendChild(strike);
        priceCol.appendChild(finalEl);
      } else {
        const p = document.createElement("span");
        p.className = "bom-popup__item-price";
        p.textContent = subtotal > 0 ? fmtBomYuan(subtotal) : "—";
        priceCol.appendChild(p);
      }

      li.appendChild(nameCol);
      li.appendChild(priceCol);
      list.appendChild(li);
    }

    if (total) {
      total.textContent = `¥${sum.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return sum;
  }

  function refreshBomPopupIfOpen() {
    const popup = document.getElementById("bomPopup");
    if (!popup || popup.hidden) return;
    fillBomPopupContent();
  }

  function openBomPopup() {
    const popup = document.getElementById("bomPopup");
    if (!popup) return;
    fillBomPopupContent();
    popup.hidden = false;
    setBomArrow(true);
  }

  function closeBomPopup() {
    const popup = document.getElementById("bomPopup");
    if (popup) popup.hidden = true;
    setBomArrow(false);
  }

  document.getElementById("bottomUiBudgetTrigger")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const popup = document.getElementById("bomPopup");
    if (popup?.hidden) openBomPopup();
  });
  document.getElementById("bomPopupClose")?.addEventListener("click", closeBomPopup);

  function updateFurnitureFloorVisibility() {
    const hasFloor = Boolean(activeFloorId);
    const activeKey = activeFloorId != null ? normalizeFloorKey(activeFloorId) : null;
    activeFloorPickMeshes.length = 0;
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const fid = String(g.userData.floorId || "").trim();
      const key = normalizeFloorKey(fid);
      const yOff = floorYOffsetById.get(key) ?? 0;
      let liftM = 0;
      if (modelIdIsDecoration(g.userData.modelType)) {
        liftM = clampDecorationLiftMForGroup(g, g.userData.decorationLiftM ?? 0);
        g.userData.decorationLiftM = liftM;
      }
      // group.position.y：楼板高度 + 装饰物垂直偏移；普通家具仅楼板；mesh 本地 y 不变
      g.position.y = yOff + liftM;
      const isActiveFloor = !hasFloor || !fid || key === activeKey;
      g.userData.isFloorActive = isActiveFloor;
      // 未开启“仅当前层”：其它楼层弱化且不可选中
      // 开启“仅当前层”：其它楼层隐藏（不可见且不可选）
      g.visible = !hideOtherFloors || isActiveFloor;
      g.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (isActiveFloor) activeFloorPickMeshes.push(o);
        const op = isActiveFloor ? 1 : Math.min(1, otherLayersOpacity * 2);
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => {
          if (!m) return;
          applyFloorplanSurfaceAlpha(m, op);
          m.needsUpdate = true;
        });
      });
    });
    if (selectedGroup && selectedGroup.userData?.isFloorActive === false) selectFurniture(null);
    rebuildFurnitureDimAnnotations();
    rebuildFurnitureNameAnnotations();
  }

  function getLayout() {
    const out = [];
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const cm = sceneXZToCenteredCm(g.position.x, g.position.z);
      const row = {
        model: g.userData.modelType,
        floorId: String(g.userData.floorId || "").trim() || null,
        x: Math.round(cm.x),
        y: Math.round(cm.y),
        rotation: Math.round(g.userData.rotDeg ?? 0),
      };
      if (modelIdIsDecoration(g.userData.modelType)) {
        row.decorationLiftCm = Math.round((Number(g.userData.decorationLiftM) || 0) * 100);
      }
      out.push(row);
    });
    return out;
  }

  function serializeEditorSnapshot() {
    return JSON.stringify({
      v: 1,
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
      floorplanStyleKey: getEffectiveFloorplanStyleKey(),
      // 兼容旧版：surfaceOverrides 仅当前风格 bucket；新版优先使用 surfaceOverridesByStyleKey。
      surfaceOverrides: JSON.parse(JSON.stringify(getCurrentSurfaceOverridesBucket())),
      surfaceOverridesByStyleKey: JSON.parse(JSON.stringify(floorplanSurfaceOverridesByStyleKey)),
    });
  }

  function cloneSurfaceOverridesPayload(raw) {
    if (!raw || typeof raw !== "object") return undefined;
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {
      return undefined;
    }
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
      if (id === undefined) {
        return {
          furniture: parsed.furniture,
          floorPlanId: undefined,
          floorLevelIndex,
          floorplanStyleKey,
          surfaceOverrides,
          surfaceOverridesByStyleKey,
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
        };
      }
      return {
        furniture: parsed.furniture,
        floorPlanId: String(id).trim(),
        floorLevelIndex,
        floorplanStyleKey,
        surfaceOverrides,
        surfaceOverridesByStyleKey,
      };
    }
    return null;
  }

  async function applyHistorySnapshotState(state) {
    if (!state) return;
    if (Object.prototype.hasOwnProperty.call(state, "surfaceOverridesByStyleKey")) {
      const raw = state.surfaceOverridesByStyleKey && typeof state.surfaceOverridesByStyleKey === "object"
        ? JSON.parse(JSON.stringify(state.surfaceOverridesByStyleKey))
        : {};
      const next = {};
      for (const [sk, bucket] of Object.entries(raw)) {
        if (!bucket || typeof bucket !== "object") continue;
        next[normalizeStyleKeyForSurfaceOverrides(sk)] = migrateFloorplanSurfaceOverridesBucket(bucket);
      }
      floorplanSurfaceOverridesByStyleKey = next;
    } else if (Object.prototype.hasOwnProperty.call(state, "surfaceOverrides")) {
      const legacy = migrateFloorplanSurfaceOverridesBucket(
        state.surfaceOverrides && typeof state.surfaceOverrides === "object"
          ? JSON.parse(JSON.stringify(state.surfaceOverrides))
          : {},
      );
      const sk = normalizeStyleKeyForSurfaceOverrides(state.floorplanStyleKey);
      floorplanSurfaceOverridesByStyleKey = { [sk]: legacy };
    } else {
      floorplanSurfaceOverridesByStyleKey = {};
    }
    if (state.floorPlanId !== undefined) {
      if (state.floorPlanId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(state.floorPlanId) : null;
        if (entry) {
          if (Object.prototype.hasOwnProperty.call(state, "floorplanStyleKey")) {
            const sk = state.floorplanStyleKey;
            floorplanStyleKeyOverride = sk != null && String(sk).trim() ? String(sk).trim() : null;
          } else {
            floorplanStyleKeyOverride = null;
          }
          await applyFloorplanEntryAtWorld(entry, undefined, undefined, {
            floorIndex: state.floorLevelIndex,
            preserveStyleKeyOverride: true,
            preserveSurfaceOverrides: true,
            skipDecorFromStyleMerge: true,
          });
        } else clearFloorplan();
      } else clearFloorplan();
    }
    const furn = Array.isArray(state.furniture) ? state.furniture : [];
    await rebuildFromLayout(furn);
  }

  function pushHistorySnapshot() {
    if (!historyReady || isRestoring) return;
    const s = serializeEditorSnapshot();
    if (history.length && history[historyIndex] === s) return;
    history.splice(historyIndex + 1);
    history.push(s);
    historyIndex = history.length - 1;
    while (history.length > MAX_HISTORY) { history.shift(); historyIndex--; }
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
    emitLayoutChanged();
  }

  function schedulePushHistory() {
    if (!historyReady || isRestoring) return;
    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = setTimeout(() => { historyDebounceTimer = null; pushHistorySnapshot(); }, 450);
  }

  function flushHistoryDebounce() {
    if (historyDebounceTimer) {
      clearTimeout(historyDebounceTimer);
      historyDebounceTimer = null;
      pushHistorySnapshot();
    }
  }

  function initHistory() {
    history.splice(0, history.length, serializeEditorSnapshot());
    historyIndex = 0;
    if (undoBtn) undoBtn.disabled = true;
    if (redoBtn) redoBtn.disabled = true;
  }

  async function applyHistoryIndex(i) {
    let state;
    try { state = normalizeHistorySnapshot(JSON.parse(history[i])); } catch { state = null; }
    if (!state) return;
    isRestoring = true;
    try {
      await applyHistorySnapshotState(state);
    } finally {
      isRestoring = false;
    }
    selectFurniture(null);
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
    emitLayoutChanged();
  }

  async function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    await applyHistoryIndex(historyIndex);
  }

  async function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    await applyHistoryIndex(historyIndex);
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
        };
      }
      if (o.userData?.floorplanWindowFill && fid) {
        return {
          kind: "allWindows",
          floorLevelId: fid,
        };
      }
      if (o.userData?.floorplanDoorFill && fid) {
        return {
          kind: "allDoors",
          floorLevelId: fid,
        };
      }
      const wid = o.userData?.floorplanWallId;
      if (wid && fid) {
        return {
          kind: "allWalls",
          floorLevelId: fid,
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
        const t = String(entryDef?.type ?? "");
        const matches = isFloor
          ? t === "wood_floor"
          : scope === "allWindows"
            ? t === "glass"
            : t === "paint" || t === "paint_wood" || t === "glass";
        if (matches) selectVal = key;
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
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    if (propertiesName) {
      propertiesName.textContent = isFloor ? "全部地面" : isDoor ? "全部门" : isWin ? "全部窗" : "全部墙体";
    }
    if (propSurfaceTitle) {
      propSurfaceTitle.textContent = isFloor
        ? "地面属性（本层所有房间）"
        : isDoor
          ? "门属性（本层全部门洞）"
          : isWin
            ? "窗户属性（本层全部窗洞玻璃）"
            : "墙体属性（本层全部墙）";
    }
    if (propSurfaceIdHint) {
      propSurfaceIdHint.textContent = `本层楼层 id：${sel.floorLevelId || "—"} · 修改将应用于该层全部${isFloor ? "地面" : isDoor ? "门洞填充" : isWin ? "窗洞玻璃" : "墙体"}`;
    }
    const ov = getFloorplanSurfaceGlobalOverride(sel.floorLevelId, scope);
    const sampleMesh = findFirstFloorplanSurfaceMesh(sel.floorLevelId, scope);
    const hex = ov?.color || sampleMeshColorHex(sampleMesh);
    const normalizedHex = hex.length === 7 ? hex : `#${hex.replace(/^#/, "")}`;
    if (propSurfaceColor) propSurfaceColor.value = normalizedHex;
    surfaceColorPicker?.setHex(normalizedHex, true);

    const lib = await getFloorplanMaterialsLibraryBag();

    const selectVal = await resolveBaseMaterialIdForSurfacePanel(sel, scope, ov, lib);
    const texAlbedoRaw = String(ov?.textureAlbedo ?? "").trim();
    if (propSurfaceMaterialSection) propSurfaceMaterialSection.hidden = isWin;
    if (propSurfaceUvTextureSection) propSurfaceUvTextureSection.hidden = isWin;
    if (!isWin) {
      if (propSurfaceMaterial) propSurfaceMaterial.value = selectVal;
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

      propSurfaceMaterialGrid.replaceChildren();
      for (const fn of files) {
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
    if (sel) setFloorplanGlobalSurfaceHighlight(sel.floorLevelId, sel.kind, true);
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
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    const lib = await getFloorplanMaterialsLibraryBag();
    const fid = sel.floorLevelId;
    const prevOv = getFloorplanSurfaceGlobalOverride(fid, scope);

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
      setFloorplanSurfaceGlobalOverride(fid, scope, hasScopeData ? next : null);
      if (!hasScopeData) {
        await rebuildFloorplan3D();
      } else {
        await applySurfaceOverridesForFloorScope(fid, scope);
      }
      await selectFloorplanSurface(sel);
      if (historyReady) schedulePushHistory();
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
    setFloorplanSurfaceGlobalOverride(fid, scope, hasScopeData ? next : null);
    if (!hasScopeData) {
      await rebuildFloorplan3D();
    } else {
      await applySurfaceOverridesForFloorScope(fid, scope);
    }
    await selectFloorplanSurface(sel);
    if (historyReady) schedulePushHistory();
  }

  async function resetFloorplanSurfaceToDefault() {
    const sel = selectedFloorplanSurface;
    if (!sel || !propSurfaceColor || !propSurfaceMaterial) return;
    const scope = floorplanSurfaceScopeFromKind(sel.kind);
    setFloorplanSurfaceGlobalOverride(sel.floorLevelId, scope, null);
    await rebuildFloorplan3D();
    await selectFloorplanSurface(sel);
    if (historyReady) schedulePushHistory();
  }

  function serializeDesignBaseline() {
    return JSON.stringify({
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
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

  function selectFurniture(group, skipPanelSync = false) {
    if (selectedGroup && selectedGroup !== group) {
      selectedGroup.traverse((o) => {
        if (o.isMesh && o.material?.emissive) o.material.emissive.setHex(0x000000);
      });
    }
    selectedGroup = group || null;
    floorplanSelected = false;
    if (selectedGroup) {
      selectedGroup.traverse((o) => {
        if (o.isMesh && o.material?.emissive) o.material.emissive.setHex(0x332200);
      });
    }
    if (!skipPanelSync) {
      syncPropertiesPanelForSelection(selectedGroup);
    }
  }

  function deselectVisualOnly() {
    if (selectedGroup) {
      selectedGroup.traverse((o) => {
        if (o.isMesh && o.material?.emissive) o.material.emissive.setHex(0x000000);
      });
      selectedGroup = null;
    }
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
    selectedGroup = null;
    syncPropertiesPanelForSelection(null);
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
    if (fur && e.altKey && modelIdIsDecoration(fur.userData.modelType)) {
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
      };
      controls.enabled = false;
      e.preventDefault();
      return;
    }
    const surf = rayPickFloorplanSurface(e.clientX, e.clientY);
    if (surf) {
      pendingSurfacePick = {
        surf,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        timerId: setTimeout(() => {
          pendingSurfacePick = null;
        }, FLOORPLAN_SURFACE_LONG_PRESS_MS),
      };
      floorplanSelected = false;
      e.preventDefault();
      return;
    }
    if (rayPickFloorplan(e.clientX, e.clientY)) {
      clearFloorplanSurfaceSelection();
      selectFurniture(null);
      floorplanSelected = true;
      propertiesPanel?.classList.remove("is-visible");
      return;
    }
    clearFloorplanSurfaceSelection();
    selectFurniture(null);
    floorplanSelected = false;
    propertiesPanel?.classList.remove("is-visible");
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
    if (altDragState && e.pointerId === altDragState.pointerId) {
      const dy = e.clientY - altDragState.startClientY;
      const sensitivity = 0.0025;
      const g = altDragState.group;
      if (g?.userData?.isFurniture && modelIdIsDecoration(g.userData.modelType)) {
        const newLift = altDragState.startLiftM - dy * sensitivity;
        g.userData.decorationLiftM = clampDecorationLiftMForGroup(g, newLift);
        updateFurnitureFloorVisibility();
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
    syncPropertiesPanelForSelection(g);
  }

  function onPointerUp(e) {
    if (pendingSurfacePick && e.pointerId === pendingSurfacePick.pointerId) {
      clearTimeout(pendingSurfacePick.timerId);
      const surf = pendingSurfacePick.surf;
      pendingSurfacePick = null;
      if (e.type !== "pointercancel") {
        void selectFloorplanSurface(surf);
      }
    }
    if (altDragState && e.pointerId === altDragState.pointerId) {
      altDragState = null;
      controls.enabled = true;
      if (historyReady) pushHistorySnapshot();
      return;
    }
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    dragState = null;
    controls.enabled = true;
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

  document.querySelectorAll("[data-svg-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = camera.position.distanceTo(controls.target);
      const f = btn.dataset.svgZoom === "in" ? 0.88 : 1.12;
      const nd = Math.min(controls.maxDistance, Math.max(controls.minDistance, d * f));
      camera.position.sub(controls.target).setLength(nd).add(controls.target);
      controls.update();
    });
  });

  document.querySelectorAll("[data-svg-pan]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const step = 0.35;
      const pan = new THREE.Vector3();
      const dir = btn.dataset.svgPan;
      if (dir === "left") pan.x = -step;
      else if (dir === "right") pan.x = step;
      else if (dir === "up") pan.z = -step;
      else if (dir === "down") pan.z = step;
      controls.target.add(pan);
      camera.position.add(pan);
      controls.update();
    });
  });

  document.querySelectorAll("[data-svg-reset]").forEach((btn) => btn.addEventListener("click", () => resetCameraView()));
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
  document.querySelectorAll("[data-svg-floorplan-clear]").forEach((btn) => {
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
        pushPtr();
        pendingFloorplanDrag = { floorPlanId, sourceCard: fpCard, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, didDrag: false, ghostEl: null };
        window.addEventListener("pointermove", onFpMove, { passive: true });
        window.addEventListener("pointerup", endFpDrag);
        window.addEventListener("pointercancel", endFpDrag);
      }
    },
    true,
  );

  function projectToSvgLayout(project) {
    const inst = project?.furnitureInstances;
    if (!Array.isArray(inst)) return [];
    return inst
      .map((fi) => {
        const pc = Array.isArray(fi.positionCm) && fi.positionCm.length >= 2 ? fi.positionCm : null;
        return {
          model: String(fi.furnitureId ?? fi.modelId ?? "").trim(),
          floorId: fi?.floorId != null && String(fi.floorId).trim() ? String(fi.floorId).trim() : "floor1",
          x: pc ? Math.round(Number(pc[0]) || 0) : 0,
          y: pc ? Math.round(Number(pc[1]) || 0) : 0,
          rotation: Math.round(Number(fi.rotationDeg ?? fi.rotation ?? 0) || 0),
        };
      })
      .filter((row) => row.model);
  }

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

  async function applyFromDesignProject(project) {
    if (!project || typeof project !== "object") return;
    const gridWasVisible = gridVisible;
    const se = project.svgEditor;
    const hasSvgEditor = se && typeof se === "object" && Number(se.version) === 1;
    const layout = hasSvgEditor && Array.isArray(se.furniture)
      ? normalizeSavedFurnitureLayout(se.furniture)
      : projectToSvgLayout(project);

    let fpId = null;
    let floorLevelIndex = 0;
    if (hasSvgEditor && Object.prototype.hasOwnProperty.call(se, "floorPlanId")) {
      const v = se.floorPlanId;
      fpId = v != null && String(v).trim() ? String(v).trim() : null;
      const lv = Math.trunc(Number(se.floorLevelIndex));
      if (Number.isFinite(lv) && lv >= 0) floorLevelIndex = lv;
    } else {
      const t = project.templateId;
      fpId = t != null && String(t).trim() ? String(t).trim() : null;
      const floorIdToIndex = new Map(
        getFloorsFromEntry(window.__floorPlanCatalog?.byId instanceof Map ? window.__floorPlanCatalog.byId.get(fpId) : null).map(
          (f, i) => [String(f?.id || ""), i],
        ),
      );
      const fromActive = String(project?.activeFloorId ?? "").trim();
      if (fromActive && floorIdToIndex.has(fromActive)) floorLevelIndex = floorIdToIndex.get(fromActive) ?? 0;
    }

    isRestoring = true;
    try {
      // 恢复风格键（若有）；再恢复各风格的 surfaceOverrides
      if (hasSvgEditor && Object.prototype.hasOwnProperty.call(se, "floorplanStyleKey")) {
        const sk = se.floorplanStyleKey;
        floorplanStyleKeyOverride = sk != null && String(sk).trim() ? String(sk).trim() : null;
      } else {
        floorplanStyleKeyOverride = null;
      }
      if (hasSvgEditor && se.surfaceOverridesByStyleKey && typeof se.surfaceOverridesByStyleKey === "object") {
        const raw = JSON.parse(JSON.stringify(se.surfaceOverridesByStyleKey));
        const next = {};
        for (const [sk, bucket] of Object.entries(raw)) {
          if (!bucket || typeof bucket !== "object") continue;
          next[normalizeStyleKeyForSurfaceOverrides(sk)] = migrateFloorplanSurfaceOverridesBucket(bucket);
        }
        floorplanSurfaceOverridesByStyleKey = next;
      } else {
        const legacyBucket = migrateFloorplanSurfaceOverridesBucket(
          hasSvgEditor && se.surfaceOverrides && typeof se.surfaceOverrides === "object"
            ? JSON.parse(JSON.stringify(se.surfaceOverrides))
            : {},
        );
        const sk = normalizeStyleKeyForSurfaceOverrides(floorplanStyleKeyOverride);
        floorplanSurfaceOverridesByStyleKey = Object.keys(legacyBucket).length ? { [sk]: legacyBucket } : {};
      }
      if (fpId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
        if (entry) {
          await applyFloorplanEntryAtWorld(entry, undefined, undefined, {
            floorIndex: floorLevelIndex,
            preserveStyleKeyOverride: true,
            preserveSurfaceOverrides: true,
            skipDecorFromStyleMerge: true,
          });
        } else clearFloorplan();
      } else clearFloorplan();
      await rebuildFromLayout(layout);
      resetCameraView();
      setGridVisible(gridWasVisible);
      if (hasSvgEditor && se.lightingConfig && typeof se.lightingConfig === "object") {
        window.svgEditorApplyLightingConfig(se.lightingConfig);
      }
    } finally {
      isRestoring = false;
    }
    selectFurniture(null);
    initHistory();
    historyReady = true;
    window.__designLayoutBaseline = serializeDesignBaseline();
    emitLayoutChanged();
    window.__selectFloorplanLibraryCardById?.(fpId || "");
  }

  async function applyExternalLayout(layout, options = {}) {
    isRestoring = true;
    try {
      await rebuildFromLayout(Array.isArray(layout) ? layout : []);
    } finally {
      isRestoring = false;
    }
    selectFurniture(null);
    initHistory();
    historyReady = true;
    window.__designLayoutBaseline =
      typeof options.designLayoutBaseline === "string" ? options.designLayoutBaseline : serializeDesignBaseline();
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
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
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

    const v = payload.view;
    if (v && Number.isFinite(Number(v.tx)) && Number.isFinite(Number(v.ty)) && Number.isFinite(Number(v.scale))) {
      setViewTransform(v);
    }
    if (typeof payload.gridVisible === "boolean") setGridVisible(payload.gridVisible);

    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = null;

    const layout = Array.isArray(payload.furnitureLayout) ? payload.furnitureLayout : [];
    const uh = payload.undoHistory;

    if (isValidUndoHistoryPayload(uh)) {
      let entries = uh.entries.slice();
      let idx = Math.trunc(Number(uh.index));
      if (entries.length > MAX_HISTORY) {
        const drop = entries.length - MAX_HISTORY;
        entries = entries.slice(drop);
        idx -= drop;
      }
      if (idx < 0 || idx >= entries.length) {
        isRestoring = true;
        try {
          await applyFloorplanByPayload();
        } finally {
          isRestoring = false;
        }
        await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        if (payload.lightingConfig) window.svgEditorApplyLightingConfig(payload.lightingConfig);
        return;
      }
      historyReady = false;
      isRestoring = true;
      history.splice(0, history.length, ...entries);
      historyIndex = idx;
      try {
        const state = normalizeHistorySnapshot(JSON.parse(history[historyIndex]));
        if (!state) throw new Error("bad");
        await applyHistorySnapshotState(state);
      } catch {
        historyReady = true;
        isRestoring = true;
        try {
          await applyFloorplanByPayload();
        } finally {
          isRestoring = false;
        }
        await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        if (payload.lightingConfig) window.svgEditorApplyLightingConfig(payload.lightingConfig);
        return;
      }
      isRestoring = false;
      selectFurniture(null);
      historyReady = true;
      window.__designLayoutBaseline =
        typeof payload.designLayoutBaseline === "string" ? payload.designLayoutBaseline : serializeDesignBaseline();
      if (undoBtn) undoBtn.disabled = historyIndex <= 0;
      if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
      if (payload.lightingConfig) window.svgEditorApplyLightingConfig(payload.lightingConfig);
      emitLayoutChanged();
    } else {
      isRestoring = true;
      try {
        await applyFloorplanByPayload();
      } finally {
        isRestoring = false;
      }
      await applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
      if (payload.lightingConfig) window.svgEditorApplyLightingConfig(payload.lightingConfig);
    }
  }

  window.addEventListener("visionhome:design-select", (e) => {
    const project = e.detail?.project;
    if (project) void applyFromDesignProject(project);
  });
  window.addEventListener("visionhome:design-new", () => {
    clearFloorplan();
    void applyExternalLayout([]);
  });

  /**
   * 是否存在「户型需按半透明处理」的楼层（非 1 不透明）：此时用分层渲染（深度预写入 + 颜色）稳定遮挡。
   * 注意：多遍合成会让整幅画面偏暗，易被误认为环境光变弱。以下情况不要走多遍：
   * - 仅调当前层透明度（见上条提交）；
   * - 再次点击当前楼层 Tab 取消选中（floorSelectionEnabled=false）：单层户型时全层 0.2 透明度，若再用「非楼层选中」单独触发多遍，会不必要地压暗画面；多层叠显且其它层半透明由下一条判断覆盖。
   * 多遍仅保留：多层同时可见且其它层为半透明（与 hideOtherFloors / otherLayersOpacity 一致）等真正需要稳定排序的情形。
   */
  function floorplanNeedsTranslucentPass() {
    if (!floorplanRoot.children.length) return false;
    const floors = getFloorsFromEntry(currentFloorplanEntry);
    const n = floors?.length ?? 0;
    if (n > 1 && !hideOtherFloors && otherLayersOpacity < 1 - 1e-4) return true;
    return false;
  }

  /**
   * 窗玻璃、玻璃门扇等「应透视后方」的 mesh 不参与深度预写入：否则 MeshDepthMaterial 在玻璃表面写入深度，
   * 第三遍里室内墙等更远半透明片深度测试失败，透过窗洞看不见室内。
   */
  function skipFloorplanDepthPrepassMesh(obj) {
    if (obj.userData.floorplanWindowFill) return true;
    if (obj.userData.floorplanDoorFill && obj.userData.floorplanDoorStyle?.isGlass) return true;
    const m = obj.material;
    const mats = Array.isArray(m) ? m : m ? [m] : [];
    for (let i = 0; i < mats.length; i++) {
      const sub = mats[i];
      if (sub?.isMeshPhysicalMaterial && Number(sub.transmission) > 0.02) return true;
    }
    return false;
  }

  /**
   * 分层渲染：先画家具+网格（不含户型），再仅对户型做深度预写入（不写颜色），最后画户型半透明颜色。
   * 用 visible 排除户型/家具；多遍 render 时须暂时去掉 scene.background（Color）：
   * Three.js WebGLBackground 在 background 为 Color 时会 forceClear，无视 autoClear=false，会整屏清空抹掉第一遍。
   */
  function renderEditorScene() {
    const prevAutoClear = renderer.autoClear;
    const prevBackground = scene.background;
    try {
      if (!floorplanNeedsTranslucentPass()) {
        renderer.autoClear = true;
        renderer.render(scene, camera);
        return;
      }
      const saved = [];
      renderer.autoClear = true;
      floorplanRoot.visible = false;
      renderer.render(scene, camera);
      floorplanRoot.visible = true;
      furnitureRoot.visible = false;
      grid.visible = false;
      renderer.autoClear = false;
      scene.background = null;
      floorplanRoot.traverse((obj) => {
        if (!obj.isMesh || obj.isSkinnedMesh) return;
        if (skipFloorplanDepthPrepassMesh(obj)) return;
        saved.push({ obj, material: obj.material });
        obj.material = floorplanDepthPrepassMat;
      });
      renderer.render(scene, camera);
      for (let i = 0; i < saved.length; i++) {
        saved[i].obj.material = saved[i].material;
      }
      renderer.render(scene, camera);
    } finally {
      renderer.autoClear = prevAutoClear;
      scene.background = prevBackground;
      furnitureRoot.visible = true;
      grid.visible = gridVisible;
      floorplanRoot.visible = true;
    }
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    // 让主光随相机方位变化：用户旋转视角时，墙体/家具阴影也会有明显变化
    tmpVecA.copy(controls.target);
    tmpVecB.copy(camera.position).sub(tmpVecA);
    // 仅使用水平朝向，避免俯仰导致光线跳变
    const lenXZ = Math.hypot(tmpVecB.x, tmpVecB.z);
    if (lenXZ > 1e-6) {
      tmpVecC.set(tmpVecB.x / lenXZ, 0, tmpVecB.z / lenXZ);
      const LIGHT_RADIUS = 26;
      const LIGHT_HEIGHT = 30;
      // 从相机前方斜射向目标，旋转视角时阴影方向跟随变化
      dirLight.position.set(
        tmpVecA.x + tmpVecC.x * LIGHT_RADIUS,
        LIGHT_HEIGHT,
        tmpVecA.z + tmpVecC.z * LIGHT_RADIUS,
      );
      dirLight.target.position.set(tmpVecA.x, 0, tmpVecA.z);
      dirLight.target.updateMatrixWorld();
    }
    dirLight.updateMatrixWorld(true);
    fitDirectionalShadowFrustum();
    renderEditorScene();
  }

  window.addEventListener("resize", resizeRenderer);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeRenderer).observe(container);

  function threeColorToHexForStylePack(c) {
    if (!c?.getHexString) return "#ffffff";
    return `#${c.getHexString()}`;
  }

  function getSceneLightingForStylePack() {
    return {
      toneMappingExposure: renderer.toneMappingExposure,
      ambient: {
        color: threeColorToHexForStylePack(ambientLight.color),
        intensity: ambientLight.intensity,
      },
      hemisphere: {
        sky: threeColorToHexForStylePack(hemiLight.color),
        ground: threeColorToHexForStylePack(hemiLight.groundColor),
        intensity: hemiLight.intensity,
      },
      directional: {
        color: threeColorToHexForStylePack(dirLight.color),
        intensity: dirLight.intensity,
      },
      envMapIntensity: sceneLightingEnvMapIntensity,
    };
  }

  function stripLibraryMetaFromMaterials(materials) {
    if (!materials || typeof materials !== "object") return {};
    const out = JSON.parse(JSON.stringify(materials));
    for (const k of Object.keys(out)) {
      const m = out[k];
      if (m && typeof m === "object" && !Array.isArray(m)) delete m.__libraryMaterialId;
    }
    return out;
  }

  function slugStyleKeyFromName(name) {
    let s = String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_-]/g, "");
    if (!s) s = `style_${Date.now()}`;
    if (!/^[a-z_]/.test(s)) s = `s_${s}`;
    return s.slice(0, 48);
  }

  function ensureUniqueStyleKeyInPack(base, stylesObj) {
    if (!stylesObj || typeof stylesObj !== "object") return base;
    let k = base;
    let n = 0;
    while (stylesObj[k]) {
      n += 1;
      k = `${base}_${n}`;
    }
    return k;
  }

  function jsonEqual(a, b) {
    try {
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    } catch {
      return false;
    }
  }

  function diffMappingAgainstBase(nextMapping, baseMapping) {
    const next = nextMapping && typeof nextMapping === "object" ? nextMapping : {};
    const base = baseMapping && typeof baseMapping === "object" ? baseMapping : {};
    const out = {};
    for (const bucketKey of ["rooms", "walls", "doors", "windows"]) {
      const n = next[bucketKey] && typeof next[bucketKey] === "object" ? next[bucketKey] : {};
      const b = base[bucketKey] && typeof base[bucketKey] === "object" ? base[bucketKey] : {};
      const diff = {};
      for (const [k, v] of Object.entries(n)) {
        if (!jsonEqual(v, b[k])) diff[k] = v;
      }
      if (Object.keys(diff).length) out[bucketKey] = diff;
    }
    return Object.keys(out).length ? out : null;
  }

  function collectMaterialKeysFromMapping(mapping) {
    const keys = new Set();
    if (!mapping || typeof mapping !== "object") return keys;
    const walls = mapping.walls && typeof mapping.walls === "object" ? mapping.walls : {};
    const doors = mapping.doors && typeof mapping.doors === "object" ? mapping.doors : {};
    const windows = mapping.windows && typeof mapping.windows === "object" ? mapping.windows : {};
    for (const v of Object.values(walls)) if (typeof v === "string" && v.trim()) keys.add(v.trim());
    for (const v of Object.values(doors)) if (typeof v === "string" && v.trim()) keys.add(v.trim());
    for (const v of Object.values(windows)) if (typeof v === "string" && v.trim()) keys.add(v.trim());
    const rooms = mapping.rooms && typeof mapping.rooms === "object" ? mapping.rooms : {};
    for (const rv of Object.values(rooms)) {
      if (!rv || typeof rv !== "object") continue;
      if (typeof rv.floor === "string" && rv.floor.trim()) keys.add(rv.floor.trim());
      if (typeof rv.wall === "string" && rv.wall.trim()) keys.add(rv.wall.trim());
    }
    return keys;
  }

  function diffMaterialsForMapping(nextMaterials, baseMaterials, mappingDiff) {
    const next = nextMaterials && typeof nextMaterials === "object" && !Array.isArray(nextMaterials) ? nextMaterials : {};
    const base = baseMaterials && typeof baseMaterials === "object" && !Array.isArray(baseMaterials) ? baseMaterials : {};
    const need = collectMaterialKeysFromMapping(mappingDiff);
    const out = {};
    for (const k of need) {
      if (next[k] === undefined) continue;
      if (!jsonEqual(next[k], base[k])) out[k] = next[k];
    }
    return Object.keys(out).length ? stripLibraryMetaFromMaterials(out) : null;
  }

  function buildStyleBlockDiffFromBaseForPack(styleKey, displayName, styleObj, baseStyleObj, baseKey) {
    const layout = getLayout();
    const placements = [];
    for (const row of layout) {
      if (!modelIdIsDecoration(row.model)) continue;
      const p = { model: row.model, x: row.x, y: row.y, rotation: row.rotation ?? 0 };
      if (row.floorId) p.floorId = row.floorId;
      if (row.decorationLiftCm != null) p.decorationLiftCm = row.decorationLiftCm;
      placements.push(p);
    }

    const baseLighting = baseStyleObj?.sceneLighting;
    const nextLighting = getSceneLightingForStylePack();
    const mappingDiff = diffMappingAgainstBase(styleObj?.mapping, baseStyleObj?.mapping);
    const materialsDiff = mappingDiff
      ? diffMaterialsForMapping(styleObj?.materials, baseStyleObj?.materials, mappingDiff)
      : null;

    const block = {
      id: styleKey,
      name: displayName,
      extends: baseKey,
      decorations: { placements },
    };
    if (!jsonEqual(nextLighting, baseLighting)) block.sceneLighting = nextLighting;
    if (mappingDiff) block.mapping = mappingDiff;
    if (materialsDiff) block.materials = materialsDiff;
    return block;
  }

  function buildStyleBlockFromSceneForPack(styleKey, displayName, styleObj) {
    const materials = stripLibraryMetaFromMaterials(styleObj?.materials);
    const layout = getLayout();
    const placements = [];
    for (const row of layout) {
      if (!modelIdIsDecoration(row.model)) continue;
      const p = {
        model: row.model,
        x: row.x,
        y: row.y,
        rotation: row.rotation ?? 0,
      };
      if (row.floorId) p.floorId = row.floorId;
      if (row.decorationLiftCm != null) p.decorationLiftCm = row.decorationLiftCm;
      placements.push(p);
    }
    return {
      id: styleKey,
      name: displayName,
      sceneLighting: getSceneLightingForStylePack(),
      materials,
      decorations: { placements },
    };
  }

  /**
   * 将「面板覆盖」烘焙进风格包：生成/覆盖 style.materials 并写入 style.mapping（按房间/墙/门/窗 id）。
   * 不在风格包中存 surfaceOverrides 字段，避免与 style 本体重复表达。
   * @param {object | null} styleObj loadStyleConfig 返回的单套风格
   * @param {Record<string, any> | null | undefined} overridesBucket 当前风格下的 surfaceOverrides bucket（按楼层 id）
   * @param {object | null} entry 当前户型 entry（含 floors/rooms/walls/doors/windows）
   * @param {Record<string, object>} libraryBag 材质库（含 style.materials 合并后的 bag）
   */
  function bakeSurfaceOverridesIntoStyle(styleObj, overridesBucket, entry, libraryBag) {
    if (!styleObj || typeof styleObj !== "object") return styleObj;
    if (!overridesBucket || typeof overridesBucket !== "object") return styleObj;
    if (!entry || typeof entry !== "object") return styleObj;
    const floors = getFloorsFromEntry(entry);
    if (!floors.length) return styleObj;

    let next;
    try {
      next = JSON.parse(JSON.stringify(styleObj));
    } catch {
      next = { ...styleObj };
    }

    if (!next.materials || typeof next.materials !== "object" || Array.isArray(next.materials)) {
      next.materials = {};
    }
    if (!next.mapping || typeof next.mapping !== "object" || Array.isArray(next.mapping)) {
      next.mapping = {};
    }
    if (!next.mapping.rooms || typeof next.mapping.rooms !== "object" || Array.isArray(next.mapping.rooms)) {
      next.mapping.rooms = {};
    }
    if (!next.mapping.walls || typeof next.mapping.walls !== "object" || Array.isArray(next.mapping.walls)) {
      next.mapping.walls = {};
    }
    if (!next.mapping.doors || typeof next.mapping.doors !== "object" || Array.isArray(next.mapping.doors)) {
      next.mapping.doors = {};
    }
    if (!next.mapping.windows || typeof next.mapping.windows !== "object" || Array.isArray(next.mapping.windows)) {
      next.mapping.windows = {};
    }

    function safeBakeKey(s) {
      return String(s ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "_")
        .slice(0, 64);
    }

    /**
     * @param {string} floorLevelId
     * @param {"allWalls"|"allFloors"|"allDoors"|"allWindows"} scope
     * @param {SurfaceScopeOverride} ovRaw
     * @returns {string | null} baked material key
     */
    function bakeOneScopeMaterialKey(floorLevelId, scope, ovRaw) {
      if (!surfaceOverrideIsActive(ovRaw)) return null;
      const ov = scope === "allWindows" ? windowSurfaceOverrideForApply(ovRaw) : ovRaw;
      if (!ov || !surfaceOverrideIsActive(ov)) return null;

      let baseDef = null;
      if (ov.materialId) {
        baseDef = resolveMaterialDefFromLibrary(libraryBag, ov.materialId);
      } else {
        // 沿风格包解析当前 scope 的基准材质（取本层第一个元素）
        const sel = { floorLevelId };
        let k = "";
        if (scope === "allFloors" || scope === "allWalls") {
          k = resolveStyleMaterialKeyForSurfaceScope(sel, scope === "allFloors" ? "allFloors" : "allWalls", next);
        } else if (scope === "allDoors") {
          k = resolveStyleMaterialKeyForDoorScope(sel, next);
        } else if (scope === "allWindows") {
          k = resolveStyleMaterialKeyForWindowScope(sel, next);
        }
        if (k) {
          const def = getMaterialDef(next, k);
          if (def) {
            try {
              baseDef = JSON.parse(JSON.stringify(def));
            } catch {
              baseDef = { ...def };
            }
          }
        }
      }
      if (!baseDef) return null;

      const mergedDef = mergeMaterialOverrideIntoDef(baseDef, ov);
      const bakedKey = `baked_${safeBakeKey(floorLevelId)}_${scope}`;
      next.materials[bakedKey] = mergedDef;
      return bakedKey;
    }

    for (const [fidRaw, bag] of Object.entries(overridesBucket)) {
      if (!bag || typeof bag !== "object") continue;
      const fid = String(fidRaw ?? "").trim();
      if (!fid) continue;
      const want = normalizeFloorKey(fid);
      const fl = floors.find((f) => normalizeFloorKey(f?.id ?? "") === want) ?? null;
      if (!fl) continue;

      if (bag.allFloors) {
        const key = bakeOneScopeMaterialKey(fid, "allFloors", bag.allFloors);
        if (key) {
          for (const room of fl.rooms || []) {
            const rid = String(room?.id ?? "").trim();
            if (!rid) continue;
            const prev = next.mapping.rooms[rid];
            const obj = prev && typeof prev === "object" && !Array.isArray(prev) ? { ...prev } : {};
            obj.floor = key;
            next.mapping.rooms[rid] = obj;
          }
        }
      }
      if (bag.allWalls) {
        const key = bakeOneScopeMaterialKey(fid, "allWalls", bag.allWalls);
        if (key) {
          for (const w of fl.walls || []) {
            const wid = String(w?.id ?? "").trim();
            if (!wid) continue;
            next.mapping.walls[wid] = key;
          }
        }
      }
      if (bag.allDoors) {
        const key = bakeOneScopeMaterialKey(fid, "allDoors", bag.allDoors);
        if (key) {
          for (const d of fl.doors || []) {
            const did = String(d?.id ?? "").trim();
            if (!did) continue;
            next.mapping.doors[did] = key;
          }
        }
      }
      if (bag.allWindows) {
        const key = bakeOneScopeMaterialKey(fid, "allWindows", bag.allWindows);
        if (key) {
          for (const win of fl.windows || []) {
            const wid = String(win?.id ?? "").trim();
            if (!wid) continue;
            next.mapping.windows[wid] = key;
          }
        }
      }
    }

    return next;
  }

  /**
   * 读取 `./assets/floorplans/style/{floorplanId}.json` 全量内容。
   * 当前编辑 apt 户型时即 `apt_2b1l_compact_01.json`。
   * @param {string} fpId 户型 id（与 JSON 文件名一致）
   */
  async function fetchRawFloorplanStylePack(fpId) {
    const url = `./${DATA_PATHS.stylesDir}/${fpId}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`无法读取风格包 (${res.status})`);
    return res.json();
  }

  /** 保存前深拷贝整包，避免与运行时缓存等共享引用；仅改 styles[当前键] 时不应影响其它风格条目 */
  function cloneStylePackDeep(pack) {
    try {
      return JSON.parse(JSON.stringify(pack));
    } catch {
      return pack;
    }
  }

  /**
   * 写回前保证根级 floorplanId 与 JSON 文件名一致；保留 mapping、defaultStyleKey、styles 中其它条目。
   * @param {string} fpId
   * @param {object} pack
   */
  function normalizeStylePackRootForDisk(fpId, pack) {
    if (!pack || typeof pack !== "object") return;
    pack.floorplanId = fpId;
    if (!pack.styles || typeof pack.styles !== "object") pack.styles = {};
  }

  /**
   * POST 整文件写入 `assets/floorplans/style/{floorplanId}.json`（需 dev_server）。
   * @param {string} fpId
   * @param {object} pack 完整装饰包（含 mapping、defaultStyleKey、styles 等）
   */
  async function postFloorplanStylePackSave(fpId, pack) {
    normalizeStylePackRootForDisk(fpId, pack);
    const res = await fetch(DATA_PATHS.floorplanStyleSaveApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floorplanId: fpId, pack }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || `保存失败 (${res.status})，请使用 python3 dev_server.py 启动本地服务`);
    }
    return res.json();
  }

  function initStylePackSaveDialogs() {
    const overwriteBtn = document.getElementById("svgStyleOverwriteBtn");
    const newBtn = document.getElementById("svgStyleNewBtn");
    const dlgOver = document.getElementById("styleOverwriteDialog");
    const dlgNew = document.getElementById("styleNewDialog");
    const msgOver = document.getElementById("styleOverwriteMessage");
    const inpName = document.getElementById("styleNewNameInput");
    const errNew = document.getElementById("styleNewNameError");

    function syncOverwriteBtnLockState() {
      if (!overwriteBtn) return;
      const fpId = getCurrentFloorplanId();
      const cur = getEffectiveFloorplanStyleKey();
      const def = fpId ? getDefaultStyleKeyForFloorplan(fpId) : "";
      const locked = !!(fpId && cur && def && cur === def);
      overwriteBtn.disabled = locked;
      overwriteBtn.title = locked ? "默认风格不可覆盖" : "覆盖当前风格";
      overwriteBtn.setAttribute("aria-label", overwriteBtn.title);
    }

    async function resolveStyleDisplayName(fpId, sk) {
      try {
        const idx = await loadStylePackIndex(fpId);
        const hit = idx.styles.find((s) => s.key === sk);
        if (hit?.name) return String(hit.name).trim();
      } catch {
        /* ignore */
      }
      return sk;
    }

    overwriteBtn?.addEventListener("click", async () => {
      const fpId = getCurrentFloorplanId();
      if (!fpId || !currentFloorplanEntry) {
        alert("请先加载户型。");
        return;
      }
      if (!lastMergedFloorplanStyle) {
        alert("当前风格包未成功加载，无法覆盖。");
        return;
      }
      const sk = getEffectiveFloorplanStyleKey();
      try {
        const pack = await fetchRawFloorplanStylePack(fpId);
        const defKey = resolveDefaultStyleKeyFromPack(pack);
        if (defKey && sk === defKey) {
          alert("默认风格不可覆盖。请新建风格后再保存。");
          syncOverwriteBtnLockState();
          return;
        }
      } catch {
        // ignore: 仅用于阻止默认风格覆盖；读取失败则继续走现有覆盖流程
      }
      const name = await resolveStyleDisplayName(fpId, sk);
      if (msgOver) msgOver.textContent = `将用当前场景的光照、材质与装饰覆盖风格「${name}」（${sk}）。确定吗？`;
      dlgOver?.showModal();
    });

    document.getElementById("styleOverwriteCancel")?.addEventListener("click", () => dlgOver?.close());
    document.getElementById("styleOverwriteConfirm")?.addEventListener("click", async () => {
      dlgOver?.close();
      const fpId = getCurrentFloorplanId();
      const sk = getEffectiveFloorplanStyleKey();
      if (!fpId || !lastMergedFloorplanStyle) return;
      try {
        const pack = cloneStylePackDeep(await fetchRawFloorplanStylePack(fpId));
        const defKey = resolveDefaultStyleKeyFromPack(pack);
        if (defKey && sk === defKey) {
          alert("默认风格不可覆盖。请使用“新建”创建一个新风格后再保存。");
          syncOverwriteBtnLockState();
          return;
        }
        const displayName = await resolveStyleDisplayName(fpId, sk);
        const surfaceOverridesBucket = getSurfaceOverridesBucketForStyle(sk, { create: false });
        const libraryBag = await getFloorplanMaterialsLibraryBag();
        const bakedStyle = bakeSurfaceOverridesIntoStyle(lastMergedFloorplanStyle, surfaceOverridesBucket, currentFloorplanEntry, libraryBag);
        const block = buildStyleBlockFromSceneForPack(sk, displayName, bakedStyle);
        if (!pack.styles || typeof pack.styles !== "object") pack.styles = {};
        // 仅替换当前键；其它 styles.* 保持从文件读出时的快照
        pack.styles[sk] = block;
        await postFloorplanStylePackSave(fpId, pack);
        clearStyleConfigCache();
        await loadStylePackIndex(fpId);
        await rebuildFloorplan3D();
        window.dispatchEvent(new CustomEvent("visionhome:floorplan-applied-to-svg"));
        if (historyReady) schedulePushHistory();
        syncOverwriteBtnLockState();
      } catch (e) {
        console.error(e);
        alert(e?.message || String(e));
      }
    });

    newBtn?.addEventListener("click", () => {
      const fpId = getCurrentFloorplanId();
      if (!fpId || !currentFloorplanEntry) {
        alert("请先加载户型。");
        return;
      }
      if (!lastMergedFloorplanStyle) {
        alert("当前风格包未成功加载，无法新建。");
        return;
      }
      if (inpName) inpName.value = "";
      if (errNew) {
        errNew.hidden = true;
        errNew.textContent = "";
      }
      dlgNew?.showModal();
      inpName?.focus();
    });

    document.getElementById("styleNewCancel")?.addEventListener("click", () => dlgNew?.close());
    document.getElementById("styleNewConfirm")?.addEventListener("click", async () => {
      const raw = String(inpName?.value ?? "").trim();
      if (!raw) {
        if (errNew) {
          errNew.textContent = "请输入风格名称";
          errNew.hidden = false;
        }
        return;
      }
      if (errNew) errNew.hidden = true;
      dlgNew?.close();
      const fpId = getCurrentFloorplanId();
      if (!fpId || !lastMergedFloorplanStyle) return;
      try {
        const sourceStyleKey = getEffectiveFloorplanStyleKey();
        const pack = cloneStylePackDeep(await fetchRawFloorplanStylePack(fpId));
        const styles = pack.styles && typeof pack.styles === "object" ? pack.styles : {};
        const base = slugStyleKeyFromName(raw);
        const newKey = ensureUniqueStyleKeyInPack(base, styles);
        const defKey = resolveDefaultStyleKeyFromPack(pack) || (fpId ? getDefaultStyleKeyForFloorplan(fpId) : "") || "default";
        const baseStyleObj = await loadStyleConfig(fpId, defKey);
        const surfaceOverridesBucket = getCurrentSurfaceOverridesBucket();
        const libraryBag = await getFloorplanMaterialsLibraryBag();
        const bakedStyle = bakeSurfaceOverridesIntoStyle(lastMergedFloorplanStyle, surfaceOverridesBucket, currentFloorplanEntry, libraryBag);
        const block = buildStyleBlockDiffFromBaseForPack(newKey, raw, bakedStyle, baseStyleObj, defKey);
        styles[newKey] = block;
        pack.styles = styles;
        // 在已有 styles 上追加新键，不改动其它风格条目
        await postFloorplanStylePackSave(fpId, pack);

        // “新建”语义：把当前场景保存为新风格，但不应污染源风格的临时 overrides。
        // 新风格已写入磁盘，因此也不需要把旧 overrides 继续叠加到新风格上。
        clearSurfaceOverridesForStyle(sourceStyleKey);
        clearSurfaceOverridesForStyle(newKey);

        floorplanStyleKeyOverride = newKey;
        clearStyleConfigCache();
        await loadStylePackIndex(fpId);
        await rebuildFloorplan3D();
        window.dispatchEvent(new CustomEvent("visionhome:floorplan-applied-to-svg"));
        if (historyReady) schedulePushHistory();
        syncOverwriteBtnLockState();
      } catch (e) {
        console.error(e);
        alert(e?.message || String(e));
      }
    });

    window.addEventListener("visionhome:floorplan-applied-to-svg", () => syncOverwriteBtnLockState());
    syncOverwriteBtnLockState();
  }

  function initFloorplanStyleToolbar() {
    const btn = document.getElementById("svgStyleRecommendBtn");
    const dropdown = document.getElementById("svgStyleDropdown");
    if (!btn || !dropdown) return;

    /** 防止多次并发 refresh 在 await 后重复 append 风格按钮 */
    let styleDropdownRefreshGen = 0;

    function openDropdown() {
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

    const STYLE_BTN_DEFAULT = "风格";

    function setStyleToolbarButtonLabel(list) {
      const cur = getEffectiveFloorplanStyleKey();
      if (!list || !list.length) {
        btn.textContent = STYLE_BTN_DEFAULT;
        btn.title = "装饰风格";
        btn.setAttribute("aria-label", "装饰风格");
        return;
      }
      const hit = list.find((s) => s.key === cur);
      const label = hit?.name ? String(hit.name).trim() : cur || STYLE_BTN_DEFAULT;
      btn.textContent = label || STYLE_BTN_DEFAULT;
      const tip = `装饰风格：${btn.textContent}`;
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
    }

    async function refreshStyleDropdown() {
      const gen = ++styleDropdownRefreshGen;
      dropdown.replaceChildren();
      const fpId = getCurrentFloorplanId();
      if (!fpId) {
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "svg-style-dropdown-hint";
        hint.textContent = "请先加载户型";
        dropdown.appendChild(hint);
        return;
      }
      let list;
      try {
        const idx = await loadStylePackIndex(fpId);
        if (gen !== styleDropdownRefreshGen) return;
        list = idx.styles;
      } catch (err) {
        console.warn("[VisionHome] 风格列表加载失败:", err);
        if (gen !== styleDropdownRefreshGen) return;
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "svg-style-dropdown-hint";
        hint.textContent = "风格列表加载失败";
        dropdown.appendChild(hint);
        return;
      }
      if (!list.length) {
        if (gen !== styleDropdownRefreshGen) return;
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "svg-style-dropdown-hint";
        hint.textContent = "暂无装饰风格";
        dropdown.appendChild(hint);
        return;
      }
      const seenKeys = new Set();
      const deduped = [];
      for (const s of list) {
        const k = String(s?.key ?? "").trim();
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        deduped.push(s);
      }
      if (gen !== styleDropdownRefreshGen) return;
      const cur = getEffectiveFloorplanStyleKey();
      for (const s of deduped) {
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "svg-style-tag";
        tag.setAttribute("role", "menuitem");
        tag.dataset.styleKey = s.key;
        tag.textContent = s.name;
        if (s.key === cur) tag.classList.add("is-active");
        dropdown.appendChild(tag);
      }
      setStyleToolbarButtonLabel(deduped);
    }

    dropdown.addEventListener("click", (e) => {
      const tag = e.target.closest(".svg-style-tag");
      if (!tag) return;
      const key = String(tag.dataset.styleKey ?? "").trim();
      if (!key || !currentFloorplanEntry) return;
      floorplanStyleKeyOverride = key;
      const picked = String(tag.textContent ?? "").trim();
      if (picked) {
        btn.textContent = picked;
        const tip = `装饰风格：${picked}`;
        btn.title = tip;
        btn.setAttribute("aria-label", tip);
      }
      void rebuildFloorplan3D({ applyDecorFromStyle: true }).then(() => pushHistorySnapshot());
      closeDropdown();
    });

    window.addEventListener("visionhome:floorplan-applied-to-svg", () => {
      void refreshStyleDropdown();
    });
    void refreshStyleDropdown();
  }

  initFloorplanStyleToolbar();
  initStylePackSaveDialogs();

  function getCurrentLightingConfig() {
    return {
      toneMappingExposure: renderer.toneMappingExposure,
      ambient: { intensity: ambientLight.intensity },
      hemisphere: { intensity: hemiLight.intensity },
      directional: { intensity: dirLight.intensity },
      envMapIntensity: sceneLightingEnvMapIntensity,
    };
  }

  function applyLightingFromSliders() {
    const exposure = parseFloat(document.getElementById("svgLightingExposure")?.value ?? "0.88");
    const ambient = parseFloat(document.getElementById("svgLightingAmbient")?.value ?? "0.26");
    const hemi = parseFloat(document.getElementById("svgLightingHemi")?.value ?? "0.36");
    const dir = parseFloat(document.getElementById("svgLightingDir")?.value ?? "1.0");
    const env = parseFloat(document.getElementById("svgLightingEnv")?.value ?? "0.35");

    renderer.toneMappingExposure = exposure;
    ambientLight.intensity = ambient;
    hemiLight.intensity = hemi;
    dirLight.intensity = dir;
    sceneLightingEnvMapIntensity = env;

    document.getElementById("svgLightingExposureVal").textContent = exposure.toFixed(2);
    document.getElementById("svgLightingAmbientVal").textContent = ambient.toFixed(2);
    document.getElementById("svgLightingHemiVal").textContent = hemi.toFixed(2);
    document.getElementById("svgLightingDirVal").textContent = dir.toFixed(2);
    document.getElementById("svgLightingEnvVal").textContent = env.toFixed(2);
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

    const sliders = ["svgLightingExposure", "svgLightingAmbient", "svgLightingHemi", "svgLightingDir", "svgLightingEnv"];
    for (const id of sliders) {
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

  initLightingToolbar();

  window.svgEditorAddFurniture = addFurniture;
  window.svgEditorGetLayout = getLayout;
  window.svgEditorApplyFloorplanAtWorld = applyFloorplanEntryAtWorld;
  window.svgEditorClearFloorplan = clearFloorplan;
  window.svgEditorCommitSavedBaseline = () => {
    window.__designLayoutBaseline = serializeDesignBaseline();
    emitLayoutChanged();
  };
  window.svgEditorGetDesignBaselineFingerprint = serializeDesignBaseline;
  window.svgEditorGetViewSize = () => ({ width: VIEW_W, height: VIEW_H });
  window.svgEditorResetView = resetCameraView;
  window.svgEditorGetViewTransform = getViewTransform;
  window.svgEditorSetViewTransform = setViewTransform;
  window.svgEditorToggleGrid = () => setGridVisible(!gridVisible);
  window.svgEditorGetGridVisible = () => gridVisible;
  window.svgEditorSetGridVisible = setGridVisible;
  window.svgEditorToggleDimensions = () => setDimensionsVisible(!showDimensions);
  window.svgEditorSetDimensionsVisible = setDimensionsVisible;
  window.svgEditorToggleWallSnap = () => setWallSnapEnabled(!wallSnapEnabled);
  window.svgEditorSetWallSnapEnabled = setWallSnapEnabled;
  window.svgEditorGetWallSnapEnabled = () => wallSnapEnabled;
  window.svgEditorToggleShadows = () => setShadowsEnabled(!shadowsEnabled);
  window.svgEditorSetShadowsEnabled = setShadowsEnabled;
  window.svgEditorGetShadowsEnabled = () => shadowsEnabled;
  window.svgEditorGetLightingConfig = () => getCurrentLightingConfig();
  window.svgEditorApplyLightingConfig = (cfg) => {
    if (!cfg || typeof cfg !== "object") return;
    if (Number.isFinite(cfg.toneMappingExposure)) renderer.toneMappingExposure = cfg.toneMappingExposure;
    if (cfg.ambient && Number.isFinite(cfg.ambient.intensity)) ambientLight.intensity = cfg.ambient.intensity;
    if (cfg.hemisphere && Number.isFinite(cfg.hemisphere.intensity)) hemiLight.intensity = cfg.hemisphere.intensity;
    if (cfg.directional && Number.isFinite(cfg.directional.intensity)) dirLight.intensity = cfg.directional.intensity;
    if (Number.isFinite(cfg.envMapIntensity)) sceneLightingEnvMapIntensity = cfg.envMapIntensity;
    renderEditorScene();
  };

  document.getElementById("svgDimToggleBtn")?.addEventListener("click", () => setDimensionsVisible(!showDimensions));
  document.getElementById("svgWallSnapToggleBtn")?.addEventListener("click", () => setWallSnapEnabled(!wallSnapEnabled));
  document.getElementById("svgShadowToggleBtn")?.addEventListener("click", () => setShadowsEnabled(!shadowsEnabled));
  document.getElementById("svgNameToggleBtn")?.addEventListener("click", () => setNamesVisible(!showNames));
  window.svgEditorGetCurrentFloorplanId = getCurrentFloorplanId;
  window.svgEditorGetCurrentFloorLevelIndex = getCurrentFloorLevelIndex;
  window.svgEditorGetCurrentFloorId = getCurrentFloorId;
  window.svgEditorGetFloorplanStyleKey = getEffectiveFloorplanStyleKey;
  window.svgEditorRestoreSession = restoreEditorSession;
  window.svgEditorGetUndoHistory = () => ({ entries: [...history], index: historyIndex });
  window.svgEditorFlushHistoryDebounce = flushHistoryDebounce;
  // 新版：返回“按 styleKey 分桶”的覆盖（兼容多风格切换互不污染）
  window.svgEditorGetSurfaceOverrides = () => JSON.parse(JSON.stringify(floorplanSurfaceOverridesByStyleKey));
  window.svgEditorDeselect = () => {
    deselectVisualOnly();
    clearFloorplanSurfaceSelection();
    syncPropertiesPanelForSelection(null);
    floorplanSelected = false;
  };
  window.svgEditorApplyPropertiesFromPanel = applyPropertiesFromPanel;

  ensureFloorLevelControls();
  setGridVisible(false);
  rebuildFloorplan3D();
  resizeRenderer();
  resetCameraView();
  selectFurniture(null);
  initHistory();
  historyReady = true;
  window.__designLayoutBaseline = serializeDesignBaseline();
  emitLayoutChanged();
  animate();

  const okResult = { ok: true, reason: null, catalogSize: byId.size };
  window.__visionHomeSvgEditor = okResult;
  return okResult;
}
