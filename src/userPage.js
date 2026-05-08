import { loadItemsFromManifest } from "./core/catalogLoader.js";
import { DATA_PATHS } from "./core/schema.js";
import { loadDesignProjectsFromManifest } from "./files/designFilesManager.js";
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
const MODE_FILE = "file";
const MODE_SEARCH = "search";

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
  [MODE_FILE]: [
    { value: "name", label: "名字" },
    { value: "updatedAt", label: "更新时间" },
    { value: "size", label: "大小" },
  ],
  [MODE_SEARCH]: [
    { value: "relevance", label: "相关度" },
    { value: "name", label: "名称" },
    { value: "type", label: "类型" },
  ],
};

let currentMode = MODE_FLOORPLAN;
let lastBrowseMode = MODE_FLOORPLAN;
let globalSearchQuery = "";
let floorplanItems = [];
let furnitureItems = [];
let fileItems = [];

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeSearchText(value) {
  return normalize(value).toLocaleLowerCase("zh-CN");
}

function getSearchTokens(query) {
  return normalizeSearchText(query)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function collectNestedText(value, depth = 3) {
  if (value == null || depth < 0) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((item) => collectNestedText(item, depth - 1));
  if (typeof value === "object") {
    return Object.values(value).flatMap((item) => collectNestedText(item, depth - 1));
  }
  return [];
}

function createSearchBlob(parts) {
  return parts.flatMap((part) => collectNestedText(part)).map(normalizeSearchText).filter(Boolean).join(" ");
}

function textMatchesTokens(text, tokens) {
  if (!tokens.length) return false;
  return tokens.every((token) => text.includes(token));
}

function scoreSearchResult(name, category, text, query, tokens) {
  const normalizedName = normalizeSearchText(name);
  const normalizedCategory = normalizeSearchText(category);
  let score = 0;
  if (normalizedName === query) score += 120;
  if (normalizedName.includes(query)) score += 80;
  score += tokens.reduce((sum, token) => sum + (normalizedName.includes(token) ? 24 : 0), 0);
  if (normalizedCategory.includes(query)) score += 28;
  score += tokens.reduce((sum, token) => sum + (normalizedCategory.includes(token) ? 8 : 0), 0);
  if (text.includes(query)) score += 12;
  return score;
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

function getDesignFileStem(entry) {
  return normalize(entry?.file).replace(/\.json$/i, "");
}

function getDesignFileName(entry) {
  const raw = entry?.project?.name ?? entry?.project?.title ?? getDesignFileStem(entry) ?? "未命名文件";
  return normalize(raw) || "未命名文件";
}

function getDesignFileSizeBytes(entry) {
  const size = Number(entry?.sizeBytes);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function getJsonSizeBytes(value) {
  const text = JSON.stringify(value ?? {});
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return text.length;
}

function normalizeDesignFileEntry(entry) {
  return {
    ...entry,
    sizeBytes: getJsonSizeBytes(entry?.project),
  };
}

function getDesignFileUpdatedMs(entry) {
  const iso = entry?.project?.updatedAt || entry?.project?.createdAt;
  if (iso != null && normalize(iso)) {
    const ms = new Date(iso).getTime();
    if (Number.isFinite(ms)) return ms;
  }

  const timestamp = getDesignFileStem(entry).match(/(\d{13})/)?.[1];
  if (timestamp) {
    const ms = Number(timestamp);
    if (Number.isFinite(ms)) return ms;
  }

  return 0;
}

function formatDesignFileUpdatedAt(entry) {
  const ms = getDesignFileUpdatedMs(entry);
  if (!ms) return "更新时间待补";
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "大小待补";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function getTemplateFloorplanName(templateId) {
  const id = normalize(templateId);
  if (!id) return "";
  const floorplan = floorplanItems.find((item) => normalize(item?.id) === id);
  return floorplan ? getFloorplanName(floorplan) : id;
}

function updateResultCount(count, noun) {
  const countEl = document.querySelector(".ucontent-count");
  if (!countEl) return;
  const start = count > 0 ? 1 : 0;
  countEl.innerHTML = `显示 ${start} – ${count} / 共 <strong>${count}</strong> 个${noun}`;
}

function updateSearchResultCount(count, query) {
  const countEl = document.querySelector(".ucontent-count");
  if (!countEl) return;
  const start = count > 0 ? 1 : 0;
  countEl.innerHTML = `搜索“${escapeHtml(query)}”：显示 ${start} – ${count} / 共 <strong>${count}</strong> 个结果`;
}

function escapeHtml(value) {
  return normalize(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char] || char;
  });
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

function setFileCategoryCount(items) {
  const countEl = document.querySelector("[data-file-category] .ucat-count");
  if (countEl) countEl.textContent = String(Array.isArray(items) ? items.length : 0);
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
  select.value = options.some((option) => option.value === prev) ? prev : options[0]?.value || "name";
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

function sortFileItems(items, sortKey) {
  const next = [...(items || [])];
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  next.sort((a, b) => {
    if (sortKey === "updatedAt") {
      const diff = getDesignFileUpdatedMs(b) - getDesignFileUpdatedMs(a);
      if (diff !== 0) return diff;
      return collator.compare(getDesignFileName(a), getDesignFileName(b));
    }
    if (sortKey === "size") {
      const diff = getDesignFileSizeBytes(b) - getDesignFileSizeBytes(a);
      if (diff !== 0) return diff;
      return collator.compare(getDesignFileName(a), getDesignFileName(b));
    }
    return collator.compare(getDesignFileName(a), getDesignFileName(b));
  });
  return next;
}

function getSearchTypeLabel(mode) {
  if (mode === MODE_FLOORPLAN) return "户型";
  if (mode === MODE_FURNITURE) return "家具";
  if (mode === MODE_FILE) return "文件";
  return "结果";
}

function getSearchTypeRank(mode) {
  if (mode === MODE_FLOORPLAN) return 1;
  if (mode === MODE_FURNITURE) return 2;
  if (mode === MODE_FILE) return 3;
  return 9;
}

function buildFloorplanSearchResult(entry, query, tokens) {
  const name = getFloorplanName(entry);
  const category = getFloorplanCategory(entry) || "未分类";
  const roomNames = (Array.isArray(entry?.floors) ? entry.floors : []).flatMap((floor) =>
    Array.isArray(floor?.rooms) ? floor.rooms.map((room) => [room?.name, room?.type]) : [],
  );
  const text = createSearchBlob([
    name,
    category,
    normalize(entry?.id),
    formatArea(getFloorplanAreaM2(entry)),
    floorCountLabel(entry),
    roomCountLabel(entry),
    roomNames,
  ]);
  if (!textMatchesTokens(text, tokens)) return null;
  return {
    mode: MODE_FLOORPLAN,
    item: entry,
    name,
    typeRank: getSearchTypeRank(MODE_FLOORPLAN),
    score: scoreSearchResult(name, category, text, query, tokens),
  };
}

function buildFurnitureSearchResult(item, query, tokens) {
  const name = getFurnitureDisplayName(item) || normalize(item?.id) || "未命名家具";
  const category = getFurnitureCategoryLabel(getFurnitureCategory(item));
  const text = createSearchBlob([
    name,
    category,
    item?.id,
    item?.model,
    item?.thumbnail,
    item?.tags,
    formatPrice(getFurniturePrice(item)),
    getFurnitureSizeLabel(item),
  ]);
  if (!textMatchesTokens(text, tokens)) return null;
  return {
    mode: MODE_FURNITURE,
    item,
    name,
    typeRank: getSearchTypeRank(MODE_FURNITURE),
    score: scoreSearchResult(name, category, text, query, tokens),
  };
}

function buildFileSearchResult(entry, query, tokens) {
  const name = getDesignFileName(entry);
  const templateName = getTemplateFloorplanName(entry?.project?.templateId);
  const text = createSearchBlob([
    name,
    entry?.file,
    entry?.project?.id,
    entry?.project?.templateId,
    templateName,
    formatDesignFileUpdatedAt(entry),
    formatFileSize(getDesignFileSizeBytes(entry)),
    entry?.project,
  ]);
  if (!textMatchesTokens(text, tokens)) return null;
  return {
    mode: MODE_FILE,
    item: entry,
    name,
    typeRank: getSearchTypeRank(MODE_FILE),
    score: scoreSearchResult(name, "文件", text, query, tokens),
  };
}

function getSearchResults(query) {
  const normalizedQuery = normalizeSearchText(query);
  const tokens = getSearchTokens(query);
  if (!tokens.length) return [];
  return [
    ...floorplanItems.map((entry) => buildFloorplanSearchResult(entry, normalizedQuery, tokens)),
    ...furnitureItems.map((item) => buildFurnitureSearchResult(item, normalizedQuery, tokens)),
    ...fileItems.map((entry) => buildFileSearchResult(entry, normalizedQuery, tokens)),
  ].filter(Boolean);
}

function sortSearchResults(results, sortKey) {
  const next = [...(results || [])];
  const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
  next.sort((a, b) => {
    if (sortKey === "type") {
      const diff = a.typeRank - b.typeRank;
      if (diff !== 0) return diff;
      return collator.compare(a.name, b.name);
    }
    if (sortKey === "name") {
      const diff = collator.compare(a.name, b.name);
      if (diff !== 0) return diff;
      return a.typeRank - b.typeRank;
    }
    const diff = b.score - a.score;
    if (Math.abs(diff) > 1e-6) return diff;
    return collator.compare(a.name, b.name);
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

function createFileCard(entry) {
  const file = normalize(entry?.file) || "unknown.json";
  const stem = getDesignFileStem(entry);
  const displayName = getDesignFileName(entry);
  const templateId = normalize(entry?.project?.templateId);

  const card = document.createElement("article");
  card.className = "model-card model-card--file";
  card.dataset.file = file;
  card.dataset.designId = normalize(entry?.project?.id) || stem;
  card.setAttribute("aria-label", `文件 ${displayName}`);

  const thumb = document.createElement("div");
  thumb.className = "model-thumb model-thumb--file";
  thumb.innerHTML = `
    <span class="file-card-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M6 3h8l4 4v14H6V3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M14 3v5h5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <path d="M9 12h6M9 15h6M9 18h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </span>
  `;

  const info = document.createElement("div");
  info.className = "model-info";

  const top = document.createElement("div");
  top.className = "model-info-top";
  const name = document.createElement("span");
  name.className = "model-name";
  name.textContent = displayName;
  const size = document.createElement("span");
  size.className = "model-price";
  size.textContent = formatFileSize(getDesignFileSizeBytes(entry));
  top.append(name, size);

  const source = document.createElement("div");
  source.className = "model-source";
  source.textContent = `${formatDesignFileUpdatedAt(entry)} · ${file}`;

  const tags = document.createElement("div");
  tags.className = "model-tags";
  if (templateId) tags.append(createTag(`模板 ${getTemplateFloorplanName(templateId)}`));

  info.append(top, source, tags);
  card.append(thumb, info);
  return card;
}

function renderEmptyState(grid, label) {
  const empty = document.createElement("div");
  empty.className = "model-empty-state";
  empty.textContent = label;
  grid.appendChild(empty);
}

function addSearchTypeTag(card, mode) {
  const tags = card.querySelector(".model-tags");
  if (!tags) return card;
  tags.prepend(createTag(getSearchTypeLabel(mode)));
  return card;
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
  lastBrowseMode = MODE_FLOORPLAN;
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
  lastBrowseMode = MODE_FURNITURE;
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
  document.querySelectorAll("[data-floorplan-category], [data-furniture-category], [data-file-category]").forEach((item) => {
    item.classList.toggle("is-active", item === row);
  });
}

function renderFiles() {
  currentMode = MODE_FILE;
  lastBrowseMode = MODE_FILE;
  setSortOptions(MODE_FILE);
  renderCards(fileItems, {
    categoryFilter: ALL_CATEGORY,
    getCategory: () => ALL_CATEGORY,
    sortItems: sortFileItems,
    createCard: createFileCard,
    noun: "文件",
    emptyText: () => "当前没有文件",
  });
}

function renderSearchResults(query = globalSearchQuery) {
  const grid = document.querySelector(".model-grid");
  if (!grid) return;

  const wasSearching = currentMode === MODE_SEARCH;
  currentMode = MODE_SEARCH;
  globalSearchQuery = normalize(query);
  setSortOptions(MODE_SEARCH);
  if (!wasSearching) {
    const select = getSortSelect();
    if (select) select.value = "relevance";
  }

  const results = sortSearchResults(getSearchResults(globalSearchQuery), getSortKey());
  grid.replaceChildren();
  results.forEach((result, index) => {
    if (result.mode === MODE_FLOORPLAN) grid.appendChild(addSearchTypeTag(createFloorplanCard(result.item, index), result.mode));
    else if (result.mode === MODE_FURNITURE) grid.appendChild(addSearchTypeTag(createFurnitureCard(result.item, index), result.mode));
    else if (result.mode === MODE_FILE) grid.appendChild(addSearchTypeTag(createFileCard(result.item), result.mode));
  });
  if (!results.length) renderEmptyState(grid, `没有找到“${globalSearchQuery}”相关内容`);
  updateSearchResultCount(results.length, globalSearchQuery);

  const pager = document.querySelector(".ucontent-bottom");
  if (pager) pager.hidden = true;
}

function restoreBrowseMode() {
  if (lastBrowseMode === MODE_FILE) renderFiles();
  else if (lastBrowseMode === MODE_FURNITURE) renderFurniture();
  else renderFloorplans();
}

function getSearchInput() {
  return document.querySelector(".header-search-input");
}

function clearSearchQuery() {
  globalSearchQuery = "";
  const input = getSearchInput();
  if (input && input.value) input.value = "";
}

function bindCategoryClicks() {
  const floorplanList = document.querySelector("[data-floorplan-category-list]");
  floorplanList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-floorplan-category]");
    if (!row || !floorplanList.contains(row)) return;
    clearSearchQuery();
    activateCategory(row);
    renderFloorplans(row.getAttribute("data-floorplan-category"));
  });

  const furnitureList = document.querySelector("[data-furniture-category-list]");
  furnitureList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-furniture-category]");
    if (!row || !furnitureList.contains(row)) return;
    clearSearchQuery();
    activateCategory(row);
    renderFurniture(row.getAttribute("data-furniture-category"));
  });

  const fileList = document.querySelector("[data-file-category-list]");
  fileList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-file-category]");
    if (!row || !fileList.contains(row)) return;
    clearSearchQuery();
    activateCategory(row);
    renderFiles();
  });
}

