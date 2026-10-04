begin;

-- DRAFT -- not applied by this change. Caches AI-derived, advisory-only
-- observations about a listing's description and its own already-confirmed
-- photos (see features/flip-finder/server/listing-ai-analysis.ts). Exactly
-- one row per listing, upserted on (re)analysis; content_hash/images_hash
-- let the application skip calling the API again when neither the
-- description nor the confirmed image set has changed since the last run.
-- This table is read-only input for operators reviewing a listing -- no
-- deterministic matching, underwriting, or scan code reads it.

create table if not exists public.listing_ai_analysis (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  content_hash text not null,
  images_hash text,
  model text not null,
  text_findings jsonb,
  photo_findings jsonb,
  analyzed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint listing_ai_analysis_listing_id_key unique (listing_id),
  constraint listing_ai_analysis_text_findings_object check (
    text_findings is null or jsonb_typeof(text_findings) = 'object'
  ),
  constraint listing_ai_analysis_photo_findings_object check (
    photo_findings is null or jsonb_typeof(photo_findings) = 'object'
  )
);

create or replace function public.set_listing_ai_analysis_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists listing_ai_analysis_set_updated_at on public.listing_ai_analysis;
create trigger listing_ai_analysis_set_updated_at
before update on public.listing_ai_analysis
for each row execute function public.set_listing_ai_analysis_updated_at();

alter table public.listing_ai_analysis enable row level security;

revoke all on table public.listing_ai_analysis from anon, authenticated;
grant select, insert, update, delete on table public.listing_ai_analysis to service_role;

commit;
