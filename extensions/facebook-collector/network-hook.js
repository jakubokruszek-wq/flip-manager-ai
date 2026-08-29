(function installPassiveNetworkObserver() {
  "use strict";
  const core = globalThis.FlipFacebookCollectorCore;
  if (!core || globalThis.__flipCollectorNetworkObserver) return;
  globalThis.__flipCollectorNetworkObserver = true;
  const MAX_BODY_BYTES = 2_000_000;

  function relevant(url, contentType) {
    return /(?:graphql|api\/graphql|relay|ajax|groups\/feed|CometGroup)/i.test(url) || /json|javascript/i.test(contentType || "");
  }

  function emit(url, method, status, contentType, body) {
    try {
      if (!relevant(url, contentType) || body.length > MAX_BODY_BYTES) return;
      const source = core.canonicalSource(location.href);
      if (!source) return;
      const records = core.extractStructuredRecordsFromText(body, "NETWORK", source, 0);
      if (!records.length) return;
      window.postMessage({ channel: "FLIP_COLLECTOR_NETWORK", payload: { url: sanitizedPath(url), method, status, contentType: String(contentType || "").slice(0, 120), size: body.length, records } }, location.origin);
    } catch { /* passive observer must never affect Facebook */ }
  }

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async function collectorFetch(...args) {
    const response = await nativeFetch(...args);
    try {
      const url = response.url || String(args[0]?.url || args[0] || "");
      const contentType = response.headers.get("content-type") || "";
      if (relevant(url, contentType)) void response.clone().text().then((body) => emit(url, String(args[1]?.method || args[0]?.method || "GET"), response.status, contentType, body)).catch(() => {});
    } catch { /* no-op */ }
    return response;
  };

  const NativeXHR = globalThis.XMLHttpRequest;
  if (NativeXHR) {
    const open = NativeXHR.prototype.open;
    const send = NativeXHR.prototype.send;
    NativeXHR.prototype.open = function collectorOpen(method, url, ...rest) { this.__flipMethod = method; this.__flipUrl = String(url); return open.call(this, method, url, ...rest); };
    NativeXHR.prototype.send = function collectorSend(...args) {
      this.addEventListener("load", () => {
        try { if (typeof this.responseText === "string") emit(this.responseURL || this.__flipUrl || "", this.__flipMethod || "GET", this.status, this.getResponseHeader("content-type") || "", this.responseText); } catch { /* no-op */ }
      }, { once: true });
      return send.apply(this, args);
    };
  }

  function sanitizedPath(value) { try { const url = new URL(value, location.href); return `${url.origin}${url.pathname}`; } catch { return "unknown"; } }
})();
