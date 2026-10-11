import { describe, expect, it } from "vitest";
import {
  askMemoryOnLaptop,
  handleMemoryRequest,
  MEMORY_REQUEST_MARK,
  MEMORY_ROW_TTL_MS,
  MESSAGES,
  parseCard,
  purgeMemoryRows,
  type MemoryCard,
  type RelayRow,
  type RelayStore,
} from "./memoryRelay";
import { plannerHistory } from "./plannerLocal";

/** A fake `commands` table, with a fake clock shared by phone and laptop. */
function fakeSupabase(startMs = 1_000_000) {
  let t = startMs;
  let n = 0;
  const rows = new Map<string, RelayRow & { text: string }>();
  const deleted: string[] = [];
  const store: RelayStore = {
    async insertRequest(question) {
      const id = `r${++n}`;
      rows.set(id, { id, text: MEMORY_REQUEST_MARK, status: "queued", reply_text: null, error: null, created_at: new Date(t).toISOString(), diff: { question } });
      return id;
    },
    async readRow(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async answer(id, patch) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, ...patch, reply_text: patch.reply_text ?? r.reply_text, error: patch.error ?? r.error });
    },
    async deleteRow(id) {
      if (rows.delete(id)) deleted.push(id);
    },
    async purgeBefore(iso) {
      for (const [id, r] of rows) if (r.text === MEMORY_REQUEST_MARK && r.created_at < iso) store.deleteRow(id);
    },
    async queued() {
      return [...rows.values()].filter((r) => r.status === "queued");
    },
  };
  return {
    store,
    rows,
    deleted,
    now: () => t,
    advance: (ms: number) => (t += ms),
  };
}

const ANSWER: MemoryCard = {
  kind: "memory",
  status: "answered",
  answer: "You read about base editing in the Broad Institute piece.",
  sources: [{ title: "Base editing", url: "https://broad.example/x", domain: "broad.example", capturedAt: "2026-10-09T12:00:00.000Z" }],
};

/** A laptop that answers whatever is queued on every phone poll. */
function withLaptop(fake: ReturnType<typeof fakeSupabase>, opts: { allowed?: boolean; ask?: (q: string) => Promise<MemoryCard> } = {}) {
  const asked: string[] = [];
  const sleep = async (ms: number) => {
    fake.advance(ms);
    for (const r of await fake.store.queued()) {
      await handleMemoryRequest(r, {
        store: fake.store,
        allowed: () => opts.allowed ?? true,
        ask: opts.ask ?? (async (q) => (asked.push(q), ANSWER)),
        now: fake.now,
      });
    }
  };
  return { sleep, asked };
}

const online = (fake: ReturnType<typeof fakeSupabase>) => async () => fake.now() - 5_000;

