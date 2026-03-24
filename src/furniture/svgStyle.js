/**
 * 2D SVG 家具占位样式（无 fetch 依赖，供 svgEditor 与家具库 UI 共用）
 */

/** JSON category → 中文（标签 / Tab） */
export const CATEGORY_LABELS = {
  sofa: "沙发",
  table: "桌几",
  bed: "床",
  lamp: "灯具",
  rug: "地毯",
  cabinet: "柜类",
  plant: "绿植",
};

const CATEGORY_STYLES = {
  sofa: { fill: "rgba(109,92,255,0.42)", stroke: "rgba(140,120,255,0.95)" },
  table: { fill: "rgba(34,197,94,0.35)", stroke: "rgba(74,222,128,0.9)" },
  lamp: { fill: "rgba(251,191,36,0.4)", stroke: "rgba(252,211,77,0.95)" },
  rug: { fill: "rgba(244,63,94,0.28)", stroke: "rgba(251,113,133,0.85)" },
  cabinet: { fill: "rgba(148,163,184,0.4)", stroke: "rgba(203,213,225,0.9)" },
  plant: { fill: "rgba(16,185,129,0.38)", stroke: "rgba(52,211,153,0.9)" },
  bed: { fill: "rgba(168,85,247,0.35)", stroke: "rgba(196,181,253,0.92)" },
  default: { fill: "rgba(100,116,139,0.38)", stroke: "rgba(148,163,184,0.9)" },
};

/**
 * 2D SVG 示意矩形：半宽/半高与颜色（画布单位 = cm，与 sofa 210×90 cm 标定一致）
 * @param {object} item 家具库 JSON 单条
 */
/** 与家具库 JSON 一致的展示名（优先 name，兼容 label/title） */
export function getFurnitureDisplayName(item) {
  if (!item) return "";
  const raw = item.name ?? item.label ?? item.title ?? item.id ?? "";
  const s = String(raw).trim();
  return s || String(item.id || "").trim();
}

/**
 * 家具 JSON 可选 `polygon`：[[x,y],…] 或 [{x,y},…]，单位 cm，原点 = 外轮廓轴对齐包围盒中心（与 anchor 0.5/0.5 一致）
 * @returns {{ x: number, y: number }[] | null}
 */
export function parseFurniturePolygonPoints(item) {
  const raw = item?.polygon;
  if (!Array.isArray(raw) || raw.length < 3) return null;
  const out = [];
  for (const p of raw) {
    let x;
    let y;
    if (Array.isArray(p) && p.length >= 2) {
      x = Number(p[0]);
      y = Number(p[1]);
    } else if (p && typeof p === "object") {
      x = Number(p.x);
      y = Number(p.y);
    } else {
      return null;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

export function getSvgStyleForItem(item) {
  if (!item?.size) return null;
  const cat = item.category || "default";
  const pal = CATEGORY_STYLES[cat] || CATEGORY_STYLES.default;
  const w = Number(item.size.width) || 210;
  const d = Number(item.size.depth) || 90;
  const h = Number(item.size.height);
  /* 画布 1 单位 = 1 cm；外接尺寸只认 size，polygon 仅决定外形（svgEditor 内再缩放到此外接框） */
  const hw = Math.max(8, w / 2);
  const hh = Math.max(8, d / 2);
  const polyPts = parseFurniturePolygonPoints(item);
  const nameFull = getFurnitureDisplayName(item) || String(item.id || "").trim() || CATEGORY_LABELS[cat] || "?";
  const dimLine = `${Math.round(w)}×${Math.round(d)} cm`;
  const heightLine = Number.isFinite(h) && h > 0 ? `高 ${Math.round(h)} cm` : "";
  return {
    fill: pal.fill,
    stroke: pal.stroke,
    longName: nameFull,
    nameFull,
    dimLine,
    heightLine,
    hw,
    hh,
    sizeW: w,
    sizeD: d,
    polygonPoints: polyPts || undefined,
  };
}
