/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "image-blocker.js"), "utf8");

function createPolicyContext() {
  const listeners = { before: null, completed: null };
  const updates = [];
  const context = vm.createContext({
    URL,
    Map,
    Set,
    Number,
    String,
    Array,
    Object,
    Math,
    Promise,
    Date,
    console: { debug() {}, warn() {} },
    globalThis: {},
    chrome: {
      webRequest: {
        onBeforeRequest: { addListener(listener) { listeners.before = listener; } },
        onCompleted: { addListener(listener) { listeners.completed = listener; } },
      },
      declarativeNetRequest: {
        async updateSessionRules(update) { updates.push(update); },
        async getSessionRules() { return []; },
      },
    },
  });
  context.globalThis.chrome = context.chrome;
  vm.runInContext(source, context);
  return { policy: context.globalThis.FlipCollectorImagePolicy, listeners, updates };
}

test("SOURCE_SCAN_DATA_ONLY blocks image requests only on the attached collector tab", async () => {
  const { policy, listeners, updates } = createPolicyContext();
  policy.startSession("scan-1", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(11, { sessionId: "scan-1", mode: policy.SOURCE_SCAN_DATA_ONLY });

  const addRules = updates.at(-1).addRules;
  assert.equal(addRules.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[0].condition.tabIds)), [11]);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[0].condition.resourceTypes)), ["image"]);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[1].condition.tabIds)), [11]);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[1].condition.resourceTypes)), ["media", "xmlhttprequest", "fetch"]);

  listeners.before({ tabId: 11, type: "image", url: "https://scontent.xx.fbcdn.net/v/t1.0/a.jpg" });
  listeners.before({ tabId: 11, type: "fetch", url: "https://www.facebook.com/api/graphql/" });
  listeners.before({ tabId: 12, type: "image", url: "https://scontent.xx.fbcdn.net/v/t1.0/other.jpg" });
  const diagnostics = policy.snapshot("scan-1");
  assert.equal(diagnostics.imageRequestsBlocked, 1);
  assert.equal(diagnostics.imageRequestsAllowed, 0);
  assert.equal(diagnostics.imageResponsesReceived, 0);
  assert.equal(diagnostics.imageBytesReceived, 0);
  assert.equal(diagnostics.listingImageBytesReceived, 0);
  assert.equal(diagnostics.fullGalleriesDownloaded, 0);
  assert.equal(diagnostics.photoViewerNavigationsWithImageBytes, 0);
  assert.equal(addRules[1].condition.regexFilter.includes("fbcdn\\.net"), true);
});

test("GALLERY_HYDRATION_MEDIA_ALLOWED does not install blocking rules and records responses", async () => {
  const { policy, listeners, updates } = createPolicyContext();
  policy.startSession("gallery-1", policy.GALLERY_HYDRATION_MEDIA_ALLOWED);
  await policy.attachTab(12, { sessionId: "gallery-1", mode: policy.GALLERY_HYDRATION_MEDIA_ALLOWED });
  const addRules = updates.at(-1).addRules;
  assert.equal(addRules, undefined);

  listeners.before({ tabId: 12, type: "image", url: "https://scontent.xx.fbcdn.net/v/t1.0/a.jpg" });
  listeners.completed({ tabId: 12, type: "image", url: "https://scontent.xx.fbcdn.net/v/t1.0/a.jpg", responseHeaders: [{ name: "Content-Length", value: "1234" }] });
  const diagnostics = policy.snapshot("gallery-1");
  assert.equal(diagnostics.imageRequestsAllowed, 1);
  assert.equal(diagnostics.listingImageRequestsStarted, 1);
  assert.equal(diagnostics.listingImageResponsesReceived, 1);
  assert.equal(diagnostics.listingImageBytesReceived, 1234);
  assert.equal(diagnostics.imageResponsesReceived, 1);
  assert.equal(diagnostics.imageBytesReceived, 1234);
  assert.equal(diagnostics.thumbnailsDownloaded, 1);
  assert.equal(diagnostics.fullImagesDownloaded, 1);
});

test("tab rules and telemetry are cleaned up after a source session", async () => {
  const { policy, updates } = createPolicyContext();
  policy.startSession("scan-2", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(17, { sessionId: "scan-2", mode: policy.SOURCE_SCAN_DATA_ONLY });
  const result = await policy.finishSession("scan-2");
  assert.equal(result.imageMode, policy.SOURCE_SCAN_DATA_ONLY);
  assert.deepEqual(JSON.parse(JSON.stringify(policy.snapshot("scan-2"))), { imageMode: policy.SOURCE_SCAN_DATA_ONLY, imageRequestsBlocked: 0, imageRequestsAllowed: 0, imageResponsesReceived: 0, imageBytesReceived: 0, listingImageRequestsStarted: 0, listingImageResponsesReceived: 0, listingImageBytesReceived: 0, thumbnailsDownloaded: 0, fullImagesDownloaded: 0, fullGalleriesDownloaded: 0, photoViewerNavigations: 0, photoViewerNavigationsWithImageBytes: 0 });
  assert.ok(updates.some((update) => Array.isArray(update.removeRuleIds) && update.removeRuleIds.length === 2));
});

test("image diagnostics contain no credentials or raw payloads", async () => {
  const { policy, listeners } = createPolicyContext();
  policy.startSession("scan-3", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(19, { sessionId: "scan-3", mode: policy.SOURCE_SCAN_DATA_ONLY });
  listeners.before({ tabId: 19, type: "image", url: "https://scontent.xx.fbcdn.net/private.jpg?token=secret" });
  const serialized = JSON.stringify(policy.snapshot("scan-3"));
  assert.doesNotMatch(serialized, /secret|token|cookie|hmac|payload/i);
});
