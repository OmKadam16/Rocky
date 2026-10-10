// Applies supabase/migrations to an in-process Postgres (PGlite) with minimal stand-ins for
// Supabase's auth/storage schemas, then checks RLS, the new-user trigger and claim_pair.
// A second suite replays the live project's history (Rocky-Planner 0001 + 0002 already applied)
// and then runs 0001_rocky_schema.sql, which is exactly what Om runs in the SQL editor.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const FIXTURES = join(import.meta.dirname, "fixtures");
const ALICE = "00000000-0000-0000-0000-00000000000a";
const BOB = "00000000-0000-0000-0000-00000000000b";

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to authenticated, anon;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  create publication supabase_realtime;
`;

const SUPABASE_GRANTS = `
  grant usage on schema public, storage to authenticated;
  grant all on all tables in schema public to authenticated;
  grant all on storage.objects to authenticated;
  grant usage, select on all sequences in schema public to authenticated;
`;

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function as(db: PGlite, user: string, fn: (q: Q) => Promise<unknown>) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
    await tx.query("set local role authenticated");
    return fn(async (sql, params) => (await tx.query<Record<string, unknown>>(sql, params)).rows);
  });
}

const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

async function addUsers(db: PGlite) {
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'a@example.com', '{"display_name":"Alice"}'), ($2, 'b@example.com', '{}')`,
    [ALICE, BOB],
  );
}

describe("fresh project: all migrations in order", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_STUBS);
    for (const f of migrationFiles()) await db.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    await db.exec(SUPABASE_GRANTS);
    await addUsers(db);
  });

  it("creates a profile and default preferences for each new user", async () => {
    const p = (await db.query("select user_id, email, display_name, onboarding_done from public.profiles order by user_id")).rows;
    expect(p).toEqual([
      { user_id: ALICE, email: "a@example.com", display_name: "Alice", onboarding_done: false },
      { user_id: BOB, email: "b@example.com", display_name: null, onboarding_done: false },
    ]);
    const pr = (await db.query("select user_id, earliest_start_time, buffer_minutes_after_fixed_events from public.preferences order by user_id")).rows;
    expect(pr).toEqual([
      { user_id: ALICE, earliest_start_time: "07:00", buffer_minutes_after_fixed_events: 15 },
      { user_id: BOB, earliest_start_time: "07:00", buffer_minutes_after_fixed_events: 15 },
    ]);
  });

  it("isolates users with RLS and defaults user_id to auth.uid()", async () => {
    await as(db, ALICE, (q) => q(`insert into public.tasks (id, name) values ('t1', 'Problem set')`));
    await as(db, ALICE, (q) => q(`insert into public.scheduled_blocks (id, source_type, title, date, start_time, end_time) values ('b1', 'event', 'Gym', '2026-10-12', '19:00', '20:00')`));
    expect(await as(db, ALICE, (q) => q("select name from public.tasks"))).toEqual([{ name: "Problem set" }]);
    expect(await as(db, BOB, (q) => q("select name from public.tasks"))).toEqual([]);
    expect(await as(db, BOB, (q) => q("select title from public.scheduled_blocks"))).toEqual([]);
    await expect(as(db, BOB, (q) => q(`insert into public.tasks (user_id, id, name) values ($1, 't2', 'Sneaky')`, [ALICE]))).rejects.toThrow(/row-level security/);
  });

  it("lets two users use the same client-side id", async () => {
    await as(db, BOB, (q) => q(`insert into public.tasks (id, name) values ('t1', 'Bob task')`));
    expect(await as(db, BOB, (q) => q("select name from public.tasks where id = 't1'"))).toEqual([{ name: "Bob task" }]);
  });

  it("upserts on (user_id, id), which is what the app's put() does", async () => {
    await as(db, ALICE, (q) => q(`insert into public.tasks (id, name, status) values ('t1', 'Problem set v2', 'scheduled') on conflict (user_id, id) do update set name = excluded.name, status = excluded.status`));
    expect(await as(db, ALICE, (q) => q("select name, status from public.tasks where id = 't1'"))).toEqual([{ name: "Problem set v2", status: "scheduled" }]);
  });

  it("rejects bad enum values", async () => {
    await expect(as(db, ALICE, (q) => q(`insert into public.tasks (id, name, status) values ('t9', 'x', 'nope')`))).rejects.toThrow();
    await expect(as(db, ALICE, (q) => q(`insert into public.fixed_commitments (id, name, start_time, end_time, days_of_week) values ('c9', 'x', '09:00', '10:00', '{7}')`))).rejects.toThrow();
  });

  it("does not let a signed-in user call handle_new_user directly", async () => {
    await expect(as(db, ALICE, (q) => q("select public.handle_new_user()"))).rejects.toThrow();
  });

  it("keeps claim_pair working (devices from 0002)", async () => {
    await as(db, ALICE, (q) => q(`insert into public.devices (role, name, pair_code, pair_expires_at) values ('laptop', 'Laptop', 'ABCDEFGH', now() + interval '5 minutes')`));
    const r = (await as(db, ALICE, (q) => q(`select public.claim_pair('ABCD-EFGH', 'Phone') as r`))) as { r: { laptop_name: string } }[];
    expect(r[0].r.laptop_name).toBe("Laptop");
    await expect(as(db, BOB, (q) => q(`select public.claim_pair('ABCDEFGH')`))).rejects.toThrow();
  });

  it("keeps static pair codes across claims (0003: no single-use clear)", async () => {
    const r2 = (await as(db, ALICE, (q) => q(`select public.claim_pair('ABCDEFGH', 'Phone 2') as r`))) as { r: { laptop_name: string } }[];
    expect(r2[0].r.laptop_name).toBe("Laptop");
    expect(await as(db, ALICE, (q) => q("select pair_code from public.devices where role = 'laptop'"))).toEqual([
      { pair_code: "ABCDEFGH" },
    ]);
  });

  it("still accepts legacy 6-char codes (0004: 6 or 8 chars)", async () => {
    await as(db, BOB, (q) => q(`insert into public.devices (role, name, pair_code, pair_expires_at) values ('laptop', 'Laptop', 'ABCDEF', now() + interval '5 minutes')`));
    const r = (await as(db, BOB, (q) => q(`select public.claim_pair('ABC-DEF', 'Phone') as r`))) as { r: { laptop_name: string } }[];
    expect(r[0].r.laptop_name).toBe("Laptop");
    await expect(
      as(db, BOB, (q) => q(`update public.devices set pair_code = 'ABCDE', pair_expires_at = now() where role = 'phone'`)),
    ).rejects.toThrow(/pair_code/);
  });
});

