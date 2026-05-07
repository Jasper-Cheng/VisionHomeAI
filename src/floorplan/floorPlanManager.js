import { loadItemsFromManifest } from "../core/catalogLoader.js";
import { DATA_PATHS } from "../core/schema.js";
import { getFloorFootprintAreaM2 } from "./floorplanSvg.js";
import { mountFloorplanThumb } from "./floorplanPreview.js";

/**
 * @returns {{ items: object[], byId: Map<string, object>, raw: object }}
 */
export async function loadFloorPlanCatalog() {
  const items = await loadItemsFromManifest({
    manifestUrl: DATA_PATHS.floorplansManifest,
    itemsBaseUrl: DATA_PATHS.floorplansDir,
  });
  const byId = new Map(items.map((t) => [t.id, t]));
  const raw = { floorPlanLibrary: items };
  return { items, byId, raw };
}

function cardDisplayName(entry) {
  const p = entry?.project;
  if (!p) return entry?.id || "户型";
  return p.name || entry.id;
}

function getFloorplanCategory(entry) {
  const raw = entry?.project?.category ?? "";
  return String(raw ?? "").trim();
}

/** @returns {number} ㎡，优先 project.areaM2，否则由首层房间 polygon 汇总 */
function floorplanEntryAreaM2(entry) {
  const a = Number(entry?.project?.areaM2);
  if (Number.isFinite(a) && a > 0) return a;
  const floor0 = Array.isArray(entry?.floors) ? entry.floors[0] : null;
  if (floor0) {
    const sum = getFloorFootprintAreaM2(floor0);
    if (Number.isFinite(sum) && sum > 0) return sum;
  }
  return 0;
}

/** @returns {string} 如 "85m²"（m + 上标 ² U+00B2），无效则空串 */
function formatFloorplanAreaCompact(m2) {
  if (!Number.isFinite(m2) || m2 <= 0) return "";
  const r = Math.round(m2 * 10) / 10;
  if (Math.abs(r - Math.round(r)) < 1e-6) return `${Math.round(r)}m\u00B2`;
  return `${r.toFixed(1)}m\u00B2`;
}

/**
 * 渲染户型库 Tab + 卡片（数据来自 assets/floorplans/manifest + 同目录 JSON）
 */
export function mountFloorplanLibrary(catalog, options = {}) {
  const strip = document.querySelector(".floorplan-tabs");
  const grid = document.getElementById("floorPlanGrid");
  if (!strip || !grid) return;

  strip.replaceChildren();
  grid.replaceChildren();

  const categoryFirstIndex = new Map();
  (catalog.items || []).forEach((it, index) => {
    const c = getFloorplanCategory(it);
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
    strip.appendChild(makeTab(cat, cat, false));
  }

  const searchInput = document.querySelector('.side-panel[data-panel="floorplans"] .search-input');

  /** @type {HTMLElement | null} */
  let selectedFloorplanCard = null;

  function floorplanCards() {
    return grid.querySelectorAll(".asset-card[data-floor-plan-id]");
  }

  /**
   * 单选户型卡片（与家具库 .is-selected 视觉一致）
   * @param {HTMLElement | null} card
   */
  function selectFloorplanCard(card) {
    if (card != null && (!grid.contains(card) || card.classList.contains("is-hidden"))) return;

    floorplanCards().forEach((c) => {
      const on = c === card;
      c.classList.toggle("is-selected", on);
      c.setAttribute("aria-pressed", on ? "true" : "false");
    });
    selectedFloorplanCard = card;
    const id = card?.dataset?.floorPlanId?.trim() || "";
    window.__selectedFloorPlanId = id;
    if (id) {
      window.dispatchEvent(
        new CustomEvent("visionhome:floorplan-select", {
          detail: { id, entry: catalog.byId?.get(id) ?? null },
        }),
      );
    }
  }

  function syncFloorplanSelectionAfterFilter() {
    const visible = [...floorplanCards()].filter((c) => !c.classList.contains("is-hidden"));
    if (!visible.length) {
      selectFloorplanCard(null);
      window.__selectedFloorPlanId = "";
      return;
    }
    if (
      !selectedFloorplanCard ||
      selectedFloorplanCard.classList.contains("is-hidden") ||
      !grid.contains(selectedFloorplanCard)
    ) {
      selectFloorplanCard(visible[0]);
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
    syncFloorplanSelectionAfterFilter();
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

  (catalog.items || []).forEach((entry, idx) => {
    const display = cardDisplayName(entry);
    const areaM2 = floorplanEntryAreaM2(entry);
    const areaCompact = formatFloorplanAreaCompact(areaM2);
    const cardLine = areaCompact ? `${display}·${areaCompact}` : display;
    const category = getFloorplanCategory(entry);
    const fid = String(entry.id || "").trim();

    const card = document.createElement("article");
    card.className = "asset-card";
    card.draggable = false;
    card.dataset.floorPlanId = fid;
    card.dataset.category = category;
    card.dataset.name = cardLine.toLowerCase();
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-pressed", "false");
    card.setAttribute("aria-label", cardLine);
    card.setAttribute("title", cardLine);

    const thumb = document.createElement("div");
    thumb.className = "asset-thumb";
    mountFloorplanThumb(thumb, entry, idx);

    const nameEl = document.createElement("div");
    nameEl.className = "floorplan-asset-label";
    const titleSpan = document.createElement("span");
    titleSpan.className = "floorplan-asset-label__title";
    titleSpan.textContent = cardLine;
    nameEl.appendChild(titleSpan);

    card.appendChild(thumb);
    card.appendChild(nameEl);
    grid.appendChild(card);

    const activate = () => selectFloorplanCard(card);
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

  if (options.loadError) {
    const msg = document.createElement("p");
    msg.className = "furniture-load-hint";
    msg.textContent = "户型库加载失败，请检查 assets/floorplans/manifest.json 与同目录条目 JSON。";
    grid.appendChild(msg);
  }

  applyFilter();

  window.__selectFloorplanLibraryCardById = (fid) => {
    const id = String(fid || "").trim();
    if (!id) {
      selectFloorplanCard(null);
      return;
    }
    const card = [...grid.querySelectorAll(".asset-card[data-floor-plan-id]")].find((c) => c.dataset.floorPlanId === id);
    if (card) selectFloorplanCard(card);
  };
}
