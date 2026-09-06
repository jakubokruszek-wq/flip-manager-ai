/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "image-blocker.js"), "utf8");

const VALID_RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest",
  "ping", "media", "websocket", "other", "csp_report", "webtransport", "webbundle",
]);

function validateRuleShape(rule) {
  assertNoUndefined(rule);
  assert.deepEqual(Object.keys(rule).sort(), ["action", "condition", "id", "priority"]);
  assert.equal(Number.isInteger(rule.id), true);
  assert.equal(rule.id > 0 && rule.id <= 2_147_483_647, true);
  assert.equal(Number.isInteger(rule.priority), true);
  assert.equal(rule.priority >= 1, true);
  assert.deepEqual(Object.keys(rule.action).sort(), ["type"]);
  assert.equal(rule.action.type, "block");
  assert.equal(typeof rule.condition, "object");
  const conditionKeys = Object.keys(rule.condition);
  assert.equal(conditionKeys.includes("tabIds"), true);
  assert.equal(Array.isArray(rule.condition.tabIds), true);
  assert.equal(rule.condition.tabIds.length > 0, true);
  assert.equal(rule.condition.tabIds.every((id) => Number.isInteger(id) && id >= 0), true);
  assert.equal(Array.isArray(rule.condition.resourceTypes), true);
  assert.equal(rule.condition.resourceTypes.length > 0, true);
  assert.equal(rule.condition.resourceTypes.every((type) => VALID_RESOURCE_TYPES.has(type)), true);
  assert.equal(["urlFilter", "regexFilter"].filter((key) => typeof rule.condition[key] === "string").length <= 1, true);
  for (const key of conditionKeys) assert.ok(["tabIds", "resourceTypes", "urlFilter", "regexFilter", "requestDomains", "initiatorDomains"].includes(key), `unknown condition key: ${key}`);
}

function assertNoUndefined(value, path = "rule") {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.notEqual(item, undefined, `${path}.${key} is undefined`);
    if (item && typeof item === "object") assertNoUndefined(item, `${path}.${key}`);
  }
}

function createPolicyContext({ rejectUpdates = null, initialRules = [], runtimeLastErrorMessage = null } = {}) {
  const listeners = { before: null, completed: null };
  const updates = [];
  const storage = {};
  let sessionRules = JSON.parse(JSON.stringify(initialRules));
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
      runtime: {
        getManifest() { return { version: "0.1.0", permissions: ["declarativeNetRequest"] }; },
        lastError: null,
      },
      storage: { local: { async set(value) { Object.assign(storage, JSON.parse(JSON.stringify(value))); } } },
      webRequest: {
        onBeforeRequest: { addListener(listener) { listeners.before = listener; } },
        onCompleted: { addListener(listener) { listeners.completed = listener; } },
      },
      declarativeNetRequest: {
        updateSessionRules(update, callback) {
          if (runtimeLastErrorMessage && Array.isArray(update.addRules)) {
            context.chrome.runtime.lastError = { message: runtimeLastErrorMessage };
            callback();
            context.chrome.runtime.lastError = null;
            return undefined;
          }
          return (async () => {
            if (typeof rejectUpdates === "function") await rejectUpdates(update);
            if (Array.isArray(update.removeRuleIds)) {
              assert.equal(update.removeRuleIds.every((id) => Number.isInteger(id) && id > 0), true);
            }
            if (Array.isArray(update.addRules)) {
              update.addRules.forEach(validateRuleShape);
              const ids = update.addRules.map((rule) => rule.id);
              assert.equal(new Set(ids).size, ids.length, "duplicate addRules id");
            }
            const removed = new Set(Array.isArray(update.removeRuleIds) ? update.removeRuleIds : []);
            sessionRules = sessionRules.filter((rule) => !removed.has(rule.id));
            if (Array.isArray(update.addRules)) {
              const existing = new Set(sessionRules.map((rule) => rule.id));
              assert.equal(update.addRules.some((rule) => existing.has(rule.id)), false, "rule id collision");
              sessionRules.push(...JSON.parse(JSON.stringify(update.addRules)));
            }
            updates.push(update);
          })();
        },
        async getSessionRules() { return JSON.parse(JSON.stringify(sessionRules)); },
      },
    },
  });
  context.globalThis.chrome = context.chrome;
  vm.runInContext(source, context);
  return { policy: context.globalThis.FlipCollectorImagePolicy, listeners, updates, storage, sessionRules: () => JSON.parse(JSON.stringify(sessionRules)) };
}

