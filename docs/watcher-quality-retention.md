# Watcher sale/photo gate and cleanup by saved date

Only confirmed property sales with at least one stored image enter the Watcher
list. The Android typed projection must say SELL_PROPERTY, usable, and have no
conflict/foreign-city/non-property qualification. The receiver validates its
post-bound JPEGs and decodes every image before storage. A text graphic is
accepted; no image-content classifier or paid Vision is added. Unknown sales
and missing-photo snapshots remain on the phone for review, not the main list.

Validated Android sale provenance is explicitly marked as
ANDROID_TYPED_CLASSIFIER. It is not fabricated original post text, author or
publication time, and does not overwrite richer non-unknown source intent or
existing authoritative fields. Replays can refresh this sidecar without a new
canonical listing. Existing richer images/decisions remain preserved.

Manager's additional cleanup action uses listings.created_at, the actual time
that database row was first saved. It does not use publication time or last
seen time. Only pure Facebook rows are deleted. CRM, Deal Room, cross-source
and other-portal records are preserved. Preview returns a candidate signature;
apply recomputes it under locks, refuses active scans and requires the same
signature. Migration installs this functionality but deletes no existing rows.
The operator must choose a cutoff and explicitly confirm the preview.

Numeric post identity tombstones block later imports, including uploads already
in flight. Receipt/replay identities are not removed, but their deleted offers' old payload
and result fields are erased. Objects in shared image storage are
not indiscriminately deleted because other records can reference them. This
cleanup deletes selected database offers; storage-wide garbage collection is
not part of this change. The existing all-history cleanup action is unchanged.

Android has an independent selected-group cleanup. Its schema migration leaves
unknown dates in older frozen queues unknown, preserving bytes and receipts.
Those records are never aged by guessed publication/capture/retry timestamps.
The manual archive is a whole dated snapshot; its savedAt controls that snapshot.
Phone cleanup does not silently delete Manager data, and vice versa.

Required validation: mobile contract/import/replay and full JPEG decode,
PostgreSQL preview/apply/protected-data/active-job/permissions/tombstone tests,
route authentication/CSRF/error handling, TypeScript and scoped lint. Android
release is separately gated by its complete fixture/instrumentation suite.
