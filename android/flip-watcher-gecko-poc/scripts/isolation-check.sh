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
if grep -R -n -i -E "okhttp|HttpURLConnection|URLConnection|retrofit|supabase|onrender\.com|vercel\.app|fetch\(" "$src" --include='*.kt' --include='*.js' --include='*.json' --exclude='main-transport.js' --exclude='main-bootstrap.js'; then
  echo "FAIL: network client or backend reference in POC sources"; exit 1
fi
# The only client-shaped exception is the reviewed MAIN wrapper; it never originates requests.
# Case-sensitive: the webRequest type name "xmlhttprequest" is a filter, not a client.
if grep -R -n -E "XMLHttpRequest|sendBeacon|WebSocket" "$src" --include='*.kt' --include='*.js' --include='*.json' --exclude='main-transport.js' --exclude='main-bootstrap.js'; then
  echo "FAIL: network client in POC sources"; exit 1
fi
# Legacy measurements remain count-only. Body access is confined to the separate opt-in module.
if grep -n -E "filterResponseData\(|\[\"blocking\"\]|TextDecoder" "$src/extension/poc-background.js"; then
  echo "FAIL: background script can read or block responses"; exit 1
fi
# 0.2.9: the official MV2 StreamFilter needs webRequestBlocking. No additional
# host/storage/cookie/header permissions and no response reading in other modules.
node - "$src/extension/manifest.json" <<'NODE'
const m=require(require('node:path').resolve(process.argv[2]));
const expected=["nativeMessaging","nativeMessagingFromContent","geckoViewAddons","scripting","webRequest","webRequestBlocking","https://*.facebook.com/*","https://facebook.com/*","https://*.fbcdn.net/*","http://127.0.0.1/*"];
if (m.permissions.length!==expected.length || expected.some(p=>!m.permissions.includes(p)) || (!m.background.scripts.includes("response-diagnosis.js") || !m.background.scripts.includes("main-transport.js"))) process.exit(1);
NODE
# MAIN may wrap existing page APIs only; it must never originate/replay requests or expose a page bridge.
node - "$src/extension/main-transport.js" "$src/extension/main-bootstrap.js" <<'NODE'
const fs=require('node:fs'),s=fs.readFileSync(process.argv[2],'utf8');
if (/new\s+(?:XMLHttpRequest|WebSocket)|sendBeacon|fetch\s*\(|postMessage|requestHeaders|responseHeaders|browser\.cookies|browser\.storage|supabase|onrender\.com|vercel\.app/.test(s)) process.exit(1);
const b=fs.readFileSync(process.argv[3],'utf8');
if (!s.includes("world:'MAIN'") || !s.includes('relay.subscribe') || !b.includes('originalFetch.apply') || !b.includes('originalSend.apply')) process.exit(1);
if (/\.clone\s*\(|\.responseText|postMessage|TextDecoder|requestHeaders|responseHeaders|browser\.|localStorage|extractStructuredRecords/.test(b)) process.exit(1);
NODE
if grep -R -n -E 'filterResponseData|responseHeaders|requestHeaders|browser\.cookies|browser\.storage' "$src/extension" --include='*.js' --exclude='response-diagnosis.js'; then
  echo "FAIL: response access outside the explicit opt-in module"; exit 1
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
