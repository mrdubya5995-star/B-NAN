#!/usr/bin/env node
/* Build-time fetcher for B-NAN's native (non-browser) desktop emulators --
   Dolphin, PCSX2, RPCS3, Cemu, xemu, Flycast, Vita3K.

   Run this BEFORE `npm run dist:*` on a real build machine (it does
   nothing useful in this sandbox: no real network access to GitHub's
   release CDN and no 7z/unzip round-trip was ever exercised here). What
   it does:

     1. For each emulator in tools/native/manifest.json with
        source:"github", asks the GitHub Releases API for that repo's
        LATEST release (not a hardcoded/guessed download URL -- resolved
        live against the real repo every time this runs) and downloads
        whichever asset's filename matches every pattern in
        assetPatterns[<this platform>].
     2. For source:"manual" (currently just Dolphin -- see manifest.json
        for why: no GitHub Releases, and dolphin-emu.org 403s non-browser
        requests), expects a human to have already dropped the official
        archive into native/manual-drop/<id>/.
     3. Extracts each archive into native/<platform>/<id>/, verifies the
        expected executable actually exists at the path the manifest
        says it should, and records the result in
        native/manifest.lock.json.

   Once native/ is populated, electron-builder bundles it via the
   "extraResources" build config (see package.json) -- from that point on
   the packaged app makes NO runtime network calls for these, same
   "fetched once, permanently embedded in the installer" guarantee the
   browser-based WASM cores already have.

   Usage:
     node tools/fetch-native-emulators.js              # fetch for this platform
     node tools/fetch-native-emulators.js --platform=win32
     node tools/fetch-native-emulators.js --only=pcsx2,flycast
*/

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(__dirname, "native", "manifest.json");
const NATIVE_DIR = path.join(ROOT, "native");
const MANUAL_DROP_DIR = path.join(NATIVE_DIR, "manual-drop");
const LOCK_PATH = path.join(NATIVE_DIR, "manifest.lock.json");

const args = process.argv.slice(2);
const platformArg = (args.find((a) => a.startsWith("--platform=")) || "").split("=")[1];
const onlyArg = (args.find((a) => a.startsWith("--only=")) || "").split("=")[1];
const PLATFORM = platformArg || process.platform; // "win32" | "darwin" | "linux"
const ONLY = onlyArg ? onlyArg.split(",").map((s) => s.trim()) : null;

function log(...a) { console.log("[fetch-native]", ...a); }
function warn(...a) { console.warn("[fetch-native] WARNING:", ...a); }

// ---- tiny promise wrapper around https.get, following redirects
// (GitHub's release asset URLs are almost always a redirect chain
// through their CDN) and writing straight to disk. ----
function download(url, destPath, redirectsLeft = 8) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "bnan-fetch-native" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error(`too many redirects fetching ${url}`));
        return resolve(download(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on("finish", () => out.close(() => resolve(destPath)));
      out.on("error", reject);
    });
    req.on("error", reject);
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      { headers: { "User-Agent": "bnan-fetch-native", Accept: "application/vnd.github+json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      }
    ).on("error", reject);
  });
}

function matchesAllPatterns(name, patterns) {
  const lower = name.toLowerCase();
  return patterns.every((p) => lower.includes(p.toLowerCase()));
}

// Real release lists turned out to need both sides: e.g. xemu's latest
// release ships regular, "-dbg-" (debug), and "-pdb" (symbols-only)
// builds side by side, all of which contain "windows-x86_64" -- there's
// no way to land on the one real build with require-patterns alone.
// Verified against a live `npm run fetch:native` run, not guessed.
function matchesAsset(name, patterns, exclude) {
  if (!matchesAllPatterns(name, patterns)) return false;
  if (!exclude || !exclude.length) return true;
  const lower = name.toLowerCase();
  return !exclude.some((p) => lower.includes(p.toLowerCase()));
}

