// Memory (Phase 10): parser, store, ingest server, answers, privacy.
// Real SQLite (:memory:) and real HTTP on 127.0.0.1; fake Ollama.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import queryMod from "./memoryQuery.cjs";
import storeMod from "./memoryStore.cjs";
import serverMod from "./memoryServer.cjs";
import answerMod from "./memoryAnswer.cjs";

const { parseTimeRange, extractKeywords, parseMemoryQuery, searchTermsOf } = queryMod;
const { createMemoryStore, isExcluded } = storeMod;
const { createMemoryServer, EXTENSION_ID } = serverMod;
const { answerQuestion, MEMORY_MODEL, MSG } = answerMod;

// Saturday 2026-10-10, 15:00 local.
const NOW = new Date(2026, 9, 10, 15, 0, 0);
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const label = (r) => r && r.label;

describe("time ranges, parsed in code", () => {
  const span = (text) => {
    const r = parseTimeRange(text, NOW);
    return r && [new Date(r.from).toDateString(), new Date(r.to).toDateString(), r.label];
  };
  it("today / yesterday / this morning / last night", () => {
    expect(span("what did I read today")).toEqual(["Sat Oct 10 2026", "Sat Oct 10 2026", "today"]);
    expect(span("the recipe I looked at yesterday")).toEqual(["Fri Oct 09 2026", "Fri Oct 09 2026", "yesterday"]);
    const morning = parseTimeRange("this morning", NOW);
    expect(new Date(morning.to).getHours()).toBe(11);
    expect(label(parseTimeRange("last night", NOW))).toBe("last night");
  });
  it("weekdays mean the most recent one; 'last' skips today", () => {
    expect(span("what did I search for on Tuesday?")).toEqual(["Tue Oct 06 2026", "Tue Oct 06 2026", "Tuesday"]);
    expect(span("on Saturday")).toEqual(["Sat Oct 10 2026", "Sat Oct 10 2026", "Saturday"]);
    expect(span("last Saturday")).toEqual(["Sat Oct 03 2026", "Sat Oct 03 2026", "Saturday"]);
  });
  it("weeks, months, specific dates", () => {
    expect(span("that article about CRISPR I read last week")).toEqual(["Mon Sep 28 2026", "Sun Oct 04 2026", "last week"]);
    expect(span("in September")).toEqual(["Tue Sep 01 2026", "Wed Sep 30 2026", "September"]);
    expect(span("in December")[0]).toBe("Mon Dec 01 2025"); // most recent past December
    expect(span("on Sept 3rd")).toEqual(["Thu Sep 03 2026", "Thu Sep 03 2026", "September 3"]);
    expect(span("last 3 days")[0]).toBe("Wed Oct 07 2026");
  });
  it("no time words: any time", () => {
    expect(parseTimeRange("what did I read about Qwen?", NOW)).toBe(null);
  });
});

describe("keywords, site and search intent", () => {
  it("keeps the topic, drops the question words", () => {
    expect(extractKeywords("what did I read about Qwen?")).toEqual(["qwen"]);
    expect(extractKeywords("find that article about CRISPR I read last week")).toEqual(["crispr"]);
    expect(extractKeywords("what was the recipe I looked at yesterday?")).toEqual(["recipe"]);
  });
  it("site filters and searches", () => {
    const q = parseMemoryQuery("that video on youtube about sourdough", NOW);
    expect(q.domain).toBe("youtube.com");
    expect(q.keywords).toEqual(["sourdough"]);
    expect(parseMemoryQuery("what did I search for on Tuesday?", NOW).searches).toBe(true);
    expect(searchTermsOf("https://www.google.com/search?q=qwen+3.5+benchmarks&hl=en")).toBe("qwen 3.5 benchmarks");
    expect(searchTermsOf("https://example.com/?q=x")).toBe(null);
  });
});

function store(now = NOW.getTime()) {
  let t = now;
  const s = createMemoryStore({ now: () => t });
  s.setSettings({ enabled: true });
  return { s, setNow: (v) => (t = v) };
}

