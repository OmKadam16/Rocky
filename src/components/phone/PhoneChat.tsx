import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { useAssistant } from "../../hooks/useAssistant";
import { useAgentView } from "../../hooks/useAgentView";
import { ensureAudioUnlocked, voiceInputSupported } from "../../lib/speech";
import { LAPTOP_ASLEEP_MESSAGE, type LaptopPresenceState } from "../../lib/devices";
import { needsConfirm as computeNeedsConfirm } from "../../lib/phoneTabs";
import MicButton from "../MicButton";
import AgentCard from "../AgentCard";
import ChatCardView from "../ChatCards";
import ChatMemoryPanel, { memoryEntryCount, useChatMemory } from "../ChatMemoryPanel";
import LaptopChip, { SettingsButton } from "./LaptopChip";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const HINT = {
  idle: "Tap the mic to talk, or type.",
  listening: "Listening… tap the mic when you're done",
  thinking: "Thinking…",
  speaking: "Speaking… tap the mic to cut in",
} as const;

type Assistant = ReturnType<typeof useAssistant>;

/**
 * Phone Chat tab: the same assistant as the Calendar tab (one useAssistant),
 * as a full thread with a composer docked above the tab bar.
 */
export default function PhoneChat({
  assistant,
  presence,
  onOpenSettings,
  keyboardOpen,
}: {
  assistant: Assistant;
  presence: LaptopPresenceState;
  onOpenSettings: () => void;
  keyboardOpen: boolean;
}) {
  const { state, turns, caption, level, error } = assistant;
  const thread = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const agent = useAgentView();
  const memory = useChatMemory();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const memoryCount = memoryEntryCount(memory);
  const agentBusy = !["idle", "done", "failed", "cancelled"].includes(agent.phase);
  const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant") ?? null;
  const confirm = computeNeedsConfirm(lastAssistant?.text ?? null, Boolean(lastAssistant?.card), state, agentBusy);
  const canSend = draft.trim().length > 0 && state !== "thinking";
  const voiceSupported = voiceInputSupported();

  const submit = () => {
    if (!canSend) return;
    void assistant.send(draft.trim(), { speak: false });
    setDraft("");
  };
  const talk = () => {
    void ensureAudioUnlocked();
    assistant.toggle();
  };

  // Newest at the bottom, always in view (also when the keyboard opens).
  useEffect(() => {
    const el = thread.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, state, agent.phase, keyboardOpen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none items-center gap-2 px-5 pb-3 pt-4">
        <div className="min-w-0 flex-1 truncate text-[22px] font-medium tracking-[-0.02em]">Rocky</div>
        <LaptopChip presence={presence} />
        <SettingsButton onClick={onOpenSettings} />
      </header>
      <div className="flex flex-none items-center gap-4 border-b border-line px-5 pb-2">
        <span className={`min-w-0 flex-1 truncate font-mono text-micro tracking-tab uppercase ${state === "idle" ? "text-grey-faint" : "text-accent"}`}>
          {state === "idle" ? "" : state === "listening" ? "Listening" : state === "thinking" ? "Thinking" : "Speaking"}
        </span>
        {memoryCount > 0 && (
          <button
            type="button"
            onClick={() => setMemoryOpen((v) => !v)}
            aria-expanded={memoryOpen}
            className={`flex h-11 cursor-pointer items-center font-mono text-micro tracking-tab uppercase hover:text-ink ${memoryOpen ? "text-ink" : "text-grey-mid"}`}
          >
            Memory · {memory.facts.length}
          </button>
        )}
        {turns.length > 0 && (
          <button
            type="button"
            onClick={() => void assistant.clearChat()}
            title="Clears the messages. Rocky keeps its memory of them."
            className="flex h-11 cursor-pointer items-center font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-ink"
          >
            Clear chat
          </button>
        )}
      </div>
      {memoryOpen && memoryCount > 0 && <ChatMemoryPanel memory={memory} pad="px-5" />}

      <div ref={thread} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-5 py-5 [-webkit-overflow-scrolling:touch]" aria-live="polite" aria-relevant="additions">
        {turns.length === 0 && state === "idle" && (
          <div className="mt-[6vh]">
            <h1 className="text-[26px] font-medium leading-[1.15] tracking-[-0.022em] [text-wrap:pretty]">What should we sort out?</h1>
            <div className="mt-4 flex flex-col gap-2 font-mono text-meta leading-[1.6] text-grey">
              <span>“Add gym tomorrow at 7 PM”</span>
              <span>“Remove everything this afternoon”</span>
              <span>“Book a haircut Saturday at 3 PM”</span>
              <span>“What did I read today about Qwen?”</span>
            </div>
          </div>
        )}
        <AnimatePresence initial={false}>
          {turns.map((turn) =>
            turn.role === "user" ? (
              <motion.div
                key={turn.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="flex justify-end pl-10"
              >
                <div className="max-w-full rounded-[6px] rounded-tr-[2px] border border-line bg-done px-[13px] py-[9px] text-15 leading-[1.45] text-ink [overflow-wrap:anywhere]">{turn.text}</div>
              </motion.div>
            ) : (
              <motion.div
                key={turn.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE }}
                className="flex min-w-0 flex-col gap-2 border-l-2 border-accent-line pl-3 pr-6"
              >
                {turn.text && <div className="text-15 leading-[1.5] text-ink-soft [overflow-wrap:anywhere] [text-wrap:pretty]">{turn.text}</div>}
                {turn.card && <ChatCardView card={turn.card} assistant={assistant} />}
              </motion.div>
            ),
          )}
        </AnimatePresence>
        {state === "thinking" && (
          <div className="flex items-center gap-[9px] border-l-2 border-accent pl-3" role="status">
            <span className="flex items-center gap-[5px]">
              {[0, 0.2, 0.4].map((delay) => (
                <span key={delay} className="h-[6px] w-[6px] rounded-full bg-accent" style={{ animation: `vcpulse 1s ease-in-out ${delay}s infinite` }} />
              ))}
            </span>
            <span className="text-15 text-grey">Thinking…</span>
          </div>
        )}
        {agent.phase !== "idle" && (
          <div className="border-l-2 border-accent-line pl-3">
            <AgentCard agent={agent} onSend={(t) => void assistant.send(t)} />
          </div>
        )}
      </div>

      <div className="flex-none border-t border-line bg-canvas px-5 pb-3 pt-3">
        {presence.status === "offline" && (
          <div role="status" className="mb-2 rounded-[3px] border border-line bg-card px-3 py-2 text-13 text-warm">
            {LAPTOP_ASLEEP_MESSAGE}
          </div>
        )}
        {state === "listening" && (
          <div className="mb-2 flex min-h-[32px] items-center text-15 leading-[1.4] text-ink">
            {caption ? (
              <span>
                {caption}
                <span className="text-accent">|</span>
              </span>
            ) : (
              <span className="flex items-end gap-[3px]" aria-label="Listening">
                {[0, 1, 2, 3, 4].map((i) => (
                  <span key={i} className="w-[3px] rounded-[2px] bg-accent transition-[height] duration-100" style={{ height: 6 + Math.round(level * 22 * (i === 2 ? 1 : i % 2 ? 0.75 : 0.5)) }} />
                ))}
              </span>
            )}
          </div>
        )}
        {error && <div className="mb-2 rounded-[3px] border border-warm-line bg-warm-soft px-3 py-2 font-mono text-meta leading-[1.5] text-ink-soft">{error}</div>}
        {confirm && (
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={() => void assistant.send("yes")} className="h-11 flex-1 cursor-pointer rounded-[3px] bg-ink text-13 font-medium text-canvas hover:bg-accent">
              Confirm
            </button>
            <button type="button" onClick={() => void assistant.send("cancel")} className="h-11 flex-1 cursor-pointer rounded-[3px] border border-line-strong font-mono text-13 text-ink-muted hover:border-ink hover:text-ink">
              Cancel
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          {voiceSupported && <MicButton state={state} onToggle={talk} />}
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message Rocky…"
            aria-label="Message Rocky"
            enterKeyHint="send"
            className="h-11 min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-3 text-[16px] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className={`h-11 flex-none cursor-pointer rounded-[3px] px-4 font-mono text-13 font-medium transition-colors ${canSend ? "bg-ink text-canvas hover:bg-accent" : "cursor-not-allowed bg-line-strong text-grey-mid"}`}
          >
            Send
          </button>
        </div>
        {!keyboardOpen && <div className="mt-1.5 font-mono text-hint leading-[1.5] text-grey">{HINT[state]}</div>}
      </div>
    </div>
  );
}
