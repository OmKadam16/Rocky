import { useMemo, useState } from "react";
import type { EventBlock, WeekSummary } from "../types";

function highlight(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return (
    <>
      {before}
      <mark className="rounded-[2px] bg-accent-bg px-0.5 text-ink">{match}</mark>
      {after}
    </>
  );
}

type DayResult = {
  date: string;
  weekday: string;
  events: EventBlock[];
};

export default function SearchView({ week }: { week: WeekSummary }) {
  const [query, setQuery] = useState("");

  const trimmed = query.trim().toLowerCase();

  const results: DayResult[] = useMemo(() => {
    if (!trimmed) return week.days.map((d) => ({ date: d.date, weekday: d.weekdayShort, events: d.events })).filter((r) => r.events.length > 0);
    return week.days
      .map((day) => {
        const matched = day.events.filter((e) => {
          const hay = `${e.title} ${e.note ?? ""} ${e.subtext ?? ""} ${e.startTime} ${e.endTime}`.toLowerCase();
          return hay.includes(trimmed);
        });
        return { date: day.date, weekday: day.weekdayShort, events: matched };
      })
      .filter((r) => r.events.length > 0);
  }, [week, trimmed]);

  const total = results.reduce((n, r) => n + r.events.length, 0);
  const totalInWeek = week.days.reduce((n, d) => n + d.events.length, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mt-11 max-w-[620px]">
        <h1 className="whitespace-pre-line text-display font-medium tracking-[-0.028em] [text-wrap:pretty]">
          {trimmed ? `Search` : `Find anything`}
        </h1>
        <p className="mt-3 font-mono text-label tracking-gap uppercase text-grey">
          {trimmed ? `${total} result${total === 1 ? "" : "s"} for “${query.trim()}”` : `${totalInWeek} events this week`}
        </p>
      </div>

      <div className="mt-6 max-w-[520px]">
        <div className="relative">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, notes — e.g. biology, print assignment"
            className="w-full rounded-[3px] border border-line-strong bg-card px-4 py-[11px] pr-10 text-15 leading-[1.4] text-ink outline-none placeholder:text-grey-faint focus:border-ink"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded-full px-2 py-1 font-mono text-13 text-grey-ghost hover:text-ink"
            >
              ×
            </button>
          )}
        </div>
        <div className="mt-2 font-mono text-micro tracking-tab uppercase text-grey-faint">
          {trimmed ? "Matching titles and notes" : "Showing this week — type to filter"}
        </div>
      </div>

      <div className="mt-8 flex-1 overflow-visible">
        {results.length === 0 ? (
          <div className="rounded-[3px] border border-dashed border-line-strong bg-panel px-6 py-10 text-center">
            <div className="font-mono text-label tracking-tab uppercase text-grey-ghost">No matches</div>
            <div className="mt-2 text-15 leading-[1.5] text-grey">Try “{trimmed ? "gym" : "standup"}” or a note like “print”</div>
          </div>
        ) : (
          <div className="flex flex-col gap-8 pb-6">
            {results.map((day) => {
              return (
                <div key={day.date}>
                  <div className="mb-3 flex items-baseline gap-3 border-b border-line pb-2 font-mono text-label tracking-tab uppercase text-grey-mid">
                    <span className="text-ink">{day.weekday}</span>
                    <span>{day.date}</span>
                    <span className="ml-auto text-grey-faint">{day.events.length} event{day.events.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {day.events.map((e) => (
                      <div
                        key={e.id}
                        className={`flex items-center gap-3 rounded-[3px] border px-4 py-3 ${e.color ? `bg-pastel-${e.color} border-pastel-${e.color}-line` : "bg-card border-line-block"}`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-15 font-medium text-ink">
                            {highlight(e.title, trimmed)}
                          </div>
                          <div className="mt-1 font-mono text-meta tracking-gap uppercase text-grey-mid">
                            {e.startTime}–{e.endTime}
                            {e.note ? ` · ${highlight(e.note as string, trimmed)}` : e.subtext ? ` · ${highlight(e.subtext, trimmed)}` : ""}
                            {e.tag === "moved" && e.movedFrom ? ` · moved from ${e.movedFrom}` : ""}
                          </div>
                        </div>
                        <div className={`h-2 w-2 flex-none rounded-full ${e.status === "now" ? "bg-accent animate-vcpulse" : e.status === "done" ? "bg-grey-ghost" : "bg-line-strong"}`} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
