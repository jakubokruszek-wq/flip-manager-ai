#!/bin/sh
set -eu
# Mounted Railway volumes start owned by root. Browser itself runs as pwuser.
mkdir -p /data/chromium
chown pwuser:pwuser /data /data/chromium
chmod 700 /data /data/chromium
exec gosu pwuser node /app/server.mjs
