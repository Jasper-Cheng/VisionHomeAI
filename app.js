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

    if (appContent) appContent.classList.toggle("has-assets-panel", panelId === "assets");

    if (contentIcons) {
      contentIcons.style.left = panelId === "assets" ? "calc(320px + 14px)" : "14px";
    }
  }

  // Allow mouse wheel to scroll horizontal tab strip
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
  // Undo/redo暂未实现（按钮已 disabled），这里不绑定点击事件。
})();

