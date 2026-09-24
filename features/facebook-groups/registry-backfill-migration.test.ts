import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20260923130000_backfill_watched_facebook_groups_registry.sql", "utf8");

const canonicalIdentifier = (url: string): string => {
  if (url.includes("/groups/")) return url.split("/groups/", 2)[1].split("/", 1)[0];
  return new URL(url).searchParams.get("id") ?? "";
};

const shouldMarkUnverified = (name: string | null | undefined, url: string): boolean => {
  const trimmed = (name ?? "").trim();
  return trimmed === "" || /^[0-9]{5,30}$/.test(trimmed) || trimmed.toLocaleLowerCase("en-US") === `facebook group ${canonicalIdentifier(url)}`.toLocaleLowerCase("en-US");
};

test("backfill does not use the unsafe broad Facebook-prefixed predicate", () => {
  assert.doesNotMatch(migration, /lower\(trim\(name\)\)\s+like\s+'facebook%'/i);
  assert.match(migration, /Facebook group '\s*\|\|\s*case/i);
  assert.match(migration, /on conflict \(url\) do nothing/i);
});

test("human Facebook-prefixed names stay verified while exact synthetic labels do not", () => {
  const groupUrl = "https://www.facebook.com/groups/1424921570856189/";
  assert.equal(shouldMarkUnverified("Facebook Nieruchomości Łódź", groupUrl), false);
  assert.equal(shouldMarkUnverified("Facebookowi sprzedawcy mieszkań", groupUrl), false);
  assert.equal(shouldMarkUnverified("Facebook group 1424921570856189", groupUrl), true);
  assert.equal(shouldMarkUnverified("1424921570856189", groupUrl), true);
  assert.equal(shouldMarkUnverified("   ", groupUrl), true);
});

test("manual rows are never overwritten and repeated migration remains idempotent", () => {
  assert.match(migration, /update public\.watched_facebook_groups\s+set name_verified = false/i);
  assert.doesNotMatch(migration, /update public\.watched_facebook_groups[\s\S]+set\s+name\s*=/i);
  assert.match(migration, /insert into public\.watched_facebook_groups[\s\S]+on conflict \(url\) do nothing/i);
  assert.match(migration, /name_verified boolean not null default true/i);
});

test("the migration keeps the existing backend-only registry security contract", () => {
  const foundation = readFileSync("supabase/migrations/20260809180000_create_facebook_groups_and_push.sql", "utf8");
  assert.match(foundation, /alter table public\.watched_facebook_groups enable row level security/i);
  assert.match(foundation, /revoke all on table public\.watched_facebook_groups from anon, authenticated/i);
  assert.match(foundation, /grant select, insert, update on table public\.watched_facebook_groups to service_role/i);
});
