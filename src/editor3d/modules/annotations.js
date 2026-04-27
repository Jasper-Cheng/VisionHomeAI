import * as THREE from "three";

export function createAnnotations(ctx) {
  const {
    byId,
    disposeObject3D,
    extractFurnitureFootprintCm,
    floorplanRoot,
    furnitureRoot,
    getFloorsFromEntry,
    getFurnitureDisplayName,
    normalizeFloorIndex,
    rebuildFloorplan3D,
    snap,
    state,
    updateFurnitureFloorVisibility,
  } = ctx;

  const dimDepthTest = false;

  /** 画带圆角的矩形路径（canvas 2d ctx） */
  function dimRoundRect(ctx2d, x, y, w, h, r) {
    ctx2d.beginPath();
    ctx2d.moveTo(x + r, y);
    ctx2d.lineTo(x + w - r, y);
    ctx2d.arcTo(x + w, y, x + w, y + r, r);
    ctx2d.lineTo(x + w, y + h - r);
    ctx2d.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx2d.lineTo(x + r, y + h);
    ctx2d.arcTo(x, y + h, x, y + h - r, r);
    ctx2d.lineTo(x, y + r);
    ctx2d.arcTo(x, y, x + r, y, r);
    ctx2d.closePath();
  }

  /** 创建始终面向相机的文字 Sprite，用于尺寸标注 */
  function makeDimSprite(text, opts = {}) {
    const fontSize = opts.fontSize ?? 24;
    const canvas = document.createElement("canvas");
    const ctx2d = canvas.getContext("2d");
    const font = `bold ${fontSize}px sans-serif`;
    ctx2d.font = font;
    const tw = Math.ceil(ctx2d.measureText(text).width);
    const pad = 9;
    canvas.width = tw + pad * 2;
    canvas.height = fontSize + pad * 2;
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.fillStyle = opts.bgColor ?? "rgba(8,14,40,0.80)";
    dimRoundRect(ctx2d, 0, 0, canvas.width, canvas.height, 6);
    ctx2d.fill();
    ctx2d.font = font;
    ctx2d.fillStyle = opts.textColor ?? "#cce0ff";
    ctx2d.fillText(text, pad, fontSize + pad * 0.45);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: dimDepthTest,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(mat);
    const pxPerM = opts.pxPerM ?? 180;
    sprite.scale.set(canvas.width / pxPerM, canvas.height / pxPerM, 1);
    return sprite;
  }

  /** 创建虚线 Line（LineDashedMaterial），depthTest=false 始终可见 */
  function makeDimLine(pts, color = 0x5599ee, dash = 0.14, gap = 0.0001) {
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineDashedMaterial({
      color,
      dashSize: dash,
      gapSize: gap,
      transparent: true,
      opacity: 0.92,
      depthTest: dimDepthTest,
    });
    const ln = new THREE.Line(geo, mat);
    ln.computeLineDistances();
    return ln;
  }

  /** 格式化 cm 为可读字符串（>=100cm 显示 m） */
  function fmtDimCm(cm) {
    return cm >= 100 ? `${(cm / 100).toFixed(2)}m` : `${Math.round(cm)}cm`;
  }

  /** 为指定楼层每个房间在中心放置名称标签 */
  function buildFloorNameAnnotations(fl, cx, cy, s) {
    const g = new THREE.Group();
    g.userData.isNameAnnotation = true;
    const labelY = 0.12;
    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      const st = room?.style;
      const styleFallback =
        st != null && typeof st === "object" && !Array.isArray(st) ? st.floor ?? st.wall : st;
      const name = String(room?.name ?? room?.type ?? styleFallback ?? "").trim();
      if (!Array.isArray(poly) || poly.length < 3 || !name) continue;
      const pts2d = poly
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [(snap(Number(p[0])) - cx) * (s / 100), (snap(Number(p[1])) - cy) * (s / 100)]);
      if (pts2d.length < 3) continue;
      let cx2 = 0;
      let cz2 = 0;
      for (const [x, z] of pts2d) {
        cx2 += x;
        cz2 += z;
      }
      cx2 /= pts2d.length;
      cz2 /= pts2d.length;
      const sp = makeDimSprite(name, { fontSize: 22, pxPerM: 160 });
      sp.position.set(cx2, labelY, cz2);
      g.add(sp);
    }

    const fh = Number(fl.height);
    const wallHeightCm = Number.isFinite(fh) && fh > 0 ? fh : 280;
    const wallTopY = (wallHeightCm * s) / 100 + 0.06;
    for (const wall of fl.walls ?? []) {
      const name = String(wall?.name ?? wall?.id ?? "").trim();
      if (!name) continue;
      if (!Array.isArray(wall?.start) || !Array.isArray(wall?.end)) continue;
      const x1 = snap(Number(wall.start[0]));
      const y1 = snap(Number(wall.start[1]));
      const x2 = snap(Number(wall.end[0]));
      const y2 = snap(Number(wall.end[1]));
      const mx = ((x1 + x2) / 2 - cx) * (s / 100);
      const mz = ((y1 + y2) / 2 - cy) * (s / 100);
      const sp = makeDimSprite(name, {
        fontSize: 16,
        pxPerM: 200,
        bgColor: "rgba(40,20,0,0.75)",
        textColor: "#ffe8a0",
      });
      sp.position.set(mx, wallTopY, mz);
      sp.userData.isWallNameAnnotation = true;
      g.add(sp);
    }

    return g;
  }

  /**
   * 为指定楼层构建尺寸标注 Group（作为 floorG 的子节点）。
   * 每个房间：虚线轮廓 + 宽/深标注线 + 文字 Sprite。
   */
  function buildFloorDimensions(fl, cx, cy, s) {
    const g = new THREE.Group();
    g.userData.isDimAnnotation = true;
    const labelY = 0.07;
    const extInner = 0.18;
    const extOuter = 0.5;
    const tick = 0.07;
    const snapTol = 0.001;

    let fminX = Infinity;
    let fminZ = Infinity;
    let fmaxX = -Infinity;
    let fmaxZ = -Infinity;

    const key = (v) => Math.round(v / snapTol) * snapTol;

    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      for (const p of poly) {
        if (!Array.isArray(p) || p.length < 2) continue;
        const x = (snap(Number(p[0])) - cx) * (s / 100);
        const z = (snap(Number(p[1])) - cy) * (s / 100);
        fminX = Math.min(fminX, x);
        fmaxX = Math.max(fmaxX, x);
        fminZ = Math.min(fminZ, z);
        fmaxZ = Math.max(fmaxZ, z);
      }
    }

    if (!Number.isFinite(fminX)) return g;

    const edgeTol = 0.05;
    const xSouth = new Set();
    const xNorth = new Set();
    const zEast = new Set();
    const zWest = new Set();

    xSouth.add(key(fminX));
    xSouth.add(key(fmaxX));
    xNorth.add(key(fminX));
    xNorth.add(key(fmaxX));
    zEast.add(key(fminZ));
    zEast.add(key(fmaxZ));
    zWest.add(key(fminZ));
    zWest.add(key(fmaxZ));

    for (const room of fl.rooms ?? []) {
      const poly = room?.polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      const pts2d = poly
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [(snap(Number(p[0])) - cx) * (s / 100), (snap(Number(p[1])) - cy) * (s / 100)]);
      if (pts2d.length < 3) continue;

      const outPts = [...pts2d, pts2d[0]].map(([x, z]) => new THREE.Vector3(x, labelY, z));
      g.add(makeDimLine(outPts, 0x7799cc, 0.07, 0.05));

      let bminX = Infinity;
      let bminZ = Infinity;
      let bmaxX = -Infinity;
      let bmaxZ = -Infinity;
      for (const [x, z] of pts2d) {
        bminX = Math.min(bminX, x);
        bmaxX = Math.max(bmaxX, x);
        bminZ = Math.min(bminZ, z);
        bmaxZ = Math.max(bmaxZ, z);
      }

      if (bmaxZ >= fmaxZ - edgeTol) {
        xSouth.add(key(bminX));
        xSouth.add(key(bmaxX));
      }
      if (bminZ <= fminZ + edgeTol) {
        xNorth.add(key(bminX));
        xNorth.add(key(bmaxX));
      }
      if (bmaxX >= fmaxX - edgeTol) {
        zEast.add(key(bminZ));
        zEast.add(key(bmaxZ));
      }
      if (bminX <= fminX + edgeTol) {
        zWest.add(key(bminZ));
        zWest.add(key(bmaxZ));
      }

      let areaCm2 = 0;
      const rawPts = poly
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map((p) => [snap(Number(p[0])), snap(Number(p[1]))]);
      for (let i = 0; i < rawPts.length; i++) {
        const [ax, ay] = rawPts[i];
        const [bx, by] = rawPts[(i + 1) % rawPts.length];
        areaCm2 += ax * by - bx * ay;
      }
      const areaM2 = Math.abs(areaCm2) / 2 / 10000;

      const insetZ = 0.18;
      const areaLabelUp = 0.46;
      const aSp = makeDimSprite(`${areaM2.toFixed(2)}㎡`, { fontSize: 20, pxPerM: 155 });
      aSp.position.set((bminX + bmaxX) / 2, labelY + 0.1, bmaxZ - insetZ - areaLabelUp);
      g.add(aSp);
    }

    const xsSouth = [...xSouth].sort((a, b) => a - b);
    const xsNorth = [...xNorth].sort((a, b) => a - b);
    const zsEast = [...zEast].sort((a, b) => a - b);
    const zsWest = [...zWest].sort((a, b) => a - b);

    function drawSegments(breaks, side, fixedVal) {
      const tickH = tick * 0.8;
      const sign = side === "south" || side === "east" ? 1 : -1;
      const lineOff = sign * extInner;
      const isHoriz = side === "south" || side === "north";

      for (let i = 0; i < breaks.length - 1; i++) {
        const a = breaks[i];
        const b = breaks[i + 1];
        const segCm = (b - a) / (s / 100);
        if (segCm < 1) continue;

        const mid = (a + b) / 2;
        let p1;
        let p2;
        let pLead1;
        let pLead2;
        let pTick1a;
        let pTick1b;
        let pTick2a;
        let pTick2b;
        let pLabel;

        if (isHoriz) {
          const lineZ = fixedVal + lineOff;
          p1 = new THREE.Vector3(a, labelY, lineZ);
          p2 = new THREE.Vector3(b, labelY, lineZ);
          pLead1 = [new THREE.Vector3(a, labelY, fixedVal), new THREE.Vector3(a, labelY, lineZ + sign * tickH)];
          pLead2 = [new THREE.Vector3(b, labelY, fixedVal), new THREE.Vector3(b, labelY, lineZ + sign * tickH)];
          pTick1a = new THREE.Vector3(a, labelY, lineZ - tickH);
          pTick1b = new THREE.Vector3(a, labelY, lineZ + tickH);
          pTick2a = new THREE.Vector3(b, labelY, lineZ - tickH);
          pTick2b = new THREE.Vector3(b, labelY, lineZ + tickH);
          pLabel = new THREE.Vector3(mid, labelY + 0.15, lineZ);
        } else {
          const lineX = fixedVal + lineOff;
          p1 = new THREE.Vector3(lineX, labelY, a);
          p2 = new THREE.Vector3(lineX, labelY, b);
          pLead1 = [new THREE.Vector3(fixedVal, labelY, a), new THREE.Vector3(lineX + sign * tickH, labelY, a)];
          pLead2 = [new THREE.Vector3(fixedVal, labelY, b), new THREE.Vector3(lineX + sign * tickH, labelY, b)];
          pTick1a = new THREE.Vector3(lineX - tickH, labelY, a);
          pTick1b = new THREE.Vector3(lineX + tickH, labelY, a);
          pTick2a = new THREE.Vector3(lineX - tickH, labelY, b);
          pTick2b = new THREE.Vector3(lineX + tickH, labelY, b);
          pLabel = new THREE.Vector3(lineX, labelY + 0.15, mid);
        }

        g.add(makeDimLine([p1, p2]));
        g.add(makeDimLine(pLead1, 0x5599ee, 0.05, 0.04));
        g.add(makeDimLine(pLead2, 0x5599ee, 0.05, 0.04));
        g.add(makeDimLine([pTick1a, pTick1b]));
        g.add(makeDimLine([pTick2a, pTick2b]));
        const sp = makeDimSprite(fmtDimCm(segCm), { fontSize: 18, pxPerM: 140 });
        sp.position.copy(pLabel);
        g.add(sp);
      }
    }

    drawSegments(xsSouth, "south", fmaxZ);
    drawSegments(xsNorth, "north", fminZ);
    drawSegments(zsEast, "east", fmaxX);
    drawSegments(zsWest, "west", fminX);

    const totalWCm = (fmaxX - fminX) / (s / 100);
    const totalDCm = (fmaxZ - fminZ) / (s / 100);

    const wZ = fmaxZ + extOuter;
    g.add(makeDimLine([new THREE.Vector3(fminX, labelY, wZ), new THREE.Vector3(fmaxX, labelY, wZ)]));
    g.add(makeDimLine([new THREE.Vector3(fminX, labelY, fmaxZ), new THREE.Vector3(fminX, labelY, wZ + tick)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, labelY, fmaxZ), new THREE.Vector3(fmaxX, labelY, wZ + tick)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fminX, labelY, wZ - tick), new THREE.Vector3(fminX, labelY, wZ + tick)]));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, labelY, wZ - tick), new THREE.Vector3(fmaxX, labelY, wZ + tick)]));
    const wSp = makeDimSprite(fmtDimCm(totalWCm));
    wSp.position.set((fminX + fmaxX) / 2, labelY + 0.18, wZ);
    g.add(wSp);

    const dX = fmaxX + extOuter;
    g.add(makeDimLine([new THREE.Vector3(dX, labelY, fminZ), new THREE.Vector3(dX, labelY, fmaxZ)]));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, labelY, fminZ), new THREE.Vector3(dX + tick, labelY, fminZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fmaxX, labelY, fmaxZ), new THREE.Vector3(dX + tick, labelY, fmaxZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(dX, labelY, fminZ - tick), new THREE.Vector3(dX, labelY, fminZ + tick)]));
    g.add(makeDimLine([new THREE.Vector3(dX, labelY, fmaxZ - tick), new THREE.Vector3(dX, labelY, fmaxZ + tick)]));
    const dSp = makeDimSprite(fmtDimCm(totalDCm));
    dSp.position.set(dX, labelY + 0.18, (fminZ + fmaxZ) / 2);
    g.add(dSp);

    const flH = (Number.isFinite(Number(fl.height)) && fl.height > 0 ? Number(fl.height) : 280) / 100;
    const vX = fminX - extOuter;
    const midZ = (fminZ + fmaxZ) / 2;
    g.add(makeDimLine([new THREE.Vector3(vX, 0, midZ), new THREE.Vector3(vX, flH, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(fminX, 0, midZ), new THREE.Vector3(vX - tick, 0, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(fminX, flH, midZ), new THREE.Vector3(vX - tick, flH, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(vX - tick, 0, midZ), new THREE.Vector3(vX + tick, 0, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(vX - tick, flH, midZ), new THREE.Vector3(vX + tick, flH, midZ)]));
    const hSp = makeDimSprite(fmtDimCm(fl.height || 280));
    hSp.position.set(vX, flH / 2 + 0.15, midZ);
    g.add(hSp);

    return g;
  }

  /**
   * 为单个家具 Group 创建本地坐标系下的尺寸标注 Group。
   * 标注随家具旋转一起变化。
   */
  function buildFurnitureDimAnnotation(group) {
    const item = byId.get(group.userData.modelType);
    const fp = extractFurnitureFootprintCm(item);
    const hw = fp.hw / 100;
    const hh = fp.hh / 100;
    const fh = fp.h / 100;

    const labelY = fh + 0.03;
    const ext = 0.18;
    const tick = 0.06;

    const g = new THREE.Group();
    g.userData.isFurnitureDimAnnotation = true;

    const corners = [
      new THREE.Vector3(-hw, labelY, -hh),
      new THREE.Vector3(hw, labelY, -hh),
      new THREE.Vector3(hw, labelY, hh),
      new THREE.Vector3(-hw, labelY, hh),
      new THREE.Vector3(-hw, labelY, -hh),
    ];
    g.add(makeDimLine(corners, 0x7799cc, 0.07, 0.05));

    const wZ = hh + ext;
    g.add(makeDimLine([new THREE.Vector3(-hw, labelY, wZ), new THREE.Vector3(hw, labelY, wZ)]));
    g.add(makeDimLine([new THREE.Vector3(-hw, labelY, hh), new THREE.Vector3(-hw, labelY, wZ + tick)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(hw, labelY, hh), new THREE.Vector3(hw, labelY, wZ + tick)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(-hw, labelY, wZ - tick), new THREE.Vector3(-hw, labelY, wZ + tick)]));
    g.add(makeDimLine([new THREE.Vector3(hw, labelY, wZ - tick), new THREE.Vector3(hw, labelY, wZ + tick)]));
    const wSp = makeDimSprite(fmtDimCm(fp.w), { fontSize: 18, pxPerM: 140 });
    wSp.position.set(0, labelY + 0.15, wZ);
    g.add(wSp);

    const dX = hw + ext;
    g.add(makeDimLine([new THREE.Vector3(dX, labelY, -hh), new THREE.Vector3(dX, labelY, hh)]));
    g.add(makeDimLine([new THREE.Vector3(hw, labelY, -hh), new THREE.Vector3(dX + tick, labelY, -hh)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(hw, labelY, hh), new THREE.Vector3(dX + tick, labelY, hh)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(dX - tick, labelY, -hh), new THREE.Vector3(dX + tick, labelY, -hh)]));
    g.add(makeDimLine([new THREE.Vector3(dX - tick, labelY, hh), new THREE.Vector3(dX + tick, labelY, hh)]));
    const dSp = makeDimSprite(fmtDimCm(fp.d), { fontSize: 18, pxPerM: 140 });
    dSp.position.set(dX, labelY + 0.15, 0);
    g.add(dSp);

    const midZ = 0;
    const vX = -hw - ext;
    g.add(makeDimLine([new THREE.Vector3(vX, 0, midZ), new THREE.Vector3(vX, fh, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(-hw, 0, midZ), new THREE.Vector3(vX - tick, 0, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(-hw, fh, midZ), new THREE.Vector3(vX - tick, fh, midZ)], 0x5599ee, 0.05, 0.04));
    g.add(makeDimLine([new THREE.Vector3(vX - tick, 0, midZ), new THREE.Vector3(vX + tick, 0, midZ)]));
    g.add(makeDimLine([new THREE.Vector3(vX - tick, fh, midZ), new THREE.Vector3(vX + tick, fh, midZ)]));
    const hSp = makeDimSprite(fmtDimCm(fp.h), { fontSize: 18, pxPerM: 140 });
    hSp.position.set(vX, fh / 2 + 0.15, midZ);
    g.add(hSp);

    return g;
  }

  /** 刷新所有家具的尺寸标注（showDimensions 切换或楼层切换时调用）。 */
  function rebuildFurnitureDimAnnotations() {
    furnitureRoot.children.forEach((group) => {
      if (!group.userData?.isFurniture) return;
      const old = group.children.filter((c) => c.userData?.isFurnitureDimAnnotation);
      old.forEach((c) => {
        group.remove(c);
        disposeObject3D(c);
      });
      if (state.showDimensions && group.visible && group.userData.isFloorActive !== false) {
        group.add(buildFurnitureDimAnnotation(group));
      }
    });
  }

  function hasFloorplanDimAnnotationGroups() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    for (const c of gWorld.children) {
      if (!c.userData?.floorplanFloorGroup) continue;
      for (const ch of c.children) {
        if (ch.userData?.isDimAnnotation) return true;
      }
    }
    return false;
  }

  function hasFloorplanNameAnnotationGroups() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return false;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return false;
    for (const c of gWorld.children) {
      if (!c.userData?.floorplanFloorGroup) continue;
      for (const ch of c.children) {
        if (ch.userData?.isNameAnnotation) return true;
      }
    }
    return false;
  }

  /** 楼层选中切换时：只改尺寸/名称标注子 Group 的 visible（各层均已生成，避免 rebuild 贴图） */
  function syncFloorAnnotationVisibility() {
    const entry = state.currentFloorplanEntry;
    if (!entry) return;
    const gWorld = floorplanRoot.children[0];
    if (!gWorld?.userData?.floorplanGWorld) return;
    const floors = getFloorsFromEntry(entry);
    const floorGroups = [];
    for (const c of gWorld.children) {
      if (c.userData?.floorplanFloorGroup) floorGroups.push(c);
    }
    if (floorGroups.length !== floors.length) return;
    const floorIndex = state.floorSelectionEnabled ? normalizeFloorIndex(entry, state.currentFloorIndex) : -1;
    for (let i = 0; i < floorGroups.length; i++) {
      const isActive = floorIndex >= 0 && i === floorIndex;
      const showAnnot = !state.floorSelectionEnabled || isActive;
      const fg = floorGroups[i];
      for (const ch of fg.children) {
        if (ch.userData?.isDimAnnotation) {
          ch.visible = state.showDimensions && showAnnot;
        } else if (ch.userData?.isNameAnnotation) {
          ch.visible = state.showNames && showAnnot;
        }
      }
    }
  }

  function setDimensionsVisible(v) {
    state.showDimensions = Boolean(v);
    const btn = document.getElementById("svgDimToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", state.showDimensions);
      btn.setAttribute("aria-pressed", String(state.showDimensions));
    }
    if (state.showDimensions && !hasFloorplanDimAnnotationGroups()) {
      void rebuildFloorplan3D();
    } else {
      syncFloorAnnotationVisibility();
    }
    updateFurnitureFloorVisibility();
  }

  /** 刷新所有家具的名称标注 */
  function rebuildFurnitureNameAnnotations() {
    furnitureRoot.children.forEach((group) => {
      if (!group.userData?.isFurniture) return;
      const old = group.children.filter((c) => c.userData?.isFurnitureNameAnnotation);
      old.forEach((c) => {
        group.remove(c);
        disposeObject3D(c);
      });
      if (state.showNames && group.visible && group.userData.isFloorActive !== false) {
        const item = byId.get(group.userData.modelType);
        const name = item ? getFurnitureDisplayName(item) : group.userData.modelType || "家具";
        const fp = extractFurnitureFootprintCm(item);
        const fh = fp.h / 100;
        const sp = makeDimSprite(name, { fontSize: 22, pxPerM: 160 });
        sp.position.set(0, fh + 0.08, 0);
        sp.userData.isFurnitureNameAnnotation = true;
        group.add(sp);
      }
    });
  }

  function setNamesVisible(v) {
    state.showNames = Boolean(v);
    const btn = document.getElementById("svgNameToggleBtn");
    if (btn) {
      btn.classList.toggle("is-active", state.showNames);
      btn.setAttribute("aria-pressed", String(state.showNames));
    }
    if (state.showNames && !hasFloorplanNameAnnotationGroups()) {
      void rebuildFloorplan3D();
    } else {
      syncFloorAnnotationVisibility();
    }
    updateFurnitureFloorVisibility();
  }

  return {
    buildFloorDimensions,
    buildFloorNameAnnotations,
    rebuildFurnitureDimAnnotations,
    rebuildFurnitureNameAnnotations,
    setDimensionsVisible,
    setNamesVisible,
    syncFloorAnnotationVisibility,
  };
}
