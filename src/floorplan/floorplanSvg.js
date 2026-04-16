/**
 * 单层 floors[i] → SVG 局部几何（厘米坐标，与画布 3000×3000 cm 一致；可与视图 transform 组合）
 * 遍历该层内 rooms / walls / doors / windows / furnitures；3D 属性（height、elevation 等）不参与 2D 绘制。
 */

import { normalizeDoorStyle, defaultDoorStyleWhite } from "./doorStyle.js";
import { normalizeWindowStyle, defaultWindowStyleWhite } from "./windowStyle.js";

const NS = "http://www.w3.org/2000/svg";

function identitySnapCoord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/** @param {number | undefined} step 户型平面坐标量化步长（≈ GRID/s，单位 cm），使变换后落在画布网格上 */
function makePlanUnitSnapper(step) {
  if (step == null || !Number.isFinite(step) || step <= 0) return identitySnapCoord;
  return (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return n;
    return Math.round(n / step) * step;
  };
}

/** 平面 [x,y]：positionCm 或 position（均为 cm） */
function readPlanPoint2d(obj) {
  if (!obj || typeof obj !== "object") return null;
  const a = obj.positionCm ?? obj.position;
  return Array.isArray(a) && a.length >= 2 ? a : null;
}

/** @param {(x: number, y: number) => void} pt */
function bboxFromSegment(obj, pt) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.start) && obj.start.length >= 2) {
    pt(Number(obj.start[0]), Number(obj.start[1]));
  }
  if (Array.isArray(obj.end) && obj.end.length >= 2) {
    pt(Number(obj.end[0]), Number(obj.end[1]));
  }
}

/** @param {unknown} poly @param {(x: number, y: number) => void} pt */
function bboxFromPolygon(poly, pt) {
  if (!Array.isArray(poly)) return;
  for (const p of poly) {
    if (Array.isArray(p) && p.length >= 2) {
      pt(Number(p[0]), Number(p[1]));
    }
  }
}

/**
 * positionCm / position + width/depth（cm）+ rotationDeg → 旋转矩形四角入 bbox
 * @param {object} obj
 * @param {(x: number, y: number) => void} pt
 */
