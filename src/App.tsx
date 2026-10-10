import { useEffect, useState } from "react";
import AddBlockModal from "./components/AddBlockModal";
import AppHeader from "./components/AppHeader";
import AssistantPanel from "./components/AssistantPanel";
import DayView from "./components/DayView";
import MonthView from "./components/MonthView";
import Onboarding from "./components/Onboarding";
import SearchView from "./components/SearchView";
import Sidebar from "./components/Sidebar";
import WeekView from "./components/WeekView";
import AssignmentsPage from "./pages/AssignmentsPage";
import DashboardPage from "./pages/DashboardPage";
import FixedCommitmentsPage from "./pages/FixedCommitmentsPage";
import MemoryPage from "./pages/MemoryPage";
import ProfilePage from "./pages/ProfilePage";
import TasksPage from "./pages/TasksPage";
import { useAssignments } from "./hooks/useAssignments";
import { ASSIGNMENTS_ENABLED } from "./lib/features";
import { useAssistant } from "./hooks/useAssistant";
import { useAuth } from "./hooks/useAuth";
import { useFixedCommitments } from "./hooks/useFixedCommitments";
import { useProfile } from "./hooks/useProfile";
import { useSchedule } from "./hooks/useSchedule";
import { useTheme } from "./hooks/useTheme";
import { useLaptopHeartbeat } from "./lib/devices";
import { isSupabaseConfigured } from "./lib/supabase";
import { db } from "./lib/db";
import { toISODate } from "../shared/datetime";
import type { PageName, ViewName } from "./types";

