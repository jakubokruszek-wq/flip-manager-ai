const statusNode = document.querySelector("#status");
const resultNode = document.querySelector("#result");

document.querySelector("#active").addEventListener("click", () => run("COLLECT_ACTIVE_SOURCE"));
document.querySelector("#all").addEventListener("click", () => run("COLLECT_CONFIGURED_SOURCES"));
document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());

void chrome.runtime.sendMessage({ type: "GET_COLLECTOR_STATE" }).then((state) => {
  if (state?.collectorState?.status === "collecting") statusNode.textContent = "Zbieranie...";
  if (state?.collectorLastResult) resultNode.textContent = summarize(state.collectorLastResult);
});

async function run(type) {
  statusNode.textContent = "Zbieranie...";
  resultNode.textContent = "";
  const response = await chrome.runtime.sendMessage({ type });
  statusNode.textContent = response?.ok ? "Zakonczono" : "Blad";
  resultNode.textContent = response?.ok ? summarize(response.result) : response?.error || "Nieznany blad";
}

function summarize(value) {
  const sources = value?.sources || [value];
  return sources.map((item) => `${item.sourceId || item.sourceUrl || "source"}: ${item.captured ?? 0} (${item.health?.status || item.status || "UNKNOWN"})`).join("\n");
}