function bboxFromPositionFootprint(obj, pt) {
  if (!obj || typeof obj !== "object") return;
  const pm = readPlanPoint2d(obj);
  if (!pm) return;
  const cx = Number(pm[0]);
  const cy = Number(pm[1]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  const w = Number(obj.widthCm ?? obj.widthMm ?? obj.width ?? 80);
  const d = Number(obj.depthCm ?? obj.depthMm ?? obj.depth ?? 80);
  const hw = Number.isFinite(w) && w > 0 ? w / 2 : 40;
  const hd = Number.isFinite(d) && d > 0 ? d / 2 : 40;
  const deg = Number(obj.rotationDeg ?? obj.rotation ?? 0);
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  for (const [lx, ly] of corners) {
    const x = cx + lx * cos - ly * sin;
    const y = cy + lx * sin + ly * cos;
    pt(x, y);
  }
}

/**
 * 门/窗等：线段、多边形、或 position + length + angleDeg
 * @param {object} obj
 * @param {(x: number, y: number) => void} pt
 */
function bboxFromOpeningLike(obj, pt) {
  if (!obj || typeof obj !== "object") return;
  bboxFromPolygon(obj.polygon, pt);
  bboxFromSegment(obj, pt);

  const pos = readPlanPoint2d(obj);
  const L = Number(obj.lengthCm ?? obj.lengthMm ?? obj.length);
  const ang = Number(obj.angleDeg ?? obj.angle ?? obj.rotationDeg ?? 0);
  if (pos && Number.isFinite(L) && L > 0) {
    const x0 = Number(pos[0]);
    const y0 = Number(pos[1]);
    const rad = (ang * Math.PI) / 180;
    const x1 = x0 + L * Math.cos(rad);
    const y1 = y0 + L * Math.sin(rad);
    pt(x0, y0);
    pt(x1, y1);
  }
}

/**
 * 门/窗挂在墙上：wallId + pos（沿墙中心线从 start 到洞口中心的 cm）+ width（cm）
 * @param {object} obj
 * @param {object[]} walls
 * @returns {{ x0: number, y0: number, x1: number, y1: number } | null}
 */
function openingSegmentOnWall(obj, walls) {
  if (!obj || typeof obj !== "object") return null;
  const wid = String(obj.wallId ?? "").trim();
  if (!wid || !Array.isArray(walls)) return null;
  const wall = walls.find((w) => String(w?.id ?? "") === wid);
  if (!wall || !Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
    return null;
  }
  const pos = Number(obj.pos);
  const width = Number(obj.width);
  if (!Number.isFinite(pos) || !Number.isFinite(width) || width <= 0) return null;
  const x1 = Number(wall.start[0]);
  const y1 = Number(wall.start[1]);
  const x2 = Number(wall.end[0]);
  const y2 = Number(wall.end[1]);
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (len < 1e-6) return null;
  const ux = (x2 - x1) / len;
  const uy = (y2 - y1) / len;
  const cx = x1 + ux * pos;
  const cy = y1 + uy * pos;
  const hw = width / 2;
  return {
    x0: cx - ux * hw,
    y0: cy - uy * hw,
    x1: cx + ux * hw,
    y1: cy + uy * hw,
  };
}

/**
 * @param {object} floor
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, cx: number, cy: number, w: number, h: number } | null}
 */
export function getFloorBBoxCm(floor) {
  if (!floor || typeof floor !== "object") return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function pt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  for (const room of floor.rooms || []) {
    bboxFromPolygon(room?.polygon, pt);
  }
  for (const wall of floor.walls || []) {
    bboxFromSegment(wall, pt);
  }
  const walls = floor.walls || [];
  for (const d of floor.doors || []) {
    bboxFromOpeningLike(d, pt);
    const seg = openingSegmentOnWall(d, walls);
    if (seg) {
      pt(seg.x0, seg.y0);
      pt(seg.x1, seg.y1);
    }
  }
  for (const w of floor.windows || []) {
    bboxFromOpeningLike(w, pt);
    const seg = openingSegmentOnWall(w, walls);
    if (seg) {
      pt(seg.x0, seg.y0);
      pt(seg.x1, seg.y1);
    }
  }
  for (const f of floor.furnitures || []) {
    bboxFromPolygon(f?.polygon, pt);
    bboxFromSegment(f, pt);
    bboxFromPositionFootprint(f, pt);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w,
    h,
  };
}

function safeTypeClass(raw) {
  const t = String(raw || "default").replace(/[^a-z0-9_-]/gi, "");
  return t || "default";
}

/** @param {number[][]} pts */
function aabbFromPoints(pts) {
  if (!pts.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    const x = Number(p[0]);
    const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/**
 * @param {unknown} poly
 * @param {(n: number) => number} snapCoord
 * @returns {number[][]}
 */
function polygonPointsSnapped(poly, snapCoord) {
  if (!Array.isArray(poly)) return [];
  return poly
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => [snapCoord(Number(p[0])), snapCoord(Number(p[1]))]);
}

/** 多边形面积（顶点为 cm，结果 cm²） */
function polygonAreaCm2(pts) {
  if (pts.length < 3) return 0;
  let s = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * 单层户型投影面积（㎡）：各房间 polygon 面积之和（cm² → ㎡）
 * @param {object} floor
 * @returns {number}
 */
export function getFloorFootprintAreaM2(floor) {
  if (!floor || typeof floor !== "object") return 0;
  let sumCm2 = 0;
  for (const room of floor.rooms || []) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const pts = poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [Number(p[0]), Number(p[1])])
      .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    sumCm2 += polygonAreaCm2(pts);
  }
  return sumCm2 / 10000;
}

/**
 * 户型尺寸标注（房间外包框 cm、面积㎡；墙段长度 cm）；inversePlanScale = 1/s 抵消画布 scale(s) 使字号可读
 * @param {object} floor
 * @param {SVGGElement} innerG
 * @param {(n: number) => number} snapCoord
 * @param {number} inversePlanScale
 */
function appendFloorDimensionAnnotations(floor, innerG, snapCoord, inversePlanScale) {
  const inv = inversePlanScale;
  if (!Number.isFinite(inv) || inv <= 0) return;

  /** 房间标注内缩（plan cm），贴在右下角内侧；ROOM_LABEL_UP 为相对原位的上移量 */
  const ROOM_BR_PAD = 10;
  const ROOM_LABEL_UP = 74;
  const FLOOR_TITLE_GAP = 26;
  const WALL_OFF = 14;

  const layer = document.createElementNS(NS, "g");
  layer.setAttribute("class", "svg-floor-dimensions-layer");
  layer.setAttribute("pointer-events", "none");

  const floorBox = getFloorBBoxCm(floor);
  if (floorBox && (floor?.name || Number.isFinite(Number(floor?.height)))) {
    const fn = String(floor.name || "").trim();
    const fh = Number(floor.height);
    const bits = [];
    if (fn) bits.push(fn);
    if (Number.isFinite(fh) && fh > 0) bits.push(`层高 ${Math.round(fh)} cm`);
    if (bits.length) {
      const fcx = (floorBox.minX + floorBox.maxX) / 2;
      const fy = floorBox.minY - FLOOR_TITLE_GAP;
      const g0 = document.createElementNS(NS, "g");
      g0.setAttribute("class", "svg-floor-dim-floor");
      g0.setAttribute("transform", `translate(${fcx} ${fy}) scale(${inv})`);
      const t0 = document.createElementNS(NS, "text");
      t0.setAttribute("class", "svg-floor-dim-label svg-floor-dim-label--floor");
      t0.setAttribute("font-size", "12");
      t0.setAttribute("text-anchor", "middle");
      t0.textContent = bits.join(" · ");
      g0.appendChild(t0);
      layer.appendChild(g0);
    }
  }

  for (const room of floor.rooms || []) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const pts = polygonPointsSnapped(poly, snapCoord);
    const box = aabbFromPoints(pts);
    if (!box || box.w < 3 || box.h < 3 || !floorBox) continue;
    const arCm2 = polygonAreaCm2(pts);
    const arM2 = arCm2 / 10000;
    const wR = Math.round(box.w);
    const hR = Math.round(box.h);

    const brX = box.maxX - ROOM_BR_PAD;
    const brY = box.maxY - ROOM_BR_PAD - ROOM_LABEL_UP;

    const g = document.createElementNS(NS, "g");
    g.setAttribute("class", "svg-floor-dim-room");
    g.setAttribute("data-room-id", String(room.id || ""));
    g.setAttribute("transform", `translate(${brX} ${brY}) scale(${inv})`);

    const text = document.createElementNS(NS, "text");
    text.setAttribute("text-anchor", "end");
    text.setAttribute("font-size", "13");
    text.setAttribute("class", "svg-floor-dim-label svg-floor-dim-label--room");

    const name = String(room.name || "").trim();
    const lh = 14;
    const cap = 11;
    let nLines = 1;
    if (shortName || areaStr) nLines += 1;
    const totalH = (nLines - 1) * lh + cap;
    text.setAttribute("x", "0");
    text.setAttribute("y", String(-totalH));

    let first = true;
    function addTspan(content, extraClass) {
      const ts = document.createElementNS(NS, "tspan");
      ts.setAttribute("x", "0");
      ts.setAttribute("dy", first ? "0" : String(lh));
      first = false;
      if (extraClass) ts.setAttribute("class", extraClass);
      ts.textContent = content;
      text.appendChild(ts);
    }
    const shortName = name && name.length > 16 ? `${name.slice(0, 15)}…` : name;
    const areaStr = arM2 >= 0.01 ? (arM2 >= 100 ? `≈ ${arM2.toFixed(1)} m²` : `≈ ${arM2.toFixed(2)} m²`) : null;

    if (shortName || areaStr) {
      const ts = document.createElementNS(NS, "tspan");
      ts.setAttribute("x", "0");
      ts.setAttribute("dy", "0");
      if (shortName) {
        const nameSpan = document.createElementNS(NS, "tspan");
        nameSpan.setAttribute("class", "svg-floor-dim-label__name");
        nameSpan.textContent = shortName;
        ts.appendChild(nameSpan);
      }
      if (areaStr) {
        const sep = shortName ? "  " : "";
        const areaSpan = document.createElementNS(NS, "tspan");
        areaSpan.setAttribute("class", "svg-floor-dim-label__area");
        areaSpan.textContent = `${sep}${areaStr}`;
        ts.appendChild(areaSpan);
      }
      text.appendChild(ts);
      first = false;
    }
    addTspan(`${wR}×${hR} cm`);
    g.appendChild(text);
    layer.appendChild(g);
  }

  if (floorBox) {
    const fcx = (floorBox.minX + floorBox.maxX) / 2;
    const fcy = (floorBox.minY + floorBox.maxY) / 2;
    for (const wall of floor.walls || []) {
      if (!Array.isArray(wall?.start) || wall.start.length < 2 || !Array.isArray(wall?.end) || wall.end.length < 2) {
        continue;
      }
      const x1 = snapCoord(Number(wall.start[0]));
      const y1 = snapCoord(Number(wall.start[1]));
      const x2 = snapCoord(Number(wall.end[0]));
      const y2 = snapCoord(Number(wall.end[1]));
      const len = Math.hypot(x2 - x1, y2 - y1);
      if (len < 28) continue;
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const dx = x2 - x1;
      const dy = y2 - y1;
      const nx = (-dy / len) * WALL_OFF;
      const ny = (dx / len) * WALL_OFF;
      const vx = mx - fcx;
      const vy = my - fcy;
      const outward = Math.sign(nx * vx + ny * vy) || 1;
      const ox = mx + nx * outward;
      const oy = my + ny * outward;
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (ang > 90) ang -= 180;
      if (ang < -90) ang += 180;

      const g = document.createElementNS(NS, "g");
      g.setAttribute("class", "svg-floor-dim-wall");
      g.setAttribute("data-wall-id", String(wall.id || ""));
      g.setAttribute("transform", `translate(${ox} ${oy}) rotate(${ang}) scale(${inv})`);
      const tw = document.createElementNS(NS, "text");
      tw.setAttribute("text-anchor", "middle");
      tw.setAttribute("y", "-4");
      tw.setAttribute("class", "svg-floor-dim-label svg-floor-dim-label--wall");
      tw.setAttribute("font-size", "11");
      tw.textContent = `${Math.round(len)} cm`;
      g.appendChild(tw);
      layer.appendChild(g);
    }
  }

  innerG.appendChild(layer);
}

