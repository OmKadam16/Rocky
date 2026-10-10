import { useEffect, useMemo, useState } from "react";
import { db } from "../lib/db";
import { useDataChange } from "../hooks/useDataChange";
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";
import { buildDay } from "../lib/schedule";
import { parseISODate, toISODate } from "../../shared/datetime";

const DOW_HEADS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function marksFor(events: { color?: string }[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.color) out.push(`var(--color-pastel-${e.color})`);
    else out.push("var(--color-accent)");
    if (out.length >= 4) break;
  }
  if (out.length === 0 && events.length > 0) out.push("var(--color-accent)");
  return out.slice(0, 4);
}

export default function MonthView({ today, displayDate, hideHeader }: { today: string; displayDate?: string; hideHeader?: boolean }) {
  const [offset, setOffset] = useState(0);
  const [openDay, setOpenDay] = useState("");
  const [blocks, setBlocks] = useState<ScheduledBlockRow[]>([]);
  const [commitments, setCommitments] = useState<FixedCommitmentRow[]>([]);
  const [dataVersion, setDataVersion] = useState(0);
  useDataChange(() => setDataVersion((v) => v + 1), ["scheduled_blocks", "fixed_commitments"]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  const cursor = useMemo(() => {
    if (displayDate) {
      const base = parseISODate(displayDate);
      return new Date(base.getFullYear(), base.getMonth(), 1);
    }
    const d = parseISODate(today);
    d.setMonth(d.getMonth() + offset);
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }, [today, displayDate, offset]);

  const rangeLabel = useMemo(() => `${MONTHS[cursor.getMonth()]} · ${cursor.getFullYear()}`, [cursor]);

  const gridStart = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const s = new Date(first);
    s.setDate(1 - first.getDay());
    return s;
  }, [cursor]);

  const now = useMemo(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }, [tick]);

  useEffect(() => {
    void (async () => {
      const start = toISODate(gridStart);
      const endDate = new Date(gridStart);
      endDate.setDate(endDate.getDate() + 41);
      const end = toISODate(endDate);
      const [b, c] = await Promise.all([
        db.scheduled_blocks.where("date").between(start, end, true, true).toArray(),
        db.fixed_commitments.toArray(),
      ]);
      setBlocks(b as ScheduledBlockRow[]);
      setCommitments(c as FixedCommitmentRow[]);
    })();
  }, [gridStart, dataVersion]);

  const weeks = useMemo(() => {
    const TODAY = parseISODate(today);
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const weeksArr: {
      cells: { num: number; iso: string; bg: string; numColor: string; weight: number; isToday: boolean; marks: string[]; inMonth: boolean; pick: () => void }[];
      expanded: boolean;
      dayLabel: string;
      blocks: { title: string; time: string; bg: string; border: string; color: string }[];
      close: () => void;
    }[] = [];

    for (let w = 0; w < 6; w++) {
      const cells: typeof weeksArr[0]["cells"] = [];
      let openCell: { d: Date; key: string } | undefined;
      for (let i = 0; i < 7; i++) {
        const d = new Date(gridStart);
        d.setDate(gridStart.getDate() + w * 7 + i);
        const iso = toISODate(d);
        const inMonth = d.getMonth() === cursor.getMonth();
        const isToday = sameDay(d, TODAY);
        const key = d.toDateString();
        const open = openDay === key;
        if (open) openCell = { d, key };
        const ctx = { today, now };
        const source = { blocks, commitments };
        const day = buildDay(iso, source, ctx);
        const marks = inMonth ? marksFor(day.events) : [];
        cells.push({
          num: d.getDate(),
          iso,
          bg: open ? "var(--color-muted)" : isToday ? "var(--color-panel)" : "transparent",
          numColor: isToday ? "var(--color-accent-deep)" : inMonth ? "var(--color-ink-2)" : "var(--color-ink-7)",
          weight: isToday ? 500 : 400,
          isToday,
          marks,
          inMonth,
          pick: () => setOpenDay(open ? "" : key),
        });
      }

      const expanded = !!openCell;
      let dayBlocks: typeof weeksArr[0]["blocks"] = [];
      let dayLabel = "";
      if (openCell) {
        const iso = toISODate(openCell.d);
        const ctx = { today, now };
        const source = { blocks, commitments };
        const day = buildDay(iso, source, ctx);
        dayLabel = `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][openCell.d.getDay()]}, ${MONTHS[openCell.d.getMonth()]} ${openCell.d.getDate()}`;
        dayBlocks = day.events.slice(0, 4).map((e) => ({
          title: e.title,
          time: `${e.startTime}–${e.endTime}`,
          bg: e.status === "done" ? "var(--color-muted)" : "var(--color-card)",
          border: "var(--color-border)",
          color: e.status === "done" ? "var(--color-ink-4)" : "var(--color-ink)",
        }));
        if (day.events.length === 0) {
          dayBlocks = [{ title: "No events", time: "Free all day", bg: "var(--color-muted)", border: "var(--color-border)", color: "var(--color-ink-4)" }];
        }
      }

      weeksArr.push({
        cells,
        expanded,
        dayLabel,
        blocks: dayBlocks,
        close: () => setOpenDay(""),
      });
    }
    return weeksArr;
  }, [gridStart, cursor, today, now, blocks, commitments, openDay]);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {!hideHeader && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-[18px]">
            <div className="font-mono text-label tracking-label uppercase text-grey">{rangeLabel}</div>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setOffset((o) => o - 1)} className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-label text-grey-mid transition-colors hover:border-ink hover:text-ink">‹</button>
              <button type="button" onClick={() => setOffset((o) => o + 1)} className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-[3px] border border-line-strong font-mono text-label text-grey-mid transition-colors hover:border-ink hover:text-ink">›</button>
            </div>
            {offset !== 0 && (
              <button type="button" onClick={() => setOffset(0)} className="font-mono text-meta tracking-tab uppercase text-accent transition-colors hover:text-ink">Today</button>
            )}
          </div>
          <div className="font-mono text-micro tracking-tab uppercase text-grey-faint">Pick a day to look closer</div>
        </div>
      )}

      <div className="mt-10 max-w-[640px]">
        <div className="text-[46px] font-medium leading-[1.06] tracking-[-0.026em] [text-wrap:pretty]">The shape of the month.<br />Pick a day to look closer.</div>
      </div>

      <div className="mt-[34px] grid grid-cols-7 border-b border-line pb-[11px]">
        {DOW_HEADS.map((d) => (
          <div key={d} className="font-mono text-micro tracking-tab uppercase text-grey-faint">{d}</div>
        ))}
      </div>

      <div className="mt-0.5 flex flex-1 min-h-0 flex-col overflow-y-auto scroll-smooth pr-2">
        {weeks.map((w, wi) => (
          <div key={wi}>
            <div className="grid grid-cols-7 border-b border-line-strong/40">
              {w.cells.map((c) => (
                <button
                  key={c.iso}
                  type="button"
                  onClick={c.pick}
                  className="flex min-h-[74px] cursor-pointer flex-col gap-[9px] border-l border-line-grid p-[9px_10px_10px] text-left transition-colors hover:bg-done"
                  style={{ background: c.bg, borderLeftColor: "var(--color-line-grid)" }}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-12" style={{ color: c.numColor, fontWeight: c.weight }}>{c.num}</span>
                    {c.isToday && <span className="font-mono text-[9px] tracking-tab uppercase text-accent">Today</span>}
                  </div>
                  <div className="flex gap-1">
                    {c.marks.map((m, i) => (
                      <span key={i} className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: m }} />
                    ))}
                  </div>
                </button>
              ))}
            </div>
            {w.expanded && (
              <div className="border-b border-line-strong/40 bg-panel px-4 py-3 animate-[vcin_0.2s_ease]">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-micro tracking-tab uppercase text-grey-mid">{w.dayLabel}</div>
                  <button type="button" onClick={w.close} className="font-mono text-12 text-grey-faint hover:text-ink">×</button>
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {w.blocks.map((b, i) => (
                    <div key={i} className="flex items-center justify-between rounded-[3px] border px-3 py-2" style={{ background: b.bg, borderColor: b.border }}>
                      <span className="text-13 font-medium" style={{ color: b.color }}>{b.title}</span>
                      <span className="font-mono text-meta text-grey-faint">{b.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
