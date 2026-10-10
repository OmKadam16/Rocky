/** Row shapes as they come back from Supabase. Shared by the client and the planner server. */

export type FixedCommitmentRow = {
  id: string;
  name: string;
  type: string;
  /** JS weekday numbers: 0 = Sunday … 6 = Saturday */
  days_of_week: number[];
  start_time: string;
  end_time: string;
  color?: string | null;
  other_label?: string | null;
  notes?: string | null;
  active_from?: string | null;
  active_until?: string | null;
};

export type TaskRow = {
  id: string;
  name: string;
  deadline: string | null;
  estimated_duration: number;
  priority: "high" | "normal" | "low";
  linked_class_or_project: string | null;
  status: "pending" | "scheduled" | "in_progress" | "done" | "blocked";
  conflict_reason: string | null;
  color?: string | null;
};

export type ScheduledBlockRow = {
  id: string;
  source_type: "task" | "event" | "fixed";
  source_id: string | null;
  title: string;
  date: string;
  start_time: string;
  end_time: string;
  previous_start_time: string | null;
  created_at: string;
  notes?: string | null;
};

export type PreferencesRow = {
  id: number;
  earliest_start_time: string;
  latest_end_time: string;
  buffer_minutes_after_fixed_events: number;
  preferred_study_hours: { start: string; end: string }[];
};
