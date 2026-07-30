/* IPC for the app's own custom title bar (frame:false in main.js means
   there's no OS-drawn minimize/maximize/close anymore -- the renderer
   draws its own, and needs a way to actually control the real window).
   Same registerXIpc(ipcMain, getMainWindow) shape as nativeEmulators.js's
   registerNativeIpc, kept in its own file for the same reason that one
   is: a distinct concern, easy to find and reason about on its own. */

function registerWindowIpc(ipcMain, getMainWindow) {
  ipcMain.handle("window:minimize", () => {
    const win = getMainWindow();
    if (win) win.minimize();
  });
  ipcMain.handle("window:maximize", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("window:close", () => {
    const win = getMainWindow();
    if (win) win.close();
  });
  ipcMain.handle("window:isMaximized", () => {
    const win = getMainWindow();
    return !!win && win.isMaximized();
  });

  const win = getMainWindow();
  if (win) {
    win.on("maximize", () => win.webContents.send("window:maximized-changed", true));
    win.on("unmaximize", () => win.webContents.send("window:maximized-changed", false));
  }
}

module.exports = { registerWindowIpc };
