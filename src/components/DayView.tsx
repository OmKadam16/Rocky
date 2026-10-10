import { useEffect } from "react";
import type { DaySummary } from "../types";
import DayTimeline from "./DayTimeline";
import NowRow from "./NowRow";

export default function DayView({ day, now }: { day: DaySummary; now: string }) {
  useEffect(() => {
    const scroller = document.getElementById("main-scroll");
    if (!scroller) return;
    scroller.scrollTo({ top: 0, behavior: "smooth" });
  }, [day.date]);

  return (
    <div className="flex flex-col animate-[vcin_0.3s_ease]">
      <div className="mt-10 max-w-[640px]">
        <h1 className="whitespace-pre-line text-[46px] font-medium leading-[1.06] tracking-[-0.026em] [text-wrap:pretty]">
          {day.headline}
        </h1>
      </div>

      <div className="mt-[34px]">
        <NowRow day={day} now={now} />
      </div>

      <div className="mt-[22px] pr-2">
        <DayTimeline events={day.events} now={now} />
      </div>
    </div>
  );
}
