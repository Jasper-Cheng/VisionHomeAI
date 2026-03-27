import * as THREE from "three";
import { OrbitControls } from "../../assets/vendor/OrbitControls.js";
import { getFurnitureTags } from "../furniture/furnitureManager.js";
import {
  applyFurnitureAppearanceToGroup,
  hasFurnitureMaterialConfig,
  normalizeFurnitureSelection,
  resolveFurnitureSelectionDetail,
} from "../furniture/furnitureConfig.js";

(() => {
  const container = document.getElementById("viewer");
  if (!container) return;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0a);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
  camera.position.set(7, 7, 9);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.update();

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const grid = new THREE.GridHelper(30, 30, 0x3b3b3b, 0x222222);
  grid.position.y = 0;
  scene.add(grid);

  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  scene.add(ambient);

  const dir = new THREE.DirectionalLight(0xffffff, 1.0);
  dir.position.set(6, 10, 7);
  dir.castShadow = true;
  scene.add(dir);

  // Ground visuals
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(60, 60),
    new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 1.0, metalness: 0.0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // Default: hide ground plane.
  ground.visible = false;

  // Placement plane (infinite mathematical plane)
  const placementPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const placeables = [];
  const interactiveMeshes = [];

  const propertiesPanel = document.getElementById("propertiesPanel");
  const propertiesName = propertiesPanel?.querySelector(".properties-name");
  const propInputX = propertiesPanel?.querySelector('input[data-prop="x"]');
  const propInputZ = propertiesPanel?.querySelector('input[data-prop="z"]');
  const propInputRotY = propertiesPanel?.querySelector('input[data-prop="rotY"]');
  const propDimW = document.getElementById("propDimW");
  const propDimD = document.getElementById("propDimD");
  const propDimH = document.getElementById("propDimH");
  const propTagsSection = document.getElementById("propTagsSection");
  const propFurnitureTags = document.getElementById("propFurnitureTags");
  const propAppearanceBody = document.getElementById("propAppearanceBody");
  const propAppearanceHint = document.getElementById("propAppearanceHint");

  function syncViewerAppearancePanel(root) {
    if (!propAppearanceBody) return;
    propAppearanceBody.replaceChildren();
    if (propAppearanceHint) propAppearanceHint.hidden = true;
    if (!root) {
      if (propAppearanceHint) propAppearanceHint.hidden = false;
      return;
    }
    const byId = catalog?.byId instanceof Map ? catalog.byId : new Map();
    const item = byId.get(root.userData.modelType);
    if (!item || !hasFurnitureMaterialConfig(item)) {
      if (propAppearanceHint) propAppearanceHint.hidden = false;
      return;
    }
    const sel = normalizeFurnitureSelection(item, root.userData.furnitureSelection);
    const det = resolveFurnitureSelectionDetail(item, sel);
    const cur = document.createElement("div");
    cur.className = "prop-appearance-current";
    const skuNameOnly =
      (det.skuName && String(det.skuName).trim()) ||
      [det.materialName, det.textureName, det.colorName].filter(Boolean).join(" · ") ||
      "—";
    const nameEl = document.createElement("div");
    nameEl.className = "prop-appearance-sku-name";
    nameEl.textContent = skuNameOnly;
    cur.appendChild(nameEl);
    propAppearanceBody.appendChild(cur);
  }

  function syncPropTagsPanel(item) {
    if (!propTagsSection || !propFurnitureTags) return;
    propFurnitureTags.replaceChildren();
    const tags = getFurnitureTags(item);
    if (!tags.length) {
      propTagsSection.hidden = true;
      return;
    }
    propTagsSection.hidden = false;
    for (const text of tags) {
      const span = document.createElement("span");
      span.className = "prop-tag";
      span.textContent = text;
      propFurnitureTags.appendChild(span);
    }
  }

  function extractDimsFromCatalogItem(item) {
    if (!item || typeof item !== "object") return { w: 100, d: 100, h: 80 };
    const raw = item.size;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { w: 100, d: 100, h: 80 };
    let w = Number(raw.widthCm ?? raw.width ?? raw.w);
    let d = Number(raw.depthCm ?? raw.depth ?? raw.d ?? raw.length);
    let h = Number(raw.heightCm ?? raw.height ?? raw.h);
    if (!Number.isFinite(w) || w <= 0) w = 210;
    if (!Number.isFinite(d) || d <= 0) d = 90;
    if (!Number.isFinite(h) || h <= 0) h = 80;
    if (w > 600 || d > 600) {
      w /= 10;
      d /= 10;
    }
    if (h > 600) h /= 10;
    return { w, d, h };
  }

  /** 与家具 JSON 的 category 一致，用于 3D 占位几何与编码前缀 */
  const MODEL_PREFIX = {
    sofa: "SF",
    table: "TB",
    lamp: "LP",
    rug: "RG",
    cabinet: "TV",
    plant: "PL",
    bed: "BD",
  };

  const modelCounters = {};

  const catalog = window.__furnitureCatalog;
  const state = {
    currentModel: catalog?.items?.[0]?.id || "sofa_001",
    dragging: false,
    mode: null, // "move"（家具仅从侧栏拖到 2D SVG，不在此场景从卡片置入 3D）
    draggedRoot: null,
    lastPointerInViewer: false,
    selectedRoot: null,
  };

  // Placement history (undo/redo)
  const ENABLE_HISTORY = false; // 暂未实现上一步/下一步
  const history = [];
  let historyIndex = -1;
  let isRestoring = false;
  let nextPlacedId = 1;

  const snapshotState = () => {
    const selectedId = state.selectedRoot?.userData?.__id ?? null;
    return {
      selectedId,
      objects: placeables.map((root) => ({
        id: root.userData.__id,
        type: root.userData.modelType,
        code: root.userData.modelCode,
        pos: { x: root.position.x, y: root.position.y, z: root.position.z },
        rotY: root.rotation?.y ?? 0,
      })),
    };
  };

  const recordHistory = () => {
    if (!ENABLE_HISTORY) return;
    if (isRestoring) return;
    const snap = snapshotState();
    // Truncate redo branch
    history.splice(historyIndex + 1);
    history.push(snap);
    historyIndex = history.length - 1;
  };

  const applySnapshot = (snap) => {
    if (!snap) return;
    isRestoring = true;

    // Cancel any in-progress move.
    state.dragging = false;
    state.mode = null;
    state.draggedRoot = null;
    controls.enabled = true;

    // Clear current objects
    for (const root of placeables) {
      scene.remove(root);
    }
    placeables.splice(0, placeables.length);
    interactiveMeshes.splice(0, interactiveMeshes.length);

    // Reset counters to continue codes correctly.
    const prefixToCategory = Object.fromEntries(
      Object.entries(MODEL_PREFIX).map(([cat, prefix]) => [prefix, cat]),
    );
    // eslint-disable-next-line no-restricted-syntax
    for (const key of Object.keys(modelCounters)) delete modelCounters[key];

    for (const obj of snap.objects || []) {
      const code = obj.code;
      if (!code) continue;
      const parts = String(code).split("-");
      if (parts.length < 2) continue;
      const prefix = parts[0];
      const num = Number(parts[1]);
      const category = prefixToCategory[prefix];
      if (category && Number.isFinite(num)) {
        modelCounters[category] = Math.max(modelCounters[category] || 0, num);
      }
    }

    nextPlacedId = 1;
    for (const obj of snap.objects || []) {
      if (typeof obj.id === "number") nextPlacedId = Math.max(nextPlacedId, obj.id + 1);
    }

    // Recreate
    for (const obj of snap.objects || []) {
      const root = createModel(obj.type); // furniture id，如 sofa_001
      root.userData.__id = obj.id;
      root.userData.modelCode = obj.code ?? null;
      root.position.set(obj.pos.x, obj.pos.y, obj.pos.z);
      root.rotation.y = obj.rotY;
      attachPlaceable(root);
    }

    // Restore selection
    const selectedRoot = snap.selectedId
      ? placeables.find((r) => r.userData.__id === snap.selectedId) || null
      : null;
    if (selectedRoot) selectRoot(selectedRoot);
    else clearSelection();

    isRestoring = false;
  };

  const undo = () => {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    applySnapshot(history[historyIndex]);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    historyIndex += 1;
    applySnapshot(history[historyIndex]);
  };

  // Initial history (empty scene)
  recordHistory();

  const createModel = (furnitureId) => {
    const lib = window.__furnitureCatalog;
    const entry = lib?.byId?.get?.(furnitureId);
    const category = entry?.category || "sofa";
    const geoKey = category === "cabinet" ? "tv-cabinet" : category;

    // All models are built with their "bottom" at y=0, so placing at y=0 feels natural.
    const group = new THREE.Group();
    group.userData.modelType = furnitureId;
    group.userData.furnitureId = furnitureId;
    group.userData.modelCategory = category;
    group.userData.modelLabel = entry?.name || furnitureId;
    group.userData.modelCode = null;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x8c7cff,
      roughness: 0.45,
      metalness: 0.05,
    });

    const matWood = new THREE.MeshStandardMaterial({
      color: 0xb08a5a,
      roughness: 0.6,
      metalness: 0.05,
    });

    const matShade = new THREE.MeshStandardMaterial({
      color: 0xdec9a7,
      roughness: 0.55,
      metalness: 0.0,
    });

    const matPlant = new THREE.MeshStandardMaterial({
      color: 0x58d38b,
      roughness: 0.55,
      metalness: 0.05,
    });

    switch (geoKey) {
      case "sofa": {
        const base = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.55, 1.0), mat);
        base.castShadow = true;
        base.position.y = 0.275;
        group.add(base);

        const back = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.75, 0.25), mat);
        back.castShadow = true;
        back.position.set(0, 0.7, -0.375);
        group.add(back);

        const armL = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.6, 1.0), mat);
        armL.castShadow = true;
        armL.position.set(-1.325, 0.55, 0);
        group.add(armL);

        const armR = armL.clone();
        armR.position.x = 1.325;
        group.add(armR);
        break;
      }
      case "table": {
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.8), matWood);
        top.castShadow = true;
        top.position.y = 0.35;
        group.add(top);

        const legGeo = new THREE.BoxGeometry(0.08, 0.35, 0.08);
        const leg1 = new THREE.Mesh(legGeo, matWood);
        leg1.castShadow = true;
        leg1.position.set(-0.72, 0.17, -0.32);
        group.add(leg1);

        const leg2 = leg1.clone();
        leg2.position.x = 0.72;
        group.add(leg2);

        const leg3 = leg1.clone();
        leg3.position.z = 0.32;
        group.add(leg3);

        const leg4 = leg1.clone();
        leg4.position.set(0.72, 0.17, 0.32);
        group.add(leg4);
        break;
      }
      case "lamp": {
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 18), matWood);
        stem.castShadow = true;
        stem.position.y = 0.6;
        group.add(stem);

        const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.33, 0.22, 20), matShade);
        shade.castShadow = true;
        shade.position.y = 1.25;
        group.add(shade);

        const bulb = new THREE.Mesh(
          new THREE.SphereGeometry(0.06, 14, 14),
          new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffd37a, emissiveIntensity: 0.3 })
        );
        bulb.castShadow = false;
        bulb.position.y = 1.25;
        group.add(bulb);
        break;
      }
      case "rug": {
        const rug = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 1.6), mat);
        rug.castShadow = true;
        rug.receiveShadow = true;
        rug.position.y = 0.025;
        rug.rotation.y = Math.PI / 16;
        group.add(rug);
        break;
      }
      case "tv-cabinet": {
        const body = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.35, 0.55), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 }));
        body.castShadow = true;
        body.position.y = 0.175;
        group.add(body);

        const screen = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 0.04), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.2 }));
        screen.castShadow = true;
        screen.position.set(0, 0.2, 0.27);
        group.add(screen);

        const base = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.08, 0.55), new THREE.MeshStandardMaterial({ color: 0x1f1f1f, roughness: 0.7 }));
        base.castShadow = true;
        base.position.set(0, 0.04, 0);
        group.add(base);
        break;
      }
      case "plant": {
        const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.25, 0.22, 18), matWood);
        pot.castShadow = true;
        pot.position.y = 0.11;
        group.add(pot);

        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.9, 12), matPlant);
        stem.castShadow = true;
        stem.position.y = 0.55;
        group.add(stem);

        const leaf1 = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 14), matPlant);
        leaf1.castShadow = true;
        leaf1.position.set(-0.2, 0.85, 0.0);
        group.add(leaf1);

        const leaf2 = leaf1.clone();
        leaf2.position.set(0.18, 0.82, 0.08);
        group.add(leaf2);
        break;
      }
      case "bed": {
        const mattress = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.35, 2.0), mat);
        mattress.castShadow = true;
        mattress.position.y = 0.175;
        group.add(mattress);

        const headboard = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.75, 0.12), mat);
        headboard.castShadow = true;
        headboard.position.set(0, 0.55, -0.94);
        group.add(headboard);
        break;
      }
      default: {
        const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
        box.castShadow = true;
        box.position.y = 0.5;
        group.add(box);
      }
    }

    // Make it easier to pick/move by storing meshes.
    group.traverse((obj) => {
      if (obj.isMesh) obj.userData.__root = group;
    });
    if (entry && hasFurnitureMaterialConfig(entry)) {
      group.userData.furnitureSelection = normalizeFurnitureSelection(entry, null);
      applyFurnitureAppearanceToGroup(THREE, group, entry);
    }
    return group;
  };

  const attachPlaceable = (root) => {
    const category = root?.userData?.modelCategory || "sofa";
    if (category && !root.userData.modelCode) {
      modelCounters[category] = (modelCounters[category] || 0) + 1;
      const prefix = MODEL_PREFIX[category] || String(category).toUpperCase().slice(0, 2);
      const num = String(modelCounters[category]).padStart(2, "0");
      root.userData.modelCode = `${prefix}-${num}`;
    }
    if (typeof root.userData.__id !== "number") {
      root.userData.__id = nextPlacedId++;
    }
    placeables.push(root);
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.userData.__root = root;
      interactiveMeshes.push(obj);
    });
    return root;
  };

  const setRayFromEvent = (event) => {
    const rect = container.getBoundingClientRect();
    const inX = event.clientX >= rect.left && event.clientX <= rect.right;
    const inY = event.clientY >= rect.top && event.clientY <= rect.bottom;
    state.lastPointerInViewer = inX && inY && rect.width > 0 && rect.height > 0;

    if (!state.lastPointerInViewer) return false;

    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return true;
  };

  const getPlanePoint = () => {
    if (!state.lastPointerInViewer) return null;
    const point = new THREE.Vector3();
    const ok = raycaster.ray.intersectPlane(placementPlane, point);
    return ok ? point : null;
  };

  const selectRoot = (root) => {
    if (typeof window.svgEditorDeselect === "function") window.svgEditorDeselect();
    state.selectedRoot = root;
    if (propertiesPanel) propertiesPanel.classList.add("is-visible");

    if (!root) return;
    const label = root.userData.modelLabel || root.userData.modelType || "模型";
    const code = root.userData.modelCode ? `(${root.userData.modelCode})` : "";

    if (propertiesName) propertiesName.textContent = `${label}${code}`;

    updatePropertiesFromRoot(root);
  };

  const clearSelection = () => {
    if (typeof window.svgEditorDeselect === "function") window.svgEditorDeselect();
    state.selectedRoot = null;
    if (propertiesPanel) propertiesPanel.classList.remove("is-visible");
    if (propertiesName) propertiesName.textContent = "未选择";
    const dash = "—";
    if (propDimW) propDimW.textContent = dash;
    if (propDimD) propDimD.textContent = dash;
    if (propDimH) propDimH.textContent = dash;
    syncPropTagsPanel(null);
    syncViewerAppearancePanel(null);
  };

  const updatePropertiesFromRoot = (root) => {
    if (!root) return;
    const p = root.position;
    const ry = root.rotation?.y ?? 0;
    const deg = (ry * 180) / Math.PI;

    if (propInputX) propInputX.value = String(Math.round(p.x * 100));
    if (propInputZ) propInputZ.value = String(Math.round(p.z * 100));
    if (propInputRotY) propInputRotY.value = String(Math.round(deg));

    const byId = catalog?.byId instanceof Map ? catalog.byId : new Map();
    const item = byId.get(root.userData.modelType);
    if (propDimW || propDimD || propDimH) {
      if (item) {
        const fp = extractDimsFromCatalogItem(item);
        if (propDimW) propDimW.textContent = String(Math.round(fp.w));
        if (propDimD) propDimD.textContent = String(Math.round(fp.d));
        if (propDimH) propDimH.textContent = String(Math.round(fp.h));
      } else {
        const dash = "—";
        if (propDimW) propDimW.textContent = dash;
        if (propDimD) propDimD.textContent = dash;
        if (propDimH) propDimH.textContent = dash;
      }
    }
    syncPropTagsPanel(item);
    syncViewerAppearancePanel(root);
  };

  const applyPropertiesToRoot = (root) => {
    if (!root) return;
    const xCm = parseFloat(propInputX?.value);
    const zCm = parseFloat(propInputZ?.value);
    const deg = parseFloat(propInputRotY?.value) || 0;
    const rad = (deg * Math.PI) / 180;
    root.position.x = Number.isFinite(xCm) ? xCm / 100 : root.position.x;
    root.position.z = Number.isFinite(zCm) ? zCm / 100 : root.position.z;
    root.rotation.y = rad;
  };

  const pickRootAtPointer = () => {
    const intersects = raycaster.intersectObjects(interactiveMeshes, true);
    if (!intersects.length) return null;
    return intersects[0].object.userData.__root || intersects[0].object;
  };

  const onPointerDown = (event) => {
    if (!event.isPrimary) return;
    setRayFromEvent(event);
    const pickedRoot = pickRootAtPointer();

    if (pickedRoot) {
      selectRoot(pickedRoot);
      state.dragging = true;
      state.mode = "move";
      state.draggedRoot = pickedRoot;
      controls.enabled = false;
    } else {
      clearSelection();
    }
  };

  const onPointerMove = (event) => {
    if (!state.dragging) return;
    setRayFromEvent(event);
    const point = getPlanePoint();
    if (!point) return;

    if (state.mode === "move" && state.draggedRoot) {
      state.draggedRoot.position.set(point.x, 0, point.z);
      updatePropertiesFromRoot(state.draggedRoot);
    }
  };

  const onPointerUp = () => {
    if (!state.dragging) return;
    const wasMoving = state.mode === "move" && state.draggedRoot;
    state.dragging = false;

    if (wasMoving) {
      recordHistory();
    }

    state.mode = null;
    state.draggedRoot = null;
    controls.enabled = true;
  };

  // UI -> currentModel
  const cards = Array.from(document.querySelectorAll('.asset-card[data-model]'));
  if (cards.length) {
    const first = cards[0];
    state.currentModel = first.dataset.model || state.currentModel;
  }

  const selectCard = (card) => {
    const model = card?.dataset?.model;
    if (model) state.currentModel = model;
    cards.forEach((c) => c.classList.toggle("is-selected", c === card));
  };

  window.__selectFurnitureLibraryCardByModel = (modelId) => {
    const c = cards.find((x) => x.dataset.model === modelId);
    if (c) selectCard(c);
  };

  cards.forEach((card) => {
    const select = () => selectCard(card);

    card.addEventListener("click", select);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") select();
    });
  });

  container.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp);

  const resize = () => {
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  };

  const resetView = () => {
    state.dragging = false;
    state.mode = null;
    state.draggedRoot = null;

    // Reset camera pose.
    camera.position.set(7, 7, 9);
    controls.target.set(0, 0, 0);
    controls.enabled = true;
    resize();
    controls.update();
  };

  // Expose for "refresh view" button.
  window.resetViewerView = resetView;

  // Undo/redo暂未实现（按钮已 disabled），这里不暴露对应全局函数。

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };

  // Toggle grid/ground from quick actions (with selected button state).
  const gridBtn = document.querySelector('[data-action="toggle-grid"]');
  const groundBtn = document.querySelector('[data-action="toggle-ground"]');

  const setBtnActive = (btn, active) => {
    if (!btn) return;
    btn.classList.toggle("is-active", !!active);
  };

  // Initial states: grid/ground are visible by default.
  setBtnActive(gridBtn, grid.visible);
  setBtnActive(groundBtn, ground.visible);

  const toggleGrid = () => {
    grid.visible = !grid.visible;
    setBtnActive(gridBtn, grid.visible);
  };
  const toggleGround = () => {
    ground.visible = !ground.visible;
    setBtnActive(groundBtn, ground.visible);
  };

  gridBtn?.addEventListener("click", toggleGrid);
  groundBtn?.addEventListener("click", toggleGround);

  // 属性面板：优先写回 SVG 平面图选中家具，否则写回 3D 选中物体
  const applyPropsFromInputs = () => {
    if (typeof window.svgEditorApplyPropertiesFromPanel === "function" && window.svgEditorApplyPropertiesFromPanel()) {
      return;
    }
    if (state.selectedRoot) {
      applyPropertiesToRoot(state.selectedRoot);
    }
  };
  [propInputX, propInputZ, propInputRotY].forEach((el) => {
    el?.addEventListener("input", applyPropsFromInputs);
    el?.addEventListener("change", () => {
      applyPropsFromInputs();
      if (state.selectedRoot) recordHistory();
    });
  });

  // Material tiles & color swatches: selection state only (visual)
  propertiesPanel?.querySelectorAll(".prop-material-tile").forEach((btn) => {
    btn.addEventListener("click", () => {
      propertiesPanel.querySelectorAll(".prop-material-tile").forEach((b) => b.classList.remove("is-selected"));
      if (!btn.classList.contains("prop-material-add")) btn.classList.add("is-selected");
    });
  });
  propertiesPanel?.querySelectorAll(".prop-color-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      propertiesPanel.querySelectorAll(".prop-color-swatch").forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      const hex = btn.dataset.color;
      if (hex && state.selectedRoot) {
        state.selectedRoot.traverse((obj) => {
          if (obj.isMesh && obj.material && obj.material.color) {
            obj.material.color.setStyle(hex);
          }
        });
      }
    });
  });

  window.addEventListener("resize", resize);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => resize()).observe(container);
  }
  resize();
  animate();
})();

