export type EventStatus = "done" | "now" | "upcoming";

export type EventBlock = {
  id: string;
  title: string;
  startTime: string; // "16:00"
  endTime: string; // "17:00", "24:00" when a block runs to midnight
  status: EventStatus;
  /** Where the block came from: task work, a calendar event, or fixed. */
  kind: "task" | "event" | "fixed";
  subtext?: string; // "3 people", "leave by 17:50, 22 min drive"
  tag?: "new" | "moved";
  movedFrom?: string; // "16:00" if tag === "moved"
  color?: PastelColor;
  note?: string;
};

export type DaySummary = {
  /** ISO date, e.g. "2026-08-20" */
  date: string;
  /** "Mon" / "Thu" — column label in week view */
  weekdayShort: string;
  /** "17" / "20" — day-of-month, column label in week view */
  dayOfMonth: string;
  /** "Thursday · Aug 20 · 2026" — the day-view header line */
  longLabel: string;
  isToday: boolean;
  headline: string; // the big editorial sentence
  events: EventBlock[];
};

export type WeekSummary = {
  headline: string;
  days: DaySummary[];
};

export type AssistantState = "idle" | "listening" | "thinking" | "speaking";

export type AssistantTurn = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

export type ViewName = "day" | "week" | "month" | "search";

export type PageName = "calendar" | "fixed" | "assignments" | "dashboard" | "profile" | "memory" | "tasks";

export type Assignment = {
  id: string;
  name: string;
  course?: string | null;
  deadline: string;
  estimatedDuration: number;
  priority: "high" | "normal" | "low";
  chunks?: number;
  color?: PastelColor;
  notes?: string;
  status: "pending" | "scheduled" | "blocked" | "done";
};

export type CommitmentKind = "Class" | "Work" | "Gym" | "Other";

/** Short weekday labels, in week order. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export type PastelColor = "magenta" | "orange" | "green" | "red" | "blue" | "lavender";

export type Commitment = {
  id: string;
  name: string;
  kind: CommitmentKind;
  otherLabel?: string;
  days: Weekday[];
  start: string; // "09:00"
  end: string; // "11:30"
  color?: PastelColor;
  notes?: string;
  activeFrom?: string | null; // YYYY-MM-DD inclusive
  activeUntil?: string | null; // YYYY-MM-DD inclusive
};

export const PASTEL_ORDER: PastelColor[] = ["magenta", "orange", "green", "red", "blue", "lavender"];
