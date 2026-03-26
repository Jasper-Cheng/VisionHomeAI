/**
 * 编辑模式 Three.js：户型挤出 + 家具交互，兼容 window.svgEditor* API
 */
import * as THREE from "three";
import { OrbitControls } from "../../assets/vendor/OrbitControls.js";
import { getFloorBBoxCm } from "../floorplan/floorplanSvg.js";
import { getFurnitureDisplayName } from "../furniture/furnitureManager.js";

const VIEW_W = 3000;
const VIEW_H = 3000;
const GRID = 1;
const FLOORPLAN_PAD = 80;
const FLOORPLAN_SIZE_FACTOR = 0.38;
const MAX_HISTORY = 80;
/** 户型墙体与地面挤出块统一颜色 */
const FLOORPLAN_SURFACE_COLOR = 0xe2e8f0;

function cmToSceneXZ(xCm, yCm) {
  return { x: (xCm - VIEW_W / 2) / 100, z: (yCm - VIEW_H / 2) / 100 };
}
function sceneXZToCm(x, z) {
  return { x: x * 100 + VIEW_W / 2, y: z * 100 + VIEW_H / 2 };
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 2;
  controls.maxDistance = 120;
  controls.update();

  const grid = new THREE.GridHelper(80, 80, 0x3b3b3b, 0x222222);
  grid.position.y = 0.001;
  scene.add(grid);
  // 略提高填充光，压低阴影对比，减轻地面/家具投影边缘的颗粒感
  scene.add(new THREE.AmbientLight(0xffffff, 0.22));
  scene.add(new THREE.HemisphereLight(0xdbeafe, 0x0b1220, 0.34));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(14, 24, 16);
  dir.castShadow = true;
  // 扩大阴影相机覆盖范围，避免多楼层/大户型时阴影被裁切
  dir.shadow.mapSize.set(4096, 4096);
  // 家具只投射、户型地面接收；bias 过高会导致“影离地”、过低易 acne，取折中
  dir.shadow.bias = 0.00015;
  dir.shadow.normalBias = 0.045;
  // PCF 软阴影半径略大，减轻阴影边缘“台阶感”
  dir.shadow.radius = 6;
  dir.shadow.camera.near = 0.1;
  dir.shadow.camera.far = 500;
  // left/right/top/bottom 每帧按场景包围盒在光照空间收紧，提高阴影贴图有效分辨率（减轻锯齿）
  dir.shadow.camera.left = -40;
  dir.shadow.camera.right = 40;
  dir.shadow.camera.top = 40;
  dir.shadow.camera.bottom = -40;
  dir.shadow.camera.updateProjectionMatrix();
  dir.target.position.set(0, 0, 0);
  scene.add(dir.target);
  scene.add(dir);

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
    shadowSceneBbox.makeEmpty();
    if (floorplanRoot.children.length) shadowSceneBbox.expandByObject(floorplanRoot);
    if (furnitureRoot.children.length) {
      const b2 = new THREE.Box3().setFromObject(furnitureRoot);
      if (shadowSceneBbox.isEmpty()) shadowSceneBbox.copy(b2);
      else shadowSceneBbox.union(b2);
    }
    if (shadowSceneBbox.isEmpty()) return;

    const cam = dir.shadow.camera;
    shadowFitCam.position.copy(dir.position);
    shadowFitCam.lookAt(dir.target.position);
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
  let currentFloorIndex = 0;
  let activeFloorId = null;
  let selectedGroup = null;
  let floorplanSelected = false;
  let dragState = null;
  const history = [];
  let historyIndex = -1;
  let historyReady = false;
  let isRestoring = false;
  let historyDebounceTimer = null;
  let gridVisible = false;
  let floorLevelDock = null;
  let floorLevelRow = null;
  // 楼层垂直偏移（场景单位：米）。key 对齐 furniture 的 floorId（如 "floor1"）。
  let floorYOffsetById = new Map();
  let floorElevationBaseCm = 0;
  function normalizeFloorKey(id) {
    return String(id ?? "").trim().toLowerCase();
  }

  const propertiesPanel = document.getElementById("propertiesPanel");
  const propertiesName = propertiesPanel?.querySelector(".properties-name");
  const propInputX = propertiesPanel?.querySelector('input[data-prop="x"]');
  const propInputZ = propertiesPanel?.querySelector('input[data-prop="z"]');
  const propInputRotY = propertiesPanel?.querySelector('input[data-prop="rotY"]');
  const undoBtn = document.querySelector("[data-svg-undo]");
  const redoBtn = document.querySelector("[data-svg-redo]");
  const gridToggleBtn = document.getElementById("svgGridToggleBtn");
  const floorHideOthersToggleBtn = document.querySelector("[data-svg-floor-hide-others-toggle]");
  // 快速操作：只显示当前楼层，其它楼层/家具隐藏
  let hideOtherFloors = false;
  const otherLayersOpacityWrap = document.getElementById("otherLayersOpacityWrap");
  const otherLayersOpacityRange = document.getElementById("otherLayersOpacityRange");
  // 其它楼层透明度（0~1），用于 rebuildFloorplan3D() 的非选中层材质
  let otherLayersOpacity = 0.2;
  floorHideOthersToggleBtn?.classList.toggle("is-active", hideOtherFloors);
  floorHideOthersToggleBtn?.setAttribute("aria-pressed", hideOtherFloors ? "true" : "false");
  function syncOtherOpacityUi() {
    if (!otherLayersOpacityWrap) return;
    otherLayersOpacityWrap.hidden = hideOtherFloors;
    otherLayersOpacityWrap.setAttribute("aria-hidden", hideOtherFloors ? "true" : "false");
    otherLayersOpacityWrap.style.display = hideOtherFloors ? "none" : "flex";
    if (otherLayersOpacityRange) {
      const v = Math.round(otherLayersOpacity * 100);
      otherLayersOpacityRange.value = String(Math.max(0, Math.min(100, v)));
    }
  }
  syncOtherOpacityUi();
  otherLayersOpacityRange?.addEventListener("input", () => {
    if (hideOtherFloors) return;
    const v = Number(otherLayersOpacityRange.value);
    if (!Number.isFinite(v)) return;
    otherLayersOpacity = Math.max(0, Math.min(1, v / 100));
    rebuildFloorplan3D();
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
  function disposeObject3D(obj) {
    obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose?.());
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

  function buildRoomMesh(room, cx, cy, s, floorOpacity) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) return null;
    const shape = new THREE.Shape();
    const pts = poly.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [snap(Number(p[0])), snap(Number(p[1]))]);
    if (pts.length < 3) return null;
    shape.moveTo((pts[0][0] - cx) * (s / 100), (pts[0][1] - cy) * (s / 100));
    for (let i = 1; i < pts.length; i++) {
      shape.lineTo((pts[i][0] - cx) * (s / 100), (pts[i][1] - cy) * (s / 100));
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mat = stdMat(FLOORPLAN_SURFACE_COLOR);
    const op = floorOpacity ?? 1;
    mat.opacity = op;
    // 选中层（op=1）走不透明渲染，避免透明排序导致的“缺失/闪烁”
    mat.transparent = op < 1;
    mat.depthWrite = op < 1 ? false : true;
    mat.side = THREE.FrontSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.position.y = 0.02;
    mesh.userData.floorplanPick = true;
    return mesh;
  }

  function buildWallMesh(wall, cx, cy, s, defaultHeightCm, floorOpacity) {
    if (!Array.isArray(wall?.start) || wall.start.length < 2 || !Array.isArray(wall?.end) || wall.end.length < 2) return null;
    const x1 = snap(Number(wall.start[0])), y1 = snap(Number(wall.start[1]));
    const x2 = snap(Number(wall.end[0])), y2 = snap(Number(wall.end[1]));
    const dx = (x2 - x1) * (s / 100), dz = (y2 - y1) * (s / 100);
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    const th = Number(wall.thickness);
    const thickM = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 10000;
    const hCm = Number(wall.height);
    const hM = ((Number.isFinite(hCm) && hCm > 0 ? hCm : defaultHeightCm) * s) / 100;
    const geo = new THREE.BoxGeometry(len, hM, thickM);
    const op = floorOpacity ?? 1;
    const mat = stdMat(FLOORPLAN_SURFACE_COLOR);
    mat.opacity = op;
    // 选中层（op=1）走不透明渲染，避免透明排序导致的“缺失/闪烁”
    mat.transparent = op < 1;
    mat.depthWrite = op < 1 ? false : true;
    // 墙体是封闭盒体，使用单面渲染可减少双面阴影引起的闪烁
    mat.side = THREE.FrontSide;
    const mesh = new THREE.Mesh(geo, mat);
    // 必须投射阴影，否则阴影贴图中无墙体深度，家具影子会“穿过”墙落在另一侧地面
    mesh.castShadow = true;
    // 不参与接收：减轻墙顶/长墙面上 shadow acne 条纹
    mesh.receiveShadow = false;
    const mx = ((x1 + x2) / 2 - cx) * (s / 100);
    const mz = ((y1 + y2) / 2 - cy) * (s / 100);
    mesh.position.set(mx, hM / 2, mz);
    mesh.rotation.y = Math.atan2(dz, dx);
    mesh.userData.floorplanPick = true;
    return mesh;
  }

  /** 按楼层 bbox 生成连续楼板，确保二/三层也有完整地板可见 */
  function buildFloorPlateMesh(fl, cx, cy, s, floorOpacity) {
    const b = getFloorBBoxCm(fl);
    if (!b) return null;
    const w = Math.max(0.08, (Math.max(1, b.maxX - b.minX) * s) / 100);
    const d = Math.max(0.08, (Math.max(1, b.maxY - b.minY) * s) / 100);
    const geo = new THREE.PlaneGeometry(w, d);
    const mat = stdMat(FLOORPLAN_SURFACE_COLOR);
    const op = floorOpacity ?? 1;
    mat.opacity = op;
    mat.transparent = op < 1;
    mat.depthWrite = op < 1 ? false : true;
    mat.side = THREE.FrontSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    // 轻微抬高，避免与其它共面几何出现 Z-fighting
    mesh.position.set(
      ((b.minX + b.maxX) * 0.5 - cx) * (s / 100),
      0.003,
      ((b.minY + b.maxY) * 0.5 - cy) * (s / 100),
    );
    mesh.receiveShadow = true;
    mesh.userData.floorplanPick = true;
    return mesh;
  }

  function rebuildFloorplan3D() {
    clearInteractiveList();
    disposeObject3D(floorplanRoot);
    floorplanRoot.clear();
    floorplanSelected = false;
    if (!currentFloorplanEntry) {
      floorYOffsetById.clear();
      floorElevationBaseCm = 0;
      return;
    }

    const entry = currentFloorplanEntry;
    const floorIndex = normalizeFloorIndex(entry, currentFloorIndex);
    const floor = getCurrentFloorFromEntry(entry, floorIndex);
    if (!floor) return;
    const bbox = getEntryBBoxCm(entry);
    if (!bbox) return;

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
    let worldX = snap(VIEW_W / 2), worldY = snap(VIEW_H / 2);
    const wxMin = worldX + s * (bbox.minX - bbox.cx);
    const wyMin = worldY + s * (bbox.minY - bbox.cy);
    worldX += Math.round(wxMin / GRID) * GRID - wxMin;
    worldY += Math.round(wyMin / GRID) * GRID - wyMin;

    const cx = bbox.cx, cy = bbox.cy;
    const gWorld = new THREE.Group();
    const pos = cmToSceneXZ(worldX, worldY);
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
      const isActive = i === floorIndex;
      // 选中层更深、更清晰：提高不透明度
      // 未选中层更淡：降低透明度
      const opacity = isActive ? 1 : otherLayersOpacity;
      const plate = buildFloorPlateMesh(fl, cx, cy, s, opacity);
      if (plate) floorG.add(plate);
      for (const room of fl.rooms || []) {
        const m = buildRoomMesh(room, cx, cy, s, opacity);
        if (m) floorG.add(m);
      }
      const fh = Number(fl.height);
      const defaultH = Number.isFinite(fh) && fh > 0 ? fh : 280;
      for (const w of fl.walls || []) {
        const m = buildWallMesh(w, cx, cy, s, defaultH, opacity);
        if (m) floorG.add(m);
      }
      // 每层楼的垂直高度（避免所有层重叠在 y=0）
      const fidRaw = String(fl?.id ?? "").trim() || `floor${i + 1}`;
      floorG.position.y = floorYOffsetById.get(normalizeFloorKey(fidRaw)) ?? 0;
      // 未开启“仅当前层”时：所有楼层都绘制（未选中透明弱化）
      // 开启“仅当前层”时：只显示当前楼层
      floorG.visible = !hideOtherFloors || isActive;
      gWorld.add(floorG);
    });

    const hitW = (Math.max(bbox.w, 1) * s) / 100;
    const hitD = (Math.max(bbox.h, 1) * s) / 100;
    const hit = new THREE.Mesh(new THREE.PlaneGeometry(hitW, hitD), new THREE.MeshBasicMaterial({ visible: false }));
    hit.rotation.x = -Math.PI / 2;
    hit.userData.floorplanPick = true;
    gWorld.add(hit);

    activeFloorId = floor?.id != null && String(floor.id).trim() ? String(floor.id).trim() : null;

    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-svg", {
        detail: { id: entry?.id != null ? String(entry.id) : "", floorIndex, floorId: String(floor.id ?? "") },
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
    const active = normalizeFloorIndex(currentFloorplanEntry, currentFloorIndex);
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
        if (i === currentFloorIndex && currentFloorplanEntry) return;
        if (currentFloorplanEntry) {
          currentFloorIndex = i;
          setFloorLevelsVisible();
          rebuildFloorplan3D();
          updateFurnitureFloorVisibility();
          selectFurniture(null);
        }
      });
      floorLevelRow.appendChild(btn);
    }
  }

  function ensureFloorLevelControls() {
    if (!canvasWrap || floorLevelDock) return;
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
    canvasWrap.appendChild(dock);
    setFloorLevelsVisible();
  }

  function clearFloorplan() {
    currentFloorplanEntry = null;
    currentFloorIndex = 0;
    rebuildFloorplan3D();
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  function applyFloorplanEntryAtWorld(entry, _wx, _wy, options = {}) {
    if (!entry) return;
    currentFloorplanEntry = entry;
    currentFloorIndex = normalizeFloorIndex(entry, options.floorIndex);
    rebuildFloorplan3D();
    setFloorLevelsVisible();
    updateFurnitureFloorVisibility();
    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  function createFurnitureMesh(furnitureId) {
    const item = byId.get(furnitureId);
    const fp = extractFurnitureFootprintCm(item);
    const w = fp.w / 100, d = fp.d / 100, h = fp.h / 100;
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = stdMat(0x8c7cff);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    // 不参与接收阴影：避免盒体顶面/侧面出现 shadow acne 条纹（花花的感觉）
    mesh.receiveShadow = false;
    mesh.position.y = h / 2;
    const g = new THREE.Group();
    g.userData.modelType = furnitureId;
    g.add(mesh);
    return g;
  }

  function setFurnitureFromLayoutCm(group, xCm, yCm, rotDeg) {
    const fp = group.userData.footprint;
    const c = clampFurnitureToCanvas(xCm, yCm, rotDeg, fp.hw, fp.hh);
    const p = cmToSceneXZ(c.x, c.y);
    group.position.x = p.x;
    group.position.z = p.z;
    group.rotation.y = (-rotDeg * Math.PI) / 180;
  }

  function appendFurnitureItem(modelId, xCm, yCm, rotationDeg = 0, floorId = null) {
    if (!byId.has(modelId)) return null;
    const fp = extractFurnitureFootprintCm(byId.get(modelId));
    const group = createFurnitureMesh(modelId);
    group.userData.isFurniture = true;
    group.userData.footprint = { hw: fp.hw, hh: fp.hh };
    group.userData.floorId = String(floorId ?? getActiveFloorIdForFurniture()).trim() || "floor1";
    let rot = Math.round(Number(rotationDeg) || 0) % 360;
    if (rot < 0) rot += 360;
    group.userData.rotDeg = rot;
    setFurnitureFromLayoutCm(group, xCm, yCm, rot);
    furnitureRoot.add(group);
    registerFurnitureMeshes(group);
    return group;
  }

  function rebuildFromLayout(layout) {
    furnitureRoot.children.slice().forEach((ch) => {
      if (ch.userData?.isFurniture) {
        unregisterFurnitureGroup(ch);
        furnitureRoot.remove(ch);
        disposeObject3D(ch);
      }
    });
    for (const item of layout) {
      appendFurnitureItem(item.model, item.x, item.y, item.rotation ?? 0, item.floorId ?? null);
    }
    updateFurnitureFloorVisibility();
  }

  function updateFurnitureFloorVisibility() {
    const hasFloor = Boolean(activeFloorId);
    const activeKey = activeFloorId != null ? normalizeFloorKey(activeFloorId) : null;
    activeFloorPickMeshes.length = 0;
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const fid = String(g.userData.floorId || "").trim();
      const key = normalizeFloorKey(fid);
      const yOff = floorYOffsetById.get(key) ?? 0;
      // group.position.y 只负责把家具放到对应楼层高度；mesh.position.y（h/2）保持不动
      g.position.y = yOff;
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
          m.opacity = op;
          m.transparent = op < 1;
          m.depthWrite = op < 1 ? false : true;
          m.needsUpdate = true;
        });
      });
    });
    if (selectedGroup && selectedGroup.userData?.isFloorActive === false) selectFurniture(null);
  }

  function getLayout() {
    const out = [];
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const cm = sceneXZToCm(g.position.x, g.position.z);
      out.push({
        model: g.userData.modelType,
        floorId: String(g.userData.floorId || "").trim() || null,
        x: cm.x,
        y: cm.y,
        rotation: g.userData.rotDeg ?? 0,
      });
    });
    return out;
  }

  function serializeEditorSnapshot() {
    return JSON.stringify({
      v: 1,
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
    });
  }

  function normalizeHistorySnapshot(parsed) {
    if (Array.isArray(parsed)) return { furniture: parsed, floorPlanId: undefined, floorLevelIndex: undefined };
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.furniture)) {
      const id = parsed.floorPlanId;
      let floorLevelIndex = undefined;
      if (parsed.floorLevelIndex === null) floorLevelIndex = null;
      else if (parsed.floorLevelIndex !== undefined) {
        const n = Math.trunc(Number(parsed.floorLevelIndex));
        floorLevelIndex = Number.isFinite(n) && n >= 0 ? n : 0;
      }
      if (id === undefined) return { furniture: parsed.furniture, floorPlanId: undefined, floorLevelIndex };
      if (id === null || String(id).trim() === "") return { furniture: parsed.furniture, floorPlanId: null, floorLevelIndex };
      return { furniture: parsed.furniture, floorPlanId: String(id).trim(), floorLevelIndex };
    }
    return null;
  }

  function applyHistorySnapshotState(state) {
    if (!state) return;
    if (state.floorPlanId !== undefined) {
      if (state.floorPlanId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(state.floorPlanId) : null;
        if (entry) applyFloorplanEntryAtWorld(entry, undefined, undefined, { floorIndex: state.floorLevelIndex });
        else clearFloorplan();
      } else clearFloorplan();
    }
    const furn = Array.isArray(state.furniture) ? state.furniture : [];
    isRestoring = true;
    try { rebuildFromLayout(furn); } finally { isRestoring = false; }
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

  function applyHistoryIndex(i) {
    let state;
    try { state = normalizeHistorySnapshot(JSON.parse(history[i])); } catch { state = null; }
    if (!state) return;
    isRestoring = true;
    try { applyHistorySnapshotState(state); } finally { isRestoring = false; }
    selectFurniture(null);
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
    emitLayoutChanged();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    applyHistoryIndex(historyIndex);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    applyHistoryIndex(historyIndex);
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
    return currentFloorplanEntry ? normalizeFloorIndex(currentFloorplanEntry, currentFloorIndex) : null;
  }
  function getCurrentFloorId() { return activeFloorId; }

  function serializeDesignBaseline() {
    return JSON.stringify({
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
      floorLevelIndex: getCurrentFloorLevelIndex(),
    });
  }

  function syncPropertiesPanelForSelection(group) {
    if (!propertiesPanel) return;
    if (!group || !group.userData?.isFurniture) {
      propertiesPanel.classList.remove("is-visible");
      if (propertiesName) propertiesName.textContent = "未选择";
      return;
    }
    propertiesPanel.classList.add("is-visible");
    const item = byId.get(group.userData.modelType);
    if (propertiesName) propertiesName.textContent = item ? getFurnitureDisplayName(item) : group.userData.modelType || "家具";
    const cm = sceneXZToCm(group.position.x, group.position.z);
    const rot = group.userData.rotDeg ?? 0;
    if (propInputX) propInputX.value = String(Math.round(cm.x));
    if (propInputZ) propInputZ.value = String(Math.round(cm.y));
    if (propInputRotY) propInputRotY.value = String(rot);
  }

  function selectFurniture(group) {
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
    syncPropertiesPanelForSelection(selectedGroup);
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
    if (!selectedGroup || !selectedGroup.userData?.isFurniture) return false;
    const x = parseFloat(propInputX?.value ?? "");
    const zField = parseFloat(propInputZ?.value ?? "");
    const deg = parseFloat(propInputRotY?.value ?? "");
    const cm = sceneXZToCm(selectedGroup.position.x, selectedGroup.position.z);
    const nx = Number.isFinite(x) ? x : cm.x;
    const ny = Number.isFinite(zField) ? zField : cm.y;
    let rot = selectedGroup.userData.rotDeg ?? 0;
    if (Number.isFinite(deg)) {
      rot = Math.round(deg) % 360;
      if (rot < 0) rot += 360;
    }
    selectedGroup.userData.rotDeg = rot;
    const fp = selectedGroup.userData.footprint;
    const c = clampFurnitureToCanvas(nx, ny, rot, fp.hw, fp.hh);
    setFurnitureFromLayoutCm(selectedGroup, c.x, c.y, rot);
    schedulePushHistory();
    return true;
  }

  function resizeRenderer() {
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
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
    const cm = sceneXZToCm(pt.x, pt.z);
    return { x: snap(cm.x), y: snap(cm.y) };
  }

  function addFurniture(modelId, xCm = VIEW_W / 2, yCm = VIEW_H / 2) {
    const g = appendFurnitureItem(modelId, xCm, yCm, 0);
    if (g) selectFurniture(g);
    updateFurnitureFloorVisibility();
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
    if (historyReady) pushHistorySnapshot();
  }

  function isEditViewActive() {
    return document.getElementById("appViewEdit")?.classList.contains("is-active");
  }

  function onPointerDown(e) {
    if (!isEditViewActive() || e.button !== 0) return;
    const fur = rayPickFurniture(e.clientX, e.clientY);
    if (fur) {
      selectFurniture(fur);
      // 拖拽锚点：记录按下时鼠标射线与“家具所在楼层平面”的交点相对家具(x/z)的偏移
      // 避免切换楼层后，因为射线与不同高度平面求交导致的落点偏移
      const planeY = fur.position?.y ?? 0;
      const startCm = intersectPlaneCm(e.clientX, e.clientY, planeY);
      const curCm = sceneXZToCm(fur.position.x, fur.position.z);
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
    if (rayPickFloorplan(e.clientX, e.clientY)) {
      selectFurniture(null);
      floorplanSelected = true;
      propertiesPanel?.classList.remove("is-visible");
      return;
    }
    selectFurniture(null);
    floorplanSelected = false;
  }

  function onPointerMove(e) {
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
    const c = clampFurnitureToCanvas(adjX, adjY, rot, fp.hw, fp.hh);
    setFurnitureFromLayoutCm(g, c.x, c.y, rot);
    syncPropertiesPanelForSelection(g);
  }

  function onPointerUp(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    dragState = null;
    controls.enabled = true;
    if (historyReady) pushHistorySnapshot();
  }

  container.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  container.addEventListener("dblclick", (e) => {
    if (!isEditViewActive()) return;
    const fur = rayPickFurniture(e.clientX, e.clientY);
    if (!fur) return;
    e.preventDefault();
    let r = (fur.userData.rotDeg ?? 0) + 90;
    r %= 360;
    fur.userData.rotDeg = r;
    const cm = sceneXZToCm(fur.position.x, fur.position.z);
    const fp = fur.userData.footprint;
    const c = clampFurnitureToCanvas(cm.x, cm.y, r, fp.hw, fp.hh);
    setFurnitureFromLayoutCm(fur, c.x, c.y, r);
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
      !["INPUT", "TEXTAREA"].includes(e.target?.tagName || "") &&
      !e.target?.isContentEditable
    ) {
      const k = e.key;
      if (k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown") {
        e.preventDefault();
        const cm = sceneXZToCm(selectedGroup.position.x, selectedGroup.position.z);
        let dx = 0, dy = 0;
        if (k === "ArrowLeft") dx = -GRID;
        else if (k === "ArrowRight") dx = GRID;
        else if (k === "ArrowUp") dy = -GRID;
        else if (k === "ArrowDown") dy = GRID;
        const rot = selectedGroup.userData.rotDeg ?? 0;
        const fp = selectedGroup.userData.footprint;
        const c = clampFurnitureToCanvas(cm.x + dx, cm.y + dy, rot, fp.hw, fp.hh);
        setFurnitureFromLayoutCm(selectedGroup, c.x, c.y, rot);
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
    rebuildFloorplan3D();
    updateFurnitureFloorVisibility();
    syncOtherOpacityUi();
  });
  undoBtn?.addEventListener("click", () => undo());
  redoBtn?.addEventListener("click", () => redo());
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
    // 只有在“确实在替换旧户型”时才清空家具：当 nextId === curId 时通常不需要清空
    const shouldClearFurniture = Boolean(currentFloorplanEntry) && !(nextId && curId && nextId === curId);
    if (!(await canReplaceExistingFloorplan(entry))) return false;
    if (shouldClearFurniture) {
      // 替换户型前先删除旧家具，避免旧家具残留到新户型楼层逻辑里
      rebuildFromLayout([]);
      selectFurniture(null);
    }
    applyFloorplanEntryAtWorld(entry);
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
    ghost.className = "furniture-library-drag-ghost";
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
    if (!byId.has(p.model)) return;
    const cm = intersectPlaneCm(x, y, getPlacementPlaneWorldY());
    if (cm) addFurniture(p.model, cm.x, cm.y);
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
        const panel = card.closest?.(".side-panel[data-panel='assets']");
        if (!panel || !panel.classList.contains("is-visible") || !isEditViewActive()) return;
        if (e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const n = Math.floor(Math.random() * 5) - 2, m = Math.floor(Math.random() * 5) - 2;
          addFurniture(card.dataset.model, VIEW_W / 2 + n * GRID, VIEW_H / 2 + m * GRID);
          return;
        }
        if (!e.isPrimary) return;
        window.__selectFurnitureLibraryCardByModel?.(card.dataset.model);
        pushPtr();
        pendingLibraryDrag = { model: card.dataset.model, sourceCard: card, sx: e.clientX, sy: e.clientY, pointerId: e.pointerId, didDrag: false, ghostEl: null };
        window.addEventListener("pointermove", onLibMove, { passive: true });
        window.addEventListener("pointerup", endLibDrag);
        window.addEventListener("pointercancel", endLibDrag);
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
          x: pc ? Number(pc[0]) || 0 : 0,
          y: pc ? Number(pc[1]) || 0 : 0,
          rotation: Number(fi.rotationDeg ?? fi.rotation ?? 0) || 0,
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
        x: Number(row?.x),
        y: Number(row?.y),
        rotation: Number(row?.rotation ?? row?.rotationDeg ?? 0) || 0,
      }))
      .filter((r) => r.model && Number.isFinite(r.x) && Number.isFinite(r.y));
  }

  function applyFromDesignProject(project) {
    if (!project || typeof project !== "object") return;
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
      if (fpId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
        if (entry) applyFloorplanEntryAtWorld(entry, undefined, undefined, { floorIndex: floorLevelIndex });
        else clearFloorplan();
      } else clearFloorplan();
      rebuildFromLayout(layout);
      if (hasSvgEditor && se.view && typeof se.view === "object") {
        const tx = Number(se.view.tx), ty = Number(se.view.ty), sc = Number(se.view.scale);
        if (Number.isFinite(tx) && Number.isFinite(ty) && Number.isFinite(sc)) setViewTransform(se.view);
        else resetCameraView();
      } else resetCameraView();
      setGridVisible(hasSvgEditor && typeof se.gridVisible === "boolean" ? se.gridVisible : true);
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

  function applyExternalLayout(layout, options = {}) {
    isRestoring = true;
    try { rebuildFromLayout(Array.isArray(layout) ? layout : []); } finally { isRestoring = false; }
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

  function restoreEditorSession(payload) {
    function applyFloorplanByPayload() {
      const fpId = payload.floorPlanId != null ? String(payload.floorPlanId).trim() : "";
      const floorLevelIndex = Math.max(0, Math.trunc(Number(payload.floorLevelIndex) || 0));
      if (fpId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
        if (entry) {
          applyFloorplanEntryAtWorld(entry, undefined, undefined, { floorIndex: floorLevelIndex });
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
        try { applyFloorplanByPayload(); } finally { isRestoring = false; }
        applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        return;
      }
      historyReady = false;
      isRestoring = true;
      history.splice(0, history.length, ...entries);
      historyIndex = idx;
      try {
        const state = normalizeHistorySnapshot(JSON.parse(history[historyIndex]));
        if (!state) throw new Error("bad");
        applyHistorySnapshotState(state);
      } catch {
        historyReady = true;
        isRestoring = true;
        try { applyFloorplanByPayload(); } finally { isRestoring = false; }
        applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        return;
      }
      isRestoring = false;
      selectFurniture(null);
      historyReady = true;
      window.__designLayoutBaseline =
        typeof payload.designLayoutBaseline === "string" ? payload.designLayoutBaseline : serializeDesignBaseline();
      if (undoBtn) undoBtn.disabled = historyIndex <= 0;
      if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
      emitLayoutChanged();
    } else {
      isRestoring = true;
      try { applyFloorplanByPayload(); } finally { isRestoring = false; }
      applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
    }
  }

  window.addEventListener("visionhome:design-select", (e) => {
    const project = e.detail?.project;
    if (project) applyFromDesignProject(project);
  });
  window.addEventListener("visionhome:design-new", () => {
    clearFloorplan();
    applyExternalLayout([]);
  });

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
      dir.position.set(
        tmpVecA.x + tmpVecC.x * LIGHT_RADIUS,
        LIGHT_HEIGHT,
        tmpVecA.z + tmpVecC.z * LIGHT_RADIUS,
      );
      dir.target.position.set(tmpVecA.x, 0, tmpVecA.z);
      dir.target.updateMatrixWorld();
    }
    dir.updateMatrixWorld(true);
    fitDirectionalShadowFrustum();
    renderer.render(scene, camera);
  }

  window.addEventListener("resize", resizeRenderer);
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeRenderer).observe(container);

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
  window.svgEditorGetCurrentFloorplanId = getCurrentFloorplanId;
  window.svgEditorGetCurrentFloorLevelIndex = getCurrentFloorLevelIndex;
  window.svgEditorGetCurrentFloorId = getCurrentFloorId;
  window.svgEditorRestoreSession = restoreEditorSession;
  window.svgEditorGetUndoHistory = () => ({ entries: [...history], index: historyIndex });
  window.svgEditorFlushHistoryDebounce = flushHistoryDebounce;
  window.svgEditorDeselect = () => {
    deselectVisualOnly();
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
