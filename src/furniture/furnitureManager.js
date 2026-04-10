import { DATA_PATHS } from "../core/schema.js";
import {
  CATEGORY_LABELS,
  getFurnitureDisplayName,
  getFurnitureLibraryCardLabel,
  getFurnitureLibrarySizeSuffix,
} from "./svgStyle.js";

/** 缩略图骨架色（循环使用） */
const THUMB_VARIANTS = ["", "thumb-skeleton--green", "thumb-skeleton--warm", "thumb-skeleton--red", "thumb-skeleton--gray", "thumb-skeleton--blue"];

export { CATEGORY_LABELS, getFurnitureDisplayName };
export { getSvgStyleForItem } from "./svgStyle.js";

/**
 * 拉取单文件 furnitureLibrary.json（含 items[]）
 * @returns {{ items: object[], byId: Map<string, object>, raw: object }}
 */
export async function loadFurnitureCatalog() {
  const url = `/${DATA_PATHS.furnitureManifest.replace(/^\//, "")}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`furniture library fetch failed: ${url}`);
  const raw = await res.json();
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items, byId, raw };
}

export function resolveModelUrl(modelPathFromRoot) {
  if (!modelPathFromRoot) return "";
  const clean = modelPathFromRoot.replace(/^\//, "");
  return `./${clean}`;
}

/**
 * 家具 JSON 可选 `tags: string[]`，用于属性面板展示（如定制能力、卖点）
 * @param {object | null | undefined} item
 * @returns {string[]}
 */
export function getFurnitureTags(item) {
  if (!item || typeof item !== "object") return [];
  const raw = item.tags;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    const s = String(t ?? "").trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * 家具预览图 URL 列表：仅当 JSON 配置了 `thumbnail` 时返回该路径；未配置则返回空数组（不请求图片，仅显示彩色骨架）。
 */
export function getFurnitureThumbnailUrls(item) {
  const custom = item?.thumbnail != null ? String(item.thumbnail).trim() : "";
  if (!custom) return [];
  return [resolveModelUrl(custom)];
}

/**
 * 在 .asset-thumb 内挂预览图；全部失败则保留彩色骨架
 * @param {HTMLElement} thumbEl
 * @param {object} item
 * @param {number} idx 骨架配色轮询
 */
export function mountFurnitureThumb(thumbEl, item, idx = 0) {
  const paths = getFurnitureThumbnailUrls(item);
  const variant = THUMB_VARIANTS[idx % THUMB_VARIANTS.length];
  const placeholder = document.createElement("div");
  placeholder.className = variant ? `thumb-skeleton ${variant}` : "thumb-skeleton";

  if (!paths.length) {
    thumbEl.appendChild(placeholder);
    return;
  }

  const img = document.createElement("img");
  img.className = "asset-thumb-img";
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  /* Safari：img 默认 draggable，会触发原生拖影并与 Pointer 自定义拖放冲突 */
  img.draggable = false;
  let i = 0;
  img.onload = () => {
    thumbEl.classList.add("has-image");
    placeholder.remove();
  };
  img.onerror = () => {
    i += 1;
    if (i < paths.length) {
      img.src = paths[i];
    } else {
      img.remove();
      /* 骨架仍在 thumbEl 内，继续作占位 */
    }
  };
  img.src = paths[0];
  /* 先铺图再叠骨架，加载完成前显示彩色占位 */
  thumbEl.appendChild(img);
  thumbEl.appendChild(placeholder);
}

/**
 * 根据目录渲染家具库 Tab + 卡片，并绑定分类筛选与搜索
 * @param {{ items: object[] }} catalog
 * @param {{ loadError?: boolean }} options
 */
export function mountFurnitureLibrary(catalog, options = {}) {
  const strip = document.querySelector(".furniture-tabs");
  const grid = document.getElementById("furnitureAssetGrid");
  if (!strip || !grid) return;

  strip.replaceChildren();
  grid.replaceChildren();

  /** 分类 Tab 顺序与 JSON 数组中首次出现顺序一致（不按字母排序） */
  const categoryFirstIndex = new Map();
  (catalog.items || []).forEach((it, index) => {
    const c = it.category;
    if (c && !categoryFirstIndex.has(c)) categoryFirstIndex.set(c, index);
  });
  const categories = [...categoryFirstIndex.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);

  function makeTab(label, category, isActive) {
    const btn = document.createElement("button");
    btn.className = isActive ? "tab is-active" : "tab";
    btn.type = "button";
    btn.role = "tab";
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.category = category;
    btn.textContent = label;
    return btn;
  }

  strip.appendChild(makeTab("全部", "", true));
  for (const cat of categories) {
    strip.appendChild(makeTab(CATEGORY_LABELS[cat] || cat, cat, false));
  }

  const searchInput = document.querySelector('.side-panel[data-panel="assets"] .search-input');

  /** @type {HTMLElement | null} */
  let selectedFurnitureCard = null;

  function furnitureCards() {
    return grid.querySelectorAll(".asset-card[data-model]");
  }

  /**
   * 单选家具卡片（与户型库 .is-selected 一致）
   * @param {HTMLElement | null} card
   */
  function selectFurnitureCard(card) {
    if (card != null && (!grid.contains(card) || card.classList.contains("is-hidden"))) return;

    furnitureCards().forEach((c) => {
      const on = c === card;
      c.classList.toggle("is-selected", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    selectedFurnitureCard = card;
    const id = card?.dataset?.model?.trim() || "";
    window.__selectedFurnitureModelId = id;
    if (id) {
      window.dispatchEvent(
        new CustomEvent("visionhome:furniture-library-select", {
          detail: { modelId: id, item: catalog.byId?.get(id) ?? null },
        }),
      );
    }
  }

  function syncFurnitureSelectionAfterFilter() {
    const visible = [...furnitureCards()].filter((c) => !c.classList.contains("is-hidden"));
    if (!visible.length) {
      selectFurnitureCard(null);
      window.__selectedFurnitureModelId = "";
      return;
    }
    if (
      !selectedFurnitureCard ||
      selectedFurnitureCard.classList.contains("is-hidden") ||
      !grid.contains(selectedFurnitureCard)
    ) {
      selectFurnitureCard(visible[0]);
    }
  }

  function applyFilter() {
    const active = strip.querySelector(".tab.is-active");
    const category = active?.dataset.category ?? "";
    const q = (searchInput?.value || "").trim().toLowerCase();
    grid.querySelectorAll(".asset-card").forEach((card) => {
      const cat = card.dataset.category || "";
      const name = (card.dataset.name || "").toLowerCase();
      const matchCat = !category || cat === category;
      const matchQ = !q || name.includes(q);
      card.classList.toggle("is-hidden", !matchCat || !matchQ);
    });
    syncFurnitureSelectionAfterFilter();
  }

  strip.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab || !strip.contains(tab)) return;
    strip.querySelectorAll(".tab").forEach((t) => {
      t.classList.remove("is-active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("is-active");
    tab.setAttribute("aria-selected", "true");
    applyFilter();
  });

  searchInput?.addEventListener("input", applyFilter);

  (catalog.items || []).forEach((item, idx) => {
    const cardLabel = getFurnitureLibraryCardLabel(item);
    const fid = String(item.id || "").trim();
    const displayName = getFurnitureDisplayName(item) || fid;
    const sizeSuffix = getFurnitureLibrarySizeSuffix(item);

    const card = document.createElement("article");
    card.className = "asset-card";
    card.draggable = false;
    card.dataset.model = fid;
    card.dataset.category = item.category || "";
    card.dataset.name = cardLabel.toLowerCase();
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-label", cardLabel || fid);
    card.setAttribute(
      "title",
      [cardLabel || fid, item.category ? `分类: ${item.category}` : ""].filter(Boolean).join("\n"),
    );

    const thumb = document.createElement("div");
    thumb.className = "asset-thumb";
    mountFurnitureThumb(thumb, item, idx);

    const nameEl = document.createElement("div");
    /* 不用 .asset-name：其 -webkit-line-clamp + -webkit-box 在 Safari 上会吞掉第二行尺寸 */
    nameEl.className = "furniture-asset-label";
    const titleSpan = document.createElement("span");
    titleSpan.className = "furniture-asset-label__title";
    titleSpan.textContent = displayName;
    nameEl.appendChild(titleSpan);
    if (sizeSuffix) {
      const dimSpan = document.createElement("span");
      dimSpan.className = "furniture-asset-label__dims";
      dimSpan.textContent = sizeSuffix;
      nameEl.appendChild(dimSpan);
    }

    card.appendChild(thumb);
    card.appendChild(nameEl);
    grid.appendChild(card);

    const activate = () => selectFurnitureCard(card);
    card.addEventListener("click", (e) => {
      e.preventDefault();
      activate();
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  });

  /* 防止子节点（如旧缓存 DOM）仍触发原生 dragstart */
  grid.addEventListener(
    "dragstart",
    (e) => {
      e.preventDefault();
    },
    true,
  );

  if (options.loadError) {
    const msg = document.createElement("p");
    msg.className = "furniture-load-hint";
    msg.textContent = "家具库加载失败，请检查 assets/furniture/furnitureLibrary.json。";
    grid.appendChild(msg);
  }

  applyFilter();

  window.__selectFurnitureLibraryCardByModel = (modelId) => {
    const id = String(modelId || "").trim();
    if (!id) {
      selectFurnitureCard(null);
      return;
    }
    const card = [...grid.querySelectorAll(".asset-card[data-model]")].find((c) => c.dataset.model === id);
    if (card) selectFurnitureCard(card);
  };
}
