#!/usr/bin/env node
/* Copies web/ into ios/www/ so Capacitor has a source folder to bundle.
   Re-run this (npm run copy-web) any time web/ changes before syncing. */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "web");
const DEST = path.join(__dirname, "www");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
copyDir(SRC, DEST);
console.log("Copied web/ -> ios/www/");
