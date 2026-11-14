#!/bin/sh
set -eu
# Run from android/flip-watcher-gecko-poc on the disposable CI emulator.
adb install -r ../../../watcher-upgrade-107/android/flip-watcher-gecko-poc/app/build/outputs/apk/debug/app-x86_64-debug.apk
adb install -r -t app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w -e class pl.jakubokruszek.flipwatcher.geckopoc.RollbackUpgradeInstrumentedTest#a_seedOn107 pl.jakubokruszek.flipwatcher.geckopoc.test/androidx.test.runner.AndroidJUnitRunner > rollback-seed.txt
cat rollback-seed.txt
grep -q 'OK (1 test)' rollback-seed.txt
adb install -r app/build/outputs/apk/debug/app-x86_64-debug.apk
adb shell am instrument -w -e class pl.jakubokruszek.flipwatcher.geckopoc.RollbackUpgradeInstrumentedTest#b_verifyAfterInPlaceUpdate pl.jakubokruszek.flipwatcher.geckopoc.test/androidx.test.runner.AndroidJUnitRunner > rollback-verify.txt
cat rollback-verify.txt
grep -q 'OK (1 test)' rollback-verify.txt
