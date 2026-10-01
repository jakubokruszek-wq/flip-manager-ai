/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");

/**
 * Real production bug: the popup's "Wykryj grupy nieruchomości" button
 * failed with the generic "Nie udało się wykryć grup. Odśwież stronę
 * Facebooka i spróbuj ponownie." on a real, already-open "Twoje grupy" tab.
 * Root cause (group-discovery.test.cjs/popup.test.cjs already prove the
 * source text is right, but never that it actually behaves this way):
 * group-discovery.js's static content_scripts entry only ever (re-)injects
 * on a real browser navigation -- never on Facebook's own internal
 * client-side routing, which is one real way an operator reaches this exact
 * tab/URL. chrome.tabs.sendMessage then throws "receiving end does not
 * exist", popup.js's own fix retries by injecting the script directly
 * (chrome.scripting.executeScript) and re-sending the same request. This
 * genuinely EXECUTES popup.js in a real V8 context (the same vm.runInContext
 * pattern already established for bootstrap.js/group-discovery-bridge.js) to
 * prove that retry really runs and really recovers, not just that the
 * source text contains the right-looking calls.
 */
function fakeElement() {
  const listeners = {};
  return {
    hidden: false,
    textContent: "",
    dataset: {},
    addEventListener(type, listener) { listeners[type] = listener; },
    click() { listeners.click?.(); },
  };
}

function buildContext({ tab, sendMessageResults, executeScriptImpl } = {}) {
  const elements = {
    "#connection-status": fakeElement(),
    "#connection-details": fakeElement(),
    "#pairing": fakeElement(),
    "#status": fakeElement(),
    "#active": fakeElement(),
    "#discover-groups": fakeElement(),
    "#options": fakeElement(),
    "#result": fakeElement(),
  };
  const document = { querySelector: (selector) => elements[selector] };
  const sendMessageCalls = [];
  const executeScriptCalls = [];
  let sendMessageCallIndex = 0;
  const chrome = {
    tabs: {
      query: async () => [tab ?? { id: 1, url: "https://www.facebook.com/groups/joins/" }],
      sendMessage: (tabId, message) => {
        sendMessageCalls.push({ tabId, message });
        const outcome = sendMessageResults[sendMessageCallIndex];
        sendMessageCallIndex += 1;
        if (outcome === undefined) throw new Error("sendMessage not configured for this call");
        if (outcome instanceof Error) return Promise.reject(outcome);
        return Promise.resolve(outcome);
      },
      create: () => {},
    },
    scripting: {
      executeScript: (options) => {
        executeScriptCalls.push(options);
        return executeScriptImpl ? executeScriptImpl(options) : Promise.resolve();
      },
    },
    runtime: {
      sendMessage: () => Promise.resolve({}),
      openOptionsPage() {},
    },
    storage: { onChanged: { addListener() {} } },
  };
  const context = vm.createContext({ document, chrome, console: { debug() {}, warn() {} }, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  return { elements, sendMessageCalls, executeScriptCalls };
}

async function clickDiscoverAndSettle(elements) {
  elements["#discover-groups"].click();
  // popup.js's handler is async; give its promise chain a turn to resolve.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a successful first response never attempts injection", async () => {
  const { elements, sendMessageCalls, executeScriptCalls } = buildContext({
    sendMessageResults: [{ ok: true }],
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(sendMessageCalls.length, 1);
  assert.equal(executeScriptCalls.length, 0, "no injection must ever be attempted when the first response already succeeds");
  assert.equal(elements["#result"].textContent, "Wykryte grupy wysłano do podglądu w Managerze.");
});

test("a thrown first sendMessage (content script missing) triggers re-injection, then a successful retry", async () => {
  const { elements, sendMessageCalls, executeScriptCalls } = buildContext({
    sendMessageResults: [new Error("Could not establish connection. Receiving end does not exist."), { ok: true }],
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(sendMessageCalls.length, 2, "the request must be retried exactly once after injecting");
  assert.equal(executeScriptCalls.length, 1);
  assert.equal(executeScriptCalls[0].target.tabId, 1);
  assert.equal(executeScriptCalls[0].files.length, 1);
  assert.equal(executeScriptCalls[0].files[0], "group-discovery.js");
  assert.equal(elements["#result"].textContent, "Wykryte grupy wysłano do podglądu w Managerze.", "the retry's own successful result must reach the UI");
});

test("injection succeeding but the retried sendMessage still failing falls back to the generic, honest error", async () => {
  const { elements, executeScriptCalls } = buildContext({
    sendMessageResults: [new Error("Receiving end does not exist."), new Error("Receiving end does not exist.")],
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(executeScriptCalls.length, 1, "injection must still be attempted exactly once");
  assert.equal(elements["#result"].textContent, "Nie udało się wykryć grup. Odśwież stronę Facebooka i spróbuj ponownie.");
});

test("injection itself failing (e.g. host permission denied) never throws out of the click handler, and falls back to the generic error", async () => {
  const { elements, sendMessageCalls } = buildContext({
    sendMessageResults: [new Error("Receiving end does not exist.")],
    executeScriptImpl: () => Promise.reject(new Error("Cannot access contents of the page")),
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(sendMessageCalls.length, 1, "the retry's own sendMessage must never be attempted when injection itself failed");
  assert.equal(elements["#result"].textContent, "Nie udało się wykryć grup. Odśwież stronę Facebooka i spróbuj ponownie.");
});

test("a specific error from a reachable content script (not a missing one) is shown as-is, never overwritten by the generic fallback", async () => {
  const { elements, executeScriptCalls } = buildContext({
    sendMessageResults: [{ ok: false, error: "GROUP_DISCOVERY_ORIGIN_REJECTED" }],
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(executeScriptCalls.length, 0, "a real, reachable response (even a failing one) must never trigger the missing-content-script recovery path");
  assert.equal(elements["#result"].textContent, "GROUP_DISCOVERY_ORIGIN_REJECTED");
});

test("the wrong tab (not Facebook's 'Twoje grupy' page) never attempts sendMessage or injection at all", async () => {
  const { elements, sendMessageCalls, executeScriptCalls } = buildContext({
    tab: { id: 1, url: "https://www.facebook.com/" },
    sendMessageResults: [],
  });
  await clickDiscoverAndSettle(elements);
  assert.equal(sendMessageCalls.length, 0);
  assert.equal(executeScriptCalls.length, 0);
  assert.equal(elements["#result"].textContent, "Otwórz stronę Facebooka „Twoje grupy” (facebook.com/groups/joins/), aby wykryć grupy.");
});
