#!/usr/bin/env bash
set -euo pipefail
# Invoked from android/flip-collector on the already running API36 CI emulator.
# Never uninstall, clear data or contact Facebook. APKs/credentials are local fixtures.
test "${GITHUB_ACTIONS:-}" = true
adb install -r -t app/build/outputs/apk/debug/app-debug.apk
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
mkdir -p app/build/reports/pilot-process
for phase in seed recover; do
  if [ "$phase" = recover ]; then
    adb shell am force-stop pl.jakubokruszek.flipcollector.integration
  fi
  adb shell am instrument -w -r \
    -e class pl.jakubokruszek.flipcollector.LivePilotProcessRecoveryTest \
    -e isolatedApiOrigin https://10.0.2.2:55441 \
    -e pilotCrashPhase "$phase" \
    pl.jakubokruszek.flipcollector.integration.test/androidx.test.runner.AndroidJUnitRunner \
    | tee "app/build/reports/pilot-process/$phase.txt"
  grep -q 'OK (1 test)' "app/build/reports/pilot-process/$phase.txt"
done