function appendPolygonIfValid(
  innerG,
  poly,
  className,
  dataAttrs = {},
  snapCoord = identitySnapCoord,
  extraAttrs = {},
) {
  if (!Array.isArray(poly) || poly.length < 3) return;
  const pts = poly
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => `${snapCoord(Number(p[0]))},${snapCoord(Number(p[1]))}`)
    .join(" ");
  if (!pts) return;
  const el = document.createElementNS(NS, "polygon");
  el.setAttribute("points", pts);
  el.setAttribute("class", className);
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v != null && v !== "") el.setAttribute(k, String(v));
  }
  if (extraAttrs.fill != null && String(extraAttrs.fill).trim() !== "") {
    el.setAttribute("fill", String(extraAttrs.fill));
  }
  innerG.appendChild(el);
}

function appendLineIfValid(innerG, x1, y1, x2, y2, className, strokeWidth, dataAttrs = {}, snapCoord = identitySnapCoord) {
  x1 = snapCoord(x1);
  y1 = snapCoord(y1);
  x2 = snapCoord(x2);
  y2 = snapCoord(y2);
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(n))) return;
  const line = document.createElementNS(NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.setAttribute("stroke-width", String(strokeWidth));
  line.setAttribute("class", className);
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v != null && v !== "") line.setAttribute(k, String(v));
  }
  innerG.appendChild(line);
}

