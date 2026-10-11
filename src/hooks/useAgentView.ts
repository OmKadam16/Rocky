import { useEffect, useState } from "react";
import { getAgentView, subscribeAgent, type AgentView } from "../lib/agentClient";

/** Live view of the booking agent run (laptop: local; phone: relayed). */
export function useAgentView(): AgentView {
  const [view, setView] = useState<AgentView>(() => getAgentView());
  useEffect(() => subscribeAgent(setView), []);
  return view;
}
