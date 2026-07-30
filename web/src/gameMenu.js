/* B-NAN game options menu — opens on double-click of a game card.
   Reuses the app's one generic modal (#core-modal-backdrop) rather than
   adding a new dialog element per screen; each "page" here is just a
   fresh innerHTML swap with its own Back/Close button. */

const RBGameMenu = (() => {
  function backdrop() {
    return document.getElementById("core-modal-backdrop");
  }
  function body() {
    return document.getElementById("core-modal-body");
  }
  function close() {
    backdrop().hidden = true;
  }
  const escapeHtml = RBUI.escapeHtml; // shared with ui.js -- was a byte-identical duplicate here

  async function open(gameId) {
    const game = await RBDB.getGame(gameId);
    if (!game) return;
    renderMain(game);
    backdrop().hidden = false;
  }

  function renderMain(game) {
    const sys = RB_SYSTEMS.find((s) => s.id === game.systemId);
    body().innerHTML = `
      <h2>${escapeHtml(game.title)}</h2>
      <p class="modal-sub">${sys ? escapeHtml(sys.name) : escapeHtml(game.systemId)}</p>
      <div class="game-menu-list">
        <button class="game-menu-item" data-action="artwork">Change Artwork</button>
        <button class="game-menu-item" data-action="rename">Rename</button>
        <button class="game-menu-item" data-action="states">View Save States</button>
        <button class="game-menu-item" data-action="import-save">Import Save File</button>
        <button class="game-menu-item" data-action="export-save">Export Save File</button>
        <button class="game-menu-item danger" data-action="delete">Delete</button>
      </div>
      <div class="row"><button class="btn ghost" data-action="close">Close</button></div>
    `;
    body().querySelectorAll("[data-action]").forEach((el) =>
      el.addEventListener("click", () => handleMainAction(el.dataset.action, game))
    );
  }

  async function handleMainAction(action, game) {
    if (action === "close") return close();
    if (action === "artwork") return renderArtworkChoice(game);
    if (action === "rename") return renderRename(game);
    if (action === "states") return renderStates(game);
    if (action === "import-save") return renderImportSave(game);
    if (action === "export-save") {
      close();
      return RBPlayer.exportSaveFile(game.id);
    }
    if (action === "delete") {
      close();
      return RBUI.confirmDeleteGame(game);
    }
  }

  // ---------- artwork ----------

  function renderArtworkChoice(game) {
    body().innerHTML = `
      <h2>Change Artwork</h2>
      <p class="modal-sub">${escapeHtml(game.title)}</p>
      <div class="row" style="justify-content:flex-start; gap:10px; margin-top:4px;">
        <button class="btn" data-action="from-files">From Files</button>
        <button class="btn" data-action="from-database">From Database</button>
      </div>
      <div class="row"><button class="btn ghost" data-action="back">Back</button></div>
    `;
    body().querySelector('[data-action="back"]').addEventListener("click", () => renderMain(game));
    body().querySelector('[data-action="from-files"]').addEventListener("click", () => pickArtFromFiles(game));
    body().querySelector('[data-action="from-database"]').addEventListener("click", () => renderArtFromDatabase(game));
  }

  function pickArtFromFiles(game) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      if (!input.files.length) return;
      const file = input.files[0];
      await RBDB.updateGame(game.id, { artBlob: file, artSource: "manual" });
      RBUI.toast(`Updated artwork for "${game.title}"`);
      RBUI.renderLibrary();
      close();
    });
    input.click();
  }

  function renderArtFromDatabase(game) {
    const sys = RB_SYSTEMS.find((s) => s.id === game.systemId);
    const suggested = RBArtwork.normalizeTitle(game.title);
    body().innerHTML = `
      <h2>Find in Database</h2>
      <p class="modal-sub">Searches thumbnails.libretro.com for ${sys ? escapeHtml(sys.name) : "this system"} by exact title.</p>
      <div class="field">
        <label for="art-search-title">Title to search</label>
        <input type="text" id="art-search-title" value="${escapeHtml(suggested)}" />
      </div>
      <div id="art-search-result"></div>
      <div class="row" style="justify-content:space-between;">
        <button class="btn ghost" data-action="back">Back</button>
        <button class="btn primary" data-action="search">Search</button>
      </div>
    `;
    body().querySelector('[data-action="back"]').addEventListener("click", () => renderArtworkChoice(game));
    body().querySelector('[data-action="search"]').addEventListener("click", () => runArtSearch(game, sys));
  }

  async function runArtSearch(game, sys) {
    const resultEl = body().querySelector("#art-search-result");
    const query = body().querySelector("#art-search-title").value.trim();
    if (!sys || !sys.thumbRepo) {
      resultEl.innerHTML = `<p class="modal-sub">No box art source is mapped for this system yet.</p>`;
      return;
    }
    resultEl.innerHTML = `<p class="modal-sub">Searching…</p>`;
    const found = await RBArtwork.lookup(sys, query);
    if (!found) {
      resultEl.innerHTML = `<p class="modal-sub">No match for "${escapeHtml(query)}" under ${escapeHtml(sys.name)} in the database (release-tag differences like (USA) vs (Europe) don't matter — this already ignores those on both sides). Double-check the system and spelling, or use "From Files" instead.</p>`;
      return;
    }
    const url = URL.createObjectURL(found.blob);
    resultEl.innerHTML = `
      <div style="display:flex; align-items:center; gap:12px; margin:10px 0;">
        <img src="${url}" alt="" style="width:72px; height:72px; object-fit:cover; border-radius:9px; border:2px solid var(--peel-300);" />
        <span style="font-size:13px; color:var(--ink-700);">Found a match for "${escapeHtml(found.matchedTitle)}".</span>
      </div>
      <div class="row" style="justify-content:flex-end;">
        <button class="btn primary" data-action="use-this">Use This Artwork</button>
      </div>
    `;
    resultEl.querySelector('[data-action="use-this"]').addEventListener("click", async () => {
      await RBDB.updateGame(game.id, { artBlob: found.blob, artSource: "database", artMatchedTitle: found.matchedTitle });
      RBUI.toast(`Updated artwork for "${game.title}"`);
      RBUI.renderLibrary();
      close();
    });
  }

  // ---------- rename ----------

  function renderRename(game) {
    body().innerHTML = `
      <h2>Rename</h2>
      <div class="field">
        <label for="rename-input">Title</label>
        <input type="text" id="rename-input" value="${escapeHtml(game.title)}" />
      </div>
      <div class="row" style="justify-content:space-between;">
        <button class="btn ghost" data-action="back">Back</button>
        <button class="btn primary" data-action="save">Save</button>
      </div>
    `;
    body().querySelector('[data-action="back"]').addEventListener("click", () => renderMain(game));
    const input = body().querySelector("#rename-input");
    input.addEventListener("keydown", (e) => e.key === "Enter" && save());
    body().querySelector('[data-action="save"]').addEventListener("click", save);
    async function save() {
      const title = input.value.trim();
      if (!title) return;
      await RBDB.updateGame(game.id, { title });
      RBUI.toast("Renamed.");
      RBUI.renderLibrary();
      close();
    }
  }

  // ---------- save states ----------

  async function renderStates(game) {
    const allStates = await RBDB.getStatesForGame(game.id);
    const states = allStates.filter((s) => s.slot !== "sram").sort((a, b) => {
      const rank = (s) => (s === "auto" ? -1 : s);
      return rank(a.slot) < rank(b.slot) ? -1 : 1;
    });
    const isPlaying = RBPlayer.isCurrentGame(game.id);
    body().innerHTML = `
      <h2>Save States</h2>
      <p class="modal-sub">${escapeHtml(game.title)}</p>
      ${states.length === 0 ? `<p class="modal-sub">Nothing here yet — this fills in with your auto-save once "Auto-save on exit" (Settings) saves your spot. Manual saves are a file now: use Save/Load in the pause menu while playing (Esc).</p>` : ""}
      <div class="states-list">
        ${states
          .map(
            (s) => `
          <div class="state-row" data-slot="${escapeHtml(String(s.slot))}">
            ${s.thumbnail ? `<img src="${s.thumbnail}" alt="" />` : `<div class="state-thumb-placeholder"></div>`}
            <div class="state-info">
              <span class="state-slot">${s.slot === "auto" ? "Auto-save" : `Slot ${s.slot}`}</span>
              <span class="state-date">${new Date(s.createdAt).toLocaleString()}</span>
            </div>
            <div class="state-actions">
              <button class="btn small" data-action="load" ${isPlaying ? "" : "disabled title=\"Launch this game first\""}>Load</button>
              <button class="btn small danger" data-action="delete">Delete</button>
            </div>
          </div>`
          )
          .join("")}
      </div>
      <div class="row"><button class="btn ghost" data-action="back">Back</button></div>
    `;
    body().querySelector('[data-action="back"]').addEventListener("click", () => renderMain(game));
    body().querySelectorAll(".state-row").forEach((row) => {
      const slot = row.dataset.slot === "auto" ? "auto" : parseInt(row.dataset.slot, 10);
      const loadBtn = row.querySelector('[data-action="load"]');
      if (loadBtn && !loadBtn.disabled) {
        loadBtn.addEventListener("click", () => {
          RBPlayer.loadFromSlot(slot);
          close();
        });
      }
      row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        await RBDB.deleteState(game.id, slot);
        renderStates(game);
      });
    });
  }

  // ---------- import save file ----------

  function renderImportSave(game) {
    body().innerHTML = `
      <h2>Import Save File</h2>
      <p class="modal-sub">${escapeHtml(game.title)}</p>
      <p style="font-size:13px; color:var(--ink-700); line-height:1.5;">
        This replaces the game's battery save (not a save state) — the same kind of file emulators call an SRAM or .srm save. If you're currently playing this game, it takes effect immediately.
      </p>
      <div class="row" style="justify-content:space-between;">
        <button class="btn ghost" data-action="back">Back</button>
        <button class="btn primary" data-action="choose">Choose File…</button>
      </div>
    `;
    body().querySelector('[data-action="back"]').addEventListener("click", () => renderMain(game));
    body().querySelector('[data-action="choose"]').addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "file";
      input.addEventListener("change", async () => {
        if (!input.files.length) return;
        await RBPlayer.importSaveFile(game.id, input.files[0]);
        close();
      });
      input.click();
    });
  }

  function init() {
    // clicking the shared backdrop (outside the modal) closes it -- already
    // wired globally in main.js for every .modal-backdrop.
  }

  return { init, open };
})();
