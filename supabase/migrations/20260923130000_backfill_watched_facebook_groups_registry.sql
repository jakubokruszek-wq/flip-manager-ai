begin;

-- Canonical-runtime-group-source mission: the Watcher scheduler, manual
-- enqueue path, and cron previously required a source to appear in the
-- hardcoded FACEBOOK_PRODUCTION_SOURCES array (features/collector/
-- facebook-production.ts) before it would ever be scanned, even if it also
-- had a real watched_facebook_groups row -- meaning an operator-imported
-- group could never actually be collected without a code change and
-- redeploy. The paired application change makes watched_facebook_groups
-- itself the only runtime gate (enabled=true + a normalizable URL). This
-- migration promotes every historical FACEBOOK_PRODUCTION_SOURCES entry
-- into a real row, so that switch does not stop scanning anything that was
-- already being scanned.
--
-- name_verified distinguishes a row whose name was genuinely captured
-- (from the app's own add/import flow, which has required a real,
-- human-provided name since the group-registry hardening patch) from one
-- backfilled here with no known name. The display layer (features/
-- facebook-groups/display-name.ts) renders "Nieznana grupa" for any row
-- with name_verified=false, regardless of what this column's own name
-- value happens to be -- so setting name to the literal "Nieznana grupa"
-- here is a convenience for anyone inspecting the row directly, not the
-- mechanism that keeps a bare numeric ID out of the UI.
--
-- No real group name is invented for any of these seven sources: none of
-- them has ever had its actual Facebook-displayed name captured anywhere
-- in this codebase.
alter table public.watched_facebook_groups
  add column if not exists name_verified boolean not null default true;

comment on column public.watched_facebook_groups.name_verified is
  'false only for rows backfilled from the historical FACEBOOK_PRODUCTION_SOURCES allowlist whose real Facebook-displayed name was never captured. The display layer must render "Nieznana grupa" instead of this row''s name whenever this is false. Every row created through the app''s own add/import flow requires a real name and is therefore true.';

-- If an operator already created one of these historical rows before this
-- migration, preserve any genuinely supplied human name. Only mark the
-- legacy synthetic/numeric labels as unverified so an old row cannot leak an
-- identifier into a primary UI label after the registry becomes canonical.
update public.watched_facebook_groups
set name_verified = false
where url in (
  'https://www.facebook.com/groups/lodzsprzedazzakupwynajem/',
  'https://www.facebook.com/groups/402796264871862/',
  'https://www.facebook.com/groups/2928219830782023/',
  'https://www.facebook.com/groups/1253809205540869/',
  'https://www.facebook.com/groups/1424921570856189/',
  'https://www.facebook.com/groups/1689328011096404/',
  'https://www.facebook.com/profile.php?id=61563667387467'
)
and (
  trim(coalesce(name, '')) = ''
  or trim(name) ~ '^[0-9]{5,30}$'
  or lower(trim(name)) = lower(
    'Facebook group ' || case
      when position('/groups/' in url) > 0 then split_part(split_part(url, '/groups/', 2), '/', 1)
      when position('id=' in url) > 0 then split_part(split_part(url, 'id=', 2), '&', 1)
      else null
    end
  )
);

-- Idempotent: ON CONFLICT (url) DO NOTHING makes this safe to run more than
-- once, and safe to run whether or not an operator has already manually
-- added any of these same URLs through the app before this migration ran.
insert into public.watched_facebook_groups (name, url, city, priority, enabled, access_status, name_verified)
values
  ('Nieznana grupa', 'https://www.facebook.com/groups/lodzsprzedazzakupwynajem/', 'Łódź', 'high', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/groups/402796264871862/', 'Łódź', 'normal', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/groups/2928219830782023/', 'Łódź', 'normal', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/groups/1253809205540869/', 'Łódź', 'normal', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/groups/1424921570856189/', 'Łódź', 'normal', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/groups/1689328011096404/', 'Łódź', 'normal', true, 'CONNECTED', false),
  ('Nieznana grupa', 'https://www.facebook.com/profile.php?id=61563667387467', 'Łódź', 'normal', true, 'CONNECTED', false)
on conflict (url) do nothing;

commit;

-- Rollback (in this order): if the seven backfilled rows must also be
-- removed, first run `delete from public.watched_facebook_groups where
-- name_verified = false and access_status = 'CONNECTED' and
-- imported_posts_count = 0;` (scoped to rows this migration could
-- plausibly have created and that have never recorded any real activity,
-- so it can never delete a row an operator has since started relying on),
-- then `alter table public.watched_facebook_groups drop column
-- name_verified;`. Dropping only the column and keeping the seven rows
-- (now defaulting name_verified back to true) is also a safe, simpler
-- partial rollback if the backfilled rows are still wanted.
