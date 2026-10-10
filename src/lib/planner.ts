import type { AssistantTurn } from "../types";
import { askPlannerLocal } from "./plannerLocal";

export type PlannerResponse = {
  reply: string;
  tools_used: { name: string; arguments: unknown; result: unknown }[];
  schedule_changed: boolean;
};

export async function askPlanner(message: string, history: AssistantTurn[]): Promise<PlannerResponse> {
  return askPlannerLocal(message, history);
}
