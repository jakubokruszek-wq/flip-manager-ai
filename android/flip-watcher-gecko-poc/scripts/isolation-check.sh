#!/usr/bin/env bash
# Isolation guard of the GeckoView POC (run from the repo root in CI):
#  1. the change touches only the POC directory, its workflow and nothing else
#     (no Finder, Radar, OLX, OFFLINE_TEST, PR #44 files, backend or database);
#  2. the POC sources contain no backend client, no production URL and no secret;
#  3. collector-core.js is byte-identical to the base branch (reused, not forked).
set -euo pipefail
base="${1:-origin/main}"
poc="android/flip-watcher-gecko-poc"

changed="$(git diff --name-only "$base"...HEAD)"
echo "Changed files vs $base:"; echo "$changed" | sed 's/^/  /'
outside="$(echo "$changed" | grep -v -E "^($poc/|\.github/workflows/android-gecko-poc\.yml$)" || true)"
if [ -n "$outside" ]; then echo "FAIL: files outside the POC were changed:"; echo "$outside"; exit 1; fi

src="$poc/app/src/main"
if grep -R -n -i -E "okhttp|HttpURLConnection|URLConnection|retrofit|supabase|onrender\.com|vercel\.app|/api/|fetch\(" "$src" --include='*.kt' --include='*.js' --include='*.json'; then
  echo "FAIL: network client or backend reference in POC sources"; exit 1
fi
# Case-sensitive: the webRequest type name "xmlhttprequest" is a filter, not a client.
if grep -R -n -E "XMLHttpRequest|sendBeacon|WebSocket" "$src" --include='*.kt' --include='*.js' --include='*.json'; then
  echo "FAIL: network client in POC sources"; exit 1
fi
# 0.2.2: response bodies are never read; the background only counts request events.
if grep -n -E "filterResponseData\(|\[\"blocking\"\]|TextDecoder" "$src/extension/poc-background.js"; then
  echo "FAIL: background script can read or block responses"; exit 1
fi
if grep -n "webRequestBlocking" "$src/extension/manifest.json"; then
  echo "FAIL: webRequestBlocking permission present"; exit 1
fi
# The background talks to the app (0.2.4 load measurement) only through its
# counters: it must not touch documents, storage or cookies.
if grep -n -E "document\.|cookies|localStorage|browser\.storage|getAll\(" "$src/extension/poc-background.js" | grep -v -E "^[0-9]+:[[:space:]]*//"; then
  echo "FAIL: background script reaches page content, cookies or storage"; exit 1
fi
if grep -R -n -E "OFFLINE_TEST|LIVE_COLLECTION_ENABLED\s*=\s*true|BUY_ENABLED" "$poc/app"; then
  echo "FAIL: POC references production switches"; exit 1
fi
if grep -R -n -i -E "(api[_-]?key|secret|password|token)\s*[:=]\s*\"[^\"]{8,}" "$poc/app" --include='*.kt' --include='*.kts' --include='*.js' --include='*.json'; then
  echo "FAIL: something that looks like a secret"; exit 1
fi
if grep -R -n -E "Log\.[dviwe]\(" "$src" --include='*.kt'; then
  echo "FAIL: logging in app sources (URLs or page data could leak to logcat)"; exit 1
fi
if grep -R -n -E "userAgentOverride|USER_AGENT_MODE_DESKTOP" "$src" --include='*.kt'; then
  echo "FAIL: the browser identity must not be overridden"; exit 1
fi

git diff --quiet "$base"...HEAD -- extensions/facebook-collector/collector-core.js || { echo "FAIL: collector-core.js changed"; exit 1; }
echo "OK: POC isolated, no backend, collector-core.js unchanged"
