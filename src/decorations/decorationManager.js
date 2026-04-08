/**
 * 装饰库管理模块
 * 支持小部件（widgets）和贴画（stickers）两种分类
 */

const DECORATION_CATEGORIES = {
  widgets: "小部件",
  stickers: "贴画",
};

/** 缩略图骨架色（循环使用） */
const THUMB_VARIANTS = ["", "thumb-skeleton--green", "thumb-skeleton--warm", "thumb-skeleton--red", "thumb-skeleton--gray", "thumb-skeleton--blue"];

/**
 * 小部件列表（示例数据，后续可从清单文件加载）
 */
const WIDGETS_ITEMS = [
  { id: "widget_lamp_01", name: "台灯", category: "widgets", tags: ["照明", "桌面"] },
  { id: "widget_curtain_01", name: "窗帘", category: "widgets", tags: ["窗饰", "遮光"] },
  { id: "widget_tv_01", name: "电视", category: "widgets", tags: ["家电", "客厅"] },
  { id: "widget_rug_01", name: "地毯", category: "widgets", tags: ["地面", "装饰"] },
  { id: "widget_toilet_01", name: "马桶", category: "widgets", tags: ["卫浴", "卫生间"] },
  { id: "widget_plant_01", name: "盆栽", category: "widgets", tags: ["绿植", "装饰"] },
  { id: "widget_vase_01", name: "花瓶", category: "widgets", tags: ["装饰", "桌面"] },
  { id: "widget_frame_01", name: "挂画", category: "widgets", tags: ["墙面", "装饰"] },
];

/**
 * 贴画列表（示例数据，后续可从清单文件加载）
 */
const STICKERS_ITEMS = [
  { id: "sticker_wallpaper_01", name: "墙纸", category: "stickers", tags: ["墙面", "装饰"] },
  { id: "sticker_poster_01", name: "海报", category: "stickers", tags: ["墙面", "装饰"] },
  { id: "sticker_banner_01", name: "挂旗", category: "stickers", tags: ["墙面", "装饰"] },
  { id: "sticker_clock_01", name: "挂钟", category: "stickers", tags: ["墙面", "计时"] },
  { id: "sticker_mirror_01", name: "装饰镜", category: "stickers", tags: ["墙面", "装饰"] },
  { id: "sticker_wallart_01", name: "墙贴", category: "stickers", tags: ["墙面", "装饰"] },
];

/**
 * 获取所有装饰项
 */
export function getDecorationItems() {
  return [...WIDGETS_ITEMS, ...STICKERS_ITEMS];
}

/**
 * 按分类获取装饰项
 */
export function getDecorationItemsByCategory(category) {
  if (!category || category === "all") {
    return getDecorationItems();
  }
  return getDecorationItems().filter((item) => item.category === category);
}

/**
 * 加载装饰库目录（目前使用静态数据，后续可扩展为从清单文件加载）
 */
export async function loadDecorationCatalog() {
  const items = getDecorationItems();
  const byId = new Map(items.map((item) => [item.id, item]));
  return { items, byId };
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

  const nameEl = document.createElement("div");
  nameEl.className = "furniture-asset-label";
  const titleSpan = document.createElement("span");
  titleSpan.className = "furniture-asset-label__title";
  titleSpan.textContent = displayName;
  nameEl.appendChild(titleSpan);

  card.appendChild(thumb);
  card.appendChild(nameEl);

  return card;
}

/**
 * 渲染装饰库 UI
 */
export function mountDecorationLibrary() {
  const tabsContainer = document.querySelector(".decoration-tabs");
  const grid = document.getElementById("decorationAssetGrid");
  const searchInput = document.querySelector('.side-panel[data-panel="decorations"] .search-input');

  if (!tabsContainer || !grid) return;

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
  tabsContainer.appendChild(makeTab("贴画", "stickers", false));

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
          detail: { modelId: id, item: null },
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
