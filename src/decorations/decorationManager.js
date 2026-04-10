/**
 * 装饰库管理模块
 * 支持小部件（widgets）和贴纸（stickers）两种分类
 */

const DECORATION_CATEGORIES = {
  widgets: "小部件",
  stickers: "贴纸",
};

/** 缩略图骨架色（循环使用） */
const THUMB_VARIANTS = ["", "thumb-skeleton--green", "thumb-skeleton--warm", "thumb-skeleton--red", "thumb-skeleton--gray", "thumb-skeleton--blue"];

const DECORATIONS_FILE = "assets/decorations/decorations.json";

/**
 * 加载装饰库目录 - 从 decorations.json 直接加载
 * @returns {{ items: object[], byId: Map<string, object> }}
 */
export async function loadDecorationCatalog() {
  const res = await fetch(DECORATIONS_FILE, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load decorations: ${DECORATIONS_FILE}`);
  const data = await res.json();
  const items = data.items || [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items, byId };
}

/**
 * 获取所有装饰项（需先调用 loadDecorationCatalog）
 */
export function getDecorationItems() {
  return window.__decorationCatalog?.items || [];
}

/**
 * 按分类获取装饰项
 */
export function getDecorationItemsByCategory(category) {
  const items = getDecorationItems();
  if (!category || category === "all") {
    return items;
  }
  return items.filter((item) => item.category === category);
}

/**
 * 渲染单个装饰卡片
 * @param {object} item 装饰项数据
 * @param {number} idx 索引（用于骨架色轮询）
 * @returns {HTMLElement}
 */
function createDecorationCard(item, idx) {
  const fid = String(item.id || "").trim();
  const displayName = item.name || fid;
  const cardLabel = displayName;
  const tags = item.tags || [];

  const card = document.createElement("article");
  card.className = "asset-card";
  card.draggable = false;
  card.dataset.model = fid;
  card.dataset.category = item.category || "";
  card.dataset.name = cardLabel.toLowerCase();
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-pressed", "false");
  card.setAttribute("aria-label", cardLabel);
  card.title = [cardLabel, item.category ? `分类: ${DECORATION_CATEGORIES[item.category] || item.category}` : "", ...tags].filter(Boolean).join("\n");

  const thumb = document.createElement("div");
  thumb.className = "asset-thumb";
  const variant = THUMB_VARIANTS[idx % THUMB_VARIANTS.length];
  const skeleton = document.createElement("div");
  skeleton.className = variant ? `thumb-skeleton ${variant}` : "thumb-skeleton";
  thumb.appendChild(skeleton);

  const thumbImg = document.createElement("img");
  thumbImg.className = "asset-thumb-img";
  thumbImg.alt = displayName;
  thumbImg.loading = "lazy";
  thumbImg.decoding = "async";
  thumbImg.draggable = false;
  const thumbUrl = item.thumbnail ? `./${item.thumbnail}` : null;
  if (thumbUrl) {
    thumbImg.src = thumbUrl;
    thumbImg.onload = () => {
      thumb.classList.add("has-image");
      skeleton.remove();
    };
    thumbImg.onerror = () => {
      thumbImg.remove();
      skeleton.remove();
    };
  } else {
    thumbImg.remove();
    skeleton.remove();
  }
  thumb.appendChild(thumbImg);

  const nameEl = document.createElement("div");
  nameEl.className = "furniture-asset-label";
  const titleSpan = document.createElement("span");
  titleSpan.className = "furniture-asset-label__title";
  titleSpan.textContent = displayName;
  nameEl.appendChild(titleSpan);

  // 添加尺寸显示
  if (item.size) {
    const sizeSpan = document.createElement("span");
    sizeSpan.className = "furniture-asset-label__dims";
    const w = Math.round(item.size.width || 0);
    const d = Math.round(item.size.depth || 0);
    const h = Math.round(item.size.height || 0);
    sizeSpan.textContent = `${w}×${d}×${h} cm`;
    nameEl.appendChild(sizeSpan);
  }

  card.appendChild(thumb);
  card.appendChild(nameEl);

  return card;
}

/**
 * 渲染装饰库 UI
 */
export async function mountDecorationLibrary() {
  const tabsContainer = document.querySelector(".decoration-tabs");
  const grid = document.getElementById("decorationAssetGrid");
  const searchInput = document.querySelector('.side-panel[data-panel="decorations"] .search-input');

  if (!tabsContainer || !grid) return;

  // 加载数据
  let catalog = { items: [], byId: new Map() };
  try {
    catalog = await loadDecorationCatalog();
    window.__decorationCatalog = catalog;
  } catch (err) {
    console.error("[Decoration] Failed to load catalog:", err);
  }

  grid.replaceChildren();

  function makeTab(label, category, isActive) {
    const btn = document.createElement("button");
    btn.className = isActive ? "panel-tab is-active" : "panel-tab";
    btn.type = "button";
    btn.role = "tab";
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
    btn.dataset.decorationCategory = category;
    btn.textContent = label;
    return btn;
  }

  tabsContainer.replaceChildren();
  tabsContainer.appendChild(makeTab("小部件", "widgets", true));
  tabsContainer.appendChild(makeTab("贴纸", "stickers", false));

  /** @type {HTMLElement | null} */
  let selectedDecorationCard = null;

  function decorationCards() {
    return grid.querySelectorAll(".asset-card[data-model]");
  }

  /**
   * 单选装饰卡片
   * @param {HTMLElement | null} card
   */
  function selectDecorationCard(card) {
    if (card != null && (!grid.contains(card) || card.classList.contains("is-hidden"))) return;

    decorationCards().forEach((c) => {
      const on = c === card;
      c.classList.toggle("is-selected", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    selectedDecorationCard = card;
    const id = card?.dataset?.model?.trim() || "";
    window.__selectedDecorationModelId = id;
    if (id) {
      window.dispatchEvent(
        new CustomEvent("visionhome:decoration-library-select", {
          detail: { modelId: id, item: catalog.byId?.get(id) ?? null },
        }),
      );
    }
  }

  function syncDecorationSelectionAfterFilter() {
    const visible = [...decorationCards()].filter((c) => !c.classList.contains("is-hidden"));
    if (!visible.length) {
      selectDecorationCard(null);
      window.__selectedDecorationModelId = "";
      return;
    }
    if (
      !selectedDecorationCard ||
      selectedDecorationCard.classList.contains("is-hidden") ||
      !grid.contains(selectedDecorationCard)
    ) {
      selectDecorationCard(visible[0]);
    }
  }

  function applyFilter() {
    const active = tabsContainer.querySelector(".panel-tab.is-active");
    const category = active?.dataset.decorationCategory || "widgets";
    const q = (searchInput?.value || "").trim().toLowerCase();
    grid.querySelectorAll(".asset-card").forEach((card) => {
      const cat = card.dataset.category || "";
      const name = (card.dataset.name || "").toLowerCase();
      const matchCat = cat === category;
      const matchQ = !q || name.includes(q);
      card.classList.toggle("is-hidden", !matchCat || !matchQ);
    });
    syncDecorationSelectionAfterFilter();
  }

  function renderDecorationCards(category) {
    grid.replaceChildren();
    const items = getDecorationItemsByCategory(category);

    items.forEach((item, idx) => {
      const card = createDecorationCard(item, idx);
      grid.appendChild(card);

      const activate = () => selectDecorationCard(card);
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

    applyFilter();
  }

  renderDecorationCards("widgets");

  tabsContainer.addEventListener("click", (e) => {
    const tab = e.target.closest(".panel-tab");
    if (!tab) return;

    tabsContainer.querySelectorAll(".panel-tab").forEach((t) => {
      t.classList.remove("is-active");
      t.setAttribute("aria-selected", "false");
    });
    tab.classList.add("is-active");
    tab.setAttribute("aria-selected", "true");

    const category = tab.dataset.decorationCategory || "widgets";
    renderDecorationCards(category);
  });

  searchInput?.addEventListener("input", applyFilter);

  /* 防止子节点触发原生 dragstart */
  grid.addEventListener(
    "dragstart",
    (e) => {
      e.preventDefault();
    },
    true,
  );

  window.__selectDecorationLibraryCardByModel = (modelId) => {
    const id = String(modelId || "").trim();
    if (!id) {
      selectDecorationCard(null);
      return;
    }
    const card = [...grid.querySelectorAll(".asset-card[data-model]")].find((c) => c.dataset.model === id);
    if (card) selectDecorationCard(card);
  };
}
