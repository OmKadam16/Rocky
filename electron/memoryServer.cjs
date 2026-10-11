"use strict";
/**
 * Memory ingest server: the Chrome extension's only way in.
 *
 * - Bound to 127.0.0.1 only. Started by main while the app runs and Memory is on.
 * - Every request needs Origin === chrome-extension://<our extension id>, a
 *   Host of 127.0.0.1/localhost on our port (no DNS rebinding), and the
 *   pairing token (Authorization: Bearer …, compared in constant time).
 * - Bodies over the cap are refused (413). No CORS wildcard: the only
 *   Access-Control-Allow-Origin ever sent is our extension's own origin.
 *
 * Pure Node (no Electron), so it is tested over real HTTP.
 */
const http = require("node:http");
const crypto = require("node:crypto");

/** From extension/manifest.json "key" (public key only; see memoryServer.test). */
const EXTENSION_ID = "jdnejbolgdoclegdleaaddghjbgbdidh";
const MAX_BODY = 4 * 1024 * 1024; // a page's text (≤20k chars) + an optional screenshot

function tokenOk(header, token) {
  const m = /^Bearer\s+(\S+)$/.exec(String(header || ""));
  if (!m || !token) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * opts: { store, extensionId?, host?, port, maxBody? }
 * store: { ingest(item), addVisitTime(url, seconds), stats(), settings() } (memoryStore)
 */
function createMemoryServer(opts) {
  const extensionId = opts.extensionId || EXTENSION_ID;
  const allowedOrigin = `chrome-extension://${extensionId}`;
  const host = opts.host || "127.0.0.1";
  const maxBody = opts.maxBody || MAX_BODY;
  let server = null;
  let port = opts.port;

  const send = (res, status, body, origin) => {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (origin === allowedOrigin) {
      headers["Access-Control-Allow-Origin"] = allowedOrigin;
      headers.Vary = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  function handle(req, res) {
    const origin = req.headers.origin;
    const hostHeader = String(req.headers.host || "");
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(res, 421, { ok: false, error: "bad host" });
    // Chrome omits Origin on some extension requests (plain GETs from the
    // service worker). Then the extension names itself in X-Rocky-Extension:
    // a web page can't send that header cross-origin without a preflight,
    // and a preflight always carries an Origin, which is refused here.
    const fromUs = origin === allowedOrigin || (origin === undefined && req.headers["x-rocky-extension"] === extensionId);
    if (!fromUs) return send(res, 403, { ok: false, error: "forbidden" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Rocky-Extension",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
      return res.end();
    }
    const s = opts.store.settings();
    if (!tokenOk(req.headers.authorization, s.token)) return send(res, 401, { ok: false, error: "not paired" }, origin);

    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, { ok: true, enabled: s.enabled, paused: s.paused, count: opts.store.stats().count, excluded: s.excluded }, origin);
    }
    // /ingest: a page for the inbox. /visit: time spent on a page ({ url, seconds }).
    if (req.method === "POST" && (url.pathname === "/ingest" || url.pathname === "/visit")) {
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > maxBody) {
        req.resume();
        return send(res, 413, { ok: false, error: "too large" }, origin);
      }
      let size = 0;
      const chunks = [];
      let aborted = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > maxBody && !aborted) {
          aborted = true;
          send(res, 413, { ok: false, error: "too large" }, origin);
          req.destroy();
          return;
        }
        if (!aborted) chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        if (!s.enabled) return send(res, 409, { ok: false, reason: "off" }, origin);
        if (s.paused) return send(res, 409, { ok: false, reason: "paused" }, origin);
        let item;
        try {
          item = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(res, 400, { ok: false, error: "bad json" }, origin);
        }
        try {
          const out =
            url.pathname === "/visit"
              ? { ok: Boolean(opts.store.addVisitTime && opts.store.addVisitTime(item && item.url, item && item.seconds)) }
              : opts.store.ingest(item);
          send(res, 200, out, origin);
        } catch {
          // Never echo or log page content.
          send(res, 500, { ok: false, error: "store failed" }, origin);
        }
      });
      return;
    }
    return send(res, 404, { ok: false, error: "not found" }, origin);
  }

  return {
    start: () =>
      new Promise((resolve, reject) => {
        if (server) return resolve(port);
        server = http.createServer(handle);
        server.on("error", (e) => {
          server = null;
          reject(e);
        });
        server.listen(port, host, () => {
          port = server.address().port;
          resolve(port);
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        if (!server) return resolve();
        const s = server;
        server = null;
        s.close(() => resolve());
        s.closeAllConnections?.();
      }),
    running: () => Boolean(server),
    port: () => port,
  };
}

module.exports = { createMemoryServer, EXTENSION_ID, MAX_BODY, tokenOk };
