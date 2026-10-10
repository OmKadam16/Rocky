import { useEffect } from "react";
import type { WeekSummary } from "../types";
import WeekEventBlock from "./WeekEventBlock";
import { HOUR_LABELS, WEEK_AXIS_HEIGHT, WEEK_PX_PER_HOUR, weekOffset } from "../lib/time";

const GRID_COLUMNS = "62px repeat(7, 1fr)";

export default function WeekView({ week }: { week: WeekSummary }) {
  useEffect(() => {
    const scroller = document.getElementById("main-scroll");
    if (!scroller) return;
    scroller.scrollTo({ top: 0, behavior: "smooth" });
  }, [week.days[0]?.date]);

  return (
    <div className="flex flex-col animate-[vcin_0.3s_ease]">
      <div className="mt-10 max-w-[640px]">
        <h1 className="whitespace-pre-line text-[46px] font-medium leading-[1.06] tracking-[-0.026em] [text-wrap:pretty]">
          {week.headline}
        </h1>
      </div>

      <div className="mt-[34px] grid border-b border-line pb-3" style={{ gridTemplateColumns: GRID_COLUMNS }}>
        <div />
        {week.days.map((day) => (
          <div
            key={day.date}
            className={`pr-3 font-mono text-label tracking-tab uppercase ${day.isToday ? "text-accent" : "text-grey-mid"}`}
          >
            <div className="whitespace-nowrap">
              {day.weekdayShort} {day.dayOfMonth}
            </div>
            {day.isToday && <div className="mt-[3px] whitespace-nowrap">today</div>}
          </div>
        ))}
      </div>

      <div className="mt-[14px] pr-2">
        <div className="grid" style={{ gridTemplateColumns: GRID_COLUMNS, height: WEEK_AXIS_HEIGHT + 8 }}>
          <div className="relative">
            {HOUR_LABELS.map((label) => (
              <div key={label} className="absolute left-0 font-mono text-label text-grey-faint" style={{ top: (label === "00:00" ? WEEK_AXIS_HEIGHT : weekOffset(label)) - 6 }}>
                {label}
              </div>
            ))}
          </div>
          {week.days.map((day) => (
            <div
              key={day.date}
              className={`relative border-l border-line-grid ${day.isToday ? "bg-panel" : ""}`}
              style={{
                backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line-grid) 0, var(--color-line-grid) 1px, transparent 1px, transparent ${WEEK_PX_PER_HOUR}px)`,
                backgroundSize: `100% ${WEEK_AXIS_HEIGHT}px`,
                backgroundRepeat: "no-repeat",
              }}
            >
              {day.events.map((event) => (
                <WeekEventBlock key={event.id} event={event} day={day} />
              ))}
              {day.events.length === 0 && (
                <div className="absolute left-0 right-0 text-center font-mono text-meta tracking-tag uppercase text-grey-ghost" style={{ top: weekOffset("12:00") }}>
                  clear
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