describe("memory store (SQLite FTS5)", () => {
  it("BM25 search with date and domain filters and recency", () => {
    const { s, setNow } = store();
    setNow(at(2026, 10, 1));
    s.ingest({ url: "https://news.example/crispr-old", title: "CRISPR basics", text: "An older piece on CRISPR gene editing." });
    setNow(at(2026, 10, 9));
    s.ingest({ url: "https://www.broad.example/base-editing", title: "Base editing beyond CRISPR", text: "CRISPR base editors fix single letters of DNA." });
    s.ingest({ url: "https://cooking.example/sourdough", title: "Sourdough recipe", text: "Flour, water, salt, starter." });
    setNow(NOW.getTime());
    const hits = s.search({ keywords: ["crispr"] });
    expect(hits.map((h) => h.title)).toEqual(["Base editing beyond CRISPR", "CRISPR basics"]);
    expect(hits[0].domain).toBe("broad.example");
    expect(hits[0].snippet).toMatch(/CRISPR/);
    const yesterday = parseTimeRange("yesterday", NOW);
    expect(s.search({ keywords: ["recipe"], from: yesterday.from, to: yesterday.to }).map((h) => h.title)).toEqual(["Sourdough recipe"]);
    expect(s.search({ keywords: ["crispr"], domain: "news.example" }).map((h) => h.title)).toEqual(["CRISPR basics"]);
    expect(s.search({ keywords: ["qwen"] })).toEqual([]);
  });

  it("dedupes the same URL + content within the window", () => {
    const { s } = store();
    const a = s.ingest({ url: "https://a.example/x", title: "X", text: "same" });
    const b = s.ingest({ url: "https://a.example/x", title: "X", text: "same" });
    expect(b).toMatchObject({ ok: true, deduped: true, id: a.id });
    expect(s.stats().count).toBe(1);
    s.ingest({ url: "https://a.example/x", title: "X", text: "changed" });
    expect(s.stats().count).toBe(2);
  });

  it("never stores banking, email, health, password-manager or excluded sites", () => {
    const { s } = store();
    for (const url of ["https://mail.google.com/mail/u/0", "https://www.chase.com/acct", "https://netbanking.hdfcbank.com", "https://mychart.example.org", "https://1password.com/vault", "https://login.example.com"]) {
      expect(s.ingest({ url, title: "t", text: "secret" })).toMatchObject({ ok: false, reason: "excluded" });
    }
    s.setSettings({ excluded: ["https://www.reddit.com/r/x", "news.example"] });
    expect(isExcluded("https://old.reddit.com/r/y", s.settings().excluded)).toBe(true);
    expect(s.ingest({ url: "https://sub.news.example/a", title: "t", text: "x" }).reason).toBe("excluded");
    expect(s.stats().count).toBe(0);
  });

  it("retention and the size cap evict oldest first", () => {
    const { s, setNow } = store();
    setNow(at(2026, 6, 1));
    s.ingest({ url: "https://a.example/old", title: "Old", text: "old" });
    setNow(NOW.getTime());
    s.ingest({ url: "https://a.example/new", title: "New", text: "new" });
    s.setSettings({ retentionDays: 90 });
    expect(s.list().map((p) => p.title)).toEqual(["New"]);
    s.setSettings({ sizeCapMB: 10 });
    expect(s.settings().sizeCapMB).toBe(10);
  });

  it("delete one, delete everything, rotate token", () => {
    const { s } = store();
    const a = s.ingest({ url: "https://a.example/1", title: "One", text: "1" });
    s.ingest({ url: "https://a.example/2", title: "Two", text: "2" });
    expect(s.remove(a.id)).toBe(true);
    expect(s.search({ keywords: ["one"] })).toEqual([]);
    s.clear();
    expect(s.stats().count).toBe(0);
    const t1 = s.settings().token;
    expect(t1.length).toBeGreaterThan(20);
    expect(s.setSettings({ rotateToken: true }).token).not.toBe(t1);
  });
});

