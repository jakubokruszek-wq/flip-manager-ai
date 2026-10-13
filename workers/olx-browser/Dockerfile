# syntax=docker/dockerfile:1
#
# Cloud OLX worker (Railway). Build context MUST be the repository root,
# because the worker imports the shared OLX parser/protocol from features/:
#
#   docker build -f workers/olx-browser/Dockerfile -t flip-olx-worker .
#
# The official Playwright image ships Node.js, the Chromium build that matches
# playwright@1.61.1 and every system library Chromium needs, plus the
# unprivileged `pwuser` account. Keep this tag equal to the `playwright`
# version in workers/olx-browser/package.json (the browser revision must match).
FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# tini as PID 1: forwards SIGTERM to Node and reaps orphaned Chromium processes.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first for layer caching. Browsers are already in the base image.
# `build_ca` is an optional BuildKit secret for building behind a TLS-inspecting
# proxy (docker build --secret id=build_ca,src=ca.crt). Secret mounts are never
# written into image layers; on Railway it is absent and this is a no-op.
COPY workers/olx-browser/package.json workers/olx-browser/package-lock.json workers/olx-browser/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm ci --prefix workers/olx-browser --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# Runtime sources only (see .dockerignore). No .env files, no secrets: the
# OLX_WORKER_API_URL / OLX_WORKER_SECRET values are injected at runtime.
COPY features/flip-finder/ features/flip-finder/
COPY features/properties/ features/properties/
COPY workers/shared/ workers/shared/
COPY workers/olx-browser/src/ workers/olx-browser/src/

USER pwuser

# Fail the build if a runtime import is missing from the copied sources (e.g.
# the parser starts importing another features/ module) or if this Playwright
# cannot start its headless Chromium (browser revision mismatch).
RUN node --experimental-strip-types --disable-warning=ExperimentalWarning workers/olx-browser/src/image-self-check.ts

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--use-system-ca", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "workers/olx-browser/src/index.ts"]
