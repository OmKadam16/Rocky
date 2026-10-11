"use strict";
/**
 * Hybrid Memory search: vector similarity (local embeddings) + BM25 over the
 * gists, a recency boost, date / site / kind filters, and tier awareness.
 * Without an embedding model it is BM25 only (and says so via `mode`).
 *
 * A relevance threshold keeps unrelated questions from returning garbage:
 * with vectors, the best match must clear MIN_COSINE (or have a keyword hit
 * and a reasonable cosine); without, a keyword hit is required.
 *
 * Pure (no Electron, no network): the query vector is passed in.
 */
const { cosine } = require("./memoryVectors.cjs");
const { DAY } = require("./memoryQuery.cjs");

const MIN_COSINE = 0.5;
const MIN_COSINE_WITH_KEYWORD = 0.3;

/**
 * opts: {
 *   keywords: string[], queryVec: Float32Array|null,
 *   from, to (ms, optional), domain, kind, limit (5-8), now
 * }
 * Returns { mode: "hybrid" | "keyword" | "time", hits: [{ memory, score, cos, bm25, resolution }] }
 * resolution: "day" for detail memories, "month" for digests, "year" for yearly.
 */
function searchMemories(store, index, opts) {
  const { keywords = [], queryVec = null, from = null, to = null, domain = null, kind = null } = opts;
  const limit = Math.max(1, Math.min(8, opts.limit || 6));
  const now = opts.now ?? store.now();
  const hasRange = from != null || to != null;

  const inRange = (m) => (from == null || m.last_seen >= from) && (to == null || m.first_seen <= to);
  const passes = (m) => m && inRange(m) && (!domain || m.domains.some((d) => d === domain || d.endsWith(`.${domain}`))) && (!kind || m.kind === kind);
  const resolutionOf = (m) => (m.tier === 0 ? "day" : m.tier === 3 ? "year" : "month");

  // A time question with nothing to match on ("what did I read Tuesday"):
  // the memories in that range, detail first, newest first.
  if (!keywords.length && !queryVec) {
    if (!hasRange) return { mode: "time", hits: [] };
    const rows = store.memoriesWhere({ from, to, domain, kind, limit: 50 }).filter(passes);
    rows.sort((a, b) => a.tier - b.tier || b.last_seen - a.last_seen);
    return { mode: "time", hits: rows.slice(0, limit).map((m) => ({ memory: m, score: 1, cos: 0, bm25: 0, resolution: resolutionOf(m) })) };
  }

  const kw = new Map(store.keywordSearch(keywords, 80).map((r) => [r.id, r.bm25]));
  const vec = new Map();
  const useVec = Boolean(queryVec && index.size());
  if (useVec) for (const r of index.search(queryVec, 80)) vec.set(r.id, r.score);

  const ids = new Set([...kw.keys(), ...vec.keys()]);
  const maxBm = Math.max(1e-9, ...kw.values());
  const out = [];
  for (const id of ids) {
    const m = store.getMemory(id);
    if (!passes(m)) continue;
    const cos = useVec ? (vec.has(id) ? vec.get(id) : cosine(queryVec, index.get(id))) : 0;
    const bm = kw.get(id) || 0;
    // Relevance gate.
    if (useVec ? !(cos >= MIN_COSINE || (bm > 0 && cos >= MIN_COSINE_WITH_KEYWORD)) : bm <= 0) continue;
    const ageDays = Math.max(0, (now - m.last_seen) / DAY);
    const recency = 1 / (1 + ageDays / 30);
    // Month / year overviews are broad: they only win when nothing more specific matches.
    const broad = m.tier === 2 || m.tier === 3 ? 0.8 : 1;
    const rel = (useVec ? 0.7 * cos + 0.3 * (bm / maxBm) : bm / maxBm) * broad;
    const boost = 0.08 * recency + (m.pinned ? 0.04 : 0) + 0.01 * m.importance;
    // A date-specific question prefers the detail entries for that range.
    const tierFit = hasRange && m.tier === 0 ? 0.05 : 0;
    out.push({ memory: m, score: rel + boost + tierFit, cos, bm25: bm, resolution: resolutionOf(m) });
  }
  out.sort((a, b) => b.score - a.score);
  return { mode: useVec ? "hybrid" : "keyword", hits: out.slice(0, limit) };
}

module.exports = { searchMemories, MIN_COSINE, MIN_COSINE_WITH_KEYWORD };