test("SOURCE_SCAN_DATA_ONLY blocks image requests only on the attached collector tab", async () => {
  const { policy, listeners, updates } = createPolicyContext();
  policy.startSession("scan-1", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(11, { sessionId: "scan-1", mode: policy.SOURCE_SCAN_DATA_ONLY });

  const addRules = updates.at(-1).addRules;
  assert.equal(addRules.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[0].condition.tabIds)), [11]);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[0].condition.resourceTypes)), ["image"]);
  assert.equal(addRules[0].priority, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[0].action)), { type: "block" });
  assert.deepEqual(Object.keys(addRules[0].condition).sort(), ["resourceTypes", "tabIds"]);
  assert.equal(addRules[1].condition.regexFilter.includes("fbcdn\\.net"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[1].condition.resourceTypes)), ["media", "xmlhttprequest"]);
  assert.deepEqual(JSON.parse(JSON.stringify(addRules[1].condition.tabIds)), [11]);

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
  assert.deepEqual(JSON.parse(JSON.stringify(policy.snapshot("scan-2"))), { imageMode: policy.SOURCE_SCAN_DATA_ONLY, imageRequestsBlocked: 0, imageRequestsAllowed: 0, imageResponsesReceived: 0, imageBytesReceived: 0, listingImageRequestsStarted: 0, listingImageResponsesReceived: 0, listingImageBytesReceived: 0, thumbnailsDownloaded: 0, fullImagesDownloaded: 0, fullGalleriesDownloaded: 0, photoViewerNavigations: 0, photoViewerNavigationsWithImageBytes: 0, imageRequestTypeCounts: {}, imageResponseTypeCounts: {}, imageResponseSamples: [] });
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

test("image telemetry identifies narrowly matched CDN media without treating GraphQL as an image", async () => {
  const { policy, listeners } = createPolicyContext();
  policy.startSession("request-proof", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(20, { sessionId: "request-proof", mode: policy.SOURCE_SCAN_DATA_ONLY, photoViewer: true });
  listeners.before({ tabId: 20, type: "xmlhttprequest", url: "https://scontent.xx.fbcdn.net/v/t39.30808-6/12345.jpg?opaque=1" });
  listeners.before({ tabId: 20, type: "xmlhttprequest", url: "https://www.facebook.com/api/graphql/" });
  listeners.completed({ tabId: 20, type: "xmlhttprequest", url: "https://scontent.xx.fbcdn.net/v/t39.30808-6/12345.jpg?opaque=1", responseHeaders: [{ name: "Content-Length", value: "42" }] });
  const diagnostics = policy.snapshot("request-proof");
  assert.equal(diagnostics.imageRequestsBlocked, 1);
  assert.equal(diagnostics.imageResponsesReceived, 1);
  assert.equal(diagnostics.imageBytesReceived, 42);
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.imageRequestTypeCounts)), { xmlhttprequest: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(diagnostics.imageResponseTypeCounts)), { xmlhttprequest: 1 });
  assert.equal(diagnostics.imageResponseSamples[0].path.includes(".jpg"), true);
  assert.equal(JSON.stringify(diagnostics).includes("opaque"), false);
  assert.equal(diagnostics.photoViewerNavigationsWithImageBytes, 1);
});

