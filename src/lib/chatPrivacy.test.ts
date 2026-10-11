import { describe, expect, it } from "vitest";
import { plannerHistory } from "./plannerLocal";
import type { AssistantTurn } from "../types";

describe("chat history sent to the cloud planner", () => {
  it("never includes private turns (Memory, receipts)", () => {
    const turns: AssistantTurn[] = [
      { id: "1", role: "user", text: "add gym tomorrow 7pm" },
      { id: "2", role: "assistant", text: "Done." },
      { id: "3", role: "user", text: "what did I read about CRISPR?", private: true },
      { id: "4", role: "assistant", text: "You read the Broad Institute piece on base editing.", private: true },
      { id: "5", role: "assistant", text: "Added Gym", private: true, card: { kind: "receipt", text: "Added Gym", undoId: "u1" } },
    ];
    const sent = plannerHistory(turns);
    expect(sent.map((t) => t.id)).toEqual(["1", "2"]);
    expect(JSON.stringify(sent)).not.toMatch(/CRISPR|Broad Institute/);
  });

  it("keeps only the last few public turns", () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: "user" as const, text: `t${i}` }));
    expect(plannerHistory(turns).map((t) => t.id)).toEqual(["12", "13", "14", "15", "16", "17", "18", "19"]);
  });
});
