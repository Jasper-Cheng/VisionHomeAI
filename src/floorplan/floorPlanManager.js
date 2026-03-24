import { DATA_PATHS } from "../core/schema.js";

const THUMB_VARIANTS = [
  "thumb-skeleton thumb-floorplan",
  "thumb-skeleton thumb-floorplan thumb-floorplan--alt",
  "thumb-skeleton thumb-floorplan thumb-floorplan--compact",
  "thumb-skeleton thumb-floorplan",
  "thumb-skeleton thumb-floorplan thumb-floorplan--alt",
  "thumb-skeleton thumb-floorplan thumb-floorplan--wide",
];

async function fetchFloorPlanLibraryJson() {
  const res = await fetch(DATA_PATHS.floorPlanLibrary, { cache: "no-store" });
  if (!res.ok) throw new Error(`floorPlanLibrary fetch failed: ${DATA_PATHS.floorPlanLibrary}`);
  return res.json();
}

/**
 * @returns {{ items: object[], byId: Map<string, object>, raw: object }}
 */
export async function loadFloorPlanCatalog() {
  const raw = await fetchFloorPlanLibraryJson();
  const items = Array.isArray(raw?.floorPlanLibrary) ? raw.floorPlanLibrary : [];
  const byId = new Map(items.map((t) => [t.id, t]));
  return { items, byId, raw };
}

function cardDisplayName(entry) {
  const p = entry?.project;
  if (!p) return entry?.id || "户型";
  const name = p.name || entry.id;
  const a = p.areaM2;
  if (a != null && Number.isFinite(Number(a))) return `${name} 约${a}㎡`;
  return name;
}

/**
 * 渲染户型库 Tab + 卡片（数据来自 floorPlanLibrary.json）
 */
export function mountFloorplanLibrary(catalog, options = {}) {
  const strip = document.querySelector(".floorplan-tabs");
  const grid = document.getElementById("floorPlanGrid");
  if (!strip || !grid) return;

  strip.replaceChildren();
  grid.replaceChildren();

  const categoryFirstIndex = new Map();
  (catalog.items || []).forEach((it, index) => {
    const c = it?.project?.category;
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

  const searchInput = document.querySelector(".floorplan-search-input");

  function applyFilter() {
    const active = strip.querySelector(".tab.is-active");
    const category = active?.dataset.category ?? "";
    const q = (searchInput?.value || "").trim().toLowerCase();
    grid.querySelectorAll(".floorplan-card").forEach((card) => {
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

  (catalog.items || []).forEach((entry, idx) => {
    const p = entry.project || {};
    const display = cardDisplayName(entry);
    const category = p.category || "";
    const fid = String(entry.id || "").trim();

    const card = document.createElement("article");
    card.className = "asset-card floorplan-card";
    card.dataset.floorPlanId = fid;
    card.dataset.category = category;
    card.dataset.name = display.toLowerCase();
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", display);
    card.setAttribute("title", display);

    const thumb = document.createElement("div");
    thumb.className = "asset-thumb";
    const sk = document.createElement("div");
    sk.className = THUMB_VARIANTS[idx % THUMB_VARIANTS.length];
    thumb.appendChild(sk);

    const nameEl = document.createElement("div");
    nameEl.className = "asset-name";
    nameEl.textContent = display;

    card.appendChild(thumb);
    card.appendChild(nameEl);
    grid.appendChild(card);
  });

  if (options.loadError) {
    const msg = document.createElement("p");
    msg.className = "furniture-load-hint";
    msg.textContent = "户型库加载失败，请检查 data/templates/floorPlanLibrary.json。";
    grid.appendChild(msg);
  }

  applyFilter();
}
