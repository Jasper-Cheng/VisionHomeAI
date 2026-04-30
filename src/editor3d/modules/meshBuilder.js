import * as THREE from "three";
import { ShapeUtils } from "three";

import { normalizeDoorStyle, defaultDoorStyleWhite } from "../../floorplan/doorStyle.js";
import { getDoorTypeDef } from "../../floorplan/doorTypes.js";
import { normalizeWindowStyle, defaultWindowStyleWhite } from "../../floorplan/windowStyle.js";
import { resolveTextureAssetUrl } from "../../furniture/furnitureConfig.js";

const WALL_HOLE_EPS = 1e-5;

export function createMeshBuilder(ctx) {
  const {
    applyFloorplanSurfaceAlpha,
    floorplanStdMat,
    getRoomFloorOverride,
    snap,
    surfaceOverrideIsActive,
    tagFloorplanLayerOpacity,
  } = ctx;

  function buildRoomMesh(room, cx, cy, s, floorOpacity, floorStyleMat, floorLevelId) {
    const poly = room?.polygon;
    if (!Array.isArray(poly) || poly.length < 3) return null;
    const pts = poly
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [snap(Number(p[0])), snap(Number(p[1]))]);
    if (pts.length < 3) return null;
    const contourTri = pts.map((p) => {
      const xm = (p[0] - cx) * (s / 100);
      const ym = (p[1] - cy) * (s / 100);
      return new THREE.Vector2(xm, -ym);
    });
    if (ShapeUtils.isClockWise(contourTri) === false) {
      contourTri.reverse();
    }
    const faceList = ShapeUtils.triangulateShape(contourTri, []);
    if (!faceList.length) return null;
    const pos = new Float32Array(contourTri.length * 3);
    const uv = new Float32Array(contourTri.length * 2);
    for (let i = 0; i < contourTri.length; i++) {
      const v = contourTri[i];
      const px = v.x;
      const py = -v.y;
      pos[i * 3] = px;
      pos[i * 3 + 1] = py;
      pos[i * 3 + 2] = 0;
      uv[i * 2] = px;
      uv[i * 2 + 1] = py;
    }
    const idx = [];
    for (let fi = 0; fi < faceList.length; fi++) {
      const f = faceList[fi];
      idx.push(f[0], f[1], f[2]);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    const mat = floorStyleMat || floorplanStdMat();
    mat.userData.__floorplanRoomFloorDepthWrite = true;
    const op = floorOpacity ?? 1;
    applyFloorplanSurfaceAlpha(mat, op);
    if (!floorStyleMat) tagFloorplanLayerOpacity(mat, op);
    mat.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.position.y = 0.02;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanRoomFloor = true;
    mesh.userData.floorplanRoomId = String(room?.id ?? "").trim();
    mesh.userData.roomId = String(room?.id ?? "").trim();
    mesh.userData.floorplanFloorLevelId = String(floorLevelId ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;

    const roomId = mesh.userData.floorplanRoomId;
    if (roomId) {
      const roomOv = getRoomFloorOverride(floorLevelId, roomId);
      if (roomOv && surfaceOverrideIsActive(roomOv)) {
        mesh.userData.floorplanRoomFloorOverride = roomOv;
      }
    }

    return mesh;
  }

  function doorFillMaterialFromNs(ns, floorOpacity) {
    let color;
    try {
      color = new THREE.Color(ns.color);
    } catch {
      return null;
    }
    const op = floorOpacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: ns.roughness,
      metalness: ns.metalness,
      envMapIntensity: 0.35,
      emissive: new THREE.Color(0x000000),
    });
    if (ns.isGlass) {
      applyFloorplanSurfaceAlpha(mat, Math.min(1, 0.42 * op));
    } else {
      applyFloorplanSurfaceAlpha(mat, op);
    }
    tagFloorplanLayerOpacity(mat, op);
    mat.side = THREE.FrontSide;
    return mat;
  }

  function effectiveDoorPanelOpacity(ns, floorOpacity) {
    const op = floorOpacity ?? 1;
    if (ns.isGlass) return Math.min(1, 0.42 * op);
    return op;
  }

  function doorHandleMetalMaterial(panelOpacity, layerOpacityTag) {
    const op = Math.max(0, Math.min(1, panelOpacity));
    const mat = new THREE.MeshStandardMaterial({
      color: 0xa8a8ad,
      metalness: 0.88,
      roughness: 0.32,
      envMapIntensity: 0.55,
      emissive: new THREE.Color(0x000000),
    });
    applyFloorplanSurfaceAlpha(mat, op);
    if (layerOpacityTag != null && Number.isFinite(layerOpacityTag)) {
      tagFloorplanLayerOpacity(mat, layerOpacityTag);
    }
    return mat;
  }

  function addDoorHandleMeshes(group, centerX, wM, hDoor, doorDepth, panelOpacity, layerOpacityTag, floorLevelIdStr) {
    const hMat = doorHandleMetalMaterial(panelOpacity, layerOpacityTag);
    const handleY = Math.min(Math.max(hDoor * 0.45, 0.35), Math.min(1.0, hDoor - 0.05));
    const handleX = centerX + wM * 0.5 - 0.08;
    const faceOut = doorDepth * 0.5 + 0.008;

    const roseGeo = new THREE.CylinderGeometry(0.025, 0.025, 0.012, 16);
    roseGeo.rotateX(Math.PI / 2);
    const levGeo = new THREE.BoxGeometry(0.12, 0.018, 0.024);

    for (const zSign of [1, -1]) {
      const faceZ = zSign * faceOut;
      const roseZ = faceZ + zSign * 0.006;
      const levZ = faceZ + zSign * 0.02;
      const levCenterX = handleX + zSign * -0.055;

      const rose = new THREE.Mesh(roseGeo, hMat);
      rose.position.set(handleX, handleY, roseZ);
      rose.castShadow = true;
      rose.userData.floorplanDoorFill = true;
      rose.userData.floorplanDoorHandle = true;
      rose.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      group.add(rose);

      const lev = new THREE.Mesh(levGeo, hMat);
      lev.position.set(levCenterX, handleY, levZ);
      lev.castShadow = true;
      lev.userData.floorplanDoorFill = true;
      lev.userData.floorplanDoorHandle = true;
      lev.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      group.add(lev);
    }
  }

  function queueDoorFillTextures(mesh, ns) {
    if (!ns) return;
    const texture = ns.texture;
    if (!texture) return;
    const albedo = String(texture.albedo ?? "").trim();
    const rough = String(texture.roughness ?? "").trim();
    const normal = String(texture.normal ?? "").trim();
    if (!albedo && !rough && !normal) return;

    const loader = new THREE.TextureLoader();
    (async () => {
      const mat = mesh.material;
      if (!mat || !mat.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;

      if (albedo) {
        try {
          const url = resolveTextureAssetUrl(albedo);
          diffTex = await loader.loadAsync(url);
          diffTex.colorSpace = THREE.SRGBColorSpace;
          diffTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] door albedo 贴图加载失败:", error);
        }
      }
      if (rough) {
        try {
          const url = resolveTextureAssetUrl(rough);
          roughTex = await loader.loadAsync(url);
          roughTex.colorSpace = THREE.LinearSRGBColorSpace;
          roughTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] door roughness 贴图加载失败:", error);
        }
      }
      if (normal) {
        try {
          const url = resolveTextureAssetUrl(normal);
          normalTex = await loader.loadAsync(url);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] door normal 贴图加载失败:", error);
        }
      }

      if (!diffTex && !roughTex && !normalTex) return;
      if (diffTex) mat.map = diffTex;
      if (roughTex) mat.roughnessMap = roughTex;
      if (normalTex) {
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      mat.needsUpdate = true;
    })();
  }

  function buildDoorFrameMaterialFromDoorNs(ns, floorOpacity) {
    const base = doorFillMaterialFromNs(ns, floorOpacity);
    if (!base || !base.isMeshStandardMaterial) return base;
    base.color = base.color.clone().multiplyScalar(0.92);
    base.roughness = Math.min(1, base.roughness + 0.06);
    base.needsUpdate = true;
    return base;
  }

  function buildDerivedDoorFrameStyleFromDoorNs(ns) {
    if (!ns || typeof ns !== "object") return defaultDoorStyleWhite();
    return {
      roughness: Math.min(1, Number(ns.roughness ?? 0.85) + 0.06),
      metalness: Number.isFinite(Number(ns.metalness)) ? Number(ns.metalness) : 0.02,
      color: (() => {
        try {
          const c = new THREE.Color(ns.color);
          return `#${c.multiplyScalar(0.92).getHexString()}`;
        } catch {
          return "#e0e0e0";
        }
      })(),
      texture: {
        albedo: String(ns.texture?.albedo ?? ""),
        roughness: String(ns.texture?.roughness ?? ""),
        normal: String(ns.texture?.normal ?? ""),
      },
      isGlass: ns.isGlass === true,
    };
  }

  function buildDoorFrameMaterialFromBase(baseMat) {
    if (!baseMat || typeof baseMat.clone !== "function") return null;
    return baseMat.clone();
  }

  function addDoorTypeDetailMeshes(group, door, doorType, centerX, wM, hDoor, wallDepth, floorOpacity, panelMat, floorLevelIdStr) {
    const mode = doorType?.panelMode || "swing";
    const detailMat = panelMat && typeof panelMat.clone === "function" ? panelMat.clone() : floorplanStdMat();
    if (detailMat?.isMaterial) {
      detailMat.side = THREE.DoubleSide;
      detailMat.transparent = true;
      detailMat.opacity = Math.min(Number(detailMat.opacity ?? 1), Math.max(0.22, 0.42 * (floorOpacity ?? 1)));
      detailMat.depthWrite = false;
      detailMat.needsUpdate = true;
    }
    const railMat = new THREE.MeshStandardMaterial({
      color: 0x8a8174,
      roughness: 0.72,
      metalness: 0.22,
      transparent: true,
      opacity: Math.max(0.25, 0.58 * (floorOpacity ?? 1)),
    });
    const z = wallDepth * 0.74;
    const thin = Math.max(0.012, wallDepth * 0.08);

    function addPanel(width, height, x, zOffset = z, material = detailMat) {
      const geo = new THREE.BoxGeometry(width, height, thin);
      const mesh = new THREE.Mesh(geo, material);
      mesh.position.set(x, height / 2, zOffset);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.floorplanDoorFill = true;
      mesh.userData.floorplanDoor = true;
      mesh.userData.floorplanDoorId = String(door?.id ?? "").trim();
      mesh.userData.doorId = String(door?.id ?? "").trim();
      mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      mesh.userData.floorplanDoorType = doorType.id;
      group.add(mesh);
    }

    function addRail(width, x, yy = hDoor + 0.1) {
      const geo = new THREE.BoxGeometry(width, 0.035, Math.max(0.018, wallDepth * 0.12));
      const mesh = new THREE.Mesh(geo, railMat);
      mesh.position.set(x, yy, z + 0.012);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.floorplanDoorFill = true;
      mesh.userData.floorplanDoor = true;
      mesh.userData.floorplanDoorId = String(door?.id ?? "").trim();
      mesh.userData.doorId = String(door?.id ?? "").trim();
      mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      mesh.userData.floorplanDoorType = doorType.id;
      group.add(mesh);
    }

    if (mode === "sliding") {
      const panelW = wM * 0.56;
      addPanel(panelW, hDoor * 0.96, centerX - panelW * 0.24, z + 0.008);
      addPanel(panelW, hDoor * 0.96, centerX + panelW * 0.24, z + 0.03);
      addRail(wM * 1.06, centerX, hDoor + 0.04);
    } else if (mode === "barn") {
      addPanel(wM * 1.06, hDoor * 0.96, centerX, z + 0.04);
      addRail(wM * 1.22, centerX, hDoor + 0.1);
    } else if (mode === "folding") {
      const leafW = wM / 4;
      for (let i = 0; i < 4; i += 1) {
        const x = centerX - wM / 2 + leafW * (i + 0.5);
        addPanel(leafW * 0.92, hDoor * 0.92, x, z + (i % 2 ? 0.03 : 0.01));
      }
    } else if (mode === "double_swing") {
      addPanel(wM * 0.48, hDoor * 0.94, centerX - wM * 0.25, z + 0.012);
      addPanel(wM * 0.48, hDoor * 0.94, centerX + wM * 0.25, z + 0.012);
    } else {
      addPanel(wM * 0.96, hDoor * 0.94, centerX, z + 0.012);
    }
  }

  function addDoorFrameMeshes(group, door, doorFrame, centerX, wM, hDoor, wallDepth, floorOpacity, styleDoorFrameMat, ns, floorLevelIdStr) {
    const rawFrameCm = Number(doorFrame?.thicknessCm ?? doorFrame?.frameThicknessCm);
    const frameW = Math.max(0.025, (Number.isFinite(rawFrameCm) && rawFrameCm > 0 ? rawFrameCm : 6) / 100);
    const frameDepth = Math.max(0.018, Math.min(0.04, wallDepth * 0.22));
    const frameFaceGap = 0.0008;
    const casingEdgeOverlap = Math.min(0.014, frameW * 0.22, wM * 0.035);
    const jambSeamOverlap = Math.min(0.008, frameDepth * 0.45);
    const jambEdgeOverlap = Math.min(0.01, frameW * 0.22, wM * 0.03);
    const faceOffset = wallDepth * 0.5 + frameDepth * 0.5 + frameFaceGap;
    const jambDepth = Math.max(0.02, wallDepth + jambSeamOverlap * 2);
    const sideHeight = hDoor + frameW;
    const topWidth = wM + frameW * 2;
    const resolvedFrameNs = buildDerivedDoorFrameStyleFromDoorNs(ns);
    const frameMat = styleDoorFrameMat
      ? buildDoorFrameMaterialFromBase(styleDoorFrameMat)
      : buildDoorFrameMaterialFromDoorNs(ns, floorOpacity);
    if (!frameMat) return;
    if (frameMat.isMaterial) {
      frameMat.side = THREE.DoubleSide;
      frameMat.polygonOffset = true;
      frameMat.polygonOffsetFactor = -1;
      frameMat.polygonOffsetUnits = -1;
      frameMat.needsUpdate = true;
    }
    let queuedFrameTexture = false;

    const createFramePiece = (geometry, x, y, zSign) => {
      const mesh = new THREE.Mesh(geometry, frameMat);
      mesh.position.set(x, y, zSign * faceOffset);
      mesh.renderOrder = 4;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.floorplanDoorFill = true;
      mesh.userData.floorplanDoorFrame = true;
      mesh.userData.floorplanDoor = true;
      mesh.userData.doorId = String(door?.id ?? "").trim();
      mesh.userData.floorplanDoorId = String(door?.id ?? "").trim();
      mesh.userData.frameMaterialId = String(doorFrame?.id ?? "").trim();
      mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
      mesh.userData.floorplanDoorStyle = ns;
      mesh.userData.floorplanDoorFrameStyle = resolvedFrameNs;
      group.add(mesh);
      if (!styleDoorFrameMat && !queuedFrameTexture) {
        queueDoorFillTextures(mesh, resolvedFrameNs);
        queuedFrameTexture = true;
      }
    };

    const sideGeo = new THREE.BoxGeometry(frameW + casingEdgeOverlap * 2, sideHeight, frameDepth);
    const topGeo = new THREE.BoxGeometry(topWidth + casingEdgeOverlap * 2, frameW + casingEdgeOverlap, frameDepth);
    const sideCoreGeo = new THREE.BoxGeometry(frameW + casingEdgeOverlap * 2, sideHeight, jambDepth);
    const topCoreGeo = new THREE.BoxGeometry(topWidth + casingEdgeOverlap * 2, frameW + casingEdgeOverlap, jambDepth);
    const jambRevealW = Math.min(frameW, Math.max(0.018, frameW * 0.45));
    const jambSideW = jambRevealW + jambEdgeOverlap;
    const jambTopH = jambRevealW + jambEdgeOverlap;
    const jambSideGeo = new THREE.BoxGeometry(jambSideW, hDoor + jambEdgeOverlap, jambDepth);
    const jambTopGeo = new THREE.BoxGeometry(wM + jambEdgeOverlap * 2, jambTopH, jambDepth);
    const sideY = sideHeight / 2;
    const leftX = centerX - wM / 2 - frameW / 2;
    const rightX = centerX + wM / 2 + frameW / 2;
    const topY = hDoor + frameW / 2;
    const jambSideY = (hDoor + jambEdgeOverlap) / 2;
    const leftJambX = centerX - wM / 2 + (jambRevealW - jambEdgeOverlap) / 2;
    const rightJambX = centerX + wM / 2 + (jambEdgeOverlap - jambRevealW) / 2;
    const topJambY = hDoor + (jambEdgeOverlap - jambRevealW) / 2;

    for (const zSign of [1, -1]) {
      createFramePiece(sideGeo, leftX, sideY, zSign);
      createFramePiece(sideGeo, rightX, sideY, zSign);
      createFramePiece(topGeo, centerX, topY, zSign);
    }

    // Jamb liners wrap the opening thickness so the wall reveal uses frame material instead of wall paint.
    const createJambPiece = (geometry, x, y) => {
      const mesh = new THREE.Mesh(geometry, frameMat);
      mesh.position.set(x, y, 0);
      mesh.renderOrder = 4;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.floorplanDoorFill = true;
      mesh.userData.floorplanDoorFrame = true;
      mesh.userData.floorplanDoor = true;
      mesh.userData.doorId = String(door?.id ?? "").trim();
      mesh.userData.floorplanDoorId = String(door?.id ?? "").trim();
      mesh.userData.frameMaterialId = String(doorFrame?.id ?? "").trim();
      mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
      mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
      mesh.userData.floorplanDoorStyle = ns;
      mesh.userData.floorplanDoorFrameStyle = resolvedFrameNs;
      group.add(mesh);
      if (!styleDoorFrameMat && !queuedFrameTexture) {
        queueDoorFillTextures(mesh, resolvedFrameNs);
        queuedFrameTexture = true;
      }
    };

    createJambPiece(sideCoreGeo, leftX, sideY);
    createJambPiece(sideCoreGeo, rightX, sideY);
    createJambPiece(topCoreGeo, centerX, topY);
    createJambPiece(jambSideGeo, leftJambX, jambSideY);
    createJambPiece(jambSideGeo, rightJambX, jambSideY);
    createJambPiece(jambTopGeo, centerX, topJambY);
  }

  function buildDoorFillGroup(
    door,
    doorFrame,
    wall,
    floorWalls,
    cx,
    cy,
    s,
    defaultHeightCm,
    floorOpacity,
    styleDoorMat,
    styleDoorFrameMat,
    floorLevelIdStr,
  ) {
    if (!door || !wall) return null;
    const ns =
      door.style != null && typeof door.style === "object" && !Array.isArray(door.style)
        ? normalizeDoorStyle(door.style)
        : defaultDoorStyleWhite();
    const doorType = getDoorTypeDef(door);
    const pos = Number(door.pos);
    const wcm = Number(door.width);
    const hcm = Number(door.height);
    if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) return null;
    const x1Raw = snap(Number(wall.start[0]));
    const y1Raw = snap(Number(wall.start[1]));
    const x2Raw = snap(Number(wall.end[0]));
    const y2Raw = snap(Number(wall.end[1]));
    const dxcRaw = x2Raw - x1Raw;
    const dycRaw = y2Raw - y1Raw;
    const lenCmRaw = Math.hypot(dxcRaw, dycRaw);
    if (lenCmRaw < 1e-9) return null;
    const ux = dxcRaw / lenCmRaw;
    const uy = dycRaw / lenCmRaw;
    const { startExtCm, endExtCm } = ctx.computeWallEndpointExtensionsCm(wall, floorWalls || []);
    const x1 = x1Raw - ux * startExtCm;
    const y1 = y1Raw - uy * startExtCm;
    const x2 = x2Raw + ux * endExtCm;
    const y2 = y2Raw + uy * endExtCm;
    const dx = (x2 - x1) * (s / 100);
    const dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const lenCm = lenCmRaw + startExtCm + endExtCm;
    if (!Number.isFinite(lenCm) || lenCm < 1e-9) return null;
    const hM = defaultHeightCm / 100;
    const wM = (wcm * s) / 100;
    const hDoor = Math.min((hcm * s) / 100, hM);
    if (hDoor < WALL_HOLE_EPS) return null;
    const th = Number(wall.thickness);
    const thickMRaw = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const halfLen = lenWorld / 2;
    const centerX = -halfLen + ((startExtCm + pos) / lenCm) * lenWorld;
    const mx = ((x1 + x2) / 2 - cx) * (s / 100);
    const mz = ((y1 + y2) / 2 - cy) * (s / 100);
    const rotY = Math.atan2(dz, dx);
    const group = new THREE.Group();
    group.position.set(mx, 0, mz);
    group.rotation.y = rotY;
    group.userData.floorplanDoorFill = true;
    group.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    const geo = new THREE.BoxGeometry(wM, hDoor, thickM * 0.22);
    const mat = styleDoorMat || doorFillMaterialFromNs(ns, floorOpacity);
    if (!mat) {
      geo.dispose();
      return null;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(centerX, hDoor / 2, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanDoorFill = true;
    mesh.userData.floorplanDoor = true;
    mesh.userData.doorId = String(door?.id ?? "").trim();
    mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
    mesh.userData.floorplanDoorStyle = ns;
    mesh.userData.floorplanDoorId = String(door?.id ?? "").trim();
    mesh.userData.floorplanDoorType = doorType.id;
    if (!styleDoorMat) queueDoorFillTextures(mesh, ns);
    group.add(mesh);
    const doorDepth = thickM * 0.22;
    addDoorFrameMeshes(group, door, doorFrame, centerX, wM, hDoor, thickM, floorOpacity, styleDoorFrameMat, ns, floorLevelIdStr);
    if (doorType.panelMode !== "swing") {
      addDoorTypeDetailMeshes(group, door, doorType, centerX, wM, hDoor, thickM, floorOpacity, mat, floorLevelIdStr);
    }
    addDoorHandleMeshes(
      group,
      centerX,
      wM,
      hDoor,
      doorDepth,
      styleDoorMat ? (floorOpacity ?? 1) : effectiveDoorPanelOpacity(ns, floorOpacity),
      floorOpacity ?? 1,
      floorLevelIdStr,
    );
    return group;
  }

  function windowGlassMaterialFromNs(ns, floorOpacity) {
    let color;
    try {
      color = new THREE.Color(ns.color);
    } catch {
      return null;
    }
    const floorOp = floorOpacity ?? 1;
    const op = Math.max(0, Math.min(1, ns.opacity * floorOp));
    let roughness = 0.14;
    let envMapIntensity = 0.55;
    if (ns.type === "clear") {
      roughness = 0.04;
      envMapIntensity = 0.95;
    } else if (ns.type === "frosted") {
      roughness = 0.92;
      envMapIntensity = 0.28;
    } else if (ns.type === "tinted") {
      roughness = 0.12;
      envMapIntensity = 0.5;
    }
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness,
      metalness: 0.02,
      transparent: true,
      opacity: op,
      envMapIntensity,
      emissive: new THREE.Color(0x000000),
    });
    applyFloorplanSurfaceAlpha(mat, op);
    tagFloorplanLayerOpacity(mat, floorOp);
    mat.side = THREE.FrontSide;
    return mat;
  }

  function queueWindowFillTextures(mesh, ns) {
    if (!ns) return;
    const texture = ns.texture;
    if (!texture) return;
    const albedo = String(texture.albedo ?? "").trim();
    const rough = String(texture.roughness ?? "").trim();
    const normal = String(texture.normal ?? "").trim();
    if (!albedo && !rough && !normal) return;

    const loader = new THREE.TextureLoader();
    (async () => {
      const mat = mesh.material;
      if (!mat || !mat.isMeshStandardMaterial) return;

      let diffTex = null;
      let roughTex = null;
      let normalTex = null;

      if (albedo) {
        try {
          const url = resolveTextureAssetUrl(albedo);
          diffTex = await loader.loadAsync(url);
          diffTex.colorSpace = THREE.SRGBColorSpace;
          diffTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] window albedo 贴图加载失败:", error);
        }
      }
      if (rough) {
        try {
          const url = resolveTextureAssetUrl(rough);
          roughTex = await loader.loadAsync(url);
          roughTex.colorSpace = THREE.LinearSRGBColorSpace;
          roughTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] window roughness 贴图加载失败:", error);
        }
      }
      if (normal) {
        try {
          const url = resolveTextureAssetUrl(normal);
          normalTex = await loader.loadAsync(url);
          normalTex.colorSpace = THREE.NoColorSpace;
          normalTex.flipY = false;
        } catch (error) {
          console.warn("[VisionHome] window normal 贴图加载失败:", error);
        }
      }

      if (!diffTex && !roughTex && !normalTex) return;
      if (diffTex) mat.map = diffTex;
      if (roughTex) mat.roughnessMap = roughTex;
      if (normalTex) {
        mat.normalMap = normalTex;
        mat.normalScale = new THREE.Vector2(1, 1);
      }
      mat.needsUpdate = true;
    })();
  }

  function buildWindowGlassGroup(win, wall, floorWalls, cx, cy, s, defaultHeightCm, floorOpacity, styleWinMat, floorLevelIdStr) {
    if (!win || !wall) return null;
    const ns =
      win.style != null && typeof win.style === "object" && !Array.isArray(win.style)
        ? normalizeWindowStyle(win.style)
        : defaultWindowStyleWhite();
    const pos = Number(win.pos);
    const wcm = Number(win.width);
    const hcm = Number(win.height);
    const altCm = Number(win.altitude ?? win.alt ?? win.sillHeightCm ?? 0);
    if (!Number.isFinite(pos) || !Number.isFinite(wcm) || wcm <= 0 || !Number.isFinite(hcm) || hcm <= 0) return null;
    if (!Number.isFinite(altCm)) return null;
    const x1Raw = snap(Number(wall.start[0]));
    const y1Raw = snap(Number(wall.start[1]));
    const x2Raw = snap(Number(wall.end[0]));
    const y2Raw = snap(Number(wall.end[1]));
    const dxcRaw = x2Raw - x1Raw;
    const dycRaw = y2Raw - y1Raw;
    const lenCmRaw = Math.hypot(dxcRaw, dycRaw);
    if (lenCmRaw < 1e-9) return null;
    const ux = dxcRaw / lenCmRaw;
    const uy = dycRaw / lenCmRaw;
    const { startExtCm, endExtCm } = ctx.computeWallEndpointExtensionsCm(wall, floorWalls || []);
    const x1 = x1Raw - ux * startExtCm;
    const y1 = y1Raw - uy * startExtCm;
    const x2 = x2Raw + ux * endExtCm;
    const y2 = y2Raw + uy * endExtCm;
    const dx = (x2 - x1) * (s / 100);
    const dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const lenCm = lenCmRaw + startExtCm + endExtCm;
    if (!Number.isFinite(lenCm) || lenCm < 1e-9) return null;
    const hM = defaultHeightCm / 100;
    const wM = (wcm * s) / 100;
    const y0 = (altCm * s) / 100;
    const hWin = (hcm * s) / 100;
    const hWinClamped = Math.max(0, Math.min(hWin, hM - y0));
    if (hWinClamped < WALL_HOLE_EPS) return null;
    const th = Number(wall.thickness);
    const thickMRaw = ((Number.isFinite(th) && th > 0 ? th : 10) * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const halfLen = lenWorld / 2;
    const centerX = -halfLen + ((startExtCm + pos) / lenCm) * lenWorld;
    const mx = ((x1 + x2) / 2 - cx) * (s / 100);
    const mz = ((y1 + y2) / 2 - cy) * (s / 100);
    const rotY = Math.atan2(dz, dx);
    const group = new THREE.Group();
    group.position.set(mx, 0, mz);
    group.rotation.y = rotY;
    group.userData.floorplanWindowFill = true;
    group.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    const geo = new THREE.BoxGeometry(wM, hWinClamped, thickM * 0.22);
    const mat = styleWinMat || windowGlassMaterialFromNs(ns, floorOpacity);
    if (!mat) {
      geo.dispose();
      return null;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 12;
    mesh.position.set(centerX, y0 + hWinClamped / 2, 0);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.floorplanPick = true;
    mesh.userData.floorplanWindowFill = true;
    mesh.userData.floorplanWindow = true;
    mesh.userData.windowId = String(win?.id ?? "").trim();
    mesh.userData.floorplanFloorLevelId = String(floorLevelIdStr ?? "").trim();
    mesh.userData.floorplanSurfaceOpacity = floorOpacity ?? 1;
    mesh.userData.floorplanWindowStyle = ns;
    mesh.userData.floorplanWindowId = String(win?.id ?? "").trim();
    if (!styleWinMat) queueWindowFillTextures(mesh, ns);
    group.add(mesh);
    return group;
  }

  return {
    buildDoorFillGroup,
    buildRoomMesh,
    buildWindowGlassGroup,
    doorFillMaterialFromNs,
    windowGlassMaterialFromNs,
  };
}
