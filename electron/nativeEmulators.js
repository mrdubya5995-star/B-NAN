/* Spawns and (on Windows) embeds B-NAN's native (non-browser) desktop
   emulators -- Dolphin, PCSX2, RPCS3, Cemu, xemu, Flycast, Vita3K.

   Architecture, decided explicitly after weighing the options:
     - Windows: TRUE embedding. The emulator's own top-level window gets
       reparented into B-NAN's window via Win32's SetParent (through
       node-window-manager, which wraps the real user32.dll call -- there
       is no such public API on macOS, which is why this branch is
       Windows-only), then resized/repositioned to exactly cover the
       #native-embed-target placeholder element the renderer reports.
     - macOS / Linux: a normal, separate OS window. macOS has no public
       window-reparenting API (only private/undocumented tricks or an
       IOSurface pixel-streaming rewrite of the emulator's own renderer,
       neither remotely stable enough to ship); Linux's X11 XEmbed would
       technically work but not on Wayland, and this app doesn't need two
       different embedding strategies for one platform B-NAN doesn't
       already treat as second-class here. A separate window is the
       honest, working answer for both.

   This file is written to run on a REAL build/dev machine -- it can't be
   exercised in the sandboxed environment this was authored in (no native
   emulator binaries were fetchable there, see tools/fetch-native-emulators.js
   and docs/NATIVE_EMULATORS.md for exactly why). `listAvailable()`
   degrades to an empty list if native/manifest.lock.json doesn't exist,
   so the app still runs fine without it -- it just won't offer native
   systems as playable, same as today. */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// electron-builder's "extraResources" (see package.json) copies native/
// to a "resources" folder that sits ALONGSIDE the packaged app's asar
// archive, not inside it -- process.resourcesPath points there. In dev
// (npm start, unpackaged) there is no asar and no resources folder at
// all, so this falls back to the plain project-relative path instead.
// Getting this wrong doesn't error loudly -- it just makes
// listAvailable() silently return nothing in a packaged build, which is
// exactly the kind of bug that only shows up after shipping.
//
// Computed lazily (not as a module-load-time const) -- verified by hand
// that requiring electron's `app` from THIS file at module-load time
// (rather than from electron/main.js, the actual entry point) came back
// undefined and crashed the whole app on startup. Reading it inside a
// function instead, on first real use, avoids whatever load-order this
// module doesn't control.
function nativeDir() {
  const { app } = require("electron");
  return app && app.isPackaged
    ? path.join(process.resourcesPath, "native")
    : path.join(__dirname, "..", "native");
}
function lockPath() {
  return path.join(nativeDir(), "manifest.lock.json");
}

// node-window-manager wraps real Win32 APIs (SetParent, SetWindowPos,
// GetWindowThreadProcessId, ...) on Windows and is a documented no-op
// stub on other platforms -- only ever actually invoked from the win32
// branch below, so requiring it unconditionally is safe.
let windowManager = null;
function getWindowManager() {
  if (windowManager) return windowManager;
  try {
    windowManager = require("node-window-manager").windowManager;
  } catch (e) {
    windowManager = null;
  }
  return windowManager;
}

function loadLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), "utf8"));
  } catch (e) {
    return {};
  }
}

// { <systemId>: { emulatorId, exePath (absolute), args } } for THIS platform only.
function listAvailable() {
  const lock = loadLock();
  const forPlatform = lock[process.platform] || {};
  const out = {};
  for (const [emulatorId, entry] of Object.entries(forPlatform)) {
    const absExePath = path.join(nativeDir(), entry.exePath);
    if (!fs.existsSync(absExePath)) continue; // lock file stale vs. what's actually on disk
    for (const systemId of entry.systems || []) {
      out[systemId] = { emulatorId, exePath: absExePath, args: entry.args || ["{romPath}"] };
    }
  }
  return out;
}

let runningChild = null; // one native game at a time, mirrors the web player's own model

function buildArgs(template, romPath) {
  return template.map((a) => (a === "{romPath}" ? romPath : a));
}

