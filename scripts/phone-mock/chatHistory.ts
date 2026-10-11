/**
 * Stand-in for src/lib/chatHistory.ts in the phone screenshot harness only:
 * a short conversation, including a relayed Memory card and a receipt.
 */
import type { AssistantTurn } from "../../src/types";

export const MAX_MESSAGES = 200;
const at = Date.now() - 60_000;
const SEED: AssistantTurn[] = [
  { id: "s1", role: "user", text: "Add gym tomorrow at 7 PM", at },
  { id: "s2", role: "assistant", text: "Gym's on tomorrow, 7 to 8 PM.", at: at + 1 },
  { id: "s3", role: "assistant", text: "", private: true, card: { kind: "receipt", text: "Added Gym · tomorrow 7 to 8 PM", undoId: null }, at: at + 2 },
  { id: "s4", role: "user", text: "What did I read today about CRISPR?", private: true, at: at + 3 },
  {
    id: "s5",
    role: "assistant",
    text: "",
    private: true,
    at: at + 4,
    card: {
      kind: "memory",
      status: "answered",
      answer: "You read the Broad Institute piece on base editing, about fixing single letters of DNA without cutting both strands.",
      sources: [{ title: "Base editing, explained", url: "https://www.broadinstitute.org/what-broad/areas-focus/project-spotlight/base-editing", domain: "broadinstitute.org", capturedAt: new Date().toISOString() }],
      relayed: true,
      note: "Sent through your account for a moment, then deleted.",
    },
  },
  { id: "s6", role: "user", text: "Remove everything this afternoon", at: at + 5 },
  { id: "s7", role: "assistant", text: "Remove Study: organic chemistry, 1 to 3 PM today? Say yes or tap Confirm.", at: at + 6 },
];

export async function loadChat(): Promise<AssistantTurn[]> {
  return (globalThis as { __emptyChat?: boolean }).__emptyChat ? [] : SEED;
}
export async function saveTurn(): Promise<void> {}
export async function deleteTurn(): Promise<void> {}
export async function clearChat(): Promise<void> {}
export function shouldPersist(turn: Pick<AssistantTurn, "private">, keepPrivate: boolean): boolean {
  return keepPrivate || !turn.private;
}
