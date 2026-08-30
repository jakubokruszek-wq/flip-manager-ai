"use strict";

const DEFAULTS = ["https://www.facebook.com/groups/lodzsprzedazzakupwynajem/", "https://www.facebook.com/groups/402796264871862/", "https://www.facebook.com/groups/2928219830782023/", "https://www.facebook.com/groups/1253809205540869/", "https://www.facebook.com/groups/1424921570856189/", "https://www.facebook.com/groups/1689328011096404/"];
const connectionNode = document.querySelector("#connection-status");
const connectionDetailsNode = document.querySelector("#connection-details");
const pairingButton = document.querySelector("#pairing");

void chrome.storage.local.get(["apiUrl", "sources"]).then((value) => {
  document.querySelector("#apiUrl").value = value.apiUrl || "https://flip-manager-ai.vercel.app";
  document.querySelector("#sources").value = (value.sources || DEFAULTS).join("\n");
});
void loadPairingStatus();

document.querySelector("#save").addEventListener("click", async () => {
  const sources = document.querySelector("#sources").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  await chrome.storage.local.set({ apiUrl: document.querySelector("#apiUrl").value.replace(/\/+$/, ""), sources });
  document.querySelector("#status").textContent = "Zapisano.";
});
pairingButton.addEventListener("click", () => chrome.tabs.create({ url: "https://flip-manager-ai.vercel.app/flip-finder/collector/setup" }));

async function loadPairingStatus() {
  const local = await chrome.runtime.sendMessage({ type: "GET_PAIRING_STATUS" });
  renderPairingStatus(local);
  if (local?.shouldVerify) renderPairingStatus(await chrome.runtime.sendMessage({ type: "VERIFY_PAIRING_STATUS" }));
}

function renderPairingStatus(value) {
  if (!value?.status) return;
  connectionNode.textContent = value.label || "Połączenie niezweryfikowane";
  connectionNode.dataset.status = value.status;
  const details = [value.deviceLabel, value.lastHeartbeatAt ? `Heartbeat: ${formatDate(value.lastHeartbeatAt)}` : null, value.lastSuccessfulScanAt ? `Ostatni scan: ${formatDate(value.lastSuccessfulScanAt)}` : null, value.health ? `Health: ${value.health}` : null];
  connectionDetailsNode.textContent = details.filter(Boolean).join(" · ");
  pairingButton.hidden = !["DISCONNECTED", "RECONNECT_REQUIRED"].includes(value.status);
}

function formatDate(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? "—" : date.toLocaleString("pl-PL"); }
