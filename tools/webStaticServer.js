/* Shared static-file HTTP request handler for serving web/ -- used by both
   tools/serve.js (plain browser testing) and electron/main.js (the
   packaged app's own local server). These used to be two independently
   maintained copies of the exact same handler (found in a codebase
   audit, confirmed byte-identical via diff) -- one place now, so a fix
   to one (like the COOP/COEP headers below) can't silently drift out of
   sync with the other again. */

const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".data": "application/octet-stream",
};

// A few cores (PSP, DOS, 3DS/azahar) need SharedArrayBuffer, which only
// exists in a cross-origin-isolated page -- every response needs these
// two headers, including the SPA-fallback one below, or Chrome's COEP
// enforcement blocks it even though it's same-origin (confirmed: this was
// a real net::ERR_BLOCKED_BY_RESPONSE until they were added everywhere).
const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// webRoot must be the absolute path to the web/ directory.
function createHandler(webRoot) {
  return function handleRequest(req, res) {
    let reqPath = decodeURIComponent(req.url.split("?")[0]);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(webRoot, reqPath);
    // A plain startsWith(webRoot) would also pass for a sibling directory
    // that happens to share webRoot as a string prefix (e.g. "web" vs a
    // hypothetical "web-something") -- checking against webRoot + sep
    // makes this a real path-boundary check, not just a string one.
    if (filePath !== webRoot && !filePath.startsWith(webRoot + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        // web/a8/ is a client-side-routed SPA (Atari 8-bit, via
        // sfotty-pie, vendored at /a8/ to match its own hardcoded
        // absolute route paths like /a8/emu exactly -- see player.js for
        // why) -- it navigates to sub-paths that don't exist as real
        // files, same as any SPA needs a fallback for. Every other
        // vendored engine (EmulatorJS, jsspeccy3, jsbeeb) is single-page
        // and doesn't need this.
        if (reqPath.startsWith("/a8/") && !path.extname(reqPath)) {
          fs.readFile(path.join(webRoot, "a8", "index.html"), (err2, indexData) => {
            if (err2) {
              res.writeHead(404);
              res.end("Not found: " + reqPath);
              return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...ISOLATION_HEADERS });
            res.end(indexData);
          });
          return;
        }
        res.writeHead(404);
        res.end("Not found: " + reqPath);
        return;
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", ...ISOLATION_HEADERS });
      res.end(data);
    });
  };
}

module.exports = { createHandler, MIME };