export default function App() {
  const [page, setPage] = useState<PageName>("dashboard");
  const [navOpen, setNavOpen] = useState(true);
  const [view, setView] = useState<ViewName>("day");
  const [calendarOffset, setCalendarOffset] = useState(0);
  const [showAddBlock, setShowAddBlock] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try { return localStorage.getItem("vc-assistant-open") === "1"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("vc-assistant-open", assistantOpen ? "1" : "0"); } catch {}
  }, [assistantOpen]);
  const { user, loading: authLoading, token } = useAuth();
  const { data: profileData, refresh: refreshProfile } = useProfile(token);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [displayName, setDisplayName] = useState(() => {
    try { return localStorage.getItem("vc-user-name") || "Kai Mercer"; } catch { return "Kai Mercer"; }
  });

  useEffect(() => {
    const compute = () => {
      const backend = profileData?.profile.display_name;
      let ls: string | null = null;
      try { ls = localStorage.getItem("vc-user-name"); } catch {}
      const meta = (user as unknown as { user_metadata?: { display_name?: string } })?.user_metadata?.display_name;
      const next = (backend && backend.trim()) || (ls && ls.trim()) || (meta && meta.trim()) || "Kai Mercer";
      setDisplayName(next);
    };
    compute();
    const onUpdate = () => { compute(); void refreshProfile(); };
    window.addEventListener("storage", onUpdate);
    window.addEventListener("vc-profile-update", onUpdate);
    const id = window.setInterval(compute, 600);
    return () => { window.removeEventListener("storage", onUpdate); window.removeEventListener("vc-profile-update", onUpdate); window.clearInterval(id); };
  }, [profileData, user, refreshProfile]);

  useEffect(() => {
    setCalendarOffset(0);
    const scroller = document.getElementById("main-scroll");
    if (scroller) scroller.scrollTo({ top: 0, behavior: "smooth" });
    const scroller2 = document.getElementById("main-scroll-assignments");
    if (scroller2) scroller2.scrollTop = 0;
    const scroller3 = document.getElementById("main-scroll-memory");
    if (scroller3) scroller3.scrollTop = 0;
    const scroller4 = document.getElementById("main-scroll-tasks");
    if (scroller4) scroller4.scrollTop = 0;
  }, [view, page]);

  const calendarDate = (() => {
    const base = new Date();
    if (page !== "calendar") return toISODate(base);
    if (view === "day") base.setDate(base.getDate() + calendarOffset);
    else if (view === "week") base.setDate(base.getDate() + calendarOffset * 7);
    else if (view === "month") base.setMonth(base.getMonth() + calendarOffset);
    return toISODate(base);
  })();

  useEffect(() => {
    if (authLoading) return;
    if (!user) { setShowOnboarding(true); return; }
    if (profileData) { setShowOnboarding(!profileData.profile.onboarding_done); return; }
    const legacy = typeof window !== "undefined" ? localStorage.getItem("vc-onb-done") : null;
    setShowOnboarding(legacy !== "1");
  }, [user, authLoading, profileData]);
  const {
    commitments,
    add: addCommitment,
    update: updateCommitment,
    remove: removeCommitment,
    refresh: refreshCommitments,
    error: fixedError,
  } = useFixedCommitments();
  const { assignments, add: addAssignment, update: updateAssignment, remove: removeAssignment, refresh: refreshAssignments, setStatus: setTaskStatus } = useAssignments() as any;

  const { day, week, now, loading, error, refresh } = useSchedule(calendarDate);
  // Laptop presence heartbeat (every 15 s while open) for the phone's online chip.
  useLaptopHeartbeat(isSupabaseConfigured && !authLoading && !!user);
  const { theme, toggle: toggleTheme } = useTheme();
  const assistant = useAssistant(() => {
    void refresh();
    void refreshAssignments();
    void refreshCommitments();
  });

  return (
    <div className="relative flex h-screen overflow-hidden bg-canvas text-ink">
      {showOnboarding && (
        <Onboarding
          onDone={(next) => {
            setShowOnboarding(false);
            setPage(next);
          }}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
      )}
      <Sidebar
        page={page}
        onNavigate={(next) => {
          if (next === "assignments" && !ASSIGNMENTS_ENABLED) return;
          setPage(next);
        }}
        open={navOpen}
        onToggle={() => setNavOpen((open) => !open)}
        fixedCount={commitments.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        displayName={displayName}
      />

      {page === "fixed" ? (
        <FixedCommitmentsPage
          commitments={commitments}
          fixedError={fixedError}
          onAdd={async (commitment) => {
            try {
              await addCommitment(commitment);
              await refresh();
            } catch (e) {
              console.error(e);
            }
          }}
          onUpdate={async (commitment) => {
            try {
              await updateCommitment(commitment);
              await refresh();
            } catch (e) {
              console.error(e);
            }
          }}
          onRemove={async (id) => {
            try {
              await removeCommitment(id);
              await refresh();
            } catch (e) {
              console.error(e);
            }
          }}
        />
      ) : page === "assignments" && ASSIGNMENTS_ENABLED ? (
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main id="main-scroll-assignments" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth">
            <AssignmentsPage
              assignments={assignments}
              onAdd={async (a) => {
                try {
                  await addAssignment(a as unknown as never);
                  await refresh();
                  await refreshAssignments();
                } catch (e) {
                  console.error(e);
                }
              }}
              onUpdate={async (a) => {
                try {
                  await updateAssignment(a);
                  await refresh();
                  await refreshAssignments();
                } catch (e) {
                  console.error(e);
                }
              }}
              onRemove={async (id) => {
                try {
                  await removeAssignment(id);
                  await refresh();
                  await refreshAssignments();
                } catch (e) {
                  console.error(e);
                }
              }}
            />
          </main>
          <AssistantPanel
            collapsed={!assistantOpen}
            onCollapse={() => setAssistantOpen((v) => !v)}
            state={assistant.state}
            turns={assistant.turns}
            caption={assistant.caption}
            level={assistant.level}
            error={assistant.error}
            onToggle={assistant.toggle}
            onSend={assistant.send}
          />
        </div>
      ) : page === "tasks" ? (
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main id="main-scroll-tasks" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth">
            <TasksPage
              assignments={assignments}
              onAdd={async (a) => {
                try { await addAssignment(a as unknown as never); await refresh(); await refreshAssignments(); } catch (e) { console.error(e); }
              }}
              onUpdate={async (a) => {
                try { await updateAssignment(a); await refresh(); await refreshAssignments(); } catch (e) { console.error(e); }
              }}
              onRemove={async (id) => {
                try { await removeAssignment(id); await refresh(); await refreshAssignments(); } catch (e) { console.error(e); }
              }}
              onSetStatus={async (id, status) => { await setTaskStatus(id, status); await refreshAssignments(); await refresh(); }}
            />
          </main>
          <AssistantPanel collapsed={!assistantOpen} onCollapse={() => setAssistantOpen((v) => !v)} state={assistant.state} turns={assistant.turns} caption={assistant.caption} level={assistant.level} error={assistant.error} onToggle={assistant.toggle} onSend={assistant.send} />
        </div>
      ) : page === "dashboard" ? (
        <main id="main-scroll-dashboard" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth pb-10 pl-16 pr-[60px] pt-[52px]">
          {error ? (
            <div className="mt-11 max-w-[620px]">
              <h1 className="text-display font-medium tracking-[-0.028em]">Can't reach your calendar.</h1>
              <p className="mt-6 font-mono text-label tracking-gap uppercase text-grey">{error}</p>
            </div>
          ) : loading ? (
            <div className="mt-11 font-mono text-label tracking-gap uppercase text-grey-ghost">Loading your day…</div>
          ) : (
            <DashboardPage day={day} now={now} assignments={assignments} commitments={commitments} assistantState={assistant.state} onOrbToggle={assistant.toggleConversation} caption={assistant.caption} />
          )}
        </main>
      ) : page === "profile" ? (
        <ProfilePage />
      ) : page === "memory" ? (
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main id="main-scroll-memory" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth">
            <MemoryPage />
          </main>
          <AssistantPanel collapsed={!assistantOpen} onCollapse={() => setAssistantOpen((v) => !v)} state={assistant.state} turns={assistant.turns} caption={assistant.caption} level={assistant.level} error={assistant.error} onToggle={assistant.toggle} onSend={assistant.send} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 overflow-hidden">
          <main id="main-scroll" className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain scroll-smooth pb-10 pl-16 pr-[60px] pt-[52px]">
            {view === "month" ? (
              <>
                <div className="flex items-center justify-between gap-4">
                  <AppHeader
                    dateLabel={`${new Date(calendarDate).toLocaleString("en-US", { month: "short" }).toUpperCase()} · ${new Date(calendarDate).getFullYear()}`}
                    onPrev={() => setCalendarOffset((o) => o - 1)}
                    onNext={() => setCalendarOffset((o) => o + 1)}
                    onToday={() => setCalendarOffset(0)}
                    showToday={calendarOffset !== 0}
                  />
                  <div className="flex items-center gap-6">
                    <nav className="flex gap-[26px] font-mono text-label tracking-tab uppercase text-grey-mid">
                      { (["day","week","month","search"] as const).map((id) => (
                        <button key={id} type="button" onClick={() => setView(id as any)} className={`cursor-pointer transition-colors hover:text-ink ${view===id ? "text-ink font-medium" : "text-grey-mid"}`}>{id.charAt(0).toUpperCase()+id.slice(1)}</button>
                      ))}
                    </nav>
                    <button type="button" onClick={() => setShowAddBlock(true)} className="flex-none cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas hover:bg-accent">+ Add block</button>
                  </div>
                </div>
                <div className="mt-6 flex-1 min-h-0">
                  <MonthView today={toISODate(new Date())} displayDate={calendarDate} hideHeader />
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center justify-between gap-4">
                  <AppHeader
                    dateLabel={day.longLabel}
                    onPrev={() => setCalendarOffset((o) => o - 1)}
                    onNext={() => setCalendarOffset((o) => o + 1)}
                    onToday={() => setCalendarOffset(0)}
                    showToday={view === "day" ? calendarOffset !== 0 : false}
                    todayLabel={view === "day" ? (calendarOffset === -1 ? "Yesterday" : calendarOffset === 1 ? "Tomorrow" : "Today") : undefined}
                  />
                  <div className="flex items-center gap-6">
                    <nav className="flex gap-[26px] font-mono text-label tracking-tab uppercase text-grey-mid">
                      { (["day","week","month","search"] as const).map((id) => (
                        <button key={id} type="button" onClick={() => setView(id as any)} className={`cursor-pointer transition-colors hover:text-ink ${view===id ? "text-ink font-medium" : "text-grey-mid"}`}>{id.charAt(0).toUpperCase()+id.slice(1)}</button>
                      ))}
                    </nav>
                    <button type="button" onClick={() => setShowAddBlock(true)} className="flex-none cursor-pointer rounded-[3px] bg-ink px-4 py-2 text-13 font-medium text-canvas hover:bg-accent">+ Add block</button>
                  </div>
                </div>
                {error ? (
                  <div className="mt-11 max-w-[620px]">
                    <h1 className="text-display font-medium tracking-[-0.028em]">
                      Can't reach your calendar.
                    </h1>
                    <p className="mt-6 font-mono text-label tracking-gap uppercase text-grey">{error}</p>
                  </div>
                ) : loading ? (
                  <div className="mt-11 font-mono text-label tracking-gap uppercase text-grey-ghost">
                    Loading your week…
                  </div>
                ) : (
                  <>
                    {view === "day" && <DayView day={day} now={now} />}
                    {view === "week" && <WeekView week={week} />}
                    {view === "search" && <SearchView week={week} />}
                  </>
                )}
              </>
            )}
          </main>

          <AssistantPanel
            collapsed={!assistantOpen}
            onCollapse={() => setAssistantOpen((v) => !v)}
            state={assistant.state}
            turns={assistant.turns}
            caption={assistant.caption}
            level={assistant.level}
            error={assistant.error}
            onToggle={assistant.toggle}
            onSend={assistant.send}
          />
          <AddBlockModal
            open={showAddBlock}
            mode={view === "month" ? "month" : view === "week" ? "week" : "day"}
            defaultDate={calendarDate}
            weekDates={view === "week" ? week.days.map((d) => d.date) : undefined}
            onClose={() => setShowAddBlock(false)}
            onSave={async (data) => {
              await db.scheduled_blocks.put({
                id: crypto.randomUUID(),
                source_type: "event",
                source_id: null,
                title: data.title,
                date: data.date,
                start_time: data.start,
                end_time: data.end,
                previous_start_time: null,
                created_at: new Date().toISOString(),
                notes: data.note ?? null,
              } as any);
              await refresh();
            }}
          />
        </div>
      )}
    </div>
  );
}
