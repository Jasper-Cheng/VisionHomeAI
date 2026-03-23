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
 * 2D SVG 示意矩形：半宽/半高与颜色（户型画布单位，与旧 sofa 2100×900 标定一致）
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
 * 画在平面图矩形里的文字：优先 JSON 名称，过长按宽度截断；无名称时才用分类中文
 */
function svgLabelFromItem(item, cat, hw, hh) {
  const full = getFurnitureDisplayName(item);
  const maxChars = Math.max(4, Math.min(16, Math.floor(((hw + hh) * 2) / 26)));
  if (full.length <= maxChars) return full || CATEGORY_LABELS[cat] || item?.id || "?";
  return `${full.slice(0, maxChars - 1)}…`;
}

export function getSvgStyleForItem(item) {
  if (!item?.size) return null;
  const cat = item.category || "default";
  const pal = CATEGORY_STYLES[cat] || CATEGORY_STYLES.default;
  const w = Number(item.size.width) || 1000;
  const d = Number(item.size.depth) || 1000;
  const hw = Math.max(12, (w / 2100) * 112);
  const hh = Math.max(12, (d / 900) * 50);
  const longName = getFurnitureDisplayName(item);
  const label = svgLabelFromItem(item, cat, hw, hh);
  return {
    fill: pal.fill,
    stroke: pal.stroke,
    label,
    longName: longName || item.id,
    hw,
    hh,
  };
}
