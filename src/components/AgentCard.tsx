import { useState } from "react";
import { cancelAgent, dismissAgent, type AgentView } from "../lib/agentClient";

type Props = {
  agent: AgentView;
  /** Sends a turn as if spoken: "yes", "no", "continue". The voice fast path handles these. */
  onSend: (text: string) => void;
  /** Phone: no screenshot, no step log (those stay on the laptop). */
  compact?: boolean;
};

const ACTIVE = new Set(["starting", "running", "question", "code", "confirm", "takeover"]);

/**
 * The booking agent's live card: status, the question it's waiting on, the
 * final confirmation (with the page screenshot on the laptop), handoffs, and
 * the result. Sits above the talk controls on both laptop and phone.
 */
export default function AgentCard({ agent, onSend, compact }: Props) {
  const [showLog, setShowLog] = useState(false);
  if (agent.phase === "idle") return null;
  const active = ACTIVE.has(agent.phase);
  const body =
    agent.phase === "question" || agent.phase === "code"
      ? agent.question
      : agent.phase === "confirm"
        ? agent.summary
        : agent.phase === "takeover" || agent.phase === "failed" || agent.phase === "cancelled"
          ? agent.message
          : agent.phase === "done"
            ? agent.result?.status === "booked"
              ? `Booked${agent.result.reference ? ` · ${agent.result.reference}` : ""}`
              : "No confirmation on the page — check the agent window."
            : null;
  const btn = "cursor-pointer rounded-[3px] px-[16px] py-[8px] text-13";
  const primary = `${btn} bg-ink font-medium text-canvas hover:bg-accent`;
  const ghost = `${btn} border border-line-strong font-mono text-ink-muted hover:border-ink hover:text-ink`;

  return (
    <div className="mb-[14px] rounded-[4px] border border-line bg-card px-[14px] py-[12px]" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-micro tracking-tab uppercase text-grey">Booking agent</span>
        <span className={`truncate font-mono text-micro tracking-tab uppercase ${agent.phase === "failed" ? "text-warm" : "text-accent"}`}>
          {agent.status || (agent.phase === "starting" ? "Opening page" : "")}
        </span>
      </div>

      {body && <div className="mt-[8px] text-body leading-[1.45] text-ink [text-wrap:pretty]">{body}</div>}
      {agent.phase === "question" && (
        <div className="mt-[6px] font-mono text-micro text-grey-mid">Answer by voice or type it below.</div>
      )}
      {agent.phase === "code" && (
        <div className="mt-[6px] font-mono text-micro text-grey-mid">
          {compact
            ? "Codes stay on your laptop: say it to Rocky there, or type it into the agent window."
            : "Say the digits or type them below. Rocky types the code in for you and never saves it."}
        </div>
      )}
      {agent.phase === "takeover" && (
        <div className="mt-[6px] font-mono text-micro text-grey-mid">Do it in the agent window, then tap Continue or say “continue”.</div>
      )}
      {!compact && agent.phase === "confirm" && agent.screenshot && (
        <img src={agent.screenshot} alt="The booking page right before the final click" className="mt-[10px] w-full rounded-[3px] border border-line" />
      )}
      {!compact && agent.phase === "done" && agent.screenshot && (
        <img src={agent.screenshot} alt="The booking page after submitting" className="mt-[10px] w-full rounded-[3px] border border-line" />
      )}
      {compact && agent.phase === "confirm" && (
        <div className="mt-[6px] font-mono text-micro text-grey-mid">The page screenshot is on your laptop.</div>
      )}

      <div className="mt-[12px] flex flex-wrap items-center gap-2">
        {agent.phase === "confirm" && (
          <>
            <button type="button" className={primary} onClick={() => onSend("yes")}>Confirm</button>
            <button type="button" className={ghost} onClick={() => onSend("no")}>Cancel</button>
          </>
        )}
        {agent.phase === "takeover" && (
          <button type="button" className={primary} onClick={() => onSend("continue")}>Continue</button>
        )}
        {active && agent.phase !== "confirm" && (
          <button type="button" className={ghost} onClick={() => void cancelAgent()}>Stop</button>
        )}
        {!active && (
          <button type="button" className={ghost} onClick={() => dismissAgent()}>Dismiss</button>
        )}
        {!compact && agent.log.length > 0 && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="ml-auto cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink"
          >
            {showLog ? "Hide steps" : `Steps (${agent.log.length})`}
          </button>
        )}
      </div>

      {!compact && showLog && (
        <ol className="mt-[10px] max-h-[160px] overflow-y-auto overscroll-contain border-t border-line-panel pt-[8px] font-mono text-micro leading-[1.6]">
          {agent.log.map((s, i) => (
            <li key={i} className={s.blocked ? "text-warm" : "text-grey"}>
              {s.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
