/**
 * 设计文件（方案）：在户型模板（templateId → assets/floorplans）基础上的家具编辑会话 JSON。
 * 侧栏仅罗列 manifest；打开/应用方案时应合并模板几何与本文件的 furnitureInstances 等。
 */
import { DATA_PATHS } from "../core/schema.js";

let designFileSearchBound = false;

function bindDesignFileSearch() {
  if (designFileSearchBound) return;
  const input = document.getElementById("designFileSearchInput");
  if (!input) return;
  designFileSearchBound = true;

  function applyDesignFileFilter() {
    const root = document.getElementById("designFileList");
    if (!root) return;
    const q = (input.value || "").trim().toLowerCase();
    root.querySelectorAll(".file-item").forEach((item) => {
      const haystack = [item.dataset.name, item.dataset.file, item.dataset.designId].filter(Boolean).join(" ").toLowerCase();
      item.classList.toggle("is-hidden", Boolean(q && !haystack.includes(q)));
    });
  }

  input.addEventListener("input", applyDesignFileFilter);
  /* type=search：点清除按钮时部分浏览器只触发 search */
  input.addEventListener("search", applyDesignFileFilter);
}

/**
 * 拉取 assets/design/manifest.json，得到要加载的 JSON 文件名列表
 * @returns {Promise<string[]>}
 */
export async function fetchDesignFileNames() {
  const url = DATA_PATHS.designManifest;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`design manifest fetch failed: ${url}`);
  const data = await res.json();
  const files = data?.files;
  if (!Array.isArray(files)) return [];
  return files.map((f) => String(f).trim()).filter(Boolean);
}

/**
 * @param {string} filename 须为 <id>.json，与 JSON 内 id 字段一致
 */
