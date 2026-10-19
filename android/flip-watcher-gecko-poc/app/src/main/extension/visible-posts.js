/* Local, one-shot rendered-DOM diagnosis. No storage, network or collector. */
(function(root) {
  "use strict";
  const keys = ["candidates", "semanticCandidates", "heuristicCandidates", "links", "confirmedIds", "permalinks", "priceCandidates", "areaCandidates", "roomCandidates", "districtCandidates", "photoCandidates", "visibleTextBlocks", "desktopMessageBlocks", "mobileTextBlocks", "fallbackTextBlocks", "ambiguousCards"];
  function context(href, group, fixture) {
    try {
      const u = new URL(href);
      return /^[a-zA-Z0-9._-]{1,100}$/.test(group) && (fixture === true || !u.search) && !u.hash &&
        ((u.protocol === "https:" && ["facebook.com", "www.facebook.com", "m.facebook.com"].includes(u.hostname)) ||
         (fixture === true && u.protocol === "http:" && u.hostname === "127.0.0.1")) &&
        u.pathname.replace(/\/$/, "") === "/groups/" + group;
    } catch { return false; }
  }
  // Reuse the unchanged desktop parser, with an independently explicit group
  // binding. Never let its optional source argument supply a missing group id.
  function exact(href, group) {
    try {
      const core = root.FlipFacebookCollectorCore;
      const u = new URL(href, "https://www.facebook.com");
      if (!core || u.protocol !== "https:" || u.username || u.password || u.port) return null;
      const pathGroup = (u.pathname.match(/^\/groups\/([^/]+)\/(?:posts|permalink)\/\d+\/?$/) || [])[1];
      const storyGroup = u.pathname === "/story.php" ? u.searchParams.get("id") : null;
      if ((pathGroup || storyGroup) !== group) return null;
      const link = core.parsePostLink(u.href, {sourceType:"GROUP", sourceId:group});
      return link && link.sourceType === "GROUP" && link.sourceId === group ? link.postId : null;
    } catch { return null; }
  }
  function analyze(input) {
    if (input.consent !== true || !context(input.href, input.groupId, input.fixture) || input.blocked || input.visible !== true) return {status:"STOP"};
    const counts = Object.fromEntries(keys.map(k => [k, 0]));
    const ids = new Set();
    for (const card of input.cards.slice(0, 20)) {
      counts.candidates++;
      counts[card.semantic ? "semanticCandidates" : "heuristicCandidates"]++;
      const links = (card.hrefs || []).slice(0, 100);
      counts.links += links.length;
      const bound = links.map(href => exact(href, input.groupId)).filter(Boolean);
      if (new Set(bound).size > 1) counts.ambiguousCards++;
      else for (const id of bound) { ids.add(id); counts.permalinks++; }
      const text = String(card.text || "").slice(0, 12000);
      if (/\b\d[\d .,]*\s*(?:zł|PLN)(?![a-zA-Ząćęłńóśźż])/i.test(text)) counts.priceCandidates++;
      if (/\b\d+(?:[,.]\d+)?\s*m(?:²|2)(?!\w)/i.test(text)) counts.areaCandidates++;
      if (/\b[1-9]\s*(?:pokoj|pokoje|pokoi)/i.test(text)) counts.roomCandidates++;
      if (/(?:dzielnica|dzielnicy)\s*[:–-]?\s*\p{L}/iu.test(text)) counts.districtCandidates++;
      if (card.photos > 0) counts.photoCandidates++;
    }
    counts.confirmedIds = ids.size;
    return {status:"GROUP_OK", counts};
  }
  function read(win, request) {
    const doc = win.document;
    const blocked = () => !!doc.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],[data-testid*="checkpoint"]') || /checkpoint|captcha|zaloguj się|log in|log into facebook|content isn.t available|group is private|join group to see|ta zawartość jest niedostępna|ta treść jest niedostępna|dołącz do grupy, aby/i.test((doc.title || "") + " " + ((doc.body && doc.body.innerText) || "").slice(0, 4000));
    if (request.consent !== true || !context(win.location.href, request.groupId, request.allowLoopback) || blocked() || doc.visibilityState !== "visible" || !(win.innerWidth > 0 && win.innerHeight > 0)) return {status:"STOP"};
    const visible = el => {
      const b = el.getBoundingClientRect(), s = win.getComputedStyle(el);
      return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < win.innerHeight && b.right > 0 && b.left < win.innerWidth && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    };
    const desktopSelector = '[data-ad-preview="message"],[data-testid="post_message"],[data-ad-comet-preview="message"],[data-ad-rendering-role="message"]';
    const mobileSelector = '[data-mcomponent="TextArea"],[data-mcomponent="Text"],[data-type="text"]';
    const semantic = el => el.matches('article,[role="article"]');
    const excluded = el => !!el.closest('script,style,noscript,input,textarea,select,nav,header,footer,[role="navigation"],[role="comment"],[data-testid*="comment"]');
    const readable = el => visible(el) && !excluded(el) && !!String(el.innerText || "").trim();
    const desktop = Array.from(doc.querySelectorAll(desktopSelector)).slice(0,2000).filter(readable);
    const mobile = Array.from(doc.querySelectorAll(mobileSelector)).slice(0,2000).filter(readable);
    const articles = Array.from(doc.querySelectorAll('article,[role="article"]')).slice(0,2000).filter(readable)
      .filter(el => !el.parentElement?.closest('article,[role="article"]'));
    const fallback = [];
    // Mobile markup can lack every desktop marker. Read bounded rendered text
    // nodes rather than requiring a price, area or a leaf MContainer first.
    // Nodes/strings remain local and ephemeral; only counts cross the port.
    if (!articles.length && !desktop.length && !mobile.length) {
      const walker = doc.createTreeWalker(doc.body, 4);
      let node, visited = 0;
      const seen = new Set();
      while ((node = walker.nextNode()) && visited++ < 5000 && fallback.length < 2000) {
        const el = node.parentElement;
        if (!el || el === doc.body || seen.has(el) || !String(node.nodeValue || "").trim() || !readable(el)) continue;
        if (el.closest('a,button,[role="button"]')) continue;
        seen.add(el); fallback.push(el);
      }
    }
    let cards = articles;
    if (!cards.length) cards = desktop.length ? desktop : mobile.length ? mobile : fallback;
    cards = [...new Set(cards)].filter(el => !cards.some(other => other !== el && el.contains(other))).slice(0,20);
    const result = analyze({consent:true, href:win.location.href, groupId:request.groupId, fixture:request.allowLoopback, visible:true, blocked:blocked(), cards:cards.slice(0,20).map(el => ({semantic:semantic(el), text:el.innerText, hrefs:Array.from(el.querySelectorAll('a[href]')).filter(visible).map(a=>a.href), photos:Array.from(el.querySelectorAll('img')).filter(visible).length}))});
    if (blocked() || !context(win.location.href, request.groupId, request.allowLoopback) || doc.visibilityState !== "visible" || !(win.innerWidth > 0 && win.innerHeight > 0)) return {status:"STOP"};
    if (result.counts) Object.assign(result.counts, {
      visibleTextBlocks: Math.min(2000, desktop.length + mobile.length + fallback.length),
      desktopMessageBlocks: desktop.length, mobileTextBlocks: mobile.length, fallbackTextBlocks: fallback.length
    });
    return result;
  }
  function watch(win, request, stop) {
    let done = false;
    const finish = (notify = true) => { if (done) return; done = true; observer.disconnect(); win.removeEventListener("pagehide", finish); win.document.removeEventListener("visibilitychange", check); win.removeEventListener("popstate", check); win.removeEventListener("hashchange", check); if (notify) stop(); };
    const check = () => {
      if (!context(win.location.href, request.groupId, request.allowLoopback) || win.document.visibilityState !== "visible" ||
          win.document.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="checkpoint"],[data-testid*="captcha"]') ||
          /checkpoint|captcha|zaloguj się|log in|log into facebook|content isn.t available|group is private|join group to see|ta zawartość jest niedostępna|ta treść jest niedostępna|dołącz do grupy, aby/i.test((win.document.title || "") + " " + ((win.document.body && win.document.body.innerText) || "").slice(0,4000))) finish();
    };
    const observer = new win.MutationObserver(check);
    observer.observe(win.document.documentElement, {childList:true, subtree:true, attributes:true, characterData:true});
    win.addEventListener("pagehide", finish);
    win.document.addEventListener("visibilitychange", check);
    win.addEventListener("popstate", check);
    win.addEventListener("hashchange", check);
    check();
    return () => finish(false);
  }
  const api = {context, exact, analyze, read, watch, keys};
  if (typeof module !== "undefined") module.exports = api;
  else root.FlipVisiblePosts = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