// ---- extraction: shells out to whatever the OS already has, rather
// than pulling in a JS unzip dependency that would itself need to be
// vetted -- unzip/tar are standard on macOS/Linux, and 7z is a normal
// thing to have on a machine set up to build RPCS3's .7z release. ----
function extract(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  if (lower.endsWith(".zip")) {
    if (process.platform === "win32") {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path "${archivePath}" -DestinationPath "${destDir}" -Force`], { stdio: "inherit" });
    } else {
      execFileSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { stdio: "inherit" });
    }
  } else if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz") || lower.endsWith(".tar.xz") || lower.endsWith(".tar.zst") || lower.endsWith(".tar")) {
    // Plain "-xf" (no explicit -z/-J) auto-detects gzip/xz/zstd/none --
    // both GNU tar and macOS's default bsdtar support this. Verified
    // needed for real assets, not hypothetical: PCSX2's actual macOS
    // release is a .tar.xz, not the .zip this originally assumed.
    execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
  } else if (lower.endsWith(".7z")) {
    execFileSync("7z", ["x", `-o${destDir}`, "-y", archivePath], { stdio: "inherit" });
  } else if (lower.endsWith(".dmg")) {
    // Mount, copy the .app out, unmount -- macOS only, matches how a
    // human would install it by hand.
    const mountPoint = fs.mkdtempSync(path.join(require("os").tmpdir(), "bnan-dmg-"));
    execFileSync("hdiutil", ["attach", archivePath, "-mountpoint", mountPoint, "-nobrowse", "-quiet"]);
    try {
      const apps = fs.readdirSync(mountPoint).filter((f) => f.endsWith(".app"));
      for (const app of apps) {
        execFileSync("cp", ["-R", path.join(mountPoint, app), destDir]);
      }
    } finally {
      execFileSync("hdiutil", ["detach", mountPoint, "-quiet"]);
    }
  } else if (lower.endsWith(".appimage")) {
    // Not an archive -- it *is* the executable. Copy it in under a FIXED
    // name (not the original, version-stamped release filename like
    // "xemu-0.8.136-x86_64.AppImage") so manifest.json's exeRelPath can
    // reference a stable "app.AppImage" instead of having to be rewritten
    // every time a project cuts a new version.
    fs.copyFileSync(archivePath, path.join(destDir, "app.AppImage"));
    fs.chmodSync(path.join(destDir, "app.AppImage"), 0o755);
  } else {
    throw new Error(`don't know how to extract: ${archivePath}`);
  }
}

async function fetchGithubEmulator(id, def) {
  const patterns = def.assetPatterns && def.assetPatterns[PLATFORM];
  if (!patterns) {
    log(`${id}: no release for platform "${PLATFORM}" -- skipping (${def.unsupportedNote || "not listed for this OS"})`);
    return null;
  }
  const exclude = def.assetExclude && def.assetExclude[PLATFORM];
  // RPCS3 is the concrete reason this exists, verified for real: its
  // build artifacts aren't in one repo with per-OS assets like every
  // other emulator here -- RPCS3/rpcs3 (the actual source) publishes NO
  // binaries at all, and win/linux/mac builds each live in their own
  // separate *-binaries-<os> repo instead. repoPerPlatform overrides the
  // default `repo` for just the platforms that need it.
  const repo = (def.repoPerPlatform && def.repoPerPlatform[PLATFORM]) || def.repo;
  log(`${id}: resolving latest release of ${repo}...`);
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  if (!release.assets || !release.assets.length) {
    warn(`${id}: latest release (${release.tag_name || "?"}) has no downloadable assets -- skipping`);
    return null;
  }
  const matches = release.assets.filter((a) => matchesAsset(a.name, patterns, exclude));
  if (!matches.length) {
    warn(`${id}: no asset in release ${release.tag_name} matched patterns [${patterns.join(", ")}]${exclude ? ` (excluding [${exclude.join(", ")}])` : ""}. Available assets: ${release.assets.map((a) => a.name).join(", ")}`);
    warn(`${id}: this usually means the project renamed its release assets -- update assetPatterns/assetExclude in tools/native/manifest.json.`);
    return null;
  }
  if (matches.length > 1) {
    warn(`${id}: ${matches.length} assets matched patterns [${patterns.join(", ")}] -- picking the first (${matches[0].name}). Consider tightening assetPatterns/assetExclude so this is unambiguous: ${matches.map((a) => a.name).join(", ")}`);
  }
  const asset = matches[0];
  const destDir = path.join(NATIVE_DIR, PLATFORM, id);
  fs.rmSync(destDir, { recursive: true, force: true });
  const tmpArchive = path.join(require("os").tmpdir(), asset.name);
  log(`${id}: downloading ${asset.name} (${(asset.size / 1e6).toFixed(0)}MB)...`);
  await download(asset.browser_download_url, tmpArchive);
  log(`${id}: extracting into native/${PLATFORM}/${id}/...`);
  extract(tmpArchive, destDir);
  fs.rmSync(tmpArchive, { force: true });
  return { version: release.tag_name, destDir };
}

// Not a real archive -- these are either this script's own instructions
// (README.txt, dropped by the project setup) or OS noise, never the
// thing a human actually downloaded. Excluding them by extension (rather
// than just "not a dotfile") is what stopped a real bug: the very first
// run of this script picked up its own README.txt placeholder as "the
// archive" and failed trying to extract it.
const NON_ARCHIVE_EXTENSIONS = new Set([".txt", ".md", ".ds_store"]);

function fetchManualEmulator(id, def) {
  const dropDir = path.join(MANUAL_DROP_DIR, id);
  const candidates = fs.existsSync(dropDir)
    ? fs.readdirSync(dropDir).filter((f) => !f.startsWith(".") && !NON_ARCHIVE_EXTENSIONS.has(path.extname(f).toLowerCase()))
    : [];
  if (!candidates.length) return null; // caller decides what "nothing here" means for this emulator
  const name = candidates[0];
  const dropped = path.join(dropDir, name);
  const destDir = path.join(NATIVE_DIR, PLATFORM, id);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  // A human doing this by hand (mounting a .dmg themselves, unzipping
  // with a GUI tool, etc.) very often ends up dropping the ALREADY
  // EXTRACTED thing -- a real .app bundle, a plain folder -- not the
  // original archive file. Verified needed, not hypothetical: exactly
  // this happened with both Dolphin and RPCS3 while building this.
  // extract() only knows how to unpack compressed files, so a directory
  // (or anything ending .app, which IS a directory even though Finder
  // shows it as one icon) gets copied straight in instead.
  if (fs.statSync(dropped).isDirectory() || name.toLowerCase().endsWith(".app")) {
    log(`${id}: copying already-extracted ${name} into native/${PLATFORM}/${id}/...`);
    fs.cpSync(dropped, path.join(destDir, name), { recursive: true });
  } else {
    log(`${id}: extracting manually-provided ${name} into native/${PLATFORM}/${id}/...`);
    extract(dropped, destDir);
  }
  return { version: "manual", destDir };
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  fs.mkdirSync(NATIVE_DIR, { recursive: true });
  fs.mkdirSync(MANUAL_DROP_DIR, { recursive: true });

  const lock = fs.existsSync(LOCK_PATH) ? JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) : {};
  lock[PLATFORM] = lock[PLATFORM] || {};

  for (const [id, def] of Object.entries(manifest.emulators)) {
    if (ONLY && !ONLY.includes(id)) continue;
    if ((def.unsupportedPlatforms || []).includes(PLATFORM)) {
      log(`${id}: not supported on ${PLATFORM} -- ${def.unsupportedNote || ""}`);
      continue;
    }
    try {
      // Manual-drop is checked for EVERY emulator, not just ones marked
      // source:"manual" -- a human can always choose to hand-provide any
      // of these (e.g. this machine had no `7z` to extract RPCS3's
      // normal GitHub release, so it got extracted by hand elsewhere and
      // dropped in instead), and that should just work rather than being
      // silently ignored in favor of re-attempting the automated path.
      let result = fetchManualEmulator(id, def);
      if (!result) {
        if (def.source === "manual") {
          warn(`${id}: no downloaded archive found in native/manual-drop/${id}/ -- ${def.manualNote || "drop the official archive there first"}`);
          continue;
        }
        result = await fetchGithubEmulator(id, def);
      }
      if (!result) continue;
      const plat = def.platforms[PLATFORM];
      const exePath = path.join(result.destDir, plat.exeRelPath);
      // GitHub archives commonly extract into a single nested top-level
      // folder (e.g. "pcsx2-v2.1/pcsx2-qt.exe") rather than flat --
      // if the expected path isn't there, search one level down before
      // giving up, since that's the far more common shape in practice.
      let finalExePath = exePath;
      if (!fs.existsSync(finalExePath)) {
        const nested = fs.readdirSync(result.destDir).filter((f) =>
          fs.statSync(path.join(result.destDir, f)).isDirectory()
        );
        const found = nested
          .map((d) => path.join(result.destDir, d, plat.exeRelPath))
          .find((p) => fs.existsSync(p));
        if (found) finalExePath = found;
      }
      // macOS .app bundle names are frequently version-stamped in the
      // release archive itself (confirmed for real: PCSX2's actual
      // bundle is "PCSX2-v2.6.3.app", not the plain "PCSX2.app" its own
      // Info.plist/product name would suggest) -- a literal exeRelPath
      // would go stale on every single release. If exeRelPath points
      // inside a "<Name>.app/..." bundle and that exact name isn't
      // there, fall back to whatever *.app actually got extracted,
      // as long as there's exactly one (an ambiguous match is a real
      // problem worth surfacing, not silently guessing).
      if (!fs.existsSync(finalExePath) && plat.exeRelPath.includes(".app/")) {
        const insideBundle = plat.exeRelPath.slice(plat.exeRelPath.indexOf(".app/") + 5);
        const apps = fs.readdirSync(result.destDir).filter((f) => f.endsWith(".app"));
        if (apps.length === 1) {
          const candidate = path.join(result.destDir, apps[0], insideBundle);
          if (fs.existsSync(candidate)) finalExePath = candidate;
        } else if (apps.length > 1) {
          warn(`${id}: multiple .app bundles found (${apps.join(", ")}) and none matched exeRelPath exactly -- can't guess which one. Check native/${PLATFORM}/${id}/ by hand.`);
        }
      }
      if (!fs.existsSync(finalExePath)) {
        warn(`${id}: extracted, but expected executable not found at ${plat.exeRelPath} (or one level deeper, or under a differently-named .app bundle). Check native/${PLATFORM}/${id}/ by hand and fix exeRelPath in manifest.json.`);
        continue;
      }
      if (process.platform !== "win32") fs.chmodSync(finalExePath, 0o755);
      lock[PLATFORM][id] = {
        version: result.version,
        exePath: path.relative(NATIVE_DIR, finalExePath),
        systems: def.systems,
        args: def.args,
      };
      log(`${id}: OK (${result.version}) -> ${path.relative(ROOT, finalExePath)}`);
    } catch (e) {
      warn(`${id}: failed -- ${e.message}`);
    }
  }

  fs.writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2));
  log(`wrote ${path.relative(ROOT, LOCK_PATH)}`);
  const gotCount = Object.keys(lock[PLATFORM]).length;
  const totalCount = Object.keys(manifest.emulators).filter(
    (id) => !(manifest.emulators[id].unsupportedPlatforms || []).includes(PLATFORM)
  ).length;
  log(`${gotCount}/${totalCount} native emulators ready for ${PLATFORM}.`);
  if (gotCount < totalCount) {
    log(`Missing ones will simply not show as playable in B-NAN -- see warnings above for why each one failed.`);
  }
}

main().catch((e) => {
  console.error("[fetch-native] fatal:", e);
  process.exit(1);
});