const WALL_JOIN_POINT_EPS_CM = 0.8;

function dist2PointToSegmentCm(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const vv = vx * vx + vy * vy;
  if (vv < 1e-12) {
    const dx = px - ax;
    const dy = py - ay;
    return dx * dx + dy * dy;
  }
  const wx = px - ax;
  const wy = py - ay;
  const tRaw = (wx * vx + wy * vy) / vv;
  const t = Math.max(0, Math.min(1, tRaw));
  const qx = ax + vx * t;
  const qy = ay + vy * t;
  const dx = px - qx;
  const dy = py - qy;
  return dx * dx + dy * dy;
}

/**
 * 平面墙线补角：端点接到其它墙（L/T）时，按相交墙半厚度延伸，避免缺角。
 * @returns {{ x1: number, y1: number, x2: number, y2: number }}
 */
function getExtendedWallSegmentCm(wall, walls, snapCoord = identitySnapCoord) {
  if (!wall || !Array.isArray(wall.start) || wall.start.length < 2 || !Array.isArray(wall.end) || wall.end.length < 2) {
    return { x1: NaN, y1: NaN, x2: NaN, y2: NaN };
  }
  const sx = snapCoord(Number(wall.start[0]));
  const sy = snapCoord(Number(wall.start[1]));
  const ex = snapCoord(Number(wall.end[0]));
  const ey = snapCoord(Number(wall.end[1]));
  const dx = ex - sx;
  const dy = ey - sy;
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < 1e-6) return { x1: sx, y1: sy, x2: ex, y2: ey };
  const ux = dx / len;
  const uy = dy / len;
  const wid = String(wall.id ?? "").trim();
  const eps2 = WALL_JOIN_POINT_EPS_CM * WALL_JOIN_POINT_EPS_CM;
  let startExt = 0;
  let endExt = 0;

  for (const other of walls || []) {
    if (!other || !Array.isArray(other.start) || other.start.length < 2 || !Array.isArray(other.end) || other.end.length < 2) {
      continue;
    }
    const oid = String(other.id ?? "").trim();
    if (wid && oid && wid === oid) continue;
    const ax = snapCoord(Number(other.start[0]));
    const ay = snapCoord(Number(other.start[1]));
    const bx = snapCoord(Number(other.end[0]));
    const by = snapCoord(Number(other.end[1]));
    if (![ax, ay, bx, by].every((v) => Number.isFinite(v))) continue;
    if (Math.hypot(bx - ax, by - ay) < 1e-6) continue;

    const oth = Number(other.thickness);
    const candidate = Math.max(0, (Number.isFinite(oth) && oth > 0 ? oth : 10) / 2);
    if (candidate < 1e-6) continue;

    if (dist2PointToSegmentCm(sx, sy, ax, ay, bx, by) <= eps2) startExt = Math.max(startExt, candidate);
    if (dist2PointToSegmentCm(ex, ey, ax, ay, bx, by) <= eps2) endExt = Math.max(endExt, candidate);
  }

  return {
    x1: sx - ux * startExt,
    y1: sy - uy * startExt,
    x2: ex + ux * endExt,
    y2: ey + uy * endExt,
  };
}

