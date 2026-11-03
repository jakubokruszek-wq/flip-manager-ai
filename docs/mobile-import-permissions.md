# Android upload HTTP 503: collector import permissions

The Android queue contained saved snapshots and the mobile endpoint accepted device authentication. Bound photos reached Storage, but no mobile-v1 receipt was recorded. Production inspection showed service_role could not SELECT, INSERT or UPDATE public.collector_imports; the importer failed at its initial duplicate lookup and returned its retryable 503 response.

The repair grants those three operations only to service_role. It preserves RLS, browser-role access and all existing rows. No APK, pairing, schema shape or queued body/idempotency-key change is required. The same idempotent grant was applied live on 2026-11-02 and is recorded here for subsequent migration runs and clean installations.

Verification against production:

- Before repair: all three service_role DML privileges were false; devices and listings already had server DML access.
- After repair: SELECT, INSERT and UPDATE are true for service_role; RLS remains enabled and SELECT remains false for anon and authenticated.
- A transaction executed under SET LOCAL ROLE service_role selected, inserted and updated a probe receipt, then ROLLBACK removed it. No synthetic listing was created.
- Real phone retries subsequently produced 28 imported receipts for 28 listings with no failed receipts at the verification checkpoint. The Android queue retains its retry backoff, so remaining snapshots can arrive gradually.
- Security and performance advisors were checked. The grant exposes no new access to browser roles.

The repair is idempotent. Leave existing queue entries and pairing intact. Refresh /facebook-watcher after uploads; the browser inbox is loaded once when the page opens.