export async function fetchDesignProjectJson(filename) {
  const clean = filename.replace(/^\/+/, "");
  const url = `${DATA_PATHS.design}/${clean}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`design project fetch failed: ${url}`);
  return res.json();
}

/**
 * 按 manifest 并行加载全部设计 JSON
 * @returns {Promise<{ file: string, project: object }[]>}
 */
export async function loadDesignProjectsFromManifest() {
  const names = await fetchDesignFileNames();
  const results = await Promise.allSettled(names.map((file) => fetchDesignProjectJson(file).then((project) => ({ file, project }))));
  /** @type {{ file: string, project: object }[]} */
  const ok = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") ok.push(r.value);
    else console.warn("[VisionHomeAI] 设计文件跳过:", names[i], r.reason);
  });
  return ok;
}

/**
 * 重新拉取 manifest 与方案并刷新「设计文件」侧栏（保存成功后调用）
 */
export async function refreshDesignProjectsFromManifest() {
  try {
    const entries = await loadDesignProjectsFromManifest();
    window.__designProjects = entries;
    mountDesignFileList(entries, { loadError: false });
  } catch (err) {
    console.error(err);
    mountDesignFileList([], { loadError: true });
  }
}

/**
 * @param {string} filename
 * @param {object} project
 * @returns {Promise<{ ok: true, file: string } | { ok: false, reason: string }>}
 */
async function postSaveDesignToDataDir(filename, project) {
  try {
    const res = await fetch(DATA_PATHS.designSaveApi, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename, project }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* 404 HTML 等 */
    }
    if (!res.ok) {
      const msg = (data && typeof data === "object" && data.error) || res.statusText || String(res.status);
      return { ok: false, reason: msg };
    }
    if (!data || data.ok !== true) {
      return { ok: false, reason: "响应无效" };
    }
    const file = typeof data.file === "string" && data.file.trim() ? data.file.trim() : filename;
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

function triggerDownloadDesignJson(filename, jsonText) {
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * 列表右侧时间：优先 updatedAt → createdAt → 文件名 project_<ms>
 * @param {object | null | undefined} project
 * @param {string} stem 无 .json 的文件名
 */
function formatDesignFileListTime(project, stem) {
  /** @type {Date | null} */
  let d = null;
  const iso = project?.updatedAt || project?.createdAt;
  if (iso != null && String(iso).trim()) {
    const t = new Date(iso);
    if (!Number.isNaN(t.getTime())) d = t;
  }
  if (!d) {
    const m = String(stem).match(/(\d{13})/);
    if (m) {
      const t = new Date(Number(m[1]));
      if (!Number.isNaN(t.getTime())) d = t;
    }
  }
  if (!d) return "";
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * 渲染「文件」侧栏：assets/design 下的方案 JSON
 * @param {{ file: string, project: object }[]} entries
 * @param {{ loadError?: boolean }} options
 */
export function mountDesignFileList(entries, options = {}) {
  const list = document.getElementById("designFileList");
  if (!list) return;

  list.replaceChildren();

  if (options.loadError) {
    const p = document.createElement("p");
    p.className = "panel-empty";
    p.textContent = "设计清单加载失败，请检查 assets/design/manifest.json。";
    list.appendChild(p);
  } else if (!entries.length) {
    const p = document.createElement("p");
    p.className = "panel-empty";
    p.textContent = "暂无设计文件。请在 assets/design/manifest.json 的 files 中加入 JSON 文件名。";
    list.appendChild(p);
  } else {
    const docSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>`;

    for (const { file, project } of entries) {
      const stem = file.replace(/\.json$/i, "").trim();
      const did = String(project?.id ?? project?.projectId ?? stem).trim();
      /** 侧栏仅展示 name；搜索仍可按 id / 文件名 / 模板匹配 */
      const displayName = String(project?.name ?? "").trim() || "（未命名）";
      const templateId = project?.templateId != null ? String(project.templateId) : "";
      const searchBlob = [displayName, did, file, templateId].filter(Boolean).join(" ").toLowerCase();

      const row = document.createElement("div");
      row.className = "file-item";
      row.dataset.name = searchBlob;
      row.dataset.designId = did;
      row.dataset.file = file;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `方案 ${displayName}，文件 ${file}`);

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = docSvg;

      const nameEl = document.createElement("span");
      nameEl.className = "file-name";
      nameEl.textContent = displayName;

      const timeLabel = formatDesignFileListTime(project, stem);
      const timeEl = document.createElement("span");
      timeEl.className = "file-item-time";
      timeEl.textContent = timeLabel;
      timeEl.setAttribute("aria-hidden", timeLabel ? "false" : "true");
      if (!timeLabel) timeEl.hidden = true;

      row.appendChild(icon);
      row.appendChild(nameEl);
      row.appendChild(timeEl);
      if (timeLabel) {
        row.setAttribute("aria-label", `方案 ${displayName}，${timeLabel}，文件 ${file}`);
      }
      list.appendChild(row);

      const activate = () => {
        window.__activeDesignFile = file;
        window.__activeDesignProject = project;
        window.__activeDesignId = did;
        window.dispatchEvent(
          new CustomEvent("visionhome:design-select", {
            detail: { file, id: did, projectId: did, project },
          }),
        );
      };
      function tryActivateDesignFile() {
        if (file === window.__activeDesignFile) return;
        if (!canSaveCurrentDesign()) {
          activate();
          return;
        }
        pendingDesignFileSwitch = { activate };
        openSwitchDesignUnsavedDialog();
      }
      row.addEventListener("click", () => tryActivateDesignFile());
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          tryActivateDesignFile();
        }
      });
    }
  }

  bindDesignFileSearch();
}

const HEADER_UNSAVED_TEXT = "未保存文件";

/** 新建场景流程：保存成功后再清空画布时置为 true，打开保存弹窗时由「保存」分支设置 */
let newSceneAfterSavePending = false;

/** 侧栏切换方案：保存完成或「不保存」后执行 */
let pendingDesignFileSwitch = null;

