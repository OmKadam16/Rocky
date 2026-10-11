/**
 * A stand-in for src/lib/supabase.ts, used ONLY by the phone screenshot
 * harness (scripts/phone-screens.mjs via vite.mock.config.ts). Never shipped.
 * Signed in, one paired laptop + phone, a few calendar rows; realtime
 * channels subscribe instantly; every write succeeds and changes nothing.
 */
const UID = "00000000-0000-0000-0000-0000000000aa";

const today = new Date();
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const plus = (n: number) => {
  const d = new Date(today);
  d.setDate(d.getDate() + n);
  return iso(d);
};

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {
  devices: [
    { id: "lap", user_id: UID, role: "laptop", name: "Om's laptop", last_seen: new Date().toISOString(), pair_code: "K7P2QM9X", pair_expires_at: "2036-01-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z" },
    { id: "ph", user_id: UID, role: "phone", name: "My Android phone", last_seen: new Date().toISOString(), pair_code: null, pair_expires_at: null, created_at: "2026-10-01T00:00:00Z" },
  ],
  profiles: [{ user_id: UID, id: "local", display_name: "Om", ai_mode: "ai", provider: "OpenAI", model: "gpt-5-nano", onboarding_done: true, extra: { chat_memory: { facts: [{ id: "f1", text: "Prefers dinner around 8 PM", at: 1 }], summary: "", summarizedUpTo: 0 } } }],
  preferences: [{ user_id: UID, id: 1, earliest_start_time: "07:00", latest_end_time: "23:00", buffer_minutes_after_fixed_events: 15, preferred_study_hours: [] }],
  fixed_commitments: [
    { user_id: UID, id: "c1", name: "Chem 101", type: "Class", days_of_week: [0, 1, 2, 3, 4, 5, 6], start_time: "10:00", end_time: "11:30", color: null, other_label: null, notes: null, active_from: null, active_until: null },
  ],
  tasks: [],
  scheduled_blocks: [
    { user_id: UID, id: "b1", source_type: "event", source_id: null, title: "Gym", date: plus(0), start_time: "07:00", end_time: "08:00", previous_start_time: null, notes: null, created_at: "2026-10-01T00:00:00Z" },
    { user_id: UID, id: "b2", source_type: "task", source_id: null, title: "Study: organic chemistry", date: plus(0), start_time: "13:00", end_time: "15:00", previous_start_time: null, notes: null, created_at: "2026-10-01T00:00:00Z" },
    { user_id: UID, id: "b3", source_type: "event", source_id: null, title: "Dinner with Sam", date: plus(0), start_time: "20:00", end_time: "21:30", previous_start_time: null, notes: null, created_at: "2026-10-01T00:00:00Z" },
    { user_id: UID, id: "b4", source_type: "event", source_id: null, title: "Haircut", date: plus(1), start_time: "15:00", end_time: "16:00", previous_start_time: null, notes: null, created_at: "2026-10-01T00:00:00Z" },
  ],
  commands: [],
};

type Filter = (r: Row) => boolean;

function query(table: string) {
  const filters: Filter[] = [];
  let single: "one" | "maybe" | null = null;
  let limit = Infinity;
  let write = false;
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  const add = (f: Filter) => (filters.push(f), chain);
  Object.assign(chain, {
    select: self,
    eq: (k: string, v: unknown) => add((r) => !(k in r) || r[k] === v),
    neq: (k: string, v: unknown) => add((r) => r[k] !== v),
    in: (k: string, vs: unknown[]) => add((r) => vs.includes(r[k])),
    gte: (k: string, v: string) => add((r) => !(k in r) || String(r[k]) >= v),
    gt: (k: string, v: string) => add((r) => !(k in r) || String(r[k]) > v),
    lte: (k: string, v: string) => add((r) => !(k in r) || String(r[k]) <= v),
    lt: (k: string, v: string) => add((r) => !(k in r) || String(r[k]) < v),
    not: self,
    is: self,
    order: self,
    filter: self,
    match: self,
    limit: (n: number) => ((limit = n), chain),
    single: () => ((single = "one"), chain),
    maybeSingle: () => ((single = "maybe"), chain),
    insert: () => ((write = true), chain),
    update: () => ((write = true), chain),
    upsert: () => ((write = true), chain),
    delete: () => ((write = true), chain),
    then: (resolve: (v: unknown) => void) => {
      const rows = write ? [] : (TABLES[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, limit);
      const data = single ? (rows[0] ?? (write ? { id: "mock" } : null)) : rows;
      resolve({ data, error: null, count: rows.length });
    },
  });
  return chain;
}

const session = { user: { id: UID, email: "om@example.com", user_metadata: { display_name: "Om" } }, access_token: "mock", expires_at: 9e9 };

function channel() {
  const ch: Record<string, unknown> = {};
  Object.assign(ch, {
    on: () => ch,
    subscribe: (cb?: (s: string) => void) => {
      setTimeout(() => cb?.("SUBSCRIBED"), 10);
      return ch;
    },
    unsubscribe: async () => "ok",
  });
  return ch;
}

const client = {
  from: (t: string) => query(t),
  rpc: async () => ({ data: null, error: null }),
  channel,
  removeChannel: async () => "ok",
  auth: {
    getSession: async () => ({ data: { session }, error: null }),
    getUser: async () => ({ data: { user: session.user }, error: null }),
    onAuthStateChange: (cb: (e: string, s: unknown) => void) => {
      setTimeout(() => cb("INITIAL_SESSION", session), 0);
      return { data: { subscription: { unsubscribe() {} } } };
    },
    signOut: async () => ({ error: null }),
  },
  storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) },
};

export const isSupabaseConfigured = true;
export function supabase() {
  return client as never;
}
export async function currentUserId(): Promise<string | null> {
  return UID;
}
export function uniqueChannel(base: string): string {
  return `${base}:${Math.random().toString(36).slice(2)}`;
}
