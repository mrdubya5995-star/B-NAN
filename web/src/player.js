/* B-NAN player — wraps EmulatorJS.

   EmulatorJS explicitly cannot be embedded directly into an SPA page (it
   assumes it owns the whole document and will fight our own DOM), so
   per their own guidance for React/SPA embedding, B-NAN loads it
   inside an <iframe> built fresh for each game. That also makes "exit
   and play something else" trivial: just throw the iframe away.

   Facts this file relies on (verified against EmulatorJS source, not
   guessed, incl. data/src/GameManager.js): EJS_gameUrl accepts a blob:
   object URL; save/load state and screenshots go through
   EJS_emulator.gameManager; battery/SRAM saves are a *separate* thing
   from save states, read/written via gameManager.getSaveFile() (sync,
   returns bytes or null) and gameManager.writeFile(path, data) +
   gameManager.loadSaveFiles() (path from gameManager.getSaveFilePath());
   video/perf knobs gameManager.setVSync(bool) and gameManager.toggleShader
   (bool) are real, callable methods.

   Rewind is deliberately not offered anywhere in this file -- it works
   by snapshotting emulator state every frame, which caused real,
   reported stutter/audio glitches, so it's disabled both in our own UI
   and in EmulatorJS's own built-in menu. Fast-forward was removed at the
   player's own request too (briefly replaced with a "Skip Intro"
   save-state bookmark, which was then also removed as unwanted) -- this
   app doesn't offer any playback-speed control as a feature.

   Two performance bugs found by hand after a real playtest (choppy
   audio + frame rate on a plain GBA game, which has no business being
   demanding):

   1. onGameStarted() used to unconditionally call gameManager.setVSync
   (true) on every boot. That's new behavior this app added -- it was
   never called before -- and forcibly locking video to the display's
   refresh rate is a well-known way to cause exactly this symptom: the
   display runs at a flat 60Hz but the emulated system doesn't (a GBA is
   ~59.7Hz), so the video and audio clocks slowly drift against each
   other under a strict lock, producing periodic crackle as the audio
   buffer over/underruns to catch up. Same reasoning applied to the
   smoothing shader toggle. Fix: both are now opt-in only -- the
   gameManager call is skipped entirely unless the player has explicitly
   turned the setting on in Settings, instead of being forced on/off on
   every single game start regardless of what the core's own (presumably
   already-sane) default was.

   2. A setInterval was flushing playtime to IndexedDB every 30s *while
   the game was running*, via a read-modify-write of the ENTIRE game
   record -- which includes the full ROM as a Blob, and now possibly a
   box-art Blob too. Structured-cloning multi-megabyte Blobs on a timer
   competes with the emulator core for main-thread time, which is
   exactly the kind of hitch that shows up as audio/video stutter. Fix:
   playtime is only written once, at exitPlayer() -- same as
   lastPlayedAt/playCount already were -- accepting that a hard crash
   loses at most that one session's playtime instead of trading away
   smooth gameplay for it. */