/**
 * 绘制 opening：优先 polygon → 线段 start/end → wallId+pos+width → position + length + angleDeg
 */
function appendOpening(innerG, obj, className, defaultStroke, snapCoord = identitySnapCoord, walls = null) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.polygon) && obj.polygon.length >= 3) {
    appendPolygonIfValid(innerG, obj.polygon, className, {
      "data-opening-id": String(obj.id || ""),
    }, snapCoord);
    return;
  }
  if (Array.isArray(obj.start) && Array.isArray(obj.end) && obj.start.length >= 2 && obj.end.length >= 2) {
    const sw = Number(obj.strokeWidthCm ?? obj.strokeWidthMm ?? obj.frameThicknessCm ?? obj.frameThicknessMm ?? defaultStroke);
    appendLineIfValid(
      innerG,
      Number(obj.start[0]),
      Number(obj.start[1]),
      Number(obj.end[0]),
      Number(obj.end[1]),
      className,
      Number.isFinite(sw) && sw > 0 ? sw : defaultStroke,
      { "data-opening-id": String(obj.id || "") },
      snapCoord,
    );
    return;
  }
  const wallSeg = openingSegmentOnWall(obj, walls);
  if (wallSeg) {
    const sw = Number(obj.strokeWidthCm ?? obj.strokeWidthMm ?? obj.frameThicknessCm ?? obj.frameThicknessMm ?? defaultStroke);
    appendLineIfValid(
      innerG,
      wallSeg.x0,
      wallSeg.y0,
      wallSeg.x1,
      wallSeg.y1,
      className,
      Number.isFinite(sw) && sw > 0 ? sw : defaultStroke,
      { "data-opening-id": String(obj.id || "") },
      snapCoord,
    );
    return;
  }
  const pos = readPlanPoint2d(obj);
  const L = Number(obj.lengthCm ?? obj.lengthMm ?? obj.length);
  const ang = Number(obj.angleDeg ?? obj.angle ?? obj.rotationDeg ?? 0);
  if (pos && Number.isFinite(L) && L > 0) {
    const x0 = Number(pos[0]);
    const y0 = Number(pos[1]);
    const rad = (ang * Math.PI) / 180;
    const x1 = x0 + L * Math.cos(rad);
    const y1 = y0 + L * Math.sin(rad);
    const sw = Number(obj.strokeWidthCm ?? obj.strokeWidthMm ?? defaultStroke);
    appendLineIfValid(
      innerG,
      x0,
      y0,
      x1,
      y1,
      className,
      Number.isFinite(sw) && sw > 0 ? sw : defaultStroke,
      { "data-opening-id": String(obj.id || "") },
      snapCoord,
    );
  }
}

