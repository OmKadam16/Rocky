-- Static pair codes: one QR per user that never changes.
-- A successful claim no longer clears the laptop row's pair_code /
-- pair_expires_at, so the same code can be scanned any number of times.
-- Claiming still requires the caller's own signed-in session and an
-- unexpired code, so a leaked QR alone grants nothing.
-- Apply to the live project by hand (SQL editor) — migrations only run
-- on fresh projects.

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

  -- Static code: kept on the laptop row so the QR works forever.

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