function currentDesignBaselineFingerprint() {
  if (typeof window.svgEditorGetDesignBaselineFingerprint === "function") {
    return window.svgEditorGetDesignBaselineFingerprint();
  }
  const getLayout = window.svgEditorGetLayout;
  const getFloorLevel = window.svgEditorGetCurrentFloorLevelIndex;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  return JSON.stringify({
    furniture: layout,
    floorPlanId: null,
    floorLevelIndex: typeof getFloorLevel === "function" ? getFloorLevel() : null,
  });
}

export function canSaveCurrentDesign() {
  const getLayout = window.svgEditorGetLayout;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  const hasItems = Array.isArray(layout) && layout.length > 0;
  const cur = currentDesignBaselineFingerprint();
  const baseline = window.__designLayoutBaseline;
  const dirty = baseline === undefined || cur !== baseline;
  return hasItems && dirty;
}

/**
 * 顶栏「保存」右侧：当前方案显示名；未关联已打开文件时为「未保存文件」
 */
export function mountHeaderCurrentDesignLabel() {
  const labelEl = document.getElementById("currentDesignFileLabel");
  const btnNew = document.getElementById("btnNewScene");
  const newDlg = document.getElementById("newSceneUnsavedDialog");
  const newDlgCancel = document.getElementById("newSceneUnsavedCancel");
  const newDlgDiscard = document.getElementById("newSceneUnsavedDiscard");
  const newDlgSave = document.getElementById("newSceneUnsavedSave");
  if (!labelEl) return;

  function setLabel(displayText) {
    const text = displayText || HEADER_UNSAVED_TEXT;
    labelEl.textContent = text;
    labelEl.title =
      text === HEADER_UNSAVED_TEXT ? "尚未关联已保存的设计方案" : `当前方案：${text}`;
  }

  function syncFromGlobals() {
    const file = window.__activeDesignFile;
    const project = window.__activeDesignProject;
    if (!file || !project) {
      setLabel(HEADER_UNSAVED_TEXT);
      return;
    }
    const name = String(project?.name ?? "").trim();
    setLabel(name || "（未命名）");
  }

  function closeNewSceneDlg() {
    if (newDlg && typeof newDlg.close === "function") newDlg.close();
  }

  window.addEventListener("visionhome:design-select", () => syncFromGlobals());
  window.addEventListener("visionhome:design-metadata-updated", () => syncFromGlobals());

  window.addEventListener("visionhome:execute-new-scene", () => {
    window.__activeDesignFile = undefined;
    window.__activeDesignProject = undefined;
    window.__activeDesignId = undefined;
    setLabel(HEADER_UNSAVED_TEXT);
    window.dispatchEvent(new CustomEvent("visionhome:design-new"));
  });

  btnNew?.addEventListener("click", () => {
    if (canSaveCurrentDesign()) {
      if (newDlg && typeof newDlg.showModal === "function") newDlg.showModal();
      else newDlg?.setAttribute("open", "");
    } else {
      window.dispatchEvent(new CustomEvent("visionhome:execute-new-scene"));
    }
  });

  newDlgCancel?.addEventListener("click", () => closeNewSceneDlg());
  newDlgDiscard?.addEventListener("click", () => {
    closeNewSceneDlg();
    window.dispatchEvent(new CustomEvent("visionhome:execute-new-scene"));
  });
  newDlgSave?.addEventListener("click", () => {
    newSceneAfterSavePending = true;
    closeNewSceneDlg();
    window.dispatchEvent(new CustomEvent("visionhome:open-save-design"));
  });

  syncFromGlobals();
}

let saveDesignFlowMounted = false;

function layoutToFurnitureInstances(layout, floorId) {
  const fid = floorId || "floor1";
  return (Array.isArray(layout) ? layout : []).map((item, i) => ({
    instanceId: `fi_${i + 1}`,
    furnitureId: item.model,
    floorId: item?.floorId != null && String(item.floorId).trim() ? String(item.floorId).trim() : fid,
    positionCm: [Math.round(Number(item.x) || 0), Math.round(Number(item.y) || 0)],
    rotationDeg: Math.round(Number(item.rotation ?? 0) || 0),
  }));
}

