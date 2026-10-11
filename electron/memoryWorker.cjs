"use strict";
/**
 * The background worker that turns the raw inbox into memories.
 *
 * One item at a time, never while the user is busy (a booking-agent run, a
 * typed or spoken turn), at most `perMinute` items a minute, each with a
 * timeout and a retry limit. For each page:
 *   classify (junk -> dropped, search page -> "searched: <query>" in code)
 *   -> gist with the local model -> embed -> merge into a reading session
 *   (same page revisited, or the same topic/site within 30 minutes) or store
 *   a new memory -> delete the raw text.
 * Also backfills vectors for memories that don't have one yet (batches of 16).
 *
 * Logs timings only (gist_ms, embed_ms), never content.
 */
const { classifyPage, gistPage, searchMemory, titleOnlyMemory, embedText } = require("./memoryGist.cjs");
const { cosine, toBlob, fromBlob, EMBED_MODEL, EMBED_BATCH } = require("./memoryVectors.cjs");
const { isExcluded, domainOf, monthKey } = require("./memoryStore.cjs");

const SESSION_GAP_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const ITEM_TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Session merge (pure)
// ---------------------------------------------------------------------------

const lower = (xs) => (xs || []).map((x) => String(x).toLowerCase());
const overlap = (a, b) => {
  const B = new Set(lower(b));
  return lower(a).filter((x) => B.has(x)).length;
};

/**
 * Which existing detail memory (if any) this new page belongs to.
 *   revisit: same URL, same content hash, or a near-identical gist (>= 0.95)
 *   session: within 30 minutes of the memory's last visit and on the same
 *            topic (same site + a shared topic or similar gist, or another
 *            site with 2 shared topics or a very similar gist).
 * Search pages only ever join other searches.
 */
function pickMerge(page, gist, vec, candidates, getVec) {
  for (const m of candidates) {
    if ((m.urls || []).some((u) => u.url === page.url)) return { target: m, why: "revisit" };
    if (page.hash && (m.hashes || []).includes(page.hash)) return { target: m, why: "revisit" };
  }
  let best = null;
  for (const m of candidates) {
    if (page.capturedAt - m.last_seen > SESSION_GAP_MS || page.capturedAt < m.first_seen - SESSION_GAP_MS) continue;
    if ((gist.kind === "search") !== (m.kind === "search")) continue;
    const sim = vec ? cosine(vec, getVec(m.id)) : 0;
    if (sim >= 0.95) return { target: m, why: "revisit" };
    const shared = overlap(gist.topics, m.topics);
    const sameSite = (m.domains || []).includes(page.domain);
    const ok = gist.kind === "search" || (sameSite ? shared >= 1 || sim >= 0.75 : shared >= 2 || sim >= 0.82);
    if (ok) {
      const score = sim + shared * 0.1 + (sameSite ? 0.1 : 0);
      if (!best || score > best.score) best = { target: m, why: "session", score };
    }
  }
  return best ? { target: best.target, why: best.why } : null;
}

const sentences = (t) => String(t || "").match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()) ?? (t ? [String(t).trim()] : []);
const unionTop = (a, b, max) => {
  const seen = new Map();
  for (const x of [...(a || []), ...(b || [])]) {
    const k = String(x).toLowerCase();
    seen.set(k, { v: x, n: (seen.get(k)?.n || 0) + 1 });
  }
  return [...seen.values()].sort((x, y) => y.n - x.n).map((x) => x.v).slice(0, max);
};

