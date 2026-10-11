"use strict";
/**
 * Answer a Memory question: code searches, the LOCAL model (Ollama) only
 * phrases a short answer from the retrieved snippets. Nothing here talks to
 * any cloud service; the only network peer is Ollama on 127.0.0.1.
 */
const { parseMemoryQuery } = require("./memoryQuery.cjs");

/** Keep in step with MEMORY_MODEL in src/lib/ollama.ts (a test checks). */
const MEMORY_MODEL = "qwen3.5:2b";
const OLLAMA_URL = "http://127.0.0.1:11434/api/chat";

const MSG = {
  off: "Memory is off. Turn it on in the Memory page.",
  none: "I couldn't find that in your Memory.",
  noTopic: "I couldn't find that. Tell me the topic or the site, and roughly when.",
  ollama: "Ollama isn't running, so I can't write an answer. Start Ollama, then ask again. The closest pages are below.",
};

/** The real local model call. think:false, temperature 0.1. */
async function ollamaChat({ messages, format }, { url = OLLAMA_URL, model = MEMORY_MODEL, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: false, think: false, options: { temperature: 0.1 }, ...(format ? { format } : {}) }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const j = await res.json();
    return String((j && j.message && j.message.content) || "");
  } finally {
    clearTimeout(t);
  }
}

const KEYWORDS_SCHEMA = {
  type: "object",
  properties: { keywords: { type: "array", items: { type: "string" } }, domain: { type: "string" } },
  required: ["keywords"],
};

const day = (ms) => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

const toSources = (hits) => hits.map((h) => ({ title: h.title || h.url, url: h.url, domain: h.domain, capturedAt: new Date(h.capturedAt).toISOString() }));

/**
 * deps: { store, chat?: (req) => Promise<string>, now?: () => Date }
 * Returns { status: answered | none | off | unavailable, answer, sources }.
 */
async function answerQuestion(question, deps) {
  const { store } = deps;
  const chat = deps.chat || ollamaChat;
  const now = deps.now ? deps.now() : new Date();
  if (!store.settings().enabled) return { status: "off", answer: MSG.off, sources: [] };

  const q = parseMemoryQuery(question, now);
  let keywords = q.keywords;
  let domain = q.domain;
  // Nothing to search on: let the local model pull out a topic (JSON schema).
  if (!keywords.length && !q.time && !q.searches) {
    try {
      const raw = await chat({
        messages: [
          { role: "system", content: "Extract search keywords from the user's question about pages they visited. Return JSON only." },
          { role: "user", content: question },
        ],
        format: KEYWORDS_SCHEMA,
      });
      const j = JSON.parse(raw);
      keywords = Array.isArray(j.keywords) ? j.keywords.map(String).filter(Boolean).slice(0, 8) : [];
      if (!domain && typeof j.domain === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(j.domain)) domain = j.domain.toLowerCase();
    } catch {
      /* no local model: fall through to the plain "couldn't find" */
    }
    if (!keywords.length) return { status: "none", answer: MSG.noTopic, sources: [] };
  }

  const range = q.time ? { from: q.time.from, to: q.time.to } : {};
  const hits = store.search({ keywords, domain, searches: q.searches, limit: q.searches ? 12 : 5, ...range });
  if (!hits.length) {
    const when = q.time ? ` from ${q.time.label}` : "";
    return { status: "none", answer: `I couldn't find that in your Memory${when}.`, sources: [] };
  }

  // Searches are answered in code, straight from the search URLs: nothing to make up.
  if (q.searches) {
    const terms = [...new Set(hits.map((h) => h.searchTerms).filter(Boolean))].slice(0, 6);
    const when = q.time ? `${q.time.label.charAt(0).toUpperCase()}${q.time.label.slice(1)} you` : "You";
    return { status: "answered", answer: `${when} searched for ${terms.map((t) => `"${t}"`).join(", ")}.`, sources: toSources(hits.slice(0, 6)) };
  }

  const top = hits.slice(0, 4);
  const snippets = top.map((h, i) => `[${i + 1}] ${h.title} (${h.domain}, ${day(h.capturedAt)}): ${h.snippet.slice(0, 600)}`).join("\n");
  let answer;
  try {
    answer = (
      await chat({
        messages: [
          {
            role: "system",
            content:
              "You answer questions about web pages the user visited, using ONLY the numbered snippets. One or two short sentences, plain text, no lists. " +
              "Name the page it came from. If the snippets don't answer the question, reply exactly: I couldn't find that.",
          },
          { role: "user", content: `Snippets:\n${snippets}\n\nQuestion: ${question}` },
        ],
      })
    )
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .trim()
      .slice(0, 500);
  } catch {
    return { status: "unavailable", answer: MSG.ollama, sources: toSources(top) };
  }
  if (!answer || /couldn'?t find that/i.test(answer)) return { status: "none", answer: MSG.none, sources: [] };
  return { status: "answered", answer, sources: toSources(top) };
}

module.exports = { answerQuestion, ollamaChat, MEMORY_MODEL, MSG };
