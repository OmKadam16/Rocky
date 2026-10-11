import type { MemorySource } from "../types";
import { memoryBridge } from "../lib/memoryClient";

type Props = {
  status: "answered" | "none" | "off" | "unavailable";
  answer: string;
  sources: MemorySource[];
  /** Phone: answered by the laptop through the relay. */
  relayed?: boolean;
  /** Shown once, under the first relayed card. */
  note?: string;
};

const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

/** A Memory answer: the short answer, then where it came from. Local only. */
export default function MemoryResultCard({ status, answer, sources, relayed, note }: Props) {
  const open = (url: string) => {
    const b = memoryBridge();
    if (b) void b.open(url);
    else window.open(url, "_blank", "noopener,noreferrer");
  };
  return (
    <div className="rounded-[4px] border border-line bg-card px-[16px] py-[14px]">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-micro tracking-tab uppercase text-grey">From your Memory</span>
        <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">{relayed ? "From your laptop" : "On this laptop"}</span>
      </div>
      <div className={`mt-[8px] text-15 leading-[1.5] ${status === "answered" ? "text-ink" : "text-ink-muted"} [text-wrap:pretty]`}>{answer}</div>
      {sources.length > 0 && (
        <ul className="mt-[12px] flex flex-col border-t border-line-panel">
          {sources.map((s) => (
            <li key={`${s.url}-${s.capturedAt}`} className="flex items-center gap-3 border-b border-line-panel py-[9px] last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="truncate text-14 font-medium text-ink-soft">{s.title}</div>
                <div className="truncate font-mono text-meta text-grey">
                  {s.domain} · {when(s.capturedAt)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => open(s.url)}
                className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-[11px] py-[5px] font-mono text-micro tracking-tab uppercase text-ink-muted hover:border-ink hover:text-ink"
              >
                Open
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <div className="mt-[10px] font-mono text-meta leading-[1.5] text-grey">{note}</div>}
    </div>
  );
}
