import { useEffect, useState } from "react";
import { forgetEverything, loadMemory, onMemoryChange, removeFact, type ChatMemory } from "../lib/chatMemory";

/** What Rocky remembers across chats, live (synced laptop ⇄ phone). */
export function useChatMemory(): ChatMemory {
  const [m, setM] = useState<ChatMemory>({ facts: [], summary: "", summarizedUpTo: 0 });
  useEffect(() => {
    let live = true;
    const load = () => void loadMemory().then((x) => live && setM(x));
    load();
    const off = onMemoryChange(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return m;
}

export const memoryEntryCount = (m: ChatMemory) => m.facts.length + (m.summary.trim() ? 1 : 0);

/**
 * The "Memory · N" list: facts with forget buttons, the earlier-chats
 * summary, and Forget everything. Shared by the laptop chat and the phone.
 * `pad` is the horizontal padding class of the host layout.
 */
export default function ChatMemoryPanel({ memory, pad = "px-[48px]" }: { memory: ChatMemory; pad?: string }) {
  return (
    <div className={`border-b border-line bg-card ${pad} py-[16px]`}>
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-micro tracking-tab uppercase text-grey">What Rocky remembers · laptop and phone</span>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Forget everything Rocky remembers from your chats?")) void forgetEverything();
          }}
          className="flex-none cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid hover:text-warm"
        >
          Forget everything
        </button>
      </div>
      {memory.facts.length > 0 && (
        <ul className="mt-[10px] flex max-h-[180px] flex-col gap-[6px] overflow-y-auto overscroll-contain">
          {memory.facts.map((f) => (
            <li key={f.id} className="flex items-baseline justify-between gap-4 text-13 leading-[1.45] text-ink">
              <span>{f.text}</span>
              <button
                type="button"
                aria-label={`Forget: ${f.text}`}
                onClick={() => void removeFact(f.id)}
                className="flex-none cursor-pointer font-mono text-micro text-grey-mid hover:text-warm"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {memory.summary.trim() && (
        <p className="mt-[10px] text-13 leading-[1.5] text-grey [text-wrap:pretty]">
          <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Earlier chats · </span>
          {memory.summary}
        </p>
      )}
    </div>
  );
}
