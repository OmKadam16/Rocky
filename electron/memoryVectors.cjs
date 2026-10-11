"use strict";
/**
 * Local embeddings for Memory: Ollama /api/embed on 127.0.0.1 with a small
 * embedding model, vectors stored as Float32 blobs, and a brute-force cosine
 * index held in memory (tens of thousands of rows scan in a few ms).
 *
 * No cloud: the only peer is Ollama on 127.0.0.1.
 */

/** Keep in step with EMBED_MODEL in src/lib/ollama.ts (a test checks). */
const EMBED_MODEL = "nomic-embed-text";
const OLLAMA_EMBED_URL = "http://127.0.0.1:11434/api/embed";
const EMBED_BATCH = 16;

/**
 * texts -> vectors (normalized), in batches of 16. Throws when Ollama or the
 * model isn't there; callers fall back to keyword search.
 */
async function ollamaEmbed(texts, { url = OLLAMA_EMBED_URL, model = EMBED_MODEL, timeoutMs = 30000 } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch, truncate: true }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Ollama embed ${res.status}`);
      const j = await res.json();
      if (!Array.isArray(j.embeddings) || j.embeddings.length !== batch.length) throw new Error("bad embed response");
      for (const e of j.embeddings) out.push(normalize(Float32Array.from(e)));
    } finally {
      clearTimeout(t);
    }
  }
  return out;
}

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / n;
  return out;
}

/** Cosine of two normalized vectors (dot product). Different sizes: 0. */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += a[i] * b[i];
  return d;
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => {
  const buf = Buffer.from(b);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
};

/** In-memory index: id -> vector, kept in step with the store. */
function createVectorIndex() {
  const map = new Map();
  return {
    set: (id, v) => void map.set(Number(id), v),
    delete: (id) => void map.delete(Number(id)),
    get: (id) => map.get(Number(id)) || null,
    clear: () => map.clear(),
    size: () => map.size,
    has: (id) => map.has(Number(id)),
    /** Top k by cosine, optionally only ids passing `filter`. */
    search(q, k = 60, filter = null) {
      const out = [];
      for (const [id, v] of map) {
        if (filter && !filter(id)) continue;
        out.push({ id, score: cosine(q, v) });
      }
      out.sort((a, b) => b.score - a.score);
      return out.slice(0, k);
    },
  };
}

module.exports = { EMBED_MODEL, OLLAMA_EMBED_URL, EMBED_BATCH, ollamaEmbed, normalize, cosine, toBlob, fromBlob, createVectorIndex };
