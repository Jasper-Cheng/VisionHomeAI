import { DATA_PATHS } from "../core/schema.js";

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
 * @param {string} filename 如 project_001.json
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
    return;
  }

  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "panel-empty";
    p.textContent = "暂无设计文件。请在 data/design/manifest.json 的 files 中加入 JSON 文件名。";
    list.appendChild(p);
    return;
  }

  const docSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>`;

  for (const { file, project } of entries) {
    const pid = String(project?.projectId || file.replace(/\.json$/i, "")).trim();
    /** 展示名即 manifest 中的文件名（不再使用 JSON 内 name 字段） */
    const title = file;
    const templateId = project?.templateId != null ? String(project.templateId) : "";
    const searchBlob = [title, pid, templateId].filter(Boolean).join(" ").toLowerCase();

    const row = document.createElement("div");
    row.className = "file-item";
    row.dataset.name = searchBlob;
    row.dataset.projectId = pid;
    row.dataset.file = file;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `设计文件 ${title}`);

    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = docSvg;

    const nameEl = document.createElement("span");
    nameEl.className = "file-name";
    nameEl.textContent = title;

    row.appendChild(icon);
    row.appendChild(nameEl);
    list.appendChild(row);

    const activate = () => {
      window.__activeDesignFile = file;
      window.__activeDesignProject = project;
      window.dispatchEvent(
        new CustomEvent("visionhome:design-select", {
          detail: { file, projectId: pid, project },
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
