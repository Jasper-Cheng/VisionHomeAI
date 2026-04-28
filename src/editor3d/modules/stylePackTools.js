import {
  clearStyleConfigCache,
  getDefaultStyleKeyForFloorplan,
  loadStyleConfig,
  loadStylePackIndex,
  resolveDefaultStyleKeyFromPack,
  resolveMaterialDefFromLibrary,
} from "../../floorplan/floorplanStyle.js";
import { DATA_PATHS } from "../../core/schema.js";

export function createStylePackTools(ctx) {
  const {
    ambientLight,
    clearFloorplanSurfaceSelection,
    clearSurfaceOverridesForStyle,
    fastStyleSwitch,
    getCurrentFloorplanId,
    getCurrentSurfaceOverridesBucket,
    getEffectiveFloorplanStyleKey,
    getFloorplanMaterialsLibraryBag,
    getFloorsFromEntry,
    getLastMergedFloorplanStyle,
    getLayout,
    getSceneLightingEnvMapIntensity,
    hemiLight,
    loadStylePackIndexFromMain,
    mergeLayoutWithStyleDecorations,
    mergeMaterialOverrideIntoDef,
    modelIdIsDecoration,
    normalizeFloorKey,
    normalizeStyleKeyForSurfaceOverrides,
    propertiesPanel,
    pushHistorySnapshot,
    rebuildFloorplan3D,
    schedulePushHistory,
    selectFurniture,
    serializeDesignBaseline,
    serializeDesignForSave,
    setFloorplanSelected,
    state,
    surfaceOverrideIsActive,
    windowSurfaceOverrideForApply,
    renderer,
    dirLight,
  } = ctx;

  function threeColorToHexForStylePack(c) {
    if (!c?.getHexString) return "#ffffff";
    return `#${c.getHexString()}`;
  }

  function getSceneLightingForStylePack() {
    return {
      toneMappingExposure: renderer.toneMappingExposure,
      ambient: {
        color: threeColorToHexForStylePack(ambientLight.color),
        intensity: ambientLight.intensity,
      },
      hemisphere: {
        sky: threeColorToHexForStylePack(hemiLight.color),
        ground: threeColorToHexForStylePack(hemiLight.groundColor),
        intensity: hemiLight.intensity,
      },
      directional: {
        color: threeColorToHexForStylePack(dirLight.color),
        intensity: dirLight.intensity,
      },
      envMapIntensity: getSceneLightingEnvMapIntensity(),
    };
  }

  function stripLibraryMetaFromMaterials(materials) {
    if (!materials || typeof materials !== "object") return {};
    const out = JSON.parse(JSON.stringify(materials));
    for (const k of Object.keys(out)) {
      const m = out[k];
      if (m && typeof m === "object" && !Array.isArray(m)) delete m.__libraryMaterialId;
    }
    return out;
  }

  function slugStyleKeyFromName(name) {
    let s = String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_-]/g, "");
    if (!s) s = `style_${Date.now()}`;
    if (!/^[a-z_]/.test(s)) s = `s_${s}`;
    return s.slice(0, 48);
  }

  function ensureUniqueStyleKeyInPack(base, stylesObj) {
    if (!stylesObj || typeof stylesObj !== "object") return base;
    let k = base;
    let n = 0;
    while (stylesObj[k]) {
      n += 1;
      k = `${base}_${n}`;
    }
    return k;
  }

  function buildStyleBlockFromSceneForPack(styleKey, displayName, styleObj) {
    const materials = stripLibraryMetaFromMaterials(styleObj?.materials);
    const layout = getLayout();
    const placements = [];
    for (const row of layout) {
      if (!modelIdIsDecoration(row.model)) continue;
      const p = {
        model: row.model,
        x: row.x,
        y: row.y,
        rotation: row.rotation ?? 0,
      };
      if (row.floorId) p.floorId = row.floorId;
      if (row.decorationLiftCm != null) p.decorationLiftCm = row.decorationLiftCm;
      placements.push(p);
    }

    const roomFloorMaterials = {};
    const roomFloorBucket = state.roomFloorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(styleKey)];
    if (roomFloorBucket && typeof roomFloorBucket === "object") {
      for (const [floorId, rooms] of Object.entries(roomFloorBucket)) {
        if (!rooms || typeof rooms !== "object") continue;
        for (const [roomId, override] of Object.entries(rooms)) {
          if (!override || typeof override !== "object" || !Object.keys(override).length) continue;
          if (!roomFloorMaterials[floorId]) roomFloorMaterials[floorId] = {};
          roomFloorMaterials[floorId][roomId] = JSON.parse(JSON.stringify(override));
        }
      }
    }

    const doorOverridesData = {};
    const doorBucket = state.doorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(styleKey)];
    if (doorBucket && typeof doorBucket === "object") {
      for (const [floorId, doors] of Object.entries(doorBucket)) {
        if (!doors || typeof doors !== "object") continue;
        for (const [doorId, override] of Object.entries(doors)) {
          if (!override || typeof override !== "object" || !Object.keys(override).length) continue;
          if (!doorOverridesData[floorId]) doorOverridesData[floorId] = {};
          doorOverridesData[floorId][doorId] = JSON.parse(JSON.stringify(override));
        }
      }
    }

    const windowOverridesData = {};
    const windowBucket = state.windowOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(styleKey)];
    if (windowBucket && typeof windowBucket === "object") {
      for (const [floorId, windows] of Object.entries(windowBucket)) {
        if (!windows || typeof windows !== "object") continue;
        for (const [windowId, override] of Object.entries(windows)) {
          if (!override || typeof override !== "object" || !Object.keys(override).length) continue;
          if (!windowOverridesData[floorId]) windowOverridesData[floorId] = {};
          windowOverridesData[floorId][windowId] = JSON.parse(JSON.stringify(override));
        }
      }
    }

    const block = {
      id: styleKey,
      name: displayName,
      sceneLighting: getSceneLightingForStylePack(),
      materials,
      decorations: { placements },
    };
    if (Object.keys(roomFloorMaterials).length) block.roomFloorMaterials = roomFloorMaterials;
    if (Object.keys(doorOverridesData).length) block.doorOverrides = doorOverridesData;
    if (Object.keys(windowOverridesData).length) block.windowOverrides = windowOverridesData;
    return block;
  }

  function bakeSurfaceOverridesIntoStyle(styleObj, overridesBucket, entry, libraryBag) {
    if (!styleObj || typeof styleObj !== "object") return styleObj;
    if (!overridesBucket || typeof overridesBucket !== "object") return styleObj;
    if (!entry || typeof entry !== "object") return styleObj;
    const floors = getFloorsFromEntry(entry);
    if (!floors.length) return styleObj;

    let next;
    try {
      next = JSON.parse(JSON.stringify(styleObj));
    } catch {
      next = { ...styleObj };
    }

    if (!next.materials || typeof next.materials !== "object" || Array.isArray(next.materials)) {
      next.materials = {};
    }

    function bakeOneMaterialOverride(materialKey, ovRaw, scope) {
      if (!surfaceOverrideIsActive(ovRaw)) return;
      const ov = scope === "allWindows" ? windowSurfaceOverrideForApply(ovRaw) : ovRaw;
      if (!ov || !surfaceOverrideIsActive(ov)) return;

      let baseDef = null;
      if (ov.materialId) {
        baseDef = resolveMaterialDefFromLibrary(libraryBag, ov.materialId);
      } else {
        const def = next.materials[materialKey];
        if (def) {
          try {
            baseDef = JSON.parse(JSON.stringify(def));
          } catch {
            baseDef = { ...def };
          }
        }
      }
      if (!baseDef) return;

      const mergedDef = mergeMaterialOverrideIntoDef(baseDef, ov);
      next.materials[materialKey] = mergedDef;
    }

    for (const [fidRaw, bag] of Object.entries(overridesBucket)) {
      if (!bag || typeof bag !== "object") continue;
      const fid = String(fidRaw ?? "").trim();
      if (!fid) continue;
      const want = normalizeFloorKey(fid);
      const fl = floors.find((f) => normalizeFloorKey(f?.id ?? "") === want) ?? null;
      if (!fl) continue;

      if (bag.allFloors) {
        for (const room of fl.rooms || []) {
          const rid = String(room?.id ?? "").trim();
          if (!rid) continue;
          bakeOneMaterialOverride(rid, bag.allFloors, "allFloors");
        }
      }

      if (bag.allWalls) {
        for (const w of fl.walls || []) {
          const wid = String(w?.id ?? "").trim();
          if (!wid) continue;
          bakeOneMaterialOverride(wid, bag.allWalls, "allWalls");
        }
        for (const room of fl.rooms || []) {
          const rid = String(room?.id ?? "").trim();
          if (!rid) continue;
          bakeOneMaterialOverride(`${rid}_wall`, bag.allWalls, "allWalls");
        }
      }

      if (bag.allDoors) {
        for (const d of fl.doors || []) {
          const did = String(d?.id ?? "").trim();
          if (!did) continue;
          bakeOneMaterialOverride(did, bag.allDoors, "allDoors");
        }
      }

      if (bag.allWindows) {
        for (const win of fl.windows || []) {
          const wid = String(win?.id ?? "").trim();
          if (!wid) continue;
          bakeOneMaterialOverride(wid, bag.allWindows, "allWindows");
        }
      }
    }

    const wallFaceData = overridesBucket.__wallFaceOverrides;
    if (wallFaceData && typeof wallFaceData === "object") {
      for (const wallsData of Object.values(wallFaceData)) {
        if (!wallsData || typeof wallsData !== "object") continue;
        for (const [wallId, faces] of Object.entries(wallsData)) {
          if (!faces || typeof faces !== "object") continue;
          const wid = String(wallId ?? "").trim();
          if (!wid) continue;
          if (faces.face_a && surfaceOverrideIsActive(faces.face_a)) {
            bakeOneMaterialOverride(`${wid}__face_a`, faces.face_a, "allWalls");
          }
          if (faces.face_b && surfaceOverrideIsActive(faces.face_b)) {
            bakeOneMaterialOverride(`${wid}__face_b`, faces.face_b, "allWalls");
          }
        }
      }
    }

    return next;
  }

  async function fetchRawFloorplanStylePack(fpId) {
    const url = `./${DATA_PATHS.stylesDir}/${fpId}.json`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`无法读取风格包 (${res.status})`);
    return res.json();
  }

  function cloneStylePackDeep(pack) {
    try {
      return JSON.parse(JSON.stringify(pack));
    } catch {
      return pack;
    }
  }

  function normalizeStylePackRootForDisk(fpId, pack) {
    if (!pack || typeof pack !== "object") return;
    pack.floorplanId = fpId;
    if (!pack.styles || typeof pack.styles !== "object") pack.styles = {};
  }

  async function postFloorplanStylePackSave(fpId, pack) {
    normalizeStylePackRootForDisk(fpId, pack);
    const res = await fetch(DATA_PATHS.floorplanStyleSaveApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ floorplanId: fpId, pack }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(t || `保存失败 (${res.status})，请使用 python3 dev_server.py 启动本地服务`);
    }
    return res.json();
  }

  function initStylePackSaveDialogs() {
    const overwriteBtn = document.getElementById("layoutStyleOverwriteBtn");
    const newBtn = document.getElementById("layoutStyleNewBtn");
    const dlgOver = document.getElementById("styleOverwriteDialog");
    const dlgNew = document.getElementById("styleNewDialog");
    const msgOver = document.getElementById("styleOverwriteMessage");
    const inpName = document.getElementById("styleNewNameInput");
    const errNew = document.getElementById("styleNewNameError");

    function syncOverwriteBtnLockState() {
      if (!overwriteBtn) return;
      const fpId = getCurrentFloorplanId();
      const cur = getEffectiveFloorplanStyleKey();
      const def = fpId ? getDefaultStyleKeyForFloorplan(fpId) : "";
      const locked = !!(fpId && cur && def && cur === def);
      overwriteBtn.disabled = locked;
      overwriteBtn.title = locked ? "默认风格不可覆盖" : "覆盖当前风格";
      overwriteBtn.setAttribute("aria-label", overwriteBtn.title);
    }

    async function resolveStyleDisplayName(fpId, sk) {
      try {
        const idx = await loadStylePackIndexFromMain(fpId);
        const hit = idx.styles.find((s) => s.key === sk);
        if (hit?.name) return String(hit.name).trim();
      } catch {
        /* ignore */
      }
      return sk;
    }

    overwriteBtn?.addEventListener("click", async () => {
      const fpId = getCurrentFloorplanId();
      if (!fpId || !state.currentFloorplanEntry) {
        alert("请先加载户型。");
        return;
      }
      if (!getLastMergedFloorplanStyle()) {
        alert("当前风格包未成功加载，无法覆盖。");
        return;
      }
      const sk = getEffectiveFloorplanStyleKey();
      try {
        const pack = await fetchRawFloorplanStylePack(fpId);
        const defKey = resolveDefaultStyleKeyFromPack(pack);
        if (defKey && sk === defKey) {
          alert("默认风格不可覆盖。请新建风格后再保存。");
          syncOverwriteBtnLockState();
          return;
        }
      } catch {
        /* ignore */
      }
      const name = await resolveStyleDisplayName(fpId, sk);
      if (msgOver) msgOver.textContent = `将用当前场景的光照、材质与装饰覆盖风格「${name}」（${sk}）。确定吗？`;
      dlgOver?.showModal();
    });

    document.getElementById("styleOverwriteCancel")?.addEventListener("click", () => dlgOver?.close());
    document.getElementById("styleOverwriteConfirm")?.addEventListener("click", async () => {
      dlgOver?.close();
      const fpId = getCurrentFloorplanId();
      const sk = getEffectiveFloorplanStyleKey();
      const lastMergedFloorplanStyle = getLastMergedFloorplanStyle();
      if (!fpId || !lastMergedFloorplanStyle) return;
      try {
        const pack = cloneStylePackDeep(await fetchRawFloorplanStylePack(fpId));
        const defKey = resolveDefaultStyleKeyFromPack(pack);
        if (defKey && sk === defKey) {
          alert("默认风格不可覆盖。请使用“新建”创建一个新风格后再保存。");
          syncOverwriteBtnLockState();
          return;
        }
        const displayName = await resolveStyleDisplayName(fpId, sk);
        const surfaceOverridesBucket = ctx.getSurfaceOverridesBucketForStyle(sk, { create: false });
        const skKey = normalizeStyleKeyForSurfaceOverrides(sk);
        const wallFaceData = state.wallFaceOverridesByStyleKey[skKey];
        const bucketWithWallFace = {
          ...surfaceOverridesBucket,
          ...(wallFaceData && Object.keys(wallFaceData).length ? { __wallFaceOverrides: wallFaceData } : {}),
        };
        const libraryBag = await getFloorplanMaterialsLibraryBag();
        const bakedStyle = bakeSurfaceOverridesIntoStyle(
          lastMergedFloorplanStyle,
          bucketWithWallFace,
          state.currentFloorplanEntry,
          libraryBag,
        );
        const block = buildStyleBlockFromSceneForPack(sk, displayName, bakedStyle);
        if (!pack.styles || typeof pack.styles !== "object") pack.styles = {};
        pack.styles[sk] = block;
        await postFloorplanStylePackSave(fpId, pack);

        clearSurfaceOverridesForStyle(sk);
        clearStyleConfigCache();
        await loadStylePackIndexFromMain(fpId);
        await rebuildFloorplan3D();
        window.dispatchEvent(new CustomEvent("visionhome:floorplan-applied-to-layout"));
        schedulePushHistory();
        syncOverwriteBtnLockState();
        window.__designLayoutBaseline = serializeDesignBaseline();
        window.__designSaveBaseline = serializeDesignForSave();
      } catch (e) {
        console.error(e);
        alert(e?.message || String(e));
      }
    });

    newBtn?.addEventListener("click", () => {
      const fpId = getCurrentFloorplanId();
      if (!fpId || !state.currentFloorplanEntry) {
        alert("请先加载户型。");
        return;
      }
      if (!getLastMergedFloorplanStyle()) {
        alert("当前风格包未成功加载，无法新建。");
        return;
      }
      if (inpName) inpName.value = "";
      if (errNew) {
        errNew.hidden = true;
        errNew.textContent = "";
      }
      dlgNew?.showModal();
      inpName?.focus();
    });

    document.getElementById("styleNewCancel")?.addEventListener("click", () => dlgNew?.close());
    document.getElementById("styleNewConfirm")?.addEventListener("click", async () => {
      const raw = String(inpName?.value ?? "").trim();
      if (!raw) {
        if (errNew) {
          errNew.textContent = "请输入风格名称";
          errNew.hidden = false;
        }
        return;
      }
      if (errNew) errNew.hidden = true;
      dlgNew?.close();
      const fpId = getCurrentFloorplanId();
      const lastMergedFloorplanStyle = getLastMergedFloorplanStyle();
      if (!fpId || !lastMergedFloorplanStyle) return;
      try {
        const sourceStyleKey = getEffectiveFloorplanStyleKey();
        const pack = cloneStylePackDeep(await fetchRawFloorplanStylePack(fpId));
        const styles = pack.styles && typeof pack.styles === "object" ? pack.styles : {};
        const base = slugStyleKeyFromName(raw);
        const newKey = ensureUniqueStyleKeyInPack(base, styles);
        const defKey = resolveDefaultStyleKeyFromPack(pack) || getDefaultStyleKeyForFloorplan(fpId) || "default";

        const sourceRoomFloorBucket = state.roomFloorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(sourceStyleKey)];
        if (sourceRoomFloorBucket && typeof sourceRoomFloorBucket === "object") {
          state.roomFloorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(newKey)] =
            JSON.parse(JSON.stringify(sourceRoomFloorBucket));
        }

        const sourceDoorBucket = state.doorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(sourceStyleKey)];
        if (sourceDoorBucket && typeof sourceDoorBucket === "object") {
          state.doorOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(newKey)] =
            JSON.parse(JSON.stringify(sourceDoorBucket));
        }

        const sourceWindowBucket = state.windowOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(sourceStyleKey)];
        if (sourceWindowBucket && typeof sourceWindowBucket === "object") {
          state.windowOverridesByStyleKey[normalizeStyleKeyForSurfaceOverrides(newKey)] =
            JSON.parse(JSON.stringify(sourceWindowBucket));
        }

        await loadStyleConfig(fpId, defKey);
        const surfaceOverridesBucket = getCurrentSurfaceOverridesBucket();
        const curSkKey = normalizeStyleKeyForSurfaceOverrides(getEffectiveFloorplanStyleKey());
        const wallFaceDataNew = state.wallFaceOverridesByStyleKey[curSkKey];
        const bucketWithWallFaceNew = {
          ...surfaceOverridesBucket,
          ...(wallFaceDataNew && Object.keys(wallFaceDataNew).length ? { __wallFaceOverrides: wallFaceDataNew } : {}),
        };
        const libraryBag = await getFloorplanMaterialsLibraryBag();
        const bakedStyle = bakeSurfaceOverridesIntoStyle(
          lastMergedFloorplanStyle,
          bucketWithWallFaceNew,
          state.currentFloorplanEntry,
          libraryBag,
        );
        styles[newKey] = buildStyleBlockFromSceneForPack(newKey, raw, bakedStyle);
        pack.styles = styles;
        await postFloorplanStylePackSave(fpId, pack);

        clearSurfaceOverridesForStyle(sourceStyleKey);
        clearSurfaceOverridesForStyle(newKey);

        state.floorplanStyleKeyOverride = newKey;
        clearStyleConfigCache();
        await loadStylePackIndexFromMain(fpId);
        await rebuildFloorplan3D();
        window.dispatchEvent(new CustomEvent("visionhome:floorplan-applied-to-layout"));
        schedulePushHistory();
        syncOverwriteBtnLockState();
        window.__designLayoutBaseline = serializeDesignBaseline();
        window.__designSaveBaseline = serializeDesignForSave();
      } catch (e) {
        console.error(e);
        alert(e?.message || String(e));
      }
    });

    window.addEventListener("visionhome:floorplan-applied-to-layout", () => syncOverwriteBtnLockState());
    syncOverwriteBtnLockState();
  }

  function initFloorplanStyleToolbar() {
    const btn = document.getElementById("layoutStyleRecommendBtn");
    const dropdown = document.getElementById("layoutStyleDropdown");
    if (!btn || !dropdown) return;

    let styleDropdownRefreshGen = 0;

    function openDropdown() {
      dropdown.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      btn.classList.add("is-active");
    }
    function closeDropdown() {
      dropdown.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("is-active");
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.hidden ? openDropdown() : closeDropdown();
    });
    document.addEventListener("click", (e) => {
      if (!dropdown.hidden && !dropdown.contains(e.target) && e.target !== btn) closeDropdown();
    });

    const STYLE_BTN_DEFAULT = "风格";

    function setStyleToolbarButtonLabel(list) {
      const cur = getEffectiveFloorplanStyleKey();
      if (!list || !list.length) {
        btn.textContent = STYLE_BTN_DEFAULT;
        btn.title = "装饰风格";
        btn.setAttribute("aria-label", "装饰风格");
        return;
      }
      const hit = list.find((s) => s.key === cur);
      const label = hit?.name ? String(hit.name).trim() : cur || STYLE_BTN_DEFAULT;
      btn.textContent = label || STYLE_BTN_DEFAULT;
      const tip = `装饰风格：${btn.textContent}`;
      btn.title = tip;
      btn.setAttribute("aria-label", tip);
    }

    async function refreshStyleDropdown() {
      const gen = ++styleDropdownRefreshGen;
      dropdown.replaceChildren();
      const fpId = getCurrentFloorplanId();
      if (!fpId) {
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "layout-style-dropdown-hint";
        hint.textContent = "请先加载户型";
        dropdown.appendChild(hint);
        return;
      }
      let list;
      try {
        const idx = await loadStylePackIndexFromMain(fpId);
        if (gen !== styleDropdownRefreshGen) return;
        list = idx.styles;
      } catch (err) {
        console.warn("[VisionHome] 风格列表加载失败:", err);
        if (gen !== styleDropdownRefreshGen) return;
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "layout-style-dropdown-hint";
        hint.textContent = "风格列表加载失败";
        dropdown.appendChild(hint);
        return;
      }
      if (!list.length) {
        if (gen !== styleDropdownRefreshGen) return;
        setStyleToolbarButtonLabel(null);
        const hint = document.createElement("div");
        hint.className = "layout-style-dropdown-hint";
        hint.textContent = "暂无装饰风格";
        dropdown.appendChild(hint);
        return;
      }
      const seenKeys = new Set();
      const deduped = [];
      for (const s of list) {
        const k = String(s?.key ?? "").trim();
        if (!k || seenKeys.has(k)) continue;
        seenKeys.add(k);
        deduped.push(s);
      }
      if (gen !== styleDropdownRefreshGen) return;
      const cur = getEffectiveFloorplanStyleKey();
      for (const s of deduped) {
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "layout-style-tag";
        tag.setAttribute("role", "menuitem");
        tag.dataset.styleKey = s.key;
        tag.textContent = s.name;
        if (s.key === cur) tag.classList.add("is-active");
        dropdown.appendChild(tag);
      }
      setStyleToolbarButtonLabel(deduped);
    }

    function hasUnsavedChanges() {
      const cur = serializeDesignBaseline();
      const baseline = window.__designLayoutBaseline;
      return baseline !== undefined && cur !== baseline;
    }

    async function executeStyleSwitch(key, tag) {
      state.floorplanStyleKeyOverride = key;
      state.floorplanSurfaceOverridesByStyleKey = {};
      state.roomFloorOverridesByStyleKey = {};
      state.doorOverridesByStyleKey = {};
      state.windowOverridesByStyleKey = {};
      state.wallFaceOverridesByStyleKey = {};

      clearFloorplanSurfaceSelection();
      selectFurniture(null);
      setFloorplanSelected(false);
      propertiesPanel?.classList.remove("is-visible");

      clearStyleConfigCache();

      dropdown.querySelectorAll(".layout-style-tag").forEach((t) => {
        if (String(t.dataset.styleKey ?? "").trim() === key) {
          t.classList.add("is-active");
        } else {
          t.classList.remove("is-active");
        }
      });

      const picked = String(tag?.textContent ?? "").trim();
      if (picked) {
        btn.textContent = picked;
        const tip = `装饰风格：${picked}`;
        btn.title = tip;
        btn.setAttribute("aria-label", tip);
      } else {
        const targetTag = dropdown.querySelector(`.layout-style-tag[data-style-key="${key}"]`);
        if (targetTag) {
          const name = String(targetTag.textContent ?? "").trim();
          if (name) {
            btn.textContent = name;
            const tip = `装饰风格：${name}`;
            btn.title = tip;
            btn.setAttribute("aria-label", tip);
          }
        }
      }

      const fastSwitchSuccess = await fastStyleSwitch(key);
      if (fastSwitchSuccess) {
        setTimeout(async () => {
          const lastMergedFloorplanStyle = getLastMergedFloorplanStyle();
          if (state.floorplanStyleKeyOverride === key && lastMergedFloorplanStyle) {
            await mergeLayoutWithStyleDecorations(lastMergedFloorplanStyle);
          }
        }, 100);
      } else {
        await rebuildFloorplan3D({ applyDecorFromStyle: true });
      }

      pushHistorySnapshot();
      window.__designLayoutBaseline = serializeDesignBaseline();
      window.__designSaveBaseline = serializeDesignForSave();
    }

    dropdown.addEventListener("click", (e) => {
      const tag = e.target.closest(".layout-style-tag");
      if (!tag) return;
      const key = String(tag.dataset.styleKey ?? "").trim();
      if (!key || !state.currentFloorplanEntry) return;
      const prevKey = getEffectiveFloorplanStyleKey();
      if (key === prevKey) {
        closeDropdown();
        return;
      }
      if (hasUnsavedChanges()) {
        const switchStyleDialog = document.getElementById("switchStyleUnsavedDialog");
        if (switchStyleDialog) {
          window.__pendingStyleSwitch = { key, tag };
          if (typeof switchStyleDialog.showModal === "function") {
            switchStyleDialog.showModal();
          } else {
            switchStyleDialog.setAttribute("open", "");
          }
          closeDropdown();
          return;
        }
      }
      void executeStyleSwitch(key, tag);
      closeDropdown();
    });

    window.addEventListener("visionhome:floorplan-applied-to-layout", () => {
      void refreshStyleDropdown();
    });
    void refreshStyleDropdown();

    const switchStyleDialog = document.getElementById("switchStyleUnsavedDialog");
    const switchStyleCancelBtn = document.getElementById("switchStyleUnsavedCancel");
    const switchStyleDiscardBtn = document.getElementById("switchStyleUnsavedDiscard");
    const switchStyleSaveBtn = document.getElementById("switchStyleUnsavedSave");

    function closeSwitchStyleDialog() {
      if (switchStyleDialog && typeof switchStyleDialog.close === "function") {
        switchStyleDialog.close();
      } else if (switchStyleDialog) {
        switchStyleDialog.removeAttribute("open");
      }
    }

    switchStyleCancelBtn?.addEventListener("click", () => {
      window.__pendingStyleSwitch = null;
      closeSwitchStyleDialog();
    });

    switchStyleDialog?.addEventListener("cancel", () => {
      window.__pendingStyleSwitch = null;
    });

    switchStyleDiscardBtn?.addEventListener("click", () => {
      const pending = window.__pendingStyleSwitch;
      window.__pendingStyleSwitch = null;
      closeSwitchStyleDialog();
      if (pending) {
        void executeStyleSwitch(pending.key, pending.tag);
      }
    });

    switchStyleSaveBtn?.addEventListener("click", async () => {
      const pending = window.__pendingStyleSwitch;
      if (!pending) return;
      closeSwitchStyleDialog();

      const hasResolvedName = Boolean(String(window.__activeDesignProject?.name ?? "").trim());
      if (hasResolvedName) {
        const executeSave = window.executeSaveWithName;
        if (typeof executeSave === "function") {
          await executeSave(String(window.__activeDesignProject?.name ?? "").trim());
        }
        await executeStyleSwitch(pending.key, pending.tag);
        window.__pendingStyleSwitch = null;
      } else {
        const handleSaveComplete = async () => {
          window.removeEventListener("visionhome:design-saved", handleSaveComplete);
          if (window.__pendingStyleSwitch) {
            const p = window.__pendingStyleSwitch;
            window.__pendingStyleSwitch = null;
            await executeStyleSwitch(p.key, p.tag);
          }
        };

        const handleSaveCancel = () => {
          window.removeEventListener("visionhome:design-saved", handleSaveComplete);
          window.removeEventListener("visionhome:save-design-cancelled", handleSaveCancel);
          window.__pendingStyleSwitch = null;
        };

        window.addEventListener("visionhome:design-saved", handleSaveComplete, { once: true });
        window.addEventListener("visionhome:save-design-cancelled", handleSaveCancel, { once: true });
        window.dispatchEvent(new CustomEvent("visionhome:open-save-design"));
      }
    });
  }

  return {
    initFloorplanStyleToolbar,
    initStylePackSaveDialogs,
  };
}