function isoNow() {
  return new Date().toISOString();
}

/**
 * 写入设计文件的 SVG 编辑态：户型、楼层索引、家具列表。
 * 视图平移/缩放、网格、逻辑画布尺寸不持久化；打开方案时使用编辑器默认视图与网格。
 */
function collectSvgEditorState(layout) {
  const getFp = window.svgEditorGetCurrentFloorplanId;
  const getFloorLevel = window.svgEditorGetCurrentFloorLevelIndex;
  const getSurf = window.svgEditorGetSurfaceOverrides;
  const getStyleKey = window.svgEditorGetFloorplanStyleKey;
  const getLighting = window.svgEditorGetLightingConfig;
  const floorPlanId = typeof getFp === "function" ? getFp() : null;
  const floorLevelIndex = typeof getFloorLevel === "function" ? getFloorLevel() : null;
  const floorplanStyleKey = typeof getStyleKey === "function" ? getStyleKey() : null;
  const furniture = (Array.isArray(layout) ? layout : []).map((item) => ({
    model: String(item.model ?? "").trim(),
    floorId: item?.floorId != null && String(item.floorId).trim() ? String(item.floorId).trim() : null,
    x: Math.round(Number(item.x) || 0),
    y: Math.round(Number(item.y) || 0),
    rotation: Math.round(Number(item.rotation ?? 0) || 0),
  }));
  const surfaceOverrides =
    typeof getSurf === "function" ? getSurf() : null;
  const lightingConfig =
    typeof getLighting === "function" ? getLighting() : null;
  const out = {
    version: 1,
    floorPlanId,
    floorLevelIndex,
    floorplanStyleKey,
    furniture,
  };
  if (surfaceOverrides && typeof surfaceOverrides === "object" && Object.keys(surfaceOverrides).length > 0) {
    out.surfaceOverrides = surfaceOverrides;
  }
  if (lightingConfig && typeof lightingConfig === "object") {
    out.lightingConfig = lightingConfig;
  }
  return out;
}

function buildProjectPayload(name, layout) {
  const trimmed = String(name || "").trim();
  const prev = window.__activeDesignProject;
  const activeFile = window.__activeDesignFile;
  const isExisting = Boolean(activeFile && prev && typeof prev === "object");
  const id = isExisting ? String(prev.id ?? activeFile.replace(/\.json$/i, "")).trim() : `project_${Date.now()}`;
  const floorIdFromCanvas =
    typeof window.svgEditorGetCurrentFloorId === "function" ? window.svgEditorGetCurrentFloorId() : null;
  const floorId =
    floorIdFromCanvas != null && String(floorIdFromCanvas).trim()
      ? String(floorIdFromCanvas).trim()
      : prev?.activeFloorId != null
        ? String(prev.activeFloorId)
        : "floor1";
  const furnitureInstances = layoutToFurnitureInstances(layout, floorId);
  const base = isExisting ? { ...prev } : {};
  const fpFromCanvas =
    typeof window.svgEditorGetCurrentFloorplanId === "function" ? window.svgEditorGetCurrentFloorplanId() : null;
  const templateId =
    fpFromCanvas != null && String(fpFromCanvas).trim()
      ? String(fpFromCanvas).trim()
      : base.templateId != null && String(base.templateId).trim()
        ? String(base.templateId).trim()
        : null;
  return {
    schemaVersion: "1.1",
    id,
    name: trimmed,
    description: base.description ?? "",
    createdAt: base.createdAt ?? isoNow(),
    updatedAt: isoNow(),
    templateId,
    activeFloorId: floorId,
    floorplanSnapshot: base.floorplanSnapshot ?? null,
    furnitureInstances,
    svgEditor: collectSvgEditorState(layout),
  };
}

function openSwitchDesignUnsavedDialog() {
  const dlg = document.getElementById("switchDesignUnsavedDialog");
  if (dlg && typeof dlg.showModal === "function") dlg.showModal();
  else if (dlg) dlg.setAttribute("open", "");
}

