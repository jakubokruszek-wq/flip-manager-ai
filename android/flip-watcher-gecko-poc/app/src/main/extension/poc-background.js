(function installGeckoPocBackground(scope) {
  "use strict";
  // Count-only network diagnostics. This script NEVER reads response bodies
  // or headers (the separate opt-in module owns response streaming),
  // cookies or full URLs. It counts request events only while one diagnosis
  // window is armed for the tab showing the approved group; see
  // FlipGeckoPocAdapter.createTrafficCounter for what is counted.
  const adapter = scope.FlipGeckoPocAdapter;
  const counter = adapter.createTrafficCounter();
  // 0.2.4: page-load measurement, armed by the app before navigation.
  const loadCounter = adapter.createLoadCounter();

  // Arming requires a real tab whose top-level page is the approved group.
  function senderOnApprovedGroup(sender, accepted) {
    if (!sender || !sender.tab || !Number.isInteger(sender.tab.id) || sender.tab.id < 0 || typeof sender.url !== "string") return false;
    if (sender.frameId !== undefined && sender.frameId !== 0) return false;
    let url;
    try { url = new URL(sender.url); } catch { return false; }
    const facebook = url.protocol === "https:" && /(^|\.)facebook\.com$/i.test(url.hostname);
    const fixture = url.protocol === "http:" && url.hostname === "127.0.0.1";
    const segment = (url.pathname.match(/^\/groups\/([^/]+)\/?$/) || [])[1];
    return (facebook || fixture) && Boolean(segment) && accepted.includes(segment);
  }

  const WATCHED = { urls: ["https://*.facebook.com/*", "https://facebook.com/*", "https://*.fbcdn.net/*", "http://127.0.0.1/*"] };
  const onBefore = details => {
    // Not armed: the event is dropped without looking at it.
    if (counter.isArmed()) counter.record(details);
    if (loadCounter.isArmed()) loadCounter.record(details);
  };
  const onCompleted = details => {
    if (counter.isArmed()) counter.complete(details);
    if (loadCounter.isArmed()) loadCounter.complete(details);
  };
  const api = { webRequest: false, listener: false, onCompleted: false };
  if (scope.browser && browser.webRequest) {
    api.webRequest = true;
    try {
      browser.webRequest.onBeforeRequest.addListener(onBefore, WATCHED);
      api.listener = browser.webRequest.onBeforeRequest.hasListener(onBefore);
    } catch { api.listener = false; }
    try {
      browser.webRequest.onCompleted.addListener(onCompleted, WATCHED);
      api.onCompleted = browser.webRequest.onCompleted.hasListener(onCompleted);
    } catch { api.onCompleted = false; }
  }

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message.type !== "string") return undefined;
    const accepted = (Array.isArray(message.accepted) ? message.accepted : []).filter(id => typeof id === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(id)).slice(0, 6);
    if (message.type === "armTraffic") {
      const ok = senderOnApprovedGroup(sender, accepted) && counter.arm(sender.tab.id, message.windowMs);
      return Promise.resolve({ armed: ok ? 1 : 0 });
    }
    if (message.type === "readTraffic") {
      const result = sender && sender.tab ? counter.read(sender.tab.id, api) : null;
      return Promise.resolve(result || { counts: { netCountingActive: 0, netBodyCapture: 0, apiWebRequest: api.webRequest ? 1 : 0, apiListener: api.listener ? 1 : 0, apiOnCompleted: api.onCompleted ? 1 : 0 }, requestPaths: [] });
    }
    return undefined;
  });

  // App <-> background port (official GeckoView native messaging). The app
  // arms the load measurement here BEFORE calling loadUri, because no page
  // script exists yet at that moment. Replies carry counts only.
  let appPort = null;
  function connectApp() {
    try {
      appPort = browser.runtime.connectNative("flipPoc");
    } catch {
      appPort = null;
      return;
    }
    appPort.onMessage.addListener(message => {
      if (!message || typeof message !== "object" || typeof message.nonce !== "string") return;
      const reply = value => { try { appPort.postMessage({ nonce: message.nonce, ...value }); } catch { /* app gone */ } };
      if (message.type === "abortResponse") {
        scope.FlipResponseDiagnosis?.abort();
        scope.FlipMainTransport?.abort();
        reply({type:"abortResponseResult"});
      } else if (message.type === "abortResponseLoad") {
        scope.FlipResponseDiagnosis.abortLoad(message);
        reply({type:"abortResponseLoadResult"});
      } else if (message.type === "readResponseLoad") {
        reply({type:"responseDiagnosisResult",...scope.FlipResponseDiagnosis.readLoad(message)});
      } else if (message.type === "armLoad") {
        reply({ type: "armLoadResult", armed: loadCounter.arm(message.nonce, message.accepted, message.windowMs) ? 1 : 0, listener: api.listener ? 1 : 0 });
      } else if (message.type === "readLoad") {
        const result = loadCounter.read(message.nonce);
        reply({ type: "readLoadResult", found: result ? 1 : 0, ...(result || { counts: {}, stopReason: null, requestPaths: [] }) });
      } else if (message.type === "abortLoad") {
        reply({ type: "abortLoadResult", aborted: loadCounter.abort(message.nonce) ? 1 : 0 });
      }
    });
    appPort.onDisconnect.addListener(() => {
      // App or runtime went away: drop any pending measurement.
      loadCounter.abort();
      scope.FlipResponseDiagnosis?.abort();
        scope.FlipMainTransport?.abort();
      appPort = null;
    });
  }
  connectApp();
})(globalThis);
