import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { AssistantState, AssistantTurn } from "../types";
import MicButton from "./MicButton";
import { voiceInputSupported } from "../lib/speech";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const STATUS_LABEL: Record<AssistantState, string> = {
  idle: "Idle",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

const HINT: Record<AssistantState, string> = {
  idle: "Tap to talk — or just start speaking.",
  listening: "Listening…  take your time, tap when done",
  thinking: "Thinking… this can take a few seconds.",
  speaking: "Speaking…  tap to cut in",
};

type Props = {
  state: AssistantState;
  turns: AssistantTurn[];
  /** Live transcript while listening. */
  caption: string;
  /** 0–1 mic level, used when the transcript only arrives at the end of the turn. */
  level?: number;
  error: string | null;
  onToggle: () => void;
  onSend?: (text: string) => void;
  onCollapse?: () => void;
  collapsed?: boolean;
};

export default function AssistantPanel({ state, turns, caption, level = 0, error, onToggle, onSend, onCollapse, collapsed }: Props) {
  if (collapsed) {
    return (
      <aside className="flex h-screen max-h-screen w-[62px] flex-none flex-col items-center border-l border-line bg-panel py-6">
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Expand assistant"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-line-strong font-mono text-13 text-grey-mid transition-colors hover:border-ink hover:text-ink"
        >
          ‹
        </button>
        <div className="mt-6 flex flex-col items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${state === "idle" ? "bg-grey-faint" : state === "listening" ? "bg-accent animate-pulse" : "bg-accent"}`} />
          <span className="font-mono text-[10px] tracking-tab uppercase text-grey-faint [writing-mode:vertical-lr]">Assistant</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCollapse}
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-ink text-canvas"
        >
          <span className="text-13">›</span>
        </button>
      </aside>
    );
  }
  const thread = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const voiceSupported = voiceInputSupported();
  const canSend = draft.trim().length > 0 && state !== "thinking";
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
  const needsConfirm = Boolean(
    lastAssistant && /say yes or tap confirm/i.test(lastAssistant.text) && state === "idle" && onSend,
  );

  const submit = () => {
    if (!canSend || !onSend) return;
    onSend(draft.trim());
    setDraft("");
  };

  // Keep the newest turn in view.
  useEffect(() => {
    if (thread.current) thread.current.scrollTop = thread.current.scrollHeight;
  }, [turns, state]);

  return (
    <aside className="flex h-screen max-h-screen w-[452px] flex-none flex-col overflow-hidden border-l border-line bg-panel sticky top-0">
      <div className="flex items-center justify-between border-b border-line-panel px-[34px] pb-[16px] pt-[20px]">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse assistant"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-11 text-grey-mid hover:border-ink hover:text-ink"
          >
            ›
          </button>
          <div className="font-mono text-label tracking-label uppercase text-grey">Assistant</div>
        </div>
        <div
          className={`font-mono text-meta tracking-tab uppercase ${
            state === "idle" ? "text-grey-mid" : "text-accent"
          }`}
        >
          {STATUS_LABEL[state]}
        </div>
      </div>

      <div ref={thread} className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto overscroll-contain px-[34px] py-5">
        <AnimatePresence initial={false}>
          {turns.map((turn) =>
            turn.role === "user" ? (
              <motion.div
                key={turn.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="flex flex-col items-end gap-2 pl-10"
              >
                <div className="font-mono text-micro tracking-tab uppercase text-grey-soft">You</div>
                <div className="max-w-[300px] rounded-[6px] rounded-tr-[2px] border border-line bg-done px-[15px] py-[11px] text-body leading-[1.45] text-ink [text-wrap:pretty]">
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
                className="flex flex-col gap-2 border-l-2 border-accent-line pl-[14px] pr-10"
              >
                <div className="font-mono text-micro tracking-tab uppercase text-accent">
                  Assistant
                </div>
                <div className="max-w-[316px] text-body leading-[1.5] text-ink-soft [text-wrap:pretty]">
                  {turn.text}
                </div>
              </motion.div>
            ),
          )}
        </AnimatePresence>

        {/* Sits where the reply will land, labelled like one, so a slow turn
            reads as working rather than broken. */}
        {state === "thinking" && (
          <div className="border-l-2 border-accent pl-[16px]">
            <div className="font-mono text-micro tracking-tab uppercase text-accent-deep">Assistant</div>
            <div className="mt-2 flex items-center gap-[9px]">
              <span className="flex items-center gap-[5px]">
                {[0, 0.2, 0.4].map((delay) => (
                  <span
                    key={delay}
                    className="h-[6px] w-[6px] rounded-full bg-accent"
                    style={{ animation: `vcpulse 1s ease-in-out ${delay}s infinite` }}
                  />
                ))}
              </span>
              <span className="text-lead leading-[1.4] text-grey">Thinking…</span>
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-line-panel px-[34px] pb-[20px] pt-[16px]">
        {state === "listening" && (
          <div className="mb-[18px] flex min-h-[46px] items-center text-lead leading-[1.4] text-ink [text-wrap:pretty]">
            {caption ? (
              <span>
                {caption}
                <span className="text-accent">|</span>
              </span>
            ) : (
              // No live transcript on the desktop path — show that we're hearing them.
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
            <button
              type="button"
              onClick={() => onSend?.("yes")}
              className="cursor-pointer rounded-[3px] bg-ink px-[18px] py-[9px] text-13 font-medium text-canvas hover:bg-accent"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => onSend?.("cancel")}
              className="cursor-pointer rounded-[3px] border border-line-strong px-[18px] py-[9px] font-mono text-13 text-ink-muted hover:border-ink hover:text-ink"
            >
              Cancel
            </button>
          </div>
        )}
        {!voiceSupported && state === "idle" && (
          <div className="mb-3 font-mono text-micro tracking-tab uppercase text-grey-faint">
            Voice not supported — try typing below
          </div>
        )}
        <div className="mb-4 flex items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Try typing: Dinner with Mom Thursday 7pm"
            className="flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-[9px] text-15 leading-[1.4] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className={`flex-none cursor-pointer rounded-[3px] px-[14px] py-[9px] font-mono text-13 font-medium transition-colors ${
              canSend ? "bg-ink text-canvas hover:bg-accent" : "bg-line-strong text-grey-mid cursor-not-allowed"
            }`}
          >
            Send
          </button>
        </div>
        <div className="flex items-center gap-4">
          <MicButton state={state} onToggle={onToggle} />
          <div className="font-mono text-hint leading-[1.5] text-grey">{HINT[state]}</div>
        </div>
      </div>
    </aside>
  );
}