function closeSwitchDesignUnsavedDialog() {
  const dlg = document.getElementById("switchDesignUnsavedDialog");
  if (dlg && typeof dlg.close === "function") dlg.close();
  else if (dlg) dlg.removeAttribute("open");
}

function hasResolvedDesignName() {
  return Boolean(String(window.__activeDesignProject?.name ?? "").trim());
}

function runPendingDesignFileSwitchIfAny() {
  const p = pendingDesignFileSwitch;
  pendingDesignFileSwitch = null;
  if (p) p.activate();
}

/**
 * 写入方案（顶栏 / 弹窗 / 切换前保存）；成功写入仓库后若存在待切换方案则继续打开目标文件
 */
export async function executeSaveWithName(name) {
  const dialog = document.getElementById("saveDesignDialog");
  const input = document.getElementById("saveDesignNameInput");
  const errEl = document.getElementById("saveDesignNameError");

  function hideError() {
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
  }
  function showError(msg) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = msg;
    }
  }
  function closeDialog() {
    if (dialog && typeof dialog.close === "function") dialog.close();
  }
  function openSaveDialog() {
    hideError();
    const p = window.__activeDesignProject;
    const defaultName = String(p?.name ?? "").trim();
    if (input) input.value = defaultName;
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
    else if (dialog) dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      try {
        input?.focus();
        input?.select();
      } catch (_) {
        /* ignore */
      }
    });
  }

  const trimmed = String(name ?? "").trim();
  if (!trimmed) return;
  const getLayout = window.svgEditorGetLayout;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  if (!layout.length) {
    openSaveDialog();
    showError("画布上没有家具，无法保存。");
    pendingDesignFileSwitch = null;
    return;
  }
  const runNewSceneAfterSave = newSceneAfterSavePending;
  const hadPendingSwitch = Boolean(pendingDesignFileSwitch);
  const previousFile = window.__activeDesignFile;
  const project = buildProjectPayload(trimmed, layout);
  const filename =
    previousFile && String(previousFile).trim().toLowerCase().endsWith(".json")
      ? String(previousFile).trim()
      : `${String(project.id).replace(/[^\w.-]+/g, "_")}.json`;
  const json = `${JSON.stringify(project, null, 2)}\n`;

  hideError();
  const saved = await postSaveDesignToDataDir(filename, project);
  if (!saved.ok) {
    triggerDownloadDesignJson(filename, json);
    openSaveDialog();
    if (input) input.value = trimmed;
    showError(`无法写入服务器（${saved.reason}）。已下载 JSON 文件。`);
  } else {
    await refreshDesignProjectsFromManifest();
  }

  window.__activeDesignProject = project;
  window.__activeDesignFile = saved.ok ? saved.file : filename;
  window.__activeDesignId = String(project.id);
  if (typeof window.svgEditorCommitSavedBaseline === "function") {
    window.svgEditorCommitSavedBaseline();
  }
  newSceneAfterSavePending = false;
  window.dispatchEvent(new CustomEvent("visionhome:design-metadata-updated"));

  if (runNewSceneAfterSave && saved.ok) {
    pendingDesignFileSwitch = null;
    closeDialog();
    window.dispatchEvent(new CustomEvent("visionhome:execute-new-scene"));
    return;
  }

  if (hadPendingSwitch && saved.ok) {
    closeDialog();
    runPendingDesignFileSwitchIfAny();
    return;
  }

  if (saved.ok) {
    closeDialog();
  }
}

let switchDesignUnsavedMounted = false;

/**
 * 侧栏切换方案：未保存且保存按钮可用时的确认框（取消 / 不保存 / 保存）
 */
