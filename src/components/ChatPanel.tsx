import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { useAssistant } from "../hooks/useAssistant";
import type { ChatCard } from "../types";
import MicButton from "./MicButton";
import AgentCard from "./AgentCard";
import { useAgentView } from "../hooks/useAgentView";
import { voiceInputSupported } from "../lib/speech";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const STATE_LABEL = { idle: "", listening: "Rocky is listening", thinking: "Rocky is thinking", speaking: "Rocky is speaking" } as const;

const HINT = {
  idle: "Tap to talk, or type below.",
  listening: "Listening…  take your time, tap when done",
  thinking: "Thinking… this can take a few seconds.",
  speaking: "Speaking…  tap to cut in",
} as const;

type Assistant = ReturnType<typeof useAssistant>;

type Props = {
  assistant: Assistant;
  /** Renders a rich card under its message (commitments, Memory, receipts). */
  renderCard?: (card: ChatCard, turnId: string) => React.ReactNode;
};

/**
 * The Dashboard's universal chat: one place for commitments, calendar,
 * bookings and Memory. Same assistant as the side panel (useAssistant), with
 * rich cards inline and the live booking agent card at the end of the thread.
 */
export default function ChatPanel({ assistant, renderCard }: Props) {
  const { state, turns, caption, level, error } = assistant;
  const thread = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const agent = useAgentView();
  const agentBusy = !["idle", "done", "failed", "cancelled"].includes(agent.phase);
  const voiceSupported = voiceInputSupported();
  const canSend = draft.trim().length > 0 && state !== "thinking";
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const needsConfirm = Boolean(
    lastAssistant && !lastAssistant.card && /say yes or tap confirm/i.test(lastAssistant.text) && state === "idle" && !agentBusy,
  );

  const submit = () => {
    if (!canSend) return;
    void assistant.send(draft.trim(), { speak: false });
    setDraft("");
  };

  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [turns, state, agent.phase]);

  return (
    <section className="flex min-w-0 flex-[55] flex-col overflow-hidden bg-canvas">
      <div className="flex items-center justify-between border-b border-line px-[48px] pb-[16px] pt-[22px]">
        <div className="font-mono text-label tracking-label uppercase text-grey">Rocky</div>
        <div className="flex items-center gap-5">
          <span className={`font-mono text-meta tracking-tab uppercase ${state === "idle" ? "text-grey-mid" : "text-accent"}`}>{STATE_LABEL[state]}</span>
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => void assistant.clearChat()}
              className="cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink"
            >
              Clear chat
            </button>
          )}
        </div>
      </div>

      <div ref={thread} className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto overscroll-contain px-[48px] py-8">
        {turns.length === 0 && state === "idle" && (
          <div className="mt-[12vh] max-w-[560px]">
            <h1 className="text-[34px] font-medium leading-[1.15] tracking-[-0.022em] [text-wrap:pretty]">What should we sort out?</h1>
            <div className="mt-5 flex flex-col gap-2 font-mono text-meta leading-[1.6] text-grey">
              <span>“I have Chem 101 every Monday and Tuesday 10 to 11:30”</span>
              <span>“Move my study block to after lab”</span>
              <span>“Book a haircut Saturday at 3”</span>
              <span>“What did I read about Qwen last week?”</span>
            </div>
          </div>
        )}
        <AnimatePresence initial={false}>
          {turns.map((turn) =>
            turn.role === "user" ? (
              <motion.div
                key={turn.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="flex flex-col items-end gap-2 pl-16"
              >
                <div className="max-w-[520px] rounded-[6px] rounded-tr-[2px] border border-line bg-done px-[15px] py-[11px] text-body leading-[1.45] text-ink [text-wrap:pretty]">
                  {turn.text}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key={turn.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="flex flex-col gap-2 border-l-2 border-accent-line pl-[14px] pr-16"
              >
                {turn.text && <div className="max-w-[600px] text-body leading-[1.5] text-ink-soft [text-wrap:pretty]">{turn.text}</div>}
                {turn.card && renderCard && <div className="max-w-[560px]">{renderCard(turn.card, turn.id)}</div>}
              </motion.div>
            ),
          )}
        </AnimatePresence>

        {state === "thinking" && (
          <div className="border-l-2 border-accent pl-[16px]">
            <div className="flex items-center gap-[9px]">
              <span className="flex items-center gap-[5px]">
                {[0, 0.2, 0.4].map((delay) => (
                  <span key={delay} className="h-[6px] w-[6px] rounded-full bg-accent" style={{ animation: `vcpulse 1s ease-in-out ${delay}s infinite` }} />
                ))}
              </span>
              <span className="text-lead leading-[1.4] text-grey">Thinking…</span>
            </div>
          </div>
        )}

        {agent.phase !== "idle" && (
          <div className="max-w-[560px] border-l-2 border-accent-line pl-[14px]">
            <AgentCard agent={agent} onSend={(t) => void assistant.send(t)} />
          </div>
        )}
      </div>

      <div className="border-t border-line px-[48px] pb-[22px] pt-[16px]">
        {state === "listening" && (
          <div className="mb-[14px] flex min-h-[40px] items-center text-lead leading-[1.4] text-ink [text-wrap:pretty]">
            {caption ? (
              <span>
                {caption}
                <span className="text-accent">|</span>
              </span>
            ) : (
              <span className="flex items-end gap-[3px]" aria-label="Listening">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span
                    key={i}
                    className="w-[3px] rounded-[2px] bg-accent transition-[height] duration-100"
                    style={{ height: 6 + Math.round(level * 22 * (i === 2 ? 1 : i % 2 ? 0.75 : 0.5)) }}
                  />
                ))}
              </span>
            )}
          </div>
        )}
        {error && (
          <div className="mb-[14px] rounded-[3px] border border-warm-line bg-warm-soft px-3 py-2 font-mono text-meta leading-[1.5] text-ink-soft">{error}</div>
        )}
        {needsConfirm && (
          <div className="mb-[14px] flex items-center gap-2">
            <button type="button" onClick={() => void assistant.send("yes")} className="cursor-pointer rounded-[3px] bg-ink px-[18px] py-[9px] text-13 font-medium text-canvas hover:bg-accent">
              Confirm
            </button>
            <button type="button" onClick={() => void assistant.send("cancel")} className="cursor-pointer rounded-[3px] border border-line-strong px-[18px] py-[9px] font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">
              Cancel
            </button>
          </div>
        )}
        <div className="flex items-center gap-3">
          <MicButton state={state} onToggle={assistant.toggle} />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={voiceSupported ? "Message Rocky…" : "Voice isn't supported here — type to Rocky…"}
            className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-[10px] text-15 leading-[1.4] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className={`flex-none cursor-pointer rounded-[3px] px-[16px] py-[10px] font-mono text-13 font-medium transition-colors ${
              canSend ? "bg-ink text-canvas hover:bg-accent" : "cursor-not-allowed bg-line-strong text-grey-mid"
            }`}
          >
            Send
          </button>
        </div>
        <div className="mt-2 font-mono text-hint leading-[1.5] text-grey">{HINT[state]}</div>
      </div>
    </section>
  );
}
