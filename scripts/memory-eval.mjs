// Memory eval: feed the fixture pages (electron/test/fixtures/memory-pages.json)
// through the real pipeline on a fake clock, then report retrieval hit-rate
// for the sample questions before and after monthly compaction, plus entry and
// byte counts. Compare gist / embedding settings with it.
//
//   node scripts/memory-eval.mjs            fake model + fake embeddings (fast, deterministic)
//   node scripts/memory-eval.mjs --real     Ollama on 127.0.0.1: MEMORY_MODEL + EMBED_MODEL
//   node scripts/memory-eval.mjs --real --embed-model=mxbai-embed-large --chat-model=qwen3.5:4b
//
// Everything stays on this machine. Nothing is written outside a temporary
// in-memory database.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, "..", "electron");
const { createPipeline } = require(path.join(root, "test", "memoryHarness.cjs"));
const fakes = require(path.join(root, "test", "memoryFakes.cjs"));
const { ollamaChat, MEMORY_MODEL } = require(path.join(root, "memoryAnswer.cjs"));
const { ollamaEmbed, EMBED_MODEL } = require(path.join(root, "memoryVectors.cjs"));
const { searchMemories } = require(path.join(root, "memorySearch.cjs"));
const { extractKeywords } = require(path.join(root, "memoryQuery.cjs"));

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const real = Boolean(args.real);
const chatModel = args["chat-model"] || MEMORY_MODEL;
const embedModel = args["embed-model"] || EMBED_MODEL;
const fixture = JSON.parse(fs.readFileSync(path.join(root, "test", "fixtures", "memory-pages.json"), "utf8"));

const chat = real ? (req) => ollamaChat(req, { model: chatModel, timeoutMs: 120000 }) : fakes.fakeChat();
const embed = real ? (texts) => ollamaEmbed(texts, { model: embedModel }) : fakes.fakeEmbed;

const p = createPipeline({ chat, embed, start: new Date(2027, 0, 1).getTime() });
const t0 = Date.now();
await p.feed(fixture.pages);
const feedMs = Date.now() - t0;

const topicOf = (m) => fixture.pages.find((x) => m.urls.some((u) => u.url === x.url) || (m.meta.sources || []).some((s) => s.url === x.url) || (m.meta.highlights || []).some((h) => h.url === x.url))?.topic ?? null;

async function evaluate(label) {
  let hit = 0;
  let top3 = 0;
  let negOk = 0;
  let neg = 0;
  const rows = [];
  for (const q of fixture.questions) {
    const kw = extractKeywords(q.q);
    let vec = null;
    try {
      [vec] = await embed([kw.join(" ") || q.q]);
    } catch {
      vec = null;
    }
    const r = searchMemories(p.store, p.index, { keywords: kw, queryVec: vec, now: p.now() });
    const topics = r.hits.map((h) => topicOf(h.memory));
    if (q.topic == null) {
      neg += 1;
      if (!r.hits.length) negOk += 1;
    } else {
      if (topics[0] === q.topic) hit += 1;
      if (topics.slice(0, 3).includes(q.topic)) top3 += 1;
    }
    rows.push(`  ${topics[0] === q.topic || (q.topic == null && !r.hits.length) ? "✓" : "✗"} ${q.q.padEnd(52)} -> ${r.hits.slice(0, 2).map((h) => `${h.memory.title.slice(0, 34)} (${h.score.toFixed(2)})`).join(" | ") || "nothing"}`);
  }
  const pos = fixture.questions.length - neg;
  console.log(`\n${label}: top-1 ${hit}/${pos} (${Math.round((100 * hit) / pos)}%), top-3 ${top3}/${pos}, unrelated -> nothing ${negOk}/${neg}`);
  console.log(rows.join("\n"));
}

const s1 = p.store.stats();
console.log(`Mode: ${real ? `real Ollama (${chatModel}, ${embedModel})` : "fake model"}; ${fixture.pages.length} pages fed in ${feedMs} ms`);
console.log(`After gisting: ${s1.tiers.detail} detail memories, ${s1.bytesByPart.memories + s1.bytesByPart.vectors} B (memories + vectors), raw inbox ${s1.bytesByPart.inbox} B`);
await evaluate("Before compaction (March, Jan + Feb still in detail)");

p.setNow(new Date(2027, 2, 20).getTime());
const before = p.store.memoriesWhere({ tier: 0 }).filter((m) => m.month < "2027-03");
const bytesOf = (rows) => rows.reduce((n, m) => n + m.bytes + (p.index.get(m.id) ? p.index.get(m.id).length * 4 : 0), 0);
const bBefore = bytesOf(before);
const run = await p.compactor.run();
const after = p.store.memoriesWhere({ tier: [1, 2] });
console.log(`\nCompaction: ${before.length} detail entries (${bBefore} B) -> ${after.filter((m) => m.tier === 1).length} digests + ${after.filter((m) => m.tier === 2).length} overviews (${bytesOf(after)} B)`);
for (const r of run.results) console.log(`  ${r.month}: ${r.status}, ${r.entries} entries -> ${r.digests} digests, ${r.bytesBefore} B -> ${r.bytesAfter} B`);
await evaluate("After compaction");
const t = p.timings.filter((x) => x.gist_ms != null);
if (t.length) console.log(`\nTimings: gist avg ${Math.round(t.reduce((n, x) => n + x.gist_ms, 0) / t.length)} ms, embed avg ${Math.round(t.reduce((n, x) => n + x.embed_ms, 0) / t.length)} ms over ${t.length} items`);
