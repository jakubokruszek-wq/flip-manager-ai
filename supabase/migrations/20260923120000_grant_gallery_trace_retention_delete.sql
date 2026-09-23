begin;

-- Gallery trace write-volume mission: rendering a Finder card fires two
-- automatic diagnostic writes (GALLERY_BUTTON_MOUNT, GALLERY_BUTTON_RENDERED)
-- to public.gallery_request_traces on every view, with no upstream cap —
-- confirmed live in production that a repeatedly-viewed listing accumulates
-- rows in this table forever, since the original 20260906133000 migration
-- granted service_role only select and insert here, never delete.
--
-- writeGalleryTrace's own retention trim (trimGalleryTraces in
-- features/flip-finder/server/gallery-request-trace.ts) keeps each
-- listing's own row count bounded to its newest MAX_TRACE_ROWS (80) by
-- deleting the older excess after every write — but that delete call
-- itself needs this grant, or it fails silently (best-effort, wrapped in
-- its own try/catch) and the table keeps growing exactly as before.
--
-- Narrowest correct grant: DELETE only, only on this one diagnostics
-- table, only to service_role (the only role this table has ever granted
-- anything to — anon/authenticated remain fully revoked, unchanged).
grant delete on table public.gallery_request_traces to service_role;

commit;
