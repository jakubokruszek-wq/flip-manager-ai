#!/usr/bin/env python3
"""Supervisor for an explicitly approved remote synthetic test deployment."""
import json
import os
import signal
import subprocess
import time
import urllib.request

if os.environ.get("FLIP_OFFLINE_REMOTE_TEST") != "true":
    raise SystemExit("REMOTE_TEST_DISABLED")
children=[]
def stop(*_):
    for child in children:
        if child.poll() is None: child.terminate()
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
try:
    children.append(subprocess.Popen(["python","scripts/facebook-android-test-db.py"]))
    for attempt in range(30):
        if children[0].poll() is not None: raise RuntimeError("DB_START_FAILED")
        try:
            req=urllib.request.Request("http://127.0.0.1:55440/health",data=b"{}",headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(req,timeout=1) as response:
                if json.load(response).get("ok"): break
        except OSError: time.sleep(1)
    else: raise RuntimeError("DB_NOT_READY")
    children.append(subprocess.Popen(["node","--import","./scripts/test-alias-loader.mjs","scripts/facebook-android-test-api.ts"]))
    while all(child.poll() is None for child in children): time.sleep(1)
finally:
    stop()
    for child in children:
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill();child.wait()
raise SystemExit(1)