function bindSort() {
  const select = getSortSelect();
  if (!select) return;
  select.addEventListener("change", () => {
    if (currentMode === MODE_SEARCH) renderSearchResults();
    else if (currentMode === MODE_FILE) renderFiles();
    else if (currentMode === MODE_FURNITURE) renderFurniture();
    else renderFloorplans();
  });
}

function bindGlobalSearch() {
  const input = getSearchInput();
  if (!input) return;
  input.addEventListener("input", () => {
    const query = normalize(input.value);
    globalSearchQuery = query;
    if (query) renderSearchResults(query);
    else restoreBrowseMode();
  });
  input.addEventListener("search", () => {
    const query = normalize(input.value);
    globalSearchQuery = query;
    if (query) renderSearchResults(query);
    else restoreBrowseMode();
  });
}

async function mountUserPage() {
  try {
    const [loadedFloorplans, furnitureCatalog, loadedFiles] = await Promise.all([
      loadItemsFromManifest({
        manifestUrl: DATA_PATHS.floorplansManifest,
        itemsBaseUrl: DATA_PATHS.floorplansDir,
      }),
      loadFurnitureCatalog(),
      loadDesignProjectsFromManifest(),
    ]);
    floorplanItems = loadedFloorplans;
    furnitureItems = Array.isArray(furnitureCatalog?.items) ? furnitureCatalog.items : [];
    fileItems = (Array.isArray(loadedFiles) ? loadedFiles : []).map(normalizeDesignFileEntry);

    setCategoryCounts("[data-floorplan-category-list]", "data-floorplan-category", floorplanItems, getFloorplanCategory);
    setCategoryCounts("[data-furniture-category-list]", "data-furniture-category", furnitureItems, getFurnitureCategory);
    setFileCategoryCount(fileItems);
    bindCategoryClicks();
    bindSort();
    bindGlobalSearch();
    renderFloorplans();
  } catch (err) {
    console.warn("[VisionHomeAI] 用户页分类加载失败:", err);
  }
}

void mountUserPage();
