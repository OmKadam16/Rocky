/**
 * Planner tools for fixed commitments by chat. They only PROPOSE: each one
 * returns a proposal the chat renders as a CommitmentCard. Nothing here
 * writes fixed_commitments (see commitmentProposals.confirmProposal).
 */
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  complete,
  createProposal,
  dbCommitmentStore,
  fieldsFromRow,
  findCommitment,
  nextMissing,
  normalizeFields,
  summarize,
  type CommitmentStore,
  type PartialFields,
} from "./commitmentProposals";

export const COMMITMENT_TOOL_NAMES = ["propose_commitment", "propose_commitment_change", "propose_commitment_removal"] as const;

const fields = {
  name: { type: "string", description: "e.g. Chem 101, Shift, Gym" },
  type: { type: "string", enum: ["Class", "Work", "Gym", "Other"] },
  days_of_week: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "0 = Sunday … 6 = Saturday" },
  start_time: { type: "string", description: "HH:MM 24h, exactly as the user said it" },
  end_time: { type: "string", description: "HH:MM 24h, exactly as the user said it" },
  active_from: { type: "string", description: "YYYY-MM-DD, only if the user gave a start date" },
  active_until: { type: "string", description: "YYYY-MM-DD, only if the user gave an end date ('until December 12')" },
  notes: { type: "string" },
} as const;

export const COMMITMENT_TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "propose_commitment",
      description:
        "Propose a NEW recurring fixed commitment (class, shift, work, gym). It does not save anything: it shows the user a card to Confirm, Edit or Cancel. Missing details come back as ONE question. Never invent days or times.",
      parameters: { type: "object", properties: fields, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_commitment_change",
      description: "Propose changing an existing fixed commitment (days, times, dates, name). Shows a confirm card; saves nothing itself.",
      parameters: {
        type: "object",
        properties: { commitment_query: { type: "string", description: "Its name, e.g. 'Chem 101'" }, ...fields },
        required: ["commitment_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_commitment_removal",
      description: "Propose deleting a fixed commitment. Shows a confirm card; nothing is deleted until the user confirms.",
      parameters: { type: "object", properties: { commitment_query: { type: "string" } }, required: ["commitment_query"] },
    },
  },
];

/** The new commitment being built across turns (one question at a time). */
let building: PartialFields | null = null;
export function resetCommitmentDraft() {
  building = null;
}

const CARD_SAY =
  "The card is on screen. Say one short line, e.g. \"Here it is — tap Confirm or say yes.\" Mention any conflicts listed. Never say it's added or saved: nothing is until the user confirms.";

export async function runCommitmentTool(name: string, args: Record<string, unknown>, store: CommitmentStore = dbCommitmentStore): Promise<unknown> {
  switch (name) {
    case "propose_commitment": {
      const incoming = normalizeFields(args);
      // Same (or no) name continues the draft from the last question.
      const base = building && (!incoming.name || !building.name || incoming.name.toLowerCase() === building.name.toLowerCase()) ? building : {};
      const merged: PartialFields = { ...base, ...incoming };
      building = merged;
      const gap = nextMissing(merged);
      if (gap) {
        if ("error" in gap) return { error: gap.error };
        return { needs: gap.field, question: gap.question, next: "Ask exactly this one question, then stop. Call propose_commitment again with everything so far plus the answer." };
      }
      building = null;
      const p = await createProposal("add", complete(merged), null, store);
      return { proposal_id: p.id, card: "commitment", summary: summarize(p.fields), conflicts: p.conflicts, say: CARD_SAY };
    }

    case "propose_commitment_change": {
      const rows = await store.list();
      const found = findCommitment(String(args.commitment_query ?? ""), rows);
      if ("question" in found) return { needs: "commitment", question: found.question };
      const patch = normalizeFields(args);
      if (!Object.keys(patch).length) return { needs: "change", question: `What should change about ${found.row.name}?` };
      const next = { ...fieldsFromRow(found.row), ...patch };
      const gap = nextMissing(next);
      if (gap) return "error" in gap ? { error: gap.error } : { needs: gap.field, question: gap.question };
      const p = await createProposal("update", complete(next), found.row, store);
      return { proposal_id: p.id, card: "commitment", summary: summarize(p.fields), conflicts: p.conflicts, say: CARD_SAY };
    }

    case "propose_commitment_removal": {
      const rows = await store.list();
      const found = findCommitment(String(args.commitment_query ?? ""), rows);
      if ("question" in found) return { needs: "commitment", question: found.question };
      const p = await createProposal("delete", fieldsFromRow(found.row), found.row, store);
      return {
        proposal_id: p.id,
        card: "commitment",
        summary: `Remove ${summarize(p.fields)}`,
        say: "The removal card is on screen. Say one short line, e.g. \"Remove it? Tap Confirm or say yes.\" Nothing is deleted until they confirm.",
      };
    }

    default:
      throw new Error(`Unknown commitment tool: ${name}`);
  }
}
