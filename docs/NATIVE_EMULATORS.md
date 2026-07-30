# Native (non-browser) desktop emulators

B-NAN's 41 web-playable systems (see `README.md`) all run through a
browser-embeddable core -- EmulatorJS/libretro WASM, or one of the three
standalone vendored engines. Seven systems have no such thing anywhere,
in this app or otherwise, because no one has ever built a browser-ready
core for them: **GameCube/Wii, PlayStation 2, Wii U, Dreamcast,
PlayStation 3, Xbox, PlayStation Vita**. The only real emulators for
these are native desktop applications (Dolphin, PCSX2, Cemu, Flycast,
RPCS3, xemu, Vita3K) -- so this is how B-NAN's `.dmg`/`.exe`/`.AppImage`
builds bundle and launch those directly, alongside the browser-based
systems, instead of pretending they don't exist.

**Nintendo Switch is deliberately NOT part of this.** The two real
Switch emulators, Yuzu and Ryujinx, were both shut down in 2024 following
Nintendo's legal action against their maintainers -- redistributing
either would be real legal exposure, not a technical choice. The other
project sometimes mentioned (NxEmu) is early-stage, native-only, and by
its own progress reports only runs a handful of games. See the `switch`
entry in `web/src/coreRegistry.js` for the in-app explanation.

## How it fits together

```
tools/native/manifest.json          -- what to fetch, from where, per OS
tools/fetch-native-emulators.js     -- build-time fetcher (run by a human, once, before packaging)
native/                             -- fetched binaries land here (gitignored-in-spirit; not meant to be hand-edited)
  <platform>/<emulatorId>/...
  manifest.lock.json                -- what actually got fetched, per platform
electron/nativeEmulators.js         -- main-process spawn + Windows embed logic
electron/preload.js                 -- exposes window.RBNative.launchNative() etc. to the renderer
web/src/coreRegistry.js             -- the 7 systems' `nativeEngine: { emulatorId }` config
web/src/player.js                   -- launchNative(), applyNativeAvailability()
package.json → build.{mac,win,linux}.extraResources -- bundles native/<platform> into that platform's installer only (outside the asar)
```

**Scoped per platform, not shared** -- a real bug, found and fixed by hand: an earlier version of this config used one shared top-level `extraResources` entry that copied the ENTIRE `native/` folder (every platform's binaries at once) into every installer, regardless of target. That meant the Windows build was carrying ~830MB of macOS-only Dolphin/PCSX2/etc. binaries that could never run on it -- confirmed by inspecting a real built `.exe`'s bundled resources. Each platform's electron-builder config now has its own `extraResources` pointing at just `native/<that platform>/` plus the shared `manifest.lock.json`.

### Why "fetch at build time" instead of committing the binaries

These are 150-500MB+ native installers per platform, times 7 emulators,
times however many OS targets -- multiple gigabytes, and not something
that belongs in this project's own history the way the ~330MB of
browser-based WASM cores already are. Fetching them once on a real build
machine (`npm run fetch:native`) and then bundling the result into every
installer via `extraResources` gets the same end guarantee the browser
cores already have -- **the shipped app makes zero runtime network calls
for these** -- without permanently bloating the source tree.

### Where each emulator actually comes from

`tools/fetch-native-emulators.js` resolves each GitHub-hosted emulator's
download by calling that repo's **live** Releases API
(`api.github.com/repos/<owner>/<repo>/releases/latest`) at fetch time --
not a hardcoded URL that can go stale -- and matching the release's
asset filenames against patterns in `manifest.json` (e.g. PCSX2 on
Windows needs an asset whose name contains both `windows-x64` and
`.zip`). If a project renames its release assets, the fetch script warns
loudly and lists every asset it actually saw, rather than silently
grabbing the wrong file.

**Dolphin is the one exception**, and it's `source: "manual"` in the
manifest for a concrete, already-verified reason: `dolphin-emu/dolphin`
publishes no binaries via GitHub Releases at all, and `dolphin-emu.org`'s
own download page returns `403 Forbidden` to non-browser/datacenter
requests (confirmed by hand: both a raw `curl` with a browser
`User-Agent` and a full headless-browser session with a `networkidle`
wait were blocked identically). A human has to download the current
stable build from dolphin-emu.org themselves and drop it in
`native/manual-drop/dolphin/` before running the fetch script.

## Windows: true embedding. macOS/Linux: separate window.

This split was chosen deliberately, not defaulted into:

- **Windows** reparents the native emulator's own window into B-NAN's
  window via Win32's `SetParent` (through the `node-window-manager`
  package, which wraps the real `user32.dll` call), then keeps it
  pinned over the `#native-embed-target` placeholder element as the app
  window resizes. This is a real, working technique other Windows apps
  use for exactly this purpose.
- **macOS** has no public, documented API for reparenting another
  process's window into your own -- only private/undocumented tricks, or
  rewriting the emulator to stream frames via `IOSurface` instead of
  showing its own window at all, neither of which is something to ship
  against a codebase (Dolphin, PCSX2, ...) this project doesn't control.
- **Linux** could technically use X11's XEmbed protocol, but that
  doesn't work under Wayland, and there's no reason to give one platform
  two different embedding strategies depending on the session type when
  a separate window already works everywhere.

Practical consequence of the separate-window approach: once the native
window has OS focus, keypresses (including Esc) go to it, not to B-NAN's
own page -- alt-tabbing back to B-NAN and using the pause-hint button (or
just closing the native emulator's own window) is how you get back, not
Esc from inside it. This is stated plainly rather than silently
papered over.

## What still needs a human on a real machine

None of this was testable in the sandboxed environment it was written
in -- there's no real Windows machine to verify `SetParent` embedding
against, and the binaries themselves were never fetchable there either.
Concretely, before shipping:

1. **Run `npm run fetch:native`** on each target platform (or in CI) to
   actually populate `native/`. Nothing native shows up as playable
   without this -- `applyNativeAvailability()` in `player.js` only ever
   flips a system's `available` flag on for what
   `window.RBNative.listAvailableNative()` reports as truly present.
2. **Download Dolphin by hand** (see above) and drop it in
   `native/manual-drop/dolphin/` -- it's the one emulator the fetch
   script can't reach on its own.
3. **`npm install`** needs to succeed for `node-window-manager`, which
   compiles a native addon via `node-gyp`/`make`. Verified, real gotcha
   found while building this: if your checkout path contains a colon
   (`:`) anywhere -- exactly what happened trying to install it inside
   *this* project's own folder, `.../Games : Creations/MISC/B-NAN`
   -- the build fails with `clang++: error: no such file or directory:
   ':'`, because `make` treats `:` as a syntactic separator. Confirmed
   by reproducing the same `npm install node-window-manager` in a
   colon-free path, where it installs and compiles cleanly. Clone/build
   B-NAN somewhere without a colon in the path.
4. **Verify `SetParent` embedding on a real Windows machine** -- window
   handle discovery (matching a spawned process to its top-level window,
   see `embedOnWindows` in `electron/nativeEmulators.js`) is the kind of
   thing that's usually fine but occasionally needs tuning against a
   specific emulator's own window-creation timing.
5. **Double-check each emulator's current license/asset-naming/macOS
   support** at fetch time -- `tools/native/manifest.json` records what
   was true when this was written, and the fetch script's own
   "no asset matched" warning is the signal something changed upstream.
