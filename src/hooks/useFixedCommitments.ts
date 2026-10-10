import { useCallback, useEffect, useState } from "react";
import { db } from "../lib/db";
import { useDataChange } from "./useDataChange";
import type { FixedCommitmentRow } from "../../shared/db";
import type { Commitment, PastelColor, Weekday } from "../types";
import { WEEKDAYS } from "../types";

const WEEKDAY_TO_NUM: Record<Weekday, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const NUM_TO_WEEKDAY: Record<number, Weekday> = { 0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat" };

function rowToCommitment(row: FixedCommitmentRow): Commitment {
  const validKinds = new Set(["Class", "Work", "Gym", "Other"]);
  const kind = validKinds.has(row.type) ? (row.type as Commitment["kind"]) : "Class";
  const days = (row.days_of_week ?? []).map((n) => NUM_TO_WEEKDAY[n]).filter(Boolean) as Weekday[];
  return {
    id: row.id,
    name: row.name,
    kind,
    otherLabel: (row as unknown as { other_label?: string | null }).other_label ?? undefined,
    days: WEEKDAYS.filter((d) => days.includes(d)),
    start: row.start_time.slice(0, 5),
    end: row.end_time.slice(0, 5),
    color: (row.color as PastelColor | null) ?? undefined,
    notes: (row as unknown as { notes?: string | null }).notes ?? undefined,
    activeFrom: (row as unknown as { active_from?: string | null }).active_from ?? undefined,
    activeUntil: (row as unknown as { active_until?: string | null }).active_until ?? undefined,
  };
}

function commitmentToRow(c: Commitment): FixedCommitmentRow {
  return {
    id: c.id,
    name: c.name,
    type: c.kind,
    days_of_week: c.days.map((d) => WEEKDAY_TO_NUM[d]),
    start_time: c.start,
    end_time: c.end,
    color: c.color ?? null,
    other_label: c.otherLabel ?? null,
    notes: c.notes ?? null,
    active_from: c.activeFrom || null,
    active_until: c.activeUntil || null,
  } as FixedCommitmentRow;
}

export function useFixedCommitments() {
  const [commitments, setCommitments] = useState<Commitment[]>([]);
  const [loading, setLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const rows = await db.fixed_commitments.orderBy("name").toArray();
      setCommitments(rows.map(rowToCommitment));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useDataChange(() => { void refresh(true); }, ["fixed_commitments"]);

  const add = useCallback(async (c: Commitment) => {
    const id = crypto.randomUUID();
    const row = commitmentToRow({ ...c, id });
    setCommitments((l) => [...l, rowToCommitment(row)]);
    setIsMutating(true);
    try {
      await db.fixed_commitments.put(row);
      return rowToCommitment(row);
    } catch (e) {
      setCommitments((l) => l.filter((x) => x.id !== id));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsMutating(false);
    }
  }, []);

  const update = useCallback(async (c: Commitment) => {
    const prev = commitments;
    setCommitments((l) => l.map((x) => (x.id === c.id ? c : x)));
    setIsMutating(true);
    try {
      await db.fixed_commitments.put(commitmentToRow(c));
      return c;
    } catch (e) {
      setCommitments(prev);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsMutating(false);
    }
  }, [commitments]);

  const remove = useCallback(async (id: string) => {
    const prev = commitments;
    setCommitments((l) => l.filter((c) => c.id !== id));
    setIsMutating(true);
    try {
      await db.fixed_commitments.delete(id);
    } catch (e) {
      setCommitments(prev);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      throw e;
    } finally {
      setIsMutating(false);
    }
  }, [commitments]);

  return { commitments, loading, isMutating, error, refresh, add, update, remove };
}
