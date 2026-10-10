import Dexie, { type Table } from "dexie";
import type { FixedCommitmentRow, PreferencesRow, ScheduledBlockRow, TaskRow } from "../../shared/db";
import { currentUserId, isSupabaseConfigured } from "./supabase";
import { SupaTable, TABLES } from "./supaDb";

export interface ProfileRow {
  id: string;
  display_name: string | null;
  ai_mode: string;
  provider: string | null;
  model: string | null;
  voice: string | null;
  about_text: string | null;
  onboarding_done: boolean;
  /** Resume step for the onboarding flow; stored in extra on Supabase (no migration). */
  onboarding_step?: string | null;
  /** Whether the optional local Memory model is ready; stored in extra on Supabase. */
  memory_model_ready?: boolean | null;
  llm_key_enc: string | null;
  el_key_enc: string | null;
  email: string | null;
}

class RockyDB extends Dexie {
  fixed_commitments!: Table<FixedCommitmentRow, string>;
  tasks!: Table<TaskRow, string>;
  scheduled_blocks!: Table<ScheduledBlockRow, string>;
  preferences!: Table<PreferencesRow, number>;
  profiles!: Table<ProfileRow, string>;

  constructor() {
    super("RockyDB");
    this.version(1).stores({
      fixed_commitments: "id, name",
      tasks: "id, status, deadline",
      scheduled_blocks: "id, date, source_type, source_id",
      preferences: "id",
      profiles: "id",
    });
    this.version(2).stores({
      fixed_commitments: "id, name",
      tasks: "id, status, deadline",
      scheduled_blocks: "id, date, source_type, source_id",
      preferences: "id",
      profiles: "id",
    }).upgrade(() => {});
    this.version(3).stores({
      fixed_commitments: "id, name",
      tasks: "id, status, deadline, source_email_id",
      scheduled_blocks: "id, date, source_type, source_id",
      preferences: "id",
      profiles: "id",
    }).upgrade(async (tx) => {
      const tasks = await (tx as any).table("tasks").toArray();
      for (const t of tasks) {
        let changed = false;
        if ((t as any).title && !t.name) { t.name = (t as any).title; delete (t as any).title; changed = true; }
        if ((t as any).estimated_minutes && !t.estimated_duration) { t.estimated_duration = (t as any).estimated_minutes; delete (t as any).estimated_minutes; changed = true; }
        if (changed) await (tx as any).table("tasks").put(t);
      }
    });
    // v4: the email feature is gone; drop its index.
    this.version(4).stores({
      fixed_commitments: "id, name",
      tasks: "id, status, deadline",
      scheduled_blocks: "id, date, source_type, source_id",
      preferences: "id",
      profiles: "id",
    });
  }
}

/**
 * With Supabase configured, every table is the signed-in user's rows in the cloud (see supaDb.ts),
 * exposed through the same Dexie-style API so the rest of the app is unchanged. Without it (a clone
 * with no .env.local) Rocky keeps the original on-device database.
 */
function cloudDb(): RockyDB {
  return {
    fixed_commitments: new SupaTable(TABLES.fixed_commitments),
    tasks: new SupaTable(TABLES.tasks),
    scheduled_blocks: new SupaTable(TABLES.scheduled_blocks),
    preferences: new SupaTable(TABLES.preferences),
    profiles: new SupaTable(TABLES.profiles),
  } as unknown as RockyDB;
}

export const usingCloud = isSupabaseConfigured;
export const db: RockyDB = usingCloud ? cloudDb() : new RockyDB();

export async function ensureSeed() {
  // In the cloud the sign-up trigger creates both rows; only fill gaps for a signed-in user.
  if (usingCloud && !(await currentUserId())) return;
  const count = await db.preferences.count();
  if (count === 0) {
    await db.preferences.put({
      id: 1,
      earliest_start_time: "07:00",
      latest_end_time: "22:00",
      buffer_minutes_after_fixed_events: 15,
      preferred_study_hours: [],
    } as PreferencesRow);
  }
  const pCount = await db.profiles.count();
  if (pCount === 0) {
    await db.profiles.put({
      id: "local",
      display_name: null,
      ai_mode: "ai",
      provider: null,
      model: null,
      voice: null,
      about_text: null,
      onboarding_done: false,
      llm_key_enc: null,
      el_key_enc: null,
      email: null,
    });
  }
}

void ensureSeed().catch(() => {});
