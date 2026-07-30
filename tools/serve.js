#!/usr/bin/env node
/* Minimal static file server for testing the web/ build in a browser.
   Usage: node tools/serve.js [port] */
const http = require("http");
const path = require("path");
const { createHandler } = require("./webStaticServer");

const ROOT = path.join(__dirname, "..", "web");
const PORT = parseInt(process.argv[2], 10) || 8877;

// Default header size limit (16KB) is too small for BBC Micro disc images,
// which get passed to the vendored jsbeeb player as base64 in a query
// string (its own loader can't take a blob: URL -- see player.js) and can
// run a few hundred KB before encoding. Bumped well past any realistic
// disc image size.
const server = http.createServer({ maxHeaderSize: 8 * 1024 * 1024 }, createHandler(ROOT));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`B-NAN (web) running at http://127.0.0.1:${PORT}`);
});