function hexColorToRgbComponents(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 窗洞平面填充（与门洞同几何），fill 随 window.style 的 color + opacity */
function appendWindowFillPolygon(innerG, win, walls, snapCoord = identitySnapCoord) {
  const seg = openingSegmentOnWall(win, walls);
  if (!seg) return;
  const wid = String(win.wallId ?? "").trim();
  const wall = walls.find((w) => String(w?.id ?? "") === wid);
  const th = Number(wall?.thickness);
  const half = (Number.isFinite(th) && th > 0 ? th : 12) / 2;
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const poly = [
    [seg.x0 + nx, seg.y0 + ny],
    [seg.x1 + nx, seg.y1 + ny],
    [seg.x1 - nx, seg.y1 - ny],
    [seg.x0 - nx, seg.y0 - ny],
  ];
  const ns =
    win.style != null && typeof win.style === "object" && !Array.isArray(win.style)
      ? normalizeWindowStyle(win.style)
      : defaultWindowStyleWhite();
  const rgb = hexColorToRgbComponents(ns.color);
  const op = Math.min(0.94, Math.max(ns.opacity, ns.opacity * 1.28 + 0.06));
  const fillStr = rgb ? `rgba(${rgb.r},${rgb.g},${rgb.b},${op})` : ns.color;
  const styleAttr =
    win.style != null && typeof win.style === "object"
      ? JSON.stringify(win.style)
      : win.style != null
        ? String(win.style)
        : "";
  appendPolygonIfValid(
    innerG,
    poly,
    "svg-floor-window-fill",
    {
      "data-window-id": String(win.id || ""),
      "data-window-type": ns.type,
      ...(styleAttr !== "" ? { "data-window-style": styleAttr } : {}),
    },
    snapCoord,
    { fill: fillStr },
  );
}

/** 门洞平面填充（墙厚方向展开四边形），颜色随 door.style（含 roughness/metalness/color/texture） */
function appendDoorFillPolygon(innerG, door, walls, snapCoord = identitySnapCoord) {
  const seg = openingSegmentOnWall(door, walls);
  if (!seg) return;
  const wid = String(door.wallId ?? "").trim();
  const wall = walls.find((w) => String(w?.id ?? "") === wid);
  const th = Number(wall?.thickness);
  const half = (Number.isFinite(th) && th > 0 ? th : 12) / 2;
  const dx = seg.x1 - seg.x0;
  const dy = seg.y1 - seg.y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * half;
  const ny = (dx / len) * half;
  const poly = [
    [seg.x0 + nx, seg.y0 + ny],
    [seg.x1 + nx, seg.y1 + ny],
    [seg.x1 - nx, seg.y1 - ny],
    [seg.x0 - nx, seg.y0 - ny],
  ];
  const ns =
    door.style != null && typeof door.style === "object" && !Array.isArray(door.style)
      ? normalizeDoorStyle(door.style)
      : defaultDoorStyleWhite();
  const styleAttr =
    door.style != null && typeof door.style === "object"
      ? JSON.stringify(door.style)
      : door.style != null
        ? String(door.style)
        : "";
  appendPolygonIfValid(
    innerG,
    poly,
    "svg-floor-door-fill",
    {
      "data-door-id": String(door.id || ""),
      ...(styleAttr !== "" ? { "data-door-style": styleAttr } : {}),
    },
    snapCoord,
    { fill: ns.color },
  );

  const tH = 0.82;
  const hx = seg.x0 + tH * (seg.x1 - seg.x0);
  const hy = seg.y0 + tH * (seg.y1 - seg.y0);
  const pnx = -dy / len;
  const pny = dx / len;
  const off = Math.min(half * 0.42, 5);
  for (const s of [-1, 1]) {
    const tcx = hx + s * pnx * off;
    const tcy = hy + s * pny * off;
    const hc = document.createElementNS(NS, "circle");
    hc.setAttribute("cx", String(snapCoord(tcx)));
    hc.setAttribute("cy", String(snapCoord(tcy)));
    hc.setAttribute("r", String(snapCoord(4)));
    hc.setAttribute("class", "svg-floor-door-handle");
    hc.setAttribute("data-door-id", String(door.id || ""));
    innerG.appendChild(hc);
  }
}

/**
 * 模板层内嵌家具：polygon / 线段 / positionCm+宽高（cm）+旋转
 */
function appendFloorFurniture(innerG, f, snapCoord = identitySnapCoord) {
  if (!f || typeof f !== "object") return;
  const fid = String(f.furnitureId ?? f.modelId ?? f.id ?? "").trim();

  if (Array.isArray(f.polygon) && f.polygon.length >= 3) {
    appendPolygonIfValid(innerG, f.polygon, "svg-floor-embed-furniture", {
      "data-furniture-id": fid,
      "data-embed-id": String(f.instanceId ?? f.id ?? ""),
    }, snapCoord);
    return;
  }
  if (Array.isArray(f.start) && Array.isArray(f.end) && f.start.length >= 2 && f.end.length >= 2) {
    const sw = Number(f.thicknessCm ?? f.thicknessMm ?? f.strokeWidthCm ?? f.strokeWidthMm ?? 8);
    appendLineIfValid(
      innerG,
      Number(f.start[0]),
      Number(f.start[1]),
      Number(f.end[0]),
      Number(f.end[1]),
      "svg-floor-embed-furniture svg-floor-embed-furniture--line",
      Number.isFinite(sw) && sw > 0 ? sw : 8,
      { "data-furniture-id": fid, "data-embed-id": String(f.instanceId ?? f.id ?? "") },
      snapCoord,
    );
    return;
  }

  const pm = readPlanPoint2d(f);
  if (!pm) return;
  const cx = snapCoord(Number(pm[0]));
  const cy = snapCoord(Number(pm[1]));
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  const w = Number(f.widthCm ?? f.widthMm ?? f.width ?? 80);
  const d = Number(f.depthCm ?? f.depthMm ?? f.depth ?? 80);
  let wf = Number.isFinite(w) && w > 0 ? snapCoord(w) : snapCoord(80);
  let df = Number.isFinite(d) && d > 0 ? snapCoord(d) : snapCoord(80);
  if (wf < 1) wf = 1;
  if (df < 1) df = 1;
  const hw = wf / 2;
  const hd = df / 2;
  const rot = Number(f.rotationDeg ?? f.rotation ?? 0);

  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "svg-floor-embed-furniture svg-floor-embed-furniture--box");
  g.setAttribute("transform", `translate(${cx} ${cy}) rotate(${rot})`);
  if (fid) g.setAttribute("data-furniture-id", fid);
  if (f.instanceId != null || f.id != null) {
    g.setAttribute("data-embed-id", String(f.instanceId ?? f.id ?? ""));
  }

  const rect = document.createElementNS(NS, "rect");
  rect.setAttribute("x", String(-hw));
  rect.setAttribute("y", String(-hd));
  rect.setAttribute("width", String(wf));
  rect.setAttribute("height", String(df));
  rect.setAttribute("rx", "1");
  g.appendChild(rect);
  innerG.appendChild(g);
}