describe("ingest server: token + origin + host + size", () => {
  let srv;
  afterEach(async () => {
    await srv?.stop();
  });
  const ORIGIN = `chrome-extension://${EXTENSION_ID}`;
  async function up(maxBody) {
    const { s } = store();
    srv = createMemoryServer({ store: s, port: 0, maxBody });
    const port = await srv.start();
    const call = (p, { method = "POST", origin = ORIGIN, token = s.settings().token, body, host, headers = {} } = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        method,
        headers: {
          ...(origin ? { Origin: origin } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(host ? { Host: host } : {}),
          ...headers,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    return { s, call, port };
  }
  const page = { url: "https://docs.example/qwen", title: "Qwen 3.5 notes", text: "Qwen 3.5 is a small model." };

  it("ingest requires the pairing token", async () => {
    const { s, call } = await up();
    expect((await call("/ingest", { token: null, body: page })).status).toBe(401);
    expect((await call("/ingest", { token: "wrong-token-wrong-token-xx", body: page })).status).toBe(401);
    const ok = await call("/ingest", { body: page });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(s.stats().count).toBe(1);
  });

  it("rejects other origins (and never sends a CORS wildcard)", async () => {
    const { s, call } = await up();
    for (const origin of [null, "https://evil.example", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
      const r = await call("/ingest", { origin, body: page });
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBe(null);
    }
    expect(s.stats().count).toBe(0);
  });

  it("refuses oversized bodies, Memory off, and paused", async () => {
    const { s, call } = await up(1000);
    expect((await call("/ingest", { body: { ...page, text: "x".repeat(5000) } })).status).toBe(413);
    s.setSettings({ paused: true });
    expect((await call("/ingest", { body: page })).status).toBe(409);
    s.setSettings({ paused: false, enabled: false });
    expect((await call("/ingest", { body: page })).status).toBe(409);
    expect(s.stats().count).toBe(0);
  });

  it("no Origin (Chrome omits it on some extension GETs): allowed only with our X-Rocky-Extension id", async () => {
    const { call } = await up();
    const ok = await call("/status", { method: "GET", origin: null, headers: { "X-Rocky-Extension": EXTENSION_ID } });
    expect(ok.status).toBe(200);
    expect((await call("/status", { method: "GET", origin: null })).status).toBe(403);
    expect((await call("/status", { method: "GET", origin: null, headers: { "X-Rocky-Extension": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } })).status).toBe(403);
    // A web page sending the header still has an Origin: refused.
    expect((await call("/status", { method: "GET", origin: "https://evil.example", headers: { "X-Rocky-Extension": EXTENSION_ID } })).status).toBe(403);
    expect((await call("/status", { method: "GET", origin: null, token: null, headers: { "X-Rocky-Extension": EXTENSION_ID } })).status).toBe(401);
  });

  it("status needs the token too; preflight answers only our origin", async () => {
    const { call } = await up();
    expect((await call("/status", { method: "GET", token: null })).status).toBe(401);
    const st = await call("/status", { method: "GET" });
    expect(await st.json()).toMatchObject({ ok: true, enabled: true, count: 0 });
    const pre = await call("/ingest", { method: "OPTIONS", token: null });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});

describe("ingest -> search -> answer (fake extension POSTs, fake Ollama)", () => {
  it("answers from the retrieved snippets only and lists the sources", async () => {
    const { s } = store();
    const srv = createMemoryServer({ store: s, port: 0 });
    const port = await srv.start();
    const post = (body) =>
      fetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { Origin: `chrome-extension://${EXTENSION_ID}`, Authorization: `Bearer ${s.settings().token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await post({ url: "https://qwen.example/blog", title: "Qwen 3.5 release", text: "Qwen 3.5 2B runs on a laptop and supports tool calls." });
    await post({ url: "https://cooking.example/pasta", title: "Pasta", text: "Boil water." });
    await srv.stop();
    const seen = [];
    const chat = async (req) => {
      seen.push(req);
      return "Qwen 3.5 2B runs on a laptop, from the Qwen 3.5 release post.";
    };
    const r = await answerQuestion("what did I read about Qwen?", { store: s, chat, now: () => NOW });
    expect(r.status).toBe("answered");
    expect(r.answer).toMatch(/Qwen 3.5 2B/);
    expect(r.sources.map((x) => x.domain)).toEqual(["qwen.example"]);
    expect(seen[0].messages[1].content).toMatch(/Qwen 3.5 release/);
    expect(seen[0].messages[1].content).not.toMatch(/Pasta/);
  });

  it("plain one-line messages: off, nothing found, Ollama down, model unsure", async () => {
    const { s } = store();
    s.ingest({ url: "https://qwen.example/blog", title: "Qwen", text: "Qwen notes" });
    expect((await answerQuestion("what did I read about qwen", { store: s, chat: async () => "x", now: () => NOW })).status).toBe("answered");
    expect(await answerQuestion("what did I read about rust", { store: s, chat: async () => "x", now: () => NOW })).toMatchObject({ status: "none", sources: [] });
    const down = await answerQuestion("what did I read about qwen", { store: s, chat: async () => { throw new Error("ECONNREFUSED"); }, now: () => NOW });
    expect(down).toMatchObject({ status: "unavailable", answer: MSG.ollama });
    expect(down.sources).toHaveLength(1);
    expect((await answerQuestion("what did I read about qwen", { store: s, chat: async () => "I couldn't find that.", now: () => NOW })).status).toBe("none");
    s.setSettings({ enabled: false });
    expect(await answerQuestion("what did I read about qwen", { store: s, now: () => NOW })).toMatchObject({ status: "off", answer: "Memory is off. Turn it on in the Memory page." });
  });

  it("'what did I search for on Tuesday' is answered in code, no model", async () => {
    let t = at(2026, 10, 6, 9);
    const s = createMemoryStore({ now: () => t });
    s.setSettings({ enabled: true });
    s.ingest({ url: "https://www.google.com/search?q=cheap+flights+to+goa", title: "cheap flights to goa - Google Search", text: "results" });
    t = at(2026, 10, 7, 9);
    s.ingest({ url: "https://www.google.com/search?q=wednesday+thing", title: "wednesday thing - Google Search", text: "results" });
    t = NOW.getTime();
    const r = await answerQuestion("what did I search for on Tuesday?", { store: s, chat: async () => { throw new Error("must not be called"); }, now: () => NOW });
    expect(r).toMatchObject({ status: "answered", answer: 'Tuesday you searched for "cheap flights to goa".' });
  });
});

describe("privacy: Memory never touches the cloud", () => {
  const files = ["memoryStore.cjs", "memoryServer.cjs", "memoryQuery.cjs", "memoryAnswer.cjs"];
  const src = (f) => fs.readFileSync(path.join(import.meta.dirname, f), "utf8");

  it("imports nothing but node built-ins and each other", () => {
    for (const f of files) {
      const reqs = [...src(f).matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
      for (const r of reqs) expect(r, `${f} requires ${r}`).toMatch(/^(node:[a-z:]+|\.\/memory[A-Za-z]+\.cjs)$/);
      expect(src(f)).not.toMatch(/openai|supabase|elevenlabs|anthropic|agentCore|agentRelay/i);
    }
  });

  it("the only network peers are 127.0.0.1 (Ollama, our own server)", () => {
    for (const f of files) {
      for (const u of src(f).match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        expect(u, `${f}: ${u}`).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)([:/]|$)|^https?:\/\/[a-z.]*example\b/);
      }
    }
  });

  it("never logs page content", () => {
    for (const f of files) expect(src(f)).not.toMatch(/console\.(log|info|debug|warn|error)/);
  });

  it("uses the same local model as the app", () => {
    const ts = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "lib", "ollama.ts"), "utf8");
    expect(ts).toContain(`export const MEMORY_MODEL = "${MEMORY_MODEL}"`);
  });
});
