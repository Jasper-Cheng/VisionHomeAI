/**
 * 户型 JSON（floors[].rooms / walls）→ SVG 局部几何（毫米坐标，再由外层 transform 缩放平移）
 */

const NS = "http://www.w3.org/2000/svg";

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

  for (const w of floor.walls || []) {
    if (Array.isArray(w?.start) && w.start.length >= 2) pt(Number(w.start[0]), Number(w.start[1]));
    if (Array.isArray(w?.end) && w.end.length >= 2) pt(Number(w.end[0]), Number(w.end[1]));
  }
  for (const room of floor.rooms || []) {
    for (const p of room.polygon || []) {
      if (Array.isArray(p) && p.length >= 2) pt(Number(p[0]), Number(p[1]));
    }
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

/**
 * @param {object} floor
 * @param {SVGGElement} innerG
 */
export function appendFloorGeometryToGroup(floor, innerG) {
  if (!floor || !innerG) return;

  for (const room of floor.rooms || []) {
    const poly = room.polygon;
    if (!Array.isArray(poly) || poly.length < 3) continue;
    const pts = poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => `${Number(p[0])},${Number(p[1])}`)
      .join(" ");
    if (!pts) continue;
    const el = document.createElementNS(NS, "polygon");
    el.setAttribute("points", pts);
    const t = String(room.type || "default").replace(/[^a-z0-9_-]/gi, "");
    el.setAttribute("class", `svg-floor-room${t ? ` svg-floor-room--${t}` : ""}`);
    el.setAttribute("data-room-id", String(room.id || ""));
    innerG.appendChild(el);
  }

  for (const wall of floor.walls || []) {
    if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end) || wall.start.length < 2 || wall.end.length < 2) {
      continue;
    }
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(wall.start[0]));
    line.setAttribute("y1", String(wall.start[1]));
    line.setAttribute("x2", String(wall.end[0]));
    line.setAttribute("y2", String(wall.end[1]));
    const th = Number(wall.thickness);
    line.setAttribute("stroke-width", String(Number.isFinite(th) && th > 0 ? th : 100));
    line.setAttribute("class", "svg-floor-wall");
    line.setAttribute("data-wall-id", String(wall.id || ""));
    innerG.appendChild(line);
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
