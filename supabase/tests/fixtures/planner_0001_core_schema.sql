-- Rocky core schema (PLAN.md section 3). SHARED CONTRACT: mirror changes in packages/core/src/types.ts.
-- Times are minutes since midnight in the user's local time: start 0-1439, end 1-1440 (1440 = midnight).
-- Weekdays are 0 = Sunday. Every table is owned by one user and protected by RLS (user_id = auth.uid()).

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

-- ---------- profiles ----------

create table public.profiles (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  full_name text,
  display_name text,
  school text,
  program text,
  year text,
  traits text[] not null default '{}',
  hobbies text[] not null default '{}',
  study_styles text[] not null default '{}',
  about_me text,
  theme text not null default 'system' check (theme in ('system', 'dark', 'light')),
  due_date_reminders boolean not null default true,
  wake_min int not null default 420 check (wake_min between 0 and 1439),
  sleep_min int not null default 1380 check (sleep_min between 1 and 1440),
  timezone text,
  created_at timestamptz not null default now()
);

-- Create a profile row for every new auth user.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- classes ----------

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(trim(name)) > 0),
  professor text,
  category text,
  code text,
  semester text,
  starts_on date,
  ends_on date,
  start_min int check (start_min between 0 and 1439),
  end_min int check (end_min between 1 and 1440),
  meeting_days int[] not null default '{}' check (meeting_days <@ array[0, 1, 2, 3, 4, 5, 6]),
  created_at timestamptz not null default now(),
  check (end_min is null or start_min is null or end_min > start_min),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index classes_user_idx on public.classes (user_id);

-- ---------- assignments ----------

create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  class_id uuid references public.classes on delete cascade, -- deleting a class deletes its assignments
  title text not null check (length(trim(title)) > 0),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  due_at timestamptz,
  created_at timestamptz not null default now()
);
create index assignments_user_due_idx on public.assignments (user_id, due_at);
create index assignments_class_idx on public.assignments (class_id);

-- ---------- tasks ----------

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null check (length(trim(title)) > 0),
  task_date date not null,
  done boolean not null default false,
  class_id uuid references public.classes on delete set null,
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index tasks_user_date_idx on public.tasks (user_id, task_date);

-- ---------- events ----------

create table public.events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null check (length(trim(title)) > 0),
  subtitle text,
  kind text not null default 'personal' check (kind in ('class', 'commitment', 'study', 'personal', 'break')),
  event_date date not null,
  start_min int not null check (start_min between 0 and 1439),
  end_min int not null check (end_min between 1 and 1440),
  fixed boolean not null default false,
  priority text not null default 'med' check (priority in ('high', 'med', 'low')),
  travel_min int not null default 0 check (travel_min between 0 and 240),
  class_id uuid references public.classes on delete cascade, -- set for blocks generated from a class
  repeat_freq text not null default 'none' check (repeat_freq in ('none', 'daily', 'weekly')),
  repeat_days int[] check (repeat_days is null or repeat_days <@ array[0, 1, 2, 3, 4, 5, 6]),
  repeat_until date,
  created_at timestamptz not null default now(),
  check (end_min > start_min),
  check (repeat_until is null or repeat_until >= event_date),
  check (class_id is null or (kind = 'class' and fixed))
);
create index events_user_date_idx on public.events (user_id, event_date);
create index events_user_repeat_idx on public.events (user_id) where repeat_freq <> 'none';
create unique index events_class_unique on public.events (class_id) where class_id is not null;

-- ---------- event_exceptions ----------

create table public.event_exceptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  event_id uuid not null references public.events on delete cascade,
  occurrence_date date not null, -- the series date being skipped or moved
  kind text not null check (kind in ('skip', 'move')),
  new_date date, -- move only; null = same date
  new_start_min int check (new_start_min between 0 and 1439),
  new_end_min int check (new_end_min between 1 and 1440),
  created_at timestamptz not null default now(),
  unique (event_id, occurrence_date),
  check (kind = 'skip' or (new_start_min is not null and new_end_min is not null and new_end_min > new_start_min))
);
create index event_exceptions_user_idx on public.event_exceptions (user_id);

-- ---------- class -> event sync ----------
-- A class with a schedule owns exactly one fixed weekly event. Keeping this in the database means
-- every client (web, brain) gets the same behavior. Runs as the caller, so RLS still applies.

create or replace function public.sync_class_event()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  has_schedule boolean := new.start_min is not null and new.end_min is not null and cardinality(new.meeting_days) > 0;
begin
  if not has_schedule then
    delete from public.events where class_id = new.id;
    return new;
  end if;

  update public.events
     set title = new.name,
         subtitle = coalesce(new.code, new.professor),
         event_date = coalesce(new.starts_on, event_date),
         start_min = new.start_min,
         end_min = new.end_min,
         repeat_days = new.meeting_days,
         repeat_until = new.ends_on
   where class_id = new.id;

  if not found then
    insert into public.events (user_id, title, subtitle, kind, event_date, start_min, end_min, fixed, class_id, repeat_freq, repeat_days, repeat_until)
    values (new.user_id, new.name, coalesce(new.code, new.professor), 'class', coalesce(new.starts_on, current_date),
            new.start_min, new.end_min, true, new.id, 'weekly', new.meeting_days, new.ends_on);
  end if;
  return new;
end;
$$;

create trigger classes_sync_event
  after insert or update on public.classes
  for each row execute function public.sync_class_event();
-- Deletes cascade through events.class_id and assignments.class_id.

-- ---------- row level security ----------

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.assignments enable row level security;
alter table public.tasks enable row level security;
alter table public.events enable row level security;
alter table public.event_exceptions enable row level security;

create policy "own rows" on public.profiles for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.classes for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.assignments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.tasks for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.events for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.event_exceptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
