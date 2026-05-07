import { loadItemsFromManifest } from "./core/catalogLoader.js";
import { DATA_PATHS } from "./core/schema.js";
import { mountFloorplanThumb } from "./floorplan/floorplanPreview.js";
import { getFloorFootprintAreaM2 } from "./floorplan/floorplanSvg.js";
import {
  CATEGORY_LABELS,
  getFurnitureDisplayName,
  getFurnitureTags,
  loadFurnitureCatalog,
  mountFurnitureThumb,
} from "./furniture/furnitureManager.js";
import { getFurnitureLibrarySizeSuffix } from "./furniture/svgStyle.js";

const ALL_CATEGORY = "__all__";
const MODE_FLOORPLAN = "floorplan";
const MODE_FURNITURE = "furniture";

const SORT_OPTIONS = {
  [MODE_FLOORPLAN]: [
    { value: "name", label: "名称" },
    { value: "area", label: "面积" },
    { value: "spaces", label: "空间" },
  ],
  [MODE_FURNITURE]: [
    { value: "name", label: "名称" },
    { value: "price", label: "价格" },
    { value: "size", label: "大小" },
  ],
};

let currentMode = MODE_FLOORPLAN;
let floorplanItems = [];
let furnitureItems = [];

function normalize(value) {
  return String(value ?? "").trim();
}

function createTag(text) {
  const tag = document.createElement("span");
  tag.className = "model-tag";
  tag.textContent = text;
  return tag;
}

function parseCategoryFilter(raw) {
  const value = normalize(raw);
  if (!value || value === ALL_CATEGORY) return [];
  return value
    .split(",")
    .map((category) => normalize(category))
    .filter(Boolean);
}

function getFloorplanCategory(entry) {
  return normalize(entry?.project?.category);
}

function getFloorplanName(entry) {
  const raw = entry?.project?.name ?? entry?.name ?? entry?.id ?? "未命名户型";
  return normalize(raw) || "未命名户型";
}

function getFloorplanAreaM2(entry) {
  const projectArea = Number(entry?.project?.areaM2);
  if (Number.isFinite(projectArea) && projectArea > 0) return projectArea;
  const floor0 = Array.isArray(entry?.floors) ? entry.floors[0] : null;
  if (!floor0) return 0;
  const area = getFloorFootprintAreaM2(floor0);
  return Number.isFinite(area) && area > 0 ? area : 0;
}

function formatArea(areaM2) {
  if (!Number.isFinite(areaM2) || areaM2 <= 0) return "面积待补";
  const rounded = Math.round(areaM2 * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) return `${Math.round(rounded)}m\u00B2`;
  return `${rounded.toFixed(1)}m\u00B2`;
}

function floorCountLabel(entry) {
  const count = Array.isArray(entry?.floors) ? entry.floors.filter(Boolean).length : 0;
  return count > 0 ? `${count}层` : "楼层待补";
}

function getRoomCount(entry) {
  return (Array.isArray(entry?.floors) ? entry.floors : []).reduce(
    (sum, floor) => sum + (Array.isArray(floor?.rooms) ? floor.rooms.length : 0),
    0,
  );
}

function roomCountLabel(entry) {
  const count = getRoomCount(entry);
  return count > 0 ? `${count}个空间` : "空间待补";
}

function getFurnitureCategory(item) {
  return normalize(item?.category);
}

function getFurnitureCategoryLabel(category) {
  const key = normalize(category);
  return CATEGORY_LABELS[key] || key || "未分类";
}

