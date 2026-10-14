#!/usr/bin/env bash
# /status checks of the unattended Worker, used by .github/workflows/olx-cloudflare-scheduled.yml.
# Same contract as scripts/scheduled-status.sh, for "flip-manager-olx-cloud-scheduled":
# scheduled mode with its fixed limits. A one-shot claim alarm may be pending
# and a Cron batch may be running while enabled; a disabled Worker claims
# nothing whatever its alarm (the alarm re-reads the kill switch).
#
#   scheduled-status.sh deploy-version <wrangler-deploy.log>
#       prints the "Current Version ID" of a wrangler deploy (fails if absent)
#   scheduled-status.sh deployment <version> <deployments-status.json>
#       `wrangler deployments status --json`: the active deployment must send 100 %
#       of traffic to <version>. Otherwise DEPLOYMENT_NOT_APPLIED.
#   scheduled-status.sh active-version <deployments-status.json>
#       prints the single version holding 100 % of traffic (fails on a split).
#   scheduled-status.sh var <versions-view.json> <NAME> <value>
#       `wrangler versions view <id> --json`: the plain-text var must have <value>
#       (proves that `--var NAME:value` overrode the config). Otherwise VAR_NOT_APPLIED.
#   scheduled-status.sh wait <disabled|enabled> <version|any> <attempts> <sleep-seconds> <out.json>
#       polls GET $SCHEDULED_URL/status until the Worker AND its Durable Object run
#       <version> in the requested state; prints a safe diagnostic line per attempt
#       and the full safe summary on failure. Exit 0 = confirmed, 1 = not confirmed.
#       A failure is classified (last valid response):
#         STATUS_UNREACHABLE              no valid /status answer
#         VERSION_NOT_ACTIVE              workers.dev still serves another version
#         DURABLE_OBJECT_VERSION_MISMATCH the Worker runs <version>, its Durable Object does not
#         STATE_MISMATCH                  both run <version>, but state/limits differ
#
# Requires SCHEDULED_URL and ADMIN_TOKEN. Never prints the token or any secret:
# /status exposes secrets only as "set"/"missing".
set -euo pipefail

# Shared by both states: fixed limits and scheduled mode.
COMMON='.configCheck.valid == true
  and .configCheck.stage1Lock == false
  and .configCheck.workerSecret == "set"
  and .configCheck.adminToken == "set"
  and .config.claimMode == "scheduled"
  and .config.workerId == "cloudflare-olx-scheduled"
  and .config.maxJobsPerDay == 2
  and .config.maxJobsPerInvocation == 1
  and .config.maxHeldJobs == 1
  and .config.safeBrowserBudgetSeconds == 120
  and .config.onBudgetExhausted == "leave_queued"'
DISABLED_FILTER=".ok == false and .code == \"OLX_CLOUD_DISABLED\" and .configCheck.killSwitch == \"disabled\" and .running == false and $COMMON"
ENABLED_FILTER=".ok == true and .code == null and .configCheck.killSwitch == \"enabled\" and $COMMON"
# The Durable Object reads the kill switch from ITS environment, so the version it runs must be the deployed one.
VERSION_FILTER='if $v == "any" then .version.matches == true else (.version.worker == $v and .version.runner == $v) end'

