import { useEffect, useState } from "react";
import AppHeader from "./AppHeader";
import DayTimeline from "./DayTimeline";
import { useSchedule } from "../hooks/useSchedule";
import { addDays } from "../../shared/datetime";
import { todayISO } from "../lib/schedule";

/**
 * Right column of the Dashboard: the selected day's full timeline, compact.
 * Has its own day (prev / next / Today) so browsing it never moves the
 * calendar pages, and refreshes whenever the chat changes the calendar.
 */
export default function DashboardDayPanel({ refreshKey }: { refreshKey: number }) {
  const [offset, setOffset] = useState(0);
  const date = addDays(todayISO(), offset);
  const { day, now, loading, error, refresh } = useSchedule(date);

  useEffect(() => {
    if (refreshKey > 0) void refresh();
  }, [refreshKey, refresh]);

  const label = offset === 0 ? "Today" : offset === -1 ? "Yesterday" : offset === 1 ? "Tomorrow" : "Today";

  return (
    <aside className="hidden min-w-0 flex-[30] flex-col border-l border-line bg-panel min-[1100px]:flex">
      <div className="flex items-center justify-between gap-3 border-b border-line-panel px-[28px] pb-[16px] pt-[20px]">
        <AppHeader
          dateLabel={day.longLabel}
          onPrev={() => setOffset((o) => o - 1)}
          onNext={() => setOffset((o) => o + 1)}
          onToday={() => setOffset(0)}
          showToday={offset !== 0}
          todayLabel={offset !== 0 ? "Today" : label}
        />
        <span className="font-mono text-micro tracking-tab uppercase text-grey-mid">{day.events.length} on</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[24px] pb-8 pt-6">
        {error ? (
          <div className="font-mono text-meta text-grey">Can't reach your calendar. {error}</div>
        ) : loading ? (
          <div className="font-mono text-label tracking-gap uppercase text-grey-ghost">Loading…</div>
        ) : day.events.length === 0 ? (
          <div className="rounded-[3px] border border-dashed border-line-strong px-6 py-8 text-center font-mono text-label tracking-tab uppercase text-grey-ghost">
            Nothing on the books
          </div>
        ) : (
          <DayTimeline events={day.events} now={day.isToday ? now : undefined} />
        )}
      </div>
    </aside>
  );
}
