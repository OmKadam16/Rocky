import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useAssistant } from "../hooks/useAssistant";
import { useTheme } from "../hooks/useTheme";
import { useVisualViewport } from "../hooks/useVisualViewport";
import ThemeToggle from "./ThemeToggle";
import { useSchedule } from "../hooks/useSchedule";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import { hasLocalAgent } from "../lib/agentClient";
import { startAgentRelayClient } from "../lib/agentRelay";
import ConnectionCheck from "./ConnectionCheck";
import { connectionProbes } from "../lib/connectionCheck";
import { defaultPhoneName } from "../lib/pairing";
import { todayISO } from "../lib/schedule";
import { initialTab, loadStoredTab, saveTab, type PhoneTab } from "../lib/phoneTabs";
import { loadPhoneMemoryAllowed, phoneMemoryAllowed, setPhoneMemoryAllowed } from "../lib/phoneMemorySetting";
import { addDays, longLabel, mondayOf, parseISODate, weekDates, WEEKDAY_SHORT } from "../../shared/datetime";
import {
  LAPTOP_ASLEEP_MESSAGE,
  readPhoneDevice,
  touchPhoneSeen,
  unpairPhone,
  updateLaptopName,
  useLaptopPresence,
} from "../lib/devices";
import PhoneTabBar from "./phone/PhoneTabBar";
import PhoneChat from "./phone/PhoneChat";
import CalendarDock from "./phone/CalendarDock";
import LaptopChip, { SettingsButton } from "./phone/LaptopChip";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/**
 * Phone home (/remote when paired): a bottom tab bar with two pages.
 *   Chat     — talking/typing with Rocky (calendar, commitments, bookings,
 *              Memory questions answered on the laptop).
 *   Calendar — today/week of the same calendar (live through the realtime
 *              fan-out), with a floating mic, a reply toast and any pending
 *              confirmation or booking run kept in view.
 * One assistant serves both tabs. Its history stays on this phone (local
 * Dexie), and private turns (Memory) are never saved.
 */
