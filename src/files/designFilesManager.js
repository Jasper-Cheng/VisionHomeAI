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

/**
 * 顶栏「保存」右侧：当前方案显示名；未关联已打开文件时为「未保存文件」
 */
export function mountHeaderCurrentDesignLabel() {
  const labelEl = document.getElementById("currentDesignFileLabel");
  const btnNew = document.getElementById("btnNewScene");
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

  window.addEventListener("visionhome:design-select", () => syncFromGlobals());

  btnNew?.addEventListener("click", () => {
    window.__activeDesignFile = undefined;
    window.__activeDesignProject = undefined;
    window.__activeDesignId = undefined;
    setLabel(HEADER_UNSAVED_TEXT);
    window.dispatchEvent(new CustomEvent("visionhome:design-new"));
  });

  syncFromGlobals();
}
