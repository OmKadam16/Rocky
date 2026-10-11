"use strict";
/**
 * Memory store: pages the user visited, on this laptop only.
 *
 * SQLite via node:sqlite (built into Electron 44's Node, FTS5 included, no
 * native build), in the app's userData. Search is BM25 over title + text with
 * date / domain filters and a recency boost. Retention (default 90 days) and
 * a total size cap with oldest-first eviction.
 *
 * Privacy contract (tested): this module talks to nothing but its own
 * database file and screenshot folder. No network, no cloud clients, no
 * logging of page content.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { searchTermsOf, DAY } = require("./memoryQuery.cjs");

const MAX_TEXT = 20000;
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_SHOT_BYTES = 3 * 1024 * 1024;
const SHOTS_CAP_BYTES = 200 * 1024 * 1024;

/**
 * Never stored, whatever the user's list says: banking, email, health
 * portals, password managers, sign-in pages.
 */
const DEFAULT_EXCLUDED = [
  "mail.google.com", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "mail.proton.me", "proton.me", "icloud.com",
  "accounts.google.com", "login.microsoftonline.com", "appleid.apple.com",
  "1password.com", "lastpass.com", "bitwarden.com", "dashlane.com", "keepersecurity.com",
  "paypal.com", "venmo.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "capitalone.com", "citi.com", "americanexpress.com",
  "discover.com", "usbank.com", "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com", "coinbase.com", "hdfcbank.com", "icicibank.com", "sbi.co.in",
  "mychart.com", "myhealth.va.gov", "patient.info",
];
/** Hostname words that mark a category (bank, health portal, login…). */
const EXCLUDED_WORDS = /(^|[.-])(bank|banking|netbanking|ebanking|mychart|patientportal|healthportal|login|signin|auth|sso|webmail|mail)([.-]|$)|bank/;

