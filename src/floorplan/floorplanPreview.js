/**
 * 户型库卡片缩略图：优先 project.thumbnail / thumbnail 图片；否则用 floors[0] 几何生成矢量预览
 */
import { appendFloorGeometryToGroup, getFloorBBoxCm } from "./floorplanSvg.js";

const NS = "http://www.w3.org/2000/svg";

const THUMB_VARIANTS = ["", "thumb-skeleton--green", "thumb-skeleton--warm", "thumb-skeleton--red", "thumb-skeleton--gray", "thumb-skeleton--blue"];

export function resolveFloorplanAssetUrl(pathFromRoot) {
  if (!pathFromRoot) return "";
  const clean = String(pathFromRoot).replace(/^\//, "");
  return `./${clean}`;
}

/**
 * @param {object} entry 户型目录条目
 * @returns {string[]}
 */
export function getFloorplanThumbnailUrls(entry) {
  const t = entry?.thumbnail ?? entry?.project?.thumbnail;
  if (t == null) return [];
  const s = String(t).trim();
  return s ? [resolveFloorplanAssetUrl(s)] : [];
}

/**
 * @param {HTMLElement} thumbEl .asset-thumb
 * @param {object} entry
 * @param {number} idx 骨架配色轮询
 */
export function mountFloorplanThumb(thumbEl, entry, idx = 0) {
  const variant = THUMB_VARIANTS[idx % THUMB_VARIANTS.length];
  const paths = getFloorplanThumbnailUrls(entry);

  if (paths.length) {
    const placeholder = document.createElement("div");
    placeholder.className = variant ? `thumb-skeleton ${variant}` : "thumb-skeleton";
    const img = document.createElement("img");
    img.className = "asset-thumb-img";
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.draggable = false;
    let i = 0;
    img.onload = () => {
      thumbEl.classList.add("has-image");
      placeholder.remove();
    };
    img.onerror = () => {
      i += 1;
      if (i < paths.length) img.src = paths[i];
      else {
        img.remove();
        appendVectorPreview(thumbEl, entry, variant, placeholder);
      }
    };
    img.src = paths[0];
    thumbEl.appendChild(img);
    thumbEl.appendChild(placeholder);
    return;
  }

  const sk = document.createElement("div");
  sk.className = variant ? `thumb-skeleton ${variant}` : "thumb-skeleton";
  appendVectorPreview(thumbEl, entry, variant, sk);
}

/**
 * @param {HTMLElement} thumbEl
 * @param {object} entry
 * @param {string} variant
 * @param {HTMLElement} fallbackEl 矢量失败时保留的骨架节点
 */
function appendVectorPreview(thumbEl, entry, variant, fallbackEl) {
  const floors = Array.isArray(entry?.floors) ? entry.floors.filter(Boolean) : [];
  if (!floors.length) {
    thumbEl.appendChild(fallbackEl);
    return;
  }

  const prepared = floors
    .map((floor) => ({ floor, bbox: getFloorBBoxCm(floor) }))
    .filter((x) => x.bbox && x.bbox.w >= 1e-9 && x.bbox.h >= 1e-9);

  if (!prepared.length) {
    thumbEl.appendChild(fallbackEl);
    return;
  }

  if (prepared.length === 1) {
    const { floor, bbox } = prepared[0];
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("class", "floorplan-thumb-svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");

    const pad = 8;
    const inner = 100 - 2 * pad;
    const s = Math.min(inner / bbox.w, inner / bbox.h) * 0.94;

    const g = document.createElementNS(NS, "g");
    g.setAttribute(
      "transform",
      `translate(50 50) scale(${s}) translate(${-bbox.cx} ${-bbox.cy})`,
    );
    appendFloorGeometryToGroup(floor, g);
    svg.appendChild(g);

    thumbEl.appendChild(svg);
    thumbEl.classList.add("has-image");
    if (fallbackEl.isConnected) fallbackEl.remove();
    return;
  }

  /**
   * 多层：立面「正前方」叠层——下为一层（floor[0]），向上依次为更高楼层，
   * 每层在独立横带内做平面投影，水平居中，与编辑画布同向（无额外旋转）。
   */
  const pad = 6;
  const gap = 1.35;
  const n = prepared.length;
  const usableH = 100 - 2 * pad;
  const bandH = (usableH - (n - 1) * gap) / n;
  const innerW = 100 - 2 * pad;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "floorplan-thumb-svg floorplan-thumb-svg--multi");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("aria-hidden", "true");

  for (let fi = 0; fi < n; fi++) {
    const { floor, bbox } = prepared[fi];
    const yBottom = 100 - pad - fi * (bandH + gap);
    const yTop = yBottom - bandH;
    const cyRow = (yTop + yBottom) / 2;

    const s = Math.min(innerW / bbox.w, bandH / bbox.h) * 0.9;

    const g = document.createElementNS(NS, "g");
    g.setAttribute(
      "transform",
      `translate(50 ${cyRow}) scale(${s}) translate(${-bbox.cx} ${-bbox.cy})`,
    );
    appendFloorGeometryToGroup(floor, g);
    svg.appendChild(g);
  }

  thumbEl.appendChild(svg);
  thumbEl.classList.add("has-image");
  if (fallbackEl.isConnected) fallbackEl.remove();
}
