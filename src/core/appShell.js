(() => {
  const railButtons = Array.from(document.querySelectorAll(".rail-btn[data-panel]"));
  const panels = Array.from(document.querySelectorAll(".side-panel[data-panel]"));
  const tabStrips = Array.from(document.querySelectorAll(".panel-tabs"));
  const resetBtn = document.querySelector('[data-action="reset-view"]');
  // Undo/redo暂未实现

  function setActive(panelId) {
    const isNone = !panelId;
    railButtons.forEach((b) => b.classList.toggle("is-active", !isNone && b.dataset.panel === panelId));
    panels.forEach((p) => p.classList.toggle("is-visible", !isNone && p.dataset.panel === panelId));
  }

  // Allow mouse wheel to scroll horizontal tab strip + tab click to switch active
  tabStrips.forEach((strip) => {
    strip.addEventListener(
      "wheel",
      (e) => {
        if (strip.scrollWidth <= strip.clientWidth) return;
        const dominantY = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const delta = dominantY ? e.deltaY : e.deltaX;
        strip.scrollLeft += delta;
        e.preventDefault();
      },
      { passive: false },
    );
    strip.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        strip.querySelectorAll(".tab").forEach((t) => {
          t.classList.remove("is-active");
          t.setAttribute("aria-selected", "false");
        });
        tab.classList.add("is-active");
        tab.setAttribute("aria-selected", "true");

        // 户型库 Tab（与 floorPlanManager 内监听并存：此处仅绑定首屏已存在的 tab；动态 tab 由 mount 内逻辑处理）
        if (strip.classList.contains("floorplan-tabs")) {
          const category = tab.dataset.category || "";
          const grid = document.getElementById("floorPlanGrid");
          const searchInput = document.querySelector('.side-panel[data-panel="floorplans"] .search-input');
          const searchQ = (searchInput?.value || "").trim().toLowerCase();
          grid?.querySelectorAll(".asset-card").forEach((card) => {
            const cardCategory = card.dataset.category || "";
            const matchesCategory = !category || cardCategory === category;
            const matchesSearch = !searchQ || (card.dataset.name || "").toLowerCase().includes(searchQ);
            card.classList.toggle("is-hidden", !matchesCategory || !matchesSearch);
          });
        }
      });
    });
  });

  railButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const isAlreadyActive = btn.classList.contains("is-active");
      setActive(isAlreadyActive ? null : btn.dataset.panel);
    });
  });

  // Default
  const defaultPanel = railButtons.find((b) => b.classList.contains("is-active"))?.dataset.panel;
  if (defaultPanel) setActive(defaultPanel);

  // 主导航：编辑模式（SVG）↔ 全景漫游（3D + 快捷入口）
  const appViewEdit = document.getElementById("appViewEdit");
  const appViewPanorama = document.getElementById("appViewPanorama");
  const navViewLinks = document.querySelectorAll(".nav-segment .seg-item[data-app-view]");

  function setAppView(mode) {
    const isPanorama = mode === "panorama";
    if (!appViewEdit || !appViewPanorama) return;

    appViewEdit.classList.toggle("is-active", !isPanorama);
    appViewPanorama.classList.toggle("is-active", isPanorama);

    navViewLinks.forEach((link) => {
      link.classList.toggle("is-active", link.dataset.appView === mode);
    });

    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  navViewLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const mode = link.dataset.appView || "edit";
      setAppView(mode);
    });
  });

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (typeof window.resetViewerView === "function") window.resetViewerView();
    });
  }

  // 设计文件列表搜索：在 designFilesManager.mountDesignFileList 挂载后绑定（见 designFilesManager.js）

  // 户型库：搜索与 Tab（与家具库同结构）
  const floorplanSearchInput = document.querySelector('.side-panel[data-panel="floorplans"] .search-input');
  const floorplanGrid = document.getElementById("floorPlanGrid");
  const floorplanTabs = document.querySelector(".floorplan-tabs");

  function filterFloorplanCards() {
    const q = (floorplanSearchInput?.value || "").trim().toLowerCase();
    const activeTab = floorplanTabs?.querySelector(".tab.is-active");
    const category = activeTab?.dataset.category || "";

    floorplanGrid?.querySelectorAll(".asset-card").forEach((card) => {
      const cardCategory = card.dataset.category || "";
      const matchesCategory = !category || cardCategory === category;
      const matchesSearch = !q || (card.dataset.name || "").toLowerCase().includes(q);
      card.classList.toggle("is-hidden", !matchesCategory || !matchesSearch);
    });
  }

  if (floorplanSearchInput) {
    floorplanSearchInput.addEventListener("input", filterFloorplanCards);
  }

  // Undo/redo暂未实现（按钮已 disabled），这里不绑定点击事件。
})();

