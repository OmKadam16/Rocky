import { useEffect, useRef, useState } from "react";
import OpenAI from "openai";
import { useAssistant } from "../hooks/useAssistant";
import { useSchedule } from "../hooks/useSchedule";
import { ensureAudioUnlocked } from "../lib/speech";
import { getSecret, setSecret } from "../lib/secrets";
import { resolveModelId } from "../lib/models";
import { supabase } from "../lib/supabase";
import { todayISO } from "../lib/schedule";
import {
  readPhoneDevice,
  unpairPhone,
  updateLaptopName,
  useLaptopPresence,
} from "../lib/devices";
import { db } from "../lib/db";

/**
 * Phone home (/remote when paired). Read-only today/week of the same
 * calendar via useSchedule (live through the existing realtime fan-out),
 * fixed blocks locked (no editing here by design), laptop presence chip,
 * settings sheet and hold-to-talk running the same planner on the phone.
 */
export default function RemoteHome({ onUnpaired }: { onUnpaired: () => void }) {
  const today = todayISO();
  const [selected, setSelected] = useState(today);
  const [view, setView] = useState<"day" | "week">("day");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { day, week, now, loading, error, refresh } = useSchedule(selected);
  const presence = useLaptopPresence(true);
  const assistant = useAssistant(() => void refresh());

  const dayList = selected === today ? day.events : (week.days.find((d) => d.date === selected)?.events ?? []);
  const next = selected === today ? dayList.find((e) => e.status === "now") ?? dayList.find((e) => e.status === "upcoming") ?? null : null;

  const chip =
    presence.status === "online"
      ? { dot: "var(--color-accent)", label: "Laptop online" }
      : presence.status === "offline"
        ? { dot: "var(--color-warm)", label: "Laptop offline" }
        : { dot: "var(--color-grey-faint)", label: "Connecting…" };

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[480px] flex-col bg-canvas text-ink">
      <header className="flex items-center gap-2 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">
            {selected === today ? "Today" : selected}
          </div>
          <div className="truncate text-[22px] font-medium tracking-[-0.02em]">{day.headline || "Your day"}</div>
        </div>
        <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1.5 font-mono text-micro tracking-tab uppercase text-grey" title={`${presence.laptopName} · ${chip.label}`}>
          <span className="h-2 w-2 rounded-full" style={{ background: chip.dot }} aria-hidden />
          {chip.label}
        </span>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label="Settings"
          className="flex h-10 w-10 flex-none cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-13 text-grey-mid hover:border-ink hover:text-ink"
        >
          •••
        </button>
      </header>

      <div className="px-5 pt-3">
        <div className="grid grid-cols-2 gap-1 rounded-[3px] border border-line bg-card p-1" role="group" aria-label="Calendar view">
          {(["day", "week"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`h-9 cursor-pointer rounded-[3px] font-mono text-micro tracking-tab uppercase ${
                view === v ? "bg-ink text-canvas" : "text-grey-mid hover:text-ink"
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="px-5 pt-3">
        <div className="grid grid-cols-7 gap-1" role="group" aria-label="Week">
          {week.days.map((d) => {
            const isSel = d.date === selected;
            const isToday = d.date === today;
            return (
              <button
                key={d.date}
                type="button"
                onClick={() => setSelected(d.date)}
                aria-label={`${d.longLabel}${isToday ? ", today" : ""}`}
                aria-pressed={isSel}
                className={`flex h-[56px] cursor-pointer flex-col items-center justify-center gap-[2px] rounded-[3px] border ${
                  isSel ? "border-ink bg-ink text-canvas" : "border-line bg-card text-ink hover:border-line-strong"
                }`}
              >
                <span className="font-mono text-micro uppercase">{d.weekdayShort}</span>
                <span className="text-15 font-medium">{d.dayOfMonth}</span>
                {!isSel && isToday && <span className="h-1 w-1 rounded-full bg-accent" aria-hidden />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 px-5 pb-44 pt-4">
        {loading ? (
          <div className="font-mono text-label tracking-gap uppercase text-grey-ghost">Loading your day…</div>
        ) : error ? (
          <div>
            <div className="font-mono text-label tracking-gap uppercase text-warm">Can't reach your calendar.</div>
            <button type="button" onClick={() => void refresh()} className="mt-2 cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas">
              Retry
            </button>
          </div>
        ) : view === "day" ? (
          <div className="flex flex-col gap-3">
            {next && (
              <div className="rounded-[3px] border border-accent-line bg-accent-bg px-[15px] py-3">
                <div className="font-mono text-micro tracking-tab uppercase text-accent-deep">Next up</div>
                <div className="mt-1 text-15 font-medium">{next.title}</div>
                <div className="font-mono text-meta text-grey">
                  {next.startTime} – {next.endTime}
                </div>
              </div>
            )}
            {dayList.length === 0 ? (
              <div className="rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center font-mono text-label tracking-tab uppercase text-grey-ghost">
                Nothing on the books
              </div>
            ) : (
              dayList.map((e) => (
                <div key={e.id} className="rounded-[3px] border border-line-block bg-card px-[15px] py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0 flex-1 truncate text-15 font-medium text-ink-soft">{e.title}</div>
                    <div className="flex-none font-mono text-meta text-grey-faint">
                      {e.startTime} – {e.endTime}
                    </div>
                  </div>
                  {(e.subtext || e.note) && <div className="mt-1 truncate font-mono text-meta text-grey">{e.note ?? e.subtext}</div>}
                  {e.status === "now" && <div className="mt-1 font-mono text-micro tracking-tab uppercase text-accent">Now</div>}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {week.days.map((d) => (
              <button key={d.date} type="button" onClick={() => { setSelected(d.date); setView("day"); }} className="cursor-pointer rounded-[3px] border border-line bg-card p-3.5 text-left">
                <span className="flex items-center gap-2">
                  <span className="text-14 font-medium">{d.longLabel}</span>
                  <span className="flex-1" />
                  <span className="font-mono text-micro tracking-tab uppercase text-grey-faint">
                    {d.events.length === 0 ? "Free" : `${d.events.length} event${d.events.length === 1 ? "" : "s"}`}
                  </span>
                </span>
                {d.events.slice(0, 4).map((e) => (
                  <span key={e.id} className="mt-1.5 flex items-center gap-2 text-14">
                    <span className="tnum font-mono text-meta text-grey">{e.startTime}</span>
                    <span className="min-w-0 flex-1 truncate text-ink-soft">{e.title}</span>
                  </span>
                ))}
              </button>
            ))}
          </div>
        )}
      </div>

      <TalkDock assistant={assistant} offline={presence.status === "offline"} now={now} />

      {settingsOpen && (
        <SettingsSheet
          laptopName={presence.laptopName}
          onClose={() => setSettingsOpen(false)}
          onUnpaired={onUnpaired}
        />
      )}
    </div>
  );
}

function TalkDock({
  assistant,
  offline,
  now: _now,
}: {
  assistant: ReturnType<typeof useAssistant>;
  offline: boolean;
  now: string;
}) {
  void _now;
  const [holding, setHolding] = useState(false);
  const [draft, setDraft] = useState("");
  const holdingRef = useRefFlag(holding);

  const down = () => {
    void ensureAudioUnlocked();
    if (assistant.state !== "idle") return;
    setHolding(true);
    assistant.toggle();
  };
  const up = () => {
    if (!holdingRef.current) return;
    setHolding(false);
    if (assistant.state === "listening") assistant.toggle();
  };

  const lastReply = [...assistant.turns].reverse().find((t) => t.role === "assistant")?.text ?? null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-5">
      <div className="pointer-events-auto flex w-full max-w-[480px] flex-col items-center gap-2 px-5">
        {assistant.error && (
          <div className="w-full rounded-[3px] border border-line bg-card px-3 py-2 font-mono text-meta leading-[1.5] text-grey">{assistant.error}</div>
        )}
        {assistant.state === "listening" && (
          <div className="flex items-end gap-[3px]" aria-label="Listening">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className="w-[3px] rounded-[2px] bg-accent transition-[height] duration-100"
                style={{ height: 6 + Math.round(assistant.level * 22 * (i === 2 ? 1 : i % 2 ? 0.75 : 0.5)) }}
              />
            ))}
          </div>
        )}
        {lastReply && assistant.state !== "thinking" && (
          <div className="max-h-[120px] w-full overflow-y-auto rounded-[3px] border border-line bg-card px-3 py-2 text-14 leading-[1.5] text-ink-soft">
            {lastReply}
          </div>
        )}
        {assistant.state === "thinking" && <div className="font-mono text-micro tracking-tab uppercase text-accent">Thinking…</div>}
        <button
          type="button"
          onPointerDown={down}
          onPointerUp={up}
          onPointerLeave={up}
          onPointerCancel={up}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={assistant.state === "listening" ? "Release to send" : "Hold to talk to Rocky"}
          className={`grid h-[72px] w-[72px] cursor-pointer touch-none select-none place-items-center rounded-full text-canvas transition-colors ${
            assistant.state === "listening" ? "bg-accent" : "bg-ink hover:bg-accent"
          }`}
        >
          <span className="flex items-center gap-[3px]" aria-hidden>
            {[16, 22, 14, 20].map((h, i) => (
              <span key={i} className="w-[3px] rounded-[2px] bg-canvas" style={{ height: h }} />
            ))}
          </span>
        </button>
        <div className="font-mono text-micro tracking-tab uppercase text-grey">
          {assistant.state === "listening" ? "Release to send" : offline ? "Hold to talk · laptop offline" : "Hold to talk"}
        </div>
        <div className="flex w-full items-center gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft.trim()) {
                void assistant.send(draft.trim());
                setDraft("");
              }
            }}
            placeholder="Or type here"
            className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-2 text-14 text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          <button
            type="button"
            onClick={() => {
              if (!draft.trim()) return;
              void assistant.send(draft.trim());
              setDraft("");
            }}
            className="flex-none cursor-pointer rounded-[3px] bg-ink px-4 py-2 font-mono text-13 font-medium text-canvas"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function useRefFlag(v: boolean) {
  const r = useRef(v);
  r.current = v;
  return r;
}

function SettingsSheet({
  laptopName,
  onClose,
  onUnpaired,
}: {
  laptopName: string;
  onClose: () => void;
  onUnpaired: () => void;
}) {
  const [name, setName] = useState(laptopName);
  const [phoneName, setPhoneName] = useState("Loading…");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmKey, setLlmKey] = useState("");
  const [elKey, setElKey] = useState("");
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);
  const [testing, setTesting] = useState<"llm" | "el" | null>(null);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void readPhoneDevice()
      .then((row) => alive && setPhoneName(row?.name ?? "this phone"))
      .catch(() => alive && setPhoneName("this phone"));
    void (async () => {
      try {
        const [a, b] = await Promise.all([getSecret("llm_key"), getSecret("el_key")]);
        if (alive) setHasKeys(Boolean(a?.trim() && b?.trim()));
      } catch {
        if (alive) setHasKeys(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const saveName = async () => {
    if (!name.trim() || name.trim() === laptopName) return;
    setBusy(true);
    setError(null);
    try {
      await updateLaptopName(name);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    setBusy(true);
    setError(null);
    try {
      await unpairPhone();
      onUnpaired();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await supabase().auth.signOut();
    } catch {}
    window.location.reload();
  };

  const testKey = async (which: "llm" | "el") => {
    setTesting(which);
    setTestMsg(null);
    try {
      if (which === "llm") {
        const key = llmKey.trim();
        if (!key) throw new Error("Paste a key first.");
        const stored = ((await db.profiles.get("local"))?.model ?? "").trim();
        const client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
        await client.chat.completions.create({
          model: stored ? resolveModelId(stored) : "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 1,
        });
        setTestMsg({ ok: true, text: "Connected." });
      } else {
        const key = elKey.trim();
        if (!key) throw new Error("Paste a key first.");
        const resp = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
        if (!resp.ok) throw new Error(`ElevenLabs rejected the key (${resp.status}).`);
        setTestMsg({ ok: true, text: "Connected." });
      }
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) });
    } finally {
      setTesting(null);
    }
  };

  const saveKeys = async () => {
    if (llmKey.trim()) await setSecret("llm_key", llmKey.trim());
    if (elKey.trim()) await setSecret("el_key", elKey.trim());
    setLlmKey("");
    setElKey("");
    setHasKeys(true);
    try {
      window.dispatchEvent(new Event("vc-profile-update"));
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Settings">
      <button type="button" aria-label="Close settings" onClick={onClose} className="absolute inset-0 bg-ink/20" />
      <div className="relative flex max-h-[82vh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-t-[4px] border border-line-strong bg-panel p-5 pb-8">
        <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Settings</div>

        <label className="flex flex-col gap-[9px]">
          <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Laptop name</span>
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-2 text-15 text-ink outline-none focus:border-ink" />
            <button type="button" onClick={() => void saveName()} disabled={busy} className="flex-none cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas disabled:opacity-60">
              Save
            </button>
          </div>
        </label>

        <div className="font-mono text-[10.5px] text-grey-soft">This phone: {phoneName}</div>

        {hasKeys === false && (
          <div className="rounded-[3px] border border-line bg-card px-[15px] py-[13px]">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-grey-mid">Keys on this phone</div>
            <p className="mt-2 text-14 leading-[1.5] text-ink-muted">Add your keys on this phone in Settings. They stay on this phone.</p>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">AI key</span>
                <div className="flex items-center gap-2">
                  <input type="password" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder="Paste your API key" className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-panel px-2 py-1.5 font-mono text-12 outline-none focus:border-ink" />
                  <button type="button" onClick={() => void testKey("llm")} disabled={testing !== null} className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-2 py-1.5 font-mono text-micro uppercase text-grey-mid disabled:opacity-60">
                    {testing === "llm" ? "…" : "Test"}
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">ElevenLabs key</span>
                <div className="flex items-center gap-2">
                  <input type="password" value={elKey} onChange={(e) => setElKey(e.target.value)} placeholder="For voice" className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-panel px-2 py-1.5 font-mono text-12 outline-none focus:border-ink" />
                  <button type="button" onClick={() => void testKey("el")} disabled={testing !== null} className="flex-none cursor-pointer rounded-[3px] border border-line-strong px-2 py-1.5 font-mono text-micro uppercase text-grey-mid disabled:opacity-60">
                    {testing === "el" ? "…" : "Test"}
                  </button>
                </div>
              </label>
              {testMsg && <div className={`font-mono text-[11px] ${testMsg.ok ? "text-accent-deep" : "text-warm"}`}>{testMsg.text}</div>}
              <button type="button" onClick={() => void saveKeys()} disabled={!llmKey.trim() && !elKey.trim()} className="cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas disabled:opacity-60">
                Save keys on this phone
              </button>
            </div>
          </div>
        )}

        {error && (
          <div role="alert" className="font-mono text-[11px] text-warm">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">
            Close
          </button>
          <button type="button" onClick={() => void unpair()} disabled={busy} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-warm hover:border-ink disabled:opacity-60">
            {busy ? "Unpairing…" : "Unpair"}
          </button>
        </div>
        <button type="button" onClick={() => void signOut()} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">
          Sign out
        </button>
        <p className="text-center font-mono text-micro text-grey-faint">Signing out keeps the pairing.</p>
      </div>
    </div>
  );
}
