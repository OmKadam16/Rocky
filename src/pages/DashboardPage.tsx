import DayTimeline from "../components/DayTimeline";
import LiquidSphere from "../components/LiquidSphere";
import NowRow from "../components/NowRow";
import type { DaySummary } from "../types";
import type { AssignmentUI } from "../hooks/useAssignments";
import { ASSIGNMENTS_ENABLED } from "../lib/features";
import type { Commitment } from "../types";

import type { AssistantState } from "../types";

type Props = {
  day: DaySummary;
  now: string;
  assignments: AssignmentUI[];
  commitments: Commitment[];
  assistantState?: AssistantState;
  onOrbToggle?: () => void;
  caption?: string;
};

export default function DashboardPage({ day, now, assignments, assistantState = "idle", onOrbToggle, caption }: Props) {
  const pending = assignments.filter((a) => a.status === "pending" || a.status === "blocked");
  const dueSoon = [...assignments]
    .filter((a) => a.deadline)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 4);

  const attention = pending.slice(0, 2);

  return (
    <div className="flex flex-col pb-8">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-label tracking-label uppercase text-grey">{day.longLabel}</div>
        <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">{day.events.length} today{ASSIGNMENTS_ENABLED ? ` · ${assignments.length} assignments` : ""}</div>
      </div>

      <div className="mt-8 flex items-start justify-between gap-8">
        <div className="max-w-[900px] flex-1">
          <h1 className="text-[44px] font-medium leading-[1.1] tracking-[-0.026em] [text-wrap:pretty]">
            The day gets away from you
            <br />
            in small pieces. Spend the first one deliberately.
          </h1>
          <div className="mt-3 font-mono text-meta tracking-tab uppercase text-grey-mid">Today&apos;s thought</div>
        </div>
        <div className="hidden shrink-0 -translate-x-[200px] transform flex-col items-center gap-3 lg:flex pr-2 xl:pr-8">
          <LiquidSphere size={220} state={assistantState} onToggle={onOrbToggle} />
          <div className="min-h-[28px] text-center">
            {assistantState === "listening" && caption ? (
              <div className="max-w-[180px] whitespace-pre-line break-words text-center font-mono text-meta leading-[1.4] text-ink [text-wrap:pretty]">
                {caption}
                <span className="text-accent">|</span>
              </div>
            ) : (
              <div className={`font-mono text-micro tracking-tab uppercase ${assistantState === "idle" ? "text-grey-mid" : "text-accent"}`}>
                {assistantState === "idle" ? "Tap orb to talk" : assistantState === "listening" ? "Listening…" : assistantState === "thinking" ? "Thinking…" : "Speaking…"}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-10 flex gap-11">
        <div className={`flex ${ASSIGNMENTS_ENABLED ? "flex-[1.15]" : "flex-[1.6]"} flex-col`}>
          <div className="flex items-center justify-between border-b border-line pb-3">
            <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Today</div>
            <div className="font-mono text-micro tracking-tab uppercase text-grey-ghost">Calendar →</div>
          </div>
          <div className="mt-2">
            <NowRow day={day} now={now} />
            <div className="mt-4 pr-2">
              {day.events.length === 0 ? (
                <div className="rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-8 text-center font-mono text-label tracking-tab uppercase text-grey-ghost">
                  Nothing on the books
                </div>
              ) : (
                <DayTimeline events={day.events} now={now} />
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col">
          {ASSIGNMENTS_ENABLED && (
            <>
          {attention.length > 0 && (
            <div className="rounded-[3px] border border-accent-line bg-accent-bg px-[18px] py-4">
              <div className="flex items-center gap-2 font-mono text-micro tracking-tab uppercase text-accent-deep">
                <span className="h-[7px] w-[7px] rounded-full bg-accent" />
                Needs attention
              </div>
              <div className="mt-3 flex flex-col gap-3">
                {attention.map((a) => (
                  <div key={a.id}>
                    <div className="text-15 font-medium text-accent-dark">{a.name}</div>
                    <div className="font-mono text-meta text-accent-soft">due {a.deadline} · {a.status === "blocked" ? "no slot before deadline" : "not yet scheduled"}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className={`flex items-center justify-between border-b border-line pb-3 ${attention.length ? "mt-8" : ""}`}>
            <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Due soon</div>
            <div className="font-mono text-micro tracking-tab uppercase text-grey-ghost">Assignments →</div>
          </div>
          <div className="mt-3 flex flex-col">
            {dueSoon.length === 0 ? (
              <div className="font-mono text-meta text-grey">Nothing due soon</div>
            ) : (
              dueSoon.map((a) => {
                const hasParts = a.chunks && a.chunks.length > 0;
                return (
                  <div key={a.id} className="border-b border-line-strong/40 py-[14px]">
                    <div className="flex items-baseline justify-between">
                      <div className="truncate pr-4 text-15 font-medium text-ink-soft">{a.name}</div>
                      <div className="flex-none font-mono text-meta text-grey-faint">{a.deadline.slice(5)}</div>
                    </div>
                    <div className="mt-1 font-mono text-meta tracking-gap uppercase text-grey-mid">{a.course ?? "No course"}</div>
                    {hasParts && (
                      <div className="mt-3 border-l border-line-strong pl-[14px]">
                        {(a.chunks ?? []).slice(0, 3).map((ch) => (
                          <div key={ch.id} className="flex items-center gap-3 py-1 text-13">
                            <span className="h-[7px] w-[7px] rounded-full bg-accent" />
                            <span className="text-ink-soft">{a.name}</span>
                            <span className="font-mono text-meta text-grey">{ch.date.slice(5)} {ch.start_time.slice(0, 5)}</span>
                          </div>
                        ))}
                        {(a.chunks?.length ?? 0) > 3 && <div className="font-mono text-micro text-grey-ghost">+{a.chunks!.length - 3} more</div>}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
            </>
          )}

          <div className={`flex items-center justify-between border-b border-line pb-3 ${ASSIGNMENTS_ENABLED ? "mt-10" : ""}`}>
            <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Who you&apos;re seeing</div>
          </div>
          <div className="mt-3 flex flex-col">
            {day.events.filter((e) => e.kind !== "task").slice(0, 3).length === 0 ? (
              <div className="font-mono text-meta text-grey">No people today</div>
            ) : (
              day.events.filter((e) => e.kind !== "task").slice(0, 3).map((e) => (
                <div key={e.id} className="flex items-center gap-3 border-b border-line-strong/50 py-3">
                  <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-line-strong font-mono text-micro text-ink-soft">
                    {e.title.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-15 font-medium text-ink-soft">{e.title}</div>
                    <div className="truncate font-mono text-meta text-grey">{e.note ?? e.subtext ?? ""}</div>
                  </div>
                  <div className="flex-none font-mono text-hint text-ink-muted">{e.startTime}</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="mt-8 max-w-[620px] border-t border-line pt-6">
        <h1 className="whitespace-pre-line text-display font-medium tracking-[-0.028em] [text-wrap:pretty]">{day.headline}</h1>
        <div className="mt-2 font-mono text-label tracking-gap uppercase text-grey">{day.isToday ? "Live today" : day.longLabel}</div>
      </div>
    </div>
  );
}
