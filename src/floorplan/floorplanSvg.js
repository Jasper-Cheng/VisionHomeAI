/**
 * 单层 floors[i] → SVG 局部几何（厘米坐标，与画布 3000×3000 cm 一致；由 svgEditor 外层 transform 缩放平移）
 * 遍历该层内 rooms / walls / doors / windows / furnitures；3D 属性（height、elevation 等）不参与 2D 绘制。
 */

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

  /** 房间标注内缩（plan cm），贴在右下角内侧 */
  const ROOM_BR_PAD = 10;
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
    const brY = box.maxY - ROOM_BR_PAD;

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
    let nLines = 0;
    if (name) nLines += 1;
    nLines += 1;
    if (arM2 >= 0.01) nLines += 1;
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
    if (name) addTspan(name.length > 16 ? `${name.slice(0, 15)}…` : name, "svg-floor-dim-label__name");
    addTspan(`${wR}×${hR} cm`);
    if (arM2 >= 0.01) {
      addTspan(arM2 >= 100 ? `≈ ${arM2.toFixed(1)} m²` : `≈ ${arM2.toFixed(2)} m²`);
    }
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

function appendPolygonIfValid(innerG, poly, className, dataAttrs = {}, snapCoord = identitySnapCoord) {
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

/**
 * 绘制 opening：优先 polygon → 线段 start/end → position + length + angleDeg
 */
function appendOpening(innerG, obj, className, defaultStroke, snapCoord = identitySnapCoord) {
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
    const t = safeTypeClass(room?.type);
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
      Number.isFinite(th) && th > 0 ? th : 10,
      { "data-wall-id": String(wall.id || "") },
      snapCoord,
    );
  }

  /* 3. 窗 */
  for (const win of floor.windows || []) {
    appendOpening(innerG, win, "svg-floor-window", 6, snapCoord);
  }

  /* 4. 门 */
  for (const door of floor.doors || []) {
    appendOpening(innerG, door, "svg-floor-door", 8, snapCoord);
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
