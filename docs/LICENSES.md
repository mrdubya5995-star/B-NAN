# Third-party software in B-NAN

B-NAN is a shell/front-end app. The actual game emulation is done
by other people's open-source work — credit where it's due:

- **EmulatorJS** (https://emulatorjs.org) — the emulation engine that
  loads and runs libretro cores in the browser. **Confirmed license:
  GNU GPL v3.0** (verified against the repo's actual `LICENSE` file — no
  linking exception). The Stable channel (v4.2.3) is vendored at
  `web/vendor-emulatorjs/data/` — EmulatorJS's own official GitHub
  Release archive, not a B-NAN build, with **one deliberate patch**: two
  hardcoded values in `GameManager.prototype.getRetroArchCfg()`
  (`audio_latency`, `video_vsync`) that upstream exposes no public
  override for and that were causing real, reported audio crackle — see
  `docs/BUILD.md`'s "Patches to vendored code" section for the exact
  diff and reasoning. The separately-vendored nightly-frozen snapshot at
  `web/vendor-emulatorjs-nightly/data/` (3DS/Intellivision only) carries
  the identical patch. Everything else in both is unmodified. "Latest"
  and the live (non-frozen) "Nightly" channel are loaded from the
  EmulatorJS CDN, same as before, and are NOT patched — see
  `docs/BUILD.md` for why that's a deliberate, separate thing from the
  frozen 3DS/Intellivision snapshot.
- **libretro cores** — each core bundled/served by EmulatorJS (FCEUmm,
  Snes9x, mGBA, Genesis Plus GX, Beetle PSX, and the rest) is its own
  open-source emulator project with its own license file, generally
  GPLv2/GPLv3 per libretro convention. There's no single consolidated
  license table published by EmulatorJS for every core — if that matters
  for how you distribute B-NAN, check the specific cores you ship.
- **Open question worth a real answer before wide distribution**:
  whether loading EmulatorJS via `<script src>` from a CDN (as this build
  does by default) vs. bundling it into your own build changes whether
  GPLv3's copyleft reaches B-NAN's own code. GPLv3 doesn't spell
  this out cleanly for this kind of integration — this is a "get an
  actual answer from someone qualified" item, not something I can
  resolve for you here.
- **JSSpeccy 3** (https://github.com/gasman/jsspeccy3) — GNU GPL v3.0
  (verified against the repo's own `COPYING` file). Powers ZX Spectrum,
  entirely separately from EmulatorJS/libretro. Vendored unmodified at
  `web/vendor-jsspeccy3/`, built from the project's own official release
  archive (v3.2).
- **jsbeeb** (https://github.com/mattgodbolt/jsbeeb) — GNU GPL v3.0
  (verified against the repo's own `COPYING` file). Powers BBC Micro,
  entirely separately from EmulatorJS/libretro. Vendored at
  `web/vendor-jsbeeb/`, built from the project's own source via its own
  documented `npm run build` (the project only publishes Electron desktop
  installers as GitHub Releases, not a static web build, so there's no
  official web archive to use unmodified the way JSSpeccy 3's could be —
  the build step here just runs their own Vite config, no B-NAN code
  changes to their source).
- **fflate** (https://github.com/101arrowz/fflate) — MIT licensed, used
  for reading `.zip` ROM archives and building backup files. Vendored at
  `web/src/vendor/fflate.min.js`.
- **Electron** — MIT licensed, used to package the desktop (.exe/.dmg) build.
- **Capacitor** — MIT licensed, used to wrap the app for iOS.
- **Notable** (https://fonts.google.com/specimen/Notable) — SIL Open Font
  License 1.1. Used for headings and subheadings only (h1/h2/h3) —
  everything else (buttons, labels, badges, chips, game titles, body
  copy) is the plain system sans font, no bundled font at all. Bundled
  locally at `web/assets/fonts/Notable.woff2` rather than loaded from
  Google Fonts, so it doesn't add a network dependency.

B-NAN does not include, distribute, or link to any copyrighted
game ROMs or console BIOS files. The import feature only reads files you
already have on your device.

(See `docs/BUILD.md` for the confirmed EmulatorJS license and exact
version pinned in this build.)
