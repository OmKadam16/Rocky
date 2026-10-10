-- 8-char pair codes. The devices pair_code CHECK accepts 6 or 8 Crockford
-- chars so existing (legacy 6-char) rows keep working; all newly generated
-- codes are 8 chars. Apply to the live project by hand (SQL editor) —
-- migrations only run on fresh projects.

alter table public.devices drop constraint if exists devices_pair_code_check;
alter table public.devices
  add constraint devices_pair_code_check
  check (pair_code ~ '^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{6}([ABCDEFGHJKMNPQRSTVWXYZ2-9]{2})?$');
