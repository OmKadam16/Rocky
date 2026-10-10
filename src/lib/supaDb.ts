import { currentUserId, supabase, uniqueChannel } from "./supabase";

/**
 * A small Dexie-compatible facade over Supabase tables.
 *
 * Rocky v1 talks to Dexie everywhere (`db.tasks.get`, `db.scheduled_blocks.where("date").between(...)`).
 * This class implements exactly the subset of that API the app uses, backed by Postgres rows owned by
 * the signed-in user (RLS), so the views, hooks and planner tools keep working unchanged.
 *
 * Row mapping: known columns go to their own columns; anything else a caller puts on a row is kept
 * in the `extra` jsonb column and merged back on read, so no field is silently dropped.
 */

type Row = Record<string, unknown>;

type TableSpec = {
  name: string;
  columns: readonly string[];
  /** "per-user": one row per user (profiles, preferences), the Dexie key is ignored. */
  mode: "keyed" | "per-user";
  /** Fields that must never leave the device. */
  localOnly?: readonly string[];
  /** Defaults merged into rows read back, mirroring v1's single-row ids. */
  readDefaults?: Row;
};

const SERVER_ONLY = new Set(["user_id", "extra", "updated_at"]);

export const TABLES = {
  profiles: {
    name: "profiles",
    mode: "per-user",
    columns: ["id", "email", "display_name", "ai_mode", "provider", "model", "voice", "about_text", "onboarding_done"],
    localOnly: ["llm_key_enc", "el_key_enc"],
    readDefaults: { id: "local" },
  },
  preferences: {
    name: "preferences",
    mode: "per-user",
    columns: ["id", "earliest_start_time", "latest_end_time", "buffer_minutes_after_fixed_events", "preferred_study_hours"],
    readDefaults: { id: 1 },
  },
  fixed_commitments: {
    name: "fixed_commitments",
    mode: "keyed",
    columns: ["id", "name", "type", "days_of_week", "start_time", "end_time", "color", "other_label", "notes", "active_from", "active_until"],
  },
  tasks: {
    name: "tasks",
    mode: "keyed",
    columns: ["id", "name", "deadline", "estimated_duration", "priority", "linked_class_or_project", "status", "conflict_reason", "color"],
  },
  scheduled_blocks: {
    name: "scheduled_blocks",
    mode: "keyed",
    columns: ["id", "source_type", "source_id", "title", "date", "start_time", "end_time", "previous_start_time", "notes", "created_at"],
  },
} as const satisfies Record<string, TableSpec>;

/** Device-only values (API keys) live in localStorage, scoped per user. Phase 2 moves keys server-side. */
const localKey = (uid: string, field: string) => `vc-local-${uid}-${field}`;
function readLocal(uid: string, fields: readonly string[]): Row {
  const out: Row = {};
  for (const f of fields) {
    try {
      const v = localStorage.getItem(localKey(uid, f));
      out[f] = v === null ? null : v;
    } catch {
      out[f] = null;
    }
  }
  return out;
}
function writeLocal(uid: string, row: Row, fields: readonly string[]) {
  for (const f of fields) {
    if (!(f in row)) continue;
    const v = row[f];
    try {
      if (v === null || v === undefined || v === "") localStorage.removeItem(localKey(uid, f));
      else localStorage.setItem(localKey(uid, f), String(v));
    } catch {
      /* storage unavailable: the key simply is not remembered */
    }
  }
}

export function toDbRow(spec: TableSpec, row: Row, uid: string): Row {
  const out: Row = { user_id: uid };
  const extra: Row = {};
  const cols = new Set(spec.columns);
  const localOnly = new Set(spec.localOnly ?? []);
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || localOnly.has(k) || SERVER_ONLY.has(k)) continue;
    if (cols.has(k)) out[k] = v;
    else extra[k] = v;
  }
  out.extra = extra;
  return out;
}