/** Merge a new page's gist into an existing memory (code, no model). */
function mergeInto(m, page, gist, why) {
  const urls = [...(m.urls || [])];
  if (!urls.some((u) => u.url === page.url)) urls.push({ url: page.url, title: gist.title, at: page.capturedAt });
  const minutes = (m.minutes || 0) + (page.seconds || 0) / 60;
  const base = {
    urls,
    last_seen: Math.max(m.last_seen, page.capturedAt),
    first_seen: Math.min(m.first_seen, page.capturedAt),
    visit_count: (m.visit_count || 1) + 1,
    minutes,
    hashes: [...new Set([...(m.hashes || []), page.hash].filter(Boolean))].slice(-20),
    importance: Math.max(m.importance, gist.importance),
  };
  if (why === "revisit" && urls.length === (m.urls || []).length) {
    // The same page again: newer content wins if it changed, the rest stays.
    return (m.hashes || []).includes(page.hash) ? base : { ...base, gist: gist.gist, key_points: gist.key_points.length ? gist.key_points : m.key_points };
  }
  if (gist.kind === "search" && m.kind === "search") {
    const queries = [...new Set([...(m.meta.queries || [m.meta.query].filter(Boolean)), gist.query].filter(Boolean))].slice(0, 20);
    return { ...base, title: `searched: ${queries.join("; ")}`.slice(0, 200), gist: `Searched the web for ${queries.map((q) => `"${q}"`).join(", ")}.`.slice(0, 900), meta: { ...m.meta, queries, query: queries.join("; ") } };
  }
  const gistSentences = [...new Set([...sentences(m.gist), ...sentences(gist.gist)])].slice(0, 6);
  return {
    ...base,
    title: m.title,
    gist: gistSentences.join(" ").slice(0, 900),
    key_points: unionTop(m.key_points, gist.key_points, 5),
    topics: unionTop(m.topics, gist.topics, 5),
    entities: unionTop(m.entities, gist.entities, 8),
    meta: { ...m.meta, ...(gist.paper && !m.meta.paper ? { paper: gist.paper } : {}) },
  };
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/**
 * deps:
 *   store                        memoryStore
 *   index                        createVectorIndex() (kept in step here)
 *   chat(req) -> string          local model (memoryAnswer.ollamaChat)
 *   embed(texts) -> Float32Array[]  (memoryVectors.ollamaEmbed); throws if missing
 *   isBusy() -> bool             user turn / booking run in progress
 *   now() -> ms
 *   onTiming({ gist_ms, embed_ms, kind })   debug readout only
 * opts: { perMinute = 6, timeoutMs = 30000, maxAttempts = 3 }
 */
function createMemoryWorker(deps, opts = {}) {
  const { store, index } = deps;
  const now = deps.now || (() => Date.now());
  /** Durations for the debug readout: real time, whatever `now` says. */
  const clock = deps.clock || (() => performance.now());
  const perMinute = opts.perMinute ?? 6;
  const timeoutMs = opts.timeoutMs ?? ITEM_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const done = [];
  let running = false;
  let timer = null;
  let embedOk = null; // null unknown, true/false after the last try
  let lastError = null;

  const withTimeout = (p) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs).unref?.())]);

  async function embedOne(text) {
    try {
      const [v] = await withTimeout(deps.embed([text]));
      embedOk = true;
      return v || null;
    } catch {
      embedOk = false;
      return null;
    }
  }

  function saveVector(id, v) {
    if (!v) return;
    store.setVector(id, toBlob(v), EMBED_MODEL, v.length);
    index.set(id, v);
  }

  /** Load every stored vector into the in-memory index (app start). */
  function loadIndex() {
    index.clear();
    for (const r of store.allVectors()) index.set(r.id, fromBlob(r.vec));
  }

  /** One inbox item. Returns what happened (for tests / timings). */
  async function processOne() {
    store.expireInbox();
    store.trimInbox();
    const page = store.inboxNext(maxAttempts);
    if (!page) return { idle: true };
    const s = store.settings();
    if (isExcluded(page.url, s.excluded)) {
      store.removeInbox(page.id);
      return { skipped: "excluded" };
    }
    const cls = classifyPage(page);
    if (cls.action === "skip") {
      store.removeInbox(page.id);
      return { skipped: cls.why };
    }
    const t0 = clock();
    let gist;
    if (cls.action === "search") gist = searchMemory(cls.query);
    else {
      try {
        gist = await withTimeout(gistPage(page, deps.chat));
      } catch {
        gist = null;
      }
      if (!gist) {
        store.inboxFail(page.id);
        lastError = "gist";
        if (page.attempts + 1 < maxAttempts) return { retry: true };
        gist = titleOnlyMemory(page); // out of retries: keep at least the visit
      }
    }
    const gistMs = Math.round(clock() - t0);
    const t1 = clock();
    const vec = await embedOne(embedText(gist));
    const candidates = [...store.seenSince(page.capturedAt - SESSION_GAP_MS), ...[store.findByUrl(page.url), store.findByHash(page.hash)].filter(Boolean)];
    const uniq = [...new Map(candidates.map((m) => [m.id, m])).values()];
    const pick = pickMerge(page, gist, vec, uniq, (id) => index.get(id));
    let id;
    if (pick) {
      id = pick.target.id;
      store.updateMemory(id, mergeInto(pick.target, page, gist, pick.why));
      if (page.manual) store.updateMemory(id, { pinned: true });
      const merged = store.getMemory(id);
      saveVector(id, pick.why === "revisit" && vec ? vec : await embedOne(embedText(merged)));
    } else {
      let thumb = null;
      if (page.manual && page.shot) thumb = page.shot;
      id = store.insertMemory({
        tier: 0,
        kind: gist.kind,
        title: gist.title,
        gist: gist.gist,
        key_points: gist.key_points,
        topics: gist.topics,
        entities: gist.entities,
        importance: gist.importance,
        pinned: page.manual,
        urls: [{ url: page.url, title: gist.title, at: page.capturedAt }],
        domains: [page.domain || domainOf(page.url)],
        first_seen: page.capturedAt,
        last_seen: page.capturedAt,
        minutes: (page.seconds || 0) / 60,
        month: monthKey(page.capturedAt),
        hashes: [page.hash].filter(Boolean),
        meta: { ...(gist.paper ? { paper: gist.paper } : {}), ...(gist.query ? { query: gist.query, queries: [gist.query] } : {}) },
        thumb,
      });
      saveVector(id, vec);
    }
    // The raw text goes as soon as the memory exists (a thumbnail moved over stays).
    store.removeInbox(page.id, { keepThumb: Boolean(page.manual && page.shot && !pick) });
    const embedMs = Math.round(clock() - t1);
    deps.onTiming?.({ gist_ms: gistMs, embed_ms: embedMs, kind: cls.action });
    lastError = null;
    return { id, merged: pick ? pick.why : null };
  }

  /** Memories without vectors (model installed later): up to 16 at a time. */
  async function backfillVectors() {
    const missing = store.missingVectors(EMBED_BATCH);
    if (!missing.length) return 0;
    let vecs;
    try {
      vecs = await withTimeout(deps.embed(missing.map(embedText)));
      embedOk = true;
    } catch {
      embedOk = false;
      return 0;
    }
    missing.forEach((m, i) => saveVector(m.id, vecs[i]));
    return missing.length;
  }

  const recent = () => {
    const t = now();
    while (done.length && t - done[0] > 60000) done.shift();
    return done.length;
  };

  /** One scheduling step: does nothing while busy, off, paused or over the rate. */
  async function tick() {
    if (running) return { busy: "running" };
    const s = store.settings();
    if (!s.enabled) return { off: true };
    if (deps.isBusy && deps.isBusy()) return { busy: "user" };
    if (recent() >= perMinute) return { busy: "rate" };
    running = true;
    try {
      const r = await processOne();
      if (!r.idle) done.push(now());
      else if (embedOk !== false) await backfillVectors();
      return r;
    } finally {
      running = false;
    }
  }

  function start(intervalMs = 4000) {
    if (timer) return;
    timer = setInterval(() => void tick().catch(() => {}), intervalMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, processOne, backfillVectors, loadIndex, start, stop, status: () => ({ embedOk, lastError, running }) };
}

module.exports = { createMemoryWorker, pickMerge, mergeInto, SESSION_GAP_MS, MAX_ATTEMPTS };
