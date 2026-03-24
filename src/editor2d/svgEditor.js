/**
 * 户型 SVG 平面图：家具拖拽、网格吸附、旋转、删除
 * 家具尺寸与名称来自 data/furniture/ 各条目 JSON（由 main 注入 catalog）
 */
import { appendFloorGeometryToGroup, getFloorBBoxMm, getPrimaryFloor } from "../floorplan/floorplanSvg.js";
import { getFurnitureDisplayName, getSvgStyleForItem } from "../furniture/svgStyle.js";

/**
 * @returns {{ ok: boolean, reason?: string | null, catalogSize?: number, error?: string }}
 */
export function initSvgEditor(catalog = { items: [], byId: new Map() }) {
  const svg = document.getElementById("svgEditorCanvas");
  const viewRoot = document.getElementById("svgEditorViewRoot");
  const gridLayer = document.getElementById("svgEditorGridLayer");
  const undoBtn = document.querySelector("[data-svg-undo]");
  const redoBtn = document.querySelector("[data-svg-redo]");
  const gridToggleBtn = document.getElementById("svgGridToggleBtn");

  /** 墙层 / 家具层不再写在 index.html；户型底图在网格之上、家具之下 */
  function svgEditorFail(reason) {
    const r = { ok: false, reason };
    window.__visionHomeSvgEditor = r;
    return r;
  }

  if (!svg) {
    return svgEditorFail("missing-svgEditorCanvas");
  }
  if (!viewRoot) {
    return svgEditorFail("missing-svgEditorViewRoot");
  }

  let furnitureLayer = document.getElementById("svgEditorFurnitureLayer");

  let floorplanLayer = document.getElementById("svgEditorFloorplanLayer");
  if (!floorplanLayer) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", "svgEditorFloorplanLayer");
    g.setAttribute("class", "svg-editor-floorplan-layer");
    g.setAttribute("aria-label", "户型底图");
    if (furnitureLayer && viewRoot.contains(furnitureLayer)) {
      viewRoot.insertBefore(g, furnitureLayer);
    } else if (gridLayer && viewRoot.contains(gridLayer)) {
      const next = gridLayer.nextSibling;
      if (next) viewRoot.insertBefore(g, next);
      else viewRoot.appendChild(g);
    } else {
      viewRoot.appendChild(g);
    }
    floorplanLayer = g;
  }

  if (!furnitureLayer) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("id", "svgEditorFurnitureLayer");
    g.setAttribute("class", "svg-editor-furniture-layer");
    g.setAttribute("aria-label", "家具布局");
    viewRoot.appendChild(g);
    furnitureLayer = g;
  }
  if (!furnitureLayer) {
    return svgEditorFail("furniture-layer-missing");
  }

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

  /** 拖动画布 / 家具 / 从侧栏拖出时禁止划选工具栏说明文字等（Safari/Chrome 均会出现蓝选区） */
  const POINTER_DRAG_BODY_CLASS = "vision-home-pointer-dragging";
  let pointerDragTextSuppressionDepth = 0;
  function pushPointerDragTextSuppression() {
    pointerDragTextSuppressionDepth += 1;
    document.body.classList.add(POINTER_DRAG_BODY_CLASS);
  }
  function popPointerDragTextSuppression() {
    pointerDragTextSuppressionDepth = Math.max(0, pointerDragTextSuppressionDepth - 1);
    if (pointerDragTextSuppressionDepth === 0) {
      document.body.classList.remove(POINTER_DRAG_BODY_CLASS);
      try {
        const sel = window.getSelection?.();
        if (sel && sel.rangeCount > 0) sel.removeAllRanges();
      } catch (_) {
        /* ignore */
      }
    }
  }

  document.addEventListener(
    "selectstart",
    (e) => {
      if (!document.body.classList.contains(POINTER_DRAG_BODY_CLASS)) return;
      const t = e.target;
      if (t?.closest?.("input, textarea, select, [contenteditable='true'], .search-input, .prop-input, .file-search-input")) {
        return;
      }
      e.preventDefault();
    },
    true,
  );

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
  /** 左键在空白处按下后，超过阈值再进入平移（避免误触） */
  let pendingLeftPan = null;
  let selectedFloorplanRoot = null;

  /** 撤销 / 重做：家具布局 + 户型 id（null 表示无户型；旧快照为纯数组时撤销不改户型层） */
  const MAX_HISTORY = 80;
  let history = [];
  let historyIndex = -1;
  let historyReady = false;
  let isRestoring = false;
  let historyDebounceTimer = null;

  let gridVisible = true;

  function serializeEditorSnapshot() {
    return JSON.stringify({
      v: 1,
      furniture: getLayout(),
      floorPlanId: getCurrentFloorplanId(),
    });
  }

  /**
   * @param {unknown} parsed JSON.parse 结果
   * @returns {{ furniture: unknown[], floorPlanId: string | null | undefined } | null}
   */
  function normalizeHistorySnapshot(parsed) {
    if (Array.isArray(parsed)) {
      return { furniture: parsed, floorPlanId: undefined };
    }
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.furniture)) {
      const id = /** @type {{ floorPlanId?: unknown }} */ (parsed).floorPlanId;
      if (id === undefined) {
        return { furniture: parsed.furniture, floorPlanId: undefined };
      }
      if (id === null || String(id).trim() === "") {
        return { furniture: parsed.furniture, floorPlanId: null };
      }
      return { furniture: parsed.furniture, floorPlanId: String(id).trim() };
    }
    return null;
  }

  /** 将某一历史帧应用到画布（不修改 history 数组；调用方负责 isRestoring） */
  function applyHistorySnapshotState(state) {
    if (!state) return;
    if (state.floorPlanId !== undefined) {
      if (state.floorPlanId) {
        const cat = window.__floorPlanCatalog;
        const entry = cat?.byId instanceof Map ? cat.byId.get(state.floorPlanId) : null;
        if (entry) applyFloorplanEntryAtWorld(entry);
        else clearFloorplanLayerContent();
      } else {
        clearFloorplanLayerContent();
      }
    }
    const furn = Array.isArray(state.furniture) ? state.furniture : [];
    rebuildFromLayout(furn);
  }

  function updateUndoRedoButtons() {
    if (undoBtn) undoBtn.disabled = historyIndex <= 0;
    if (redoBtn) redoBtn.disabled = historyIndex >= history.length - 1;
  }

  function emitSvgLayoutChanged() {
    window.dispatchEvent(new CustomEvent("visionhome:svg-layout-changed"));
  }

  function pushHistorySnapshot() {
    if (!historyReady || isRestoring) return;
    const s = serializeEditorSnapshot();
    if (history.length && history[historyIndex] === s) return;
    history = history.slice(0, historyIndex + 1);
    history.push(s);
    historyIndex = history.length - 1;
    while (history.length > MAX_HISTORY) {
      history.shift();
      historyIndex--;
    }
    updateUndoRedoButtons();
    emitSvgLayoutChanged();
  }

  function schedulePushHistory() {
    if (!historyReady || isRestoring) return;
    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = setTimeout(() => {
      historyDebounceTimer = null;
      pushHistorySnapshot();
    }, 450);
  }

  /** 离开页面前调用：把防抖中的布局写入撤销栈，避免会话快照落后一档 */
  function flushHistoryDebounce() {
    if (historyDebounceTimer) {
      clearTimeout(historyDebounceTimer);
      historyDebounceTimer = null;
      pushHistorySnapshot();
    }
  }

  function initHistory() {
    history = [serializeEditorSnapshot()];
    historyIndex = 0;
    updateUndoRedoButtons();
  }

  /** 按布局重建家具层（不写入历史；调用方在需抑制入栈时应设 isRestoring） */
  function rebuildFromLayout(layout) {
    furnitureLayer.replaceChildren();
    for (const item of layout) {
      appendFurnitureItem(item.model, item.x, item.y, item.rotation ?? 0);
    }
  }

  function applyHistoryIndex(i) {
    let state;
    try {
      state = normalizeHistorySnapshot(JSON.parse(history[i]));
    } catch {
      state = null;
    }
    if (!state) return;
    isRestoring = true;
    try {
      applyHistorySnapshotState(state);
    } finally {
      isRestoring = false;
    }
    select(null);
    updateUndoRedoButtons();
    emitSvgLayoutChanged();
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

  function clearFloorplanSelection() {
    if (selectedFloorplanRoot) {
      selectedFloorplanRoot.classList.remove("is-selected");
      selectedFloorplanRoot = null;
    }
  }

  function setFloorplanSelected(root) {
    clearFloorplanSelection();
    if (root && floorplanLayer.contains(root)) {
      selectedFloorplanRoot = root;
      root.classList.add("is-selected");
    }
  }

  function clearFloorplanLayerContent() {
    clearFloorplanSelection();
    floorplanLayer.replaceChildren();
    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  /**
   * @param {{ skipFocus?: boolean }} [options] Safari：pointerdown 时立刻 focus SVG 组可能干扰拖拽，鼠标按下选中应 skipFocus
   */
  function select(g, options = {}) {
    const skipFocus = options.skipFocus === true;
    if (g) {
      clearFloorplanSelection();
      if (selectedEl && selectedEl !== g) selectedEl.classList.remove("is-selected");
      selectedEl = g;
      selectedEl.classList.add("is-selected");
      if (!skipFocus) {
        try {
          selectedEl.focus({ preventScroll: true });
        } catch (_) {
          /* ignore */
        }
      }
    } else {
      if (selectedEl) selectedEl.classList.remove("is-selected");
      selectedEl = null;
      clearFloorplanSelection();
    }
    syncPropertiesPanelForSelection(selectedEl);
  }

  function appendFurnitureItem(type, cx, cy, rotationDeg = 0) {
    const item = byId.get(type);
    if (!item) return null;
    let def = getSvgStyleForItem(item);
    if (!def) {
      const fp = getFootprint(type);
      def = {
        fill: fp.fill,
        stroke: fp.stroke,
        label: fp.label,
        longName: fp.longName,
        hw: fp.hw,
        hh: fp.hh,
      };
    }

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
    /* WebKit：家具上用 setPointerCapture 常无效，拖拽时在根 svg 上 capture，此处对应 release */
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch (_) {
      try {
        dragState.el.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    const endedEl = dragState.el;
    dragState = null;
    popPointerDragTextSuppression();
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
    popPointerDragTextSuppression();
  }

  function clearPendingLeftPan() {
    if (!pendingLeftPan) return;
    window.removeEventListener("pointermove", onPendingLeftPanMove);
    window.removeEventListener("pointerup", endPendingLeftPan);
    window.removeEventListener("pointercancel", endPendingLeftPan);
    pendingLeftPan = null;
  }

  function endPendingLeftPan(e) {
    if (!pendingLeftPan || e.pointerId !== pendingLeftPan.pointerId) return;
    clearPendingLeftPan();
    popPointerDragTextSuppression();
  }

  function onPendingLeftPanMove(e) {
    if (!pendingLeftPan || e.pointerId !== pendingLeftPan.pointerId) return;
    const d = Math.hypot(e.clientX - pendingLeftPan.sx, e.clientY - pendingLeftPan.sy);
    if (d < 6) return;
    const r = clientToRootSvg(e.clientX, e.clientY);
    clearPendingLeftPan();
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

  function isPointerOnCanvasBackground(target) {
    if (!target || target === svg) return true;
    if (target.classList?.contains("svg-editor-bg")) return true;
    if (target.id === "svgEditorGridLayer") return true;
    return false;
  }

  function startMiddlePan(e) {
    if (!viewRoot) return;
    if (middlePanState) return;
    e.preventDefault();
    pushPointerDragTextSuppression();
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

      const item = e.target.closest?.(".svg-furniture");
      if (item && furnitureLayer.contains(item)) {
        e.preventDefault();
        e.stopPropagation();
        select(item, { skipFocus: true });
        /* Safari：焦点环 / 选区有时与 SVG 重绘叠成横向白条 */
        try {
          if (document.activeElement === item) item.blur();
          const sel = window.getSelection?.();
          if (sel && sel.rangeCount > 0) sel.removeAllRanges();
        } catch (_) {
          /* ignore */
        }
        /* Chrome 可在子节点 capture；Safari/WebKit 对 SVG <g> 等 capture 常失败，统一到根 svg（与画布平移一致） */
        try {
          svg.setPointerCapture(e.pointerId);
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
        pushPointerDragTextSuppression();
        item.classList.add("is-dragging");
        window.addEventListener("pointermove", onWindowMove, { passive: true });
        window.addEventListener("pointerup", endDrag);
        window.addEventListener("pointercancel", endDrag);
        return;
      }

      const fpRoot = e.target.closest?.(".svg-floorplan-root");
      if (fpRoot && floorplanLayer.contains(fpRoot) && e.button === 0) {
        e.preventDefault();
        e.stopPropagation();
        if (selectedEl) {
          selectedEl.classList.remove("is-selected");
          selectedEl = null;
        }
        syncPropertiesPanelForSelection(null);
        setFloorplanSelected(fpRoot);
        try {
          if (document.activeElement === fpRoot) fpRoot.blur();
          const sel = window.getSelection?.();
          if (sel && sel.rangeCount > 0) sel.removeAllRanges();
        } catch (_) {
          /* ignore */
        }
        return;
      }

      if (e.button === 0 && isPointerOnCanvasBackground(e.target)) {
        e.preventDefault();
        select(null);
        pushPointerDragTextSuppression();
        pendingLeftPan = { pointerId: e.pointerId, sx: e.clientX, sy: e.clientY };
        window.addEventListener("pointermove", onPendingLeftPanMove, { passive: true });
        window.addEventListener("pointerup", endPendingLeftPan);
        window.addEventListener("pointercancel", endPendingLeftPan);
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
    if (selectedFloorplanRoot && floorplanLayer.contains(selectedFloorplanRoot)) {
      e.preventDefault();
      clearFloorplanLayerContent();
      return;
    }
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
  document.querySelectorAll("[data-svg-floorplan-clear]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (floorplanLayer.childNodes.length > 0) clearFloorplanLayerContent();
    });
  });

  function isEditViewActive() {
    return document.getElementById("appViewEdit")?.classList.contains("is-active");
  }

  const FLOORPLAN_PAD = 80;
  /** 相对「铺满留白区」的等比缩小，初始户型略小便于看网格与家具 */
  const FLOORPLAN_SIZE_FACTOR = 0.38;

  /**
   * 将户型目录条目（毫米几何）缩放落入 viewBox；户型中心固定在画布逻辑中心（忽略传入坐标，兼容旧 API）
   */
  function applyFloorplanEntryAtWorld(entry, _worldX, _worldY) {
    const worldX = VIEW_W / 2;
    const worldY = VIEW_H / 2;
    const floor = getPrimaryFloor(entry);
    if (!floor) return;
    const bbox = getFloorBBoxMm(floor);
    if (!bbox) return;
    const availW = Math.max(40, VIEW_W - 2 * FLOORPLAN_PAD);
    const availH = Math.max(40, VIEW_H - 2 * FLOORPLAN_PAD);
    let s = 1;
    if (bbox.w > 1e-6 && bbox.h > 1e-6) {
      s = Math.min(availW / bbox.w, availH / bbox.h);
    }
    s *= FLOORPLAN_SIZE_FACTOR;
    s = Math.min(Math.max(s, 0.02), 4);

    clearFloorplanSelection();
    floorplanLayer.replaceChildren();
    const svgNS = "http://www.w3.org/2000/svg";

    const root = document.createElementNS(svgNS, "g");
    root.setAttribute("class", "svg-floorplan-root");
    root.setAttribute("data-floorplan-root", "1");
    if (entry?.id != null && String(entry.id).trim()) {
      root.setAttribute("data-floor-plan-id", String(entry.id).trim());
    }
    root.setAttribute("tabindex", "-1");
    root.setAttribute("aria-label", "户型底图（固定在画布中心），Delete 删除");

    const xform = document.createElementNS(svgNS, "g");
    xform.setAttribute("class", "svg-floorplan-xform");
    xform.dataset.fpWx = String(worldX);
    xform.dataset.fpWy = String(worldY);
    xform.dataset.fpS = String(s);
    xform.dataset.fpCx = String(bbox.cx);
    xform.dataset.fpCy = String(bbox.cy);
    xform.setAttribute(
      "transform",
      `translate(${worldX} ${worldY}) scale(${s}) translate(${-bbox.cx} ${-bbox.cy})`,
    );

    const hit = document.createElementNS(svgNS, "rect");
    hit.setAttribute("class", "svg-floorplan-hit");
    hit.setAttribute("x", String(bbox.minX));
    hit.setAttribute("y", String(bbox.minY));
    hit.setAttribute("width", String(Math.max(bbox.w, 1)));
    hit.setAttribute("height", String(Math.max(bbox.h, 1)));
    hit.setAttribute("fill", "transparent");

    appendFloorGeometryToGroup(floor, xform);
    xform.appendChild(hit);
    root.appendChild(xform);
    floorplanLayer.appendChild(root);

    window.dispatchEvent(
      new CustomEvent("visionhome:floorplan-applied-to-svg", {
        detail: { id: entry?.id != null ? String(entry.id) : "" },
      }),
    );

    if (historyReady && !isRestoring) pushHistorySnapshot();
  }

  function addFloorplanFromLibraryAtCenter(floorPlanId) {
    const cat = window.__floorPlanCatalog;
    const entry = cat?.byId instanceof Map ? cat.byId.get(floorPlanId) : null;
    if (!entry) return;
    applyFloorplanEntryAtWorld(entry, VIEW_W / 2, VIEW_H / 2);
  }

  /** 编辑模式：从家具库拖到 SVG 画布上松开 → 落在指针处（家具不入 3D，仅从侧栏进 2D） */
  let pendingLibraryDrag = null;

  const LIBRARY_DRAG_GHOST_THRESHOLD = 6;

  function positionLibraryDragGhost(clientX, clientY) {
    const g = pendingLibraryDrag?.ghostEl;
    if (!g) return;
    const w = g.offsetWidth || 88;
    const h = g.offsetHeight || 88;
    g.style.left = `${Math.round(clientX - w / 2)}px`;
    g.style.top = `${Math.round(clientY - h / 2)}px`;
  }

  function ensureLibraryDragGhost() {
    if (!pendingLibraryDrag || pendingLibraryDrag.ghostEl) return;
    const card = pendingLibraryDrag.sourceCard;
    const ghost = document.createElement("div");
    ghost.className = "furniture-library-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    const thumb = card?.querySelector(".asset-thumb");
    if (thumb) {
      ghost.appendChild(thumb.cloneNode(true));
    } else {
      const label = document.createElement("span");
      label.className = "furniture-library-drag-ghost__fallback";
      const nameEl = card?.querySelector(".asset-name");
      label.textContent = (nameEl?.textContent || "").trim() || pendingLibraryDrag.model || "?";
      ghost.appendChild(label);
    }
    document.body.appendChild(ghost);
    pendingLibraryDrag.ghostEl = ghost;
  }

  function removeLibraryDragGhost() {
    const el = pendingLibraryDrag?.ghostEl;
    if (el?.parentNode) el.remove();
    if (pendingLibraryDrag) pendingLibraryDrag.ghostEl = null;
  }

  function onLibraryDragMove(e) {
    if (!pendingLibraryDrag || e.pointerId !== pendingLibraryDrag.pointerId) return;
    const d = Math.hypot(e.clientX - pendingLibraryDrag.sx, e.clientY - pendingLibraryDrag.sy);
    if (d >= LIBRARY_DRAG_GHOST_THRESHOLD) {
      pendingLibraryDrag.didDrag = true;
      ensureLibraryDragGhost();
      positionLibraryDragGhost(e.clientX, e.clientY);
    }
  }

  function endLibraryDrag(e) {
    if (!pendingLibraryDrag || e.pointerId !== pendingLibraryDrag.pointerId) return;
    removeLibraryDragGhost();
    const p = pendingLibraryDrag;
    pendingLibraryDrag = null;
    popPointerDragTextSuppression();
    window.removeEventListener("pointermove", onLibraryDragMove, { passive: true });
    window.removeEventListener("pointerup", endLibraryDrag);
    window.removeEventListener("pointercancel", endLibraryDrag);

    if (!p.didDrag) return;

    const rect = svg.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    if (!byId.has(p.model)) return;
    const wpt = clientToWorld(x, y);
    addFurniture(p.model, wpt.x, wpt.y);
  }

  /** Shift+点击：加入画布中心附近；普通拖拽：松手在 SVG 上则落到该点 */
  document.addEventListener(
    "pointerdown",
    (e) => {
      const card = e.target.closest?.(".asset-card[data-model]");
      if (!card) return;
      const panel = card.closest?.(".side-panel[data-panel='assets']");
      if (!panel || !panel.classList.contains("is-visible")) return;
      if (!isEditViewActive()) return;

      if (e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addFromLibrary(card.dataset.model);
        return;
      }

      if (!e.isPrimary) return;

      const model = card.dataset.model;
      if (typeof window.__selectFurnitureLibraryCardByModel === "function") {
        window.__selectFurnitureLibraryCardByModel(model);
      }

      pushPointerDragTextSuppression();
      pendingLibraryDrag = {
        model,
        sourceCard: card,
        sx: e.clientX,
        sy: e.clientY,
        pointerId: e.pointerId,
        didDrag: false,
        ghostEl: null,
      };
      window.addEventListener("pointermove", onLibraryDragMove, { passive: true });
      window.addEventListener("pointerup", endLibraryDrag);
      window.addEventListener("pointercancel", endLibraryDrag);
    },
    true,
  );

  /** 户型库 → 画布（pointer 拖拽，与家具库一致） */
  let pendingFloorplanDrag = null;

  function removeFloorplanDragGhost() {
    const el = pendingFloorplanDrag?.ghostEl;
    if (el?.parentNode) el.remove();
    if (pendingFloorplanDrag) pendingFloorplanDrag.ghostEl = null;
  }

  function ensureFloorplanDragGhost() {
    if (!pendingFloorplanDrag || pendingFloorplanDrag.ghostEl) return;
    const card = pendingFloorplanDrag.sourceCard;
    const ghost = document.createElement("div");
    ghost.className = "furniture-library-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    const thumb = card?.querySelector(".asset-thumb");
    if (thumb) {
      ghost.appendChild(thumb.cloneNode(true));
    } else {
      const label = document.createElement("span");
      label.className = "furniture-library-drag-ghost__fallback";
      const nameEl = card?.querySelector(".asset-name");
      label.textContent = (nameEl?.textContent || "").trim() || pendingFloorplanDrag.floorPlanId || "?";
      ghost.appendChild(label);
    }
    document.body.appendChild(ghost);
    pendingFloorplanDrag.ghostEl = ghost;
  }

  function positionFloorplanDragGhost(clientX, clientY) {
    const g = pendingFloorplanDrag?.ghostEl;
    if (!g) return;
    const w = g.offsetWidth || 88;
    const h = g.offsetHeight || 88;
    g.style.left = `${Math.round(clientX - w / 2)}px`;
    g.style.top = `${Math.round(clientY - h / 2)}px`;
  }

  function onFloorplanLibraryDragMoveFixed(e) {
    if (!pendingFloorplanDrag || e.pointerId !== pendingFloorplanDrag.pointerId) return;
    const d = Math.hypot(e.clientX - pendingFloorplanDrag.sx, e.clientY - pendingFloorplanDrag.sy);
    if (d >= LIBRARY_DRAG_GHOST_THRESHOLD) {
      pendingFloorplanDrag.didDrag = true;
      ensureFloorplanDragGhost();
      positionFloorplanDragGhost(e.clientX, e.clientY);
    }
  }

  function endFloorplanLibraryDrag(e) {
    if (!pendingFloorplanDrag || e.pointerId !== pendingFloorplanDrag.pointerId) return;
    removeFloorplanDragGhost();
    const p = pendingFloorplanDrag;
    pendingFloorplanDrag = null;
    popPointerDragTextSuppression();
    window.removeEventListener("pointermove", onFloorplanLibraryDragMoveFixed, { passive: true });
    window.removeEventListener("pointerup", endFloorplanLibraryDrag);
    window.removeEventListener("pointercancel", endFloorplanLibraryDrag);

    if (!p.didDrag) return;

    const rect = svg.getBoundingClientRect();
    const { clientX: x, clientY: y } = e;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;

    const cat = window.__floorPlanCatalog;
    const entry = cat?.byId instanceof Map ? cat.byId.get(p.floorPlanId) : null;
    if (!entry) return;

    applyFloorplanEntryAtWorld(entry);
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      const fpCard = e.target.closest?.(".asset-card[data-floor-plan-id]");
      if (!fpCard) return;
      const panel = fpCard.closest?.('.side-panel[data-panel="floorplans"]');
      if (!panel || !panel.classList.contains("is-visible")) return;
      if (!isEditViewActive()) return;

      const floorPlanId = String(fpCard.dataset.floorPlanId || "").trim();
      if (!floorPlanId) return;

      if (e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        addFloorplanFromLibraryAtCenter(floorPlanId);
        return;
      }

      if (!e.isPrimary) return;

      if (typeof window.__selectFloorplanLibraryCardById === "function") {
        window.__selectFloorplanLibraryCardById(floorPlanId);
      }

      pushPointerDragTextSuppression();
      pendingFloorplanDrag = {
        floorPlanId,
        sourceCard: fpCard,
        sx: e.clientX,
        sy: e.clientY,
        pointerId: e.pointerId,
        didDrag: false,
        ghostEl: null,
      };
      window.addEventListener("pointermove", onFloorplanLibraryDragMoveFixed, { passive: true });
      window.addEventListener("pointerup", endFloorplanLibraryDrag);
      window.addEventListener("pointercancel", endFloorplanLibraryDrag);
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

  /** 方案 JSON furnitureInstances → 画布布局（仅当前 activeFloorId） */
  function projectToSvgLayout(project) {
    const floorId = project?.activeFloorId != null ? String(project.activeFloorId) : "floor1";
    const inst = project?.furnitureInstances;
    if (!Array.isArray(inst)) return [];
    return inst
      .filter((fi) => !fi?.floorId || String(fi.floorId) === floorId)
      .map((fi) => ({
        model: String(fi.furnitureId ?? fi.modelId ?? "").trim(),
        x: Array.isArray(fi.positionMm) ? Number(fi.positionMm[0]) || 0 : 0,
        y: Array.isArray(fi.positionMm) ? Number(fi.positionMm[1]) || 0 : 0,
        rotation: Number(fi.rotationDeg ?? fi.rotation ?? 0) || 0,
      }))
      .filter((row) => row.model);
  }

  /** 外部切换方案 / 新建：重建家具并重置撤销栈与「已保存」基线 */
  function applyExternalLayout(layout, options = {}) {
    isRestoring = true;
    try {
      rebuildFromLayout(layout);
    } finally {
      isRestoring = false;
    }
    select(null);
    initHistory();
    historyReady = true;
    const baseline = options.designLayoutBaseline;
    window.__designLayoutBaseline =
      typeof baseline === "string" ? baseline : JSON.stringify(getLayout());
    emitSvgLayoutChanged();
  }

  function isValidUndoHistoryPayload(uh) {
    if (!uh || typeof uh !== "object") return false;
    const entries = uh.entries;
    const index = uh.index;
    if (!Array.isArray(entries) || entries.length === 0) return false;
    if (!Number.isFinite(Number(index))) return false;
    const idx = Math.trunc(Number(index));
    if (idx < 0 || idx >= entries.length) return false;
    for (const s of entries) {
      if (typeof s !== "string") return false;
      try {
        const p = JSON.parse(s);
        if (normalizeHistorySnapshot(p) == null) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * 从 sessionStorage 等恢复 2D 编辑态（户型 id + 家具 + 视图 + 网格 + 未保存基线 + 可选撤销栈）
   * @param {{ version?: number, furnitureLayout?: unknown[], undoHistory?: { entries: string[], index: number }, floorPlanId?: string | null, view?: { tx?: number, ty?: number, scale?: number }, gridVisible?: boolean, designLayoutBaseline?: string }} payload
   */
  function restoreEditorSession(payload) {
    if (!payload || Number(payload.version) !== 1) return;

    const v = payload.view;
    if (v && Number.isFinite(Number(v.tx)) && Number.isFinite(Number(v.ty)) && Number.isFinite(Number(v.scale))) {
      let sc = Number(v.scale);
      sc = Math.min(SCALE_MAX, Math.max(SCALE_MIN, sc));
      viewTx = Number(v.tx);
      viewTy = Number(v.ty);
      viewScale = sc;
      applyViewTransform();
    }

    if (typeof payload.gridVisible === "boolean") {
      setGridVisible(payload.gridVisible);
    }

    clearTimeout(historyDebounceTimer);
    historyDebounceTimer = null;

    const layout = Array.isArray(payload.furnitureLayout) ? payload.furnitureLayout : [];
    const uh = payload.undoHistory;

    if (isValidUndoHistoryPayload(uh)) {
      let entries = uh.entries.slice();
      let idx = Math.trunc(Number(uh.index));
      if (entries.length > MAX_HISTORY) {
        const drop = entries.length - MAX_HISTORY;
        entries = entries.slice(drop);
        idx -= drop;
      }
      if (idx < 0 || idx >= entries.length) {
        isRestoring = true;
        try {
          const fpId = payload.floorPlanId != null ? String(payload.floorPlanId).trim() : "";
          if (fpId) {
            const cat = window.__floorPlanCatalog;
            const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
            if (entry) applyFloorplanEntryAtWorld(entry);
            else {
              clearFloorplanSelection();
              floorplanLayer.replaceChildren();
            }
          } else {
            clearFloorplanSelection();
            floorplanLayer.replaceChildren();
          }
        } finally {
          isRestoring = false;
        }
        applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        return;
      }

      historyReady = false;
      isRestoring = true;
      history = entries;
      historyIndex = idx;
      try {
        const state = normalizeHistorySnapshot(JSON.parse(history[historyIndex]));
        if (!state) throw new Error("bad snapshot");
        applyHistorySnapshotState(state);
      } catch {
        historyReady = true;
        isRestoring = true;
        try {
          const fpId = payload.floorPlanId != null ? String(payload.floorPlanId).trim() : "";
          if (fpId) {
            const cat = window.__floorPlanCatalog;
            const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
            if (entry) applyFloorplanEntryAtWorld(entry);
            else {
              clearFloorplanSelection();
              floorplanLayer.replaceChildren();
            }
          } else {
            clearFloorplanSelection();
            floorplanLayer.replaceChildren();
          }
        } finally {
          isRestoring = false;
        }
        applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
        return;
      }
      isRestoring = false;
      select(null);
      historyReady = true;
      const baseline = payload.designLayoutBaseline;
      window.__designLayoutBaseline =
        typeof baseline === "string" ? baseline : JSON.stringify(getLayout());
      updateUndoRedoButtons();
      emitSvgLayoutChanged();
    } else {
      isRestoring = true;
      try {
        const fpId = payload.floorPlanId != null ? String(payload.floorPlanId).trim() : "";
        if (fpId) {
          const cat = window.__floorPlanCatalog;
          const entry = cat?.byId instanceof Map ? cat.byId.get(fpId) : null;
          if (entry) applyFloorplanEntryAtWorld(entry);
          else {
            clearFloorplanSelection();
            floorplanLayer.replaceChildren();
          }
        } else {
          clearFloorplanSelection();
          floorplanLayer.replaceChildren();
        }
      } finally {
        isRestoring = false;
      }
      applyExternalLayout(layout, { designLayoutBaseline: payload.designLayoutBaseline });
    }
  }

  function getCurrentFloorplanId() {
    const el = floorplanLayer.querySelector(".svg-floorplan-root[data-floor-plan-id]");
    const id = el?.getAttribute("data-floor-plan-id")?.trim();
    return id || null;
  }

  function setViewTransform(t) {
    if (!t) return;
    const tx = Number(t.tx);
    const ty = Number(t.ty);
    let sc = Number(t.scale);
    if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(sc)) return;
    sc = Math.min(SCALE_MAX, Math.max(SCALE_MIN, sc));
    viewTx = tx;
    viewTy = ty;
    viewScale = sc;
    applyViewTransform();
  }

  window.addEventListener("visionhome:design-select", (e) => {
    const project = e.detail?.project;
    if (!project) return;
    applyExternalLayout(projectToSvgLayout(project));
  });

  window.addEventListener("visionhome:design-new", () => {
    clearFloorplanLayerContent();
    applyExternalLayout([]);
  });

  window.svgEditorAddFurniture = addFurniture;
  window.svgEditorGetLayout = getLayout;
  window.svgEditorApplyFloorplanAtWorld = applyFloorplanEntryAtWorld;
  window.svgEditorClearFloorplan = clearFloorplanLayerContent;
  window.svgEditorCommitSavedBaseline = () => {
    window.__designLayoutBaseline = JSON.stringify(getLayout());
    emitSvgLayoutChanged();
  };
  window.svgEditorGetViewSize = () => ({ width: VIEW_W, height: VIEW_H });
  window.svgEditorResetView = resetView;
  window.svgEditorGetViewTransform = () => ({ tx: viewTx, ty: viewTy, scale: viewScale });
  window.svgEditorSetViewTransform = setViewTransform;
  window.svgEditorToggleGrid = toggleGridVisible;
  window.svgEditorGetGridVisible = () => gridVisible;
  window.svgEditorSetGridVisible = setGridVisible;
  window.svgEditorGetCurrentFloorplanId = getCurrentFloorplanId;
  window.svgEditorRestoreSession = restoreEditorSession;
  window.svgEditorGetUndoHistory = () => ({ entries: [...history], index: historyIndex });
  window.svgEditorFlushHistoryDebounce = flushHistoryDebounce;

  select(null);
  initHistory();
  historyReady = true;
  window.__designLayoutBaseline = JSON.stringify(getLayout());
  setGridVisible(true);

  const okResult = { ok: true, reason: null, catalogSize: byId.size };
  window.__visionHomeSvgEditor = okResult;
  return okResult;
}
