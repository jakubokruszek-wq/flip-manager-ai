# Server-hosted Facebook Watcher

Runs the existing Chrome collector extension continuously in a dedicated Chromium
profile. This is the **BROWSER_EXTENSION** queue consumer; the old
`workers/facebook-browser` HMAC worker consumes a different queue and must not be
substituted. The Android APK remains unchanged and is not needed for scheduled
server scans. Existing acquisition, filtering, canonical identity and import
policies remain in effect; this deployment adds no new paid Vision calls.

## Deployment (not activated by this commit)

1. Create a single-replica Railway service from this repository. Set its config
   file to `workers/facebook-server/railway.json`, with repository-root build
   context. Allocate at least 2 GB RAM and a persistent volume mounted at `/data`.
2. Generate an HTTPS service domain. Set `WATCHER_DESKTOP_ORIGIN` to that exact
   origin (no path). Generate `WATCHER_DESKTOP_PASSWORD` with at least 24 random
   characters and store it in Railway service secrets. Never commit it or paste
   it into chat. Only port `PORT` (default 8080) is public. Do not expose ports
   5901, 6081 or a Chrome debugging port. The proxy requires the platform's
   `X-Forwarded-Proto: https` header and the exact domain.
3. Deploy. `/healthz` reports browser/process liveness, **not** a working Facebook
   login or successful scans. The desktop uses username `flip` and the secret
   password above. The authenticated `/status` reports pairing and last poll,
   without tokens, page data or browser cookies.
4. Open the protected desktop in your browser. In its Chromium window, log in to
   Facebook yourself, including any 2FA/checkpoint. Then open the Manager's
   `/flip-finder/collector/setup`, name the device `Watcher serwer`, and use
   **Połącz collector** (extension pairing, not Android code). Never copy a
   personal Chrome profile or export Facebook cookies to this service.
5. Verify a fresh heartbeat and successful real source scan in the Manager before
   calling the deployment operational. Existing server environment
   `FACEBOOK_COLLECTOR_QUEUE_ENABLED=true` is required to consume queued jobs.
6. Set **on the Manager deployment**, not this browser service,
   `FACEBOOK_WATCHER_DAILY_SCAN_TIMES=08:00,14:00,20:00` and redeploy that Manager.
   Its existing GitHub scheduler wakes every five minutes; extension claim and
   completion also advance the scheduler. The IANA timezone is Europe/Warsaw.
   Execution is due at those times; wakeups/provider delays can make it later.
   The first online tick after an outage runs at most one catch-up cycle.
   Active cycles finish sequentially across enabled sources without overlap.
7. Additional comma-separated daily times allow more frequent scans (max 24).
   Removing the variable returns to the existing persisted interval setting.
   02:00–02:59 is rejected because of DST ambiguity. Manual scans bypass the
   calendar gate. Do not leave a second collector polling if only this service
   should consume the shared queue.

The volume contains the Facebook session and collector credentials. Restrict
hosting access accordingly. Restart/redeploy retains that volume. One live
Chromium process must own it; do not scale replicas or mount it in two services.
If Facebook requires login again, complete it through the protected desktop.
No CAPTCHA or checkpoint bypass is implemented.

## Verification

`npm test --prefix workers/facebook-server` checks HTTP/WebSocket authorization
and proxy behavior. Calendar tests cover winter/summer, both DST transitions,
restart deduplication and missed-slot coalescing. CI builds the actual image and
boots an unpaired browser, verifies health/protected desktop/extension status,
then restarts with the same volume. This is not a live Facebook data test.

Activation additionally requires hosting authorization, a real user login and
pairing, and one complete source scan. None of those is implied by passing CI.
