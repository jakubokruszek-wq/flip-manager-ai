# Flip Manager Facebook Collector

Manifest V3 collector that runs inside the user's normal logged-in Chrome/Edge Facebook tab. It observes only data Facebook already loads, combines DOM, hydration and passive network discovery, and uploads signed, idempotent batches to Flip Manager.

## Local installation

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable Developer mode and choose **Load unpacked**.
3. Select `extensions/facebook-collector`.
4. Open the extension options. Copy `deviceId` and `deviceToken` from Flip Manager's Collector setup screen. The token is stored only in local extension storage.
5. Open a Facebook group/profile in the normal logged-in browser and click **Zbierz aktywne źródło**.

The collector never contains a Supabase key, never calls Facebook private APIs itself, and does not run Vision. Low discovery coverage is persisted as `DEGRADED`, not as a false successful completion. Group Search is a bounded secondary fallback only for degraded group coverage.
