import type { DaySummary, EventBlock } from "../types";
import { PASTEL_SURFACES } from "./blockStyles";
import { minutesFromStart, weekHeight, weekOffset } from "../lib/time";

function surface(event: EventBlock, day: DaySummary): string {
  if (event.color) {
    const pastel = PASTEL_SURFACES[event.color];
    if (event.status === "done") return `${pastel} opacity-65`;
    if (event.tag === "new") return `${pastel} animate-vcin`;
    if (day.isToday) return `${pastel} border-l-2 border-l-accent`;
    return pastel;
  }
  if (event.tag === "new") return "bg-accent-bg-week border border-accent-line animate-vcin";
  if (day.isToday && event.status !== "done") {
    return "bg-card border border-line-grid border-l-2 border-l-accent";
  }
  return "bg-card border border-line-grid";
}

type Props = { event: EventBlock; day: DaySummary };

export default function WeekEventBlock({ event, day }: Props) {
  if (minutesFromStart(event.startTime) < 0) return null;

  const height = weekHeight(event);
  const stacked = height >= 40;

  return (
    <div
      className={`absolute left-[7px] right-2 flex flex-col justify-center overflow-hidden rounded-[3px] px-[9px] ${surface(
        event,
        day,
      )}`}
      style={{ top: weekOffset(event.startTime) + 1, height: height - 2 }}
    >
      <div
        className={`overflow-hidden text-ellipsis whitespace-nowrap text-13 font-medium ${
          event.tag === "new" ? "text-accent-dark" : "text-ink"
        }`}
      >
        {event.title}
      </div>
      {stacked && (
        <div className="mt-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-meta text-grey">
          {event.startTime}–{event.endTime}
          {event.tag === "moved" && event.movedFrom ? ` · moved from ${event.movedFrom}` : ""}
          {event.note ? ` · ${event.note}` : event.subtext ? ` · ${event.subtext}` : ""}
        </div>
      )}
    </div>
  );
}