# Safe one-line view of a /status response (no secrets are present in /status).
DIAG='"ok=\(.ok) code=\(.code) killSwitch=\(.configCheck.killSwitch) valid=\(.configCheck.valid) mode=\(.config.claimMode) limity(dzień/wywołanie/trzymane)=\(.config.maxJobsPerDay)/\(.config.maxJobsPerInvocation)/\(.config.maxHeldJobs) budżet=\(.config.safeBrowserBudgetSeconds)s running=\(.running) nextAlarm=\(.nextAlarm) wersja: worker=\(.version.worker) runner=\(.version.runner) zgodne=\(.version.matches) reset=\(.version.runnerReset)"'
SUMMARY='{ok, code, message, configCheck: (.configCheck // {} | {killSwitch, stage1Lock, valid, problem, apiHost, workerSecret, adminToken, warnings}),
  config: (.config // {} | {claimMode, workerId, maxJobsPerDay, maxJobsPerInvocation, maxHeldJobs, safeBrowserBudgetSeconds, onBudgetExhausted}),
  running, nextAlarm, version, paused: (.paused // null | if . then .code else null end)}'

# `wrangler ... --json` output starting at the first "{" line (tolerates a warning printed before it).
json() { sed -n '/^{/,$p' "$1"; }

case "${1:-}" in
  deploy-version)
    version="$(grep -Eo 'Current Version ID: [0-9a-f-]{36}' "$2" | tail -1 | awk '{print $4}')"
    [ -n "$version" ] || { echo "::error::Brak 'Current Version ID' w wyniku wdrożenia" >&2; exit 1; }
    echo "$version"
    ;;
  deployment)
    version="$2"; file="$3"
    json "$file" > "$file.json"; file="$file.json"
    jq -e '.versions | type == "array"' "$file" >/dev/null 2>&1 \
      || { echo "::error::DEPLOYMENT_STATUS_UNREADABLE: brak czytelnego wyniku 'wrangler deployments status --json'"; exit 1; }
    traffic="$(jq -r '[.versions[] | "\(.version_id):\(.percentage)%"] | join(", ")' "$file")"
    if jq -e --arg v "$version" '(.versions | length) == 1 and .versions[0].version_id == $v and .versions[0].percentage == 100' "$file" >/dev/null; then
      echo "Aktywny deployment $(jq -r '.id // "?"' "$file"): $traffic (zgodny z wdrożeniem)."
      exit 0
    fi
    echo "::error::DEPLOYMENT_NOT_APPLIED: aktywny deployment $(jq -r '.id // "?"' "$file") kieruje ruch na [$traffic], a wdrożono $version (oczekiwano 100 %)."
    exit 1
    ;;
  active-version)
    json "$2" > "$2.json"; file="$2.json"
    active="$(jq -r 'if (.versions | type) == "array" and (.versions | length) == 1 and .versions[0].percentage == 100 then .versions[0].version_id else empty end' "$file" 2>/dev/null || true)"
    [ -n "$active" ] || { echo "::error::DEPLOYMENT_SPLIT: aktywny deployment nie ma jednej wersji ze 100 % ruchu" >&2; exit 1; }
    echo "$active"
    ;;
  var)
    json "$2" > "$2.json"; file="$2.json"; name="$3"; expected="$4"
    actual="$(jq -r --arg n "$name" '[.resources.bindings[]? | select(.name == $n and .type == "plain_text") | .text] | if length == 1 then .[0] else "<brak>" end' "$file" 2>/dev/null || echo "<nieczytelne>")"
    if [ "$actual" = "$expected" ]; then
      echo "Wersja $(jq -r '.id // "?"' "$file"): $name = \"$actual\" (zgodnie z oczekiwaniem)."
      exit 0
    fi
    echo "::error::VAR_NOT_APPLIED: wersja $(jq -r '.id // "?"' "$file" 2>/dev/null) ma $name = \"$actual\", oczekiwano \"$expected\"."
    exit 1
    ;;
  wait)
    state="$2"; version="$3"; attempts="$4"; pause="$5"; out="$6"
    last=""
    case "$state" in
      disabled) filter="$DISABLED_FILTER" ;;
      enabled) filter="$ENABLED_FILTER" ;;
      *) echo "::error::Nieznany stan: $state" >&2; exit 2 ;;
    esac
    : "${SCHEDULED_URL:?}" "${ADMIN_TOKEN:?}"
    for attempt in $(seq 1 "$attempts"); do
      http="$(curl -sS -o "$out" -w '%{http_code}' --max-time 20 -H "authorization: Bearer ${ADMIN_TOKEN}" "$SCHEDULED_URL/status" 2>/dev/null)" || http="błąd-połączenia"
      if [ "$http" = "200" ] && jq -e . "$out" >/dev/null 2>&1; then
        echo "próba $attempt/$attempts ($state): HTTP 200 $(jq -r "$DIAG" "$out")"
        last="$out.last"; cp "$out" "$last"
        if jq -e --arg v "$version" "($filter) and ($VERSION_FILTER)" "$out" >/dev/null; then
          echo "Potwierdzono stan '$state' (wersja: $version)."
          exit 0
        fi
      else
        echo "próba $attempt/$attempts ($state): HTTP $http, odpowiedź nie jest JSON-em /status ($(wc -c < "$out" 2>/dev/null || echo 0) bajtów)"
      fi
      [ "$attempt" -lt "$attempts" ] && sleep "$pause"
    done
    # Separate causes: no answer, an old version still serving, a lagging Durable Object, a wrong state.
    if [ -z "$last" ]; then
      echo "::error::STATUS_UNREACHABLE: /status nie zwrócił poprawnej odpowiedzi w $attempts próbach."
    else
      worker="$(jq -r '.version.worker // "null"' "$last")"; runner="$(jq -r '.version.runner // "null"' "$last")"
      if [ "$version" = "any" ]; then expected_worker="$worker"; expected_runner="$worker"; else expected_worker="$version"; expected_runner="$version"; fi
      if [ "$worker" != "$expected_worker" ]; then
        echo "::error::VERSION_NOT_ACTIVE: workers.dev nadal obsługuje wersję $worker, a wdrożono $version (Durable Object: $runner)."
      elif [ "$runner" != "$expected_runner" ]; then
        echo "::error::DURABLE_OBJECT_VERSION_MISMATCH: Worker działa w wersji $worker, Durable Object w $runner (runnerReset=$(jq -r '.version.runnerReset' "$last"))."
      else
        echo "::error::STATE_MISMATCH: wersja $worker zgodna, ale stan różni się od '$state' (code=$(jq -r '.code' "$last"), killSwitch=$(jq -r '.configCheck.killSwitch' "$last"), running=$(jq -r '.running' "$last"))."
      fi
    fi
    echo "::error::Nie potwierdzono stanu '$state' dla wersji $version po $attempts próbach. Ostatnia odpowiedź /status (bez sekretów):"
    jq "$SUMMARY" "${last:-$out}" 2>/dev/null || echo "(brak poprawnej odpowiedzi)"
    exit 1
    ;;
  *)
    echo "użycie: $0 deploy-version <log> | deployment <version> <deployments.json> | active-version <deployments.json> | var <version.json> <NAME> <value> | wait <disabled|enabled> <version|any> <attempts> <sleep> <out.json>" >&2
    exit 2
    ;;
esac