// bounds: { x, y, width, height } in the MAIN WINDOW's own screen
// coordinates, reported by the renderer for the #native-embed-target
// placeholder element it lays out in the player view. Held as a mutable
// object (liveBounds) rather than a plain argument so both the window's
// own 'resize' event AND fresh bounds pushed from the renderer via
// updateBounds() (e.g. the player view's layout shifting, not just the
// whole app window resizing) apply against the same current rectangle.
function embedOnWindows(pid, mainWindow, initialBounds) {
  const wm = getWindowManager();
  if (!wm) return false;

  const liveBounds = { ...initialBounds };
  const applyBounds = (win) => {
    try { win.setBounds({ x: liveBounds.x, y: liveBounds.y, width: liveBounds.width, height: liveBounds.height }); } catch (e) {}
  };

  // The emulator's own window may not exist yet the instant spawn()
  // returns (it still has to get through its own GPU/audio init) -- poll
  // briefly for a top-level window owned by this PID rather than assuming
  // it's there immediately.
  let attempts = 0;
  const tryEmbed = () => {
    attempts++;
    const win = wm.getWindows().find((w) => w.processId === pid);
    if (!win) {
      if (attempts < 100) setTimeout(tryEmbed, 100); // ~10s of polling before giving up
      return;
    }
    try {
      win.setParent(mainWindow.getNativeWindowHandle());
      applyBounds(win);
      const onResize = () => applyBounds(win);
      mainWindow.on("resize", onResize);
      if (runningChild) {
        runningChild.updateBounds = (next) => { Object.assign(liveBounds, next); applyBounds(win); };
        runningChild.onCleanup = () => mainWindow.removeListener("resize", onResize);
      }
    } catch (e) {
      console.error("[nativeEmulators] SetParent embed failed:", e);
    }
  };
  tryEmbed();
  return true;
}

function launch(systemId, romPath, mainWindow, bounds) {
  const available = listAvailable();
  const entry = available[systemId];
  if (!entry) throw new Error(`no native emulator ready for system "${systemId}"`);
  if (runningChild) throw new Error("a native emulator is already running -- close it before launching another");

  const args = buildArgs(entry.args, romPath);
  const child = spawn(entry.exePath, args, {
    cwd: path.dirname(entry.exePath),
    detached: process.platform !== "win32", // own process group on mac/linux so it survives independently of embedding attempts, which don't apply there
    stdio: "ignore",
  });
  runningChild = { child, systemId, onCleanup: null };
  child.on("exit", () => {
    if (runningChild && runningChild.onCleanup) runningChild.onCleanup();
    runningChild = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("native:exited", systemId);
  });
  // Without this, a spawn failure (e.g. the exe on disk is stale/corrupt
  // or missing permissions) fires an unhandled 'error' event, which Node
  // rethrows as an uncaught exception and takes down the whole main
  // process -- not just this one launch.
  child.on("error", (err) => {
    console.error("[nativeEmulators] failed to launch native emulator:", err);
    if (runningChild && runningChild.child === child) {
      if (runningChild.onCleanup) runningChild.onCleanup();
      runningChild = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("native:exited", systemId);
  });

  if (process.platform === "win32" && bounds) {
    embedOnWindows(child.pid, mainWindow, bounds);
    return { embedded: true };
  }
  return { embedded: false }; // mac/linux: it's just its own window now, nothing more to do
}

function updateBounds(bounds) {
  // Only meaningful mid-session on Windows (see embedOnWindows's resize
  // listener, which reads this closure's `bounds` by reference) -- a
  // no-op everywhere else.
  if (runningChild && runningChild.updateBounds) runningChild.updateBounds(bounds);
}

function stop() {
  if (!runningChild) return;
  try {
    // SIGTERM is a clean, standard shutdown request every one of these
    // emulators' underlying Qt/SDL frameworks already handles -- there's
    // no cross-platform equivalent of "ask a foreign GUI app to close its
    // window" beyond that without much deeper OS-specific work.
    if (process.platform === "win32") runningChild.child.kill();
    else process.kill(-runningChild.child.pid, "SIGTERM"); // negative pid = the whole detached group
  } catch (e) {
    /* already exited */
  }
}

// Native emulators are real OS processes reading a real file off disk --
// unlike the WASM cores, they can't be handed a Blob URL, and B-NAN
// itself only ever stores ROMs as Blobs inside IndexedDB (see db.js).
// This writes the bytes the renderer already has in memory out to a
// scratch file once per launch so a real path exists to hand the
// emulator's own argv. Not cleaned up automatically after exit -- these
// files live in the OS temp dir, which the OS already reclaims on its
// own schedule, and keeping the last-used copy around for a moment is
// harmless.
function writeTempRom(buffer, filename) {
  const dir = path.join(require("os").tmpdir(), "bnan-native-roms");
  fs.mkdirSync(dir, { recursive: true });
  const safeName = `${Date.now()}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const dest = path.join(dir, safeName);
  fs.writeFileSync(dest, Buffer.from(buffer));
  return dest;
}

function registerNativeIpc(ipcMain, getMainWindow) {
  ipcMain.handle("native:list", () => Object.keys(listAvailable()));
  ipcMain.handle("native:launch", (_evt, { systemId, romPath, bounds }) => {
    return launch(systemId, romPath, getMainWindow(), bounds);
  });
  ipcMain.handle("native:updateBounds", (_evt, bounds) => updateBounds(bounds));
  ipcMain.handle("native:stop", () => stop());
  ipcMain.handle("native:writeTempRom", (_evt, { buffer, filename }) => writeTempRom(buffer, filename));
}

module.exports = { listAvailable, launch, stop, updateBounds, registerNativeIpc };