const RBPlayer = (() => {
  let currentGame = null;
  let currentSystem = null;
  let objectUrl = null;
  let sessionStartedAt = null;
  let isPaused = false;

  // The "stable" channel (the default, and what ~37 of B-NAN's systems
  // use) is vendored locally at web/vendor-emulatorjs/data/ -- a full copy
  // of the official EmulatorJS v4.2.3 release, not a build B-NAN wrote.
  // That means if cdn.emulatorjs.org ever goes away or changes what it
  // serves, every already-supported system keeps working exactly as it
  // does today, forever, with no network dependency at all for them.
  //
  // 3DS and Intellivision used to be the two exceptions -- too new for
  // ANY stable release, so they lived on the live "nightly" channel with
  // a real network dependency and a "may be unstable" warning. Fixed by
  // vendoring a SEPARATE, FROZEN snapshot of just those two cores' actual
  // nightly release (runtime JS/CSS + core WASM data, matched versions so
  // there's no runtime/core mismatch) at
  // web/vendor-emulatorjs-nightly/data/ -- same "permanently embedded,
  // zero network calls" guarantee "stable" already has, just taken from a
  // pinned nightly snapshot instead of a numbered release. This is
  // DELIBERATELY separate from plain "nightly" below, which stays
  // live-CDN-only on purpose: a player who explicitly picks "Nightly" in
  // Settings for every other system is asking for the bleeding, possibly
  // broken edge, and silently handing them a stale pinned snapshot
  // instead would defeat the entire point of that setting.
  function cdnBase(channel) {
    if (channel === "stable") return "/vendor-emulatorjs/data/";
    if (channel === "nightly-frozen") return "/vendor-emulatorjs-nightly/data/";
    return `https://cdn.emulatorjs.org/${channel}/data/`;
  }

  // Threading has gone back and forth twice now -- worth recording why,
  // since it's not obvious and easy to get backwards again:
  //
  // Round 1: opted a BROAD set of cores into threading, including
  // lightweight ones (NES, SNES, GB, ...), reasoning that running audio
  // off the main thread would generally help. Never actually verified
  // against real audio output (no speaker access in the environment that
  // change was made in).
  //
  // Round 2: a specific report ("audio is very slow, not just choppy")
  // pointed at the real risk with round 1 -- a threaded build hands the
  // core's ENTIRE main loop to a Web Worker synchronized via
  // SharedArrayBuffer, and for a lightweight core that never needed the
  // offload, that sync overhead can cost more than it buys, dragging
  // both audio and video down together. Reverted all the way to
  // `requiresThreads`-only (PSP, DOS, 3DS/azahar -- cores that literally
  // cannot run without threads at all).
  //
  // Round 3 (this one): that revert broke a DIFFERENT, worse case --
  // N64 (Mario 64) reported with a distinctive stretched/stuttering
  // sound (repeated fragments of each syllable), the textbook signature
  // of the audio buffer running dry because the main thread is too busy
  // to keep feeding it. N64 emulation is genuinely CPU/GPU-heavy, unlike
  // the lightweight 8/16-bit cores round 2 was really targeting --
  // exactly the case where offloading audio processing to a worker
  // thread has real headroom to gain rather than just sync overhead to
  // lose. THREAD_CAPABLE below is the middle ground: threading for cores
  // that are genuinely demanding enough to plausibly starve their own
  // audio pipeline on the main thread (3D-era and CD-based systems), not
  // for simple cartridge-era 8/16-bit ones, and not the broad opt-in
  // round 1 tried. Every core listed here was verified to actually have
  // a "<core>-thread-wasm.data" file in web/vendor-emulatorjs/data/cores/
  // before being added, not assumed.
  const THREAD_CAPABLE = new Set([
    "n64", "psx", "segaSaturn", "segaCD", "arcade", "mame", "3do", "amiga",
    "amigacd32", // same "amiga" emulatorjsCore/wasm files as amiga above (coreRegistry.js), just a CD-based mode of it -- same thread-capable core, was just missing from this list
  ]);

  function iframeDoc({ system, gameUrl, gameName, gameIdNum, settings }) {
    const channel = system.requiresChannel || settings.coreChannel || "stable";
    const dataPath = cdnBase(channel);
    const cfg = {
      threads: !!system.requiresThreads || THREAD_CAPABLE.has(system.id),
    };

    return `<!doctype html>
<html><head><meta charset="utf-8" />
<style>
  html,body{margin:0;padding:0;background:#000;height:100%;overflow:hidden;}
  #game{width:100%;height:100%;}
  /* Cursor hides itself after a couple seconds of no mouse movement --
     the same convention as any fullscreen video/game player (YouTube,
     Netflix, Steam Big Picture), driven by wakeCursor() below. This
     replaces an earlier all-or-nothing cursor:none that hid the pointer
     everywhere including EmulatorJS's own settings/cheats menu (needing a
     separate, selector-dependent watcher to detect that menu was open)
     and any letterboxed black-bar space around the game itself -- both
     real, reported "I can't find my cursor" bugs. Moving the mouse to
     reach the cheats menu, or anywhere else, now just naturally counts as
     "not idle" like everything else; nothing menu-specific to track. */
  body.cursor-idle, body.cursor-idle * { cursor: none !important; }
</style>
</head>
<body>
<div id="game"></div>
<script>
  // Esc is handled by B-NAN's own parent document, not EmulatorJS's
  // built-in menu (which is disabled entirely via EJS_Buttons below) --
  // this iframe just forwards the keypress up so the pause overlay
  // (which lives in the parent document, outside this iframe) can open.
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      parent.postMessage({ rb: 'escape' }, '*');
    }
  });
  // EmulatorJS's own callEvent() system (data/src/*.js) never fires
  // anything error-shaped -- only "ready"/"start"/"exit"/save-related
  // events. Known startup failures (bad graphics driver, core download
  // error, ...) are handled separately via startGameError(), which the
  // startupFailCheck poll below catches; this pair of listeners is for
  // the OTHER kind of failure -- a genuine uncaught exception or rejected
  // promise during boot that EmulatorJS itself never anticipated. Both
  // report back through the same postMessage channel into the parent's
  // existing generic rb-equals-error handler.
  window.addEventListener('error', function (e) {
    parent.postMessage({ rb: 'error', message: (e && e.message) || 'Unknown error while starting the core' }, '*');
  });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    parent.postMessage({ rb: 'error', message: (reason && reason.message) || String(reason || 'Unknown rejection while starting the core') }, '*');
  });
  var cursorIdleTimer = null;
  function wakeCursor() {
    document.body.classList.remove('cursor-idle');
    clearTimeout(cursorIdleTimer);
    cursorIdleTimer = setTimeout(function () {
      document.body.classList.add('cursor-idle');
    }, 2500);
  }
  document.addEventListener('mousemove', wakeCursor);
  document.addEventListener('mousedown', wakeCursor);
  wakeCursor();
  EJS_player = '#game';
  EJS_core = ${JSON.stringify(system.emulatorjsCore)};
  EJS_pathtodata = ${JSON.stringify(dataPath)};
  EJS_gameUrl = ${JSON.stringify(gameUrl)};
  EJS_gameName = ${JSON.stringify(gameName)};
  EJS_gameID = ${JSON.stringify(gameIdNum)};
  EJS_color = '#e0ab2a';
  EJS_backgroundColor = '#17140b';
  EJS_startOnLoaded = true;
  EJS_volume = ${JSON.stringify(settings.volume)};
  EJS_fullscreenOnLoaded = ${JSON.stringify(!!settings.startFullscreen)};
  EJS_threads = ${JSON.stringify(cfg.threads)};
  // Skip EmulatorJS's own content-database lookups -- B-NAN has its own
  // library/metadata, so this is pure boot-time work we don't need.
  EJS_disableDatabases = true;
  // Rewind stays off entirely -- it works by snapshotting emulator state
  // every frame, which is exactly the per-frame overhead that causes the
  // audio/video stutter this was built to avoid.
  EJS_defaultOptions = {
    'rewindEnabled': 'disabled',
    'slowMotion': 'disabled',
    'save-state-location': 'browser'
  };
  EJS_hideSettings = ['rewindEnabled', 'rewind-granularity', 'slowMotion', 'sm-ratio'];
  EJS_Buttons = {
    saveState: false,
    loadState: false,
    screenshot: false,
    quickSave: false,
    quickLoad: false,
    fullscreen: false,
    exitEmulation: false,
    fastForward: false,
    slowMotion: false
  };
  // Deliberately NOT wiring EJS_ready to anything -- verified against
  // EmulatorJS's own source (createStartButton in emulator.js): "ready"
  // fires ~20ms in, right after the start button element is created,
  // which is BEFORE the actual core/BIOS/ROM download even begins. It
  // does not mean "the game is playable" despite the name. EJS_onGameStart
  // (below) is the real "actually running now" signal -- callEvent("start")
  // only fires at the very end of startGame(), after the wasm core is
  // instantiated and the canvas is attached. Hiding B-NAN's own loading
  // screen on "ready" instead of this was a real bug: the loading screen
  // would vanish almost instantly, leaving whatever's underneath (a black
  // frame, or EmulatorJS's own unstyled "Download Game Core" / error text)
  // exposed for the entire real boot time.
  var startupFailCheck = setInterval(function () {
    if (window.EJS_emulator && window.EJS_emulator.failedToStart) {
      clearInterval(startupFailCheck);
      // EmulatorJS has its own internal failure messages for known cases
      // (outdated graphics driver, no WebGL2, core download error,
      // network error, ...) set directly on its own status text element
      // rather than thrown as a catchable JS error -- this is the only
      // way to actually see which one happened.
      var msg = (window.EJS_emulator.textElem && window.EJS_emulator.textElem.innerText) || 'Failed to start';
      parent.postMessage({ rb: 'error', message: msg }, '*');
    }
  }, 400);
  EJS_onGameStart = function () {
    clearInterval(startupFailCheck);
    parent.postMessage({ rb: 'started' }, '*');
  };
<\/script>
<script src="${dataPath}loader.js"><\/script>
</body></html>`;
  }

  function numericGameId(gameId) {
    let h = 0;
    for (let i = 0; i < gameId.length; i++) h = (h * 31 + gameId.charCodeAt(i)) >>> 0;
    return h || 1;
  }

  async function launch(gameId) {
    const game = await RBDB.getGame(gameId);
    if (!game) return;
    const system = RB_SYSTEMS.find((s) => s.id === game.systemId);
    if (!system || !system.available) {
      RBUI.toast(`${system ? system.name : game.systemId} isn't playable yet — see Core List in Settings.`);
      return;
    }

    currentGame = game;
    currentSystem = system;
    sessionStartedAt = Date.now();

    const playerView = document.getElementById("player-view");
    playerView.classList.toggle("alt-engine", !!system.altEngine);
    playerView.classList.toggle("native-engine", !!system.nativeEngine);
    setPaused(false);
    showLoading(system, game);

    if (system.nativeEngine) {
      await launchNative(game, system);
    } else if (system.altEngine) {
      await launchAltEngine(game, system);
    } else {
      await launchEmulatorJS(game, system);
    }

    playerView.hidden = false;

    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.add("player-active");

    await RBDB.updateGame(game.id, {
      lastPlayedAt: Date.now(),
      playCount: (game.playCount || 0) + 1,
    });
  }

  async function launchEmulatorJS(game, system) {
    const settings = await RBSettings.all();

    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(game.romBlob);

    const container = document.getElementById("ejs-container");
    container.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;";
    iframe.setAttribute("allow", "fullscreen; gamepad; autoplay");
    iframe.srcdoc = iframeDoc({
      system,
      gameUrl: objectUrl,
      gameName: game.title,
      gameIdNum: numericGameId(game.id),
      settings,
    });
    container.appendChild(iframe);
    RBPlayer._iframe = iframe;
  }

  // Systems with no browser-ready core at all (GameCube/Wii, PS2, Wii U,
  // Dreamcast, PS3, Xbox, PS Vita) -- covered only by a real native
  // desktop emulator (Dolphin/PCSX2/Cemu/Flycast/RPCS3/xemu/Vita3K),
  // bundled per tools/fetch-native-emulators.js and spawned by
  // electron/nativeEmulators.js. Only reachable at all when
  // system.available got flipped on by applyNativeAvailability() below,
  // which only happens once RBNative confirms this exact build actually
  // has that emulator bundled -- so this function itself doesn't need to
  // re-check "is this even possible", only "did launching it work".
  //
  // On Windows the native window gets truly reparented into this one
  // (see nativeEmulators.js's embedOnWindows) to sit over the
  // #native-embed-target placeholder created below. On macOS/Linux it's
  // just a separate OS window -- there's no public reparenting API on
  // macOS, and X11 XEmbed doesn't cover Wayland, so a second window is
  // the honest answer there instead of a shakier partial embed. One real
  // consequence of that: once the native window has OS focus, B-NAN's
  // own page can no longer see Esc keypresses (they go to the native
  // window instead) -- alt-tabbing back to B-NAN and using the pause
  // hint button, or closing the native window directly, are the ways
  // back, not Esc from inside it.
  async function launchNative(game, system) {
    // Native systems get their own placeholder text below instead of the
    // generic loading overlay -- redundant to show both.
    hideLoading();
    const container = document.getElementById("ejs-container");
    container.innerHTML = "";
    const placeholder = document.createElement("div");
    placeholder.id = "native-embed-target";
    placeholder.className = "native-embed-target";
    container.appendChild(placeholder);
    RBPlayer._iframe = null;
    RBPlayer._nativeSystemId = system.id;

    if (!window.RBNative || !window.RBNative.isElectron) {
      placeholder.textContent = `${system.name} needs the B-NAN desktop app — this is the browser version.`;
      return;
    }

    placeholder.textContent = `Starting ${system.name}…`;
    try {
      const bytes = new Uint8Array(await game.romBlob.arrayBuffer());
      const filename = game.filename || `${(game.title || "game").replace(/[^a-zA-Z0-9._-]/g, "_")}.bin`;
      const romPath = await window.RBNative.writeTempRom(bytes.buffer, filename);
      const rect = placeholder.getBoundingClientRect();
      const result = await window.RBNative.launchNative(system.id, romPath, {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
      placeholder.textContent = result && result.embedded
        ? ""
        : `${system.name} opened in its own window — this space is just a placeholder for it.`;
    } catch (e) {
      placeholder.textContent = `Couldn't launch ${system.name}: ${(e && e.message) || e}`;
    }
  }

  // Keeps a Windows-embedded native window glued to its placeholder as
  // B-NAN's own window is resized -- a no-op call on macOS/Linux (see
  // updateBounds in nativeEmulators.js), so it's safe to always send.
  function syncNativeBounds() {
    if (!RBPlayer._nativeSystemId || !window.RBNative) return;
    const el = document.getElementById("native-embed-target");
    if (!el) return;
    const rect = el.getBoundingClientRect();
    window.RBNative.updateNativeBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  // Systems that don't run through EmulatorJS at all -- ZX Spectrum
  // (jsspeccy3) and BBC Micro (jsbeeb), both vendored locally, both
  // GPL-3.0. Each has its own loading convention (verified against their
  // actual source, not guessed):
  //  - jsspeccy3's `openUrl` option does a plain fetch(), and a blob: URL
  //    created in this document is fetchable from a same-origin iframe
  //    (confirmed by hand with a throwaway test page) -- so a normal
  //    object URL works.
  //  - jsbeeb doesn't work the same way, for two reasons found by hand,
  //    not assumed: (1) its own query-string schema-sniffing
  //    (splitImage() in its source) breaks on a nested scheme like
  //    "blob:http://...", so a blob: URL never loads at all; (2) passing
  //    the disc image inline as base64 in the URL instead hits real
  //    transport limits well within normal disc-image sizes (HTTP 431
  //    from Node's default header cap, then a hard connection close even
  //    after raising it -- confirmed against a live request, not
  //    theorized). What actually works: jsbeeb already ships its own
  //    "load disc from local file" feature, a plain <input type="file"
  //    id="disc_load"> wired to a change handler in its source. Since the
  //    iframe is same-origin (vendored under B-NAN's own web root), that
  //    element is directly reachable -- so the disc's bytes are handed to
  //    jsbeeb's OWN real file-loading code via a synthetic DataTransfer
  //    (the standard, non-hacky way to feed a File into an <input> from
  //    script), the same path a user dragging a file onto that menu item
  //    would go through, instead of any bespoke parsing of B-NAN's own.
  //    A reset + simulated Shift-hold afterward reproduces jsbeeb's own
  //    autoboot() (confirmed by reading it: it's exactly a reset plus
  //    holding Shift for 1000ms, nothing more).
  async function launchAltEngine(game, system) {
    const container = document.getElementById("ejs-container");
    container.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000;";
    iframe.setAttribute("allow", "fullscreen; gamepad; autoplay");

    const eng = system.altEngine;
    if (eng.type === "jsspeccy3") {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(game.romBlob);
      iframe.src = `${eng.embedPath}?file=${encodeURIComponent(objectUrl)}`;
      container.appendChild(iframe);
      RBPlayer._iframe = iframe;
      iframe.addEventListener("load", hideLoading, { once: true });
    } else if (eng.type === "jsbeeb") {
      iframe.src = eng.embedPath;
      container.appendChild(iframe);
      RBPlayer._iframe = iframe;
      iframe.addEventListener("load", () => { loadJsbeebDisc(iframe, game); hideLoading(); }, { once: true });
    } else if (eng.type === "atari8bit") {
      // Sfotty Pie (vendored at web/a8/, see coreRegistry.js) is a
      // client-routed SPA whose own <Route> paths are hardcoded absolute
      // strings like "/a8/emu" -- not relative to wherever it's mounted.
      // Rather than patch their router, it's vendored at exactly the path
      // its own routes already expect, with a matching URL-rewrite rule
      // in tools/serve.js / electron/main.js so /a8/emu (which isn't a
      // real file) still serves its index.html.
      iframe.src = eng.embedPath;
      container.appendChild(iframe);
      RBPlayer._iframe = iframe;
      iframe.addEventListener("load", () => { loadAtari8bitFile(iframe, game); hideLoading(); }, { once: true });
    } else if (eng.type === "retroarch-web") {
      // RetroArch's OWN official web player, vendored at
      // web/vendor-retroarch-web/ -- a real, different engine than
      // EmulatorJS (which wraps the same underlying libretro cores far
      // more lightly). Verified working end-to-end by hand before this
      // was wired up: WASM module loads, BrowserFS mounts, RetroArch
      // boots straight past its own menu via direct-launch argv, WebGL
      // renders (confirmed via a real GPU driver message, not a frozen
      // canvas). See embed.html's own header comment for the full story.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(game.romBlob);
      const filename = game.filename || `${game.title || "rom"}.bin`;
      iframe.src = `${eng.embedPath}?core=${encodeURIComponent(eng.core)}&file=${encodeURIComponent(objectUrl)}&filename=${encodeURIComponent(filename)}`;
      container.appendChild(iframe);
      RBPlayer._iframe = iframe;
    }

    // Same cursor-hiding + Esc-pauses behavior as the EmulatorJS iframe
    // (see iframeDoc above), but these three engines are vendored,
    // same-origin *pages* rather than a srcdoc B-NAN itself writes, so
    // there's no template to bake it into up front -- it's injected once
    // the page has actually loaded instead.
    iframe.addEventListener("load", () => attachAltEngineChrome(iframe), { once: true });
  }

  function attachAltEngineChrome(iframe) {
    try {
      const doc = iframe.contentDocument;
      if (doc) {
        // Idle-timeout cursor hiding, same mechanism and reasoning as the
        // EmulatorJS iframe in iframeDoc() above -- see the comment there.
        // A static cursor:none here made these engines' own in-game menus
        // (jsbeeb's disc-load menu, etc.) impossible to see the pointer in.
        const style = doc.createElement("style");
        style.textContent = "body.cursor-idle, body.cursor-idle *{cursor:none !important;}";
        (doc.head || doc.documentElement).appendChild(style);
        let idleTimer = null;
        const wakeCursor = () => {
          if (!doc.body) return;
          doc.body.classList.remove("cursor-idle");
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => doc.body.classList.add("cursor-idle"), 2500);
        };
        doc.addEventListener("mousemove", wakeCursor);
        doc.addEventListener("mousedown", wakeCursor);
        wakeCursor();
      }
    } catch (e) {
      /* cross-origin or torn-down iframe -- nothing to inject into */
    }
    try {
      const win = iframe.contentWindow;
      if (win) {
        win.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            togglePause();
          }
        });
      }
    } catch (e) {
      /* same */
    }
  }

  function loadJsbeebDisc(iframe, game) {
    try {
      const doc = iframe.contentDocument;
      const input = doc.getElementById("disc_load");
      if (!input) return; // jsbeeb's own markup changed underneath us -- fail quiet, not broken
      // Built with this document's own constructors, not the iframe's --
      // File/DataTransfer/KeyboardEvent don't need to come from the target
      // realm to be valid there, and reaching into contentWindow for them
      // turned out to be flaky (KeyboardEvent specifically threw
      // "not a constructor" via contentWindow in testing).
      const file = new File([game.romBlob], game.filename || game.title || "disc.ssd");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));

      const resetBtn = doc.getElementById("hard-reset");
      setTimeout(() => {
        if (resetBtn) resetBtn.click();
        const target = doc.body;
        const shiftDown = new KeyboardEvent("keydown", { key: "Shift", code: "ShiftLeft", keyCode: 16, which: 16, shiftKey: true, bubbles: true });
        const shiftUp = new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft", keyCode: 16, which: 16, shiftKey: false, bubbles: true });
        target.dispatchEvent(shiftDown);
        setTimeout(() => target.dispatchEvent(shiftUp), 1000);
      }, 300); // give the disc a moment to actually mount before resetting
    } catch (e) {
      /* best-effort -- if jsbeeb's internals ever change shape, the player still
         opens and the user can load the disc themselves via its own file menu */
    }
  }

  // sfotty-pie (Atari 8-bit) is a client-rendered Preact SPA -- unlike
  // jsbeeb, the file input isn't in the static HTML at all, it only
  // exists once the app has hydrated. Its hidden <input type="file"> has
  // no id (verified against source: apps/a8-web/src/app.tsx), but it's
  // the only file input in the app, so a plain selector finds it. Feeding
  // it a file (same DataTransfer approach as jsbeeb) routes to the app's
  // own host.loadFile(), which boots the machine with it automatically --
  // no extra reset/keypress dance needed here, unlike jsbeeb.
  function loadAtari8bitFile(iframe, game, attempt) {
    attempt = attempt || 0;
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return;
    }
    const input = doc && doc.querySelector('input[type="file"]');
    if (!input) {
      if (attempt < 40) setTimeout(() => loadAtari8bitFile(iframe, game, attempt + 1), 125); // ~5s of retries while the SPA hydrates
      return;
    }
    try {
      const file = new File([game.romBlob], game.filename || game.title || "game.atr");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      /* best-effort -- if the app's internals ever change shape, the player still
         opens and the user can load the file themselves via its own picker */
    }
  }

  function ejs() {
    try {
      return RBPlayer._iframe && RBPlayer._iframe.contentWindow
        ? RBPlayer._iframe.contentWindow.EJS_emulator
        : null;
    } catch (e) {
      return null;
    }
  }

  // Called once the core signals it's actually running: applies quality/
  // perf settings the player explicitly opted into, and if the player
  // picked a save file from the library ("Import Save File" in the game
  // options menu), injects it now.
  //
  // VSync and the smoothing shader are deliberately opt-in only -- the
  // gameManager call is skipped entirely when off, rather than actively
  // forcing "off" on every boot. Forcing VSync on unconditionally used to
  // be the default here and caused real, reported audio crackle: locking
  // video to the display's flat 60Hz fights the emulated system's own
  // native rate (a GBA runs at ~59.7Hz), and that drift has to come out
  // somewhere -- it comes out as periodic audio buffer glitches.
  async function onGameStarted() {
    const inst = ejs();
    if (!inst || !inst.gameManager) return;
    const settings = await RBSettings.all();
    if (settings.vsyncEnabled) {
      try {
        inst.gameManager.setVSync(true);
      } catch (e) {}
    }
    if (settings.smoothingEnabled) {
      try {
        inst.gameManager.toggleShader(true);
      } catch (e) {}
    }
    if (currentGame) {
      try {
        const saved = await RBDB.getState(currentGame.id, "sram");
        if (saved) {
          const bytes = new Uint8Array(await saved.data.arrayBuffer());
          inst.gameManager.writeFile(inst.gameManager.getSaveFilePath(), bytes);
          inst.gameManager.loadSaveFiles();
        }
      } catch (e) {
        /* no stored save file, or the core doesn't support one -- fine, just play from scratch */
      }
    }
  }

  async function saveToSlot(slot) {
    const inst = ejs();
    if (!inst || !inst.gameManager) {
      RBUI.toast("Still loading — try again in a second.");
      return;
    }
    // Save the actual state first and confirm it — the thumbnail is a
    // nice-to-have and must never be allowed to block or break a save.
    // (EmulatorJS's screenshot() callback can fail to fire at all in some
    // rendering contexts, which used to hang this whole function forever.)
    const stateBytes = inst.gameManager.getState();
    const gameId = currentGame.id;
    await RBDB.saveState({ gameId, slot, data: new Blob([stateBytes]), thumbnail: null, createdAt: Date.now() });
    RBUI.toast(`Saved to Slot ${slot}`);

    // Fire-and-forget: a slow or stuck thumbnail must never delay anything
    // that's waiting on saveToSlot itself (e.g. exiting the player).
    Promise.race([
      new Promise((resolve, reject) => {
        inst.screenshot((blob) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("screenshot read failed"));
          reader.readAsDataURL(blob);
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("screenshot timeout")), 2000)),
    ])
      .then((thumbnail) => RBDB.saveState({ gameId, slot, data: new Blob([stateBytes]), thumbnail, createdAt: Date.now() }))
      .catch(() => {
        /* no thumbnail this time — the save itself already succeeded above */
      });
  }

  async function loadFromSlot(slot) {
    const inst = ejs();
    if (!inst || !inst.gameManager) {
      RBUI.toast("Still loading — try again in a second.");
      return;
    }
    const entry = await RBDB.getState(currentGame.id, slot);
    if (!entry) {
      RBUI.toast(`Nothing saved in Slot ${slot} yet.`);
      return;
    }
    const bytes = new Uint8Array(await entry.data.arrayBuffer());
    inst.gameManager.loadState(bytes);
    RBUI.toast(`Loaded Slot ${slot}`);
  }

  // The pause overlay's own Save/Load buttons -- deliberately NOT the same
  // as saveToSlot/loadFromSlot above (which stay, unchanged, for auto-save
  // and gameMenu.js's separate save-states browser). These write/read a
  // plain file instead of IndexedDB: no numbered slots to track or cycle
  // through, just "save state to a file" and "load a file back in", same
  // shape as exportSaveFile/importSaveFile already use for battery saves.
  function saveStateToFile() {
    const inst = ejs();
    if (!inst || !inst.gameManager) {
      RBUI.toast("Still loading — try again in a second.");
      return;
    }
    const stateBytes = inst.gameManager.getState();
    const title = (currentGame && currentGame.title) || "bnan";
    RBUI.downloadBlob(new Blob([stateBytes]), `${title}.state`);
    RBUI.toast("Save state downloaded.");
  }

  async function loadStateFromFile(file) {
    const inst = ejs();
    if (!inst || !inst.gameManager) {
      RBUI.toast("Still loading — try again in a second.");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    inst.gameManager.loadState(bytes);
    RBUI.toast("Save state loaded.");
  }

  function takeScreenshot() {
    const inst = ejs();
    if (!inst) return;
    inst.screenshot((blob) => {
      RBUI.downloadBlob(blob, `${(currentGame && currentGame.title) || "bnan"}-screenshot.png`);
    });
  }

  function toggleFullscreen() {
    const inst = ejs();
    if (inst && inst.toggleFullscreen) inst.toggleFullscreen(true);
    else if (RBPlayer._iframe && RBPlayer._iframe.requestFullscreen) RBPlayer._iframe.requestFullscreen();
  }


  // Persists accumulated playtime for the current session. Deliberately
  // called only once, at exit -- not on a timer during play, which used
  // to cause exactly the kind of audio/video stutter this file now
  // warns about above.
  async function flushPlaytime() {
    if (!currentGame || !sessionStartedAt) return;
    const now = Date.now();
    const elapsedSec = Math.round((now - sessionStartedAt) / 1000);
    sessionStartedAt = now;
    if (elapsedSec <= 0) return;
    await RBDB.incrementPlaytime(currentGame.id, elapsedSec);
  }

  // Best-effort silent sync of the in-game battery save back into B-NAN's
  // own storage, so "Export Save File" in the game options menu always
  // has the latest data without the player needing to remember to do
  // anything mid-session.
  async function syncSaveFile() {
    const inst = ejs();
    if (!inst || !inst.gameManager || !currentGame) return;
    try {
      const bytes = inst.gameManager.getSaveFile();
      if (!bytes || !bytes.length) return;
      await RBDB.saveState({ gameId: currentGame.id, slot: "sram", data: new Blob([bytes]), thumbnail: null, createdAt: Date.now() });
    } catch (e) {
      /* core has no battery save, or isn't ready -- fine */
    }
  }

  async function exitPlayer() {
    hideLoading(); // defensive -- covers exiting mid-load, so the next launch never inherits a stuck overlay
    // Same spinner, different text: auto-save below can still take a
    // moment for a large save state, and the frozen game frame sitting
    // there with zero feedback during that reads as "it's just hung,"
    // not "it's saving." No back button here on purpose -- unlike the
    // game-loading case, there's nothing to back out OF, this screen IS
    // the act of returning to the library.
    const loadingEl = document.getElementById("player-loading");
    if (loadingEl) {
      document.getElementById("player-loading-title").textContent = "Returning to library…";
      document.getElementById("player-loading-sub").textContent = "";
      loadingEl.hidden = false;
      const backBtn = document.getElementById("btn-loading-back");
      if (backBtn) backBtn.hidden = true;
    }
    if (RBPlayer._nativeSystemId) {
      if (window.RBNative) await window.RBNative.stopNative();
      RBPlayer._nativeSystemId = null;
    }
    // Save states / SRAM sync only mean anything for EmulatorJS games --
    // for alt-engine (jsspeccy3, jsbeeb, atari8bit) and native (Dolphin,
    // PCSX2, ...) systems ejs() always returns null, so these would
    // otherwise be silent no-ops at best and a misleading "still
    // loading" toast at worst (saveToSlot's own "still loading" toast
    // fires on a null gameManager, which native/alt-engine exits would
    // hit every single time otherwise).
    if (!currentSystem || (!currentSystem.altEngine && !currentSystem.nativeEngine)) {
      const settings = await RBSettings.all();
      if (settings.autoSaveOnExit && currentGame) {
        try {
          await saveToSlot("auto");
        } catch (e) {
          /* best-effort; don't block exiting on a save failure */
        }
      }
      await syncSaveFile();
    }
    await flushPlaytime();
    sessionStartedAt = null;
    if (loadingEl) loadingEl.hidden = true;
    document.getElementById("player-view").hidden = true;
    document.getElementById("player-view").classList.remove("alt-engine");
    document.getElementById("player-view").classList.remove("native-engine");
    const appEl = document.getElementById("app");
    if (appEl) appEl.classList.remove("player-active");
    document.getElementById("ejs-container").innerHTML = "";
    RBPlayer._iframe = null;
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    currentGame = null;
    currentSystem = null;
    RBUI.renderLibrary();
  }

  function isCurrentGame(gameId) {
    return !!currentGame && currentGame.id === gameId;
  }

  // Export the battery/SRAM save file for a game -- live from the running
  // core if it's the one currently playing, otherwise from the last synced
  // copy in storage.
  async function exportSaveFile(gameId) {
    let bytes = null;
    let title = gameId;
    if (isCurrentGame(gameId)) {
      await syncSaveFile();
      title = currentGame.title;
    }
    const game = await RBDB.getGame(gameId);
    if (game) title = game.title;
    const entry = await RBDB.getState(gameId, "sram");
    if (entry) bytes = new Uint8Array(await entry.data.arrayBuffer());
    if (!bytes || !bytes.length) {
      RBUI.toast("No save file yet — play the game at least once first.");
      return;
    }
    RBUI.downloadBlob(new Blob([bytes]), `${title}.srm`);
    RBUI.toast("Save file exported.");
  }

  // Import a battery/SRAM save file for a game -- applied live if it's
  // the one currently playing, and always stored so it's applied on the
  // next launch too (see onGameStarted above).
  async function importSaveFile(gameId, file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await RBDB.saveState({ gameId, slot: "sram", data: new Blob([bytes]), thumbnail: null, createdAt: Date.now() });
    if (isCurrentGame(gameId)) {
      const inst = ejs();
      if (inst && inst.gameManager) {
        try {
          inst.gameManager.writeFile(inst.gameManager.getSaveFilePath(), bytes);
          inst.gameManager.loadSaveFiles();
        } catch (e) {}
      }
    }
    RBUI.toast("Save file imported.");
  }

  function handleIframeMessage(e) {
    if (!e.data || typeof e.data !== "object" || !("rb" in e.data)) return;
    // Every "rb"-tagged message is sent via parent.postMessage from inside
    // whichever iframe is currently playing (EmulatorJS srcdoc, jsspeccy3,
    // jsbeeb, atari8bit, retroarch-web all do this -- verified, none of them
    // route through anywhere else). Rejecting anything not from the CURRENT
    // iframe closes a real reentrancy risk: a stale message queued by an old
    // iframe just before it's torn down (fast exit-then-relaunch) could
    // otherwise fire exitPlayer() a second time, or hide/react against a
    // session that's no longer the active one.
    if (e.source !== RBPlayer._iframe?.contentWindow) return;
    // "ready" is only ever sent by RetroArch-web's embed.html, and only
    // once its own boot sequence has actually finished -- safe to hide
    // loading on. The EmulatorJS srcdoc deliberately does NOT send "ready"
    // at all (see iframeDoc's own comment on EJS_ready) since EmulatorJS's
    // "ready" event fires almost immediately, well before the game is
    // actually playable -- "started" (EJS_onGameStart, sent once the core
    // is genuinely running) is what hides loading for it instead.
    if (e.data.rb === "ready") hideLoading();
    else if (e.data.rb === "started") { hideLoading(); onGameStarted(); }
    else if (e.data.rb === "escape") togglePause();
    else if (e.data.rb === "error") { hideLoading(); RBUI.toast(`Couldn't start: ${e.data.message || "unknown error"}`); }
    else if (e.data.rb === "retroarch-exit") exitPlayer();
  }

  // The whole point: while playing, the cursor is invisible everywhere
  // (baked into the EmulatorJS srcdoc, injected into alt-engine iframes --
  // see iframeDoc and attachAltEngineChrome above) and no controls are on
  // screen at all. Esc -- from the parent document, the EmulatorJS
  // iframe (via postMessage, since it's a separate srcdoc realm), or an
  // alt-engine iframe (direct call, since those are same-origin) -- opens
  // this overlay, which sits above the game with a normal cursor and
  // every control B-NAN offers in one place.
  function setPaused(paused) {
    isPaused = paused;
    document.getElementById("player-view").classList.toggle("paused", paused);
    document.getElementById("player-pause-overlay").hidden = !paused;
    if (paused) {
      document.getElementById("pause-game-name").textContent = (currentGame && currentGame.title) || "";
    }
  }

  function togglePause() {
    setPaused(!isPaused);
  }

  let loadingGiveUpTimer = null;

  // Real problem this solves: without any visible feedback, a slow-to-
  // boot game (a big ROM, a demanding system like N64/3DS/PSP) is just a
  // black screen -- reported back as "will not load" / "was taking
  // hours" even when it's genuinely still working, because there's
  // nothing on screen to say otherwise. Shown from the moment launch()
  // starts; hideLoading() is called from whichever engine's own real
  // "I'm actually running now" signal fires (EmulatorJS's EJS_onGameStart
  // -- NOT its "ready" event, which fires ~20ms in, long before the game
  // is playable, see iframeDoc's own comment -- an alt-engine iframe's
  // load event, RetroArch-web's own genuine ready message, or right after
  // a native process launch resolves).
  function showLoading(system, game) {
    const el = document.getElementById("player-loading");
    const title = document.getElementById("player-loading-title");
    const sub = document.getElementById("player-loading-sub");
    const backBtn = document.getElementById("btn-loading-back");
    if (!el) return;
    title.textContent = `Loading ${(game && game.title) || (system && system.name) || "game"}…`;
    sub.textContent = "";
    el.hidden = false;
    if (backBtn) backBtn.hidden = false;
    clearTimeout(loadingGiveUpTimer);
    // Belt-and-suspenders for failure modes that never throw a catchable
    // error at all (the iframe's own error/unhandledrejection listeners in
    // iframeDoc cover the ones that do, but a wasm core that just hangs
    // outright rather than erroring wouldn't hit either of those) -- past
    // this point it's not "still working," it's stuck, and the only way
    // back was previously force-quitting the whole app.
    loadingGiveUpTimer = setTimeout(() => {
      if (!el.hidden) {
        RBUI.toast(`${(game && game.title) || "This game"} didn't finish loading — back to the library.`);
        exitPlayer();
      }
    }, 60000);
  }

  function hideLoading() {
    clearTimeout(loadingGiveUpTimer);
    loadingGiveUpTimer = null;
    const el = document.getElementById("player-loading");
    if (el) {
      el.hidden = true;
      el.classList.remove("light");
    }
    const backBtn = document.getElementById("btn-loading-back");
    if (backBtn) backBtn.hidden = true;
  }

  // Generic version for any other genuinely blocking wait outside the
  // player itself (ROM import, ...) -- no reassure/give-up timers (those
  // model "a game core might be stuck," which doesn't apply here), just
  // show text and go. { light: true } swaps to the light-themed variant
  // for anything triggered from the (light-themed) library, so it isn't
  // a jarring hard-cut to the game's dark takeover screen -- see
  // .player-loading.light in styles.css. The back-to-library button
  // stays hidden here -- there's no game session to back out of.
  function showGenericLoading(text, { light } = {}) {
    const el = document.getElementById("player-loading");
    const title = document.getElementById("player-loading-title");
    const sub = document.getElementById("player-loading-sub");
    if (!el) return;
    title.textContent = text;
    sub.textContent = "";
    el.classList.toggle("light", !!light);
    el.hidden = false;
  }

  function handleGlobalKeydown(e) {
    if (e.key !== "Escape") return;
    if (document.getElementById("player-view").hidden) return;
    e.preventDefault();
    togglePause();
  }

  // Runs once at startup. In the browser build (or Electron before a
  // fetch-native-emulators.js run ever happened), window.RBNative.
  // listAvailableNative() resolves to an empty list, so this is a no-op
  // and every native-only system in coreRegistry.js stays exactly as
  // unavailable as it's declared there -- this only ever flips systems
  // ON, for the specific ones a build actually has bundled.
  async function applyNativeAvailability() {
    if (!window.RBNative || !window.RBNative.isElectron || !window.RBNative.listAvailableNative) return;
    let ids;
    try {
      ids = await window.RBNative.listAvailableNative();
    } catch (e) {
      return;
    }
    if (!ids || !ids.length) return;
    let changed = false;
    for (const id of ids) {
      const system = RB_SYSTEMS.find((s) => s.id === id);
      if (system && !system.available) {
        system.available = true;
        changed = true;
      }
    }
    if (changed && window.RBUI && RBUI.renderLibrary) RBUI.renderLibrary();
  }

  function init() {
    applyNativeAvailability();
    document.getElementById("btn-exit-player").addEventListener("click", exitPlayer);
    document.getElementById("btn-loading-back").addEventListener("click", exitPlayer);
    document.getElementById("btn-save-state").addEventListener("click", saveStateToFile);
    document.getElementById("btn-load-state").addEventListener("click", () => {
      document.getElementById("load-state-input").click();
    });
    document.getElementById("load-state-input").addEventListener("change", (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (file) loadStateFromFile(file);
    });
    document.getElementById("btn-screenshot").addEventListener("click", takeScreenshot);
    document.getElementById("btn-fullscreen").addEventListener("click", toggleFullscreen);
    document.getElementById("btn-resume").addEventListener("click", () => setPaused(false));
    document.getElementById("btn-pause-hint").addEventListener("click", () => setPaused(true));
    window.addEventListener("message", handleIframeMessage);
    window.addEventListener("keydown", handleGlobalKeydown);
    window.addEventListener("resize", syncNativeBounds);
    if (window.RBNative && window.RBNative.onNativeExited) {
      window.RBNative.onNativeExited((systemId) => {
        if (RBPlayer._nativeSystemId === systemId) exitPlayer();
      });
    }
  }

  return {
    init,
    launch,
    loadFromSlot,
    isCurrentGame,
    exportSaveFile,
    importSaveFile,
    showGenericLoading,
    hideLoading,
  };
})();
