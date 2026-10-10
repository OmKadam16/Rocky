import { useState } from "react";
import AssignmentPopup from "../components/AssignmentPopup";
import type { AssignmentUI } from "../hooks/useAssignments";
import { db } from "../lib/db";

type Props = {
  assignments: AssignmentUI[];
  onAdd: (a: { name: string; course?: string; deadline: string; estimatedDuration: number; priority: "high" | "normal" | "low"; color?: string }) => Promise<void>;
  onUpdate: (a: AssignmentUI) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onSetStatus?: (id: string, status: "pending" | "in_progress" | "done" | "scheduled" | "blocked") => Promise<void>;
};

function daysTo(due: string, today: string): number {
  if (!due) return 999;
  const a = new Date(today);
  const b = new Date(due);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}
function courseColor(course?: string | null): string {
  const palette = ["var(--color-c-a)", "var(--color-c-b)", "var(--color-c-c)", "var(--color-c-d)"];
  if (!course) return palette[0];
  let h = 0;
  for (let i = 0; i < course.length; i++) h = (h * 31 + course.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
function priBar(p: string): string {
  if (p === "high") return "var(--color-ink)";
  if (p === "normal") return "var(--color-border-2)";
  return "transparent";
}

export default function TasksPage({ assignments, onAdd, onUpdate, onRemove, onSetStatus }: Props) {
  const [editing, setEditing] = useState<AssignmentUI | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [filter, setFilter] = useState<"all" | "pending" | "scheduled" | "blocked">("all");
  const [openIds, setOpenIds] = useState<string[]>([]);
  const [addingPart, setAddingPart] = useState<string | null>(null);
  const [partName, setPartName] = useState("");
  const [partDate, setPartDate] = useState("");
  const [partStart, setPartStart] = useState("14:00");
  const [partEnd, setPartEnd] = useState("15:00");

  const today = new Date().toISOString().slice(0, 10);
  const counts = {
    all: assignments.length,
    pending: assignments.filter((a) => a.status === "pending").length,
    scheduled: assignments.filter((a) => a.status === "scheduled").length,
    blocked: assignments.filter((a) => a.status === "blocked").length,
  };
  const filtered = assignments.filter((a) => {
    if (filter === "all") return true;
    return a.status === filter;
  }).sort((a, b) => (a.deadline || "").localeCompare(b.deadline || ""));
  const active = filtered.filter((a) => a.status !== "done");
  const completed = filtered.filter((a) => a.status === "done");
  const groups: { label: string; items: AssignmentUI[]; done?: boolean }[] = (() => {
    if (!filtered.length) return [];
    if (filter === "all") {
      const out: { label: string; items: AssignmentUI[]; done?: boolean }[] = [];
      const thisWeek = active.filter((a) => daysTo(a.deadline, today) <= 7);
      const later = active.filter((a) => daysTo(a.deadline, today) > 7);
      if (thisWeek.length) out.push({ label: "This week", items: thisWeek });
      if (later.length) out.push({ label: "Later", items: later });
      if (!thisWeek.length && !later.length && active.length) out.push({ label: "All", items: active });
      if (completed.length) out.push({ label: "Completed", items: completed, done: true });
      return out;
    }
    const thisWeek = filtered.filter((a) => daysTo(a.deadline, today) <= 7);
    const later = filtered.filter((a) => daysTo(a.deadline, today) > 7);
    const out: { label: string; items: AssignmentUI[] }[] = [];
    if (thisWeek.length) out.push({ label: "This week", items: thisWeek });
    if (later.length) out.push({ label: "Later", items: later });
    if (!out.length) out.push({ label: "All", items: filtered });
    return out;
  })();

  const toggle = (id: string) => setOpenIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const handleAddPart = async (a: AssignmentUI) => {
    if (!partDate) return;
    const title = partName.trim() || `${a.name} — part ${(a.chunks?.length ?? 0) + 1}`;
    await db.scheduled_blocks.put({
      id: crypto.randomUUID(),
      source_type: "task",
      source_id: a.id,
      title,
      date: partDate,
      start_time: partStart,
      end_time: partEnd,
      previous_start_time: null,
      created_at: new Date().toISOString(),
    } as any);
    window.location.reload();
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col pb-10 pl-[60px] pr-14 pt-[52px]">
      <div className="font-mono text-label tracking-label uppercase text-grey">Tasks</div>
      <div className="mt-10 flex items-start justify-between gap-8">
        <div className="max-w-[620px] flex-1">
          <h1 className="text-[42px] font-medium leading-[1.08] tracking-[-0.026em] [text-wrap:pretty]">
            Your tasks,
            <br />
            wherever they came from.
          </h1>
          <p className="mt-[18px] max-w-[500px] text-15 leading-[1.55] text-ink-muted [text-wrap:pretty]">
            Add tasks by hand, or ask Rocky to schedule them.
          </p>
        </div>
        <button type="button" onClick={() => { setEditing(null); setShowManual(true); }} className="mt-20 flex-none cursor-pointer self-start rounded-[3px] bg-ink px-[26px] py-[13px] text-14 font-medium text-canvas transition-colors hover:bg-accent">
          Add task
        </button>
      </div>
      <AssignmentPopup
        open={showManual || !!editing}
        editing={editing ? { id: editing.id, name: editing.name, course: editing.course ?? undefined, deadline: editing.deadline, estimatedDuration: editing.estimatedDuration, priority: editing.priority, color: editing.color, parts: (editing.chunks ?? []).map((ch) => ({ id: ch.id, name: ch.title, duration: Math.max(15, Math.round((new Date(`2000-01-01T${ch.end_time}`).getTime() - new Date(`2000-01-01T${ch.start_time}`).getTime()) / 60000)) })) } : null}
        onClose={() => { setEditing(null); setShowManual(false); }}
        onSave={(data) => {
          if (editing) { void onUpdate({ ...editing, name: data.name, course: data.course ?? null, deadline: data.deadline, estimatedDuration: data.estimatedDuration, priority: data.priority, color: data.color, notes: editing.notes } as AssignmentUI); setEditing(null); setShowManual(false); }
          else void onAdd({ ...data, parts: data.parts } as never).then(() => setShowManual(false));
        }}
      />

      <div className="mt-8 flex items-center justify-between border-b border-line pb-3">
        <div className="flex gap-[22px]">
          {(["all", "pending", "scheduled", "blocked"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`flex items-baseline gap-[7px] font-mono text-micro tracking-tab uppercase transition-colors ${filter === f ? "text-ink" : "text-grey-mid hover:text-ink"}`}>
              <span>{f}</span>
              <span className={filter === f ? "text-grey-mid" : "text-grey-faint"}>{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">By due date</div>
      </div>

      <div className="mt-[18px] flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-2 pb-6">
        {filtered.length === 0 && (
          <div className="py-8 text-center">
            <div className="text-[22px] font-medium text-ink-muted">Nothing on the list.</div>
            <div className="mt-2 font-mono text-label tracking-gap uppercase text-grey-ghost">Add one by hand.</div>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className={g.done ? "opacity-90" : ""}>
            <div className="flex items-center gap-3 py-[14px]">
              <div className={`font-mono text-micro tracking-tab uppercase ${g.done ? "text-grey" : "text-grey-faint"}`}>{g.label}{g.done ? ` · ${g.items.length}` : ""}</div>
              <div className="h-px flex-1 bg-line-strong/40" />
              {g.done && <span className="font-mono text-nano tracking-tag uppercase text-grey-faint">Done</span>}
            </div>
            <div className="flex flex-col gap-2">
              {g.items.map((a) => {
                const isOpen = openIds.includes(a.id);
                const dt = daysTo(a.deadline, today);
                const urgencyColor = dt < 0 || dt === 0 ? "var(--color-warm)" : dt <= 3 ? "var(--color-accent-deep)" : dt <= 7 ? "var(--color-grey)" : "var(--color-grey-faint)";
                const dueLabel = a.deadline ? a.deadline.slice(5).replace("-", "/") : "—";
                const isBlocked = a.status === "blocked";
                const isDone = a.status === "done";
                const isInProgress = a.status === "in_progress";
                const chunks = a.chunks ?? [];
                return (
                  <div key={a.id} onClick={() => toggle(a.id)} className={`flex cursor-pointer gap-0 rounded-[3px] border px-0 py-0 transition-colors ${isDone ? "border-line bg-done/60 opacity-70 hover:opacity-90" : isInProgress ? "border-accent-line bg-accent-bg hover:border-accent" : isBlocked ? "border-warm-line bg-warm-soft" : "border-line-block bg-card hover:border-line-strong"} ${isOpen && !isDone ? "border-line-strong" : ""} ${g.done ? "opacity-80" : ""}`}>
                    <div className="my-[12px] ml-[12px] w-[3px] flex-none rounded-full" style={{ background: priBar(a.priority) }} />
                    <div className="min-w-0 flex-1 px-[16px] py-[16px]">
                      <div className="flex items-center gap-3">
                        <span className={`h-[7px] w-[7px] flex-none rounded-full ${isInProgress ? "animate-pulse" : ""}`} style={{ background: isDone ? "var(--color-grey-faint)" : isInProgress ? "var(--color-accent)" : courseColor(a.course) }} />
                        <div className={`min-w-0 flex-1 truncate text-[16.5px] font-medium ${isDone ? "text-grey-mid line-through decoration-line-strong" : isInProgress ? "text-accent-deep" : "text-ink-soft"}`}>{isDone ? "✓ " : isInProgress ? "▶ " : ""}{a.name}</div>
                        {a.priority === "high" && <span className="rounded-full border border-line-strong px-2 py-0.5 font-mono text-nano tracking-tag uppercase text-grey-mid">High</span>}
                        <span className="ml-auto flex-none font-mono text-13" style={{ color: urgencyColor }}>{dt < 0 ? "Overdue" : dt === 0 ? "Today" : dt === 1 ? "Tomorrow" : `${dt}d`}</span>
                        <span className="w-[84px] flex-none text-right font-mono text-meta text-grey-faint">{dueLabel}</span>
                        <span className="font-mono text-12 text-grey-faint">{isOpen ? "–" : "+"}</span>
                      </div>
                      <div className="mt-[7px] flex flex-wrap items-center gap-3 pl-[17px]">
                        <span className="font-mono text-meta tracking-gap uppercase" style={{ color: courseColor(a.course) }}>{a.course ?? "No course"}</span>
                        <span className="font-mono text-meta text-grey-faint">{chunks.length ? `${chunks.length} chunks · ${a.estimatedDuration}m` : `Not broken up yet · ${a.estimatedDuration}m`}</span>
                        <span className={`rounded-full border px-2 py-0.5 font-mono text-nano tracking-tag uppercase ${a.status === "done" ? "border-done bg-done text-grey" : a.status === "in_progress" || a.status === "scheduled" ? "border-accent-line bg-accent-bg text-accent" : "border-line bg-card text-grey-mid"}`}>{a.status === "in_progress" ? "In Progress" : a.status === "done" ? "Complete" : a.status === "blocked" ? "Blocked" : a.status === "scheduled" ? "Scheduled" : "Incomplete"}</span>
                      </div>
                      <div className="mt-2 ml-[17px] flex flex-wrap gap-2">
                        {a.status !== "done" && <button type="button" onClick={(e) => { e.stopPropagation(); onSetStatus?.(a.id, "done"); }} className="cursor-pointer rounded-[3px] bg-ink px-2.5 py-1 font-mono text-micro tracking-tab uppercase text-canvas hover:bg-accent">✓ Complete</button>}
                        {a.status !== "in_progress" && a.status !== "done" && <button type="button" onClick={(e) => { e.stopPropagation(); onSetStatus?.(a.id, "in_progress"); }} className="cursor-pointer rounded-[3px] border border-line-strong px-2.5 py-1 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">▶ In progress</button>}
                        {a.status !== "pending" && a.status !== "done" && <button type="button" onClick={(e) => { e.stopPropagation(); onSetStatus?.(a.id, "pending"); }} className="cursor-pointer rounded-[3px] border border-line-strong px-2.5 py-1 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">↺ Incomplete</button>}
                        {a.status === "done" && <button type="button" onClick={(e) => { e.stopPropagation(); onSetStatus?.(a.id, "pending"); }} className="cursor-pointer rounded-[3px] border border-line-strong px-2.5 py-1 font-mono text-micro tracking-tab uppercase text-grey hover:border-ink hover:text-ink">↺ Reopen</button>}
                      </div>
                      {isBlocked && (
                        <div className="mt-3 border-l-2 border-warm-line pl-[14px]"><div className="text-14 leading-[1.4] text-ink-muted">No gap before due date.</div></div>
                      )}
                      {isOpen && (
                        <div className="mt-4 border-l border-line-strong pl-4 animate-[vcin_0.25s_ease]">
                          {chunks.length === 0 ? <div className="font-mono text-meta text-grey">No chunks placed yet.</div> : (
                            <div className="flex flex-col gap-2">
                              {chunks.slice().sort((x, y) => x.date.localeCompare(y.date) || x.start_time.localeCompare(y.start_time)).map((ch) => {
                                const isDone = ch.date < today;
                                const isToday = ch.date === today;
                                return (
                                  <div key={ch.id} className="flex items-center gap-3">
                                    <span className="h-[7px] w-[7px] rounded-full" style={{ background: isDone ? "var(--color-grey-ghost)" : isToday ? "var(--color-accent)" : "var(--color-line-strong)", border: `1px solid ${isDone ? "var(--color-grey-ghost)" : "var(--color-border-2)"}` }} />
                                    <div className="min-w-0 flex-1 truncate text-14" style={{ color: isDone ? "var(--color-grey-mid)" : "var(--color-ink-soft)" }}>{ch.title}</div>
                                    <span className="font-mono text-meta" style={{ color: isDone ? "var(--color-grey-faint)" : "var(--color-grey)" }}>{isDone ? "Done" : isToday ? "Today" : ch.date.slice(5)} {ch.start_time.slice(0, 5)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <button type="button" onClick={(e) => { e.stopPropagation(); const next = addingPart === a.id ? null : a.id; setAddingPart(next); if (next) setPartName(""); }} className="cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-mid underline decoration-line-strong underline-offset-4 hover:text-ink">+ Add part</button>
                            <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(a); setShowManual(true); }} className="cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-ghost hover:text-ink">Edit</button>
                            <button type="button" onClick={(e) => { e.stopPropagation(); onRemove(a.id); }} className="cursor-pointer font-mono text-micro tracking-tab uppercase text-grey-ghost hover:text-ink">Delete</button>
                          </div>
                          {addingPart === a.id && (
                            <div className="mt-3 flex flex-col gap-3 rounded-[3px] border border-line-strong bg-panel px-3 py-3" onClick={(e) => e.stopPropagation()}>
                              <input type="text" value={partName} onChange={(e) => setPartName(e.target.value)} placeholder="Part name" className="w-full rounded border border-line-strong bg-card px-2 py-2 font-mono text-13 text-ink outline-none placeholder:text-grey-faint focus:border-ink" />
                              <div className="flex flex-wrap items-center gap-2">
                                <input type="date" value={partDate} onChange={(e) => setPartDate(e.target.value)} className="rounded border border-line-strong bg-card px-2 py-1 font-mono text-13 outline-none focus:border-ink" />
                                <input type="time" value={partStart} onChange={(e) => setPartStart(e.target.value)} className="rounded border border-line-strong bg-card px-2 py-1 font-mono text-13 outline-none focus:border-ink" />
                                <span className="font-mono text-13 text-grey">→</span>
                                <input type="time" value={partEnd} onChange={(e) => setPartEnd(e.target.value)} className="rounded border border-line-strong bg-card px-2 py-1 font-mono text-13 outline-none focus:border-ink" />
                                <button type="button" onClick={() => handleAddPart(a)} className="cursor-pointer rounded bg-ink px-3 py-1.5 font-mono text-12 text-canvas hover:bg-accent">Add</button>
                                <button type="button" onClick={() => { setAddingPart(null); setPartName(""); }} className="cursor-pointer font-mono text-12 text-grey hover:text-ink">Cancel</button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(a); setShowManual(true); }} className="mr-2 hidden flex-none text-grey-ghost hover:text-ink md:flex"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg></button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
