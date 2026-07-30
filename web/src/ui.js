/* B-NAN UI — rendering + interaction. Deliberately plain: one file, no
   framework, no build step.

   One screen now, not four: a "Recent Games" hero row (renderRecentHero)
   sits above the "Full Library" grid/list (renderLibrary), with Settings
   as a full-screen overlay reachable from the topbar avatar or the
   bottom bar's Settings hint (openSettings/closeSettings) -- there's no
   more sidebar or per-view topbar config to branch on. */

const RBUI = (() => {
  let activeSystemFilter = null;
  let favoritesOnly = false;
  let sortMode = "alpha"; // alpha | recentlyAdded | recentlyPlayed | mostPlayed | system
  let displayMode = "grid"; // grid | list
  let searchTerm = "";
  let gamesCache = [];
  let selectMode = false;
  let selectedIds = new Set();
  const artUrlCache = new Map(); // gameId -> { blob, url }, so we're not leaking/recreating one per render

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  // Shared by backup.js (full backup zip) and player.js (screenshots,
  // save-file export, save-state files) -- was several near-identical
  // copies of "create an object URL, click a synthetic <a download>,
  // revoke it after a delay" (found in a codebase audit), now one place.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function formatPlaytime(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return "<1m";
  }

  // A game can now render twice in the same pass -- once in the Recent
  // Games hero, once again in the Full Library grid/list below it, since
  // the hero doesn't exclude anything from the library. The old version
  // of this unconditionally revoked the previous URL on every single
  // call, which broke the FIRST render's <img> the moment the SAME game
  // was rendered again later in that same pass -- exactly why art was
  // showing in the library but not in Recent Games. Now it only revokes
  // and recreates when the art has actually changed (or been removed),
  // so two renders of the same still-current art safely share one URL.
  function getArtUrl(game) {
    const cached = artUrlCache.get(game.id);
    if (!game.artBlob) {
      if (cached) {
        URL.revokeObjectURL(cached.url);
        artUrlCache.delete(game.id);
      }
      return null;
    }
    if (cached && cached.blob === game.artBlob) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const url = URL.createObjectURL(game.artBlob);
    artUrlCache.set(game.id, { blob: game.artBlob, url });
    return url;
  }

  // ---------- settings overlay ----------

  function openSettings() {
    document.getElementById("view-library").hidden = true;
    document.getElementById("view-settings").hidden = false;
    renderSettings();
  }

  function closeSettings() {
    document.getElementById("view-settings").hidden = true;
    document.getElementById("view-library").hidden = false;
    renderLibrary();
  }

  // Clicking the logo -- closes Settings if it's open, clears every
  // active filter/search/select-mode, and scrolls back to the top, same
  // as a fresh load. Doesn't touch sort/display-mode -- those are
  // persisted preferences, not filter state, so a "go home" shouldn't
  // silently discard a choice you made on purpose.
  function goHome() {
    document.getElementById("view-settings").hidden = true;
    document.getElementById("view-library").hidden = false;

    activeSystemFilter = null;
    favoritesOnly = false;
    searchTerm = "";
    selectMode = false;
    selectedIds.clear();

    document.getElementById("search-input").value = "";
    document.getElementById("sort-by").value = sortMode;

    renderLibrary();
    // #view-library is the element that actually scrolls (it's the flex
    // child sized to .app-main's height with its own overflow-y:auto),
    // not .app-main itself, which never overflows.
    document.getElementById("view-library").scrollTo({ top: 0, behavior: "smooth" });
  }

  // ---------- filters / sort / display mode ----------

  function filterBySystem(systemId) {
    activeSystemFilter = activeSystemFilter === systemId ? null : systemId;
    renderLibrary();
  }

  // "Favorites Only" lives as an option INSIDE the sort-by dropdown
  // (moved there on request, rather than a separate standalone chip) --
  // picking it filters to favorites while leaving the underlying sort
  // order (whatever it was) alone; picking any real sort option clears
  // the favorites filter and applies that order.
  function setSortMode(mode) {
    if (mode === "favorites") {
      favoritesOnly = true;
    } else {
      favoritesOnly = false;
      sortMode = mode;
      RBDB.setSetting("librarySortMode", mode);
    }
    document.getElementById("sort-by").value = mode;
    renderLibrary();
  }

  function setDisplayMode(mode) {
    displayMode = mode;
    document.getElementById("btn-display-grid").classList.toggle("active", mode === "grid");
    document.getElementById("btn-display-list").classList.toggle("active", mode === "list");
    RBDB.setSetting("libraryDisplayMode", mode);
    renderLibrary();
  }

  // Restores the last sort/display-mode choice -- same generic settings
  // key/value store settings.js already uses (RBDB.getSetting/setSetting),
  // not a new persistence mechanism.
  async function loadPrefs() {
    sortMode = await RBDB.getSetting("librarySortMode", "alpha");
    displayMode = await RBDB.getSetting("libraryDisplayMode", "grid");
    document.getElementById("sort-by").value = sortMode;
    document.getElementById("btn-display-grid").classList.toggle("active", displayMode === "grid");
    document.getElementById("btn-display-list").classList.toggle("active", displayMode === "list");
  }

  // ---------- console filter chips ----------

  function baseGameSet(games) {
    return favoritesOnly ? games.filter((g) => g.favorite) : games;
  }

  function renderConsoleChips() {
    const wrap = document.getElementById("topbar-chips");
    wrap.innerHTML = "";
    const base = baseGameSet(gamesCache);
    const bySystem = {};
    base.forEach((g) => (bySystem[g.systemId] = (bySystem[g.systemId] || 0) + 1));
    const used = RB_SYSTEMS.filter((s) => bySystem[s.id]);
    if (used.length === 0) return;

    const allChip = document.createElement("button");
    allChip.className = "console-chip" + (activeSystemFilter ? "" : " active");
    allChip.textContent = `All (${base.length})`;
    allChip.addEventListener("click", () => filterBySystem(null));
    wrap.appendChild(allChip);

    used
      .sort((a, b) => bySystem[b.id] - bySystem[a.id])
      .forEach((s) => {
        const chip = document.createElement("button");
        chip.className = "console-chip" + (activeSystemFilter === s.id ? " active" : "");
        chip.textContent = `${s.name} (${bySystem[s.id]})`;
        chip.addEventListener("click", () => filterBySystem(s.id));
        wrap.appendChild(chip);
      });
  }

  function updateFavoritesOptionCount() {
    const n = gamesCache.filter((g) => g.favorite).length;
    const opt = document.querySelector('#sort-by option[value="favorites"]');
    if (opt) opt.textContent = n ? `★ Favorites Only (${n})` : "★ Favorites Only";
  }

  // ---------- topbar action buttons (select mode) ----------

  function renderTopbarActionsState() {
    const selectBtn = document.getElementById("btn-select-mode");
    const selectAllBtn = document.getElementById("btn-select-all");
    const cancelBtn = document.getElementById("btn-cancel-select");
    const bulkBtn = document.getElementById("btn-bulk-delete");
    const bulkCount = document.getElementById("bulk-count");

    if (selectMode) {
      selectBtn.classList.add("hidden");
      selectAllBtn.classList.remove("hidden");
      selectAllBtn.textContent = allVisibleSelected() ? "Deselect All" : "Select All";
      cancelBtn.classList.remove("hidden");
      bulkBtn.classList.remove("hidden");
      bulkBtn.disabled = selectedIds.size === 0;
      bulkCount.textContent = selectedIds.size ? String(selectedIds.size) : "";
    } else {
      selectBtn.classList.remove("hidden");
      selectAllBtn.classList.add("hidden");
      cancelBtn.classList.add("hidden");
      bulkBtn.classList.add("hidden");
    }
  }

  // ---------- multi-select ----------

  function toggleSelectMode() {
    selectMode = !selectMode;
    if (!selectMode) selectedIds.clear();
    renderTopbarActionsState();
    renderLibrary();
  }

  function cancelSelect() {
    selectMode = false;
    selectedIds.clear();
    renderTopbarActionsState();
    renderLibrary();
  }

  function allVisibleSelected() {
    const visible = currentGameSet(gamesCache);
    return visible.length > 0 && visible.every((g) => selectedIds.has(g.id));
  }

  // Selects everything currently visible (respecting the active console
  // filter/favorites/search, same as what's actually on screen) --
  // toggles to deselect-all if everything visible is already selected.
  function toggleSelectAll() {
    const visible = currentGameSet(gamesCache);
    if (allVisibleSelected()) {
      visible.forEach((g) => selectedIds.delete(g.id));
    } else {
      visible.forEach((g) => selectedIds.add(g.id));
    }
    renderTopbarActionsState();
    renderLibrary();
  }

  function toggleSelect(gameId) {
    if (selectedIds.has(gameId)) selectedIds.delete(gameId);
    else selectedIds.add(gameId);
    // Scoped to the library grid/list specifically (not the Recent Games
    // hero, which never shows the select checkbox -- a game can appear in
    // both places at once, and only the library copy should react here).
    const el = document.querySelector(`#game-grid [data-id="${CSS.escape(gameId)}"], #game-list [data-id="${CSS.escape(gameId)}"]`);
    if (el) {
      const on = selectedIds.has(gameId);
      el.classList.toggle("selected", on);
      const cb = el.querySelector(".select-toggle input");
      if (cb) cb.checked = on;
    }
    renderTopbarActionsState();
  }

  function confirmBulkDelete() {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    const backdrop = document.getElementById("core-modal-backdrop");
    const body = document.getElementById("core-modal-body");
    body.innerHTML = `
      <h2>Delete ${ids.length} game${ids.length === 1 ? "" : "s"}?</h2>
      <p class="modal-sub">This also removes any save states/save files for them. This can't be undone.</p>
      <div class="row">
        <button class="btn ghost" id="bulk-delete-cancel">Cancel</button>
        <button class="btn danger" id="bulk-delete-confirm">Delete</button>
      </div>
    `;
    backdrop.hidden = false;
    body.querySelector("#bulk-delete-cancel").addEventListener("click", () => (backdrop.hidden = true));
    body.querySelector("#bulk-delete-confirm").addEventListener("click", async () => {
      await RBDB.deleteGames(ids);
      backdrop.hidden = true;
      toast(`Deleted ${ids.length} game${ids.length === 1 ? "" : "s"}`);
      selectMode = false;
      selectedIds.clear();
      renderTopbarActionsState();
      renderLibrary();
    });
  }

  // ---------- sorting / filtering ----------

  function matchesSearch(game) {
    if (!searchTerm) return true;
    return game.title.toLowerCase().includes(searchTerm.toLowerCase());
  }

  function sortGames(list, mode) {
    const sorted = list.slice();
    if (mode === "recentlyAdded") {
      sorted.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (mode === "recentlyPlayed") {
      sorted.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    } else if (mode === "mostPlayed") {
      sorted.sort((a, b) => (b.playtimeSeconds || 0) - (a.playtimeSeconds || 0));
    } else if (mode === "system") {
      sorted.sort((a, b) => {
        const nameOf = (g) => (RB_SYSTEMS.find((s) => s.id === g.systemId) || {}).name || g.systemId;
        return nameOf(a).localeCompare(nameOf(b)) || a.title.localeCompare(b.title);
      });
    } else {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
    }
    return sorted;
  }

  function currentGameSet(games) {
    let list = baseGameSet(games);
    if (activeSystemFilter) list = list.filter((g) => g.systemId === activeSystemFilter);
    list = list.filter(matchesSearch);
    return sortGames(list, sortMode);
  }

  function emptyMessage() {
    if (favoritesOnly) return "Star a game from your library and it'll show up here.";
    if (searchTerm) return "No games match your search.";
    if (activeSystemFilter) return "No games for this console yet.";
    return "Import a ROM to get started — use the Add Game button up top, or drag a file anywhere in the window.";
  }

  // ---------- Recent Games hero ----------

  // The blurred backdrop behind the hero section -- defaults to the most
  // recently played game, and swaps to whatever card is currently active
  // (hovered, or moved to via arrow keys/Tab).
  function setHeroAmbient(url) {
    const bg = document.getElementById("hero-ambient-bg");
    if (!bg) return;
    if (url) {
      bg.style.backgroundImage = `url(${url})`;
      bg.classList.add("visible");
    } else {
      bg.classList.remove("visible");
    }
  }

  function setHeroActiveItem(row, el) {
    row.querySelectorAll(".hero-item.active").forEach((a) => a.classList.remove("active"));
    if (el) el.classList.add("active");
  }

  // When the pointer/focus leaves the row entirely, falls back to
  // whatever's still genuinely focused inside it, or the default
  // (most-recent) item otherwise -- not just "nothing," so the hero
  // always has exactly one clearly active/large item, matching "make the
  // one you're pointed at the big one, others smaller."
  function reconcileHeroActive(row, defaultUrl) {
    const focused = row.querySelector(".hero-item:focus");
    if (focused) return;
    setHeroActiveItem(row, row.querySelector(".hero-item"));
    setHeroAmbient(defaultUrl);
  }

  function wireHeroRowInteractivity(row, items, defaultUrl) {
    items.forEach(({ el, game }) => {
      const activate = () => {
        setHeroActiveItem(row, el);
        setHeroAmbient(getArtUrl(game));
      };
      el.addEventListener("mouseenter", activate);
      el.addEventListener("focus", activate);
    });
    row.addEventListener("mouseleave", () => reconcileHeroActive(row, defaultUrl));
    row.addEventListener("focusout", () => {
      // Deferred a tick: if focus is moving to ANOTHER item in this same
      // row, that item's own "focus" handler above already re-activated
      // it by the time this runs, so reconcile below is a no-op for that
      // case -- it only matters when focus left the row entirely.
      requestAnimationFrame(() => reconcileHeroActive(row, defaultUrl));
    });

    // Real left/right browsing, not just decoration -- Tab already moved
    // focus item-to-item via normal DOM order; this adds the dedicated
    // arrow-key navigation actually asked for.
    row.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const els = items.map((i) => i.el);
      const current = document.activeElement && document.activeElement.closest(".hero-item");
      let idx = els.indexOf(current);
      if (idx === -1) idx = els.findIndex((el) => el.classList.contains("active"));
      if (idx === -1) return;
      e.preventDefault();
      const nextIdx = e.key === "ArrowRight" ? Math.min(idx + 1, els.length - 1) : Math.max(idx - 1, 0);
      els[nextIdx].focus();
    });
  }

  // Capped so a very long play history doesn't turn this into an
  // unbounded strip -- it's a "recents" glance, not another full list.
  const HERO_MAX_ITEMS = 14;

  function renderRecentHero() {
    const section = document.getElementById("hero-recent");
    const content = document.getElementById("hero-content");
    const played = gamesCache
      .filter((g) => g.lastPlayedAt)
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, HERO_MAX_ITEMS);
    content.innerHTML = "";

    if (played.length === 0) {
      section.classList.add("hidden");
      setHeroAmbient(null);
      return;
    }
    section.classList.remove("hidden");

    const defaultUrl = getArtUrl(played[0]);
    setHeroAmbient(defaultUrl);

    const row = document.createElement("div");
    row.className = "hero-row";
    const items = played.map((game) => {
      const el = renderHeroItem(game);
      row.appendChild(el);
      return { el, game };
    });
    items[0].el.classList.add("active");
    wireHeroRowInteractivity(row, items, defaultUrl);
    content.appendChild(row);

    updateHeroScrollHint();
  }

  function updateHeroScrollHint() {
    const content = document.getElementById("hero-content");
    const hint = document.getElementById("hero-scroll-hint");
    hint.classList.toggle("hidden", content.scrollWidth <= content.clientWidth + 4);
  }

  // ---------- game item rendering (grid card / list row / hero variants) ----------

  function artCodeFor(game, sys) {
    return (sys ? sys.id : game.systemId || "?").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase();
  }

  // select-mode's checkbox overlay only ever applies to the library grid/
  // list (selectable:true) -- the Recent Games hero always shows the
  // normal favorite/delete overlay regardless of global select-mode state,
  // since bulk-selecting from the hero was never really a thing.
  function overlayMarkup(game, selectable) {
    if (selectable && selectMode) {
      return `<label class="select-toggle">
        <input type="checkbox" ${selectedIds.has(game.id) ? "checked" : ""} />
        <span class="select-check"><svg width="12" height="12"><use href="#icon-check"/></svg></span>
      </label>`;
    }
    return `<button class="delete-toggle" title="Delete"><svg width="13" height="13"><use href="#icon-trash"/></svg></button>
      <button class="fav-toggle ${game.favorite ? "active" : ""}" title="Favorite"><svg width="14" height="14"><use href="#icon-star"/></svg></button>`;
  }

  // Shared click/dblclick/rightclick/select-mode wiring for EVERY game
  // item -- grid card, list row, hero featured card, hero row item alike.
  // Not forked per display mode: a markup refactor that duplicated this
  // per-renderer is exactly how the label/checkbox 3-click bug (see the
  // preventDefault() below) could silently come back.
  function attachGameCardInteractions(el, game, { selectable = true } = {}) {
    if (selectable && selectMode) {
      // A <label> wrapping a checkbox has a browser-native DEFAULT ACTION
      // of forwarding a click to its associated control -- this fires a
      // fully separate, independent second click-and-toggle on the input
      // AFTER the original click has already bubbled through and been
      // handled once, undoing it. preventDefault() on the label's own
      // click cancels that forwarding default action outright, while
      // letting the event keep bubbling normally to this element's own
      // listener exactly once. Load-bearing -- this is the actual fix for
      // a real "it takes 3 clicks to select a game" bug found earlier.
      el.querySelector(".select-toggle").addEventListener("click", (e) => e.preventDefault());
      el.addEventListener("click", () => toggleSelect(game.id));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleSelect(game.id);
        }
      });
      return;
    }

    el.querySelector(".fav-toggle").addEventListener("click", async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const updated = await RBDB.updateGame(game.id, { favorite: !game.favorite });
      btn.classList.toggle("active", updated.favorite);
      renderLibrary();
    });
    el.querySelector(".delete-toggle").addEventListener("click", (e) => {
      e.stopPropagation();
      confirmDeleteGame(game);
    });

    const launch = () => RBPlayer.launch(game.id);

    // A single click launches the game; right-click or double-click opens
    // the options menu (both work, right-click is the one most people
    // reach for first). The short delay on the launch click is what lets
    // the browser tell a click from a double-click apart -- a plain click
    // always fires before dblclick does, so without the delay both would
    // fire and the game would launch AND the menu would open together.
    el.addEventListener("click", () => {
      if (el._clickTimer) return;
      el._clickTimer = setTimeout(() => {
        el._clickTimer = null;
        launch();
      }, 240);
    });
    // Basic keyboard/gamepad-hint support: Tab (native focus order) or
    // click both focus an item, Enter/Space launches it -- not a full
    // spatial-navigation system (d-pad doesn't move focus), just enough
    // that the bottom bar's "Play" hint has something real to act on.
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        launch();
      }
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (el._clickTimer) {
        clearTimeout(el._clickTimer);
        el._clickTimer = null;
      }
      RBGameMenu.open(game.id);
    });
    el.addEventListener("dblclick", (e) => {
      e.preventDefault();
      if (el._clickTimer) {
        clearTimeout(el._clickTimer);
        el._clickTimer = null;
      }
      RBGameMenu.open(game.id);
    });
  }

  function renderGameCard(game, showPlaytime) {
    const sys = RB_SYSTEMS.find((s) => s.id === game.systemId);
    const card = document.createElement("div");
    card.className = "game-item game-card" + (selectMode && selectedIds.has(game.id) ? " selected" : "");
    card.dataset.id = game.id;
    card.tabIndex = 0;

    const artUrl = getArtUrl(game);
    const artInner = artUrl ? `<img src="${artUrl}" alt="" />` : `<span class="art-code">${escapeHtml(artCodeFor(game, sys))}</span>`;
    const playtimeBadge = showPlaytime ? `<div class="playtime-badge">${formatPlaytime(game.playtimeSeconds || 0)}</div>` : "";

    card.innerHTML = `
      ${overlayMarkup(game, true)}
      <div class="art">${artInner}</div>
      <div class="title">${escapeHtml(game.title)}</div>
      <div class="system">${sys ? escapeHtml(sys.name) : escapeHtml(game.systemId)}</div>
      ${playtimeBadge}
    `;
    attachGameCardInteractions(card, game, { selectable: true });
    return card;
  }

  function renderGameRow(game, showPlaytime) {
    const sys = RB_SYSTEMS.find((s) => s.id === game.systemId);
    const row = document.createElement("div");
    row.className = "game-item game-row" + (selectMode && selectedIds.has(game.id) ? " selected" : "");
    row.dataset.id = game.id;
    row.tabIndex = 0;

    const artUrl = getArtUrl(game);
    const artInner = artUrl ? `<img src="${artUrl}" alt="" />` : `<span class="art-code">${escapeHtml(artCodeFor(game, sys))}</span>`;
    const playtimeBadge = showPlaytime ? `<span class="row-playtime">${formatPlaytime(game.playtimeSeconds || 0)}</span>` : "";

    row.innerHTML = `
      <div class="row-art">${artInner}</div>
      <div class="row-info">
        <div class="title">${escapeHtml(game.title)}</div>
        <div class="system">${sys ? escapeHtml(sys.name) : escapeHtml(game.systemId)}</div>
      </div>
      ${playtimeBadge}
      <div class="row-overlay">${overlayMarkup(game, true)}</div>
    `;
    attachGameCardInteractions(row, game, { selectable: true });
    return row;
  }

  // One uniform card shape for every hero item -- which one is big is now
  // purely a matter of the .active class (set on hover/focus, see
  // wireHeroRowInteractivity above), not a separate "featured" element
  // with its own bigger markup like before.
  function renderHeroItem(game) {
    const sys = RB_SYSTEMS.find((s) => s.id === game.systemId);
    const card = document.createElement("div");
    card.className = "game-item game-card hero-item";
    card.dataset.id = game.id;
    card.tabIndex = 0;

    const artUrl = getArtUrl(game);
    const artInner = artUrl ? `<img src="${artUrl}" alt="" />` : `<span class="art-code">${escapeHtml(artCodeFor(game, sys))}</span>`;

    card.innerHTML = `
      ${overlayMarkup(game, false)}
      <div class="art">${artInner}</div>
      <div class="title">${escapeHtml(game.title)}</div>
      <div class="system">${sys ? escapeHtml(sys.name) : escapeHtml(game.systemId)}</div>
      <div class="hero-playtime">${formatPlaytime(game.playtimeSeconds || 0)} played</div>
    `;
    attachGameCardInteractions(card, game, { selectable: false });
    return card;
  }

  // ---------- library render ----------

  async function renderLibrary() {
    gamesCache = await RBDB.getAllGames();
    renderRecentHero();
    renderConsoleChips();
    updateFavoritesOptionCount();
    renderTopbarActionsState();

    const list = currentGameSet(gamesCache);
    const grid = document.getElementById("game-grid");
    const listEl = document.getElementById("game-list");
    const empty = document.getElementById("library-empty");
    grid.innerHTML = "";
    listEl.innerHTML = "";

    if (list.length === 0) {
      empty.classList.remove("hidden");
      grid.classList.add("hidden");
      listEl.classList.add("hidden");
      empty.querySelector("p").textContent = emptyMessage();
      empty.querySelector("#empty-add-game").classList.toggle("hidden", favoritesOnly || !!activeSystemFilter || !!searchTerm);
      return;
    }
    empty.classList.add("hidden");

    const showPlaytime = sortMode === "mostPlayed";
    if (displayMode === "list") {
      grid.classList.add("hidden");
      listEl.classList.remove("hidden");
      list.forEach((game) => listEl.appendChild(renderGameRow(game, showPlaytime)));
    } else {
      listEl.classList.add("hidden");
      grid.classList.remove("hidden");
      list.forEach((game) => grid.appendChild(renderGameCard(game, showPlaytime)));
    }
  }

  function confirmDeleteGame(game) {
    const backdrop = document.getElementById("core-modal-backdrop");
    const body = document.getElementById("core-modal-body");
    body.innerHTML = `
      <h2>Delete "${escapeHtml(game.title)}"?</h2>
      <p class="modal-sub">This also removes any save states/save file for it. This can't be undone.</p>
      <div class="row">
        <button class="btn ghost" id="delete-cancel">Cancel</button>
        <button class="btn danger" id="delete-confirm">Delete</button>
      </div>
    `;
    backdrop.hidden = false;
    body.querySelector("#delete-cancel").addEventListener("click", () => (backdrop.hidden = true));
    body.querySelector("#delete-confirm").addEventListener("click", async () => {
      await RBDB.deleteGame(game.id);
      backdrop.hidden = true;
      toast(`Deleted "${game.title}"`);
      renderLibrary();
    });
  }

  // ---------- core list (opened from Settings) ----------

  function renderCoreListInto(wrap) {
    wrap.innerHTML = "";
    const bySystem = {};
    RB_CORE_LIST.forEach((c) => {
      bySystem[c.system] = bySystem[c.system] || [];
      bySystem[c.system].push(c);
    });
    Object.keys(bySystem)
      .sort()
      .forEach((systemName) => {
        const cores = bySystem[systemName];
        const card = document.createElement("div");
        card.className = "settings-card";
        card.style.marginBottom = "10px";
        card.innerHTML = `<h3>${escapeHtml(systemName)}</h3>`;
        cores.forEach((c) => {
          const row = document.createElement("div");
          row.className = "toggle-row";
          row.style.cursor = "pointer";
          row.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="badge ${c.available ? "ok" : "stub"}">${c.available ? "Playable" : "Not available"}</span>`;
          row.addEventListener("click", () => showCoreDetail(c));
          card.appendChild(row);
        });
        wrap.appendChild(card);
      });
  }

  function openCoreList() {
    const backdrop = document.getElementById("core-modal-backdrop");
    const body = document.getElementById("core-modal-body");
    body.innerHTML = `
      <h2>Core List</h2>
      <p class="modal-sub">Every system anyone might want. <span class="badge ok">green</span> runs today in this build. <span class="badge stub">amber</span> doesn't — tap one for the honest reason, which is different for each: some genuinely have no browser-ready emulator anywhere yet, some are blocked on licensing, and a few (like Switch, PS3, Wii U) are permanent no's, not "coming later."</p>
      <div id="core-table"></div>
      <div class="row"><button class="btn ghost" id="core-list-close">Close</button></div>
    `;
    renderCoreListInto(body.querySelector("#core-table"));
    backdrop.hidden = false;
    body.querySelector("#core-list-close").addEventListener("click", () => (backdrop.hidden = true));
  }

  function showCoreDetail(core) {
    const backdrop = document.getElementById("core-modal-backdrop");
    const body = document.getElementById("core-modal-body");
    body.innerHTML = `
      <h2>${escapeHtml(core.name)}</h2>
      <p class="modal-sub">${escapeHtml(core.system)}</p>
      <p style="font-size:13.5px; color:var(--ink-800); line-height:1.5;">
        ${core.available
          ? "This core runs today, right in the browser, powered by the open-source EmulatorJS/libretro project."
          : (core.note || "Not available in B-NAN right now.")}
      </p>
      <div class="row"><button class="btn ghost" id="core-detail-back">Back to list</button></div>
    `;
    backdrop.hidden = false;
    body.querySelector("#core-detail-back").addEventListener("click", openCoreList);
  }

  // ---------- settings ----------

  function renderSettings() {
    const grid = document.getElementById("settings-grid");
    grid.innerHTML = "";
    RBSettings.renderInto(grid);
  }

  return {
    openSettings,
    closeSettings,
    goHome,
    setSortMode,
    setDisplayMode,
    loadPrefs,
    renderLibrary,
    toast,
    setSearch(term) {
      searchTerm = term;
      renderLibrary();
    },
    toggleSelectMode,
    toggleSelectAll,
    cancelSelect,
    confirmBulkDelete,
    confirmDeleteGame,
    openCoreList,
    escapeHtml,
    downloadBlob,
  };
})();