const domainOf = (url) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** True when a URL must never be stored (defaults + the user's list). */
function isExcluded(url, userList = []) {
  const host = domainOf(url);
  if (!host) return true;
  const match = (d) => {
    const x = String(d).trim().toLowerCase().replace(/^\*\.|^www\./, "");
    return x && (host === x || host.endsWith(`.${x}`));
  };
  return DEFAULT_EXCLUDED.some(match) || userList.some(match) || EXCLUDED_WORDS.test(host);
}

const DEFAULT_SETTINGS = { enabled: false, paused: false, excluded: [], retentionDays: 90, sizeCapMB: 200, port: 47821 };

function createMemoryStore({ file = ":memory:", shotsDir = null, now = () => Date.now() } = {}) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      captured_at INTEGER NOT NULL,
      domain TEXT NOT NULL DEFAULT '',
      hash TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0,
      shot TEXT
    );
    CREATE INDEX IF NOT EXISTS pages_time ON pages(captured_at);
    CREATE INDEX IF NOT EXISTS pages_url ON pages(url);
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(title, text, content='pages', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, text) VALUES (new.id, new.title, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
    END;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  // ---- settings ------------------------------------------------------------
  const getRaw = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putRaw = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

  function settings() {
    const row = getRaw.get("settings");
    const s = { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
    if (!s.token) {
      s.token = crypto.randomBytes(24).toString("base64url");
      putRaw.run("settings", JSON.stringify(s));
    }
    return s;
  }

  function setSettings(patch) {
    const s = settings();
    const next = { ...s };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.paused === "boolean") next.paused = patch.paused;
    if (Array.isArray(patch.excluded)) {
      next.excluded = [...new Set(patch.excluded.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")).filter(Boolean))].slice(0, 500);
    }
    if (Number.isFinite(patch.retentionDays)) next.retentionDays = Math.min(3650, Math.max(1, Math.round(patch.retentionDays)));
    if (Number.isFinite(patch.sizeCapMB)) next.sizeCapMB = Math.min(5000, Math.max(10, Math.round(patch.sizeCapMB)));
    if (Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535) next.port = patch.port;
    if (patch.rotateToken === true) next.token = crypto.randomBytes(24).toString("base64url");
    putRaw.run("settings", JSON.stringify(next));
    prune();
    return next;
  }

  // ---- write -------------------------------------------------------------
  const findDup = db.prepare("SELECT id FROM pages WHERE url = ? AND hash = ? AND captured_at > ? LIMIT 1");
  const insert = db.prepare("INSERT INTO pages(url, title, text, captured_at, domain, hash, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const setShot = db.prepare("UPDATE pages SET shot = ? WHERE id = ?");

  function ingest(item) {
    const s = settings();
    // The #fragment is the same page (redirects like /Base_editing ->
    // /Genome_editing#Base_editing must not save it twice).
    const url = String(item && item.url ? item.url : "").replace(/#.*$/, "").slice(0, 2000);
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "bad_url" };
    if (isExcluded(url, s.excluded)) return { ok: false, reason: "excluded" };
    const title = String(item.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const text = String(item.text ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT);
    if (!title && !text) return { ok: false, reason: "empty" };
    const t = now();
    const hash = crypto.createHash("sha256").update(`${title}\n${text}`).digest("hex").slice(0, 32);
    const dup = findDup.get(url, hash, t - DEDUPE_WINDOW_MS);
    if (dup) return { ok: true, deduped: true, id: Number(dup.id) };
    const bytes = Buffer.byteLength(url) + Buffer.byteLength(title) + Buffer.byteLength(text);
    const r = insert.run(url, title, text, t, domainOf(url), hash, bytes);
    const id = Number(r.lastInsertRowid);
    if (item.screenshot && shotsDir) saveShot(id, item.screenshot);
    prune();
    return { ok: true, id };
  }

  function saveShot(id, dataUrl) {
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) return;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_SHOT_BYTES) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    const file = path.join(shotsDir, `${id}.${m[1] === "png" ? "png" : "jpg"}`);
    fs.writeFileSync(file, buf);
    setShot.run(path.basename(file), id);
    // Screenshot folder cap: oldest first.
    const files = fs.readdirSync(shotsDir).map((f) => ({ f, st: fs.statSync(path.join(shotsDir, f)) })).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    let total = files.reduce((n, x) => n + x.st.size, 0);
    while (total > SHOTS_CAP_BYTES && files.length) {
      const x = files.shift();
      total -= x.st.size;
      fs.rmSync(path.join(shotsDir, x.f), { force: true });
    }
  }

  const delOne = db.prepare("DELETE FROM pages WHERE id = ?");
  const shotOf = db.prepare("SELECT shot FROM pages WHERE id = ?");
  function remove(id) {
    const r = shotOf.get(Number(id));
    if (r && r.shot && shotsDir) fs.rmSync(path.join(shotsDir, r.shot), { force: true });
    return delOne.run(Number(id)).changes > 0;
  }

  function clear() {
    db.exec("DELETE FROM pages");
    db.exec("INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')");
    if (shotsDir && fs.existsSync(shotsDir)) fs.rmSync(shotsDir, { recursive: true, force: true });
  }

  const oldOnes = db.prepare("SELECT id FROM pages WHERE captured_at < ?");
  const totalBytes = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM pages");
  const oldest = db.prepare("SELECT id FROM pages ORDER BY captured_at ASC LIMIT 50");
  /** Retention, then the size cap (oldest first). */
  function prune() {
    const s = settings();
    for (const r of oldOnes.all(now() - s.retentionDays * DAY)) remove(r.id);
    const cap = s.sizeCapMB * 1024 * 1024;
    let guard = 0;
    while (Number(totalBytes.get().n) > cap && guard < 1000) {
      for (const r of oldest.all()) remove(r.id);
      guard += 1;
    }
  }

  // ---- read --------------------------------------------------------------
  const ftsWords = (words) =>
    words
      .map((w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())
      .filter(Boolean)
      .flatMap((w) => w.split(" "))
      .filter((w) => w.length > 1);
  const ftsQuery = (words, op = "OR") =>
    ftsWords(words)
      // Plain term = porter-stemmed ("editing" -> "edit"); prefix catches partial words.
      .map((w) => `("${w}" OR "${w}"*)`)
      .join(` ${op} `);

  /**
   * Keyword / BM25 search with date + domain filters and a recency boost.
   * No keywords: the pages in the range, newest first.
   */
  function search({ keywords = [], from = null, to = null, domain = null, searches = false, limit = 5 } = {}) {
    const where = [];
    const params = [];
    if (from != null) {
      where.push("p.captured_at >= ?");
      params.push(Number(from));
    }
    if (to != null) {
      where.push("p.captured_at <= ?");
      params.push(Number(to));
    }
    if (domain) {
      where.push("(p.domain = ? OR p.domain LIKE ?)");
      params.push(String(domain), `%.${domain}`);
    }
    const q = ftsQuery(keywords);
    let rows;
    if (q) {
      const run = (match) =>
        db
          .prepare(
            `SELECT p.id, p.url, p.title, p.domain, p.captured_at, bm25(pages_fts, 4.0, 1.0) AS rank,
                    snippet(pages_fts, 1, '', '', ' … ', 64) AS snip
             FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
             WHERE pages_fts MATCH ? ${where.length ? `AND ${where.join(" AND ")}` : ""}
             ORDER BY rank LIMIT 60`,
          )
          .all(match, ...params);
      // Narrowest match first: the words as a phrase ("base editing"), then
      // every word, then any word. BM25 alone can't separate pages in a small
      // collection where common words appear everywhere (Wikipedia "[edit]").
      const words = ftsWords(keywords);
      rows = words.length > 1 ? run(`"${words.join(" ")}"`) : [];
      if (!rows.length) rows = run(ftsQuery(keywords, "AND"));
      if (!rows.length) rows = run(q);
    } else {
      rows = db
        .prepare(
          `SELECT p.id, p.url, p.title, p.domain, p.captured_at, 0 AS rank, substr(p.text, 1, 280) AS snip
           FROM pages p ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
           ORDER BY p.captured_at DESC LIMIT 60`,
        )
        .all(...params);
    }
    const t = now();
    let out = rows.map((r) => {
      const ageDays = Math.max(0, (t - Number(r.captured_at)) / DAY);
      const relevance = q ? -Number(r.rank) : 1;
      return {
        id: Number(r.id),
        url: r.url,
        title: r.title,
        domain: r.domain,
        capturedAt: Number(r.captured_at),
        snippet: String(r.snip || "").replace(/\s+/g, " ").trim(),
        searchTerms: searchTermsOf(r.url),
        score: relevance * (1 + 1 / (1 + ageDays / 7)),
      };
    });
    if (searches) out = out.filter((r) => r.searchTerms);
    out.sort((a, b) => b.score - a.score || b.capturedAt - a.capturedAt);
    return out.slice(0, Math.max(1, Math.min(20, limit)));
  }

  function list({ limit = 50, offset = 0, q = "" } = {}) {
    const lim = Math.min(200, Math.max(1, Number(limit) || 50));
    const off = Math.max(0, Number(offset) || 0);
    const like = `%${String(q).trim()}%`;
    const rows = q
      ? db.prepare("SELECT id, url, title, domain, captured_at FROM pages WHERE title LIKE ? OR url LIKE ? ORDER BY captured_at DESC LIMIT ? OFFSET ?").all(like, like, lim, off)
      : db.prepare("SELECT id, url, title, domain, captured_at FROM pages ORDER BY captured_at DESC LIMIT ? OFFSET ?").all(lim, off);
    return rows.map((r) => ({ id: Number(r.id), url: r.url, title: r.title, domain: r.domain, capturedAt: Number(r.captured_at) }));
  }

  function stats() {
    const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b, MIN(captured_at) AS lo, MAX(captured_at) AS hi FROM pages").get();
    return { count: Number(r.n), bytes: Number(r.b), oldest: r.lo == null ? null : Number(r.lo), newest: r.hi == null ? null : Number(r.hi) };
  }

  return { ingest, search, list, remove, clear, stats, prune, settings, setSettings, close: () => db.close() };
}

module.exports = { createMemoryStore, isExcluded, domainOf, DEFAULT_EXCLUDED, EXCLUDED_WORDS, MAX_TEXT };
