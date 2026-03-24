/**
 * 户型库卡片缩略图：优先 project.thumbnail / thumbnail 图片；否则用 floors[0] 几何生成矢量预览
 */
import { appendFloorGeometryToGroup, getFloorBBoxMm, getPrimaryFloor } from "./floorplanSvg.js";

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
  const floor = getPrimaryFloor(entry);
  const bbox = getFloorBBoxMm(floor);

  if (!floor || !bbox || bbox.w < 1e-9 || bbox.h < 1e-9) {
    thumbEl.appendChild(fallbackEl);
    return;
  }

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
}
