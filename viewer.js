import * as THREE from "three";
import { OrbitControls } from "./public/OrbitControls.js";

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

  // Placement plane (infinite mathematical plane)
  const placementPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const placeables = [];
  const interactiveMeshes = [];

  const state = {
    currentModel: "sofa",
    dragging: false,
    mode: null, // "place" | "move"
    ghost: null,
    draggedRoot: null,
    lastPointerInViewer: false,
    pendingPlace: null, // { model, startX, startY }
  };

  const createModel = (type) => {
    // All models are built with their "bottom" at y=0, so placing at y=0 feels natural.
    const group = new THREE.Group();

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

    switch (type) {
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
    return group;
  };

  const setGhostStyle = (root, isGhost) => {
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = !isGhost;
      obj.receiveShadow = !isGhost;
      if (obj.material) {
        obj.material.transparent = isGhost;
        obj.material.opacity = isGhost ? 0.55 : 1.0;
      }
    });
  };

  const attachPlaceable = (root) => {
    placeables.push(root);
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.userData.__root = root;
      interactiveMeshes.push(obj);
    });
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

  const startPlace = () => {
    state.ghost = createModel(state.currentModel);
    setGhostStyle(state.ghost, true);
    scene.add(state.ghost);
  };

  const commitPlace = () => {
    if (!state.ghost) return;
    setGhostStyle(state.ghost, false);
    attachPlaceable(state.ghost);
    state.ghost = null;
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
      state.dragging = true;
      state.mode = "move";
      state.draggedRoot = pickedRoot;
      controls.enabled = false;
    }
  };

  const onPointerMove = (event) => {
    if (state.dragging) {
      setRayFromEvent(event);
      const point = getPlanePoint();
      if (!point) return;

      if (state.mode === "place" && state.ghost) {
        state.ghost.position.set(point.x, 0, point.z);
      } else if (state.mode === "move" && state.draggedRoot) {
        state.draggedRoot.position.set(point.x, 0, point.z);
      }
      return;
    }

    // Pending placement: start only when user drags the card into the viewer.
    if (state.pendingPlace) {
      const dx = event.clientX - state.pendingPlace.startX;
      const dy = event.clientY - state.pendingPlace.startY;
      const dist = Math.hypot(dx, dy);
      const DRAG_THRESHOLD = 6;

      const canRay = setRayFromEvent(event);
      if (!canRay) return;
      if (dist < DRAG_THRESHOLD) return;

      // Start ghost
      state.mode = "place";
      state.dragging = true;
      state.draggedRoot = null;
      state.currentModel = state.pendingPlace.model;

      state.ghost = createModel(state.currentModel);
      setGhostStyle(state.ghost, true);
      scene.add(state.ghost);

      controls.enabled = false;
      state.pendingPlace = null;

      const point = getPlanePoint();
      if (point) {
        state.ghost.position.set(point.x, 0, point.z);
      }
    }
  };

  const onPointerUp = (event) => {
    if (!state.dragging && !state.pendingPlace) return;
    state.dragging = false;

    if (state.pendingPlace) {
      // Click/cancel on card shouldn't create anything.
      state.pendingPlace = null;
      controls.enabled = true;
      return;
    }

    if (state.mode === "place") {
      // Only commit when pointer is released over the viewer.
      if (setRayFromEvent(event)) {
        commitPlace();
      } else if (state.ghost) {
        scene.remove(state.ghost);
        state.ghost = null;
      }
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

  cards.forEach((card) => {
    const model = card.dataset.model;
    const select = () => selectCard(card);

    card.addEventListener("click", select);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") select();
    });

    // Pointer-drag from the library card into the 3D viewer.
    card.addEventListener("pointerdown", (e) => {
      if (!e.isPrimary) return;
      e.preventDefault();

      selectCard(card);

      // Pending until user actually drags into viewer.
      state.pendingPlace = { model, startX: e.clientX, startY: e.clientY };
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

  const animate = () => {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };

  window.addEventListener("resize", resize);
  resize();
  animate();
})();

