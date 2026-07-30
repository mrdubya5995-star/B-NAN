# B-NAN — iOS / App Store build

I can't finish this leg myself: turning this into a submittable App Store
build needs a Mac with **full Xcode** (not just the command-line tools),
a paid **Apple Developer Program** account ($99/yr), and your own
code-signing certificate. None of that is something I can do on your
behalf. What's here is everything short of that: a ready-to-sync
Capacitor wrapper around the same web app that powers the desktop and
browser builds.

## What you'll need

- A Mac with Xcode installed from the App Store (not just Command Line Tools).
- [Node.js](https://nodejs.org) (already required for the rest of B-NAN).
- CocoaPods (`sudo gem install cocoapods`), which Capacitor's iOS build uses.
- An Apple Developer Program account, if/when you're ready to submit.

## Steps

```bash
cd "B-NAN/ios"
npm install
npm run add-platform     # copies web/ into ios/www and creates the Xcode project
npm run open             # opens the project in Xcode
```

From Xcode:
1. Select the B-NAN target → **Signing & Capabilities** → pick your Apple Developer team.
2. Plug in an iPhone or pick a simulator, hit **Run** to test.
3. When ready, **Product → Archive**, then use the Organizer window to submit to App Store Connect.

Any time you change something in `web/`, re-run `npm run sync` before
opening Xcode again so the changes are copied over.

## Before you submit — read this

- **Apple's rules on emulators changed in April 2024** (App Store Review
  Guideline 4.7): retro game console emulators are now allowed, but with
  conditions — the app can't download *arbitrary executable code* beyond
  the emulated game content itself, and it can't facilitate piracy. Keep
  B-NAN's "bring your own legally-owned ROM" framing front and
  center in your app description and onboarding; don't add ROM download
  links.
- **WebAssembly + WKWebView**: iOS runs the emulator inside a WKWebView.
  This works, but Apple reviewers sometimes scrutinize apps that load
  WASM binaries at runtime from a remote CDN. For a submission, self-host
  the EmulatorJS `data/` folder (cores + loader) *inside* the app bundle
  instead of pulling it from `cdn.emulatorjs.org` at runtime — that also
  makes the app usable offline, which reviewers and users both prefer.
  See `../docs/BUILD.md` for how to vendor the data folder.
- **Performance**: heavier systems (PS1, N64, Saturn) are already a
  stretch in a desktop browser; expect them to be rough or unplayable on
  older iPhones. Nintendo/Sega 8- and 16-bit systems, Game Boy/Color/Advance,
  and most handhelds run comfortably.
- **Review risk is still real** even with a compliant app — Apple's
  emulator policy is new and enforcement has been inconsistent. Don't be
  surprised by a rejection on the first pass; the appeals/resubmission
  process is normal for this category.
- **Icon**: `web/assets/icons/banana-1024.png` is the 1024×1024 master —
  Xcode's asset catalog wants that exact size for the App Store icon slot.
