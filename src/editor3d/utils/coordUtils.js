import * as THREE from "three";

import { getFloorBBoxCm } from "../../floorplan/floorplanSvg.js";

export const VIEW_W = 3000;
export const VIEW_H = 3000;
/** 编辑区平面半宽/半深（cm），原点在画布中心，与 Three 场景 XZ=0 对齐 */
const CENTER_HALF = VIEW_W / 2;
export const GRID = 1;
const FLOORPLAN_PAD = 80;
const FLOORPLAN_SIZE_FACTOR = 0.38;

// 地面网格在 y=0.02（见 buildRoomMesh）；家具/装饰的 group.position.y 需要抬到地面之上，
// 否则很多 glTF 会以 y=0 为底面导致“下陷”。
export const FLOOR_SURFACE_Y_M = 0.02;

/** 户型世界摆放等：画布 cm（左上角为 0）↔ 场景米 */
export function canvasCmToSceneXZ(xCm, yCm) {
  return { x: (xCm - VIEW_W / 2) / 100, z: (yCm - VIEW_H / 2) / 100 };
}

export function sceneXZToCanvasCm(x, z) {
  return { x: x * 100 + VIEW_W / 2, y: z * 100 + VIEW_H / 2 };
}

/** 家具布局：以编辑区中心为原点的 cm（约 [-1500,1500]）↔ 场景米 */
export function centeredCmToSceneXZ(cx, cy) {
  return { x: cx / 100, z: cy / 100 };
}

export function sceneXZToCenteredCm(x, z) {
  return { x: x * 100, y: z * 100 };
}

export function centeredToCanvasCm(cx, cy) {
  return { x: cx + CENTER_HALF, y: cy + CENTER_HALF };
}

export function canvasCmToCentered(xCm, yCm) {
  return { x: xCm - CENTER_HALF, y: yCm - CENTER_HALF };
}

export function clampFurnitureCentered(cx, cy, rotDeg, hw, hh) {
  const canvas = centeredToCanvasCm(cx, cy);
  const clamped = clampFurnitureToCanvas(canvas.x, canvas.y, rotDeg, hw, hh);
  return canvasCmToCentered(clamped.x, clamped.y);
}

export function snap(v) {
  return Math.round(v / GRID) * GRID;
}

export function getFloorsFromEntry(entry) {
  const floors = entry?.floors;
  return Array.isArray(floors) ? floors : [];
}

export function normalizeFloorIndex(entry, indexLike) {
  const floors = getFloorsFromEntry(entry);
  if (!floors.length) return 0;
  const n = Math.trunc(Number(indexLike));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), floors.length - 1);
}

export function normalizeFloorKey(id) {
  return String(id ?? "").trim().toLowerCase();
}

export function getCurrentFloorFromEntry(entry, indexLike) {
  const floors = getFloorsFromEntry(entry);
  if (!floors.length) return null;
  return floors[normalizeFloorIndex(entry, indexLike)] ?? floors[0] ?? null;
}

export function getEntryBBoxCm(entry) {
  const floors = getFloorsFromEntry(entry);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
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
export function computeFloorplanCanvasPlacement(entry) {
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

export function closestPointOnSegment2D(px, py, ax, ay, bx, by) {
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
export function furnitureWallSnapSamplePointsCm(cx, cy, rotDeg, hw, hh) {
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

export function extractFurnitureFootprintCm(item) {
  if (!item || typeof item !== "object") return { w: 100, d: 100, h: 80, hw: 50, hh: 50 };
  const raw = item.size;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { w: 100, d: 100, h: 80, hw: 50, hh: 50 };
  let w = Number(raw.widthCm ?? raw.width ?? raw.w);
  let d = Number(raw.depthCm ?? raw.depth ?? raw.d ?? raw.length);
  let h = Number(raw.heightCm ?? raw.height ?? raw.h);
  if (!Number.isFinite(w) || w <= 0) w = 210;
  if (!Number.isFinite(d) || d <= 0) d = 90;
  if (!Number.isFinite(h) || h <= 0) h = 80;
  if (w > 600 || d > 600) {
    w /= 10;
    d /= 10;
  }
  if (h > 600) h /= 10;
  return { w, d, h, hw: Math.max(8, w / 2), hh: Math.max(8, d / 2) };
}

/**
 * 将 GLTF 场景缩放到目标尺寸（米）并落底：底面 y=0，水平居中。
 * width→X，height→Y，depth→Z（与 BoxGeometry(w,h,d) 一致）
 */
export function fitGltfToFootprint(root, widthM, heightM, depthM) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (!box.isEmpty()) {
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.x > 1e-6 && size.y > 1e-6 && size.z > 1e-6) {
      const sx = widthM / size.x;
      const sy = heightM / size.y;
      const sz = depthM / size.z;
      root.scale.set(sx, sy, sz);
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

export function rotateYLocal(x, z, deg) {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: c * x + s * z, z: -s * x + c * z };
}

export function furnitureFootprintAabbCm(cx, cy, rotDeg, hw, hh) {
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of corners) {
    const p = rotateYLocal(lx, ly, rotDeg);
    minX = Math.min(minX, p.x + cx);
    minY = Math.min(minY, p.z + cy);
    maxX = Math.max(maxX, p.x + cx);
    maxY = Math.max(maxY, p.z + cy);
  }
  return { minX, minY, maxX, maxY };
}

export function clampFurnitureToCanvas(cx, cy, rotDeg, hw, hh) {
  const margin = 10;
  let x = cx;
  let y = cy;
  for (let iter = 0; iter < 16; iter++) {
    let b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    x += Math.round(b.minX / GRID) * GRID - b.minX;
    y += Math.round(b.minY / GRID) * GRID - b.minY;
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    let adjusted = false;
    if (b.minX < margin) {
      x += margin - b.minX;
      adjusted = true;
    }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.minY < margin) {
      y += margin - b.minY;
      adjusted = true;
    }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.maxX > VIEW_W - margin) {
      x += VIEW_W - margin - b.maxX;
      adjusted = true;
    }
    b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
    if (b.maxY > VIEW_H - margin) {
      y += VIEW_H - margin - b.maxY;
      adjusted = true;
    }
    if (!adjusted) {
      b = furnitureFootprintAabbCm(x, y, rotDeg, hw, hh);
      x += Math.round(b.minX / GRID) * GRID - b.minX;
      y += Math.round(b.minY / GRID) * GRID - b.minY;
      break;
    }
  }
  return { x, y };
}
