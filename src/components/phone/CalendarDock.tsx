import { useEffect, useReducer } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { useAssistant } from "../../hooks/useAssistant";
import { useAgentView } from "../../hooks/useAgentView";
import { ensureAudioUnlocked } from "../../lib/speech";
import { calendarPending, needsConfirm as computeNeedsConfirm, TOAST_MS, toastReducer } from "../../lib/phoneTabs";
import AgentCard from "../AgentCard";
import ShowAgentBrowser from "./ShowAgentBrowser";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

type Assistant = ReturnType<typeof useAssistant>;

/**
 * Calendar tab, above the tab bar: a pending confirmation or booking run
 * (never missed), the last reply as a short toast with "Open chat", and a
 * small floating mic (bottom-right) that starts a voice turn.
 */
export default function CalendarDock({ assistant, onOpenChat }: { assistant: Assistant; onOpenChat: () => void }) {
  const agent = useAgentView();
  const agentBusy = !["idle", "done", "failed", "cancelled"].includes(agent.phase);
  const lastAssistant = [...assistant.turns].reverse().find((t) => t.role === "assistant") ?? null;
  const confirm = computeNeedsConfirm(lastAssistant?.text ?? null, Boolean(lastAssistant?.card), assistant.state, agentBusy);
  const pending = calendarPending({ needsConfirm: confirm, agentPhase: agent.phase });

  // A new reply shows; once the turn is over it clears after 2 s.
  const [toast, dispatch] = useReducer(toastReducer, { id: lastAssistant?.id ?? null, visible: false });
  useEffect(() => {
    if (lastAssistant?.id) dispatch({ type: "reply", id: lastAssistant.id });
  }, [lastAssistant?.id]);
  useEffect(() => {
    if (!toast.visible || !toast.id || assistant.state !== "idle" || pending) return;
    const id = toast.id;
    const t = window.setTimeout(() => dispatch({ type: "idle-timeout", id }), TOAST_MS);
    return () => window.clearTimeout(t);
  }, [toast.visible, toast.id, assistant.state, pending]);

  const replyText = lastAssistant?.text || (lastAssistant?.card?.kind === "memory" ? lastAssistant.card.answer : "");
  const listening = assistant.state === "listening";

  return (
    // In the flow above the tab bar: a pending card or an error takes real
    // space (the list shrinks and still scrolls). The toast and the mic float
    // just above it.
    <div className={`relative z-30 flex flex-none flex-col items-stretch gap-2 px-5 ${assistant.error || pending ? "pb-3 pt-2" : ""}`}>
      {assistant.error && (
        <div className="rounded-[3px] border border-warm-line bg-warm-soft px-3 py-2 font-mono text-meta leading-[1.5] text-ink-soft">{assistant.error}</div>
      )}
      {pending === "agent" && (
        <div className="pointer-events-auto">
          <AgentCard agent={agent} onSend={(t) => void assistant.send(t)} compact />
          <ShowAgentBrowser phase={agent.phase} />
        </div>
      )}
      {pending === "confirm" && (
        <div className="pointer-events-auto rounded-[3px] border border-line bg-card px-3 py-3" role="group" aria-label="Rocky is waiting for a yes">
          <div className="text-14 leading-[1.45] text-ink-soft [overflow-wrap:anywhere]">{lastAssistant?.text}</div>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => void assistant.send("yes")} className="h-11 flex-1 cursor-pointer rounded-[3px] bg-ink text-13 font-medium text-canvas hover:bg-accent">
              Confirm
            </button>
            <button type="button" onClick={() => void assistant.send("cancel")} className="h-11 flex-1 cursor-pointer rounded-[3px] border border-line-strong font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-5 bottom-full mb-3 flex items-end gap-3">
        <div className="min-w-0 flex-1" aria-live="polite">
          <AnimatePresence initial={false}>
            {!pending && toast.visible && replyText && assistant.state !== "thinking" && (
              <motion.div
                key={toast.id ?? "toast"}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="pointer-events-auto rounded-[3px] border border-line bg-card px-3 py-2"
              >
                <div className="line-clamp-3 text-14 leading-[1.45] text-ink-soft [overflow-wrap:anywhere]">{replyText}</div>
                <button
                  type="button"
                  onClick={onOpenChat}
                  className="mt-1 flex h-9 cursor-pointer items-center font-mono text-micro tracking-tab uppercase text-accent hover:text-ink"
                >
                  Open chat →
                </button>
              </motion.div>
            )}
            {assistant.state === "thinking" && (
              <motion.div
                key="thinking"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="pointer-events-auto inline-flex rounded-full border border-line bg-card px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-accent"
              >
                Thinking…
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <motion.button
          type="button"
          onClick={() => {
            void ensureAudioUnlocked();
            assistant.toggle();
          }}
          aria-label={listening ? "Tap to finish and send" : "Tap to talk to Rocky"}
          aria-pressed={listening}
          whileTap={{ scale: 0.92 }}
          className={`pointer-events-auto grid h-14 w-14 flex-none cursor-pointer select-none place-items-center rounded-full text-canvas shadow-[0_2px_10px_rgba(0,0,0,0.12)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            listening ? "bg-accent" : "bg-ink hover:bg-accent"
          }`}
        >
          <span className="flex items-center gap-[3px]" aria-hidden>
            {[12, 18, 10, 16].map((h, i) => (
              <span key={i} className="w-[3px] rounded-[2px] bg-canvas" style={{ height: h }} />
            ))}
          </span>
        </motion.button>
      </div>
    </div>
  );
}