test("image telemetry blocks Facebook CDN kf media fetched as XHR", async () => {
  const { policy, listeners } = createPolicyContext();
  policy.startSession("kf-proof", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(22, { sessionId: "kf-proof", mode: policy.SOURCE_SCAN_DATA_ONLY });
  listeners.before({ tabId: 22, type: "xmlhttprequest", url: "https://scontent-waw2-1.xx.fbcdn.net/m1/v/t6/example.kf" });
  assert.equal(policy.snapshot("kf-proof").imageRequestsBlocked, 1);
});

test("production DNR rules use only the MV3 schema and supported resource types", async () => {
  const { policy, updates } = createPolicyContext();
  policy.startSession("schema-1", policy.SOURCE_SCAN_DATA_ONLY);
  await policy.attachTab(21, { sessionId: "schema-1", mode: policy.SOURCE_SCAN_DATA_ONLY });
  const install = updates.at(-1);
  assert.deepEqual(Object.keys(install).sort(), ["addRules", "removeRuleIds"]);
  install.addRules.forEach(validateRuleShape);
  assert.equal(install.addRules.some((rule) => rule.condition.resourceTypes.includes("xmlhttprequest") && typeof rule.condition.regexFilter === "string"), true);
  assert.equal(install.addRules.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(install.addRules[0].condition)), { resourceTypes: ["image"], tabIds: [21] });
  assert.deepEqual(JSON.parse(JSON.stringify(install.addRules[1].condition.resourceTypes)), ["media", "xmlhttprequest"]);
  assert.deepEqual(JSON.parse(JSON.stringify(install.addRules[1].condition.tabIds)), [21]);
  assert.equal(typeof install.addRules[1].condition.regexFilter, "string");

  assert.throws(() => validateRuleShape({ id: "21", priority: 1000, action: "block", condition: { tabIds: [21], resourceTypes: ["image"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1000, action: { type: "block", telemetry: true }, condition: { tabIds: [21], resourceTypes: ["image"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1000, action: { type: "block" }, condition: { tabIds: ["21"], resourceTypes: ["image"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: undefined, priority: 1000, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: ["image"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1000, action: { type: "block" }, condition: { tabIds: [undefined], resourceTypes: ["image"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1000, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: ["fetch"], urlFilter: "|http" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1000, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: ["image"], urlFilter: "|http", telemetry: "bad" } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1, action: { type: "allow" }, condition: { tabIds: [21], resourceTypes: ["image"] } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 0, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: ["image"] } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1, action: { type: "block" }, condition: { tabIds: [], resourceTypes: ["image"] } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: [] } }));
  assert.throws(() => validateRuleShape({ id: 21, priority: 1, action: { type: "block" }, condition: { tabIds: [21], resourceTypes: ["image"], urlFilter: undefined } }));
});

test("DNR installation failures preserve the Chrome error, session state and sanitized rule options", async () => {
  const { policy, storage, sessionRules } = createPolicyContext({ rejectUpdates: async (update) => {
    if (Array.isArray(update.addRules)) {
      const error = new Error("Invalid value for resourceTypes: fetch");
      error.name = "TypeError";
      throw error;
    }
  } });
  policy.startSession("schema-error", policy.SOURCE_SCAN_DATA_ONLY);
  await assert.rejects(
    policy.attachTab(22, { sessionId: "schema-error", mode: policy.SOURCE_SCAN_DATA_ONLY }),
    (error) => error.code === "SOURCE_SCAN_IMAGE_RULE_INSTALL_FAILED"
      && error.diagnostics.tabId === 22
      && error.diagnostics.chromeErrorName === "TypeError"
      && error.diagnostics.chromeErrorMessage.includes("resourceTypes")
      && error.diagnostics.options.addRules.length === 2
      && error.diagnostics.runtime.policyVersion === "SOURCE_SCAN_IMAGE_ONLY_V2"
      && error.diagnostics.runtime.dnrPermissionPresent === true
      && error.diagnostics.runtimeValues.tabIdType === "number"
      && error.diagnostics.runtimeValues.tabIdIsInteger === true
      && error.diagnostics.runtimeValues.priority === 1
      && error.diagnostics.sessionRulesBefore.length === 0
      && error.diagnostics.sessionRulesAfter.length === 0
      && error.diagnostics.targetRulePresentBefore === false
      && error.diagnostics.targetRulePresentAfter === false
      && !JSON.stringify(error.diagnostics).match(/token|secret|cookie|hmac/i),
  );
  assert.equal(sessionRules().length, 0);
  assert.equal(storage.collectorDnrDiagnostics.installResult, "FAIL");
  await assert.doesNotReject(policy.finishSession("schema-error"));
});

test("successful image-only install records the exact runtime rule and atomic session state", async () => {
  const { policy, storage, sessionRules } = createPolicyContext();
  policy.startSession("runtime-proof", policy.SOURCE_SCAN_DATA_ONLY);
  const result = await policy.attachTab(23, { sessionId: "runtime-proof", mode: policy.SOURCE_SCAN_DATA_ONLY });
  assert.equal(result.installDiagnostics.installResult, "PASS");
  assert.equal(result.installDiagnostics.targetRulePresentBefore, false);
  assert.equal(result.installDiagnostics.targetRulePresentAfter, true);
  assert.equal(sessionRules().length, 2);
  assert.equal(storage.collectorDnrDiagnostics.runtime.updateSessionRulesAvailable, true);
  assert.deepEqual(storage.collectorDnrDiagnostics.options.addRules[0].condition, { resourceTypes: ["image"], tabIds: [23] });
});

test("a real high Chrome tab id gets an independent valid rule id", async () => {
  const { policy, sessionRules } = createPolicyContext();
  policy.startSession("high-tab", policy.SOURCE_SCAN_DATA_ONLY);
  const result = await policy.attachTab(369_530_379, { sessionId: "high-tab", mode: policy.SOURCE_SCAN_DATA_ONLY });
  assert.equal(Number.isInteger(result.ruleIds[0]), true);
  assert.equal(result.ruleIds[0] >= 1 && result.ruleIds[0] <= 2_147_483_647, true);
  assert.notEqual(result.ruleIds[0], 369_530_379);
  assert.deepEqual(sessionRules()[0].condition.tabIds, [369_530_379]);
  assert.equal(result.installDiagnostics.runtimeValues.ruleIdType, "number");
  assert.equal(result.installDiagnostics.runtimeValues.tabIdIsInteger, true);
});

test("parallel attached tabs receive unique session rule ids", async () => {
  const { policy, sessionRules } = createPolicyContext();
  policy.startSession("two-tabs", policy.SOURCE_SCAN_DATA_ONLY);
  const first = await policy.attachTab(369_530_379, { sessionId: "two-tabs", mode: policy.SOURCE_SCAN_DATA_ONLY });
  const second = await policy.attachTab(369_530_380, { sessionId: "two-tabs", mode: policy.SOURCE_SCAN_DATA_ONLY });
  assert.notEqual(first.ruleIds[0], second.ruleIds[0]);
  assert.equal(new Set(sessionRules().map((rule) => rule.id)).size, 4);
});

test("callback runtime.lastError is retained separately from the wrapped install code", async () => {
  const { policy, storage } = createPolicyContext({ runtimeLastErrorMessage: "Rule with id 1700000048 is invalid" });
  policy.startSession("runtime-error", policy.SOURCE_SCAN_DATA_ONLY);
  await assert.rejects(
    policy.attachTab(24, { sessionId: "runtime-error", mode: policy.SOURCE_SCAN_DATA_ONLY }),
    (error) => error.code === "SOURCE_SCAN_IMAGE_RULE_INSTALL_FAILED"
      && error.diagnostics.chromeErrorName === "ChromeRuntimeError"
      && error.diagnostics.chromeRuntimeLastErrorMessage === "Rule with id 1700000048 is invalid",
  );
  assert.equal(storage.collectorDnrDiagnostics.chromeRuntimeLastErrorMessage, "Rule with id 1700000048 is invalid");
});
