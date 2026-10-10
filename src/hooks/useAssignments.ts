import { useCallback, useEffect, useState } from "react";
import { addDays, minutesOf, timeOf, toISODate } from "../../shared/datetime";
import { db } from "../lib/db";
import type { ScheduledBlockRow, TaskRow } from "../../shared/db";
import type { PastelColor } from "../types";

export type AssignmentUI = {
  id: string;
  name: string;
  course?: string | null;
  deadline: string;
  estimatedDuration: number;
  priority: "high" | "normal" | "low";
  status: TaskRow["status"];
  color?: PastelColor;
  notes?: string | null;
  chunks?: ScheduledBlockRow[];
};

function rowToAssignment(row: TaskRow, blocks: ScheduledBlockRow[]): AssignmentUI {
  const chunks = blocks.filter((b) => b.source_id === row.id && b.source_type === "task");
  const r = row as any;
  return {
    id: row.id,
    name: row.name,
    course: row.linked_class_or_project,
    deadline: row.deadline ?? "",
    estimatedDuration: row.estimated_duration,
    priority: row.priority,
    status: row.status,
    color: (r.color as PastelColor | undefined),
    notes: null,
    chunks,
  };
}

export function useAssignments() {
  const [assignments, setAssignments] = useState<AssignmentUI[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tasks, blocks] = await Promise.all([db.tasks.orderBy("deadline").toArray(), db.scheduled_blocks.where("source_type").equals("task").toArray()]);
      setAssignments(tasks.map((r) => rowToAssignment(r as TaskRow, blocks as ScheduledBlockRow[])));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onTasks = () => void refresh();
    window.addEventListener("vc-tasks-update", onTasks);
    return () => { window.removeEventListener("vc-tasks-update", onTasks); };
  }, [refresh]);

  const add = useCallback(async (a: Omit<AssignmentUI, "id" | "status" | "chunks"> & { parts?: { name: string; duration: number }[] }) => {
    const parts = (a as unknown as { parts?: { name: string; duration: number }[] }).parts ?? [];
    const totalDur = parts.length ? parts.reduce((t, p) => t + p.duration, 0) : a.estimatedDuration;
    const id = crypto.randomUUID();
    const row: TaskRow = {
      id,
      name: a.name,
      deadline: a.deadline || null,
      estimated_duration: totalDur,
      priority: a.priority,
      linked_class_or_project: a.course ?? null,
      status: parts.length ? "scheduled" : "pending",
      conflict_reason: null,
      color: a.color ?? null,
      created_at: new Date().toISOString(),
    } as TaskRow;
    await db.tasks.put(row);
    if (parts.length) {
      const today = toISODate(new Date());
      const blocks: ScheduledBlockRow[] = [];
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        let date = addDays(today, i + 1);
        if (a.deadline && date > a.deadline) date = a.deadline;
        const start = "14:00";
        const end = timeOf(minutesOf(start) + p.duration);
        const title = p.name || `${a.name} — part ${i + 1}`;
        blocks.push({
          id: crypto.randomUUID(),
          source_type: "task",
          source_id: id,
          title,
          date,
          start_time: start,
          end_time: end,
          previous_start_time: null,
          created_at: new Date().toISOString(),
        } as ScheduledBlockRow);
      }
      await db.scheduled_blocks.bulkPut(blocks);
    }
    const mapped = rowToAssignment(row, await db.scheduled_blocks.where("source_id").equals(id).toArray());
    setAssignments((l) => [...l, mapped]);
    await refresh();
    return mapped;
  }, [refresh]);

  const update = useCallback(async (a: AssignmentUI) => {
    const row: Partial<TaskRow> = {
      name: a.name,
      deadline: a.deadline || null,
      estimated_duration: a.estimatedDuration,
      priority: a.priority,
      linked_class_or_project: a.course ?? null,
      color: a.color ?? null,
      status: a.status,
    };
    await db.tasks.update(a.id, row as TaskRow);
    const fresh = (await db.tasks.get(a.id)) as TaskRow;
    const blocks = await db.scheduled_blocks.where("source_id").equals(a.id).toArray();
    const mapped = rowToAssignment(fresh ?? (a as unknown as TaskRow), blocks);
    setAssignments((l) => l.map((x) => (x.id === a.id ? mapped : x)));
    return mapped;
  }, []);

  const setStatus = useCallback(async (id: string, status: TaskRow["status"]) => {
    await db.tasks.update(id, { status } as Partial<TaskRow>);
    const fresh = (await db.tasks.get(id)) as TaskRow;
    if (fresh) {
      const blocks = await db.scheduled_blocks.where("source_id").equals(id).toArray();
      const mapped = rowToAssignment(fresh, blocks);
      setAssignments((l) => l.map((x) => (x.id === id ? mapped : x)));
    }
    window.dispatchEvent(new Event("vc-tasks-update"));
  }, []);

  const remove = useCallback(async (id: string) => {
    await db.tasks.delete(id);
    await db.scheduled_blocks.where("source_id").equals(id).delete();
    setAssignments((l) => l.filter((x) => x.id !== id));
  }, []);

  return { assignments, loading, error, refresh, add, update, remove, setStatus };
}
