/**
 * The calendar as the planner should read it: plain lines, one per entry,
 * day by day, with what kind of thing each entry is and whether it has
 * already happened. Built in code from the context snapshot (pure; tested in
 * calendarGlance.test.ts). Small models read this far better than the JSON,
 * which still rides along for ids and details.
 */

type GlanceBlock = { id: string; title: string; source_type?: string; start_time: string; end_time: string; moved_from?: string | null; notes?: string | null };
type GlanceFixed = { id: string; name: string; start_time: string; end_time: string; notes?: string | null };
type GlanceDay = { date: string; weekday: string; free_windows?: { start_time: string; end_time: string }[]; fixed_commitments: GlanceFixed[]; blocks: GlanceBlock[] };
type GlanceTask = { name: string; deadline?: string | null; estimated_duration?: number | null; priority?: string | null; status?: string | null };

export type GlanceSnapshot = {
  today: string;
  now: string;
  tomorrow?: string;
  week: { days: GlanceDay[] };
  tasks?: GlanceTask[];
};

const mins = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** What kind of entry a block is, in the words the prompt uses. */
export function blockKind(b: Pick<GlanceBlock, "title" | "source_type">): string {
  if (/\((booking|check booking|booking failed)/i.test(b.title) || /booking hold/i.test(b.title)) return "booking hold, NOT a reservation";
  if (b.source_type === "task") return "task block";
  return "event";
}

function when(date: string, start: string, end: string, today: string, now: string): string {
  if (date !== today) return "";
  const n = mins(now);
  if (mins(end) <= n) return ", already over";
  if (mins(start) <= n) return ", happening now";
  return ", later today";
}

function dayName(d: GlanceDay, s: GlanceSnapshot): string {
  if (d.date === s.today) return `TODAY, ${d.weekday} ${d.date} (it is ${s.now} now)`;
  if (d.date === s.tomorrow) return `TOMORROW, ${d.weekday} ${d.date}`;
  return `${d.weekday} ${d.date}`;
}

export function calendarGlance(s: GlanceSnapshot): string {
  const lines: string[] = ["CALENDAR AT A GLANCE (24-hour times; ids in [brackets] are for tools, never say them aloud):"];
  for (const d of s.week.days) {
    lines.push(`${dayName(d, s)}:`);
    const entries = [
      ...d.fixed_commitments.map((c) => ({
        start: c.start_time,
        line: `${c.start_time}-${c.end_time} ${c.name} (fixed commitment: recurring, never moves, not deletable here${when(d.date, c.start_time, c.end_time, s.today, s.now)}) [${c.id}]`,
      })),
      ...d.blocks.map((b) => ({
        start: b.start_time,
        line: `${b.start_time}-${b.end_time} ${b.title} (${blockKind(b)}${b.moved_from ? `, moved from ${b.moved_from}` : ""}${when(d.date, b.start_time, b.end_time, s.today, s.now)})${b.notes ? ` note: ${String(b.notes).slice(0, 80)}` : ""} [${b.id}]`,
      })),
    ].sort((a, b) => mins(a.start) - mins(b.start));
    if (!entries.length) lines.push("  nothing scheduled");
    for (const e of entries) lines.push(`  ${e.line}`);
    const blocks = d.blocks.length;
    const fixed = d.fixed_commitments.length;
    lines.push(`  totals: ${blocks} block${blocks === 1 ? "" : "s"}, ${fixed} fixed commitment${fixed === 1 ? "" : "s"}`);
    if (d.free_windows?.length) lines.push(`  free: ${d.free_windows.map((w) => `${w.start_time}-${w.end_time}`).join(", ")}`);
  }
  const pending = (s.tasks ?? []).filter((t) => t.status === "pending" || t.status === "blocked");
  if (pending.length) {
    lines.push("PENDING TASKS (to-dos, not on the calendar until a task block is placed):");
    for (const t of pending.slice(0, 15)) {
      lines.push(`  ${t.name}${t.deadline ? `, due ${t.deadline}` : ""}${t.estimated_duration ? `, ~${t.estimated_duration} min` : ""}${t.priority && t.priority !== "normal" ? `, ${t.priority} priority` : ""}${t.status === "blocked" ? ", couldn't be placed" : ""}`);
    }
  }
  return lines.join("\n");
}
