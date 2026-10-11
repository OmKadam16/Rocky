"use strict";
/**
 * Fake Ollama for Memory tests and the --fake eval: deterministic gists,
 * digests, overviews and bag-of-words embeddings. No network.
 */
const { normalize } = require("../memoryVectors.cjs");

const STOP = new Set(
  "the a an and or of to in on for with is are was were be by this that it its as at from about how what which who you your we our they their them i me my not no but if than then so can will just into more most some any all also have has had do does did one two new use using".split(" "),
);
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "");
const words = (t) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map(stem);

/** Bag of words hashed into 256 dims. Same topic -> high cosine. */
function fakeEmbedOne(text) {
  const v = new Float32Array(256);
  for (const w of words(text)) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i += 1) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % 256] += 1;
  }
  return normalize(v);
}
const fakeEmbed = async (texts) => texts.map(fakeEmbedOne);
const brokenEmbed = async () => {
  throw new Error("model not found");
};

const top = (list, n) => {
  const c = new Map();
  for (const w of list) c.set(w, (c.get(w) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map((x) => x[0]);
};

/**
 * One fake model for every Memory prompt, chosen by the system prompt.
 * opts.fail(kind, req) -> true makes that call throw; opts.junk -> returns junk.
 */
function fakeChat(opts = {}) {
  const calls = [];
  const chat = async (req) => {
    const sys = req.messages[0].content;
    const user = req.messages[1].content;
    const kind = /private memory of a web page/.test(sys) ? "gist" : /month overview|year overview/.test(sys) ? "overview" : /compress a user's private reading/.test(sys) ? "digest" : /Extract search keywords/.test(sys) ? "keywords" : "answer";
    calls.push({ kind, req });
    if (opts.fail && opts.fail(kind, req)) throw new Error("model failed");
    if (opts.junk && opts.junk(kind, req)) return "sorry, I can't do JSON today";
    if (kind === "gist") {
      const title = (/Title: (.*)/.exec(user) || [])[1] || "Untitled";
      const body = (/<page>\n([\s\S]*)\n<\/page>/.exec(user) || [])[1] || "";
      const sentences = body.match(/[^.!?]+[.!?]+/g) || [body];
      const gist = sentences.slice(0, 2).join(" ").replace(/\s+/g, " ").trim();
      const tw = words(title);
      const topics = top([...tw, ...tw, ...words(body)], 3);
      const isPaper = /abstract|doi|arxiv/i.test(body);
      return JSON.stringify({
        title,
        gist: gist.split(/\s+/).length >= 5 ? gist : `${title} is a page about ${topics.join(" and ")}.`,
        key_points: sentences.slice(2, 4).map((s) => s.trim()),
        topics,
        entities: [],
        kind: isPaper ? "paper" : "article",
        importance: /important/i.test(body) ? 3 : 1,
        ...(isPaper ? { paper: { authors: ["A. Author"], venue: "Nature", year: "2027" } } : {}),
      });
    }
    if (kind === "digest") {
      const lines = user.split("\n").filter((l) => l.startsWith("- "));
      const tw = top(lines.flatMap((l) => words(l.split("(")[0])), 3);
      return JSON.stringify({ title: tw.join(", ") || "reading", summary: `They read ${lines.length} pages about ${tw.join(", ")}. Main points were noted.`, topics: tw });
    }
    if (kind === "overview") {
      const lines = user.split("\n").filter((l) => l.startsWith("- "));
      return JSON.stringify({ overview: lines.map((l) => l.slice(2, 60)).join("\n"), top_topics: top(lines.flatMap((l) => words(l)), 4) });
    }
    if (kind === "keywords") return JSON.stringify({ keywords: words(user).slice(0, 3) });
    // answer: echo the first memory title so tests can see what was used.
    const first = (/\[1\] ([^(]+)\(/.exec(user) || [])[1];
    return first ? `You read ${first.trim()}.` : "I couldn't find that.";
  };
  chat.calls = calls;
  return chat;
}

module.exports = { fakeChat, fakeEmbed, fakeEmbedOne, brokenEmbed, words };
