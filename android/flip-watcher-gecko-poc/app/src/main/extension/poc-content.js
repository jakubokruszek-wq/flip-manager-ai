(function installGeckoPocContent(scope) {
  "use strict";
  // Content script of the GeckoView POC. It connects to the app over the
  // official native-messaging port and acts only on the app's requests:
  // "probe" (page diagnostics) and "scan" (post ids of the approved group).
  // No fetch/XHR, no gallery, no clicks, no form access: it reads the DOM the
  // user already sees. Input values are never read; only element counts.
  const adapter = scope.FlipGeckoPocAdapter;
  const core = scope.FlipFacebookCollectorCore;
  let port;
  try {
    port = browser.runtime.connectNative("flipPoc");
  } catch {
    return;
  }
  let scanning = false;

  function probe() {
    const doc = scope.document;
    return {
      host: scope.location.hostname,
      path: scope.location.pathname.slice(0, 200),
      title: String(doc.title || "").slice(0, 120),
      readyState: doc.readyState,
      elements: doc.getElementsByTagName("*").length,
      forms: doc.forms.length,
      inputs: doc.querySelectorAll("input").length,
      passwordInputs: doc.querySelectorAll('input[type="password"]').length,
      articles: topLevelCards().length,
      iframes: doc.querySelectorAll("iframe").length,
    };
  }

  function topLevelCards() {
    const all = Array.from(scope.document.querySelectorAll('[role="article"],article'));
    return all.filter(card => !card.parentElement || !card.parentElement.closest('[role="article"],article'));
  }

  function snapshot() {
    const doc = scope.document;
    const cards = topLevelCards().slice(0, 300).map(card => ({
      // Only the card's own links; links inside nested cards (comments) are left out.
      hrefs: Array.from(card.querySelectorAll("a[href]"))
        .filter(a => a.closest('[role="article"],article') === card)
        .map(a => a.href)
        .slice(0, 200),
    }));
    const structured = Array.from(doc.querySelectorAll('script[type="application/json"],script[type="application/ld+json"]'))
      .slice(0, 100)
      .map(script => script.textContent || "");
    return {
      href: scope.location.href,
      bodyTextSample: String((doc.body && (doc.body.innerText || doc.body.textContent)) || "").slice(0, 4000),
      hasPasswordInput: Boolean(doc.querySelector('input[type="password"]')),
      hasLoginForm: Boolean(doc.querySelector('form[action*="login"]')),
      hasCaptcha: Boolean(doc.querySelector('iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]')),
      cards,
      structured,
    };
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function scan(request) {
    const input = { groupId: request.groupId, maxPosts: request.maxPosts, allowLoopback: request.allowLoopback === true };
    const startHref = scope.location.href;
    const scrolls = Math.max(0, Math.min(5, Math.floor(Number(request.scrolls) || 0)));
    const pauseMs = Math.max(200, Math.min(4000, Math.floor(Number(request.scrollPauseMs) || 1500)));
    let scrolled = 0;
    for (let i = 0; i < scrolls; i++) {
      // Stop at once when the page left the approved group.
      if (adapter.classify(snapshot(), input) !== "GROUP_OK") break;
      scope.scrollBy(0, Math.max(400, scope.innerHeight || 800));
      scrolled++;
      await sleep(pauseMs);
    }
    if (scope.location.href !== startHref && adapter.classify(snapshot(), input) !== "GROUP_OK") {
      return { status: "NAVIGATED_AWAY", posts: [], diagnostics: {}, scrolls: scrolled };
    }
    const result = adapter.evaluate(snapshot(), input, core);
    return { ...result, scrolls: scrolled };
  }

  port.onMessage.addListener(async message => {
    if (!message || typeof message !== "object" || typeof message.nonce !== "string") return;
    if (message.type === "probe") {
      port.postMessage({ type: "probeResult", nonce: message.nonce, probe: probe() });
      return;
    }
    if (message.type !== "scan") return;
    if (scanning) {
      port.postMessage({ type: "scanResult", nonce: message.nonce, status: "BUSY", posts: [], diagnostics: {} });
      return;
    }
    scanning = true;
    try {
      const result = await scan(message);
      port.postMessage({ type: "scanResult", nonce: message.nonce, probe: probe(), ...result });
    } catch (error) {
      port.postMessage({ type: "scanResult", nonce: message.nonce, status: "COLLECTOR_ERROR", error: String((error && error.message) || error).slice(0, 120), posts: [], diagnostics: {} });
    } finally {
      scanning = false;
    }
  });

  port.postMessage({ type: "ready", probe: probe() });
})(globalThis);
