import { useCallback, useEffect, useState } from "react";
import MemoryResultCard from "../components/MemoryResultCard";
import { DESKTOP_ONLY, askMemory, formatBytes, memoryBridge, type MemoryAnswer, type MemoryItem, type MemoryMonth, type MemoryStatus } from "../lib/memoryClient";
import { EMBED_MODEL, MEMORY_MODEL, checkOllama, hasMemoryModel, pullModel, type OllamaStatus } from "../lib/ollama";

const sectionHead = "flex items-baseline justify-between border-b border-line pb-3";
const sectionLabel = "font-mono text-micro tracking-tab uppercase text-grey-faint";
const card = "rounded-[3px] border border-line bg-card px-[19px] py-[17px]";
const small = "font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid";
const chip = (on: boolean) =>
  `cursor-pointer rounded-[3px] border px-[13px] py-[6px] font-mono text-[10px] tracking-[0.14em] uppercase ${on ? "border-ink text-ink" : "border-line-strong text-grey-mid hover:border-ink hover:text-ink"}`;
const ghost = "cursor-pointer rounded-[3px] border border-line-strong px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-ink-muted hover:border-ink hover:text-ink";

const dayLabel = (ms: number) => new Date(ms).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dateLabel = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthLabel = (key: string) => {
  if (/^\d{4}$/.test(key)) return key;
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
};
const TIER_LABEL = ["Detail", "Monthly summary", "Month overview", "Year overview"];
const debugOn = () => {
  try {
    return localStorage.getItem("vc-debug") === "1";
  } catch {
    return false;
  }
};

