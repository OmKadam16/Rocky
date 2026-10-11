import { useCallback, useEffect, useState } from "react";
import MemoryResultCard from "../components/MemoryResultCard";
import { DESKTOP_ONLY, askMemory, formatBytes, memoryBridge, type MemoryAnswer, type MemoryStatus, type SavedPage } from "../lib/memoryClient";
import { MEMORY_MODEL, checkOllama, hasMemoryModel, pullModel, type OllamaStatus } from "../lib/ollama";

const RETENTION = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "Forever", days: 3650 },
] as const;

const sectionHead = "flex items-baseline justify-between border-b border-line pb-3";
const sectionLabel = "font-mono text-micro tracking-tab uppercase text-grey-faint";
const card = "rounded-[3px] border border-line bg-card px-[19px] py-[17px]";
const small = "font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid";
const chip = (on: boolean) =>
  `cursor-pointer rounded-[3px] border px-[13px] py-[6px] font-mono text-[10px] tracking-[0.14em] uppercase ${on ? "border-ink text-ink" : "border-line-strong text-grey-mid hover:border-ink hover:text-ink"}`;
const ghost = "cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-ink-muted hover:border-ink hover:text-ink";

const dayLabel = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function MemoryPage() {
  const bridge = memoryBridge();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [pull, setPull] = useState<string | null>(null);
  const [pages, setPages] = useState<SavedPage[]>([]);
  const [query, setQuery] = useState("");
  const [excludedDraft, setExcludedDraft] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<MemoryAnswer | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const s = await bridge.status();
    setStatus(s);
    setExcludedDraft((d) => d || s.settings.excluded.join("\n"));
    setPages(await bridge.list({ q: query, limit: 100 }));
  }, [bridge, query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void checkOllama().then(setOllama);
  }, []);

  const set = async (patch: Parameters<NonNullable<typeof bridge>["set"]>[0]) => {
    if (!bridge) return;
    setStatus(await bridge.set(patch));
  };

  if (!bridge) {
    return (
      <div className="flex min-w-0 flex-1 flex-col pb-10 pl-[60px] pr-14 pt-[52px]">
        <div className="font-mono text-label tracking-label uppercase text-grey">Memory</div>
        <h1 className="mt-10 max-w-[620px] text-[42px] font-medium leading-[1.08] tracking-[-0.026em]">What you read, still on this laptop.</h1>
        <div className="mt-6 inline-flex w-fit rounded-[3px] border border-line bg-panel px-3 py-2 font-mono text-micro tracking-tab uppercase text-grey-mid">{DESKTOP_ONLY}</div>
      </div>
    );
  }

  const s = status?.settings;
  const modelReady = ollama?.state === "ready" && hasMemoryModel(ollama.models);
  const stateLabel = !s ? "…" : !s.enabled ? "Off" : s.paused ? "Paused" : "On";

  return (
    <div className="flex min-w-0 flex-1 flex-col pb-10 pl-[60px] pr-14 pt-[52px]">
      <div className="font-mono text-label tracking-label uppercase text-grey">Memory</div>

      <div className="mt-10 flex items-start justify-between gap-8">
        <div className="max-w-[620px] flex-1">
          <h1 className="text-[42px] font-medium leading-[1.08] tracking-[-0.026em] [text-wrap:pretty]">
            What you read,
            <br />
            still on this laptop.
          </h1>
          <p className="mt-[18px] max-w-[500px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            Everything Memory saves stays on this laptop. Nothing is uploaded, and no cloud model ever sees it.
          </p>
        </div>
        <div className="flex flex-none flex-col items-end gap-2 self-start">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void set({ enabled: !s?.enabled, paused: false })}
              className={`cursor-pointer rounded-[3px] px-[18px] py-[10px] font-mono text-micro tracking-tab uppercase ${s?.enabled ? "bg-ink text-canvas hover:bg-accent" : "border border-line-strong text-ink-muted hover:border-ink hover:text-ink"}`}
            >
              {s?.enabled ? "Turn off" : "Turn on"}
            </button>
            {s?.enabled && (
              <button type="button" onClick={() => void set({ paused: !s.paused })} className={ghost}>
                {s.paused ? "Resume" : "Pause"}
              </button>
            )}
          </div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">
            Memory · <span className={stateLabel === "On" ? "text-accent" : ""}>{stateLabel}</span>
          </div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>What Memory does</div>
          <div className={sectionLabel}>Off by default</div>
        </div>
        <div className={`mt-[18px] ${card}`}>
          <div className="text-[16px] font-medium text-ink-soft">Saves what you read in Chrome, so you can ask about it later.</div>
          <p className="mt-2 max-w-[560px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            The Rocky Memory extension sends the text of pages you visit to this app, on this laptop only. Ask the chat “what did I read about CRISPR last week?”.
            Banking, email, health and password-manager sites, incognito windows, and pages with password or payment fields are never saved. Screenshots only when you ask for one.
          </p>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>Setup</div>
          <div className={sectionLabel}>On this laptop</div>
        </div>
        <div className="mt-[18px] flex flex-col gap-2">
          <div className={card}>
            <div className={small}>Local model</div>
            <div className="mt-2 text-[16px] font-medium text-ink-soft">Answers come from {MEMORY_MODEL} running in Ollama on this laptop.</div>
            <div className="mt-3 flex flex-wrap items-center gap-3 font-mono text-meta text-grey">
              <span>
                {ollama == null
                  ? "Checking Ollama…"
                  : ollama.state === "not-running"
                    ? "Ollama isn't running. Start it (or install it from ollama.com)."
                    : ollama.state === "cors-blocked"
                      ? "Ollama is running but blocked this app. Restart Ollama."
                      : modelReady
                        ? "Ollama is running · model ready"
                        : "Ollama is running · model not downloaded"}
              </span>
              {ollama?.state === "ready" && !modelReady && (
                <button
                  type="button"
                  className={ghost}
                  disabled={pull != null}
                  onClick={async () => {
                    setPull("Starting…");
                    try {
                      await pullModel(MEMORY_MODEL, (p) => setPull(p.total ? `${Math.round((p.done / p.total) * 100)}%` : p.status));
                    } catch (e) {
                      setNote(e instanceof Error ? e.message : String(e));
                    }
                    setPull(null);
                    setOllama(await checkOllama());
                  }}
                >
                  {pull ?? "Download model"}
                </button>
              )}
              <button type="button" className={ghost} onClick={async () => setOllama(await checkOllama())}>
                Check again
              </button>
            </div>
          </div>

          <div className={card}>
            <div className={small}>Chrome extension</div>
            <ol className="mt-3 flex list-decimal flex-col gap-1 pl-5 text-14 leading-[1.55] text-ink-muted">
              <li>
                In the Rocky folder run <code className="font-mono text-meta text-ink">npm run build:extension</code>.
              </li>
              <li>
                Open <code className="font-mono text-meta text-ink">chrome://extensions</code>, turn on Developer mode, click Load unpacked, pick <code className="font-mono text-meta text-ink">extension/dist</code>.
              </li>
              <li>Turn Memory on here, then paste the pairing token below into the extension's popup and click Connect.</li>
              <li>In the popup, click “Save pages automatically” (Chrome asks once). Without it, only “Save this page now” works.</li>
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className={small}>Pairing token</span>
              <code className="rounded-[3px] border border-line-strong bg-panel px-2 py-1 font-mono text-meta text-ink">{s ? (showToken ? s.token : "•".repeat(16)) : "…"}</code>
              <button type="button" className={ghost} onClick={() => setShowToken((v) => !v)}>
                {showToken ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className={ghost}
                onClick={async () => {
                  if (s) await navigator.clipboard.writeText(s.token).catch(() => {});
                  setNote("Token copied.");
                }}
              >
                Copy
              </button>
              <button
                type="button"
                className={ghost}
                onClick={async () => {
                  await set({ rotateToken: true });
                  setNote("New token: reconnect the extension with it.");
                }}
              >
                Rotate
              </button>
            </div>
            <div className="mt-3 font-mono text-meta text-grey">
              {status?.server.error
                ? status.server.error
                : status?.server.running
                  ? `Listening on 127.0.0.1:${status.server.port} for the extension only`
                  : "Server off (turn Memory on to connect the extension)"}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>Ask Memory</div>
          <div className={sectionLabel}>Or ask in the chat</div>
        </div>
        <div className={`mt-[18px] ${card}`}>
          <form
            className="flex items-center gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!question.trim()) return;
              setAsking(true);
              setAnswer(await askMemory(question.trim()));
              setAsking(false);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What did I read about Qwen last week?"
              className="flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-[9px] text-15 leading-[1.4] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
            />
            <button type="submit" disabled={asking} className="flex-none cursor-pointer rounded-[3px] bg-ink px-[14px] py-[9px] font-mono text-13 text-canvas hover:bg-accent disabled:opacity-60">
              {asking ? "…" : "Ask"}
            </button>
          </form>
          {answer && (
            <div className="mt-3">
              <MemoryResultCard {...answer} />
            </div>
          )}
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>Saved pages</div>
          <div className={sectionLabel}>
            {status ? `${status.stats.count} pages · ${formatBytes(status.stats.bytes)}` : "…"}
          </div>
        </div>
        <div className="mt-[18px] flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title or address"
            className="flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-[8px] text-14 text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <button
            type="button"
            className={confirmClear ? "cursor-pointer rounded-[3px] bg-warm px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-canvas" : ghost}
            onClick={async () => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              await bridge.clear();
              setConfirmClear(false);
              setNote("Everything in Memory was deleted.");
              await refresh();
            }}
            onBlur={() => setConfirmClear(false)}
          >
            {confirmClear ? "Click again to delete everything" : "Delete everything"}
          </button>
        </div>
        {pages.length === 0 ? (
          <div className="mt-2 rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center">
            <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">{query ? "No matches" : "Nothing saved yet"}</div>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col rounded-[3px] border border-line bg-card">
            {pages.map((p) => (
              <li key={p.id} className="flex items-center gap-3 border-b border-line-panel px-[15px] py-[10px] last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-14 font-medium text-ink-soft">{p.title || p.url}</div>
                  <div className="truncate font-mono text-meta text-grey">
                    {p.domain} · {dayLabel(p.capturedAt)}
                  </div>
                </div>
                <button type="button" className={ghost} onClick={() => void bridge.open(p.url)}>
                  Open
                </button>
                <button
                  type="button"
                  className={ghost}
                  onClick={async () => {
                    await bridge.remove(p.id);
                    await refresh();
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>Privacy</div>
          <div className={sectionLabel}>Stored on this laptop</div>
        </div>
        <div className="mt-[18px] flex flex-col gap-2">
          <div className={card}>
            <div className={small}>Excluded sites</div>
            <div className="mt-2 font-mono text-meta text-grey">Banking, email, health and password-manager sites are always excluded. Add more, one per line.</div>
            <textarea
              value={excludedDraft}
              onChange={(e) => setExcludedDraft(e.target.value)}
              rows={4}
              placeholder="reddit.com"
              className="mt-3 box-border w-full resize-none rounded-[3px] border border-line-strong bg-panel px-[13px] py-[11px] font-mono text-[13px] leading-[1.6] text-ink outline-none focus:border-ink"
            />
            <button
              type="button"
              className={`mt-2 ${ghost}`}
              onClick={async () => {
                await set({ excluded: excludedDraft.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) });
                setNote("Excluded sites saved.");
              }}
            >
              Save list
            </button>
          </div>
          <div className={card}>
            <div className={small}>Retention</div>
            <div className="mt-3 flex flex-wrap gap-2">
              {RETENTION.map((r) => (
                <button key={r.label} type="button" className={chip(s?.retentionDays === r.days)} onClick={() => void set({ retentionDays: r.days })}>
                  {r.label}
                </button>
              ))}
            </div>
            <div className="mt-2 font-mono text-[10.5px] text-grey-soft">
              Older pages are deleted automatically. Memory also stays under {s?.sizeCapMB ?? 200} MB, oldest first.
            </div>
          </div>
        </div>
      </div>
      {note && <div className="mt-6 max-w-[680px] font-mono text-meta text-grey">{note}</div>}
    </div>
  );
}
