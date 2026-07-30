/* B-NAN backup/restore — bundles every save state into one .zip
   the player can keep, move to a new machine, or drop into cloud
   storage (Dropbox/iCloud/whatever) by hand. */

const RBBackup = (() => {
  async function exportAll() {
    const games = await RBDB.getAllGames();
    const files = {};
    const manifest = { exportedAt: Date.now(), games: [] };

    for (const game of games) {
      const states = await RBDB.getStatesForGame(game.id);
      if (states.length === 0) continue;
      const entry = { id: game.id, title: game.title, systemId: game.systemId, states: [] };
      for (const st of states) {
        const path = `saves/${game.id}/${st.slot}.state`;
        files[path] = new Uint8Array(await st.data.arrayBuffer());
        entry.states.push({ slot: st.slot, createdAt: st.createdAt, thumbnail: st.thumbnail || null });
      }
      manifest.games.push(entry);
    }

    if (manifest.games.length === 0) {
      RBUI.toast("No save states yet — nothing to back up.");
      return;
    }

    files["manifest.json"] = fflate.strToU8(JSON.stringify(manifest, null, 2));
    const zipped = fflate.zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: "application/zip" });
    const stamp = new Date().toISOString().slice(0, 10);
    RBUI.downloadBlob(blob, `bnan-backup-${stamp}.zip`);
    RBUI.toast("Backup saved to your Downloads folder.");
  }

  function promptImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.addEventListener("change", async () => {
      if (input.files.length) await importFile(input.files[0]);
    });
    input.click();
  }

  async function importFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let unzipped;
    try {
      unzipped = fflate.unzipSync(buf);
    } catch (err) {
      RBUI.toast("That didn't look like a B-NAN backup file.");
      return;
    }
    const manifestBytes = unzipped["manifest.json"];
    if (!manifestBytes) {
      RBUI.toast("No manifest.json found in that backup.");
      return;
    }
    const manifest = JSON.parse(fflate.strFromU8(manifestBytes));
    let restored = 0;
    for (const g of manifest.games) {
      for (const st of g.states) {
        const path = `saves/${g.id}/${st.slot}.state`;
        const bytes = unzipped[path];
        if (!bytes) continue;
        await RBDB.saveState({
          gameId: g.id,
          slot: st.slot,
          data: new Blob([bytes]),
          thumbnail: st.thumbnail || null,
          createdAt: st.createdAt || Date.now(),
        });
        restored++;
      }
    }
    RBUI.toast(`Restored ${restored} save state${restored === 1 ? "" : "s"}. Import the matching ROMs if you haven't already.`);
  }

  return { exportAll, promptImport };
})();
