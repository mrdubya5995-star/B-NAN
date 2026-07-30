/* B-NAN ROM import — drag/drop or file picker, with .zip support.
   Everything stays local: files are read into IndexedDB as Blobs, never
   sent anywhere. Runs inside the "Add a Game" modal (opened from the +
   button on the Games topbar), but a drop anywhere in the window works
   too, matching the old behavior. */

const RBImport = (() => {
  const ARCHIVE_EXTS = ["zip"];

  function extOf(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(filename || "");
    return m ? m[1].toLowerCase() : "";
  }

  function guessSystem(filename) {
    const ext = extOf(filename);
    const matches = RB_SYSTEMS.filter((s) => s.extensions.includes(ext));
    if (matches.length === 0) return null;
    // prefer a system that actually has a playable core today
    return (matches.find((s) => s.available) || matches[0]).id;
  }

  function openAddGameModal() {
    document.getElementById("add-game-modal-backdrop").hidden = false;
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;
    // Real feedback for the slow part -- unzipping a big PS1/Saturn/PSP
    // disc image genuinely takes a few real seconds (see unzipAsync's own
    // comment), and without this it just looks like nothing happened.
    RBPlayer.showGenericLoading(
      files.length === 1 ? `Adding ${files[0].name}…` : `Adding ${files.length} files…`,
      { light: true }
    );
    try {
      for (const file of files) {
        await handleOneFile(file);
      }
    } finally {
      RBPlayer.hideLoading();
    }
  }

  async function handleOneFile(file) {
    const ext = extOf(file.name);
    if (ARCHIVE_EXTS.includes(ext)) {
      await handleZip(file);
    } else {
      await addGameAuto(file.name, file);
    }
  }

  // fflate's callback-based unzip(), not unzipSync() -- for a large
  // zipped ROM (PS1/Saturn/PSP discs commonly ship zipped, often several
  // hundred MB to a few GB), the sync version blocks the single main
  // thread for the entire decompression, freezing the whole page --
  // easily long enough to trip the browser's own "page unresponsive"
  // watchdog, and it needs the full compressed AND decompressed buffers
  // in memory at once. This is the real, findable cause behind "the
  // import doesn't work for bigger files" -- confirmed by reading the
  // code, not assumed. unzip() still does the same work on this thread
  // (this vendored build doesn't offload to a Worker), so it isn't
  // instant, but the page stays responsive and it isn't doubling memory
  // pressure at the same single instant the way sync decompression does.
  function unzipAsync(buf) {
    return new Promise((resolve, reject) => {
      fflate.unzip(buf, (err, data) => (err ? reject(err) : resolve(data)));
    });
  }

  async function handleZip(file) {
    log(`Reading ${file.name}…`);
    const buf = new Uint8Array(await file.arrayBuffer());
    let unzipped;
    try {
      unzipped = await unzipAsync(buf);
    } catch (err) {
      log(`Couldn't read ${file.name} as a zip: ${err.message}`, true);
      return;
    }
    const names = Object.keys(unzipped).filter((n) => !n.endsWith("/"));
    const romName = names.find((n) => guessSystem(n)) || names[0];
    if (!romName) {
      log(`${file.name} looks empty.`, true);
      return;
    }
    const bytes = unzipped[romName];
    const blob = new Blob([bytes]);
    await addGameAuto(romName.split("/").pop(), blob);
  }

  function log(msg, isError) {
    const el = document.getElementById("import-log");
    const line = document.createElement("div");
    line.style.fontSize = "12.5px";
    line.style.padding = "4px 2px";
    line.style.color = isError ? "var(--berry-600)" : "var(--ink-700)";
    line.textContent = msg;
    el.prepend(line);
  }

  // Adds a game straight to the library, no per-file "confirm this game"
  // step -- the guessed system (preferring one that's actually playable
  // today, see guessSystem above) and a cleaned-up title (extension
  // stripped, release tags like (USA)(En) stripped the same way artwork
  // matching does) are used as-is. If the extension doesn't match any
  // known system at all, this skips adding it rather than silently
  // guessing wrong with no way to fix it after the fact (there's no
  // "change system" option once a game's in the library).
  async function addGameAuto(filename, blob) {
    const systemId = guessSystem(filename);
    if (!systemId) {
      log(`Couldn't tell what system "${filename}" is for -- skipped.`, true);
      RBUI.toast(`Couldn't tell what system "${filename}" is for.`);
      return;
    }
    const system = RB_SYSTEMS.find((s) => s.id === systemId);
    const withoutExt = filename.replace(/\.[a-z0-9]+$/i, "");
    const title = RBArtwork.normalizeTitle(withoutExt) || withoutExt;

    const game = {
      id: RBDB.uid(),
      title,
      systemId,
      filename,
      size: blob.size,
      romBlob: blob,
      addedAt: Date.now(),
      lastPlayedAt: null,
      playCount: 0,
      playtimeSeconds: 0,
      favorite: false,
      artBlob: null,
      artSource: "none",
    };
    try {
      await RBDB.addGame(game);
    } catch (err) {
      log(`Couldn't add "${title}": ${err.message || err}`, true);
      RBUI.toast(`Couldn't add "${title}"`);
      return;
    }
    log(`Added "${title}" to your library (${system.name}).`);
    RBUI.toast(`Added "${title}"`);
    RBUI.renderLibrary();

    // Box art lookup happens after the game is already in the library and
    // visible -- it must never make "add a game" feel slower than it is.
    RBArtwork.autoFetch(game, system).then((found) => {
      if (found) RBUI.renderLibrary();
    });
  }

  function init() {
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("file-input");

    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
      })
    );
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });
    document.getElementById("btn-browse").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) handleFiles(e.target.files);
      fileInput.value = "";
    });

    document.getElementById("btn-add-game").addEventListener("click", openAddGameModal);
    document.getElementById("empty-add-game").addEventListener("click", openAddGameModal);
    document.getElementById("add-game-close").addEventListener("click", () => {
      document.getElementById("add-game-modal-backdrop").hidden = true;
    });

    // also allow dropping a ROM anywhere in the window
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      if (e.target.closest("#dropzone")) return;
      e.preventDefault();
      if (e.dataTransfer.files.length) {
        openAddGameModal();
        handleFiles(e.dataTransfer.files);
      }
    });
  }

  return { init };
})();