export function fromDbRow(spec: TableSpec, row: Row): Row {
  const { extra, user_id: _u, updated_at: _up, ...rest } = row;
  void _u;
  void _up;
  return { ...(spec.readDefaults ?? {}), ...((extra as Row | null) ?? {}), ...rest };
}

type Filter =
  | { op: "eq"; field: string; value: unknown }
  | { op: "between"; field: string; lo: unknown; hi: unknown; incLo: boolean; incHi: boolean };

/** Notify the app that data changed (used by hooks to refetch). */
export function emitDataChange(table: string) {
  try {
    window.dispatchEvent(new CustomEvent("vc-data-change", { detail: { table } }));
    if (table === "tasks" || table === "scheduled_blocks") window.dispatchEvent(new Event("vc-tasks-update"));
    if (table === "profiles") window.dispatchEvent(new Event("vc-profile-update"));
  } catch {
    /* not in a browser */
  }
}

async function requireUid(): Promise<string> {
  const uid = await currentUserId();
  if (!uid) throw new Error("Not signed in.");
  return uid;
}

class SupaCollection<T extends Row> {
  constructor(
    private table: SupaTable<T>,
    private filters: Filter[] = [],
    private order: { field: string; desc: boolean } | null = null,
    private predicates: ((row: T) => boolean)[] = [],
  ) {}

  equals(value: unknown) {
    const last = this.filters[this.filters.length - 1];
    if (!last || last.op !== "eq") throw new Error("equals() must follow where()");
    return new SupaCollection<T>(this.table, [...this.filters.slice(0, -1), { ...last, value }], this.order, this.predicates);
  }

  between(lo: unknown, hi: unknown, incLo = true, incHi = false) {
    const last = this.filters[this.filters.length - 1];
    if (!last) throw new Error("between() must follow where()");
    return new SupaCollection<T>(this.table, [...this.filters.slice(0, -1), { op: "between", field: last.field, lo, hi, incLo, incHi }], this.order, this.predicates);
  }

  filter(fn: (row: T) => boolean) {
    return new SupaCollection<T>(this.table, this.filters, this.order, [...this.predicates, fn]);
  }

  reverse() {
    return new SupaCollection<T>(this.table, this.filters, this.order ? { ...this.order, desc: !this.order.desc } : { field: "id", desc: true }, this.predicates);
  }

  async toArray(): Promise<T[]> {
    const rows = await this.table._select(this.filters, this.order);
    return this.predicates.length ? rows.filter((r) => this.predicates.every((p) => p(r))) : rows;
  }

  async first(): Promise<T | undefined> {
    return (await this.toArray())[0];
  }

  async count(): Promise<number> {
    return (await this.toArray()).length;
  }

  async delete(): Promise<number> {
    if (this.predicates.length) {
      const rows = await this.toArray();
      for (const r of rows) await this.table.delete(r.id as string);
      return rows.length;
    }
    return this.table._deleteWhere(this.filters);
  }
}

export class SupaTable<T extends Row> {
  constructor(private spec: TableSpec) {}

  private q() {
    return supabase().from(this.spec.name);
  }

  async _select(filters: Filter[], order: { field: string; desc: boolean } | null): Promise<T[]> {
    let query = this.q().select("*");
    for (const f of filters) {
      if (f.op === "eq") query = query.eq(f.field, f.value as never);
      else {
        query = f.incLo ? query.gte(f.field, f.lo as never) : query.gt(f.field, f.lo as never);
        query = f.incHi ? query.lte(f.field, f.hi as never) : query.lt(f.field, f.hi as never);
      }
    }
    if (order) {
      // Dexie's orderBy walks an index, which skips rows where the field is missing.
      query = query.not(order.field, "is", null).order(order.field, { ascending: !order.desc });
    }
    const { data, error } = await query;
    if (error) throw new Error(`${this.spec.name}: ${error.message}`);
    const uid = this.spec.localOnly ? await currentUserId() : null;
    return (data ?? []).map((r) => {
      const row = fromDbRow(this.spec, r as Row);
      return (uid ? { ...row, ...readLocal(uid, this.spec.localOnly!) } : row) as T;
    });
  }

