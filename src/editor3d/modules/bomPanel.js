export function createBomPanel(ctx) {
  const {
    byId,
    extractFurnitureFootprintCm,
    formatSkuMarkupLabel,
    furnitureRoot,
    getFloorsFromEntry,
    getFurnitureDisplayName,
    hasFurnitureMaterialConfig,
    normalizeFloorIndex,
    normalizeFloorKey,
    normalizeFurnitureSelection,
    resolveFurnitureSelectionDetail,
    selectFurniture,
    setFloorLevelsVisible,
    state,
    syncOtherOpacityUi,
    applyFloorLevelSelectionChange,
  } = ctx;

  /** 单件：条目 `price` + 当前 SKU `markup`（有材质配置时） */
  function getFurnitureLinePrice(item, group) {
    const base = Number(item?.price ?? 0);
    if (!item || base <= 0) return 0;
    if (!hasFurnitureMaterialConfig(item)) return base;
    const sel = normalizeFurnitureSelection(item, group?.userData?.furnitureSelection);
    const det = resolveFurnitureSelectionDetail(item, sel);
    const markup = det.skuMarkup != null ? det.skuMarkup : 0;
    return base + (Number.isFinite(markup) ? markup : 0);
  }

  /** 计算户型总建筑面积（平方厘米） */
  function calcFloorAreaCm2() {
    let floorAreaCm2 = 0;
    const floors = getFloorsFromEntry(state.currentFloorplanEntry);
    for (const fl of floors) {
      for (const room of fl.rooms ?? []) {
        const poly = room?.polygon;
        if (!Array.isArray(poly) || poly.length < 3) continue;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
          const [ax, ay] = poly[i];
          const [bx, by] = poly[(i + 1) % poly.length];
          area += ax * by - bx * ay;
        }
        floorAreaCm2 += Math.abs(area) / 2;
      }
    }
    return floorAreaCm2;
  }

  function refreshBomPopupIfOpen() {
    const popup = document.getElementById("bomPopup");
    if (!popup || popup.hidden) return;
    fillBomPopupContent();
  }

  function refreshSpacePopupIfOpen() {
    const popup = document.getElementById("spacePopup");
    if (!popup || popup.hidden) return;
    fillSpacePopupContent();
  }

  function updateBottomUI() {
    const priceEl = document.getElementById("bottomUiPrice");
    const pctEl = document.getElementById("bottomUiRatePercent");
    const levelEl = document.getElementById("bottomUiRateLevel");
    if (!priceEl && !pctEl) return;

    let totalPrice = 0;
    let furnitureAreaCm2 = 0;
    const decCatalog = window.__decorationCatalog;
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const modelType = g.userData.modelType;
      const isDecoration = decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType);

      if (!isDecoration) {
        const item = byId.get(modelType);
        const price = getFurnitureLinePrice(item, g);
        if (price > 0) totalPrice += price;
      }

      if (isDecoration) {
        const decItem = decCatalog.byId.get(modelType);
        const fp = extractFurnitureFootprintCm(decItem);
        furnitureAreaCm2 += fp.hw * fp.hh * 4;
      } else {
        const hw = g.userData.footprint?.hw ?? 0;
        const hh = g.userData.footprint?.hh ?? 0;
        furnitureAreaCm2 += hw * hh * 4;
      }
    });

    if (priceEl) {
      priceEl.textContent = `¥${totalPrice.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    const floorAreaCm2 = calcFloorAreaCm2();
    if (pctEl || levelEl) {
      const pct = floorAreaCm2 > 0 ? Math.min(100, Math.round((furnitureAreaCm2 / floorAreaCm2) * 100)) : 0;
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (levelEl) {
        let level = "-";
        if (floorAreaCm2 > 0) {
          if (pct >= 60) level = "拥挤";
          else if (pct >= 40) level = "紧凑";
          else if (pct >= 20) level = "优秀";
          else if (pct >= 8) level = "适中";
          else level = "稀疏";
        }
        levelEl.textContent = level;
      }
    }

    refreshBomPopupIfOpen();
    refreshSpacePopupIfOpen();
  }

  /**
   * 从预算/空间弹窗条目选中对应 3D 家具/装饰；若目标在其他楼层，先切到该层再选中
   * @param {any} group
   */
  function selectFurnitureFromPopupItem(group) {
    if (!group || !group.userData?.isFurniture) return;
    const fid = String(group.userData.floorId ?? "").trim();
    if (fid && state.currentFloorplanEntry) {
      const floors = getFloorsFromEntry(state.currentFloorplanEntry);
      const idx = floors.findIndex((fl) => normalizeFloorKey(fl?.id ?? "") === normalizeFloorKey(fid));
      if (idx >= 0) {
        const cur = state.floorSelectionEnabled ? normalizeFloorIndex(state.currentFloorplanEntry, state.currentFloorIndex) : -1;
        if (!state.floorSelectionEnabled || cur !== idx) {
          state.floorSelectionEnabled = true;
          state.currentFloorIndex = idx;
          syncOtherOpacityUi();
          setFloorLevelsVisible();
          applyFloorLevelSelectionChange();
        }
      }
    }
    selectFurniture(group);
  }

  function bindPopupRowSelectToFurniture(rowEl, group) {
    if (!rowEl || !group?.userData?.isFurniture) return;
    rowEl.classList.add("is-selectable");
    rowEl.tabIndex = 0;
    rowEl.setAttribute("role", "button");
    rowEl.addEventListener("click", () => {
      selectFurnitureFromPopupItem(group);
    });
    rowEl.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      selectFurnitureFromPopupItem(group);
    });
  }

  function setBomArrow(open) {
    const arrow = document.getElementById("bomArrow");
    if (arrow) arrow.textContent = open ? "▼" : "▲";
  }

  /** 重填 BOM 列表与合计（与底部总价口径一致：base + SKU markup） */
  function fillBomPopupContent() {
    const list = document.getElementById("bomPopupList");
    const total = document.getElementById("bomPopupTotal");
    if (!list) return 0;
    list.replaceChildren();
    let sum = 0;

    const tally = new Map();
    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const modelType = g.userData.modelType;
      const decCatalog = window.__decorationCatalog;
      if (decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType)) return;
      const item = byId.get(modelType);
      const name = item ? getFurnitureDisplayName(item) : modelType || "家具";
      const line = getFurnitureLinePrice(item, g);
      const baseUnit = Number(item?.price ?? 0);
      let key = modelType;
      let skuName = "";
      let markup = 0;
      if (item && hasFurnitureMaterialConfig(item)) {
        const sel = normalizeFurnitureSelection(item, g.userData.furnitureSelection);
        key = `${modelType}\0${sel?.skuId ? String(sel.skuId) : ""}`;
        const det = resolveFurnitureSelectionDetail(item, sel);
        skuName = String(det.skuName ?? "").trim();
        markup = det.skuMarkup != null && Number.isFinite(det.skuMarkup) ? det.skuMarkup : 0;
      }
      if (tally.has(key)) {
        const hit = tally.get(key);
        hit.count += 1;
        hit.groups.push(g);
      } else {
        tally.set(key, { name, line, count: 1, skuName, markup, baseUnit, groups: [g] });
      }
    });

    if (tally.size === 0) {
      const empty = document.createElement("li");
      empty.className = "bom-popup__item";
      empty.style.justifyContent = "center";
      empty.style.color = "rgba(255,255,255,0.35)";
      empty.textContent = "暂无家具";
      list.appendChild(empty);
      if (total) total.textContent = "¥0.00";
      return 0;
    }

    const fmtBomYuan = (n) =>
      `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    for (const { name, line, count, skuName, markup, baseUnit, groups } of tally.values()) {
      const li = document.createElement("li");
      li.className = "bom-popup__item";
      const label = skuName
        ? count > 1
          ? `${name}（${skuName}）×${count}`
          : `${name}（${skuName}）`
        : count > 1
          ? `${name} ×${count}`
          : name;
      const subtotal = line * count;
      sum += subtotal;
      const baseTotal = (Number.isFinite(baseUnit) ? baseUnit : 0) * count;
      const hasMarkup = Number.isFinite(markup) && markup !== 0;

      const nameCol = document.createElement("div");
      nameCol.className = "bom-popup__item-name";
      const titleEl = document.createElement("div");
      titleEl.className = "bom-popup__item-title";
      titleEl.textContent = label;
      nameCol.appendChild(titleEl);

      const priceCol = document.createElement("div");
      priceCol.className = "bom-popup__item-prices";

      if (hasMarkup) {
        const mkEl = document.createElement("div");
        mkEl.className = "bom-popup__item-markup" + (markup < 0 ? " is-negative" : "");
        const mkTotal = markup * count;
        mkEl.textContent =
          count <= 1
            ? `加价 ${formatSkuMarkupLabel(markup)}`
            : `加价 ${formatSkuMarkupLabel(markup)}/件，合计 ${formatSkuMarkupLabel(mkTotal)}`;
        nameCol.appendChild(mkEl);

        const strike = document.createElement("span");
        strike.className = "bom-popup__item-price bom-popup__item-price--strike";
        strike.textContent = baseTotal > 0 ? fmtBomYuan(baseTotal) : "—";
        const finalEl = document.createElement("span");
        finalEl.className = "bom-popup__item-price bom-popup__item-price--final";
        finalEl.textContent = subtotal > 0 ? fmtBomYuan(subtotal) : "—";
        priceCol.appendChild(strike);
        priceCol.appendChild(finalEl);
      } else {
        const p = document.createElement("span");
        p.className = "bom-popup__item-price";
        p.textContent = subtotal > 0 ? fmtBomYuan(subtotal) : "—";
        priceCol.appendChild(p);
      }

      li.appendChild(nameCol);
      li.appendChild(priceCol);
      bindPopupRowSelectToFurniture(li, Array.isArray(groups) && groups.length ? groups[0] : null);
      list.appendChild(li);
    }

    if (total) {
      total.textContent = `¥${sum.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return sum;
  }

  function openBomPopup() {
    const popup = document.getElementById("bomPopup");
    if (!popup) return;
    fillBomPopupContent();
    popup.hidden = false;
    setBomArrow(true);
  }

  function closeBomPopup() {
    const popup = document.getElementById("bomPopup");
    if (popup) popup.hidden = true;
    setBomArrow(false);
  }

  function setSpaceArrow(open) {
    const arrow = document.getElementById("spaceArrow");
    if (arrow) arrow.textContent = open ? "▼" : "▲";
  }

  /** 重填空间利用率详情列表（家具和装饰的尺寸、占用比例） */
  function fillSpacePopupContent() {
    const list = document.getElementById("spacePopupList");
    const totalAreaEl = document.getElementById("spacePopupTotalArea");
    if (!list) return;

    list.replaceChildren();
    const floorAreaCm2 = calcFloorAreaCm2();
    const items = [];
    const decCatalog = window.__decorationCatalog;

    furnitureRoot.children.forEach((g) => {
      if (!g.userData?.isFurniture) return;
      const modelType = g.userData.modelType;
      const isDecoration = decCatalog?.byId instanceof Map && decCatalog.byId.has(modelType);

      let name;
      let hw;
      let hh;
      if (isDecoration) {
        const decItem = decCatalog.byId.get(modelType);
        name = decItem ? decItem.name || modelType || "装饰" : modelType || "装饰";
        const fp = extractFurnitureFootprintCm(decItem);
        hw = fp.hw;
        hh = fp.hh;
      } else {
        const item = byId.get(modelType);
        name = item ? getFurnitureDisplayName(item) : modelType || "家具";
        hw = g.userData.footprint?.hw ?? 0;
        hh = g.userData.footprint?.hh ?? 0;
      }

      const areaCm2 = hw * hh * 4;
      const pct = floorAreaCm2 > 0 ? (areaCm2 / floorAreaCm2) * 100 : 0;
      items.push({ name, hw, hh, areaCm2, pct, group: g });
    });

    if (totalAreaEl) {
      totalAreaEl.textContent = `${(floorAreaCm2 / 10000).toFixed(2)} m²`;
    }

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "space-popup__item";
      empty.style.justifyContent = "center";
      empty.style.color = "rgba(255,255,255,0.35)";
      empty.textContent = "暂无家具或装饰";
      list.appendChild(empty);
      return;
    }

    items.sort((a, b) => b.areaCm2 - a.areaCm2);

    for (const { name, hw, hh, areaCm2, pct, group } of items) {
      const li = document.createElement("li");
      li.className = "space-popup__item";

      const nameCol = document.createElement("div");
      nameCol.className = "space-popup__item-name";

      const titleEl = document.createElement("div");
      titleEl.className = "space-popup__item-title";
      titleEl.textContent = name;
      nameCol.appendChild(titleEl);

      const dimEl = document.createElement("div");
      dimEl.className = "space-popup__item-dim";
      dimEl.textContent = `${(hw * 2).toFixed(0)}×${(hh * 2).toFixed(0)} cm  |  ${(areaCm2 / 10000).toFixed(4)} m²`;
      nameCol.appendChild(dimEl);

      const percentCol = document.createElement("div");
      percentCol.className = "space-popup__item-percent";

      const pctValue = document.createElement("div");
      pctValue.className = "space-popup__item-percent-value";
      pctValue.textContent = `${pct.toFixed(2)}%`;
      percentCol.appendChild(pctValue);

      li.appendChild(nameCol);
      li.appendChild(percentCol);
      bindPopupRowSelectToFurniture(li, group);
      list.appendChild(li);
    }
  }

  function openSpacePopup() {
    const popup = document.getElementById("spacePopup");
    if (!popup) return;
    fillSpacePopupContent();
    popup.hidden = false;
    setSpaceArrow(true);
    closeBomPopup();
  }

  function closeSpacePopup() {
    const popup = document.getElementById("spacePopup");
    if (popup) popup.hidden = true;
    setSpaceArrow(false);
  }

  function initBomPanel() {
    document.getElementById("bottomUiBudgetTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = document.getElementById("bomPopup");
      if (popup?.hidden) openBomPopup();
    });
    document.getElementById("bomPopupClose")?.addEventListener("click", closeBomPopup);
    document.getElementById("bottomUiSpaceTrigger")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = document.getElementById("spacePopup");
      if (popup?.hidden) openSpacePopup();
      else closeSpacePopup();
    });
    document.getElementById("spacePopupClose")?.addEventListener("click", closeSpacePopup);
  }

  return {
    initBomPanel,
    updateBottomUI,
  };
}
