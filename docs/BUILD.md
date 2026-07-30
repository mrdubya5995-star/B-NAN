# Building B-NAN

B-NAN is one static web app (`web/`) wrapped three different ways.
Everything in `web/` is what actually runs — Electron and Capacitor just
put a native shell around it.

## 1. Web / browser build (.html) — the source of truth

```bash
cd "B-NAN"
npm run web
# open http://127.0.0.1:8877
```

This is the most-tested target and the easiest to iterate on. It's also
the most limited: it needs a network connection the first time you play
each system (to fetch that system's emulator core from the EmulatorJS
CDN), and some heavier cores need your browser to support
`SharedArrayBuffer`, which requires these response headers — already set
by `tools/serve.js` and `electron/main.js`:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you host `web/` on your own server (Netlify, GitHub Pages, etc.), set
those two headers there too, or some systems will fail to start.

## 2. Desktop build (.dmg / .exe / .AppImage / .deb)

```bash
npm run dist:mac     # -> dist/B-NAN-<version>.dmg      (must run on macOS)
npm run dist:win     # -> dist/B-NAN Setup <version>.exe (installer)
                      # -> dist/B-NAN <version>.exe       (portable, no installer)
npm run dist:linux   # -> dist/B-NAN-<version>.AppImage
                      # -> dist/bnan_<version>_amd64.deb
```

Notes:
- `dist:win` can usually be cross-built from macOS/Linux, but Windows
  code-signing can't — the resulting .exe will trigger a Windows
  SmartScreen warning until you sign it with your own certificate
  (or codesign isn't set up at all, in which case it's simply unsigned).
