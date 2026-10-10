-- Devices, pairing and the voice command relay. Copied from Rocky-Planner 0002.
-- ALREADY APPLIED on the live project; only run this on a fresh project.
-- Difference from the original: the realtime line only publishes devices + commands
-- (0001_rocky_schema.sql publishes the calendar tables).

-- Devices, pairing and the voice command relay (PLAN.md section 6).
-- SHARED CONTRACT: the `commands` row shape and claim_pair() are used by apps/web and apps/brain.

-- ---------- devices ----------
-- One laptop and one phone per account: apps/web upserts on (user_id, role).

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  role text not null check (role in ('laptop', 'phone')),
  name text,
  last_seen timestamptz not null default now(),
  -- 6 chars, Crockford-style alphabet (no 0 O 1 I L U), stored uppercase without the dash.
  pair_code text check (pair_code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{6}$'),
  pair_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, role),
  check ((pair_code is null) = (pair_expires_at is null))
);

-- ---------- commands ----------

create table public.commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  source text not null check (source in ('phone', 'laptop')),
  kind text not null check (kind in ('audio', 'text')),
  audio_path text, -- voice-clips/<user_id>/<command_id>.webm
  text text,
  status text not null default 'queued'
    check (status in ('queued', 'transcribing', 'thinking', 'done', 'error')),
  transcript text,
  reply_text text,
  diff jsonb, -- scheduler Diff that was applied (undo source)
  error text,
  stt_ms int, -- latency, shown in the debug panel
  llm_ms int,
  total_ms int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'audio' and audio_path is not null) or (kind = 'text' and text is not null))
);
create index commands_user_created_idx on public.commands (user_id, created_at desc);
create index commands_queued_idx on public.commands (user_id, created_at) where status = 'queued';

create trigger commands_updated_at
  before update on public.commands
  for each row execute function public.set_updated_at();

-- ---------- row level security ----------

alter table public.devices enable row level security;
alter table public.commands enable row level security;

create policy "own rows" on public.devices for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.commands for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------- pairing ----------
-- The phone claims the code its laptop is showing. Scoped to the caller's own laptop row, so a code
-- can never pair across accounts. No rate limit: the caller can already read their own pair_code
-- through RLS, so guessing gains nothing (and a raise would roll back any attempt counter anyway).
-- Errors are raised with stable words apps/web matches on: "expired", "account".
-- Returns { laptop_name, laptop_device_id, phone_device_id }.
create or replace function public.claim_pair(code text, phone_name text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  normalized text := upper(regexp_replace(coalesce(code, ''), '[^A-Za-z0-9]', '', 'g'));
  laptop public.devices;
  phone_id uuid;
begin
  if uid is null then
    raise exception 'Sign in first: no account on this request' using errcode = '28000';
  end if;

  select * into laptop
    from public.devices
   where user_id = uid and role = 'laptop' and pair_code = normalized
   for update;

  if not found then
    raise exception 'That code is not active for this account' using errcode = 'P0002';
  end if;

  if laptop.pair_expires_at <= now() then
    raise exception 'That pairing code has expired' using errcode = 'P0001';
  end if;

  -- Single use.
  update public.devices set pair_code = null, pair_expires_at = null where id = laptop.id;

  insert into public.devices (user_id, role, name, last_seen)
  values (uid, 'phone', coalesce(nullif(trim(phone_name), ''), 'Phone'), now())
  on conflict (user_id, role) do update
    set name = coalesce(nullif(trim(excluded.name), ''), public.devices.name), last_seen = now()
  returning id into phone_id;

  return jsonb_build_object(
    'laptop_name', coalesce(laptop.name, 'your laptop'),
    'laptop_device_id', laptop.id,
    'phone_device_id', phone_id
  );
end;
$$;

revoke all on function public.claim_pair(text, text) from public, anon;
grant execute on function public.claim_pair(text, text) to authenticated;

-- ---------- storage: voice clips ----------
-- Private bucket, path <user_id>/<command_id>.webm. The brain deletes clips after transcription.

insert into storage.buckets (id, name, public)
values ('voice-clips', 'voice-clips', false)
on conflict (id) do nothing;

create policy "voice clips: own folder" on storage.objects for all to authenticated
  using (bucket_id = 'voice-clips' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'voice-clips' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------- realtime ----------
-- event_exceptions is included so skipping/moving one occurrence ("cancel gym tomorrow") updates the phone.
-- Note: DELETE payloads only carry the primary key under RLS; clients should refetch on delete.

alter publication supabase_realtime add table
  public.commands, public.devices;
