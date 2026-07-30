/* B-NAN settings — kept to the things that actually matter for a
   simple emulator: play feel, save behavior, performance, and a couple
   of accessibility knobs. No 40-tab options maze. */

const RBDefaults = {
  volume: 0.7,
  autoSaveOnExit: true,
  startFullscreen: false,
  cheatsEnabled: true,
  highContrast: false,
  fontScale: 1,
  menuNarration: false,
  coreChannel: "stable",
  vsyncEnabled: false,
  smoothingEnabled: false,
};

const RBSettings = (() => {
  let cache = null;

  async function all() {
    if (cache) return cache;
    const entries = await Promise.all(
      Object.keys(RBDefaults).map(async (k) => [k, await RBDB.getSetting(k, RBDefaults[k])])
    );
    cache = Object.fromEntries(entries);
    return cache;
  }

  async function set(key, value) {
    const s = await all();
    s[key] = value;
    await RBDB.setSetting(key, value);
    applyVisualSettings();
    return value;
  }

  async function applyVisualSettings() {
    const s = await all();
    document.body.classList.toggle("high-contrast", !!s.highContrast);
    document.documentElement.style.setProperty("--ui-scale", s.fontScale || 1);
  }

  function toggleRow(container, { key, label, hint, value, onChange }) {
    const row = document.createElement("div");
    row.className = "toggle-row";
    row.innerHTML = `
      <div><span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ""}</div>
      <label class="switch">
        <input type="checkbox" ${value ? "checked" : ""} />
        <span class="track"></span>
      </label>
    `;
    row.querySelector("input").addEventListener("change", (e) => onChange(e.target.checked));
    container.appendChild(row);
  }

  function sliderRow(container, { label, hint, min, max, step, value, format, onChange }) {
    const row = document.createElement("div");
    row.className = "toggle-row";
    row.style.flexDirection = "column";
    row.style.alignItems = "stretch";
    const valId = "val_" + Math.random().toString(36).slice(2, 8);
    row.innerHTML = `
      <div style="display:flex; justify-content:space-between;">
        <div><span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ""}</div>
        <span id="${valId}" style="font-weight:700;">${format(value)}</span>
      </div>
      <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" style="margin-top:8px; width:100%;" />
    `;
    row.querySelector("input").addEventListener("input", (e) => {
      const v = parseFloat(e.target.value);
      row.querySelector(`#${valId}`).textContent = format(v);
      onChange(v);
    });
    container.appendChild(row);
  }

  function selectRow(container, { label, hint, value, options, onChange }) {
    const row = document.createElement("div");
    row.className = "toggle-row";
    const selId = "sel_" + Math.random().toString(36).slice(2, 8);
    row.innerHTML = `
      <div><span>${label}</span>${hint ? `<span class="hint">${hint}</span>` : ""}</div>
      <select id="${selId}" style="padding:6px 8px; border-radius:8px; border:2px solid var(--peel-300); background:#fff; font-family:inherit;">
        ${options.map((o) => `<option value="${o.value}" ${o.value === value ? "selected" : ""}>${o.label}</option>`).join("")}
      </select>
    `;
    row.querySelector("select").addEventListener("change", (e) => onChange(e.target.value));
    container.appendChild(row);
  }

  async function renderInto(container) {
    const s = await all();

    const gameplay = document.createElement("div");
    gameplay.className = "settings-card";
    gameplay.innerHTML = "<h3>Gameplay</h3>";
    toggleRow(gameplay, {
      label: "Cheats",
      hint: "Allow entering cheat codes from the in-game menu",
      value: s.cheatsEnabled,
      onChange: (v) => set("cheatsEnabled", v),
    });
    container.appendChild(gameplay);

    const perf = document.createElement("div");
    perf.className = "settings-card";
    perf.innerHTML = "<h3>Performance &amp; quality</h3>";
    toggleRow(perf, {
      label: "VSync",
      hint: "Locks frame pacing to your display's refresh rate. Off by default — most systems don't run at exactly 60Hz, and forcing a lock against that can cause periodic audio crackle. Try it only if you're seeing screen tearing.",
      value: s.vsyncEnabled,
      onChange: (v) => set("vsyncEnabled", v),
    });
    toggleRow(perf, {
      label: "Smoothing shader",
      hint: "Softens pixel edges. Off = sharp, raw pixels and the least GPU work — the fastest option.",
      value: s.smoothingEnabled,
      onChange: (v) => set("smoothingEnabled", v),
    });
    const perfNote = document.createElement("p");
    perfNote.style.cssText = "font-size:11.5px; color:var(--ink-700); opacity:0.75; margin:6px 0 0; line-height:1.5;";
    perfNote.textContent = "Systems that support multi-threaded cores (PSP, DOS, 3DS, Nintendo 64) use them automatically for the best speed your device can give them — nothing to configure. Actual top speed still depends on your machine and the underlying core; a few systems are just demanding (see Core List below).";
    perf.appendChild(perfNote);
    container.appendChild(perf);

    const saves = document.createElement("div");
    saves.className = "settings-card";
    saves.innerHTML = "<h3>Saves</h3>";
    toggleRow(saves, {
      label: "Auto-save on exit",
      hint: "Quietly saves your spot to Slot 1 when you leave a game",
      value: s.autoSaveOnExit,
      onChange: (v) => set("autoSaveOnExit", v),
    });
    const savesNote = document.createElement("p");
    savesNote.style.cssText = "font-size:11.5px; color:var(--ink-700); opacity:0.75; margin:6px 0 0; line-height:1.5;";
    savesNote.textContent = "Save states, and importing/exporting a game's save file, live on the game itself — double-click any game to get to them.";
    saves.appendChild(savesNote);
    const backupRow = document.createElement("div");
    backupRow.className = "toggle-row";
    backupRow.innerHTML = `<div><span>Backup &amp; restore</span><span class="hint">Export every save state as a file, or bring one back</span></div>`;
    const btnWrap = document.createElement("div");
    btnWrap.style.display = "flex";
    btnWrap.style.gap = "6px";
    const exportBtn = document.createElement("button");
    exportBtn.className = "btn small";
    exportBtn.textContent = "Export";
    exportBtn.addEventListener("click", () => RBBackup.exportAll());
    const importBtn = document.createElement("button");
    importBtn.className = "btn small";
    importBtn.textContent = "Import";
    importBtn.addEventListener("click", () => RBBackup.promptImport());
    btnWrap.append(exportBtn, importBtn);
    backupRow.appendChild(btnWrap);
    saves.appendChild(backupRow);
    container.appendChild(saves);

    const display = document.createElement("div");
    display.className = "settings-card";
    display.innerHTML = "<h3>Display, sound &amp; controls</h3>";
    toggleRow(display, {
      label: "Start games in fullscreen",
      value: s.startFullscreen,
      onChange: (v) => set("startFullscreen", v),
    });
    sliderRow(display, {
      label: "Default volume",
      min: 0, max: 1, step: 0.05, value: s.volume,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => set("volume", v),
    });
    const inputRow = document.createElement("div");
    inputRow.className = "toggle-row";
    inputRow.innerHTML = `<div><span>Controls</span><span class="hint">Keyboard works out of the box; any gamepad connected before you start a game is picked up automatically. To remap buttons, use EmulatorJS's own in-game menu (the small gear icon in the corner of the game view) — B-NAN doesn't duplicate that screen.</span></div>`;
    display.appendChild(inputRow);
    container.appendChild(display);

    const access = document.createElement("div");
    access.className = "settings-card";
    access.innerHTML = "<h3>Accessibility</h3>";
    toggleRow(access, {
      label: "High-contrast text",
      value: s.highContrast,
      onChange: (v) => set("highContrast", v),
    });
    sliderRow(access, {
      label: "Text size",
      min: 0.9, max: 1.4, step: 0.05, value: s.fontScale,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => set("fontScale", v),
    });
    toggleRow(access, {
      label: "Read menu items aloud",
      hint: "Speaks button labels when they're focused",
      value: s.menuNarration,
      onChange: (v) => set("menuNarration", v),
    });
    container.appendChild(access);

    const advanced = document.createElement("div");
    advanced.className = "settings-card";
    advanced.innerHTML = "<h3>Advanced</h3>";
    selectRow(advanced, {
      label: "Emulator core channel",
      hint: "B-NAN's emulation is powered by EmulatorJS, and EmulatorJS itself publishes 3 versions of its engine, called \"channels\" -- this picks which one B-NAN uses. Stable is the one bundled permanently inside B-NAN itself (see Core List below) -- it works fully offline, forever, with no server dependency, and is what everything defaults to. Latest and Nightly are EmulatorJS's own newer, still-changing builds, fetched live from EmulatorJS's own servers each time -- picking either trades 'always works offline' for 'whatever EmulatorJS shipped today,' and needs an internet connection. Only switch off Stable if you specifically want to test something newer. (3DS and Intellivision use their own separate, ALSO permanently-bundled snapshot regardless of this setting -- see Core List.)",
      value: s.coreChannel,
      options: [
        { value: "stable", label: "Stable — bundled in B-NAN, works offline forever (recommended)" },
        { value: "latest", label: "Latest — EmulatorJS's newest release, needs a connection" },
        { value: "nightly", label: "Nightly — EmulatorJS's bleeding edge, can be unstable, needs a connection" },
      ],
      onChange: (v) => set("coreChannel", v),
    });
    const coreListRow = document.createElement("div");
    coreListRow.className = "toggle-row";
    coreListRow.innerHTML = `<div><span>Core List</span><span class="hint">Every system B-NAN aims to support, and exactly what powers each one today</span></div>`;
    const coreListBtn = document.createElement("button");
    coreListBtn.className = "btn small";
    coreListBtn.textContent = "View";
    coreListBtn.addEventListener("click", () => RBUI.openCoreList());
    coreListRow.appendChild(coreListBtn);
    advanced.appendChild(coreListRow);
    container.appendChild(advanced);

    const about = document.createElement("div");
    about.className = "settings-card";
    about.innerHTML = `<h3>About</h3>
      <p style="font-size:12.5px; color:var(--ink-700); line-height:1.6; margin:0;">
      B-NAN runs games using open-source emulator cores (via EmulatorJS &amp; the libretro project).
      The Stable core channel is bundled with the app itself, so it keeps working even if EmulatorJS's own servers ever go away.
      Everything you import and save stays on this device — B-NAN doesn't upload anything or provide ROMs.
      Box art is looked up automatically (via GitHub, from the open libretro-thumbnails project) when you add a game; that's the only thing B-NAN fetches from the network on its own, besides the Latest/Nightly core channel above, if you switch to one of those.
      </p>`;
    container.appendChild(about);
  }

  return { all, applyVisualSettings, renderInto };
})();