describe("Memory questions from the phone, answered on the laptop", () => {
  it("round trip: the laptop answers locally and the phone gets the card", async () => {
    const fake = fakeSupabase();
    const laptop = withLaptop(fake);
    const card = await askMemoryOnLaptop("what did I read today about CRISPR?", { store: fake.store, laptopLastSeen: online(fake), now: fake.now, sleep: laptop.sleep });
    expect(laptop.asked).toEqual(["what did I read today about CRISPR?"]);
    expect(card.status).toBe("answered");
    expect(card.answer).toBe(ANSWER.answer);
    expect(card.sources[0].url).toBe("https://broad.example/x");
  });

  it("the phone deletes the row right after reading it: nothing stays in the cloud", async () => {
    const fake = fakeSupabase();
    const laptop = withLaptop(fake);
    await askMemoryOnLaptop("what did I read about Qwen?", { store: fake.store, laptopLastSeen: online(fake), now: fake.now, sleep: laptop.sleep });
    expect(fake.rows.size).toBe(0);
    expect(fake.deleted).toEqual(["r1"]);
  });

  it("toggle off: the laptop refuses and the phone says so in one sentence", async () => {
    const fake = fakeSupabase();
    const laptop = withLaptop(fake, { allowed: false });
    const card = await askMemoryOnLaptop("what did I read about Qwen?", { store: fake.store, laptopLastSeen: online(fake), now: fake.now, sleep: laptop.sleep });
    expect(card.answer).toBe(MESSAGES.phoneOff);
    expect(laptop.asked).toEqual([]);
    expect(fake.rows.size).toBe(0);
  });

  it("laptop asleep: nothing is sent at all", async () => {
    const fake = fakeSupabase();
    const card = await askMemoryOnLaptop("what did I read?", { store: fake.store, laptopLastSeen: async () => fake.now() - 10 * 60_000, now: fake.now, sleep: async () => {} });
    expect(card.answer).toBe(MESSAGES.asleep);
    expect(fake.deleted).toEqual([]);
    expect(fake.rows.size).toBe(0);
    const none = await askMemoryOnLaptop("what did I read?", { store: fake.store, laptopLastSeen: async () => null, now: fake.now, sleep: async () => {} });
    expect(none.answer).toBe(MESSAGES.asleep);
  });

  it("timeout after 30 s: a plain sentence, and the row is deleted", async () => {
    const fake = fakeSupabase();
    const card = await askMemoryOnLaptop("what did I read?", { store: fake.store, laptopLastSeen: online(fake), now: fake.now, sleep: async (ms) => void fake.advance(ms) });
    expect(card.answer).toBe(MESSAGES.timeout);
    expect(fake.rows.size).toBe(0);
  });

  it("Memory off / Ollama down / nothing found pass through as the laptop's own sentence", async () => {
    for (const reply of [
      { kind: "memory", status: "off", answer: "Memory is off. Turn it on in the Memory page.", sources: [] },
      { kind: "memory", status: "unavailable", answer: "The local model isn't running. Start Ollama and try again.", sources: [] },
      { kind: "memory", status: "none", answer: "I couldn't find anything about that in Memory.", sources: [] },
    ] as MemoryCard[]) {
      const fake = fakeSupabase();
      const laptop = withLaptop(fake, { ask: async () => reply });
      const card = await askMemoryOnLaptop("what did I read?", { store: fake.store, laptopLastSeen: online(fake), now: fake.now, sleep: laptop.sleep });
      expect(card).toMatchObject({ status: reply.status, answer: reply.answer, sources: [] });
    }
  });

  it("expiry: the laptop drops a request older than a minute instead of answering it", async () => {
    const fake = fakeSupabase();
    const id = (await fake.store.insertRequest("what did I read?"))!;
    fake.advance(61_000);
    const asked: string[] = [];
    const r = await handleMemoryRequest((await fake.store.readRow(id))!, { store: fake.store, allowed: () => true, ask: async (q) => (asked.push(q), ANSWER), now: fake.now });
    expect(r).toBe("stale");
    expect(asked).toEqual([]);
    expect(fake.rows.size).toBe(0);
  });

  it("laptop purge deletes any memory row older than 2 minutes, keeps fresh ones", async () => {
    const fake = fakeSupabase();
    await fake.store.insertRequest("old question");
    fake.advance(MEMORY_ROW_TTL_MS + 1000);
    await fake.store.insertRequest("new question");
    await purgeMemoryRows(fake.store, fake.now());
    expect([...fake.rows.keys()]).toEqual(["r2"]);
  });

  it("a malformed reply is never shown as an answer", () => {
    expect(parseCard("not json")).toBeNull();
    expect(parseCard(JSON.stringify({ status: "answered" }))).toBeNull();
    expect(parseCard(JSON.stringify({ status: "made-up", answer: "x" }))).toBeNull();
    const c = parseCard(JSON.stringify({ status: "answered", answer: "ok", sources: [{ title: "t", url: "javascript:alert(1)", domain: "d", capturedAt: "" }] }));
    expect(c?.sources).toEqual([]);
  });

  it("the cloud planner never receives the question or the answer (private turns)", () => {
    const history = plannerHistory([
      { id: "1", role: "user", text: "add gym tomorrow at 7 PM" },
      { id: "2", role: "user", text: "what did I read today about CRISPR?", private: true },
      { id: "3", role: "assistant", text: "", private: true, card: { ...ANSWER, relayed: true } },
    ]);
    expect(JSON.stringify(history)).not.toMatch(/CRISPR|base editing|broad\.example/);
  });
});
