/**
 * 户型 SVG 平面图：家具拖拽、网格吸附、旋转、删除
 * 家具尺寸与名称来自 data/furnitureLibrary.json（由 main 注入 catalog）
 */
import { getFurnitureDisplayName, getSvgStyleForItem } from "../furniture/svgStyle.js";

export function initSvgEditor(catalog = { items: [], byId: new Map() }) {
  const svg = document.getElementById("svgEditorCanvas");
  const viewRoot = document.getElementById("svgEditorViewRoot");
  const gridLayer = document.getElementById("svgEditorGridLayer");
  const undoBtn = document.querySelector("[data-svg-undo]");
  const redoBtn = document.querySelector("[data-svg-redo]");
  const gridToggleBtn = document.getElementById("svgGridToggleBtn");

  /** 墙层 / 家具层不再写在 index.html；家具层在运行时创建（墙层待户型 SVG 渲染接入时再挂 #svgEditorWalls） */
  let furnitureLayer = document.getElementById("svgEditorFurnitureLayer");
  if (!furnitureLayer && viewRoot) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", "svgEditorFurnitureLayer");
    g.setAttribute("class", "svg-editor-furniture-layer");
    g.setAttribute("aria-label", "家具布局");
    viewRoot.appendChild(g);
    furnitureLayer = g;
  }

  if (!svg || !furnitureLayer) return;

  const byId = catalog.byId instanceof Map ? catalog.byId : new Map();

  const propertiesPanel = document.getElementById("propertiesPanel");
  const propertiesName = propertiesPanel?.querySelector(".properties-name");
  const propInputX = propertiesPanel?.querySelector('input[data-prop="x"]');
  const propInputZ = propertiesPanel?.querySelector('input[data-prop="z"]');
  const propInputRotY = propertiesPanel?.querySelector('input[data-prop="rotY"]');

  /** 与 index.html 中 SVG viewBox 一致：画布逻辑坐标 3000×3000（户型几何单独绘制，尺寸不变） */
  const VIEW_W = 3000;
  const VIEW_H = 3000;
  const GRID = 20;

  /** 根据家具 id 取 2D 占位尺寸与样式（未知 id 用保守默认，便于兼容旧布局 JSON） */
  function getFootprint(modelId) {
    const item = byId.get(modelId);
    if (item) {
      const s = getSvgStyleForItem(item);
      if (s) return s;
    }
    return {
      hw: 50,
      hh: 50,
      fill: "rgba(100,116,139,0.38)",
      stroke: "rgba(148,163,184,0.9)",
      label: "?",
      longName: modelId || "家具",
    };
  }

  let selectedEl = null;
  let dragState = null;
  let middlePanState = null;

  /** 撤销 / 重做：家具布局快照 */
  const MAX_HISTORY = 80;
  let history = [];
  let historyIndex = -1;
  let historyReady = false;
  let isRestoring = false;
  let historyDebounceTimer = null;

  let gridVisible = true;

  function serializeLayout() {
    return JSON.stringify(getLayout());
  }

  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
  }

  function pushHistorySnapshot() {
    if (!historyReady || isRestoring) return;
    const s = serializeLayout();
    if (history.length && history[historyIndex] === s) return;
    history = history.slice(0, historyIndex + 1);
    history.push(s);
    historyIndex = history.length - 1;
    while (history.length > MAX_HISTORY) {
      history.shift();
      historyIndex--;
    }
    updateUndoRedoButtons();
  }

  function schedulePushHistory() {
    if (!historyReady || isRestoring) return;
    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = setTimeout(() => {
      historyDebounceTimer = null;
      pushHistorySnapshot();
    }, 450);
  }

  function initHistory() {
    history = [serializeLayout()];
    historyIndex = 0;
    updateUndoRedoButtons();
  }

  /** 按布局重建家具层（不写入历史） */
  function rebuildFromLayout(layout) {
    isRestoring = true;
    furnitureLayer.replaceChildren();
    for (const item of layout) {
      appendFurnitureItem(item.model, item.x, item.y, item.rotation ?? 0);
    }
    isRestoring = false;
  }

  function applyHistoryIndex(i) {
    const layout = JSON.parse(history[i]);
    rebuildFromLayout(layout);
    select(null);
    updateUndoRedoButtons();
  }

  function undoSvg() {
    if (historyIndex <= 0) return;
    historyIndex--;
    applyHistoryIndex(historyIndex);
  }

  function redoSvg() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    applyHistoryIndex(historyIndex);
  }

  function setGridVisible(visible) {
    gridVisible = !!visible;
    gridLayer?.classList.toggle("svg-grid-hidden", !gridVisible);
    if (gridToggleBtn) {
      gridToggleBtn.classList.toggle("is-active", gridVisible);
      gridToggleBtn.setAttribute("aria-pressed", String(gridVisible));
    }
  }

  function toggleGridVisible() {
    setGridVisible(!gridVisible);
  }

  /** 视图：与 #svgEditorViewRoot 的 transform 一致（世界坐标 ↔ 屏幕） */
  let viewTx = 0;
  let viewTy = 0;
  let viewScale = 1;
  const SCALE_MIN = 0.12;
  const SCALE_MAX = 8;
  const ZOOM_STEP = 1.18;
  const PAN_STEP = 120;

  function snap(v) {
    return Math.round(v / GRID) * GRID;
  }

  function applyViewTransform() {
    if (!viewRoot) return;
    viewRoot.setAttribute("transform", `translate(${viewTx} ${viewTy}) scale(${viewScale})`);
  }

  /** 屏幕 → SVG 根用户坐标（viewBox 空间，含 viewRoot 变换在屏幕上的效果） */
  function clientToRootSvg(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    return pt.matrixTransform(ctm.inverse());
  }

  /** 屏幕坐标 → 户型世界坐标（与家具 translate 一致） */
  function clientToWorld(clientX, clientY) {
    const root = clientToRootSvg(clientX, clientY);
    if (!viewRoot) return { x: root.x, y: root.y };
    const s = viewScale || 1;
    return {
      x: (root.x - viewTx) / s,
      y: (root.y - viewTy) / s,
    };
  }

  /** 以 (rx,ry) 为锚点缩放（根坐标，通常为指针位置） */
  function zoomAtRootPoint(rx, ry, factor) {
    const wx = (rx - viewTx) / viewScale;
    const wy = (ry - viewTy) / viewScale;
    let next = viewScale * factor;
    next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    if (Math.abs(next - viewScale) < 1e-9) return;
    viewScale = next;
    viewTx = rx - wx * viewScale;
    viewTy = ry - wy * viewScale;
    applyViewTransform();
  }

  function zoomAtViewCenter(factor) {
    zoomAtRootPoint(VIEW_W / 2, VIEW_H / 2, factor);
  }

  /** 滚轮：deltaY 负为放大；触控板用指数更顺 */
  function wheelZoomFactor(deltaY, ctrlKey) {
    const k = ctrlKey ? 0.008 : 0.0015;
    let f = Math.exp(-deltaY * k);
    f = Math.min(Math.max(f, 0.9), 1.11);
    return f;
  }

  function resetView() {
    viewTx = 0;
    viewTy = 0;
    viewScale = 1;
    applyViewTransform();
  }

  function panView(dxRoot, dyRoot) {
    viewTx += dxRoot;
    viewTy += dyRoot;
    applyViewTransform();
  }

  function parseTranslate(g) {
    const t = g.getAttribute("transform") || "";
    const m = t.match(/translate\(\s*([\d.-]+)\s*[,\s]\s*([\d.-]+)/);
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    return { x: 0, y: 0 };
  }

  function getRotation(g) {
    const r = parseInt(g.getAttribute("data-rot") || "0", 10);
    return Number.isFinite(r) ? r % 360 : 0;
  }

  function setRotation(g, deg) {
    g.setAttribute("data-rot", String(deg));
    applyTransform(g);
  }

  function applyTransform(g) {
    const { x, y } = parseTranslate(g);
    const rot = getRotation(g);
    g.setAttribute("transform", `translate(${x},${y}) rotate(${rot})`);
  }

  function clampPosition(g, x, y) {
    const type = g.getAttribute("data-model") || "";
    const def = getFootprint(type);
    const hw = def.hw;
    const hh = def.hh;
    const margin = 10;
    const nx = Math.min(Math.max(x, hw + margin), VIEW_W - hw - margin);
    const ny = Math.min(Math.max(y, hh + margin), VIEW_H - hh - margin);
    return { x: snap(nx), y: snap(ny) };
  }

  /** 与 3D 共用右侧面板：位置 X / 位置 Y(存 Z 字段) / 旋转° */
  function syncPropertiesPanelForSelection(g) {
    if (!propertiesPanel) return;
    if (!g || !furnitureLayer.contains(g)) {
      propertiesPanel.classList.remove("is-visible");
      if (propertiesName) propertiesName.textContent = "未选择";
      return;
    }
    propertiesPanel.classList.add("is-visible");
    const id = g.getAttribute("data-model") || "";
    const item = byId.get(id);
    if (propertiesName) {
      propertiesName.textContent = item ? getFurnitureDisplayName(item) : getFootprint(id).longName || id || "家具";
    }
    const pos = parseTranslate(g);
    const rot = getRotation(g);
    if (propInputX) propInputX.value = pos.x.toFixed(2);
    if (propInputZ) propInputZ.value = pos.y.toFixed(2);
    if (propInputRotY) propInputRotY.value = String(rot);
  }

  /** 仅清除 SVG 选中样式（3D 选中时由 viewer 调用，避免双选） */
  function deselectVisualOnly() {
    if (selectedEl) {
      selectedEl.classList.remove("is-selected");
      selectedEl = null;
    }
  }
  window.svgEditorDeselect = deselectVisualOnly;

  /** 从属性面板读数写回当前 SVG 家具；有选中时返回 true（供 viewer 的 input 回调优先处理） */
  function applyPropertiesFromPanelToSvg() {
    if (!selectedEl || !furnitureLayer.contains(selectedEl)) return false;
    const x = parseFloat(propInputX?.value ?? "");
    const zField = parseFloat(propInputZ?.value ?? "");
    const deg = parseFloat(propInputRotY?.value ?? "");
    const pos = parseTranslate(selectedEl);
    const nx = Number.isFinite(x) ? x : pos.x;
    const ny = Number.isFinite(zField) ? zField : pos.y;
    const c = clampPosition(selectedEl, nx, ny);
    let rot = getRotation(selectedEl);
    if (Number.isFinite(deg)) {
      rot = Math.round(deg) % 360;
      if (rot < 0) rot += 360;
    }
    selectedEl.setAttribute("data-rot", String(rot));
    selectedEl.setAttribute("transform", `translate(${c.x},${c.y}) rotate(${rot})`);
    schedulePushHistory();
    return true;
  }
  window.svgEditorApplyPropertiesFromPanel = applyPropertiesFromPanelToSvg;

  function select(g) {
    if (selectedEl && selectedEl !== g) selectedEl.classList.remove("is-selected");
    selectedEl = g || null;
    if (selectedEl) {
      selectedEl.classList.add("is-selected");
      try {
        selectedEl.focus({ preventScroll: true });
      } catch (_) {
        /* ignore */
      }
    }
    syncPropertiesPanelForSelection(selectedEl);
  }

  function appendFurnitureItem(type, cx, cy, rotationDeg = 0) {
    const item = byId.get(type);
    if (!item) return null;
    const def = getSvgStyleForItem(item);
    if (!def) return null;

    let rot = Math.round(Number(rotationDeg) || 0) % 360;
    if (rot < 0) rot += 360;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.classList.add("svg-furniture");
    g.setAttribute("data-model", type);
    g.setAttribute("data-rot", String(rot));
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", `${def.longName}，可拖拽`);

    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(-def.hw));
    rect.setAttribute("y", String(-def.hh));
    rect.setAttribute("width", String(def.hw * 2));
    rect.setAttribute("height", String(def.hh * 2));
    rect.setAttribute("rx", "14");
    rect.setAttribute("fill", def.fill);
    rect.setAttribute("stroke", def.stroke);
    rect.setAttribute("stroke-width", "5");
    rect.classList.add("svg-furniture-shape");

    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("y", "10");
    text.setAttribute("fill", "rgba(255,255,255,0.88)");
    text.setAttribute("font-size", "28");
    text.setAttribute("font-weight", "700");
    text.setAttribute("pointer-events", "none");
    text.textContent = def.label;

    g.appendChild(rect);
    g.appendChild(text);

    const pos = clampPosition(g, cx, cy);
    g.setAttribute("transform", `translate(${pos.x},${pos.y}) rotate(${rot})`);
    furnitureLayer.appendChild(g);
    return g;
  }

  function createFurnitureGroup(type, cx, cy) {
    const g = appendFurnitureItem(type, cx, cy, 0);
    if (g) select(g);
    return g;
  }

  function addFurniture(type, cx = VIEW_W / 2, cy = VIEW_H / 2) {
    const g = createFurnitureGroup(type, cx, cy);
    if (g && historyReady) pushHistorySnapshot();
    return g;
  }

  function removeSelected() {
    if (!selectedEl || !furnitureLayer.contains(selectedEl)) return;
    selectedEl.remove();
    selectedEl = null;
    syncPropertiesPanelForSelection(null);
    if (historyReady) pushHistorySnapshot();
  }

  /** 从家具库 Shift+点击：加入平面图中心偏一点，避免重叠 */
  function addFromLibrary(model) {
    if (!byId.has(model)) return;
    const jitter = (Math.random() - 0.5) * GRID * 4;
    addFurniture(model, VIEW_W / 2 + jitter, VIEW_H / 2 + jitter);
  }

  function endDrag(e) {
    if (!dragState) return;
    if (e.pointerId !== dragState.pointerId) return;
    dragState.el.classList.remove("is-dragging");
    try {
      dragState.el.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const endedEl = dragState.el;
    dragState = null;
    if (selectedEl === endedEl) syncPropertiesPanelForSelection(selectedEl);
    if (historyReady) pushHistorySnapshot();
  }

  function onWindowMove(e) {
    if (!dragState || e.pointerId !== dragState.pointerId) return;
    const p = clientToWorld(e.clientX, e.clientY);
    const nx = p.x - dragState.grabX;
    const ny = p.y - dragState.grabY;
    const c = clampPosition(dragState.el, nx, ny);
    const r = getRotation(dragState.el);
    dragState.el.setAttribute("transform", `translate(${c.x},${c.y}) rotate(${r})`);
    if (propInputX) propInputX.value = c.x.toFixed(2);
    if (propInputZ) propInputZ.value = c.y.toFixed(2);
  }

  function onMiddlePanMove(e) {
    if (!middlePanState || e.pointerId !== middlePanState.pointerId) return;
    const r = clientToRootSvg(e.clientX, e.clientY);
    viewTx += r.x - middlePanState.lastRx;
    viewTy += r.y - middlePanState.lastRy;
    middlePanState.lastRx = r.x;
    middlePanState.lastRy = r.y;
    applyViewTransform();
  }

  function endMiddlePan(e) {
    if (!middlePanState) return;
    if (e.pointerId !== middlePanState.pointerId) return;
    svg.classList.remove("is-middle-panning");
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    window.removeEventListener("pointermove", onMiddlePanMove);
    window.removeEventListener("pointerup", endMiddlePan);
    window.removeEventListener("pointercancel", endMiddlePan);
    middlePanState = null;
  }

  function startMiddlePan(e) {
    if (!viewRoot) return;
    if (middlePanState) return;
    e.preventDefault();
    const r = clientToRootSvg(e.clientX, e.clientY);
    middlePanState = { pointerId: e.pointerId, lastRx: r.x, lastRy: r.y };
    svg.classList.add("is-middle-panning");
    try {
      svg.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    window.addEventListener("pointermove", onMiddlePanMove, { passive: true });
    window.addEventListener("pointerup", endMiddlePan);
    window.addEventListener("pointercancel", endMiddlePan);
  }

  svg.addEventListener("wheel", (e) => {
    if (!viewRoot) return;
    e.preventDefault();
    const r = clientToRootSvg(e.clientX, e.clientY);
    const factor = wheelZoomFactor(e.deltaY, e.ctrlKey);
    zoomAtRootPoint(r.x, r.y, factor);
  }, { passive: false });

  svg.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  svg.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        startMiddlePan(e);
        return;
      }

      const item = e.target.closest(".svg-furniture");
      if (item && furnitureLayer.contains(item)) {
        e.stopPropagation();
        select(item);
        try {
          item.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
        const p = clientToWorld(e.clientX, e.clientY);
        const pos = parseTranslate(item);
        dragState = {
          el: item,
          grabX: p.x - pos.x,
          grabY: p.y - pos.y,
          pointerId: e.pointerId,
        };
        item.classList.add("is-dragging");
        window.addEventListener("pointermove", onWindowMove, { passive: true });
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
        return;
      }

      if (e.target.classList?.contains("svg-editor-bg") || e.target === svg) {
        select(null);
      }
    },
    true,
  );

  svg.addEventListener("dblclick", (e) => {
    const item = e.target.closest(".svg-furniture");
    if (!item || !furnitureLayer.contains(item)) return;
    e.preventDefault();
    const next = (getRotation(item) + 90) % 360;
    setRotation(item, next);
    if (selectedEl === item) syncPropertiesPanelForSelection(item);
    if (historyReady) pushHistorySnapshot();
  });

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "z") {
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) redoSvg();
      else undoSvg();
      return;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    if (!selectedEl) return;
    e.preventDefault();
    removeSelected();
  });

  applyViewTransform();

  document.querySelectorAll("[data-svg-zoom]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.svgZoom;
      if (dir === "in") zoomAtViewCenter(ZOOM_STEP);
      else if (dir === "out") zoomAtViewCenter(1 / ZOOM_STEP);
    });
  });
  document.querySelectorAll("[data-svg-reset]").forEach((btn) => {
    btn.addEventListener("click", () => resetView());
  });
  document.querySelectorAll("[data-svg-pan]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.svgPan;
      const s = PAN_STEP;
      /* 与箭头语义一致：按「把内容往箭头方向推」的直觉 */
      if (dir === "left") panView(-s, 0);
      else if (dir === "right") panView(s, 0);
      else if (dir === "up") panView(0, -s);
      else if (dir === "down") panView(0, s);
    });
  });

  document.querySelectorAll("[data-svg-grid-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => toggleGridVisible());
  });
  undoBtn?.addEventListener("click", () => undoSvg());
  redoBtn?.addEventListener("click", () => redoSvg());

  /** Shift + 点击家具库卡片：加入平面图（不触发 3D 拖拽） */
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.shiftKey) return;
      const card = e.target.closest?.(".asset-card[data-model]");
      if (!card) return;
      const panel = card.closest?.(".side-panel[data-panel='assets']");
      if (!panel || !panel.classList.contains("is-visible")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      addFromLibrary(card.dataset.model);
    },
    true,
  );

  /** 导出布局（供保存 / 与 3D 同步） */
  function getLayout() {
    return Array.from(furnitureLayer.querySelectorAll(".svg-furniture")).map((g) => {
      const pos = parseTranslate(g);
      return {
        model: g.getAttribute("data-model"),
        x: pos.x,
        y: pos.y,
        rotation: getRotation(g),
      };
    });
  }

  window.svgEditorAddFurniture = addFurniture;
  window.svgEditorGetLayout = getLayout;
  window.svgEditorGetViewSize = () => ({ width: VIEW_W, height: VIEW_H });
  window.svgEditorResetView = resetView;
  window.svgEditorGetViewTransform = () => ({ tx: viewTx, ty: viewTy, scale: viewScale });

  select(null);
  initHistory();
  historyReady = true;
  setGridVisible(true);
}
