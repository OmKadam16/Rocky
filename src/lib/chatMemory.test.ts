import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantTurn } from "../types";
import {
  FOLD_AFTER,
  PLANNER_WINDOW,
  foldIntoSummary,
  forgetEverything,
  forgetFacts,
  loadMemory,
  memoryContext,
  memoryStoreInMemory,
  mergeMemory,
  profileStore,
  rememberFact,
  turnsToFold,
  useMemoryStore,
} from "./chatMemory";
import { PLANNER_RULES } from "./plannerPrompt";

let n = 0;
const turn = (role: "user" | "assistant", text: string, extra: Partial<AssistantTurn> = {}): AssistantTurn => ({ id: `t${++n}`, role, text, at: 1000 + n, ...extra });
const chat = (count: number) => Array.from({ length: count }, (_, i) => turn(i % 2 ? "assistant" : "user", `message ${i}`));

beforeEach(() => {
  useMemoryStore(memoryStoreInMemory());
});

describe("facts", () => {
  it("remembers, replaces the same topic, and forgets on request", async () => {
    await rememberFact("Their barber is Fade Co");
    await rememberFact("Prefers dinner around 8pm");
    const r = await rememberFact("Their barber is now Kings Cuts");
    expect(r.ok && r.replaced).toBe("Their barber is Fade Co");
    let m = await loadMemory();
    expect(m.facts.map((f) => f.text).sort()).toEqual(["Prefers dinner around 8pm", "Their barber is now Kings Cuts"]);
    expect(await forgetFacts("barber")).toEqual(["Their barber is now Kings Cuts"]);
    m = await loadMemory();
    expect(m.facts.map((f) => f.text)).toEqual(["Prefers dinner around 8pm"]);
  });

  it("never keeps secrets", async () => {
    for (const t of ["My password is hunter2", "Card number 4111 1111 1111 1111", "The verification code was 4271", "•••• (verification code)"]) {
      expect((await rememberFact(t)).ok).toBe(false);
    }
    expect((await loadMemory()).facts).toHaveLength(0);
  });
});

describe("what the planner reads first", () => {
  it("nothing yet: no memory message", async () => {
    expect(memoryContext(await loadMemory())).toBe(null);
  });

  it("facts and the summary, with the rule that the user's words now win", async () => {
    await rememberFact("Books restaurants under Om Kadam");
    const text = memoryContext({ ...(await loadMemory()), summary: "They booked Nobu Newport Beach for 3 on Oct 13." }) as string;
    expect(text).toMatch(/^chat_memory/);
    expect(text).toMatch(/- Books restaurants under Om Kadam/);
    expect(text).toMatch(/Earlier conversations \(summary\): They booked Nobu/);
    expect(text).toMatch(/their words win/);
  });

  it("the planner prompt tells it to read memory first and how to save", () => {
    expect(PLANNER_RULES).toMatch(/Read chat_memory first/);
    expect(PLANNER_RULES).toMatch(/remember_fact/);
    expect(PLANNER_RULES).toMatch(/forget_fact/);
  });
});

describe("summary of earlier chat", () => {
  it("folds only turns that left the planner's window, a batch at a time", async () => {
    const complete = vi.fn(async () => "They planned a study week.");
    // Window plus fewer than FOLD_AFTER extra: nothing yet.
    await foldIntoSummary(chat(PLANNER_WINDOW + FOLD_AFTER - 1), complete);
    expect(complete).not.toHaveBeenCalled();
    const turns = chat(PLANNER_WINDOW + FOLD_AFTER);
    await foldIntoSummary(turns, complete);
    expect(complete).toHaveBeenCalledTimes(1);
    const m = await loadMemory();
    expect(m.summary).toBe("They planned a study week.");
    // The newest PLANNER_WINDOW turns aren't folded (the planner still sees them).
    expect(m.summarizedUpTo).toBe(turns[FOLD_AFTER - 1].at);
    expect(turnsToFold(turns, m.summarizedUpTo)).toHaveLength(0);
  });

  it("Clear chat folds everything not yet summarised, and memory survives", async () => {
    const complete = vi.fn(async (p: { system: string; user: string }) => (p.user.includes("Nobu") ? "They booked Nobu for 3." : "x"));
    await rememberFact("Vegetarian");
    await foldIntoSummary([turn("user", "Book Nobu for 3 on the 13th"), turn("assistant", "On it.")], complete, { all: true });
    const m = await loadMemory();
    expect(m.summary).toBe("They booked Nobu for 3.");
    expect(m.facts.map((f) => f.text)).toEqual(["Vegetarian"]);
  });

  it("private turns and verification codes never go into the summary", async () => {
    const complete = vi.fn(async (_p: { system: string; user: string }) => "ok");
    await foldIntoSummary(
      [
        turn("user", "what did I read about CRISPR?", { private: true }),
        turn("assistant", "You read the Broad piece.", { private: true }),
        turn("user", "•••• (verification code)"),
        turn("user", "book a haircut"),
      ],
      complete,
      { all: true },
    );
    const sent = complete.mock.calls[0]?.[0].user ?? "";
    expect(sent).toMatch(/book a haircut/);
    expect(sent).not.toMatch(/CRISPR|Broad|verification code/);
  });

  it("a failed model call loses nothing: the turns are tried again", async () => {
    const turns = chat(PLANNER_WINDOW + FOLD_AFTER);
    await foldIntoSummary(turns, async () => null);
    expect((await loadMemory()).summary).toBe("");
    await foldIntoSummary(turns, async () => "Now it worked.");
    expect((await loadMemory()).summary).toBe("Now it worked.");
  });

  it("forget everything wipes facts and summary", async () => {
    await rememberFact("Vegetarian");
    await foldIntoSummary([turn("user", "hi there, plan my week")], async () => "They wanted a week plan.", { all: true });
    await forgetEverything();
    const m = await loadMemory();
    expect(m.facts).toHaveLength(0);
    expect(m.summary).toBe("");
  });
});

