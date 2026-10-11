/**
 * Memory routing, decided in code.
 *
 * A question about what the user read, searched or visited goes straight to
 * local Memory: it never reaches the cloud planner, and neither does the
 * answer. As a fallback the planner has an `ask_memory` tool; its result is a
 * fixed sentence, the answer itself goes only to the chat.
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ChatCard } from "../types";
import { askMemory, memoryBridge } from "./memoryClient";
import { askMemoryRelayed } from "./memoryRelayLive";
import { isSupabaseConfigured } from "./supabase";

const MEMORY_Q = [
  /\bwhat (did|have) i (read|search(ed)?|look(ed)? (at|up)|see|saw|watch(ed)?|brows(e|ed)|visit(ed)?|google(d)?)\b/i,
  /\bwhat (was|were) (the|that|those) .{0,40}\b(i|i'd) (read|saw|looked at|visited|watched|found|searched)\b/i,
  /\b(find|show me|pull up|get me|remind me (of|about))\b.{0,30}\b(article|page|post|paper|video|recipe|site|link|thread|blog|tab|doc)\b.{0,40}\b(i|i'd)\b/i,
  /\b(article|page|post|paper|video|recipe|site|link|thread|blog)\b.{0,30}\b(i|i'd) (read|saw|looked at|visited|watched|was reading|opened)\b/i,
  /\bin (my )?memory\b/i,
  /\bmy (browsing|search) history\b/i,
];

/** Clearly about the calendar, not Memory ("what did I schedule", "what's on Tuesday"). */
const CALENDAR = /\b(schedul|calendar|commitment|appointment|meeting|class|shift|book(ed|ing)?|remind me to|plan)\b/i;

export function isMemoryQuestion(text: string): boolean {
  const t = String(text || "");
  if (!t.trim() || CALENDAR.test(t)) return false;
  return MEMORY_Q.some((r) => r.test(t));
}

/** The only thing the cloud planner ever learns from Memory. */
export const MEMORY_TOOL_RESULT = "Answered from Memory, shown to the user.";

export const ASK_MEMORY_SCHEMA: ChatCompletionTool = {
  type: "function",
  function: {
    name: "ask_memory",
    description:
      "The user is asking about web pages they read, searched or visited. Rocky answers from local Memory on the laptop and shows it to the user; you never see the answer. Pass only their question.",
    parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
  },
};

/** The answer card from the last ask_memory call, picked up by the chat (never by the planner). */
let pending: Extract<ChatCard, { kind: "memory" }> | null = null;
export function takeMemoryCard() {
  const c = pending;
  pending = null;
  return c;
}

export async function memoryCardFor(question: string): Promise<Extract<ChatCard, { kind: "memory" }>> {
  // No local Memory here (the phone, or a browser tab): ask the laptop
  // through the transient relay. Memory itself never leaves the laptop.
  if (!memoryBridge() && isSupabaseConfigured) return askMemoryRelayed(question);
  const r = await askMemory(question);
  return { kind: "memory", status: r.status, answer: r.answer, sources: r.sources };
}

/** ask_memory: answers locally, stashes the card, returns a fixed line. */
export async function runAskMemory(args: Record<string, unknown>, userText?: string): Promise<string> {
  const q = (userText ?? "").trim() || String(args.question ?? "").trim();
  pending = await memoryCardFor(q);
  return MEMORY_TOOL_RESULT;
}
