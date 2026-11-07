# 0.5.73 — visible automatic scan status

The main screen has a two-line status entry. Tapping it opens a read-only live
status activity. Unlike the main Facebook screen, this activity does not acquire
browser/UI ownership or pause the background worker. The notification opens the
same read-only activity. It refreshes every two seconds without reopening the
Facebook session or changing queue receipts.

Durable status records preparation, group loading, reading, saving and upload
acknowledgements; group position/completed count; rows and bound photos saved in
the current attempt; start, actual stage-change, heartbeat, end and last full-scan
times. No post content, URLs or credentials enter status preferences/notifications.
Heartbeat is separate from progress. A stale active record is explicitly
unconfirmed rather than falsely marked successful or blamed on an invented
Android kill reason. Disabled notifications, missing internet, pairing/login,
CAPTCHA, an open browser UI, completed/not-yet-due windows, partial batches and
HTTP upload failures receive human-readable explanations. WorkManager's observed
state and the next planned window are shown; exact OS scheduling-delay reasons
are not available and are not invented. Normal low-importance notifications are
used, not a background-started foreground service.

Manual requests survive partial failure and an interruption caused by returning
to the browser UI. They are cleared only after every active group has a durable
scan receipt. Successful groups are skipped on continuation. A read-only status
visit does not set uiVisible and therefore does not trigger that interruption.

Verification: formatter/liveness unit tests, actual worker partial-retry and
missing-pairing/UI tests, live activity refresh/ownership tests and the full
existing Android/JS/JVM regression workflow. Publication requires success and an
anonymous verified download of the exact tested ARM64 APK.
