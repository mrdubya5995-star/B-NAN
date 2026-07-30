const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const http = require("http");
const { registerNativeIpc } = require("./nativeEmulators");
const { registerWindowIpc } = require("./windowChrome");
const { createHandler } = require("../tools/webStaticServer");

// Chromium throttles timers/rAF in backgrounded or unfocused renderers by
// default -- great for battery life, bad for an emulator whose audio and
// video loop needs to keep running smoothly. These switches (plus
// backgroundThrottling:false below) stop that throttling from kicking in.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

// EmulatorJS streams WASM and fetches core files at runtime -- that works
// far more reliably over http than over a raw file:// URL in Chromium, so
// the app spins up a tiny localhost-only static server instead of using
// loadFile() directly.
const WEB_ROOT = path.join(__dirname, "..", "web");

// Request handler (MIME map, COOP/COEP isolation headers, the /a8/ SPA
// fallback) lives in tools/webStaticServer.js -- shared with tools/serve.js,
// which used to be an independently maintained, byte-identical copy of
// this same logic (found in a codebase audit).
function startServer() {
  return new Promise((resolve) => {
    // Default header size limit (16KB) is too small for BBC Micro disc
    // images, passed to the vendored jsbeeb player as base64 in a query
    // string -- see player.js for why a blob: URL can't be used instead.
    const server = http.createServer({ maxHeaderSize: 8 * 1024 * 1024 }, createHandler(WEB_ROOT));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

let mainWindow;

async function createWindow() {
  const server = await startServer();
  const { port } = server.address();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#fff8e1",
    icon: path.join(WEB_ROOT, "assets", "icons", "banana-512.png"),
    title: "B-NAN",
    // No OS-drawn title bar -- the renderer draws its own (app-topbar in
    // index.html/styles.css) to match the reference layout exactly, with
    // real minimize/maximize/close wired through windowChrome.js's IPC.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  app.on("before-quit", () => server.close());
}

const menuTemplate = [
  ...(process.platform === "darwin"
    ? [{ label: "B-NAN", submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }] }]
    : []),
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "togglefullscreen" },
      { type: "separator" },
      { role: "toggledevtools" },
    ],
  },
];

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));
  await createWindow();
  registerNativeIpc(ipcMain, () => mainWindow);
  // Registered after createWindow() resolves (not fire-and-forget like the
  // line above used to be) because this one also attaches mainWindow's own
  // maximize/unmaximize listeners at registration time, not just inside
  // lazy ipcMain.handle callbacks -- it needs a real window to exist yet.
  registerWindowIpc(ipcMain, () => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  require("./nativeEmulators").stop(); // don't leave a native emulator running orphaned after B-NAN itself closes
  if (process.platform !== "darwin") app.quit();
});
