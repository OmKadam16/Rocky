"use strict";
/**
 * A full Memory pipeline on a fake clock, for tests and the eval script:
 * store (SQLite :memory:) + vector index + worker + compactor. Pages are
 * ingested at their own times and gisted right away (as the idle worker would).
 */
const { createMemoryStore } = require("../memoryStore.cjs");
const { createVectorIndex } = require("../memoryVectors.cjs");
const { createMemoryWorker } = require("../memoryWorker.cjs");
const { createCompactor } = require("../memoryCompact.cjs");

function createPipeline({ chat, embed, start = Date.now(), file = ":memory:", busy = () => false, perMinute = 1000 } = {}) {
  let t = start;
  const now = () => t;
  const store = createMemoryStore({ file, now });
  store.setSettings({ enabled: true });
  const index = createVectorIndex();
  const timings = [];
  const worker = createMemoryWorker({ store, index, chat, embed, now, isBusy: busy, onTiming: (x) => timings.push(x) }, { perMinute, timeoutMs: 5000 });
  const compactor = createCompactor({ store, index, chat, embed, now, isBusy: busy, onTiming: (x) => timings.push(x) });

  /** Drain the inbox (each tick handles one item). */
  async function drain(max = 1000) {
    for (let i = 0; i < max; i += 1) {
      const r = await worker.processOne();
      if (r.idle) return;
    }
  }

  /** Ingest fixture pages at their own times, gisting each as it lands. */
  async function feed(pages) {
    for (const p of [...pages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      t = Date.parse(p.at);
      const r = store.ingest({ url: p.url, title: p.title, text: p.text, manual: p.manual === true });
      if (r.ok && p.seconds) store.addVisitTime(p.url, p.seconds);
      await drain();
    }
  }

  return { store, index, worker, compactor, timings, drain, feed, now, setNow: (ms) => (t = ms) };
}

module.exports = { createPipeline };
