#!/usr/bin/env node
/* Tiny static server for site/ (the download/marketing page) -- separate
   from tools/serve.js on purpose, since that one serves web/ with
   COOP/COEP headers the emulator itself needs and this page has nothing
   to do with that. Supports HTTP range requests since the download
   buttons point at real ~400MB installer files, and browsers expect to
   be able to resume/seek those. */

const http = require("http");
const path = require("path");
const fs = require("fs");

const SITE_ROOT = path.join(__dirname, "..", "site");
const PORT = process.env.PORT || 8878;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".exe": "application/octet-stream",
  ".dmg": "application/octet-stream",
  ".appimage": "application/octet-stream",
  ".deb": "application/octet-stream",
};

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(SITE_ROOT, reqPath);
  if (filePath !== SITE_ROOT && !filePath.startsWith(SITE_ROOT + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    const range = req.headers.range;

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`B-NAN site: http://127.0.0.1:${PORT}`);
});
