# 0.5.72 — sale offers, at least one photo, saved-date cleanup

Main offer cards and new uploads require an explicit SELL_PROPERTY classification,
usable evidence and at least one actually stored, post-bound image. A graphic
containing text counts; no image-content classifier rejects it for being text.
A page counter saying photos exist is insufficient. Uncertain candidates and
missing-image snapshots remain encrypted in quality_hold and available for
review/enrichment. Existing pending items are checked before HTTP, too.

Manager enforces the same gate before upload/import and its Watcher list excludes
records without sale evidence or a stored image. This is a heuristic classifier,
not a guarantee that every Facebook post is understood correctly. It does not
invent raw source text or author/publication times. Existing evidence is retained.

Android's automation panel adds saved-date cleanup for the selected group. The
chosen date means its start in the phone's timezone; that day and newer records
remain. Preview reports posts, snapshots, unsent rows, manual-archive rows and
unknown dates. Apply rechecks the preview under the automation lock. The queue
keeps receipt/idempotency tombstones but erases deleted payloads; scans and retry
cannot reanimate removed posts. The manual archive is a dated snapshot, so its
own savedAt determines whether the whole snapshot is older than the cutoff.
Manager cleanup is separate and protects CRM/Deal Room/cross-source records.

Queue version 1 has no saved-date field. Migration preserves encrypted frozen
bodies, keys and receipts, recovers source identity, and leaves dates unknown.
Unknown-date records are not removed by guessing their age. Eligible old snapshots
are revalidated once with exactly the same frozen body/key to refresh sale
provenance in Manager; existing receipts remain and no new canonical offer is
created. Reopening the v2 queue does not repeat that migration replay. Facebook login,
pairing, schedules and other groups remain intact. Nothing is automatically
removed without the operator choosing a cutoff and confirming its preview.

Validation must include Kotlin compilation, JVM/property-classifier regressions,
real Android queue migration/cleanup/retry/UI/Gecko tests, mobile API/import tests
and PostgreSQL cleanup/permissions/replay tests. Do not publish before full CI.
