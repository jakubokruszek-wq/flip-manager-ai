#!/usr/bin/env bash
# Stage-2 /status checks used by .github/workflows/olx-cloudflare-stage2.yml.
#
#   stage2-status.sh deploy-version <wrangler-deploy.log>
#       prints the "Current Version ID" of a wrangler deploy (fails if absent)
#   stage2-status.sh wait <disabled|enabled> <version|any> <attempts> <sleep-seconds> <out.json>
#       polls GET $STAGE2_URL/status until the Worker AND its Durable Object run
#       <version> in the requested state; prints a safe diagnostic line per attempt
#       and the full safe summary on failure. Exit 0 = confirmed, 1 = not confirmed.
#
# Requires STAGE2_URL and ADMIN_TOKEN. Never prints the token or any secret:
# /status exposes secrets only as "set"/"missing".
set -euo pipefail

# Shared by both states: fixed limits and manual mode, nothing running, no alarm.
COMMON='.configCheck.valid == true
  and .configCheck.stage1Lock == false
  and .configCheck.workerSecret == "set"
  and .configCheck.adminToken == "set"
  and .config.claimMode == "manual"
  and .config.workerId == "cloudflare-olx-stage2"
  and .config.maxJobsPerDay == 1
  and .config.maxJobsPerInvocation == 1
  and .config.maxHeldJobs == 1
  and .config.safeBrowserBudgetSeconds == 120
  and .running == false
  and .nextAlarm == null'
DISABLED_FILTER=".ok == false and .code == \"OLX_CLOUD_DISABLED\" and .configCheck.killSwitch == \"disabled\" and $COMMON"
ENABLED_FILTER=".ok == true and .code == null and .configCheck.killSwitch == \"enabled\" and $COMMON"
# The Durable Object reads the kill switch from ITS environment, so the version it runs must be the deployed one.
VERSION_FILTER='if $v == "any" then .version.matches == true else (.version.worker == $v and .version.runner == $v) end'

# Safe one-line view of a /status response (no secrets are present in /status).
DIAG='"ok=\(.ok) code=\(.code) killSwitch=\(.configCheck.killSwitch) valid=\(.configCheck.valid) mode=\(.config.claimMode) limity(dzień/wywołanie/trzymane)=\(.config.maxJobsPerDay)/\(.config.maxJobsPerInvocation)/\(.config.maxHeldJobs) budżet=\(.config.safeBrowserBudgetSeconds)s running=\(.running) nextAlarm=\(.nextAlarm) wersja: worker=\(.version.worker) runner=\(.version.runner) zgodne=\(.version.matches) reset=\(.version.runnerReset)"'
SUMMARY='{ok, code, message, configCheck: (.configCheck // {} | {killSwitch, stage1Lock, valid, problem, apiHost, workerSecret, adminToken, warnings}),
  config: (.config // {} | {claimMode, workerId, maxJobsPerDay, maxJobsPerInvocation, maxHeldJobs, safeBrowserBudgetSeconds}),
  running, nextAlarm, version, paused: (.paused // null | if . then .code else null end)}'

case "${1:-}" in
  deploy-version)
    version="$(grep -Eo 'Current Version ID: [0-9a-f-]{36}' "$2" | tail -1 | awk '{print $4}')"
    [ -n "$version" ] || { echo "::error::Brak 'Current Version ID' w wyniku wdrożenia" >&2; exit 1; }
    echo "$version"
    ;;
  wait)
    state="$2"; version="$3"; attempts="$4"; pause="$5"; out="$6"
    case "$state" in
      disabled) filter="$DISABLED_FILTER" ;;
      enabled) filter="$ENABLED_FILTER" ;;
      *) echo "::error::Nieznany stan: $state" >&2; exit 2 ;;
    esac
    : "${STAGE2_URL:?}" "${ADMIN_TOKEN:?}"
    for attempt in $(seq 1 "$attempts"); do
      http="$(curl -sS -o "$out" -w '%{http_code}' --max-time 20 -H "authorization: Bearer ${ADMIN_TOKEN}" "$STAGE2_URL/status" 2>/dev/null)" || http="błąd-połączenia"
      if [ "$http" = "200" ] && jq -e . "$out" >/dev/null 2>&1; then
        echo "próba $attempt/$attempts ($state): HTTP 200 $(jq -r "$DIAG" "$out")"
        if jq -e --arg v "$version" "($filter) and ($VERSION_FILTER)" "$out" >/dev/null; then
          echo "Potwierdzono stan '$state' (wersja: $version)."
          exit 0
        fi
      else
        echo "próba $attempt/$attempts ($state): HTTP $http, odpowiedź nie jest JSON-em /status ($(wc -c < "$out" 2>/dev/null || echo 0) bajtów)"
      fi
      [ "$attempt" -lt "$attempts" ] && sleep "$pause"
    done
    echo "::error::Nie potwierdzono stanu '$state' dla wersji $version po $attempts próbach. Ostatnia odpowiedź /status (bez sekretów):"
    jq "$SUMMARY" "$out" 2>/dev/null || echo "(brak poprawnej odpowiedzi)"
    exit 1
    ;;
  *)
    echo "użycie: $0 deploy-version <log> | wait <disabled|enabled> <version|any> <attempts> <sleep> <out.json>" >&2
    exit 2
    ;;
esac
