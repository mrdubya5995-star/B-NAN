/* B-NAN bootstrap */

(async function main() {
  document.getElementById("search-input").addEventListener("input", (e) => {
    RBUI.setSearch(e.target.value);
  });

  document.getElementById("btn-select-mode").addEventListener("click", () => RBUI.toggleSelectMode());
  document.getElementById("btn-select-all").addEventListener("click", () => RBUI.toggleSelectAll());
  document.getElementById("btn-cancel-select").addEventListener("click", () => RBUI.cancelSelect());
  document.getElementById("btn-bulk-delete").addEventListener("click", () => RBUI.confirmBulkDelete());

  document.getElementById("btn-avatar").addEventListener("click", () => RBUI.openSettings());
  document.getElementById("btn-home").addEventListener("click", () => RBUI.goHome());
  document.getElementById("btn-settings-back").addEventListener("click", () => RBUI.closeSettings());
  document.getElementById("btn-settings-back-top").addEventListener("click", () => RBUI.closeSettings());
  document.getElementById("sort-by").addEventListener("change", (e) => RBUI.setSortMode(e.target.value));
  document.getElementById("btn-display-grid").addEventListener("click", () => RBUI.setDisplayMode("grid"));
  document.getElementById("btn-display-list").addEventListener("click", () => RBUI.setDisplayMode("list"));
  document.getElementById("hero-scroll-hint").addEventListener("click", () => {
    document.getElementById("hero-content").scrollBy({ left: 320, behavior: "smooth" });
  });

  RBImport.init();
  RBPlayer.init();
  RBGameMenu.init();
  RBWindowChrome.initWindowChrome();
  await RBSettings.applyVisualSettings();
  await RBUI.loadPrefs();

  document.querySelectorAll(".modal-backdrop").forEach((bd) => {
    bd.addEventListener("click", (e) => {
      if (e.target === bd) bd.hidden = true;
    });
  });

  RBUI.renderLibrary();

  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // Without this, the whole library (every ROM, every save) lives in
  // "best-effort" IndexedDB storage, which browsers are allowed to
  // silently evict under disk pressure -- a real, concrete way games
  // could vanish with no user action at all, worth closing given B-NAN
  // routinely stores multi-gigabyte ROMs. persist() doesn't guarantee
  // anything (the browser can still say no, quietly, per spec), so this
  // is best-effort itself -- but it's a real, standard mechanism, not a
  // no-op, and there's no reason not to ask.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
})();
