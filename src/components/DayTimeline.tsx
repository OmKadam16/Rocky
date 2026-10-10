import type { EventBlock } from "../types";
import DayEventBlock from "./DayEventBlock";
import {
  DAY_AXIS_HEIGHT,
  DAY_PX_PER_HOUR,
  HOUR_LABELS,
  dayOffset,
  findGaps,
  toMinutes,
} from "../lib/time";

type Props = {
  events: EventBlock[];
  /** Wall-clock "now", e.g. "10:03". Omit to hide the marker. */
  now?: string;
};

export default function DayTimeline({ events, now }: Props) {
  const gaps = findGaps(events);
  const sorted = [...events].sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  const last = sorted[sorted.length - 1];
  const nowOffset = now ? dayOffset(now) : null;
  const nowVisible = nowOffset !== null && nowOffset >= 0 && nowOffset <= DAY_AXIS_HEIGHT;
  const nowHour = now ? `${now.slice(0, 2)}:00` : null;

  return (
    <div className="relative" style={{ height: DAY_AXIS_HEIGHT + 34 }}>
      {/* hour rules */}
      <div
        className="absolute left-[76px] right-0 top-0"
        style={{
          height: DAY_AXIS_HEIGHT + 1,
          backgroundImage: `repeating-linear-gradient(to bottom, var(--color-line-grid) 0, var(--color-line-grid) 1px, transparent 1px, transparent ${DAY_PX_PER_HOUR}px)`,
        }}
      />

      {/* hour labels — one per hour */}
      {HOUR_LABELS.map((label) => (
        <div
          key={label}
          className={`absolute left-0 font-mono text-label ${
            label === nowHour ? "text-ink" : "text-grey-faint"
          }`}
          style={{ top: dayOffset(label) - 6 }}
        >
          {label}
        </div>
      ))}

      {/* open stretches */}
      {gaps.map((gap) => (
        <div
          key={gap.id}
          className="absolute left-[84px] right-[4px] text-center font-mono text-label tracking-gap text-grey-ghost"
          style={{ top: (dayOffset(gap.startTime) + dayOffset(gap.endTime)) / 2 - 6 }}
        >
          {gap.label}
        </div>
      ))}
      {last && (
        <div
          className="absolute left-[84px] right-[4px] text-center font-mono text-label tracking-gap text-grey-ghost"
          style={{ top: DAY_AXIS_HEIGHT + 10 }}
        >
          nothing after {last.endTime}
        </div>
      )}

      {/* events */}
      {sorted.map((event) => (
        <DayEventBlock key={event.id} event={event} />
      ))}

      {/* now marker */}
      {nowVisible && (
        <>
          <div
            className="absolute left-[76px] right-[4px] z-[3] h-px bg-accent"
            style={{ top: nowOffset }}
          />
          <div
            className="absolute left-[72px] z-[3] h-[7px] w-[7px] rounded-full bg-accent animate-vcpulse"
            style={{ top: nowOffset - 3 }}
          />
        </>
      )}
    </div>
  );
}
