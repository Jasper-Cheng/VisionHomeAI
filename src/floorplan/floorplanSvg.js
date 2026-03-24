/**
 * 单层 floors[i] → SVG 局部几何（毫米坐标，由 svgEditor 外层 transform 统一缩放平移）
 * 遍历该层内 rooms / walls / doors / windows / furnitures；3D 属性（height、elevation 等）不参与 2D 绘制。
 */

const NS = "http://www.w3.org/2000/svg";

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
 * positionMm / position + width/depth + rotationDeg → 旋转矩形四角入 bbox
 * @param {object} obj
 * @param {(x: number, y: number) => void} pt
 */
function bboxFromPositionFootprint(obj, pt) {
  if (!obj || typeof obj !== "object") return;
  const pm = obj.positionMm ?? obj.position;
  if (!Array.isArray(pm) || pm.length < 2) return;
  const cx = Number(pm[0]);
  const cy = Number(pm[1]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  const w = Number(obj.widthMm ?? obj.width ?? 800);
  const d = Number(obj.depthMm ?? obj.depth ?? 800);
  const hw = Number.isFinite(w) && w > 0 ? w / 2 : 400;
  const hd = Number.isFinite(d) && d > 0 ? d / 2 : 400;
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

  const pos = obj.position ?? obj.positionMm;
  const L = Number(obj.lengthMm ?? obj.length);
  const ang = Number(obj.angleDeg ?? obj.angle ?? obj.rotationDeg ?? 0);
  if (Array.isArray(pos) && pos.length >= 2 && Number.isFinite(L) && L > 0) {
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
 * @param {object} floor
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, cx: number, cy: number, w: number, h: number } | null}
 */
export function getFloorBBoxMm(floor) {
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
  for (const d of floor.doors || []) {
    bboxFromOpeningLike(d, pt);
  }
  for (const w of floor.windows || []) {
    bboxFromOpeningLike(w, pt);
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

function appendPolygonIfValid(innerG, poly, className, dataAttrs = {}) {
  if (!Array.isArray(poly) || poly.length < 3) return;
  const pts = poly
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => `${Number(p[0])},${Number(p[1])}`)
    .join(" ");
  if (!pts) return;
  const el = document.createElementNS(NS, "polygon");
  el.setAttribute("points", pts);
  el.setAttribute("class", className);
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v != null && v !== "") el.setAttribute(k, String(v));
  }
  innerG.appendChild(el);
}

function appendLineIfValid(innerG, x1, y1, x2, y2, className, strokeWidth, dataAttrs = {}) {
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

/**
 * 绘制 opening：优先 polygon → 线段 start/end → position + length + angleDeg
 */
function appendOpening(innerG, obj, className, defaultStroke) {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj.polygon) && obj.polygon.length >= 3) {
    appendPolygonIfValid(innerG, obj.polygon, className, {
      "data-opening-id": String(obj.id || ""),
    });
    return;
  }
  if (Array.isArray(obj.start) && Array.isArray(obj.end) && obj.start.length >= 2 && obj.end.length >= 2) {
    const sw = Number(obj.strokeWidthMm ?? obj.frameThicknessMm ?? defaultStroke);
    appendLineIfValid(
      innerG,
      Number(obj.start[0]),
      Number(obj.start[1]),
      Number(obj.end[0]),
      Number(obj.end[1]),
      className,
      Number.isFinite(sw) && sw > 0 ? sw : defaultStroke,
      { "data-opening-id": String(obj.id || "") },
    );
    return;
  }
  const pos = obj.position ?? obj.positionMm;
  const L = Number(obj.lengthMm ?? obj.length);
  const ang = Number(obj.angleDeg ?? obj.angle ?? obj.rotationDeg ?? 0);
  if (Array.isArray(pos) && pos.length >= 2 && Number.isFinite(L) && L > 0) {
    const x0 = Number(pos[0]);
    const y0 = Number(pos[1]);
    const rad = (ang * Math.PI) / 180;
    const x1 = x0 + L * Math.cos(rad);
    const y1 = y0 + L * Math.sin(rad);
    const sw = Number(obj.strokeWidthMm ?? defaultStroke);
    appendLineIfValid(
      innerG,
      x0,
      y0,
      x1,
      y1,
      className,
      Number.isFinite(sw) && sw > 0 ? sw : defaultStroke,
      { "data-opening-id": String(obj.id || "") },
    );
  }
}

