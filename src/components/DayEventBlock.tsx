import type { EventBlock } from "../types";
import { PASTEL_SURFACES, SURFACE_ACCENT, SURFACE_CARD, SURFACE_MUTED } from "./blockStyles";
import { dayHeight, dayOffset, durationMinutes, formatDuration } from "../lib/time";

function metaLine(event: EventBlock): string {
  if (event.status === "done") {
    return `done · ${event.startTime}–${event.endTime}`;
  }
  if (event.status === "now") {
    const parts = [formatDuration(durationMinutes(event))];
    if (event.note) parts.push(event.note);
    else if (event.subtext) parts.push(event.subtext);
    return parts.join(" · ");
  }
  const parts = [`${event.startTime}–${event.endTime}`];
  if (event.tag === "moved" && event.movedFrom) parts.push(`moved from ${event.movedFrom}`);
  if (event.note) parts.push(event.note);
  else if (event.subtext && !(event.tag === "moved" && event.movedFrom)) parts.push(event.subtext);
  return parts.join(" · ");
}

function surface(event: EventBlock) {
  if (event.status === "done") return `${SURFACE_MUTED} opacity-65`;
  if (event.color) {
    const pastel = PASTEL_SURFACES[event.color];
    if (event.tag === "new") return `${pastel} animate-vcin`;
    if (event.status === "now") return `${pastel} border-l-2 border-l-accent`;
    return `${pastel}${event.tag === "moved" ? " animate-vcin" : ""}`;
  }
  if (event.tag === "new") return `${SURFACE_ACCENT} animate-vcin`;
  if (event.status === "now") return `${SURFACE_CARD} border-l-2 border-l-accent`;
  return `${SURFACE_CARD}${event.tag === "moved" ? " animate-vcin" : ""}`;
}

export default function DayEventBlock({ event }: { event: EventBlock }) {
  const height = dayHeight(event);
  const compact = height < 34;
  const roomy = height >= 46;

  const titleColor =
    event.status === "done" ? "text-ink-muted" : event.tag === "new" ? "text-accent-dark" : "text-ink";
  const metaColor =
    event.status === "done"
      ? "text-grey-mid"
      : event.tag === "new"
        ? "text-accent-soft"
        : "text-grey";

  return (
    <div
      className={`absolute left-[84px] right-[4px] box-border overflow-hidden ${surface(event)}`}
      style={{
        top: dayOffset(event.startTime),
        height,
        padding: compact ? "0 12px" : roomy ? "7px 12px" : "3px 12px",
      }}
    >
      {compact ? (
        <div className="flex h-full items-center gap-[10px]">
          <div className={`whitespace-nowrap text-event font-medium ${titleColor}`}>{event.title}</div>
          {event.tag === "new" && (
            <div className="whitespace-nowrap font-mono text-nano tracking-tag uppercase text-accent-deep">
              new
            </div>
          )}
          <div
            className={`overflow-hidden text-ellipsis whitespace-nowrap font-mono text-label ${metaColor}`}
          >
            {metaLine(event)}
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-[9px]">
            <div
              className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-medium ${titleColor}`}
              style={{ fontSize: roomy ? 14 : 13.5, lineHeight: roomy ? "17px" : "16px" }}
            >
              {event.title}
            </div>
            {event.tag === "new" && (
              <div className="flex-none font-mono text-nano tracking-tag uppercase text-accent-deep">
                new
              </div>
            )}
          </div>
          <div
            className={`font-mono text-meta ${metaColor}`}
            style={{ lineHeight: roomy ? "14px" : "13px" }}
          >
            {metaLine(event)}
          </div>
        </>
      )}
    </div>
  );
}