function getFurniturePrice(item) {
  const price = Number(item?.price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function formatPrice(price) {
  if (!Number.isFinite(price) || price <= 0) return "价格待补";
  return `¥${Math.round(price).toLocaleString("zh-CN")}`;
}

function getFurnitureSizeVolume(item) {
  const size = item?.size;
  if (!size || typeof size !== "object" || Array.isArray(size)) return 0;
  const w = Number(size.widthCm ?? size.width ?? size.w);
  const d = Number(size.depthCm ?? size.depth ?? size.d ?? size.length);
  const h = Number(size.heightCm ?? size.height ?? size.h);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(d) || d <= 0) return 0;
  return w * d * (Number.isFinite(h) && h > 0 ? h : 1);
}

function getFurnitureSizeLabel(item) {
  return getFurnitureLibrarySizeSuffix(item) || "尺寸待补";
}

function updateResultCount(count, noun) {
  const countEl = document.querySelector(".ucontent-count");
  if (!countEl) return;
  const start = count > 0 ? 1 : 0;
  countEl.innerHTML = `显示 ${start} – ${count} / 共 <strong>${count}</strong> 个${noun}`;
}

function setCategoryCounts(listSelector, dataAttr, items, getCategory) {
  const list = document.querySelector(listSelector);
  if (!list) return;

  const counts = new Map();
  const total = Array.isArray(items) ? items.length : 0;
  for (const item of items || []) {
    const category = getCategory(item);
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  list.querySelectorAll(`[${dataAttr}]`).forEach((row) => {
    const raw = normalize(row.getAttribute(dataAttr));
    const countEl = row.querySelector(".ucat-count");
    if (!countEl) return;
    if (raw === ALL_CATEGORY) {
      countEl.textContent = String(total);
      return;
    }
    const categories = parseCategoryFilter(raw);
    const count = categories.reduce((sum, category) => sum + (counts.get(category) || 0), 0);
    countEl.textContent = String(count);
  });
}

function getSortSelect() {
  return document.querySelector(".ucontent-sort-select");
}

function setSortOptions(mode) {
  const select = getSortSelect();
  if (!select) return;
  const prev = normalize(select.value);
  const options = SORT_OPTIONS[mode] || SORT_OPTIONS[MODE_FLOORPLAN];
  select.replaceChildren();
  for (const optionDef of options) {
    const option = document.createElement("option");
    option.value = optionDef.value;
    option.textContent = optionDef.label;
    select.appendChild(option);
  }
  select.value = options.some((option) => option.value === prev) ? prev : "name";
}

function getSortKey() {
  return normalize(getSortSelect()?.value) || "name";
}

function sortFloorplanItems(items, sortKey) {
  const next = [...(items || [])];
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  next.sort((a, b) => {
    if (sortKey === "area") {
      const diff = getFloorplanAreaM2(b) - getFloorplanAreaM2(a);
      if (Math.abs(diff) > 1e-6) return diff;
      return collator.compare(getFloorplanName(a), getFloorplanName(b));
    }
    if (sortKey === "spaces") {
      const diff = getRoomCount(b) - getRoomCount(a);
      if (diff !== 0) return diff;
      return collator.compare(getFloorplanName(a), getFloorplanName(b));
    }
    return collator.compare(getFloorplanName(a), getFloorplanName(b));
  });
  return next;
}

function sortFurnitureItems(items, sortKey) {
  const next = [...(items || [])];
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  next.sort((a, b) => {
    if (sortKey === "price") {
      const diff = getFurniturePrice(a) - getFurniturePrice(b);
      if (Math.abs(diff) > 1e-6) return diff;
      return collator.compare(getFurnitureDisplayName(a), getFurnitureDisplayName(b));
    }
    if (sortKey === "size") {
      const diff = getFurnitureSizeVolume(b) - getFurnitureSizeVolume(a);
      if (Math.abs(diff) > 1e-6) return diff;
      return collator.compare(getFurnitureDisplayName(a), getFurnitureDisplayName(b));
    }
    return collator.compare(getFurnitureDisplayName(a), getFurnitureDisplayName(b));
  });
  return next;
}

function createFloorplanCard(entry, index) {
  const category = getFloorplanCategory(entry) || "未分类";
  const areaLabel = formatArea(getFloorplanAreaM2(entry));

  const card = document.createElement("article");
  card.className = "model-card model-card--floorplan";
  card.dataset.floorplanId = normalize(entry?.id);
  card.dataset.category = category;

  const thumb = document.createElement("div");
  thumb.className = "model-thumb model-thumb--floorplan";
  mountFloorplanThumb(thumb, entry, index);

  const info = document.createElement("div");
  info.className = "model-info";

  const top = document.createElement("div");
  top.className = "model-info-top";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = getFloorplanName(entry);
  const area = document.createElement("span");
  area.className = "model-price";
  area.textContent = areaLabel;
  top.append(name, area);

  const tags = document.createElement("div");
  tags.className = "model-tags";
  tags.append(createTag(category), createTag(floorCountLabel(entry)), createTag(roomCountLabel(entry)));

  info.append(top, tags);
  card.append(thumb, info);
  return card;
}

function createFurnitureCard(item, index) {
  const category = getFurnitureCategory(item);
  const categoryLabel = getFurnitureCategoryLabel(category);
  const sizeLabel = getFurnitureSizeLabel(item);

  const card = document.createElement("article");
  card.className = "model-card model-card--furniture";
  card.dataset.model = normalize(item?.id);
  card.dataset.category = category;

  const thumb = document.createElement("div");
  thumb.className = "model-thumb model-thumb--furniture";
  mountFurnitureThumb(thumb, item, index);

  const info = document.createElement("div");
  info.className = "model-info";

  const top = document.createElement("div");
  top.className = "model-info-top";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = getFurnitureDisplayName(item) || normalize(item?.id) || "未命名家具";
  const price = document.createElement("span");
  price.className = "model-price";
  price.textContent = formatPrice(getFurniturePrice(item));
  top.append(name, price);

  const tags = document.createElement("div");
  tags.className = "model-tags";
  const itemTags = getFurnitureTags(item);
  tags.append(createTag(categoryLabel), ...itemTags.map((tag) => createTag(tag)), createTag(sizeLabel));

  info.append(top, tags);
  card.append(thumb, info);
  return card;
}

function renderEmptyState(grid, label) {
  const empty = document.createElement("div");
  empty.className = "model-empty-state";
  empty.textContent = label;
  grid.appendChild(empty);
}

function renderCards(items, options) {
  const grid = document.querySelector(".model-grid");
  if (!grid) return;

  const filters = parseCategoryFilter(options.categoryFilter);
  const filteredItems = filters.length ? items.filter((item) => filters.includes(options.getCategory(item))) : items;
  const visibleItems = options.sortItems(filteredItems, getSortKey());
  grid.replaceChildren();
  visibleItems.forEach((item, index) => grid.appendChild(options.createCard(item, index)));
  if (!visibleItems.length) renderEmptyState(grid, options.emptyText(filters));
  updateResultCount(visibleItems.length, options.noun);

  const pager = document.querySelector(".ucontent-bottom");
  if (pager) pager.hidden = true;
}

function getActiveFilter(selector, dataAttr) {
  const active = document.querySelector(`${selector} .ucat-item.is-active`);
  return active?.getAttribute(dataAttr) || ALL_CATEGORY;
}

function renderFloorplans(categoryFilter = getActiveFilter("[data-floorplan-category-list]", "data-floorplan-category")) {
  currentMode = MODE_FLOORPLAN;
  setSortOptions(MODE_FLOORPLAN);
  renderCards(floorplanItems, {
    categoryFilter,
    getCategory: getFloorplanCategory,
    sortItems: sortFloorplanItems,
    createCard: createFloorplanCard,
    noun: "户型",
    emptyText: (filters) => (filters.length ? `当前没有${filters.join(" / ")}户型` : "当前没有户型"),
  });
}

function renderFurniture(categoryFilter = getActiveFilter("[data-furniture-category-list]", "data-furniture-category")) {
  currentMode = MODE_FURNITURE;
  setSortOptions(MODE_FURNITURE);
  renderCards(furnitureItems, {
    categoryFilter,
    getCategory: getFurnitureCategory,
    sortItems: sortFurnitureItems,
    createCard: createFurnitureCard,
    noun: "家具",
    emptyText: (filters) => {
      const labels = filters.map(getFurnitureCategoryLabel).join(" / ");
      return labels ? `当前没有${labels}家具` : "当前没有家具";
    },
  });
}

function activateCategory(row) {
  document.querySelectorAll("[data-floorplan-category], [data-furniture-category]").forEach((item) => {
    item.classList.toggle("is-active", item === row);
  });
}

function bindCategoryClicks() {
  const floorplanList = document.querySelector("[data-floorplan-category-list]");
  floorplanList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-floorplan-category]");
    if (!row || !floorplanList.contains(row)) return;
    activateCategory(row);
    renderFloorplans(row.getAttribute("data-floorplan-category"));
  });

  const furnitureList = document.querySelector("[data-furniture-category-list]");
  furnitureList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-furniture-category]");
    if (!row || !furnitureList.contains(row)) return;
    activateCategory(row);
    renderFurniture(row.getAttribute("data-furniture-category"));
  });
}

function bindSort() {
  const select = getSortSelect();
  if (!select) return;
  select.addEventListener("change", () => {
    if (currentMode === MODE_FURNITURE) renderFurniture();
    else renderFloorplans();
  });
}

async function mountUserPage() {
  try {
    const [loadedFloorplans, furnitureCatalog] = await Promise.all([
      loadItemsFromManifest({
        manifestUrl: DATA_PATHS.floorplansManifest,
        itemsBaseUrl: DATA_PATHS.floorplansDir,
      }),
      loadFurnitureCatalog(),
    ]);
    floorplanItems = loadedFloorplans;
    furnitureItems = Array.isArray(furnitureCatalog?.items) ? furnitureCatalog.items : [];

    setCategoryCounts("[data-floorplan-category-list]", "data-floorplan-category", floorplanItems, getFloorplanCategory);
    setCategoryCounts("[data-furniture-category-list]", "data-furniture-category", furnitureItems, getFurnitureCategory);
    bindCategoryClicks();
    bindSort();
    renderFloorplans();
  } catch (err) {
    console.warn("[VisionHomeAI] 用户页分类加载失败:", err);
  }
}

void mountUserPage();