/**
 * 模板层内嵌家具：polygon / 线段 / positionMm+宽高+旋转
 */
function appendFloorFurniture(innerG, f) {
  if (!f || typeof f !== "object") return;
  const fid = String(f.furnitureId ?? f.modelId ?? f.id ?? "").trim();

  if (Array.isArray(f.polygon) && f.polygon.length >= 3) {
    appendPolygonIfValid(innerG, f.polygon, "svg-floor-embed-furniture", {
      "data-furniture-id": fid,
      "data-embed-id": String(f.instanceId ?? f.id ?? ""),
    });
    return;
  }
  if (Array.isArray(f.start) && Array.isArray(f.end) && f.start.length >= 2 && f.end.length >= 2) {
    const sw = Number(f.thicknessMm ?? f.strokeWidthMm ?? 80);
    appendLineIfValid(
      innerG,
      Number(f.start[0]),
      Number(f.start[1]),
      Number(f.end[0]),
      Number(f.end[1]),
      "svg-floor-embed-furniture svg-floor-embed-furniture--line",
      Number.isFinite(sw) && sw > 0 ? sw : 80,
      { "data-furniture-id": fid, "data-embed-id": String(f.instanceId ?? f.id ?? "") },
    );
    return;
  }

  const pm = f.positionMm ?? f.position;
  if (!Array.isArray(pm) || pm.length < 2) return;
  const cx = Number(pm[0]);
  const cy = Number(pm[1]);
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;

  const w = Number(f.widthMm ?? f.width ?? 800);
  const d = Number(f.depthMm ?? f.depth ?? 800);
  const hw = Number.isFinite(w) && w > 0 ? w / 2 : 400;
  const hd = Number.isFinite(d) && d > 0 ? d / 2 : 400;
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
  rect.setAttribute("width", String(hw * 2));
  rect.setAttribute("height", String(hd * 2));
  rect.setAttribute("rx", "6");
  g.appendChild(rect);
  innerG.appendChild(g);
}

/**
 * @param {object} floor 单层对象
 * @param {SVGGElement} innerG
 */
export function appendFloorGeometryToGroup(floor, innerG) {
  if (!floor || !innerG) return;

  /* 1. 房间面 */
  for (const room of floor.rooms || []) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const t = safeTypeClass(room?.type);
    const el = document.createElementNS(NS, "polygon");
    const pts = poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => `${Number(p[0])},${Number(p[1])}`)
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
  for (const wall of floor.walls || []) {
    if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end) || wall.start.length < 2 || wall.end.length < 2) {
      continue;
    }
    const th = Number(wall.thickness);
    appendLineIfValid(
      innerG,
      Number(wall.start[0]),
      Number(wall.start[1]),
      Number(wall.end[0]),
      Number(wall.end[1]),
      "svg-floor-wall",
      Number.isFinite(th) && th > 0 ? th : 100,
      { "data-wall-id": String(wall.id || "") },
    );
  }

  /* 3. 窗 */
  for (const win of floor.windows || []) {
    appendOpening(innerG, win, "svg-floor-window", 60);
  }

  /* 4. 门 */
  for (const door of floor.doors || []) {
    appendOpening(innerG, door, "svg-floor-door", 80);
  }

  /* 5. 层内模板家具 */
  for (const fu of floor.furnitures || []) {
    appendFloorFurniture(innerG, fu);
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
