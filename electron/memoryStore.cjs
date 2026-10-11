"use strict";
/**
 * Memory store: what the user read, on this laptop only.
 *
 * SQLite via node:sqlite (built into Electron's Node, FTS5 included, no native
 * build), in the app's userData. Two layers:
 *   - pages: a TEMPORARY inbox of raw page text from the extension. Kept until
 *     the background worker has gisted it, at most 24 hours.
 *   - memories: compact gists (tier 0, this month in detail), monthly digests
 *     (tier 1) + month overviews (tier 2), optional yearly overviews (tier 3).
 *     FTS5/BM25 over title, gist, topics, entities and body; vectors as Float32
 *     blobs in `vectors`; `compactions` + `backups` (7-day undo) for the
 *     monthly compaction (memoryCompact.cjs).
 *
 * Privacy contract (tested): this module talks to nothing but its own
 * database file and thumbnail folder. No network, no cloud clients, no
 * logging of page content.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { DAY } = require("./memoryQuery.cjs");

const MAX_TEXT = 20000;
const DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Raw page text never outlives this, gisted or not. */
const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
/** Pages waiting to be gisted; beyond this the oldest raw items are dropped. */
const INBOX_MAX = 300;
const MAX_THUMB_BYTES = 400 * 1024;
const BACKUP_TTL_MS = 7 * DAY;

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

/** "2027-01" for a time, in the local timezone. */
function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Local-time bounds of a month key. */
function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() - 1 };
}

const DEFAULT_SETTINGS = { enabled: false, paused: false, excluded: [], sizeCapMB: 500, keepShrinking: false, port: 47821 };