/** One memory: title, gist, kept highlights, sources, Pin / Delete. */
function MemoryRow({ m, onOpen, onPin, onDelete }: { m: MemoryItem; onOpen: (url: string) => void; onPin: () => void; onDelete: () => void }) {
  const links = m.tier === 0 ? m.urls.map((u) => ({ title: u.title, url: u.url })) : m.sources.map((x) => ({ title: x.title, url: x.url }));
  return (
    <li className="border-b border-line-panel px-[15px] py-[12px] last:border-b-0">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-14 font-medium text-ink-soft [text-wrap:pretty]">
            {m.pinned && <span className="mr-2 font-mono text-micro tracking-tab uppercase text-accent">Pinned</span>}
            {m.title}
          </div>
          <div className="mt-1 font-mono text-meta text-grey">
            {TIER_LABEL[m.tier] ?? "Memory"} · {m.tier === 0 ? dayLabel(m.lastSeen) : `${dateLabel(m.firstSeen)} – ${dateLabel(m.lastSeen)}`}
            {m.domains.length > 0 && ` · ${m.domains.slice(0, 3).join(", ")}`}
            {m.tier === 0 && m.visits > 1 && ` · ${m.visits} visits`}
            {m.minutes > 0 && ` · ${m.minutes} min`}
            {m.entries ? ` · from ${m.entries} entries` : ""}
          </div>
          <p className="mt-2 whitespace-pre-line text-14 leading-[1.55] text-ink-muted [text-wrap:pretty]">{m.gist}</p>
          {m.paper && (m.paper.doi || m.paper.arxiv || m.paper.venue) && (
            <div className="mt-1 font-mono text-meta text-grey">
              {[m.paper.authors.slice(0, 3).join(", "), m.paper.venue, m.paper.year, m.paper.doi ? `doi:${m.paper.doi}` : "", m.paper.arxiv ? `arXiv:${m.paper.arxiv}` : ""].filter(Boolean).join(" · ")}
            </div>
          )}
          {m.highlights.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {m.highlights.map((h) => (
                <div key={`${h.url}-${h.date}`} className="text-13 leading-[1.5] text-ink-muted">
                  <span className="font-mono text-micro tracking-tab uppercase text-grey">Kept · </span>
                  <span className="font-medium text-ink-soft">{h.title}</span>: {h.gist}
                </div>
              ))}
            </div>
          )}
          {links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
              {links.slice(0, 6).map((l) => (
                <button key={l.url} type="button" onClick={() => onOpen(l.url)} className="max-w-[280px] cursor-pointer truncate font-mono text-meta text-grey underline-offset-2 hover:text-ink hover:underline">
                  {l.title || l.url}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-none gap-2">
          <button type="button" className={ghost} onClick={onPin}>
            {m.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" className={ghost} onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

export default function MemoryPage() {
  const bridge = memoryBridge();
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [pull, setPull] = useState<string | null>(null);
  const [embedPull, setEmbedPull] = useState<string | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [months, setMonths] = useState<MemoryMonth[]>([]);
  const [month, setMonth] = useState<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [confirmMonth, setConfirmMonth] = useState(false);
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
    const ms = await bridge.months();
    setMonths(ms);
    const pick = month && ms.some((x) => x.month === month) ? month : (ms[0]?.month ?? null);
    if (pick !== month) setMonth(pick);
    setItems(pick ? await bridge.list({ q: query, month: pick, limit: 200 }) : []);
  }, [bridge, query, month]);

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
  const embedReady = ollama?.state === "ready" && hasMemoryModel(ollama.models, EMBED_MODEL);
  const st = status?.stats;
  const last = status?.lastCompaction;
  const sortedItems = [...items].sort((a, b) => b.tier - a.tier || Number(b.pinned) - Number(a.pinned) || b.lastSeen - a.lastSeen);
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
          <div className="text-[16px] font-medium text-ink-soft">Remembers the gist of what you read in Chrome, so you can ask about it later.</div>
          <p className="mt-2 max-w-[560px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            The Rocky Memory extension sends the text of pages you visit to this app. A local model turns each page into a short summary, then the page text is deleted (always within a day).
            Ask the chat “what did I read about CRISPR last week?”. Banking, email, health and password-manager sites, incognito windows, and pages with password or payment fields are never saved.
            A thumbnail only when you ask for one with “Save this page”.
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
            <div className="mt-4 border-t border-line-panel pt-3">
              <div className={small}>Search model</div>
              <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-meta text-grey">
                <span>
                  {ollama?.state !== "ready"
                    ? `${EMBED_MODEL} needs Ollama.`
                    : embedReady
                      ? `${EMBED_MODEL} ready · search by meaning`
                      : `${EMBED_MODEL} not downloaded · search uses keywords only until it is`}
                </span>
                {ollama?.state === "ready" && !embedReady && (
                  <button
                    type="button"
                    className={ghost}
                    disabled={embedPull != null}
                    onClick={async () => {
                      setEmbedPull("Starting…");
                      try {
                        await pullModel(EMBED_MODEL, (p) => setEmbedPull(p.total ? `${Math.round((p.done / p.total) * 100)}%` : p.status));
                      } catch (e) {
                        setNote(e instanceof Error ? e.message : String(e));
                      }
                      setEmbedPull(null);
                      setOllama(await checkOllama());
                    }}
                  >
                    {embedPull ?? "Download search model"}
                  </button>
                )}
              </div>
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
          <div className={sectionLabel}>How Memory keeps things</div>
          <div className={sectionLabel}>{st ? `${formatBytes(st.bytesByPart.live)} used` : "…"}</div>
        </div>
        <div className={`mt-[18px] ${card}`}>
          <div className="text-[16px] font-medium text-ink-soft">This month is kept in detail. Each finished month is shortened once into a summary.</div>
          <p className="mt-2 max-w-[560px] text-14 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            On the 1st, last month's entries are grouped by topic and the local model writes a short summary of each, keeping the top sources. Pinned and important pages are kept in full inside the summary.
            A summarised month then stays as it is. For 7 days you can undo it.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 font-mono text-meta text-grey">
            <span>This month, in detail: {st ? st.tiers.detail : "…"}</span>
            <span>Monthly summaries: {st ? st.tiers.digests : "…"}</span>
            <span>Overviews: {st ? st.tiers.overviews : "…"}</span>
            <span>
              Waiting to be summarised: {st ? st.queue : "…"}
              {st && st.dropped > 0 ? ` (${st.dropped} dropped, queue was full)` : ""}
            </span>
            <span>
              Storage: {st ? formatBytes(st.bytesByPart.live) : "…"} of {s?.sizeCapMB ?? 500} MB
              {st && st.bytesByPart.backups > 0 ? ` (+${formatBytes(st.bytesByPart.backups)} undo copies)` : ""}
            </span>
            <span>Search: {status?.search === "hybrid" ? "by meaning + keywords" : "keywords only"}</span>
            <span className="col-span-2">
              Last summary:{" "}
              {last ? `${monthLabel(last.month)}: ${last.entries} entries → ${last.digests} summaries (${formatBytes(last.bytesBefore)} → ${formatBytes(last.bytesAfter)}), ${dateLabel(last.at)}` : "none yet"}
            </span>
            <span className="col-span-2">Next: {status ? dateLabel(status.nextCompaction) : "…"}</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={ghost}
              disabled={compacting || !s?.enabled}
              onClick={async () => {
                setCompacting(true);
                const r = await bridge.compactNow();
                setCompacting(false);
                const done = (r.results ?? []).filter((x) => x.entries > 0);
                setNote(
                  r.off
                    ? "Turn Memory on first."
                    : r.busy
                      ? "Busy right now (a chat turn or a run). Try again in a moment."
                      : done.length
                        ? done.map((x) => `${monthLabel(x.month)}: ${x.entries} entries → ${x.digests} summaries${x.status === "done" ? "" : " (some groups failed, kept as they were; retried next run)"}`).join(" · ")
                        : "Nothing to summarise: only this month has entries.",
                );
                await refresh();
              }}
            >
              {compacting ? "Summarising…" : "Compact now"}
            </button>
            {(status?.undoable ?? []).map((m) => (
              <button
                key={m}
                type="button"
                className={ghost}
                onClick={async () => {
                  const r = await bridge.undo(m);
                  setNote(r.ok ? `${monthLabel(m)} is back in detail. It won't be summarised again until you press Compact now.` : "That undo has expired.");
                  await refresh();
                }}
              >
                Undo {monthLabel(m)}
              </button>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className={small}>Keep shrinking older months</span>
            <button type="button" className={chip(s?.keepShrinking === true)} onClick={() => void set({ keepShrinking: true })}>
              On
            </button>
            <button type="button" className={chip(s?.keepShrinking !== true)} onClick={() => void set({ keepShrinking: false })}>
              Off
            </button>
          </div>
          <div className="mt-2 font-mono text-[10.5px] text-grey-soft">On: summaries older than 12 months fold into one overview per year. Over {s?.sizeCapMB ?? 500} MB, the oldest unsummarised month is summarised first, then the oldest unimportant summaries go.</div>
          {debugOn() && status && (
            <div className="mt-2 font-mono text-micro text-grey-faint">
              gist {status.timings.gist_ms ?? "–"}ms · embed {status.timings.embed_ms ?? "–"}ms · compaction {status.timings.compaction_ms ?? "–"}ms
            </div>
          )}
        </div>
      </div>

      <div className="mt-10 max-w-[680px]">
        <div className={sectionHead}>
          <div className={sectionLabel}>Browse</div>
          <div className={sectionLabel}>{st ? `${st.count} memories · ${formatBytes(st.bytes)}` : "…"}</div>
        </div>
        {months.length > 0 && (
          <div className="mt-[18px] flex flex-wrap gap-2">
            {months.map((m) => (
              <button key={m.month} type="button" className={chip(month === m.month)} onClick={() => setMonth(m.month)}>
                {monthLabel(m.month)}
                {m.current ? " · this month" : m.compaction?.status === "done" ? " · summary" : ""}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by title, topic or site"
            className="flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-[8px] text-14 text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          {month && (
            <button
              type="button"
              className={confirmMonth ? "cursor-pointer rounded-[3px] bg-warm px-3 py-1.5 font-mono text-micro tracking-tab uppercase text-canvas" : ghost}
              onClick={async () => {
                if (!confirmMonth) {
                  setConfirmMonth(true);
                  return;
                }
                await bridge.removeMonth(month);
                setConfirmMonth(false);
                setNote(`${monthLabel(month)} was deleted.`);
                setMonth(null);
                await refresh();
              }}
              onBlur={() => setConfirmMonth(false)}
            >
              {confirmMonth ? "Click again" : "Delete this month"}
            </button>
          )}
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
        {sortedItems.length === 0 ? (
          <div className="mt-2 rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center">
            <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">{query ? "No matches" : st && st.queue > 0 ? "Pages are waiting to be summarised" : "Nothing saved yet"}</div>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col rounded-[3px] border border-line bg-card">
            {sortedItems.map((m) => (
              <MemoryRow
                key={m.id}
                m={m}
                onOpen={(url) => void bridge.open(url)}
                onPin={async () => {
                  await bridge.pin(m.id, !m.pinned);
                  await refresh();
                }}
                onDelete={async () => {
                  await bridge.remove(m.id);
                  await refresh();
                }}
              />
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
        </div>
      </div>
      {note && <div className="mt-6 max-w-[680px] font-mono text-meta text-grey">{note}</div>}
    </div>
  );
}
