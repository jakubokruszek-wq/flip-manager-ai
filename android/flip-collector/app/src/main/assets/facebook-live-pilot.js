(function installPilot(scope) {
  "use strict";
  // Passive DOM snapshot only. No fetch/XHR, gallery, network interception or navigation.
  scope.FlipAndroidLivePilot = function (document, input, nonce, startedAt) {
    const reply = value => scope.FlipPilot.postMessage(JSON.stringify({version: 1, nonce, ...value}));
    try {
      const path = scope.location.pathname;
      const text = String(document.body?.innerText || document.body?.textContent || "");
      if (/checkpoint|two_step_verification/.test(path)) return reply({stop: "CHECKPOINT"});
      if (/captcha/i.test(path) || document.querySelector('iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"]')) return reply({stop: "CAPTCHA"});
      if (/login|recover/.test(path) || document.querySelector('input[type="password"],form[action*="login"]')) return reply({stop: "LOGIN_REQUIRED"});
      if (/content isn't available|this content isn't available|group is private|join group to see|ta zawartość jest niedostępna|dołącz do grupy, aby/i.test(text)) return reply({stop: "GROUP_UNAVAILABLE"});
      if (scope.location.origin !== new URL(input.sourceUrl).origin || path.replace(/\/$/, "") !== `/groups/${input.sourceId}`) return reply({stop: "GROUP_UNAVAILABLE"});
      const batch = scope.FlipAndroidOfflineAdapter.collect(document, input);
      batch.posts = batch.posts.slice(0, 20).map(post => ({...post, media: post.media.slice(0, 20)}));
      if (!batch.posts.some(post => post.identityConfidence === "EXACT")) return reply({stop: "NO_VERIFIED_POSTS"});
      batch.collectedAt = new Date().toISOString();
      batch.imageMode = "SOURCE_SCAN_DATA_ONLY";
      batch.health = {status: "DEGRADED", visibleCardCount: document.querySelectorAll('article,[role="article"]').length,
        capturedPostCount: batch.posts.length, scrolls: 0, durationMs: Math.min(45000, Math.max(0, Date.now() - startedAt)),
        stopReason: batch.posts.length === 20 ? "POST_LIMIT" : "VISIBLE_SNAPSHOT", reasons: ["PILOT_VISIBLE_SNAPSHOT_ONLY"]};
      reply({batch});
    } catch { reply({stop: "COLLECTOR_ERROR"}); }
  };
})(globalThis);