describe("synced between laptop and phone (profile extra.chat_memory)", () => {
  /** One profile row in "Supabase", two devices with their own localStorage. */
  function cloud() {
    let row: unknown = null;
    const device = () => {
      const local = new Map<string, string>();
      return {
        read: async () => (row ? JSON.parse(JSON.stringify(row)) : null),
        write: async (m: unknown) => void (row = JSON.parse(JSON.stringify(m))),
        localGet: (k: string) => local.get(k) ?? null,
        localSet: (k: string, v: string | null) => void (v == null ? local.delete(k) : local.set(k, v)),
      };
    };
    return { device, row: () => row as { facts: { text: string }[]; summary: string } | null };
  }

  it("a fact saved on the laptop is there on the phone, and forgetting works both ways", async () => {
    const c = cloud();
    const laptop = profileStore(c.device());
    const phone = profileStore(c.device());
    useMemoryStore(laptop);
    await rememberFact("Their usual spot is Nobu Newport Beach");
    useMemoryStore(phone);
    expect((await loadMemory()).facts.map((f) => f.text)).toEqual(["Their usual spot is Nobu Newport Beach"]);
    await rememberFact("Vegetarian");
    useMemoryStore(laptop);
    expect((await loadMemory()).facts.map((f) => f.text).sort()).toEqual(["Their usual spot is Nobu Newport Beach", "Vegetarian"]);
    await forgetFacts("Nobu");
    useMemoryStore(phone);
    expect((await loadMemory()).facts.map((f) => f.text)).toEqual(["Vegetarian"]);
  });

  it("the summary is shared; which turns are summarised stays per device", async () => {
    const c = cloud();
    const laptop = profileStore(c.device());
    const phone = profileStore(c.device());
    useMemoryStore(laptop);
    await foldIntoSummary([turn("user", "plan my exam week")], async () => "They're planning exam week.", { all: true });
    useMemoryStore(phone);
    const m = await loadMemory();
    expect(m.summary).toBe("They're planning exam week.");
    expect(m.summarizedUpTo).toBe(0); // the phone's own chat isn't summarised yet
  });

  it("a write never drops the other device's newer change (fresh read first)", async () => {
    const c = cloud();
    const laptop = profileStore(c.device());
    const phone = profileStore(c.device());
    await laptop.putFact({ id: "a", text: "Vegetarian", at: 1 });
    await phone.putFact({ id: "b", text: "Prefers dinner around 8pm", at: 2 });
    await laptop.setMeta("summary", "They like Nobu.");
    expect(c.row()?.facts.map((f) => f.text)).toEqual(["Vegetarian", "Prefers dinner around 8pm"]);
    expect(c.row()?.summary).toBe("They like Nobu.");
  });

  it("merging the old local-only memory keeps both sides, one per topic", () => {
    const remote = { v: 1 as const, facts: [{ id: "r", text: "Their barber is Fade Co", at: 1 }], summary: "Phone chats.", updatedAt: 1 };
    const local = { v: 1 as const, facts: [{ id: "l", text: "Their barber is Kings Cuts", at: 5 }, { id: "l2", text: "Vegetarian", at: 6 }], summary: "Laptop chats.", updatedAt: 6 };
    const m = mergeMemory(remote, local);
    expect(m.facts.map((f) => f.text)).toEqual(["Their barber is Kings Cuts", "Vegetarian"]);
    expect(m.summary).toBe("Phone chats. Laptop chats.");
  });
});
