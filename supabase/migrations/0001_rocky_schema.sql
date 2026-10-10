-- Rocky schema: v1 row shapes (shared/db.ts) moved from the browser (Dexie) into Supabase,
-- one owner per row, protected by RLS (user_id = auth.uid()).
--
-- The live project previously held the Rocky-Planner prototype tables. They are empty and are
-- replaced here. devices / commands / claim_pair() are kept (see 0002) and are not touched.
--
-- Run once in the Supabase SQL editor.

-- ---------- remove the Rocky-Planner prototype tables (empty) ----------

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.sync_class_event() cascade;
drop table if exists public.event_exceptions cascade;
drop table if exists public.events cascade;
drop table if exists public.assignments cascade;
drop table if exists public.classes cascade;
drop table if exists public.tasks cascade;
drop table if exists public.profiles cascade;

-- ---------- helpers ----------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- profiles (one row per user; v1 used id 'local') ----------
-- API keys are NOT stored here. In Phase 1 they stay on the device (browser storage or the
-- desktop keychain); Phase 2 moves them to a server-only store.

create table public.profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  id text not null default 'local',
  email text,
  display_name text,
  ai_mode text not null default 'ai',
  provider text,
  model text,
  voice text,
  about_text text,
  onboarding_done boolean not null default false,
  gmail_email text,
  gmail_connected boolean not null default false,
  drive_connected boolean not null default false,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- preferences (one row per user; v1 used id 1) ----------

create table public.preferences (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  id int not null default 1,
  earliest_start_time text not null default '07:00',
  latest_end_time text not null default '22:00',
  buffer_minutes_after_fixed_events int not null default 15,
  preferred_study_hours jsonb not null default '[]'::jsonb,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger preferences_updated_at before update on public.preferences
  for each row execute function public.set_updated_at();

-- ---------- fixed_commitments: classes, shifts, standing appointments (never moved) ----------

create table public.fixed_commitments (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  name text not null,
  type text not null default 'class',
  days_of_week int[] not null default '{}' check (days_of_week <@ array[0, 1, 2, 3, 4, 5, 6]),
  start_time text not null,
  end_time text not null,
  color text,
  other_label text,
  notes text,
  active_from text,
  active_until text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- ---------- tasks: work needing a slot; assignments are tasks with a deadline ----------

create table public.tasks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  name text not null,
  deadline text,
  estimated_duration int not null default 60,
  priority text not null default 'normal' check (priority in ('high', 'normal', 'low')),
  linked_class_or_project text,
  status text not null default 'pending'
    check (status in ('pending', 'scheduled', 'in_progress', 'done', 'blocked')),
  conflict_reason text,
  color text,
  source_email_id text,
  source_email_subject text,
  source_email_from text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index tasks_user_status_idx on public.tasks (user_id, status);
create index tasks_user_deadline_idx on public.tasks (user_id, deadline);

-- ---------- scheduled_blocks: anything occupying time ----------

create table public.scheduled_blocks (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  id text not null,
  source_type text not null check (source_type in ('task', 'event', 'fixed')),
  source_id text,
  title text not null,
  date text not null,
  start_time text not null,
  end_time text not null,
  previous_start_time text,
  notes text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index scheduled_blocks_user_date_idx on public.scheduled_blocks (user_id, date);
create index scheduled_blocks_user_source_idx on public.scheduled_blocks (user_id, source_id);

-- ---------- new users get a profile + default preferences ----------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (user_id) do nothing;
  insert into public.preferences (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.preferences enable row level security;
alter table public.fixed_commitments enable row level security;
alter table public.tasks enable row level security;
alter table public.scheduled_blocks enable row level security;

create policy "own rows" on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.preferences for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.fixed_commitments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.scheduled_blocks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- realtime: phone and laptop see each other's changes ----------

alter publication supabase_realtime add table
  public.profiles, public.preferences, public.fixed_commitments, public.tasks, public.scheduled_blocks;