  async _deleteWhere(filters: Filter[]): Promise<number> {
    const uid = await requireUid();
    let query = this.q().delete({ count: "exact" }).eq("user_id", uid);
    for (const f of filters) {
      if (f.op === "eq") query = query.eq(f.field, f.value as never);
      else {
        query = f.incLo ? query.gte(f.field, f.lo as never) : query.gt(f.field, f.lo as never);
        query = f.incHi ? query.lte(f.field, f.hi as never) : query.lt(f.field, f.hi as never);
      }
    }
    const { error, count } = await query;
    if (error) throw new Error(`${this.spec.name}: ${error.message}`);
    emitDataChange(this.spec.name);
    return count ?? 0;
  }

  async get(key: unknown): Promise<T | undefined> {
    if (this.spec.mode === "per-user") {
      const rows = await this._select([], null);
      return rows[0];
    }
    const rows = await this._select([{ op: "eq", field: "id", value: key }], null);
    return rows[0];
  }

  async toArray(): Promise<T[]> {
    return this._select([], null);
  }

  async count(): Promise<number> {
    return (await this.toArray()).length;
  }

  where(field: string) {
    return new SupaCollection<T>(this, [{ op: "eq", field, value: undefined }]);
  }

  orderBy(field: string) {
    return new SupaCollection<T>(this, [], { field, desc: false });
  }

  async put(row: T): Promise<unknown> {
    await this.bulkPut([row]);
    return this.spec.mode === "per-user" ? (row as Row).id : (row as Row).id;
  }

  async bulkPut(rows: T[]): Promise<void> {
    if (!rows.length) return;
    const uid = await requireUid();
    if (this.spec.localOnly) for (const r of rows) writeLocal(uid, r, this.spec.localOnly);
    const payload = rows.map((r) => toDbRow(this.spec, r, uid));
    const onConflict = this.spec.mode === "per-user" ? "user_id" : "user_id,id";
    const { error } = await this.q().upsert(payload, { onConflict });
    if (error) throw new Error(`${this.spec.name}: ${error.message}`);
    emitDataChange(this.spec.name);
  }

  async update(key: unknown, changes: Partial<T>): Promise<number> {
    const existing = await this.get(key);
    if (!existing) return 0;
    await this.put({ ...existing, ...changes } as T);
    return 1;
  }

  async delete(key: unknown): Promise<void> {
    const uid = await requireUid();
    let query = this.q().delete().eq("user_id", uid);
    if (this.spec.mode === "keyed") query = query.eq("id", key as never);
    const { error } = await query;
    if (error) throw new Error(`${this.spec.name}: ${error.message}`);
    emitDataChange(this.spec.name);
  }

  /**
   * Dexie's clear() empties the table. For the per-user profile row, clearing means "forget this
   * person on this device" (v1 called it on sign-out), so it only drops device-local fields and
   * never deletes the account's profile in the cloud.
   */
  async clear(): Promise<void> {
    if (this.spec.name === "profiles") {
      const uid = await currentUserId();
      if (uid && this.spec.localOnly) writeLocal(uid, Object.fromEntries(this.spec.localOnly.map((f) => [f, null])), this.spec.localOnly);
      return;
    }
    await this._deleteWhere([]);
  }
}

/** Live updates: one subscription per signed-in session, fanned out as window events. */
let realtimeStop: (() => void) | null = null;
export function startRealtime() {
  stopRealtime();
  const sb = supabase();
  const channel = sb.channel(uniqueChannel("rocky-data"));
  for (const t of Object.values(TABLES)) {
    channel.on("postgres_changes", { event: "*", schema: "public", table: t.name }, () => emitDataChange(t.name));
  }
  channel.subscribe();
  realtimeStop = () => {
    void sb.removeChannel(channel);
  };
}
export function stopRealtime() {
  realtimeStop?.();
  realtimeStop = null;
}
