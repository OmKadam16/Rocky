import type { CommitmentKind } from "../types";

export type DayCommitment = {
  name: string;
  type: CommitmentKind;
  days_of_week: number[];
  start_time: string;
  end_time: string;
  notes?: string;
};

export type DayAnalysis = {
  summary: string;
  wake_time?: string;
  sleep_time?: string;
  preferred_study_hours?: { start: string; end: string }[];
  commitments: DayCommitment[];
};

/**
 * Lenient time normalization before validation.
 * Accepts "H:MM", "HH:MM", "7am"/"7 pm"/"7:30pm" and pads to "HH:MM".
 * Returns null when unparseable (caller drops the optional field/entry).
 */
export function normalizeTimeToHHMM(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    const h12 = Number(ampm[1]);
    const mm = ampm[2] !== undefined ? Number(ampm[2]) : 0;
    if (!Number.isInteger(h12) || h12 < 1 || h12 > 12) return null;
    if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
    let h24 = h12 % 12;
    if (ampm[3] === "pm") h24 += 12;
    return `${String(h24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  const hmm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hmm) {
    const h = Number(hmm[1]);
    const m = Number(hmm[2]);
    if (!Number.isInteger(h) || h < 0 || h > 23) return null;
    if (!Number.isInteger(m) || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  return null;
}

export function normalizeCommitmentType(raw: unknown, nameForNotes = ""): { type: CommitmentKind; notesSuffix?: string } {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "class") return { type: "Class" };
  if (s === "work") return { type: "Work" };
  if (s === "gym") return { type: "Gym" };
  if (s === "other") return { type: "Other" };
  const original = String(raw ?? "").trim();
  const keep = original || nameForNotes;
  return { type: "Other", notesSuffix: keep ? `Original type: ${keep}` : undefined };
}

function minutesOf(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function cleanDays(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<number>();
  for (const n of v) {
    const i = typeof n === "number" ? n : Number(n);
    if (Number.isInteger(i) && i >= 0 && i <= 6) out.add(i);
  }
  return [...out].sort();
}

/**
 * Lenient validator for the day-analysis JSON.
 * - Times are normalized first ("7:00"->"07:00", "7pm"->"19:00").
 * - Invalid OPTIONAL fields (wake/sleep/bad study-hour entries) are dropped, not fatal.
 * - Invalid individual commitments (bad times/days/names) are dropped; the rest are kept.
 * Only missing summary / non-object / missing commitments array fail the whole payload.
 */
export function validateDayAnalysis(input: unknown): { ok: true; value: DayAnalysis } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Expected a JSON object." };
  const o = input as Record<string, unknown>;
  const summary = String(o.summary ?? "").trim();
  if (!summary) return { ok: false, error: "Missing summary." };
  const out: DayAnalysis = { summary: summary.slice(0, 2000), commitments: [] };
  if (o.wake_time !== undefined && o.wake_time !== null && String(o.wake_time).trim() !== "") {
    const w = normalizeTimeToHHMM(o.wake_time);
    if (w) out.wake_time = w;
  }
  if (o.sleep_time !== undefined && o.sleep_time !== null && String(o.sleep_time).trim() !== "") {
    const s = normalizeTimeToHHMM(o.sleep_time);
    if (s) out.sleep_time = s;
  }
  if (Array.isArray(o.preferred_study_hours)) {
    const hours: { start: string; end: string }[] = [];
    for (const h of o.preferred_study_hours) {
      if (!h || typeof h !== "object") continue;
      const s = normalizeTimeToHHMM((h as Record<string, unknown>).start);
      const e = normalizeTimeToHHMM((h as Record<string, unknown>).end);
      if (!s || !e) continue;
      if (minutesOf(e) <= minutesOf(s)) continue;
      hours.push({ start: s, end: e });
    }
    if (hours.length) out.preferred_study_hours = hours;
  }
  if (!Array.isArray(o.commitments)) return { ok: false, error: "Missing commitments array." };
  const commitments: DayCommitment[] = [];
  for (const c of o.commitments) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    const { type, notesSuffix } = normalizeCommitmentType(r.type, name);
    const days = cleanDays(r.days_of_week);
    if (!days.length) continue;
    const start = normalizeTimeToHHMM(r.start_time);
    const end = normalizeTimeToHHMM(r.end_time);
    if (!start || !end) continue;
    if (minutesOf(end) <= minutesOf(start)) continue;
    const notes = String(r.notes ?? "").trim();
    const merged = [notes, notesSuffix].filter(Boolean).join(" · ").slice(0, 500) || undefined;
    commitments.push({ name: name.slice(0, 120), type, days_of_week: days, start_time: start, end_time: end, notes: merged });
  }
  out.commitments = commitments;
  return { ok: true, value: out };
}

export const DAY_ANALYSIS_PROMPT = `Extract a usual day into strict JSON only (no prose). Shape: {"summary": string, "wake_time"?: "HH:MM", "sleep_time"?: "HH:MM", "preferred_study_hours"?: [{"start":"HH:MM","end":"HH:MM"}], "commitments": [{"name": string, "type": "Class"|"Work"|"Gym"|"Other", "days_of_week": number[] (0=Sun..6=Sat), "start_time":"HH:MM","end_time":"HH:MM","notes"?: string}]}. Map club/study-group/etc to "Other" and keep the original word in notes. Times as HH:MM (24h); "7pm" style is fine and will be normalized. Days: at least one per commitment, end after start.`;

export function buildDayAnalysisMessages(summaryText: string): { system: string; userText: string } {
  return {
    system: `${DAY_ANALYSIS_PROMPT}`,
    userText: `Usual day:\n${summaryText.slice(0, 4000)}`,
  };
}
