/* Wires the custom title bar's own minimize/maximize/close buttons (see
   .app-topbar in index.html) to the real window, via the IPC bridge in
   electron/windowChrome.js. In the browser (tools/serve.js, or B-NAN
   running as a plain web page/PWA) there's no window to control and no
   RBNative bridge at all -- same gating pattern player.js already uses
   for native-emulator features -- so the whole control cluster just
   hides itself instead of doing nothing when clicked. */

const RBWindowChrome = (() => {
  function initWindowChrome() {
    const controls = document.getElementById("window-controls");
    if (!controls) return;
    if (!window.RBNative || !window.RBNative.isElectron) {
      controls.classList.add("hidden");
      return;
    }

    const btnMin = document.getElementById("win-minimize");
    const btnMax = document.getElementById("win-maximize");
    const btnClose = document.getElementById("win-close");

    btnMin.addEventListener("click", () => window.RBNative.minimizeWindow());
    btnMax.addEventListener("click", () => window.RBNative.maximizeWindow());
    btnClose.addEventListener("click", () => window.RBNative.closeWindow());

    const btnMaxUse = btnMax.querySelector("use");
    function applyMaximizedState(isMaximized) {
      btnMax.title = isMaximized ? "Restore" : "Maximize";
      btnMaxUse.setAttribute("href", isMaximized ? "#icon-window-restore" : "#icon-window-max");
    }
    window.RBNative.isWindowMaximized().then(applyMaximizedState);
    window.RBNative.onWindowMaximizedChanged(applyMaximizedState);
  }

  return { initWindowChrome };
})();
