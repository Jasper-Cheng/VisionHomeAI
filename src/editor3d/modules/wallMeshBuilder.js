import * as THREE from "three";

import { findWallSideRoomsAt, resolveRoomWallMaterialKey } from "../../floorplan/floorplanStyle.js";

export function createWallMeshBuilder(ctx) {
  const {
    WALL_HOLE_EPS,
    applyFloorplanSurfaceAlpha,
    cellFullyInsideAnyHole,
    clipLocalPolygonByLineKeepPoint,
    clipLocalPolygonByXRange,
    collectWallOpeningHolesLocal,
    computeParallelWallSideOverlapRangesLocal,
    computeWallEndpointExtensionsCm,
    convexHull2d,
    floorplanStdMat,
    intervalRangeCovers,
    makeWallPlanPrismGeometryLocal,
    mergeSplitEdges,
    polygonAabbCm,
    remapWallBoxUvToWallSpan,
    suppressWallBoxFaces,
    tagFloorplanLayerOpacity,
  } = ctx;

  function buildWallMesh(wall, floor, cx, cy, s, defaultHeightCm, floorOpacity, wallStyleMat, style, getMaterialForKey, floorLevelId) {
    if (!Array.isArray(wall?.start) || wall.start.length < 2 || !Array.isArray(wall?.end) || wall.end.length < 2) return null;
    const x1Raw = ctx.snap(Number(wall.start[0]));
    const y1Raw = ctx.snap(Number(wall.start[1]));
    const x2Raw = ctx.snap(Number(wall.end[0]));
    const y2Raw = ctx.snap(Number(wall.end[1]));
    const dxc = x2Raw - x1Raw;
    const dyc = y2Raw - y1Raw;
    const lenCmRaw = Math.hypot(dxc, dyc);
    if (lenCmRaw < 1e-9) return null;
    const ux = dxc / lenCmRaw;
    const uy = dyc / lenCmRaw;

    const { startExtCm, endExtCm, startMiterFill, endMiterFill, startTrimClip, endTrimClip } =
      computeWallEndpointExtensionsCm(wall, floor?.walls || []);
    const x1 = x1Raw - ux * startExtCm;
    const y1 = y1Raw - uy * startExtCm;
    const x2 = x2Raw + ux * endExtCm;
    const y2 = y2Raw + uy * endExtCm;
    const dx = (x2 - x1) * (s / 100);
    const dz = (y2 - y1) * (s / 100);
    const lenWorld = Math.hypot(dx, dz);
    if (lenWorld < 1e-9) return null;
    const wallIdStr = String(wall?.id ?? "").trim();
    const floorIdStr = String(floorLevelId ?? "").trim();
    const lenCm = lenCmRaw + startExtCm + endExtCm;
    const th = Number(wall.thickness);
    const thicknessCm = Number.isFinite(th) && th > 0 ? th : 10;
    const thickMRaw = (thicknessCm * s) / 100;
    const thickM = Math.max(0.03, thickMRaw);
    const hM = defaultHeightCm / 100;
    const holes = collectWallOpeningHolesLocal(wall, floor, lenWorld, lenCm, hM, s, startExtCm);

    const rotY = Math.atan2(dz, dx);
    const op = floorOpacity ?? 1;
    const cornerMiterFills = [startMiterFill, endMiterFill].filter(Boolean);
    const skipWallStartCap = ctx.wallEndCapCoveredByOtherWallCm(wall, floor?.walls || [], x1, y1, ux, uy, thicknessCm);
    const skipWallEndCap = ctx.wallEndCapCoveredByOtherWallCm(wall, floor?.walls || [], x2, y2, ux, uy, thicknessCm);
    const parallelSideOverlaps = computeParallelWallSideOverlapRangesLocal(
      wall,
      floor?.walls || [],
      { x1, y1, x2, y2 },
      lenCm,
      ux,
      uy,
      thicknessCm,
      s / 100,
    );
    const parallelSplitXs = parallelSideOverlaps.splitXs || [];
    const halfThick = thickM / 2;

    function wallSideSuppressForRange(xa, xb) {
      return {
        skipFaceA: intervalRangeCovers(parallelSideOverlaps.faceA, xa, xb),
        skipFaceB: intervalRangeCovers(parallelSideOverlaps.faceB, xa, xb),
      };
    }

    function wallSideSkipEdgesForRange(xa, xb) {
      const suppress = wallSideSuppressForRange(xa, xb);
      const out = [];
      if (suppress.skipFaceA) out.push([[xa, halfThick], [xb, halfThick]]);
      if (suppress.skipFaceB) out.push([[xa, -halfThick], [xb, -halfThick]]);
      return { suppress, skipSideEdges: out };
    }

    function makeWallMaterial() {
      if (wallStyleMat) {
        wallStyleMat.side = THREE.FrontSide;
        return wallStyleMat;
      }
      const mat = floorplanStdMat();
      applyFloorplanSurfaceAlpha(mat, op);
      mat.side = THREE.FrontSide;
      tagFloorplanLayerOpacity(mat, op);
      return mat;
    }

    function wallFaceMaterialsAtT(t) {
      const baseMat = makeWallMaterial();
      const useRoomWalls = style && typeof getMaterialForKey === "function";
      const faceAKey = wallIdStr ? `${wallIdStr}__face_a` : null;
      const faceBKey = wallIdStr ? `${wallIdStr}__face_b` : null;
      const bakedFaceA = faceAKey && typeof getMaterialForKey === "function" ? getMaterialForKey(faceAKey) : null;
      const bakedFaceB = faceBKey && typeof getMaterialForKey === "function" ? getMaterialForKey(faceBKey) : null;

      if (!useRoomWalls) {
        if (bakedFaceA || bakedFaceB) {
          const matA = bakedFaceA || baseMat;
          const matB = bakedFaceB || baseMat;
          return { mats: [baseMat, baseMat, baseMat, baseMat, matA, matB], baseMat };
        }
        return { mats: null, baseMat };
      }
      const { roomPosZ, roomNegZ } = findWallSideRoomsAt(floor, wall, t, 4);
      function faceMatForRoom(room) {
        if (!room) return baseMat;
        const roomKey = resolveRoomWallMaterialKey(style, room);
        if (!roomKey) return baseMat;
        const mat = getMaterialForKey(roomKey);
        return mat || baseMat;
      }
      const roomMatPosZ = faceMatForRoom(roomPosZ);
      const roomMatNegZ = faceMatForRoom(roomNegZ);
      const matPosZ = bakedFaceA || roomMatPosZ;
      const matNegZ = bakedFaceB || roomMatNegZ;
      return { mats: [baseMat, baseMat, baseMat, baseMat, matPosZ, matNegZ], baseMat };
    }

    function wallMaterialArrayAtT(t) {
      const { mats, baseMat } = wallFaceMaterialsAtT(t);
      if (Array.isArray(mats)) return mats;
      return [baseMat, baseMat, baseMat, baseMat, baseMat, baseMat];
    }

    function tagWallMesh(mesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.userData.floorplanPick = true;
      mesh.userData.floorplanWallFace = true;
      mesh.userData.floorplanWall = true;
      mesh.userData.wallId = wallIdStr;
      mesh.userData.floorplanWallId = wallIdStr;
      mesh.userData.floorplanFloorLevelId = floorIdStr;
      mesh.userData.floorplanSurfaceOpacity = op;
    }

    function buildMiteredWallPlanPolygonLocal() {
      const trimClips = [startTrimClip, endTrimClip].filter(Boolean);
      if (!cornerMiterFills.length && !trimClips.length) return null;
      const halfSpan = lenWorld / 2;
      const k = s / 100;
      const wallCenter = new THREE.Vector3(((x1 + x2) / 2 - cx) * k, 0, ((y1 + y2) / 2 - cy) * k);
      const wallMatrix = new THREE.Matrix4().makeRotationY(rotY);
      wallMatrix.setPosition(wallCenter);
      const worldToWall = new THREE.Matrix4().copy(wallMatrix).invert();
      const v = new THREE.Vector3();
      const skipSideEdges = [];
      function planPointToWallLocal(pt) {
        const px = Number(pt?.[0]);
        const py = Number(pt?.[1]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
        v.set((px - cx) * k, 0, (py - cy) * k).applyMatrix4(worldToWall);
        return [v.x, v.z];
      }
      const rawStartLocal = startTrimClip ? planPointToWallLocal([x1Raw, y1Raw]) : null;
      const rawEndLocal = endTrimClip ? planPointToWallLocal([x2Raw, y2Raw]) : null;
      const baseMinX = rawStartLocal ? Math.min(-halfSpan, rawStartLocal[0]) : -halfSpan;
      const baseMaxX = rawEndLocal ? Math.max(halfSpan, rawEndLocal[0]) : halfSpan;
      const pts = [
        [baseMinX, -halfThick],
        [baseMaxX, -halfThick],
        [baseMaxX, halfThick],
        [baseMinX, halfThick],
      ];
      for (const fill of cornerMiterFills) {
        for (const pt of fill?.triangleCm || []) {
          const localPt = planPointToWallLocal(pt);
          if (localPt) pts.push(localPt);
        }
        if (Array.isArray(fill?.seamCm) && fill.seamCm.length >= 2) {
          const a = planPointToWallLocal(fill.seamCm[0]);
          const b = planPointToWallLocal(fill.seamCm[1]);
          if (a && b) skipSideEdges.push([a, b]);
        }
      }
      for (const clip of trimClips) {
        const pointCm = clip?.pointCm;
        const dirCm = clip?.dirCm;
        const keepPointCm = clip?.keepPointCm;
        if (!Array.isArray(pointCm) || !Array.isArray(dirCm) || !Array.isArray(keepPointCm)) continue;
        const px = Number(pointCm[0]);
        const py = Number(pointCm[1]);
        const dxClip = Number(dirCm[0]);
        const dyClip = Number(dirCm[1]);
        if (![px, py, dxClip, dyClip].every((value) => Number.isFinite(value))) continue;
        const lineHalfCm = Math.max(lenCmRaw, thicknessCm, 100) * 100;
        const a = planPointToWallLocal([px - dxClip * lineHalfCm, py - dyClip * lineHalfCm]);
        const b = planPointToWallLocal([px + dxClip * lineHalfCm, py + dyClip * lineHalfCm]);
        const keepPoint = planPointToWallLocal(keepPointCm);
        if (a && b && keepPoint) skipSideEdges.push([a, b]);
      }
      let poly = convexHull2d(pts);
      for (const clip of trimClips) {
        const pointCm = clip?.pointCm;
        const dirCm = clip?.dirCm;
        const keepPointCm = clip?.keepPointCm;
        if (!Array.isArray(pointCm) || !Array.isArray(dirCm) || !Array.isArray(keepPointCm)) continue;
        const px = Number(pointCm[0]);
        const py = Number(pointCm[1]);
        const dxClip = Number(dirCm[0]);
        const dyClip = Number(dirCm[1]);
        if (![px, py, dxClip, dyClip].every((value) => Number.isFinite(value))) continue;
        const a = planPointToWallLocal([px, py]);
        const b = planPointToWallLocal([px + dxClip, py + dyClip]);
        const keepPoint = planPointToWallLocal(keepPointCm);
        if (a && b && keepPoint) {
          poly = clipLocalPolygonByLineKeepPoint(poly, a, b, keepPoint);
          if (poly.length < 3) return null;
        }
      }
      return poly.length >= 3 ? { poly, skipSideEdges } : null;
    }

    function addMiteredWallPiece(parent, planPoly, xMin, xMax, yMin, yMax, tMid, geometryOptions = {}) {
      const clipped = clipLocalPolygonByXRange(planPoly, xMin, xMax);
      if (clipped.length < 3) return;
      const geo = makeWallPlanPrismGeometryLocal(clipped, yMin, yMax, lenWorld, hM, geometryOptions);
      if (!geo) return;
      const mesh = new THREE.Mesh(geo, wallMaterialArrayAtT(tMid));
      tagWallMesh(mesh);
      parent.add(mesh);
    }

    function buildMiteredWallMesh(planPoly, baseSkipSideEdges = []) {
      const group = new THREE.Group();
      group.position.set(((x1 + x2) / 2 - cx) * (s / 100), 0, ((y1 + y2) / 2 - cy) * (s / 100));
      group.rotation.y = rotY;
      group.userData.floorplanPick = true;
      group.userData.floorplanWallId = wallIdStr;
      group.userData.floorplanFloorLevelId = floorIdStr;
      const halfSpan = lenWorld / 2;
      const bounds = polygonAabbCm(planPoly);
      if (!bounds) return null;
      const polyMinX = bounds.minX;
      const polyMaxX = bounds.maxX;
      const hasStartExtension = polyMinX < -halfSpan - WALL_HOLE_EPS;
      const hasEndExtension = polyMaxX > halfSpan + WALL_HOLE_EPS;
      const coreSplitXs = mergeSplitEdges(-halfSpan, halfSpan, parallelSplitXs);
      function pieceOptions(xa, xb, skipCapAtX = [], extra = {}) {
        const { skipSideEdges } = wallSideSkipEdgesForRange(xa, xb);
        return {
          ...extra,
          skipCapAtX,
          skipSideEdges: baseSkipSideEdges.concat(skipSideEdges),
        };
      }
      const fullPieceSkipCapAtX = [];
      if (skipWallStartCap && !hasStartExtension) fullPieceSkipCapAtX.push(-halfSpan);
      if (skipWallEndCap && !hasEndExtension) fullPieceSkipCapAtX.push(halfSpan);
      if (!holes.length) {
        const useRoomWalls = style && typeof getMaterialForKey === "function";
        if (!useRoomWalls) {
          if (!hasStartExtension && !hasEndExtension && coreSplitXs.length === 2) {
            addMiteredWallPiece(group, planPoly, polyMinX, polyMaxX, 0, hM, 0.5, pieceOptions(-halfSpan, halfSpan, fullPieceSkipCapAtX));
          } else {
            if (hasStartExtension) {
              addMiteredWallPiece(group, planPoly, polyMinX, -halfSpan, 0, hM, 0, {
                skipCapAtX: [-halfSpan],
                skipSideEdges: baseSkipSideEdges.slice(),
              });
            }
            if (hasEndExtension) {
              addMiteredWallPiece(group, planPoly, halfSpan, polyMaxX, 0, hM, 1, {
                skipCapAtX: [halfSpan],
                skipSideEdges: baseSkipSideEdges.slice(),
              });
            }
            for (let i = 0; i < coreSplitXs.length - 1; i++) {
              const xa = coreSplitXs[i];
              const xb = coreSplitXs[i + 1];
              if (xb - xa < WALL_HOLE_EPS) continue;
              const skipCapAtX = [];
              if (i > 0 || hasStartExtension || skipWallStartCap) skipCapAtX.push(xa);
              if (i < coreSplitXs.length - 2 || hasEndExtension || skipWallEndCap) skipCapAtX.push(xb);
              addMiteredWallPiece(group, planPoly, xa, xb, 0, hM, ((xa + xb) / 2 + halfSpan) / lenWorld, pieceOptions(xa, xb, skipCapAtX));
            }
          }
          return group.children.length ? group : null;
        }
        if (hasStartExtension) {
          addMiteredWallPiece(group, planPoly, polyMinX, -halfSpan, 0, hM, 0, {
            skipCapAtX: [-halfSpan],
            skipSideEdges: baseSkipSideEdges.slice(),
          });
        }
        if (hasEndExtension) {
          addMiteredWallPiece(group, planPoly, halfSpan, polyMaxX, 0, hM, 1, {
            skipCapAtX: [halfSpan],
            skipSideEdges: baseSkipSideEdges.slice(),
          });
        }
        const N = Math.min(256, Math.max(24, Math.ceil(lenCm / 4)));
        const samples = [];
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          const { roomPosZ, roomNegZ } = findWallSideRoomsAt(floor, wall, t, 4);
          const rk = `${String(roomPosZ?.id ?? "")}|${String(roomNegZ?.id ?? "")}`;
          samples.push({ t, roomPosZ, roomNegZ, rk });
        }
        const tLeft = (idx) => (idx === 0 ? 0 : (2 * idx - 1) / (2 * N));
        const tRight = (idx) => (idx === N ? 1 : (2 * idx + 1) / (2 * N));
        let start = 0;
        for (let i = 1; i <= N + 1; i++) {
          if (i === N + 1 || (i <= N && samples[i].rk !== samples[start].rk)) {
            const b = i - 1;
            const t0 = tLeft(start);
            const t1 = tRight(b);
            const xa0 = -halfSpan + lenWorld * t0;
            const xb0 = -halfSpan + lenWorld * t1;
            const xsLocal = mergeSplitEdges(xa0, xb0, parallelSplitXs);
            for (let k = 0; k < xsLocal.length - 1; k++) {
              const xa = xsLocal[k];
              const xb = xsLocal[k + 1];
              if (xb - xa < WALL_HOLE_EPS) continue;
              const tMid = ((xa + xb) / 2 + halfSpan) / lenWorld;
              const skipCapAtX = [];
              if (k > 0 || t0 > WALL_HOLE_EPS || hasStartExtension || skipWallStartCap) skipCapAtX.push(xa);
              if (k < xsLocal.length - 2 || t1 < 1 - WALL_HOLE_EPS || hasEndExtension || skipWallEndCap) skipCapAtX.push(xb);
              addMiteredWallPiece(group, planPoly, xa, xb, 0, hM, tMid, pieceOptions(xa, xb, skipCapAtX));
            }
            start = i;
          }
        }
        return group.children.length ? group : null;
      }
      const xs = mergeSplitEdges(-halfSpan, halfSpan, holes.flatMap((h) => [h.x0, h.x1]).concat(parallelSplitXs));
      const ys = mergeSplitEdges(0, hM, holes.flatMap((h) => [h.y0, h.y1]));
      if (hasStartExtension) {
        addMiteredWallPiece(group, planPoly, polyMinX, -halfSpan, 0, hM, 0, {
          skipCapAtX: [-halfSpan],
          skipSideEdges: baseSkipSideEdges.slice(),
        });
      }
      if (hasEndExtension) {
        addMiteredWallPiece(group, planPoly, halfSpan, polyMaxX, 0, hM, 1, {
          skipCapAtX: [halfSpan],
          skipSideEdges: baseSkipSideEdges.slice(),
        });
      }
      for (let i = 0; i < xs.length - 1; i++) {
        const xa = xs[i];
        const xb = xs[i + 1];
        if (xb - xa < WALL_HOLE_EPS) continue;
        for (let j = 0; j < ys.length - 1; j++) {
          const ya = ys[j];
          const yb = ys[j + 1];
          if (yb - ya < WALL_HOLE_EPS) continue;
          if (cellFullyInsideAnyHole(xa, xb, ya, yb, holes)) continue;
          const tMid = ((xa + xb) / 2 + halfSpan) / lenWorld;
          const skipCapAtX = [];
          const hasLeftSolidNeighbor = i > 0 && !cellFullyInsideAnyHole(xs[i - 1], xa, ya, yb, holes);
          const hasRightSolidNeighbor = i < xs.length - 2 && !cellFullyInsideAnyHole(xb, xs[i + 2], ya, yb, holes);
          const hasBottomSolidNeighbor = j > 0 && !cellFullyInsideAnyHole(xa, xb, ys[j - 1], ya, holes);
          const hasTopSolidNeighbor = j < ys.length - 2 && !cellFullyInsideAnyHole(xa, xb, yb, ys[j + 2], holes);
          if (hasLeftSolidNeighbor || (hasStartExtension && Math.abs(xa + halfSpan) <= WALL_HOLE_EPS) || (skipWallStartCap && Math.abs(xa + halfSpan) <= WALL_HOLE_EPS)) skipCapAtX.push(xa);
          if (hasRightSolidNeighbor || (hasEndExtension && Math.abs(xb - halfSpan) <= WALL_HOLE_EPS) || (skipWallEndCap && Math.abs(xb - halfSpan) <= WALL_HOLE_EPS)) skipCapAtX.push(xb);
          addMiteredWallPiece(group, planPoly, xa, xb, ya, yb, tMid, {
            ...pieceOptions(xa, xb, skipCapAtX),
            skipBottomFace: hasBottomSolidNeighbor,
            skipTopFace: hasTopSolidNeighbor,
          });
        }
      }
      return group.children.length ? group : null;
    }

    function pushWallSegmentMesh(parent, segLenWorld, tMid, t0, t1, matsOrSingle, faceSuppress = {}) {
      const mxSeg = (x1 + tMid * (x2 - x1) - cx) * (s / 100);
      const mzSeg = (y1 + tMid * (y2 - y1) - cy) * (s / 100);
      const geo = new THREE.BoxGeometry(segLenWorld, hM, thickM);
      remapWallBoxUvToWallSpan(geo, t0, t1, 0, 1);
      suppressWallBoxFaces(geo, faceSuppress);
      const mesh = new THREE.Mesh(geo, matsOrSingle);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.position.set(mxSeg, hM / 2, mzSeg);
      mesh.rotation.y = rotY;
      mesh.userData.floorplanPick = true;
      mesh.userData.floorplanWallFace = true;
      mesh.userData.floorplanWall = true;
      mesh.userData.wallId = wallIdStr;
      mesh.userData.floorplanWallId = wallIdStr;
      mesh.userData.floorplanFloorLevelId = floorIdStr;
      mesh.userData.floorplanSurfaceOpacity = op;
      parent.add(mesh);
    }

    const miteredPlan = buildMiteredWallPlanPolygonLocal();
    if (miteredPlan?.poly && miteredPlan.poly.length >= 3) {
      const built = buildMiteredWallMesh(miteredPlan.poly, miteredPlan.skipSideEdges || []);
      if (built) return built;
    }

    if (!holes.length) {
      const useRoomWalls = style && typeof getMaterialForKey === "function";
      const coreSplitXs = mergeSplitEdges(-lenWorld / 2, lenWorld / 2, parallelSplitXs);
      if (!useRoomWalls) {
        const fullSideSuppress = wallSideSuppressForRange(-lenWorld / 2, lenWorld / 2);
        if (coreSplitXs.length === 2 && !fullSideSuppress.skipFaceA && !fullSideSuppress.skipFaceB) {
          const geo = new THREE.BoxGeometry(lenWorld, hM, thickM);
          remapWallBoxUvToWallSpan(geo, 0, 1, 0, 1);
          suppressWallBoxFaces(geo, { skipStartCap: skipWallStartCap, skipEndCap: skipWallEndCap });
          const mat = makeWallMaterial();
          const mesh = new THREE.Mesh(geo, mat);
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          mesh.position.set(((x1 + x2) / 2 - cx) * (s / 100), hM / 2, ((y1 + y2) / 2 - cy) * (s / 100));
          mesh.rotation.y = rotY;
          mesh.userData.floorplanPick = true;
          mesh.userData.floorplanWallFace = true;
          mesh.userData.floorplanWall = true;
          mesh.userData.wallId = wallIdStr;
          mesh.userData.floorplanWallId = wallIdStr;
          mesh.userData.floorplanFloorLevelId = floorIdStr;
          mesh.userData.floorplanSurfaceOpacity = op;
          return mesh;
        }
        const group = new THREE.Group();
        group.userData.floorplanPick = true;
        const mat = makeWallMaterial();
        for (let i = 0; i < coreSplitXs.length - 1; i++) {
          const xa = coreSplitXs[i];
          const xb = coreSplitXs[i + 1];
          if (xb - xa < WALL_HOLE_EPS) continue;
          const t0 = (xa + lenWorld / 2) / lenWorld;
          const t1 = (xb + lenWorld / 2) / lenWorld;
          const suppress = wallSideSuppressForRange(xa, xb);
          pushWallSegmentMesh(group, xb - xa, (t0 + t1) / 2, t0, t1, mat, {
            skipStartCap: i > 0 || skipWallStartCap,
            skipEndCap: i < coreSplitXs.length - 2 || skipWallEndCap,
            skipFaceA: suppress.skipFaceA,
            skipFaceB: suppress.skipFaceB,
          });
        }
        return group.children.length ? group : null;
      }
      const N = Math.min(256, Math.max(24, Math.ceil(lenCm / 4)));
      const samples = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const { roomPosZ, roomNegZ } = findWallSideRoomsAt(floor, wall, t, 4);
        const rk = `${String(roomPosZ?.id ?? "")}|${String(roomNegZ?.id ?? "")}`;
        samples.push({ t, roomPosZ, roomNegZ, rk });
      }
      const tLeft = (idx) => (idx === 0 ? 0 : (2 * idx - 1) / (2 * N));
      const tRight = (idx) => (idx === N ? 1 : (2 * idx + 1) / (2 * N));
      const intervals = [];
      let start = 0;
      for (let i = 1; i <= N + 1; i++) {
        if (i === N + 1 || (i <= N && samples[i].rk !== samples[start].rk)) {
          const b = i - 1;
          intervals.push({
            t0: tLeft(start),
            t1: tRight(b),
            roomPosZ: samples[start].roomPosZ,
            roomNegZ: samples[start].roomNegZ,
          });
          start = i;
        }
      }
      if (intervals.length === 1) {
        const it = intervals[0];
        const xa0 = -lenWorld / 2 + lenWorld * it.t0;
        const xb0 = -lenWorld / 2 + lenWorld * it.t1;
        const xsLocal = mergeSplitEdges(xa0, xb0, parallelSplitXs);
        if (xsLocal.length === 2) {
          const tMid = (it.t0 + it.t1) / 2;
          const { mats } = wallFaceMaterialsAtT(tMid);
          const geo = new THREE.BoxGeometry(lenWorld * (it.t1 - it.t0), hM, thickM);
          remapWallBoxUvToWallSpan(geo, it.t0, it.t1, 0, 1);
          const suppress = wallSideSuppressForRange(xa0, xb0);
          suppressWallBoxFaces(geo, {
            skipStartCap: skipWallStartCap,
            skipEndCap: skipWallEndCap,
            skipFaceA: suppress.skipFaceA,
            skipFaceB: suppress.skipFaceB,
          });
          const mesh = new THREE.Mesh(geo, mats || makeWallMaterial());
          mesh.castShadow = true;
          mesh.receiveShadow = false;
          const tm = (it.t0 + it.t1) / 2;
          mesh.position.set((x1 + tm * (x2 - x1) - cx) * (s / 100), hM / 2, (y1 + tm * (y2 - y1) - cy) * (s / 100));
          mesh.rotation.y = rotY;
          mesh.userData.floorplanPick = true;
          mesh.userData.floorplanWallFace = true;
          mesh.userData.floorplanWallId = wallIdStr;
          mesh.userData.floorplanFloorLevelId = floorIdStr;
          mesh.userData.floorplanSurfaceOpacity = op;
          return mesh;
        }
      }
      const group = new THREE.Group();
      group.userData.floorplanPick = true;
      const baseMat = makeWallMaterial();
      function matsForInterval(roomPosZ, roomNegZ) {
        function faceMatForRoom(room) {
          if (!room) return baseMat;
          const roomKey = resolveRoomWallMaterialKey(style, room);
          if (!roomKey) return baseMat;
          const mat = getMaterialForKey(roomKey);
          return mat || baseMat;
        }
        return [baseMat, baseMat, baseMat, baseMat, faceMatForRoom(roomPosZ), faceMatForRoom(roomNegZ)];
      }
      for (const it of intervals) {
        const dt = it.t1 - it.t0;
        if (dt < 1e-8) continue;
        const xa0 = -lenWorld / 2 + lenWorld * it.t0;
        const xb0 = -lenWorld / 2 + lenWorld * it.t1;
        const xsLocal = mergeSplitEdges(xa0, xb0, parallelSplitXs);
        for (let i = 0; i < xsLocal.length - 1; i++) {
          const xa = xsLocal[i];
          const xb = xsLocal[i + 1];
          const segLen = xb - xa;
          if (segLen < 0.015) continue;
          const t0 = (xa + lenWorld / 2) / lenWorld;
          const t1 = (xb + lenWorld / 2) / lenWorld;
          const tMid = (t0 + t1) / 2;
          const suppress = wallSideSuppressForRange(xa, xb);
          pushWallSegmentMesh(group, segLen, tMid, t0, t1, matsForInterval(it.roomPosZ, it.roomNegZ), {
            skipStartCap: i > 0 || it.t0 > WALL_HOLE_EPS || skipWallStartCap,
            skipEndCap: i < xsLocal.length - 2 || it.t1 < 1 - WALL_HOLE_EPS || skipWallEndCap,
            skipFaceA: suppress.skipFaceA,
            skipFaceB: suppress.skipFaceB,
          });
        }
      }
      return group.children.length ? group : null;
    }

    const halfSpan = lenWorld / 2;
    const xs = mergeSplitEdges(-halfSpan, halfSpan, holes.flatMap((h) => [h.x0, h.x1]).concat(parallelSplitXs));
    const ys = mergeSplitEdges(0, hM, holes.flatMap((h) => [h.y0, h.y1]));
    const group = new THREE.Group();
    group.position.set(((x1 + x2) / 2 - cx) * (s / 100), 0, ((y1 + y2) / 2 - cy) * (s / 100));
    group.rotation.y = rotY;
    group.userData.floorplanPick = true;

    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i];
      const xb = xs[i + 1];
      if (xb - xa < WALL_HOLE_EPS) continue;
      for (let j = 0; j < ys.length - 1; j++) {
        const ya = ys[j];
        const yb = ys[j + 1];
        if (yb - ya < WALL_HOLE_EPS) continue;
        if (cellFullyInsideAnyHole(xa, xb, ya, yb, holes)) continue;
        const cxLocal = (xa + xb) / 2;
        const cyLocal = (ya + yb) / 2;
        const gw = xb - xa;
        const gh = yb - ya;
        const geo = new THREE.BoxGeometry(gw, gh, thickM);
        const u0 = (xa + halfSpan) / lenWorld;
        const u1 = (xb + halfSpan) / lenWorld;
        const v0 = ya / hM;
        const v1 = yb / hM;
        remapWallBoxUvToWallSpan(geo, u0, u1, v0, v1);
        const hasLeftSolidNeighbor = i > 0 && !cellFullyInsideAnyHole(xs[i - 1], xa, ya, yb, holes);
        const hasRightSolidNeighbor = i < xs.length - 2 && !cellFullyInsideAnyHole(xb, xs[i + 2], ya, yb, holes);
        const hasBottomSolidNeighbor = j > 0 && !cellFullyInsideAnyHole(xa, xb, ys[j - 1], ya, holes);
        const hasTopSolidNeighbor = j < ys.length - 2 && !cellFullyInsideAnyHole(xa, xb, yb, ys[j + 2], holes);
        const suppress = wallSideSuppressForRange(xa, xb);
        suppressWallBoxFaces(geo, {
          skipStartCap: hasLeftSolidNeighbor || (skipWallStartCap && Math.abs(xa + halfSpan) <= WALL_HOLE_EPS),
          skipEndCap: hasRightSolidNeighbor || (skipWallEndCap && Math.abs(xb - halfSpan) <= WALL_HOLE_EPS),
          skipBottomCap: hasBottomSolidNeighbor,
          skipTopCap: hasTopSolidNeighbor,
          skipFaceA: suppress.skipFaceA,
          skipFaceB: suppress.skipFaceB,
        });
        const tAlong = (cxLocal + halfSpan) / lenWorld;
        const { mats } = wallFaceMaterialsAtT(tAlong);
        const mat = mats || makeWallMaterial();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.position.set(cxLocal, cyLocal, 0);
        mesh.userData.floorplanPick = true;
        mesh.userData.floorplanWallFace = true;
        mesh.userData.floorplanWallId = wallIdStr;
        mesh.userData.floorplanFloorLevelId = floorIdStr;
        mesh.userData.floorplanSurfaceOpacity = op;
        group.add(mesh);
      }
    }
    return group.children.length ? group : null;
  }

  return { buildWallMesh };
}
