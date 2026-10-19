/* Local, one-shot rendered-DOM diagnosis. No storage, network or collector. */
(function(root) {
  "use strict";
  const keys = ["candidates", "semanticCandidates", "heuristicCandidates", "links", "confirmedIds", "permalinks", "priceCandidates", "areaCandidates", "roomCandidates", "districtCandidates", "photoCandidates"];
  function context(href, group, fixture) {
    try {
      const u = new URL(href);
      return /^[a-zA-Z0-9._-]{1,100}$/.test(group) && (fixture === true || !u.search) && !u.hash &&
        ((u.protocol === "https:" && ["facebook.com", "www.facebook.com", "m.facebook.com"].includes(u.hostname)) ||
         (fixture === true && u.protocol === "http:" && u.hostname === "127.0.0.1")) &&
        u.pathname.replace(/\/$/, "") === "/groups/" + group;
    } catch { return false; }
  }
  function exact(href, group) {
    try {
      const u = new URL(href, "https://www.facebook.com");
      if (u.protocol !== "https:" || !["facebook.com", "www.facebook.com", "m.facebook.com"].includes(u.hostname) || u.username || u.password) return null;
      const m = u.pathname.match(/^\/groups\/([a-zA-Z0-9._-]+)\/(?:posts|permalink)\/(\d+)\/?$/);
      return m && m[1] === group ? m[2] : null;
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
      for (const href of links) { const id = exact(href, input.groupId); if (id) { ids.add(id); counts.permalinks++; } }
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
    const blocked = () => !!doc.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="captcha"],[data-testid*="checkpoint"]') || /checkpoint|captcha|zaloguj się|log in|log into facebook/i.test((doc.title || "") + " " + ((doc.body && doc.body.innerText) || "").slice(0, 4000));
    if (request.consent !== true || !context(win.location.href, request.groupId, request.allowLoopback) || blocked() || doc.visibilityState !== "visible") return {status:"STOP"};
    const visible = el => {
      const b = el.getBoundingClientRect(), s = win.getComputedStyle(el);
      return b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < win.innerHeight && b.right > 0 && b.left < win.innerWidth && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
    };
    const selector = 'article,[role="article"],[data-mcomponent="MContainer"],[data-type="container"]';
    const semantic = el => el.matches('article,[role="article"]');
    const nodes = Array.from(doc.querySelectorAll(selector)).slice(0, 5000).filter(visible);
    // Prefer semantic cards. Mobile fallback uses leaf containers with listing evidence;
    // wrappers are explicitly heuristic and never prove that a listing is a post.
    let cards = nodes.filter(semantic).filter(el => !el.parentElement.closest('article,[role="article"]'));
    if (!cards.length) cards = nodes.filter(el => !semantic(el) && !el.querySelector(selector) && /\d\s*(?:zł|PLN|m²|m2)/i.test(el.innerText || ""));
    const result = analyze({consent:true, href:win.location.href, groupId:request.groupId, fixture:request.allowLoopback, visible:true, blocked:blocked(), cards:cards.slice(0,20).map(el => ({semantic:semantic(el), text:el.innerText, hrefs:Array.from(el.querySelectorAll('a[href]')).filter(visible).map(a=>a.href), photos:Array.from(el.querySelectorAll('img')).filter(visible).length}))});
    if (blocked() || !context(win.location.href, request.groupId, request.allowLoopback) || doc.visibilityState !== "visible") return {status:"STOP"};
    return result;
  }
  function watch(win, request, stop) {
    let done = false;
    const finish = (notify = true) => { if (done) return; done = true; observer.disconnect(); win.removeEventListener("pagehide", finish); win.document.removeEventListener("visibilitychange", check); win.removeEventListener("popstate", check); win.removeEventListener("hashchange", check); if (notify) stop(); };
    const check = () => {
      if (!context(win.location.href, request.groupId, request.allowLoopback) || win.document.visibilityState !== "visible" ||
          win.document.querySelector('input[type="password"],form[action*="login"],iframe[src*="captcha"],input[name="captcha_response"],[data-testid*="checkpoint"],[data-testid*="captcha"]') ||
          /checkpoint|captcha|zaloguj się|log in|log into facebook/i.test((win.document.title || "") + " " + ((win.document.body && win.document.body.innerText) || "").slice(0,4000))) finish();
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