export default function RemoteHome({ onUnpaired }: { onUnpaired: () => void }) {
  const today = todayISO();
  const [selected, setSelected] = useState(today);
  const [view, setView] = useState<"day" | "week">("day");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTabState] = useState<PhoneTab>(() => initialTab(typeof window !== "undefined" ? window.location.search : "", loadStoredTab()));
  const setTab = (t: PhoneTab) => {
    setTabState(t);
    saveTab(t);
  };
  const viewport = useVisualViewport();
  // Applies the saved light/dark theme on the phone from the first paint.
  useTheme();
  const { day, week, now, loading, error, refresh } = useSchedule(selected);
  void now;

  // One-week row, swipeable across weeks: 26 weeks back and forward, each a
  // snap page. Same cells as before — swipe right for next week, left for
  // the previous one.
  const stripWeeks = useMemo(() => {
    const start = mondayOf(addDays(today, -7 * STRIP_WEEKS_BACK));
    return Array.from({ length: STRIP_WEEKS_BACK + 1 + STRIP_WEEKS_FWD }, (_, i) =>
      weekDates(addDays(start, i * 7)),
    );
  }, [today]);
  const stripRef = useRef<HTMLDivElement>(null);
  const selectedWeekIdx = stripWeeks.findIndex((w) => w.includes(selected));

  // Start on this week; follow the selection when a tapped day sits in an
  // adjacent week. (The strip remounts when the Calendar tab comes back.)
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    el.scrollLeft = (selectedWeekIdx >= 0 ? selectedWeekIdx : STRIP_WEEKS_BACK) * el.clientWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  useEffect(() => {
    const el = stripRef.current;
    if (!el || selectedWeekIdx < 0) return;
    el.scrollTo({ left: selectedWeekIdx * el.clientWidth, behavior: "smooth" });
  }, [selectedWeekIdx]);
  const presence = useLaptopPresence(true);
  const [probes] = useState(() => connectionProbes(defaultPhoneName()));
  // The laptop's Devices section shows when this phone was last seen.
  useEffect(() => {
    void touchPhoneSeen();
    const id = window.setInterval(() => void touchPhoneSeen(), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const assistant = useAssistant(() => void refresh(), { persist: true, keepPrivate: false });
  // Phone: the booking agent runs on the laptop; this relays to it.
  useEffect(() => {
    if (!isSupabaseConfigured || hasLocalAgent()) return;
    return startAgentRelayClient();
  }, []);

  const dayList = selected === today ? day.events : (week.days.find((d) => d.date === selected)?.events ?? []);
  const next = selected === today ? dayList.find((e) => e.status === "now") ?? dayList.find((e) => e.status === "upcoming") ?? null : null;

  // The shell is the visible viewport: with the keyboard up the composer
  // stays above it and the tab bar steps aside.
  const shellStyle = viewport.height ? { height: viewport.height, top: viewport.top } : undefined;

  return (
    <div className="fixed inset-x-0 top-0 mx-auto flex h-dvh w-full max-w-[480px] flex-col overflow-hidden bg-canvas text-ink" style={shellStyle}>
      <AnimatePresence mode="wait" initial={false}>
        {tab === "calendar" ? (
          <motion.div
            key="calendar"
            id="phone-panel-calendar"
            role="tabpanel"
            aria-labelledby="phone-tab-calendar"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="relative flex min-h-0 flex-1 flex-col"
          >
          <header className="flex flex-none items-center gap-2 px-5 pt-4">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10.5px] tracking-label uppercase text-grey-mid">
                {selected === today ? "Today" : selected}
              </div>
              <div className="truncate text-[22px] font-medium tracking-[-0.02em]">{day.headline || "Your day"}</div>
            </div>
            <LaptopChip presence={presence} />
            <SettingsButton onClick={() => setSettingsOpen(true)} />
          </header>

          <div className="flex-none px-5 pt-3">
            <div className="grid grid-cols-2 gap-1 rounded-[3px] border border-line bg-card p-1" role="group" aria-label="Calendar view">
              {(["day", "week"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={`relative h-9 cursor-pointer rounded-[3px] font-mono text-micro tracking-tab uppercase ${
                    view === v ? "text-canvas" : "text-grey-mid hover:text-ink"
                  }`}
                >
                  {view === v && (
                    <motion.span
                      layoutId="phone-view-tab"
                      className="absolute inset-0 rounded-[3px] bg-ink"
                      transition={{ duration: 0.22, ease: EASE }}
                    />
                  )}
                  <span className="relative">{v}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="flex-none px-5 pt-3">
            <div
              ref={stripRef}
              className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              role="group"
              aria-label="Weeks — swipe left or right for more weeks"
            >
              {stripWeeks.map((days) => (
                <div key={days[0]} className="grid w-full flex-none snap-start grid-cols-7 gap-1">
                  {days.map((date) => {
                    const d = parseISODate(date);
                    const isSel = date === selected;
                    const isToday = date === today;
                    return (
                      <button
                        key={date}
                        type="button"
                        onClick={() => setSelected(date)}
                        aria-label={`${longLabel(date)}${isToday ? ", today" : ""}`}
                        aria-pressed={isSel}
                        className={`relative flex h-[56px] cursor-pointer flex-col items-center justify-center gap-[2px] rounded-[3px] border ${
                          isSel ? "border-ink text-canvas" : "border-line bg-card text-ink hover:border-line-strong"
                        }`}
                      >
                        {isSel && (
                          <motion.span
                            layoutId="phone-day"
                            className="absolute inset-0 rounded-[3px] bg-ink"
                            transition={{ duration: 0.22, ease: EASE }}
                          />
                        )}
                        <span className="relative font-mono text-micro uppercase">{WEEKDAY_SHORT[d.getDay()]}</span>
                        <span className="relative text-15 font-medium">{d.getDate()}</span>
                        {!isSel && isToday && <span className="relative h-1 w-1 rounded-full bg-accent" aria-hidden />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 touch-pan-y overscroll-contain overflow-y-auto px-5 pb-28 pt-4 [-webkit-overflow-scrolling:touch]">
            <div className="mb-3 flex flex-col gap-2">
              {presence.status === "offline" && (
                <div role="status" className="rounded-[3px] border border-line bg-card px-3 py-2 text-13 text-warm">
                  {LAPTOP_ASLEEP_MESSAGE}
                </div>
              )}
              {/* Runs once when the home opens; opens itself only on a problem. */}
              <ConnectionCheck probes={probes} runKey={1} />
            </div>
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
            <CalendarDock assistant={assistant} onOpenChat={() => setTab("chat")} />
          </motion.div>
        ) : (
          <motion.div
            key="chat"
            id="phone-panel-chat"
            role="tabpanel"
            aria-labelledby="phone-tab-chat"
            initial={{ opacity: 0, x: -12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <PhoneChat assistant={assistant} presence={presence} onOpenSettings={() => setSettingsOpen(true)} keyboardOpen={viewport.keyboardOpen} />
          </motion.div>
        )}
      </AnimatePresence>

      {!viewport.keyboardOpen && <PhoneTabBar tab={tab} onChange={setTab} />}

      <AnimatePresence>
        {settingsOpen && (
          <SettingsSheet
            laptopName={presence.laptopName}
            onClose={() => setSettingsOpen(false)}
            onUnpaired={onUnpaired}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/** Weeks rendered each side of this week in the swipeable strip. */
const STRIP_WEEKS_BACK = 26;
const STRIP_WEEKS_FWD = 26;

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

  useEffect(() => {
    let alive = true;
    void readPhoneDevice()
      .then((row) => alive && setPhoneName(row?.name ?? "this phone"))
      .catch(() => alive && setPhoneName("this phone"));
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

  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center" role="dialog" aria-modal="true" aria-label="Settings">
      <motion.button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: EASE }}
        className="absolute inset-0 bg-ink/20"
      />
      <motion.div
        initial={{ y: 48 }}
        animate={{ y: 0 }}
        exit={{ y: 48, opacity: 0.5 }}
        transition={{ type: "spring", stiffness: 320, damping: 32 }}
        drag="y"
        dragConstraints={{ top: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 120) onClose();
        }}
        className="relative flex max-h-[82vh] w-full max-w-[480px] flex-col gap-4 overflow-y-auto rounded-t-[4px] border border-line-strong bg-panel p-5 pb-[calc(2rem+env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center justify-between">
          <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">Settings</div>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>

        <label className="flex flex-col gap-[9px]">
          <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Laptop name</span>
          <div className="flex items-center gap-2">
            <input value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} className="min-w-0 flex-1 rounded-[3px] border border-line-strong bg-card px-3 py-2 text-15 text-ink outline-none focus:border-ink" />
            <motion.button
              type="button"
              onClick={() => void saveName()}
              disabled={busy}
              whileTap={{ scale: 0.98 }}
              className="flex-none cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas disabled:opacity-60"
            >
              Save
            </motion.button>
          </div>
        </label>

        <div className="font-mono text-[10.5px] text-grey-soft">This phone: {phoneName}</div>

        <div className="font-mono text-[10.5px] text-grey-soft">Talk uses your account’s keys — the same ones as your laptop.</div>

        <PhoneMemoryToggle />

        {error && (
          <div role="alert" className="font-mono text-[11px] text-warm">
            {error}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">
            Close
          </button>
          <motion.button
            type="button"
            onClick={() => void unpair()}
            disabled={busy}
            whileTap={{ scale: 0.98 }}
            className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-warm hover:border-ink disabled:opacity-60"
          >
            {busy ? "Unpairing…" : "Unpair"}
          </motion.button>
        </div>
        <button type="button" onClick={() => void signOut()} className="cursor-pointer rounded-[3px] border border-line-strong px-4 py-2.5 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">
          Sign out
        </button>
        <p className="text-center font-mono text-micro text-grey-faint">Signing out keeps the pairing.</p>
      </motion.div>
    </div>
  );
}

/** "Allow Memory questions from my phone" (same switch as the laptop's Profile → Devices). */
function PhoneMemoryToggle() {
  const [on, setOn] = useState(() => phoneMemoryAllowed());
  useEffect(() => {
    void loadPhoneMemoryAllowed().then(setOn);
  }, []);
  return (
    <div className="flex flex-col gap-[9px]">
      <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">Allow Memory questions from my phone</span>
      <div className="flex gap-2" role="group" aria-label="Allow Memory questions from my phone">
        {[true, false].map((v) => (
          <button
            key={String(v)}
            type="button"
            aria-pressed={on === v}
            onClick={() => {
              setOn(v);
              void setPhoneMemoryAllowed(v).catch(() => {});
            }}
            className={`h-11 flex-1 cursor-pointer rounded-[3px] border font-mono text-micro tracking-tab uppercase ${on === v ? "border-ink text-ink" : "border-line-strong text-grey-mid hover:border-ink hover:text-ink"}`}
          >
            {v ? "On" : "Off"}
          </button>
        ))}
      </div>
      <span className="font-mono text-[10.5px] leading-[1.5] text-grey-soft">
        Questions like “what did I read today about…” are answered by Rocky on your laptop. Each one goes through your account for a moment, then is deleted.
      </span>
    </div>
  );
}
