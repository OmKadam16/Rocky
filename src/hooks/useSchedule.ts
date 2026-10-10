import { useCallback, useEffect, useMemo, useState } from "react";
import type { FixedCommitmentRow, ScheduledBlockRow } from "../../shared/db";
import { weekDates } from "../../shared/datetime";
import { buildDay, buildWeek, nowHHMM, todayISO } from "../lib/schedule";
import { db } from "../lib/db";
import { useDataChange } from "./useDataChange";

export function useSchedule(displayDate?: string) {
  const [blocks, setBlocks] = useState<ScheduledBlockRow[]>([]);
  const [commitments, setCommitments] = useState<FixedCommitmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const today = todayISO();
  const base = displayDate ?? today;
  const dates = useMemo(() => weekDates(base), [base]);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const allBlocks = await db.scheduled_blocks.where("date").between(dates[0], dates[6], true, true).toArray();
      const allCommitments = await db.fixed_commitments.toArray();
      setBlocks(allBlocks.sort((a, b) => a.date.localeCompare(b.date) || a.start_time.localeCompare(b.start_time)));
      setCommitments(allCommitments);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dates]);

  useEffect(() => { void refresh(); }, [refresh]);
  useDataChange(() => { void refresh(); }, ["scheduled_blocks", "fixed_commitments"]);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const { day, week, now } = useMemo(() => {
    void tick;
    const ctx = { today, now: nowHHMM() };
    const source = { blocks, commitments };
    return {
      day: buildDay(base, source, ctx),
      week: buildWeek(dates, source, ctx),
      now: ctx.now,
    };
  }, [blocks, commitments, dates, base, today, tick]);

  return { day, week, now, loading, error, refresh };
}
