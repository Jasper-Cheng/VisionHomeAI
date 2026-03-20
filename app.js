(() => {
  const railButtons = Array.from(document.querySelectorAll(".rail-btn[data-panel]"));
  const panels = Array.from(document.querySelectorAll(".side-panel[data-panel]"));
  const tabStrips = Array.from(document.querySelectorAll(".panel-tabs"));
  const appContent = document.querySelector(".app-content");
  const contentIcons = document.querySelector(".content-icons");
  const resetBtn = document.querySelector('[data-action="reset-view"]');
  // Undo/redo暂未实现

  function setActive(panelId) {
    const isNone = !panelId;
    railButtons.forEach((b) => b.classList.toggle("is-active", !isNone && b.dataset.panel === panelId));
    panels.forEach((p) => p.classList.toggle("is-visible", !isNone && p.dataset.panel === panelId));

    const hasLeftPanel = panelId === "assets" || panelId === "files" || panelId === "floorplans";
    if (appContent) appContent.classList.toggle("has-assets-panel", hasLeftPanel);

    if (contentIcons) {
      contentIcons.style.left = hasLeftPanel ? "calc(320px + 14px)" : "14px";
    }
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

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (typeof window.resetViewerView === "function") window.resetViewerView();
    });
  }

  // File panel search
  const fileSearchInput = document.querySelector(".file-search-input");
  const fileItems = document.querySelectorAll(".file-item");
  if (fileSearchInput && fileItems.length) {
    fileSearchInput.addEventListener("input", () => {
      const q = (fileSearchInput.value || "").trim().toLowerCase();
      fileItems.forEach((item) => {
        const name = (item.dataset.name || "").toLowerCase();
        item.classList.toggle("is-hidden", q && !name.includes(q));
      });
    });
  }

  // Floorplan panel search
  const floorplanSearchInput = document.querySelector(".floorplan-search-input");
  const floorplanCards = document.querySelectorAll(".floorplan-card");
  if (floorplanSearchInput && floorplanCards.length) {
    floorplanSearchInput.addEventListener("input", () => {
      const q = (floorplanSearchInput.value || "").trim().toLowerCase();
      floorplanCards.forEach((card) => {
        const name = (card.dataset.name || "").toLowerCase();
        card.classList.toggle("is-hidden", q && !name.includes(q));
      });
    });
  }
  // Undo/redo暂未实现（按钮已 disabled），这里不绑定点击事件。
})();

