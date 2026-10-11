import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "You read the Broad Institute piece on base editing (secret-browsing-detail).";
const asked = vi.hoisted(() => ({ questions: [] as string[] }));
vi.mock("./memoryClient", () => ({
  askMemory: async (q: string) => {
    asked.questions.push(q);
    return { status: "answered", answer: SECRET, sources: [{ title: "Base editing", url: "https://broad.example/x", domain: "broad.example", capturedAt: "2026-10-09T12:00:00.000Z" }] };
  },
}));

import { MEMORY_TOOL_RESULT, isMemoryQuestion, takeMemoryCard } from "./memoryIntent";
import { runTool } from "./plannerTools";

beforeEach(() => {
  asked.questions = [];
  takeMemoryCard();
});

describe("memory questions are recognised in code", () => {
  it("routes the brief's examples to Memory", () => {
    for (const q of [
      "what did I search for on Tuesday?",
      "find that article about CRISPR I read last week",
      "what was the recipe I looked at yesterday?",
      "what did I read about Qwen?",
      "show me the video I watched this morning about sourdough",
    ]) {
      expect(isMemoryQuestion(q), q).toBe(true);
    }
  });

  it("leaves calendar and booking questions to the planner", () => {
    for (const q of ["what did I schedule for Tuesday?", "what's on my calendar tomorrow", "book a table at Nobu", "I have Chem 101 every Monday", "move my study block"]) {
      expect(isMemoryQuestion(q), q).toBe(false);
    }
  });
});

describe("the planner never receives memory text", () => {
  it("ask_memory returns only the fixed line; the answer goes to the chat card", async () => {
    const result = await runTool("ask_memory", { question: "what did I read about base editing?" }, { userText: "what did I read about base editing?" } as never);
    // This is exactly what the planner loop puts in its tool message.
    const toolMessage = JSON.stringify(result);
    expect(result).toBe(MEMORY_TOOL_RESULT);
    expect(toolMessage).not.toContain("Broad");
    expect(toolMessage).not.toContain("secret-browsing-detail");
    const card = takeMemoryCard();
    expect(card?.answer).toBe(SECRET);
    expect(card?.sources[0].domain).toBe("broad.example");
    expect(takeMemoryCard()).toBe(null); // taken once
  });

  it("Memory gets the user's own words, not the planner's rewrite", async () => {
    await runTool("ask_memory", { question: "base editing" }, { userText: "that thing about base editing I read" } as never);
    expect(asked.questions).toEqual(["that thing about base editing I read"]);
  });
});