export function mountSwitchDesignUnsavedFlow() {
  if (switchDesignUnsavedMounted) return;
  const dlg = document.getElementById("switchDesignUnsavedDialog");
  const cancelBtn = document.getElementById("switchDesignUnsavedCancel");
  const discardBtn = document.getElementById("switchDesignUnsavedDiscard");
  const saveBtn = document.getElementById("switchDesignUnsavedSave");
  if (!dlg || !cancelBtn || !discardBtn || !saveBtn) return;
  switchDesignUnsavedMounted = true;

  cancelBtn.addEventListener("click", () => {
    pendingDesignFileSwitch = null;
    closeSwitchDesignUnsavedDialog();
  });

  dlg.addEventListener("cancel", () => {
    pendingDesignFileSwitch = null;
  });

  discardBtn.addEventListener("click", () => {
    const p = pendingDesignFileSwitch;
    pendingDesignFileSwitch = null;
    closeSwitchDesignUnsavedDialog();
    if (p) p.activate();
  });

  saveBtn.addEventListener("click", () => {
    if (!pendingDesignFileSwitch) return;
    closeSwitchDesignUnsavedDialog();
    if (hasResolvedDesignName()) {
      void executeSaveWithName(String(window.__activeDesignProject?.name ?? "").trim());
    } else {
      window.dispatchEvent(new CustomEvent("visionhome:open-save-design"));
    }
  });
}

function updateSaveButtonState() {
  const btn = document.getElementById("btnSave");
  if (!btn) return;
  const can = canSaveCurrentDesign();
  btn.disabled = !can;
  const getLayout = window.svgEditorGetLayout;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  const hasItems = Array.isArray(layout) && layout.length > 0;
  const cur = currentDesignBaselineFingerprint();
  const baseline = window.__designLayoutBaseline;
  const dirty = baseline === undefined || cur !== baseline;
  if (!hasItems) btn.title = "画布上没有家具，无法保存";
  else if (!dirty) btn.title = "当前已与上次保存一致";
  else btn.title = "保存当前方案";
}

/**
 * 保存按钮：有家具且相对上次保存有改动时可点；弹窗确认后优先 POST 同源保存接口，失败则触发下载 JSON。
 */
export function mountSaveDesignFlow() {
  if (saveDesignFlowMounted) return;
  const btn = document.getElementById("btnSave");
  const dialog = document.getElementById("saveDesignDialog");
  const input = document.getElementById("saveDesignNameInput");
  const errEl = document.getElementById("saveDesignNameError");
  const cancelBtn = document.getElementById("saveDesignCancelBtn");
  const confirmBtn = document.getElementById("saveDesignConfirmBtn");
  if (!btn || !dialog || !input || !confirmBtn) return;
  saveDesignFlowMounted = true;

  window.addEventListener("visionhome:open-save-design", () => {
    openSaveDialog();
  });

  function hideError() {
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
  }

  function showError(msg) {
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = msg;
    }
  }

  function closeDialog() {
    if (typeof dialog.close === "function") dialog.close();
  }

  function openSaveDialog() {
    hideError();
    const p = window.__activeDesignProject;
    const defaultName = String(p?.name ?? "").trim();
    input.value = defaultName;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    requestAnimationFrame(() => {
      try {
        input.focus();
        input.select();
      } catch (_) {
        /* ignore */
      }
    });
  }

  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    if (hasResolvedDesignName()) {
      await executeSaveWithName(String(window.__activeDesignProject?.name ?? "").trim());
      return;
    }
    openSaveDialog();
  });

  cancelBtn?.addEventListener("click", () => {
    newSceneAfterSavePending = false;
    pendingDesignFileSwitch = null;
    closeDialog();
  });

  dialog.addEventListener("cancel", () => {
    newSceneAfterSavePending = false;
    pendingDesignFileSwitch = null;
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirmBtn.click();
    }
  });

  confirmBtn.addEventListener("click", async () => {
    const name = String(input.value ?? "").trim();
    if (!name) {
      showError("请输入保存名称。");
      try {
        input.focus();
      } catch (_) {
        /* ignore */
      }
      return;
    }
    await executeSaveWithName(name);
  });

  window.addEventListener("visionhome:svg-layout-changed", updateSaveButtonState);
  updateSaveButtonState();
}