describe("live project: Rocky-Planner history, then 0001_rocky_schema.sql", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(SUPABASE_STUBS);
    await db.exec(readFileSync(join(FIXTURES, "planner_0001_core_schema.sql"), "utf8"));
    await db.exec(readFileSync(join(FIXTURES, "planner_0002_devices_commands.sql"), "utf8"));
    await db.exec(SUPABASE_GRANTS);
    // A paired laptop survives the schema swap.
    await db.query(`insert into auth.users (id, email) values ($1, 'a@example.com')`, [ALICE]);
    await as(db, ALICE, (q) => q(`insert into public.devices (role, name) values ('laptop', 'Laptop')`));
    await db.exec(readFileSync(join(MIGRATIONS, "0001_rocky_schema.sql"), "utf8"));
    await db.exec(SUPABASE_GRANTS);
  });

  it("replaces the prototype tables with the Rocky ones", async () => {
    const t = (await db.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' order by table_name`)).rows.map((r) => r.table_name);
    expect(t).toEqual(["commands", "devices", "fixed_commitments", "preferences", "profiles", "scheduled_blocks", "tasks"]);
  });

  it("keeps devices and the new-user trigger works with the new profile shape", async () => {
    expect(await as(db, ALICE, (q) => q("select name from public.devices"))).toEqual([{ name: "Laptop" }]);
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'b@example.com', '{"full_name":"Bob B"}')`, [BOB]);
    expect((await db.query("select display_name from public.profiles where user_id = $1", [BOB])).rows).toEqual([{ display_name: "Bob B" }]);
  });

  it("publishes the new tables to realtime", async () => {
    const pub = (await db.query<{ tablename: string }>(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename`)).rows.map((r) => r.tablename);
    expect(pub).toEqual(expect.arrayContaining(["commands", "devices", "fixed_commitments", "preferences", "profiles", "scheduled_blocks", "tasks"]));
    expect(pub).not.toContain("events");
  });
});
