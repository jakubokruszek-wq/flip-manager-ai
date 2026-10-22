"""The pilot preparation must not become a hidden upload feature in the local APK."""
import re
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as apk:
    dex = [name for name in apk.namelist() if re.fullmatch(r"classes(?:[0-9]+)?\.dex", name)]
    assert dex, "APK has no DEX"
    for name in dex:
        assert b"PilotBatchGate" not in apk.read(name), "pilot preparation leaked into local APK"
print("Pilot preparation absent from local APK: PASS")