- `dist:mac` produces an unsigned/unnotarized .dmg unless you set up
  an Apple Developer ID certificate and notarization credentials via
  environment variables (`CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  etc. — see electron-builder's code-signing docs). Unsigned means
  Gatekeeper will show an "unidentified developer" warning on first
  launch; right-click → Open gets past it.
- `dist:linux` → AppImage builds and runs correctly from macOS (verified:
  a real 400+MB AppImage was produced and is a valid executable). The
  **.deb target does not** — building a real Debian package requires GNU
  `ar` (via the `fpm` tool electron-builder shells out to), which macOS's
  native `ar` doesn't produce compatibly with; the output on a Mac host is
  a corrupted, non-installable file, confirmed by hand (`ar t` on the
  resulting file only shows a stray `__.SYMDEF SORTED` member, not the
  `debian-binary`/`control.tar.gz`/`data.tar.gz` a real .deb needs). This
  is a documented electron-builder/fpm limitation, not a B-NAN bug — build
  the `.deb` on an actual Linux machine or in Linux CI (e.g. a GitHub
  Actions `ubuntu-latest` runner) instead. AppImage alone already covers
  "double-click and run" on effectively every mainstream distro, so it's
  the one to actually ship if a Linux build has to happen from a Mac.
- Electron packages a full Chromium + Node runtime, so builds land
  around 150-200MB even though `web/` itself is tiny (Linux builds run
  larger, ~400MB, since AppImage bundles its own runtime dependencies).
- There is no Android/.apk build target — Capacitor's Android build needs
  the Android SDK, a JDK, and Gradle, none of which are available in this
  environment, and Android was dropped from B-NAN's target list in favor
  of the Linux desktop build above.

### Native (non-browser) emulators bundled into the desktop build

GameCube/Wii, PS2, Wii U, Dreamcast, PS3, Xbox, and PS Vita have no
browser-ready core anywhere -- the desktop builds above bundle real
native emulators (Dolphin, PCSX2, Cemu, Flycast, RPCS3, xemu, Vita3K)
for these instead. This needs a separate, one-time step before
packaging: see **`docs/NATIVE_EMULATORS.md`** for the full picture --
`npm run fetch:native`, the one emulator (Dolphin) that needs a manual
download, and a real gotcha already found and documented (native addon
compilation breaks if your checkout path contains a `:`).

## 3. iOS build

See `ios/README.md` — this leg needs a Mac with full Xcode and your own
Apple Developer account, which isn't something achievable from this
environment. Everything short of that (the Capacitor wrapper) is ready.

## Self-hosted emulator cores (already done, not just documented)

`web/vendor-emulatorjs/data/` is a full, unmodified copy of the official
EmulatorJS v4.2.3 GitHub Release archive (`4.2.3.7z`, ~300MB — the
release archive, not the npm package, which ships no core binaries at
all). `cdnBase()` in `web/src/player.js` points the **stable** channel
(the default, and what 37 of B-NAN's 41 always-available systems use) at
this local copy instead of `cdn.emulatorjs.org`. That means stable-channel
systems work fully offline and have zero dependency on that third-party
CDN staying up, ever — verified by inspecting actual network requests
during a real game launch, not assumed.

**3DS and Intellivision are ALSO fully vendored now**, at
`web/vendor-emulatorjs-nightly/data/` (~10MB — a matched runtime+core
snapshot, not just the two core files) via a distinct `nightly-frozen`
channel value. These two systems aren't in any tagged EmulatorJS release
yet, so they can't use the same `stable` copy above — but rather than
leave them permanently dependent on the live CDN, this pins one specific
nightly snapshot (both the runtime JS and the two cores, matched
versions, downloaded together) locally instead. Verified end-to-end with
Playwright: launching either system produces zero requests to
`cdn.emulatorjs.org`, same guarantee as `stable`.

This is deliberately a SEPARATE thing from the plain `nightly` channel a
player can still pick in Settings ("newest everything, can be unstable,
needs a connection") — that one stays 100% live-CDN, since silently
handing an explicit "give me the bleeding edge" request a frozen snapshot
instead would defeat the point of the setting. `nightly-frozen` is never
user-selectable; it's wired to exactly these two systems in
`coreRegistry.js` and nothing else.

Two real correctness bugs were found and fixed while setting this up,
worth knowing if this is ever touched again: EmulatorJS's `EJS_core`
value isn't always the same string as the system id — verified against
EmulatorJS's own `data/src/consts.js` — 3DS's actual core is `"azahar"`
(not `"3ds"`) and Intellivision's is `"freeintv"` (not `"intv"`).
`coreRegistry.js` had the wrong value for both before this, which would
have meant the core simply never loads. Also needed:
`cores/reports/<core>.json` (a small per-core metadata file EmulatorJS's
own UI fetches) alongside the actual WASM core files, or the core load
fails with an unrelated-looking 404.

To update EITHER vendored set to a newer release later:

```bash
# stable:
curl -L -o emulatorjs.7z https://github.com/EmulatorJS/EmulatorJS/releases/latest/download/<version>.7z
# extract emulatorjs.7z's data/ folder over web/vendor-emulatorjs/data/

# nightly-frozen (re-pin 3DS/Intellivision to a fresh nightly snapshot):
# re-download emulator.min.js, emulator.min.css, loader.js, version.json,
# compression/, localization/, and cores/{azahar,freeintv}*-wasm.data +
# cores/reports/{azahar,freeintv}.json from https://cdn.emulatorjs.org/nightly/data/
# over web/vendor-emulatorjs-nightly/data/ -- keep the runtime and core
# files from the SAME pull to avoid a version mismatch between them.
```

If a future EmulatorJS release adds real 3DS/Intellivision support to a
tagged version, they can move to the same `stable` vendored copy as
everything else and `vendor-emulatorjs-nightly/` can go away entirely.

This roughly triples the app's on-disk size (cores are WASM binaries,
one set per system) — that's the real, permanent tradeoff for not
depending on a third party's server.

### Patches to vendored code

Everything vendored is unmodified upstream code, with exactly one
deliberate exception, applied identically to **both** `emulator.min.js`
copies (`web/vendor-emulatorjs/data/` and `web/vendor-emulatorjs-nightly/data/`
— same bug, same fix, both places) plus the readable
`web/vendor-emulatorjs/data/src/GameManager.js` reference copy:

`GameManager.prototype.getRetroArchCfg()` hardcodes `audio_latency = 64`
and `video_vsync = true` into every game's RetroArch config, completely
unconditionally — there is no public `EJS_*` global that overrides
either one (the only real override mechanism, `retroarchOpts`, is only
ever populated from a core's own bundled `core.json`, confirmed by
reading the surrounding source, not assumed). Forcing vsync locks video
to the display's flat 60Hz against systems that don't run at exactly
that rate (a GBA is ~59.7Hz); the audio pipeline absorbs that drift as
periodic crackle. 64ms of buffer is also tight enough that ordinary
main-thread jitter causes audible underruns. **This was very likely the
real, persistent root cause of choppy audio reported repeatedly across
this project's whole development** — every earlier fix (removing a
redundant `setVSync` call B-NAN's own code used to make, killing a
periodic IndexedDB write during play, hiding a compositing decorative
overlay, broader WASM threading) was real and worth doing, but none of
them touched this, because it's baked into EmulatorJS's own vendored
source, not anything B-NAN's own code controls.

Patched both bundles directly: `audio_latency = 64` → `128` (matching
the default EmulatorJS's own authors use in their own example code for
this exact setting, found commented-out in `emulator.js`), `video_vsync
= true` → `false`.

**This means a future re-vendor of either EmulatorJS copy (see the
update commands above) will silently reintroduce this bug** — the fix
lives in the downloaded bundle, not in anything B-NAN's own source
controls, so it doesn't survive an overwrite. Re-apply it after any
re-vendor: in the new `emulator.min.js`, find the literal string
`audio_latency = 64\nvideo_top_portrait_viewport = true\nvideo_vsync =
true\nvideo_smooth = false` and change the two values as above.

## Updating the core list / registry

`web/src/coreRegistry.js` is the single source of truth for which
systems are wired up. Each entry has an `available` flag — flipping a
system from `false` to `true` (once EmulatorJS or another engine
supports it) is the only change needed for it to show up as playable.
