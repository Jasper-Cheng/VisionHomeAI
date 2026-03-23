/**
 * 户型 SVG 平面图：家具拖拽、网格吸附、旋转、删除
 */
(() => {
  const svg = document.getElementById("svgEditorCanvas");
  const furnitureLayer = document.getElementById("svgEditorFurnitureLayer");
  const viewRoot = document.getElementById("svgEditorViewRoot");
  if (!svg || !furnitureLayer) return;

  const propertiesPanel = document.getElementById("propertiesPanel");
  const propertiesName = propertiesPanel?.querySelector(".properties-name");
  const propInputX = propertiesPanel?.querySelector('input[data-prop="x"]');
  const propInputZ = propertiesPanel?.querySelector('input[data-prop="z"]');
  const propInputRotY = propertiesPanel?.querySelector('input[data-prop="rotY"]');

  /** 与 index.html 中 SVG viewBox 一致：固定逻辑坐标 2000×2000 */
  const VIEW_W = 2000;
  const VIEW_H = 2000;
  const GRID = 20;

  /** 家具 footprint（半宽半高，用户空间单位；按画布比例相对旧 800×600 约 2.5× 放大） */
  const FURNITURE = {
    sofa: { hw: 112, hh: 50, label: "沙发", fill: "rgba(109,92,255,0.42)", stroke: "rgba(140,120,255,0.95)" },
    table: { hw: 63, hh: 63, label: "茶几", fill: "rgba(34,197,94,0.35)", stroke: "rgba(74,222,128,0.9)" },
    lamp: { hw: 30, hh: 30, label: "灯", fill: "rgba(251,191,36,0.4)", stroke: "rgba(252,211,77,0.95)" },
    rug: { hw: 100, hh: 70, label: "地毯", fill: "rgba(244,63,94,0.28)", stroke: "rgba(251,113,133,0.85)" },
    "tv-cabinet": { hw: 95, hh: 35, label: "电视柜", fill: "rgba(148,163,184,0.4)", stroke: "rgba(203,213,225,0.9)" },
    plant: { hw: 35, hh: 35, label: "绿植", fill: "rgba(16,185,129,0.38)", stroke: "rgba(52,211,153,0.9)" },
  };

  let selectedEl = null;
  let dragState = null;

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

  /** 屏幕坐标 → 户型世界坐标（与家具 translate 一致） */
  function clientToWorld(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const root = pt.matrixTransform(ctm.inverse());
    if (!viewRoot) return { x: root.x, y: root.y };
    const s = viewScale || 1;
    return {
      x: (root.x - viewTx) / s,
      y: (root.y - viewTy) / s,
    };
  }

  function zoomAtViewCenter(factor) {
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;
    const wx = (cx - viewTx) / viewScale;
    const wy = (cy - viewTy) / viewScale;
    let next = viewScale * factor;
    next = Math.min(SCALE_MAX, Math.max(SCALE_MIN, next));
    if (next === viewScale) return;
    viewScale = next;
    viewTx = cx - wx * viewScale;
    viewTy = cy - wy * viewScale;
    applyViewTransform();
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
    const type = g.getAttribute("data-model") || "sofa";
    const def = FURNITURE[type] || FURNITURE.sofa;
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
    const type = g.getAttribute("data-model") || "";
    const def = FURNITURE[type];
    if (propertiesName) propertiesName.textContent = def ? def.label : type || "家具";
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

  function createFurnitureGroup(type, cx, cy) {
    const def = FURNITURE[type];
    if (!def) return null;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.classList.add("svg-furniture");
    g.setAttribute("data-model", type);
    g.setAttribute("data-rot", "0");
    g.setAttribute("role", "button");
    g.setAttribute("tabindex", "0");
    g.setAttribute("aria-label", `${def.label}，可拖拽`);

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
    g.setAttribute("transform", `translate(${pos.x},${pos.y}) rotate(0)`);
    furnitureLayer.appendChild(g);
    return g;
  }

  function addFurniture(type, cx = VIEW_W / 2, cy = VIEW_H / 2) {
    const g = createFurnitureGroup(type, cx, cy);
    if (g) select(g);
    return g;
  }

  function removeSelected() {
    if (!selectedEl || !furnitureLayer.contains(selectedEl)) return;
    selectedEl.remove();
    selectedEl = null;
    syncPropertiesPanelForSelection(null);
  }

  /** 从家具库 Shift+点击：加入平面图中心偏一点，避免重叠 */
  function addFromLibrary(model) {
    if (!FURNITURE[model]) return;
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

  svg.addEventListener(
    "pointerdown",
    (e) => {
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
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const active = document.activeElement;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
    if (!selectedEl) return;
    e.preventDefault();
    removeSelected();
  });

  document.querySelectorAll("[data-add-furniture]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.addFurniture;
      if (type) addFurniture(type);
    });
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

  /* 初始示例：置于居中较小户型右下房间内 */
  addFurniture("sofa", 1150, 1180);
  addFurniture("table", 1220, 1190);
  select(null);
})();
