import { loadFurnitureLibrary } from "../core/projectManager.js";
import { CATEGORY_LABELS, getFurnitureDisplayName } from "./svgStyle.js";

/** 缩略图骨架色（循环使用） */
const THUMB_VARIANTS = ["", "thumb-skeleton--green", "thumb-skeleton--warm", "thumb-skeleton--red", "thumb-skeleton--gray", "thumb-skeleton--blue"];

export { CATEGORY_LABELS, getFurnitureDisplayName };
export { getSvgStyleForItem } from "./svgStyle.js";

/**
 * 拉取并解析 data/furniture/furnitureLibrary.json
 * @returns {{ items: object[], byId: Map<string, object> }}
 */
export async function loadFurnitureCatalog() {
  const data = await loadFurnitureLibrary();
  const items = Array.isArray(data?.furnitureLibrary) ? data.furnitureLibrary : [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items, byId, raw: data };
}

export function resolveModelUrl(modelPathFromRoot) {
  if (!modelPathFromRoot) return "";
  const clean = modelPathFromRoot.replace(/^\//, "");
  return `./${clean}`;
}

/** 家具预览图 URL 列表：优先 JSON.thumbnail，否则 assets/thumbnails/{id}.webp|png|jpg|jpeg */
export function getFurnitureThumbnailUrls(item) {
  const paths = [];
  const custom = item?.thumbnail != null ? String(item.thumbnail).trim() : "";
  if (custom) paths.push(resolveModelUrl(custom));
  const id = String(item?.id || "").trim();
  if (id) {
    const base = `assets/thumbnails/${id}`;
    paths.push(`${base}.webp`, `${base}.png`, `${base}.jpg`, `${base}.jpeg`);
  }
  return paths;
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
    const displayName = getFurnitureDisplayName(item);
    const fid = String(item.id || "").trim();

    const card = document.createElement("article");
    card.className = "asset-card";
    card.dataset.model = fid;
    card.dataset.category = item.category || "";
    card.dataset.name = displayName.toLowerCase();
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", displayName || fid);
    card.setAttribute(
      "title",
      [displayName || fid, item.category ? `分类: ${item.category}` : ""].filter(Boolean).join("\n"),
    );

    const thumb = document.createElement("div");
    thumb.className = "asset-thumb";
    mountFurnitureThumb(thumb, item, idx);

    const nameEl = document.createElement("div");
    nameEl.className = "asset-name";
    nameEl.textContent = displayName || fid;

    card.appendChild(thumb);
    card.appendChild(nameEl);
    grid.appendChild(card);
  });

  if (options.loadError) {
    const msg = document.createElement("p");
    msg.className = "furniture-load-hint";
    msg.textContent = "家具库加载失败，请检查 data/furniture/furnitureLibrary.json 或网络。";
    grid.appendChild(msg);
  }

  applyFilter();
}
