/**
 * 设计文件（方案）：在户型模板（templateId → data/floorplans）基础上的家具编辑会话 JSON。
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
 * 拉取 data/design/manifest.json，得到要加载的 JSON 文件名列表
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
 * 渲染「文件」侧栏：data/design 下的方案 JSON
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
    p.textContent = "设计清单加载失败，请检查 data/design/manifest.json。";
    list.appendChild(p);
  } else if (!entries.length) {
    const p = document.createElement("p");
    p.className = "panel-empty";
    p.textContent = "暂无设计文件。请在 data/design/manifest.json 的 files 中加入 JSON 文件名。";
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

      row.appendChild(icon);
      row.appendChild(nameEl);
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
      row.addEventListener("click", () => activate());
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    }
  }

  bindDesignFileSearch();
}

const HEADER_UNSAVED_TEXT = "未保存文件";

/** 新建场景流程：保存成功后再清空画布时置为 true，打开保存弹窗时由「保存」分支设置 */
let newSceneAfterSavePending = false;

function canSaveCurrentDesign() {
  const getLayout = window.svgEditorGetLayout;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  const hasItems = Array.isArray(layout) && layout.length > 0;
  const cur = JSON.stringify(layout);
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
    floorId: fid,
    positionMm: [item.x, item.y],
    rotationDeg: item.rotation ?? 0,
  }));
}

function isoNow() {
  return new Date().toISOString();
}

function buildProjectPayload(name, layout) {
  const trimmed = String(name || "").trim();
  const prev = window.__activeDesignProject;
  const activeFile = window.__activeDesignFile;
  const isExisting = Boolean(activeFile && prev && typeof prev === "object");
  const id = isExisting ? String(prev.id ?? activeFile.replace(/\.json$/i, "")).trim() : `project_${Date.now()}`;
  const floorId = prev?.activeFloorId != null ? String(prev.activeFloorId) : "floor1";
  const furnitureInstances = layoutToFurnitureInstances(layout, floorId);
  const base = isExisting ? { ...prev } : {};
  return {
    schemaVersion: "1.0",
    id,
    name: trimmed,
    description: base.description ?? "",
    createdAt: base.createdAt ?? isoNow(),
    updatedAt: isoNow(),
    templateId: base.templateId ?? null,
    activeFloorId: floorId,
    floorplanSnapshot: base.floorplanSnapshot ?? null,
    furnitureInstances,
  };
}

function updateSaveButtonState() {
  const btn = document.getElementById("btnSave");
  if (!btn) return;
  const can = canSaveCurrentDesign();
  btn.disabled = !can;
  const getLayout = window.svgEditorGetLayout;
  const layout = typeof getLayout === "function" ? getLayout() : [];
  const hasItems = Array.isArray(layout) && layout.length > 0;
  const cur = JSON.stringify(layout);
  const baseline = window.__designLayoutBaseline;
  const dirty = baseline === undefined || cur !== baseline;
  if (!hasItems) btn.title = "画布上没有家具，无法保存";
  else if (!dirty) btn.title = "当前已与上次保存一致";
  else btn.title = "保存方案到 data/design/（需 scripts/dev_server.py；否则下载 JSON）";
}

/**
 * 保存按钮：有家具且相对上次保存有改动时可点；弹窗确认后优先 POST 写入 data/design/（dev_server），失败则下载 JSON。
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

  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    openSaveDialog();
  });

  cancelBtn?.addEventListener("click", () => {
    newSceneAfterSavePending = false;
    closeDialog();
  });

  dialog.addEventListener("cancel", () => {
    newSceneAfterSavePending = false;
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
    const getLayout = window.svgEditorGetLayout;
    const layout = typeof getLayout === "function" ? getLayout() : [];
    if (!layout.length) {
      showError("画布上没有家具，无法保存。");
      return;
    }
    const runNewSceneAfterSave = newSceneAfterSavePending;
    const previousFile = window.__activeDesignFile;
    const project = buildProjectPayload(name, layout);
    const filename =
      previousFile && String(previousFile).trim().toLowerCase().endsWith(".json")
        ? String(previousFile).trim()
        : `${String(project.id).replace(/[^\w.-]+/g, "_")}.json`;
    const json = `${JSON.stringify(project, null, 2)}\n`;

    hideError();
    const saved = await postSaveDesignToDataDir(filename, project);
    if (!saved.ok) {
      triggerDownloadDesignJson(filename, json);
      showError(
        `无法写入 ${DATA_PATHS.design}/（${saved.reason}）。已改为下载 JSON。开发环境请运行：python3 scripts/dev_server.py`,
      );
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
    if (saved.ok) {
      closeDialog();
      if (runNewSceneAfterSave) {
        window.dispatchEvent(new CustomEvent("visionhome:execute-new-scene"));
      }
    }
  });

  window.addEventListener("visionhome:svg-layout-changed", updateSaveButtonState);
  updateSaveButtonState();
}