const J = (v, d) => {
  try {
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};

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
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      tier INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'other',
      title TEXT NOT NULL DEFAULT '',
      gist TEXT NOT NULL DEFAULT '',
      key_points TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      entities TEXT NOT NULL DEFAULT '[]',
      importance INTEGER NOT NULL DEFAULT 1,
      pinned INTEGER NOT NULL DEFAULT 0,
      urls TEXT NOT NULL DEFAULT '[]',
      domains TEXT NOT NULL DEFAULT '',
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      visit_count INTEGER NOT NULL DEFAULT 1,
      minutes REAL NOT NULL DEFAULT 0,
      month TEXT NOT NULL,
      hashes TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}',
      body TEXT NOT NULL DEFAULT '',
      thumb TEXT,
      bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS memories_month ON memories(month, tier);
    CREATE INDEX IF NOT EXISTS memories_seen ON memories(last_seen);
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(title, gist, topics, entities, body, content='memories', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, gist, topics, entities, body) VALUES (new.id, new.title, new.gist, new.topics, new.entities, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, gist, topics, entities, body) VALUES ('delete', old.id, old.title, old.gist, old.topics, old.entities, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, gist, topics, entities, body) VALUES ('delete', old.id, old.title, old.gist, old.topics, old.entities, old.body);
      INSERT INTO memories_fts(rowid, title, gist, topics, entities, body) VALUES (new.id, new.title, new.gist, new.topics, new.entities, new.body);
    END;
    CREATE TABLE IF NOT EXISTS vectors (memory_id INTEGER PRIMARY KEY, model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS compactions (
      month TEXT PRIMARY KEY, status TEXT NOT NULL, entries INTEGER NOT NULL DEFAULT 0, digests INTEGER NOT NULL DEFAULT 0,
      bytes_before INTEGER NOT NULL DEFAULT 0, bytes_after INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY, month TEXT NOT NULL, payload TEXT NOT NULL, digest_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  `);
  // Upgrade an inbox from the first Memory build: no raw page is older than
  // 24h from the moment it entered the inbox; the old page FTS index goes.
  const cols = new Set(db.prepare("PRAGMA table_info(pages)").all().map((c) => c.name));
  if (!cols.has("inbox_at")) db.exec(`ALTER TABLE pages ADD COLUMN inbox_at INTEGER NOT NULL DEFAULT 0; UPDATE pages SET inbox_at = ${Number(now())};`);
  if (!cols.has("attempts")) db.exec("ALTER TABLE pages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("seconds")) db.exec("ALTER TABLE pages ADD COLUMN seconds INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("manual")) db.exec("ALTER TABLE pages ADD COLUMN manual INTEGER NOT NULL DEFAULT 0");
  db.exec("DROP TRIGGER IF EXISTS pages_ai; DROP TRIGGER IF EXISTS pages_ad; DROP TABLE IF EXISTS pages_fts;");

  /** Run fn in one transaction; any throw rolls everything back. */
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- settings ------------------------------------------------------------
  const getRaw = db.prepare("SELECT value FROM settings WHERE key = ?");
  const putRaw = db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const kvGet = (k) => J(getRaw.get(k)?.value, null);
  const kvSet = (k, v) => putRaw.run(k, JSON.stringify(v));

  function settings() {
    const row = getRaw.get("settings");
    const stored = row ? JSON.parse(row.value) : {};
    // Retention was replaced by monthly compaction + the size cap; an old
    // 200 MB default moves up to the new 500 MB one.
    delete stored.retentionDays;
    if (stored.sizeCapMB === 200) stored.sizeCapMB = 500;
    const s = { ...DEFAULT_SETTINGS, ...stored };
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
    if (typeof patch.keepShrinking === "boolean") next.keepShrinking = patch.keepShrinking;
    if (Array.isArray(patch.excluded)) {
      next.excluded = [...new Set(patch.excluded.map((d) => String(d).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")).filter(Boolean))].slice(0, 500);
    }
    if (Number.isFinite(patch.sizeCapMB)) next.sizeCapMB = Math.min(5000, Math.max(10, Math.round(patch.sizeCapMB)));
    if (Number.isInteger(patch.port) && patch.port >= 1024 && patch.port <= 65535) next.port = patch.port;
    if (patch.rotateToken === true) next.token = crypto.randomBytes(24).toString("base64url");
    putRaw.run("settings", JSON.stringify(next));
    // A newly excluded site: drop what's waiting in the inbox from it.
    for (const r of db.prepare("SELECT id, url FROM pages").all()) if (isExcluded(r.url, next.excluded)) removeInbox(r.id);
    return next;
  }

  // ---- inbox (raw, temporary) ------------------------------------------------
  const findDup = db.prepare("SELECT id FROM pages WHERE url = ? AND hash = ? AND captured_at > ? LIMIT 1");
  const insert = db.prepare("INSERT INTO pages(url, title, text, captured_at, domain, hash, bytes, inbox_at, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
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
    const manual = item.manual === true ? 1 : 0;
    const r = insert.run(url, title, text, t, domainOf(url), hash, bytes, t, manual);
    const id = Number(r.lastInsertRowid);
    // A thumbnail only for "Save this page", and only a small one.
    if (manual && item.screenshot && shotsDir) saveThumb(id, item.screenshot);
    return { ok: true, id };
  }

  function saveThumb(id, dataUrl) {
    const m = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) return;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_THUMB_BYTES) return;
    fs.mkdirSync(shotsDir, { recursive: true });
    const name = `p${id}.${m[1] === "png" ? "png" : "jpg"}`;
    fs.writeFileSync(path.join(shotsDir, name), buf);
    setShot.run(name, id);
  }
  const rmThumb = (name) => {
    if (name && shotsDir) fs.rmSync(path.join(shotsDir, path.basename(name)), { force: true });
  };

  /** Time on page from the extension: added to the waiting page or its memory. */
  function addVisitTime(rawUrl, seconds) {
    const url = String(rawUrl ?? "").replace(/#.*$/, "");
    const sec = Math.max(0, Math.min(4 * 3600, Math.round(Number(seconds) || 0)));
    if (!sec || !/^https?:\/\//i.test(url)) return false;
    const p = db.prepare("SELECT id FROM pages WHERE url = ? ORDER BY captured_at DESC LIMIT 1").get(url);
    if (p) {
      db.prepare("UPDATE pages SET seconds = seconds + ? WHERE id = ?").run(sec, Number(p.id));
      return true;
    }
    const m = findByUrl(url);
    if (m) {
      db.prepare("UPDATE memories SET minutes = minutes + ? WHERE id = ?").run(sec / 60, m.id);
      return true;
    }
    return false;
  }

  const inboxRow = (r) =>
    r && { id: Number(r.id), url: r.url, title: r.title, text: r.text, capturedAt: Number(r.captured_at), domain: r.domain, hash: r.hash, attempts: Number(r.attempts), seconds: Number(r.seconds), manual: Boolean(r.manual), shot: r.shot || null };

  function inboxNext(maxAttempts = 3) {
    return inboxRow(db.prepare("SELECT * FROM pages WHERE attempts < ? ORDER BY captured_at ASC LIMIT 1").get(maxAttempts));
  }
  const inboxCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM pages").get().n);
  const inboxFail = (id) => db.prepare("UPDATE pages SET attempts = attempts + 1 WHERE id = ?").run(Number(id));
  const inboxGet = (id) => inboxRow(db.prepare("SELECT * FROM pages WHERE id = ?").get(Number(id)));
  function removeInbox(id, { keepThumb = false } = {}) {
    const r = db.prepare("SELECT shot FROM pages WHERE id = ?").get(Number(id));
    if (r && r.shot && !keepThumb) rmThumb(r.shot);
    return db.prepare("DELETE FROM pages WHERE id = ?").run(Number(id)).changes > 0;
  }

  /** Raw text older than 24h goes, gisted or not. Returns how many. */
  function expireInbox() {
    const old = db.prepare("SELECT id FROM pages WHERE inbox_at < ?").all(now() - INBOX_TTL_MS);
    for (const r of old) removeInbox(r.id);
    return old.length;
  }

  /** Over the queue cap: drop the oldest raw items. Returns how many. */
  function trimInbox(max = INBOX_MAX) {
    const n = inboxCount();
    if (n <= max) return 0;
    const old = db.prepare("SELECT id FROM pages ORDER BY captured_at ASC LIMIT ?").all(n - max);
    for (const r of old) removeInbox(r.id);
    const dropped = (kvGet("inbox_dropped") || 0) + old.length;
    kvSet("inbox_dropped", dropped);
    return old.length;
  }

  // ---- memories ---------------------------------------------------------------
  const memRow = (r) =>
    r && {
      id: Number(r.id),
      tier: Number(r.tier),
      kind: r.kind,
      title: r.title,
      gist: r.gist,
      key_points: J(r.key_points, []),
      topics: J(r.topics, []),
      entities: J(r.entities, []),
      importance: Number(r.importance),
      pinned: Boolean(r.pinned),
      urls: J(r.urls, []),
      domains: String(r.domains || "").split(" ").filter(Boolean),
      first_seen: Number(r.first_seen),
      last_seen: Number(r.last_seen),
      visit_count: Number(r.visit_count),
      minutes: Number(r.minutes),
      month: r.month,
      hashes: J(r.hashes, []),
      meta: J(r.meta, {}),
      thumb: r.thumb || null,
      bytes: Number(r.bytes),
    };

  /** Searchable extra text: key points + kept highlights (digests). */
  const bodyOf = (m) =>
    [
      ...(m.key_points || []),
      ...((m.meta && m.meta.highlights) || []).map((h) => `${h.title}. ${h.gist}`),
      ...((m.meta && m.meta.sources) || []).map((s) => s.title),
      m.meta && m.meta.query ? m.meta.query : "",
    ]
      .filter(Boolean)
      .join("\n");
  const sizeOf = (m) =>
    Buffer.byteLength(JSON.stringify([m.title, m.gist, m.key_points, m.topics, m.entities, m.urls, m.meta, m.hashes])) + 64;

  const memInsert = db.prepare(`INSERT INTO memories(tier, kind, title, gist, key_points, topics, entities, importance, pinned, urls, domains, first_seen, last_seen, visit_count, minutes, month, hashes, meta, body, thumb, bytes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function insertMemory(m) {
    const first = Number(m.first_seen ?? now());
    const row = {
      tier: m.tier ?? 0, kind: m.kind || "other", title: m.title || "", gist: m.gist || "",
      key_points: m.key_points || [], topics: m.topics || [], entities: m.entities || [],
      importance: m.importance ?? 1, pinned: m.pinned ? 1 : 0, urls: m.urls || [],
      domains: [...new Set(m.domains || (m.urls || []).map((u) => domainOf(u.url)).filter(Boolean))],
      first_seen: first, last_seen: Number(m.last_seen ?? first), visit_count: m.visit_count ?? 1, minutes: m.minutes ?? 0,
      month: m.month || monthKey(first), hashes: m.hashes || [], meta: m.meta || {}, thumb: m.thumb || null,
    };
    const r = memInsert.run(
      row.tier, row.kind, row.title, row.gist, JSON.stringify(row.key_points), JSON.stringify(row.topics), JSON.stringify(row.entities),
      row.importance, row.pinned, JSON.stringify(row.urls), row.domains.join(" "), row.first_seen, row.last_seen, row.visit_count, row.minutes,
      row.month, JSON.stringify(row.hashes), JSON.stringify(row.meta), bodyOf(row), row.thumb, sizeOf(row),
    );
    return Number(r.lastInsertRowid);
  }

  function updateMemory(id, patch) {
    const cur = getMemory(id);
    if (!cur) return false;
    const m = { ...cur, ...patch };
    if (patch.urls) m.domains = [...new Set(m.urls.map((u) => domainOf(u.url)).filter(Boolean))];
    db.prepare(
      `UPDATE memories SET kind=?, title=?, gist=?, key_points=?, topics=?, entities=?, importance=?, pinned=?, urls=?, domains=?, first_seen=?, last_seen=?,
       visit_count=?, minutes=?, hashes=?, meta=?, body=?, thumb=?, bytes=? WHERE id=?`,
    ).run(
      m.kind, m.title, m.gist, JSON.stringify(m.key_points), JSON.stringify(m.topics), JSON.stringify(m.entities), m.importance, m.pinned ? 1 : 0,
      JSON.stringify(m.urls), m.domains.join(" "), m.first_seen, m.last_seen, m.visit_count, m.minutes, JSON.stringify(m.hashes),
      JSON.stringify(m.meta), bodyOf(m), m.thumb, sizeOf(m), Number(id),
    );
    return true;
  }

  const getMemory = (id) => memRow(db.prepare("SELECT * FROM memories WHERE id = ?").get(Number(id)));

  function deleteMemories(ids) {
    for (const id of ids) {
      const r = db.prepare("SELECT thumb FROM memories WHERE id = ?").get(Number(id));
      if (r && r.thumb) rmThumb(r.thumb);
      db.prepare("DELETE FROM memories WHERE id = ?").run(Number(id));
      db.prepare("DELETE FROM vectors WHERE memory_id = ?").run(Number(id));
    }
    return ids.length;
  }

  /** The detail memory (tier 0) that already holds this URL. */
  function findByUrl(url) {
    const r = db.prepare("SELECT * FROM memories WHERE tier = 0 AND urls LIKE ? ORDER BY last_seen DESC LIMIT 5").all(`%${JSON.stringify(url).slice(1, -1)}%`);
    return memRow(r.find((x) => J(x.urls, []).some((u) => u.url === url)) || null);
  }
  function findByHash(hash) {
    if (!hash) return null;
    return memRow(db.prepare("SELECT * FROM memories WHERE tier = 0 AND hashes LIKE ? LIMIT 1").get(`%"${hash}"%`) || null);
  }
  const seenSince = (since) => db.prepare("SELECT * FROM memories WHERE tier = 0 AND last_seen >= ? ORDER BY last_seen DESC").all(Number(since)).map(memRow);

  function memoriesWhere({ tier = null, month = null, from = null, to = null, kind = null, domain = null, limit = 500, offset = 0 } = {}) {
    const w = [];
    const p = [];
    if (tier != null) {
      w.push(Array.isArray(tier) ? `tier IN (${tier.map(() => "?").join(",")})` : "tier = ?");
      p.push(...(Array.isArray(tier) ? tier : [tier]));
    }
    if (month) {
      w.push("month = ?");
      p.push(month);
    }
    if (from != null) {
      w.push("last_seen >= ?");
      p.push(Number(from));
    }
    if (to != null) {
      w.push("first_seen <= ?");
      p.push(Number(to));
    }
    if (kind) {
      w.push("kind = ?");
      p.push(kind);
    }
    if (domain) {
      w.push("(' ' || domains || ' ') LIKE ?");
      p.push(`% ${domain}%`);
    }
    return db
      .prepare(`SELECT * FROM memories ${w.length ? `WHERE ${w.join(" AND ")}` : ""} ORDER BY last_seen DESC LIMIT ? OFFSET ?`)
      .all(...p, Math.max(1, Math.min(100000, limit)), Math.max(0, offset))
      .map(memRow);
  }

  // ---- vectors --------------------------------------------------------------
  const setVector = (id, blob, model, dim) =>
    db.prepare("INSERT INTO vectors(memory_id, model, dim, vec) VALUES (?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model, dim=excluded.dim, vec=excluded.vec").run(Number(id), model, dim, blob);
  const allVectors = () => db.prepare("SELECT memory_id, model, vec FROM vectors").all().map((r) => ({ id: Number(r.memory_id), model: r.model, vec: r.vec }));
  const missingVectors = (limit = 16) =>
    db.prepare("SELECT m.* FROM memories m LEFT JOIN vectors v ON v.memory_id = m.id WHERE v.memory_id IS NULL ORDER BY m.last_seen DESC LIMIT ?").all(limit).map(memRow);

  // ---- keyword search ---------------------------------------------------------
  const ftsWords = (words) =>
    words
      .map((w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim())
      .filter(Boolean)
      .flatMap((w) => w.split(" "))
      .filter((w) => w.length > 1);
  const ftsQuery = (words, op = "OR") => ftsWords(words).map((w) => `("${w}" OR "${w}"*)`).join(` ${op} `);

  /**
   * BM25 over title / gist / topics / entities / body: [{ id, bm25, coverage }]
   * best first. `coverage` is the share of the query's words the memory
   * contains (stemmed / prefix), so a single shared word ("computing" vs
   * "computed") can be told apart from a real match.
   */
  const stemOf = (w) => w.replace(/(ings?|ed|es|s)$/, "");
  function keywordSearch(keywords, limit = 60) {
    const words = ftsWords(keywords);
    if (!words.length) return [];
    const run = (match) =>
      db.prepare("SELECT rowid AS id, bm25(memories_fts, 5.0, 2.0, 3.0, 2.0, 1.0) AS rank FROM memories_fts WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?").all(match, limit);
    let rows = words.length > 1 ? run(`"${words.join(" ")}"`) : [];
    if (!rows.length) rows = run(ftsQuery(keywords, "AND"));
    if (!rows.length) rows = run(ftsQuery(keywords));
    const stems = [...new Set(words.map(stemOf).filter((w) => w.length > 1))];
    return rows.map((r) => {
      const m = getMemory(r.id);
      const hay = m ? ` ${[m.title, m.gist, m.topics.join(" "), m.entities.join(" "), m.key_points.join(" ")].join(" ").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} ` : "";
      const hit = stems.filter((w) => hay.includes(` ${w}`)).length;
      return { id: Number(r.id), bm25: -Number(r.rank), coverage: stems.length ? hit / stems.length : 0 };
    });
  }

  // ---- compaction bookkeeping ----------------------------------------------
  const compaction = (month) => {
    const r = db.prepare("SELECT * FROM compactions WHERE month = ?").get(month);
    return r ? { month: r.month, status: r.status, entries: Number(r.entries), digests: Number(r.digests), bytesBefore: Number(r.bytes_before), bytesAfter: Number(r.bytes_after), at: Number(r.at) } : null;
  };
  const setCompaction = (c) =>
    db.prepare(
      "INSERT INTO compactions(month, status, entries, digests, bytes_before, bytes_after, at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(month) DO UPDATE SET status=excluded.status, entries=excluded.entries, digests=excluded.digests, bytes_before=excluded.bytes_before, bytes_after=excluded.bytes_after, at=excluded.at",
    ).run(c.month, c.status, c.entries || 0, c.digests || 0, c.bytesBefore || 0, c.bytesAfter || 0, c.at ?? now());
  const compactions = () => db.prepare("SELECT month FROM compactions ORDER BY at DESC").all().map((r) => compaction(r.month));
  const deleteCompaction = (month) => db.prepare("DELETE FROM compactions WHERE month = ?").run(month);

  const addBackup = (month, payload, digestIds) =>
    Number(db.prepare("INSERT INTO backups(month, payload, digest_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(month, JSON.stringify(payload), JSON.stringify(digestIds), now(), now() + BACKUP_TTL_MS).lastInsertRowid);
  const backupsFor = (month) =>
    db.prepare("SELECT * FROM backups WHERE month = ? AND expires_at > ? ORDER BY id").all(month, now()).map((r) => ({ id: Number(r.id), month: r.month, payload: J(r.payload, []), digestIds: J(r.digest_ids, []), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) }));
  const deleteBackup = (id) => db.prepare("DELETE FROM backups WHERE id = ?").run(Number(id));
  const purgeBackups = () => db.prepare("DELETE FROM backups WHERE expires_at <= ?").run(now()).changes;
  const undoableMonths = () => db.prepare("SELECT DISTINCT month FROM backups WHERE expires_at > ? ORDER BY month").all(now()).map((r) => r.month);

  // ---- housekeeping -----------------------------------------------------------
  function clear() {
    db.exec("DELETE FROM pages; DELETE FROM memories; DELETE FROM vectors; DELETE FROM compactions; DELETE FROM backups;");
    db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
    kvSet("inbox_dropped", 0);
    if (shotsDir && fs.existsSync(shotsDir)) fs.rmSync(shotsDir, { recursive: true, force: true });
  }

  /** Bytes by part: raw inbox, memories, vectors, backups. */
  function bytes() {
    const one = (sql) => Number(db.prepare(sql).get().n);
    const inbox = one("SELECT COALESCE(SUM(bytes), 0) AS n FROM pages");
    const memories = one("SELECT COALESCE(SUM(bytes), 0) AS n FROM memories");
    const vectors = one("SELECT COALESCE(SUM(length(vec)), 0) AS n FROM vectors");
    const backups = one("SELECT COALESCE(SUM(length(payload)), 0) AS n FROM backups");
    // `live` is what the size cap measures; undo backups expire in 7 days.
    return { inbox, memories, vectors, backups, live: inbox + memories + vectors, total: inbox + memories + vectors + backups };
  }

  function stats() {
    const tiers = Object.fromEntries(db.prepare("SELECT tier, COUNT(*) AS n FROM memories GROUP BY tier").all().map((r) => [Number(r.tier), Number(r.n)]));
    const r = db.prepare("SELECT COUNT(*) AS n, MIN(first_seen) AS lo, MAX(last_seen) AS hi FROM memories").get();
    const b = bytes();
    return {
      count: Number(r.n),
      bytes: b.total,
      bytesByPart: b,
      oldest: r.lo == null ? null : Number(r.lo),
      newest: r.hi == null ? null : Number(r.hi),
      tiers: { detail: tiers[0] || 0, digests: tiers[1] || 0, overviews: (tiers[2] || 0) + (tiers[3] || 0) },
      queue: inboxCount(),
      dropped: kvGet("inbox_dropped") || 0,
    };
  }

  return {
    // inbox
    ingest, addVisitTime, inboxNext, inboxCount, inboxFail, inboxGet, removeInbox, expireInbox, trimInbox,
    // memories
    insertMemory, updateMemory, getMemory, deleteMemories, findByUrl, findByHash, seenSince, memoriesWhere,
    setVector, allVectors, missingVectors, keywordSearch,
    // compaction
    compaction, setCompaction, compactions, deleteCompaction, addBackup, backupsFor, deleteBackup, purgeBackups, undoableMonths,
    // misc
    transaction, kvGet, kvSet, clear, stats, bytes, settings, setSettings, now, shotsDir,
    close: () => db.close(),
  };
}

module.exports = { createMemoryStore, isExcluded, domainOf, monthKey, monthRange, DEFAULT_EXCLUDED, EXCLUDED_WORDS, MAX_TEXT, INBOX_TTL_MS, INBOX_MAX, BACKUP_TTL_MS };