/**
 * @param {object} floor 单层对象
 * @param {SVGGElement} innerG
 * @param {{ planUnitsPerWorldGrid?: number, dimensionLabelInverseScale?: number }} [options]
 *   dimensionLabelInverseScale：户型 transform 中 scale(s) 的倒数 1/s，用于标注文字不随户型缩放糊成一团
 */
export function appendFloorGeometryToGroup(floor, innerG, options = {}) {
  if (!floor || !innerG) return;
  const step = options.planUnitsPerWorldGrid;
  const snapCoord = makePlanUnitSnapper(step);

  /* 1. 房间面 */
  for (const room of floor.rooms || []) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const rs = room?.style;
    const styleForClass = rs != null && typeof rs === "object" && !Array.isArray(rs) ? rs.floor : rs;
    const t = safeTypeClass(room?.type ?? styleForClass);
    const el = document.createElementNS(NS, "polygon");
    const pts = poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => `${snapCoord(Number(p[0]))},${snapCoord(Number(p[1]))}`)
      .join(" ");
    if (!pts) continue;
    el.setAttribute("points", pts);
    el.setAttribute("class", `svg-floor-room${t !== "default" ? ` svg-floor-room--${t}` : ""}`);
    el.setAttribute("data-room-id", String(room.id || ""));
    const rn = String(room.name || "").trim();
    if (rn) el.setAttribute("title", rn);
    innerG.appendChild(el);
  }

  /* 2. 墙（中心线 + 厚度） */
  const walls = floor.walls || [];
  for (const wall of floor.walls || []) {
    if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end) || wall.start.length < 2 || wall.end.length < 2) {
      continue;
    }
    const th = Number(wall.thickness);
    const seg = getExtendedWallSegmentCm(wall, walls, snapCoord);
    appendLineIfValid(
      innerG,
      seg.x1,
      seg.y1,
      seg.x2,
      seg.y2,
      "svg-floor-wall",
      Number.isFinite(th) && th > 0 ? th : 10,
      { "data-wall-id": String(wall.id || "") },
      snapCoord,
    );
  }

  const wallsForOpenings = walls;

  /* 3. 窗洞填充（平面） */
  for (const win of floor.windows || []) {
    appendWindowFillPolygon(innerG, win, wallsForOpenings, snapCoord);
  }

  /* 3.1 窗线（笔宽与墙厚同坐标系 cm，略粗更易辨认） */
  for (const win of floor.windows || []) {
    appendOpening(innerG, win, "svg-floor-window", 11, snapCoord, wallsForOpenings);
  }

  /* 3.5 门洞填充（平面） */
  for (const door of floor.doors || []) {
    appendDoorFillPolygon(innerG, door, wallsForOpenings, snapCoord);
  }

  /* 4. 门 */
  for (const door of floor.doors || []) {
    appendOpening(innerG, door, "svg-floor-door", 14, snapCoord, wallsForOpenings);
  }

  /* 5. 层内模板家具 */
  for (const fu of floor.furnitures || []) {
    appendFloorFurniture(innerG, fu, snapCoord);
  }

  const inv = options.dimensionLabelInverseScale;
  if (Number.isFinite(inv) && inv > 0) {
    appendFloorDimensionAnnotations(floor, innerG, snapCoord, inv);
  }
}

/**
 * @param {object} entry 户型目录条目（根级含 floors[]）
 * @returns {object | null} 首层或唯一一层
 */
export function getPrimaryFloor(entry) {
  const floors = entry?.floors;
  if (!Array.isArray(floors) || !floors.length) return null;
  return floors[0];
}
