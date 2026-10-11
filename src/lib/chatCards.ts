/** Builds chat cards from a planner turn's tool results (no UI here). */
import type { ChatCard } from "../types";
import { getProposal } from "./commitmentProposals";
import { COMMITMENT_TOOL_NAMES } from "./commitmentTools";

type ToolUse = { name: string; arguments: unknown; result: unknown };

/** The commitment card for the last proposal made this turn, if any. */
export function commitmentCardFromTools(tools: ToolUse[]): ChatCard | null {
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    const t = tools[i];
    if (!(COMMITMENT_TOOL_NAMES as readonly string[]).includes(t.name)) continue;
    const id = (t.result as { proposal_id?: unknown } | null)?.proposal_id;
    if (typeof id !== "string") continue;
    const p = getProposal(id);
    if (!p) continue;
    return { kind: "commitment", proposalId: p.id, op: p.op, fields: p.fields, conflicts: p.conflicts };
  }
  return null;
}

/** The pending proposal the user is answering: only the latest assistant turn's card counts. */
export function pendingProposalId(turns: { role: string; card?: ChatCard }[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i];
    if (t.role !== "assistant") continue;
    if (t.card?.kind === "receipt") continue; // a receipt rides under its reply
    if (t.card?.kind !== "commitment") return null;
    const p = getProposal(t.card.proposalId);
    return p && p.status === "pending" ? p.id : null;
  }
  return null;
}
