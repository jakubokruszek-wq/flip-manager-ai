"use strict";

const statusNode = document.querySelector("#status");
const resultNode = document.querySelector("#result");
const connectionNode = document.querySelector("#connection-status");
const connectionDetailsNode = document.querySelector("#connection-details");
const pairingButton = document.querySelector("#pairing");

document.querySelector("#active").addEventListener("click", () => run("COLLECT_ACTIVE_SOURCE"));
document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());
pairingButton.addEventListener("click", () => chrome.tabs.create({ url: "https://flip-manager-ai.vercel.app/flip-finder/collector/setup" }));

void loadPairingStatus();
void chrome.runtime.sendMessage({ type: "GET_COLLECTOR_STATE" }).then((state) => {
  renderState(state?.collectorState);
  if (state?.collectorLastResult) resultNode.textContent = summarize(state.collectorLastResult);
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.collectorState?.newValue) renderState(changes.collectorState.newValue);
  if (changes.collectorPairingState?.newValue) void renderStoredPairingStatus();
});

async function loadPairingStatus() {
  const local = await chrome.runtime.sendMessage({ type: "GET_PAIRING_STATUS" });
  renderPairingStatus(local);
  if (local?.shouldVerify) renderPairingStatus(await chrome.runtime.sendMessage({ type: "VERIFY_PAIRING_STATUS" }));
}

async function renderStoredPairingStatus() {
  renderPairingStatus(await chrome.runtime.sendMessage({ type: "GET_PAIRING_STATUS" }));
}

async function run(type) {
  renderState({ status: "collecting", phase: "MAIN_FEED", progress: "Skanowanie feedu…" });
  resultNode.textContent = "";
  const response = await chrome.runtime.sendMessage({ type });
  renderState(response?.ok ? { status: "idle", phase: "DONE", progress: "Zakończono" } : { status: "failed", progress: "Błąd" });
  resultNode.textContent = response?.ok ? summarize(response.result) : response?.error || "Nieznany błąd";
}

function renderPairingStatus(value) {
  if (!value?.status) return;
  connectionNode.textContent = value.label || "Połączenie niezweryfikowane";
  connectionNode.dataset.status = value.status;
  connectionDetailsNode.textContent = pairingDetails(value);
  pairingButton.hidden = !["DISCONNECTED", "RECONNECT_REQUIRED"].includes(value.status);
}

function pairingDetails(value) {
  const parts = [];
  if (value.deviceLabel) parts.push(value.deviceLabel);
  if (value.lastHeartbeatAt) parts.push(`Heartbeat: ${formatDate(value.lastHeartbeatAt)}`);
  if (value.lastSuccessfulScanAt) parts.push(`Ostatni scan: ${formatDate(value.lastSuccessfulScanAt)}`);
  if (value.health) parts.push(`Health: ${value.health}`);
  return parts.join(" · ");
}

function renderState(state) {
  if (!state) return;
  statusNode.textContent = state.status === "collecting" ? state.progress || "Zbieranie…" : state.progress || (state.status === "failed" ? "Błąd" : "Gotowy");
}

function summarize(value) {
  const sources = value?.sources || [value];
  return sources.map((item) => `${item.sourceId || item.sourceUrl || "source"}: ${item.captured ?? 0} unique (${item.health?.status || item.status || "UNKNOWN"})\n${item.merged ? `MAIN ${item.mainFeed?.captured ?? 0}; SEARCH ${item.search?.length ?? 0}; duplicates ${item.merged.duplicatesRemoved}` : ""}`).join("\n");
}

function formatDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("pl-PL"); }
