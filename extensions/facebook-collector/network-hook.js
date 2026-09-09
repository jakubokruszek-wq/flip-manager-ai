(function installPassiveNetworkObserver() {
  "use strict";
  const core = globalThis.FlipFacebookCollectorCore;
  if (!core || globalThis.__flipCollectorNetworkObserver) return;
  globalThis.__flipCollectorNetworkObserver = true;
  const MAX_BODY_BYTES = 2_000_000;
  const MAX_VIEWER_BUFFER_ITEMS = 16;
  const MAX_VIEWER_BUFFER_BYTES = 8_000_000;
  let galleryContext = null;
  const recentViewerBodies = [];

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== "FLIP_COLLECTOR_GALLERY_CONTEXT") return;
    const expectedPostId = String(event.data.payload?.expectedPostId || "");
    const expectedUrl = String(event.data.payload?.expectedUrl || "");
    const mediaId = String(event.data.payload?.mediaId || "");
    if (!/^\d{5,30}$/.test(expectedPostId) || !/^\d{5,30}$/.test(mediaId) || !/^https:\/\/(?:www\.)?facebook\.com\/groups\//i.test(expectedUrl)) return;
    galleryContext = { expectedPostId, expectedUrl: expectedUrl.slice(0, 500), mediaId };
    for (const item of recentViewerBodies.splice(0)) emit(item.url, item.method, item.status, item.contentType, item.body, false);
  });

  function relevant(url, contentType) {
    return /(?:graphql|api\/graphql|relay|ajax|groups\/feed|CometGroup)/i.test(url) || /json|javascript/i.test(contentType || "");
  }

  function emit(url, method, status, contentType, body, remember = true) {
    try {
      if (!relevant(url, contentType) || body.length > MAX_BODY_BYTES) return;
      const source = core.canonicalSource(location.href);
      const viewerContext = galleryViewerContext();
      if (!source && !viewerContext) return;
      // Facebook may redirect a vanity group URL to its numeric group id while
      // response payloads still contain the vanity permalink. The final tab
      // URL is the binding authority; normalize that payload only for this
      // passive network observer. Gallery hydration still requires the exact
      // final group/post URL and exact media association.
      const extractionSource = source?.sourceType === "GROUP" ? { ...source, allowGroupRedirect: true } : source;
      const records = source ? core.extractStructuredRecordsFromText(body, "NETWORK", extractionSource, 0) : [];
      let galleryProof = null;
      let galleryAudit = null;
      if (viewerContext?.mediaId) {
        const gallerySource = galleryContext?.expectedPostId === viewerContext.postId ? core.canonicalSource(galleryContext.expectedUrl) : null;
        if (gallerySource) gallerySource.allowGroupRedirect = true;
        const proof = galleryContext?.expectedPostId === viewerContext.postId
          ? core.resolveGalleryMediaSetFromText(body, gallerySource, viewerContext.postId, viewerContext.mediaId)
          : null;
        if (proof?.status === "VERIFIED" && proof.currentMediaId === viewerContext.mediaId && proof.expectedPostId === viewerContext.postId) {
          galleryProof = {
            status: "VERIFIED",
            expectedPostId: proof.expectedPostId,
            currentMediaId: proof.currentMediaId,
            mediaIds: Array.isArray(proof.mediaIds) ? proof.mediaIds.slice(0, 50) : [],
            permalink: typeof proof.permalink === "string" ? proof.permalink.slice(0, 500) : null,
            candidate: proof.candidate || null,
          };
        }
        if (!galleryProof && galleryContext?.expectedPostId === viewerContext.postId) {
          galleryAudit = {
            ...core.inspectGalleryMediaPayload(body, viewerContext.postId, viewerContext.mediaId),
            proofReason: proof?.reason || "GALLERY_VIEWER_CONTEXT_NOT_PROVEN",
          };
        }
      }
      if (remember && viewerContext && !galleryProof) {
        recentViewerBodies.push({ url, method, status, contentType, body });
        while (
          recentViewerBodies.length > MAX_VIEWER_BUFFER_ITEMS
          || recentViewerBodies.reduce((total, item) => total + item.body.length, 0) > MAX_VIEWER_BUFFER_BYTES
        ) recentViewerBodies.shift();
        setTimeout(() => {
          const index = recentViewerBodies.findIndex((item) => item.body === body);
          if (index >= 0) recentViewerBodies.splice(index, 1);
        }, 30_000);
      }
      if (!records.length && !galleryProof) {
        if (galleryAudit) window.postMessage({ channel: "FLIP_COLLECTOR_NETWORK", payload: { url: sanitizedPath(url), method, status, contentType: String(contentType || "").slice(0, 120), size: body.length, records: [], galleryProof: null, galleryAudit } }, location.origin);
        return;
      }
      window.postMessage({ channel: "FLIP_COLLECTOR_NETWORK", payload: { url: sanitizedPath(url), method, status, contentType: String(contentType || "").slice(0, 120), size: body.length, records, galleryProof, galleryAudit } }, location.origin);
    } catch { /* passive observer must never affect Facebook */ }
  }

  function galleryViewerContext() {
    try {
      const current = new URL(location.href);
      const postId = current.searchParams.get("set")?.match(/^pcb\.(\d{5,30})$/i)?.[1] || null;
      const queryMediaId = current.searchParams.get("fbid") || "";
      const mediaId = /^\d{5,30}$/.test(queryMediaId) ? queryMediaId : galleryContext?.expectedPostId === postId && /^\d{5,30}$/.test(galleryContext.mediaId || "") ? galleryContext.mediaId : null;
      // Keep buffering bounded viewer responses even when Comet has already
      // removed `fbid` from the URL. The exact media id is supplied later by
      // the content script from the persisted exact-bound seed; no proof is
      // accepted until the replay has a matching media id and attachment
      // binding.
      if (!/^\/photo(?:\.php)?(?:\/|$)/i.test(current.pathname) || !postId) return null;
      return { postId, mediaId: mediaId ? String(mediaId) : null };
    } catch { return null; }
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
