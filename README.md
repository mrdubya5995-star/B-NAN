# B-NAN

A small, honest, multi-system game emulator. Soft yellow, no glassmorphism,
no giant options maze — import your ROMs, play, save, done.

## What's in this folder

```
web/            the actual app (plain HTML/CSS/JS, no build step) — open this in any browser
electron/       desktop wrapper (.dmg / .exe / .AppImage) around web/
ios/            Capacitor wrapper for iOS — needs your own Mac+Xcode+Apple account to finish
tools/          icon generator, local dev server
dist/           built installers (after running the dist scripts)
docs/           BUILD.md, LICENSES.md
```

## Quick start (web)

```bash
npm run web
# open http://127.0.0.1:8877
```

## Desktop app

```bash
npm install
npm start          # run it locally without packaging
npm run dist:mac    # -> dist/B-NAN-1.0.0.dmg
npm run dist:win     # -> dist/B-NAN Setup 1.0.0.exe (installer)
                      # -> dist/B-NAN 1.0.0.exe (portable, no install)
npm run dist:linux   # -> dist/B-NAN-1.0.0.AppImage
```

All three were built and tested from this same setup — a real ~400MB
`.dmg`, two real ~400MB Windows `.exe` files, and a real ~400MB
`.AppImage` already sit in `dist/`. They're unsigned (see `docs/BUILD.md`
for what that means per platform). There is no Android/.apk build — see
`docs/BUILD.md` for why, and why the Linux desktop build above replaces
it. `dist:linux` can also emit a `.deb`, but building a genuinely valid
one requires an actual Linux host (see `docs/BUILD.md`).

## iOS

See `ios/README.md`. This is the one piece I genuinely can't finish for
you — turning it into an App Store submission needs your own Mac with
full Xcode and a paid Apple Developer account. Everything short of that
(the Capacitor wrapper, the build steps, the App Store policy notes) is
ready to go.

## What actually works today

B-NAN is honest about this in the app itself (see the "Core List"
page, under Settings) rather than pretending everything on the wishlist
runs. As of this build, **46 systems are genuinely playable**:

- **38 via EmulatorJS/libretro cores**, fully vendored locally (permanent,
  zero network dependency): NES, SNES, Game Boy/Color/Advance, N64, DS,
  PS1, PSP, all the Genesis/Master System/Game Gear/32X/Sega CD/Saturn
  family (Genesis Plus GX also covers the earlier **SG-1000** on the same
  core), the Atari lineup, PC Engine/PC-FX, most of the Commodore family,
  DOS, 3DO, Amiga, ColecoVision, arcade (FinalBurn Neo + MAME), and
  **3DS + Intellivision** — genuinely permanent too, via a separately
  pinned nightly snapshot (see `docs/BUILD.md`), not the "may need a live
  connection" caveat these carried before.
- **4 via standalone web emulators**, vendored locally, not EmulatorJS
  cores: **ZX Spectrum** (JSSpeccy 3, GPL-3.0), **BBC Micro** (jsbeeb,
  GPL-3.0), **Atari 8-bit** (Sfotty Pie, MIT), **Amiga CD32** (the same
  PUAE core as regular Amiga, CD32 mode).
- **5 via RetroArch's own official web player**, also vendored locally
  (a heavier, different engine than EmulatorJS — see
  `web/vendor-retroarch-web/embed.html` for why and how): **Uzebox**
  (Uzem, GPLv3), **MicroW8** (Unlicense), **LowRes NX** (zlib), **NEC
  PC-8000/PC-8800** (QUASI88, BSD-3-Clause), **Thomson MO/TO** (Theodore,
  GPLv3). A sixth (NEC PC-9800 via NP2kai) is vendored and wired up but
  currently throws a real runtime error this specific core hits and the
  others don't — left marked unavailable rather than shipped half-working;
  see the `pc98` entry in `coreRegistry.js`.

Everything else — GameCube/Wii, PS2, PS3, PS Vita, Wii U, Xbox/360,
Dreamcast and Sega's later 3D arcade boards (Model 2/3, Naomi, Triforce,
Chihiro, Hikaru), MSX, Amstrad CPC, ScummVM, Doom/Quake engines,
TIC-80/WASM-4, and a long tail of niche/discontinued handhelds — is
listed as a roadmap item with an honest, specific explanation of why:
mostly because no browser-ready emulator exists for it *anywhere*, not
just in B-NAN, and in a couple of cases (MSX) because a real one exists
but has no license, so it legally can't be bundled. Nintendo Switch is
also listed as unsupported — there's no browser/WASM-ready core for it
anywhere, and the only real Switch emulators (Yuzu, Ryujinx) were both
shut down in 2024 following Nintendo's legal action against their
maintainers.

The EmulatorJS Stable channel (what ~35 of the 37 EmulatorJS-backed
systems use) is vendored locally too, at `web/vendor-emulatorjs/`, an
exact unmodified copy of EmulatorJS's own official release — so those
systems keep working even if `cdn.emulatorjs.org` ever goes away.

Full detail, including exactly which named core (Genesis Plus GX, Beetle
PSX HW, Yabause, etc.) powers which system: open the app, go to
**Settings → Core List**, or read `web/src/coreRegistry.js` directly.

## Priorities, as built

1. Every system that has a real browser-ready emulator engine is wired
   up and playable; everything else — including Nintendo Switch — is
   listed honestly, not faked.
2. Four sections, sidebar on the left: Games, Favorites, Recents,
   Settings. The topbar changes with the section — console filter chips
   and an Add Game button on Games, the same chips (no Add) on
   Favorites, a Recently Played / Time Played toggle on Recents.
3. Save states (multiple slots, thumbnails, auto-save on exit) and a
   game's actual save file (SRAM/battery save, separate from states)
   both work, plus a one-click backup/restore to a `.zip` file.
4. Double-click any game for its options: change artwork, rename, view
   save states, import/export its save file, delete.
5. Box art is fetched automatically when you add a game, matched by
   title against thumbnails.libretro.com — release tags like
   `(USA)(En)` or `[!]` are stripped first so the match still lands on
   the bare title. Manual override (from your own files, or a manual
   database search) is always available from the same double-click menu.
6. Multi-select + bulk delete for clearing out several games at once.
7. Import ROMs (drag-and-drop or file picker, `.zip` supported).
8. Soft yellow theme throughout, matching warm text color, hand-touched
   details (a hand-drawn pixel banana, dashed dividers, a little paper
   grain) instead of a generic AI-generated look.

See `docs/BUILD.md` for build details and `docs/LICENSES.md` for what
B-NAN is built on top of (EmulatorJS/libretro, GPLv3).
