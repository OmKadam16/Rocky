import type { DaySummary } from "../types";
import { endsIn } from "../lib/time";

/** The live "NOW" strip that sits under the headline. */
export default function NowRow({ day, now }: { day: DaySummary; now: string }) {
  const current = day.events.find((event) => event.status === "now");
  if (!current) {
    return (
      <div className="mt-10 flex items-center gap-[14px] border-b border-line pb-[22px]">
        <div className="h-[7px] w-[7px] rounded-full bg-grey-ghost" />
        <div className="font-mono text-label tracking-label uppercase text-grey-mid">Now</div>
        <div className="text-lead font-medium text-ink-muted">Nothing running</div>
      </div>
    );
  }

  return (
    <div className="mt-10 flex items-center gap-[14px] border-b border-line pb-[22px]">
      <div className="h-[7px] w-[7px] rounded-full bg-accent animate-vcpulse" />
      <div className="font-mono text-label tracking-label uppercase text-accent">Now</div>
      <div className="text-lead font-medium">{current.title}</div>
      <div className="font-mono text-12 text-grey">{endsIn(now, current.endTime)}</div>
    </div>
  );
}
