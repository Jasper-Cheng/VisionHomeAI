import { loadItemsFromManifest } from "./core/catalogLoader.js";
import { DATA_PATHS } from "./core/schema.js";
import { mountFloorplanThumb } from "./floorplan/floorplanPreview.js";
import { getFloorFootprintAreaM2 } from "./floorplan/floorplanSvg.js";

const ALL_FLOORPLAN_CATEGORY = "__all__";

function normalizeCategory(value) {
  return String(value ?? "").trim();
}

function getFloorplanCategory(entry) {
  return normalizeCategory(entry?.project?.category);
}

function getFloorplanName(entry) {
  const raw = entry?.project?.name ?? entry?.name ?? entry?.id ?? "未命名户型";
  return normalizeCategory(raw) || "未命名户型";
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

function roomCountLabel(entry) {
  const count = (Array.isArray(entry?.floors) ? entry.floors : []).reduce(
    (sum, floor) => sum + (Array.isArray(floor?.rooms) ? floor.rooms.length : 0),
    0,
  );
  return count > 0 ? `${count}个空间` : "空间待补";
}

function parseCategoryFilter(raw) {
  const value = normalizeCategory(raw);
  if (!value || value === ALL_FLOORPLAN_CATEGORY) return [];
  return value
    .split(",")
    .map((category) => normalizeCategory(category))
    .filter(Boolean);
}

function setCategoryCounts(items) {
  const list = document.querySelector("[data-floorplan-category-list]");
  if (!list) return;

  const counts = new Map();
  const total = Array.isArray(items) ? items.length : 0;
  for (const item of items || []) {
    const category = getFloorplanCategory(item);
    if (!category) continue;
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  list.querySelectorAll("[data-floorplan-category]").forEach((row) => {
    const raw = normalizeCategory(row.dataset.floorplanCategory);
    const countEl = row.querySelector(".ucat-count");
    if (!countEl) return;
    if (raw === ALL_FLOORPLAN_CATEGORY) {
      countEl.textContent = String(total);
      return;
    }
    const categories = raw
      .split(",")
      .map((category) => normalizeCategory(category))
      .filter(Boolean);
    const count = categories.reduce((sum, category) => sum + (counts.get(category) || 0), 0);
    countEl.textContent = String(count);
  });
}

function updateResultCount(count) {
  const countEl = document.querySelector(".ucontent-count");
  if (!countEl) return;
  const start = count > 0 ? 1 : 0;
  countEl.innerHTML = `显示 ${start} – ${count} / 共 <strong>${count}</strong> 个户型`;
}

function createTag(text) {
  const tag = document.createElement("span");
  tag.className = "model-tag";
  tag.textContent = text;
  return tag;
}

function createFloorplanCard(entry, index) {
  const category = getFloorplanCategory(entry) || "未分类";
  const areaLabel = formatArea(getFloorplanAreaM2(entry));

  const card = document.createElement("article");
  card.className = "model-card model-card--floorplan";
  card.dataset.floorplanId = normalizeCategory(entry?.id);
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

  const source = document.createElement("div");
  source.className = "model-source";
  source.textContent = `户型分类：${category}`;

  const tags = document.createElement("div");
  tags.className = "model-tags";
  tags.append(createTag(category), createTag(floorCountLabel(entry)), createTag(roomCountLabel(entry)));

  info.append(top, source, tags);
  card.append(thumb, info);
  return card;
}

function renderEmptyState(grid, categoryLabel) {
  const empty = document.createElement("div");
  empty.className = "model-empty-state";
  empty.textContent = categoryLabel ? `当前没有${categoryLabel}户型` : "当前没有户型";
  grid.appendChild(empty);
}

function renderFloorplanCards(items, categoryFilter) {
  const grid = document.querySelector(".model-grid");
  if (!grid) return;

  const filters = parseCategoryFilter(categoryFilter);
  const visibleItems = filters.length ? items.filter((item) => filters.includes(getFloorplanCategory(item))) : items;
  grid.replaceChildren();
  visibleItems.forEach((item, index) => {
    grid.appendChild(createFloorplanCard(item, index));
  });
  if (!visibleItems.length) {
    renderEmptyState(grid, filters.join(" / "));
  }
  updateResultCount(visibleItems.length);

  const pager = document.querySelector(".ucontent-bottom");
  if (pager) pager.hidden = true;
}

function bindFloorplanCategoryClicks(items) {
  const list = document.querySelector("[data-floorplan-category-list]");
  if (!list) return;

  list.addEventListener("click", (event) => {
    const row = event.target.closest("[data-floorplan-category]");
    if (!row || !list.contains(row)) return;
    list.querySelectorAll("[data-floorplan-category]").forEach((item) => item.classList.toggle("is-active", item === row));
    renderFloorplanCards(items, row.dataset.floorplanCategory);
  });
}

async function mountUserPage() {
  try {
    const items = await loadItemsFromManifest({
      manifestUrl: DATA_PATHS.floorplansManifest,
      itemsBaseUrl: DATA_PATHS.floorplansDir,
    });
    setCategoryCounts(items);
    bindFloorplanCategoryClicks(items);
    const active = document.querySelector("[data-floorplan-category-list] .ucat-item.is-active");
    renderFloorplanCards(items, active?.dataset.floorplanCategory || ALL_FLOORPLAN_CATEGORY);
  } catch (err) {
    console.warn("[VisionHomeAI] 用户页户型分类统计失败:", err);
  }
}

void mountUserPage();
