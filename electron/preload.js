const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("RBNative", {
  platform: process.platform,
  isElectron: true,

  // Native (non-browser) desktop emulators -- see electron/nativeEmulators.js
  // for what's actually behind these. listAvailableNative() returns the
  // list of systemIds this specific build actually has a fetched-and-
  // bundled native emulator for (see tools/fetch-native-emulators.js) --
  // NOT the full wishlist, so B-NAN only ever offers to launch what's
  // really there. bounds must be the #native-embed-target element's
  // position in SCREEN coordinates (getBoundingClientRect() plus the
  // window's own screen offset) -- only load-bearing on Windows, where
  // the emulator's window gets reparented to sit exactly over it; ignored
  // elsewhere, where it just opens as its own separate window.
  listAvailableNative: () => ipcRenderer.invoke("native:list"),
  launchNative: (systemId, romPath, bounds) => ipcRenderer.invoke("native:launch", { systemId, romPath, bounds }),
  updateNativeBounds: (bounds) => ipcRenderer.invoke("native:updateBounds", bounds),
  stopNative: () => ipcRenderer.invoke("native:stop"),
  onNativeExited: (cb) => ipcRenderer.on("native:exited", (_evt, systemId) => cb(systemId)),
  // buffer must be an ArrayBuffer (not a Blob -- Blobs aren't structured-
  // cloneable across contextBridge) of the ROM's actual bytes; returns
  // the absolute path it was written to on disk.
  writeTempRom: (buffer, filename) => ipcRenderer.invoke("native:writeTempRom", { buffer, filename }),

  // Custom title bar controls -- see electron/windowChrome.js. The window
  // itself is created with frame:false (main.js), so these are the only
  // way to minimize/maximize/close at all; there's no OS-drawn fallback.
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeWindow: () => ipcRenderer.invoke("window:maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  onWindowMaximizedChanged: (cb) => ipcRenderer.on("window:maximized-changed", (_evt, isMaximized) => cb(isMaximized)),
});
