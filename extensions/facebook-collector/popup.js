const statusNode = document.querySelector("#status");
const resultNode = document.querySelector("#result");

document.querySelector("#active").addEventListener("click", () => run("COLLECT_ACTIVE_SOURCE"));
document.querySelector("#all")?.remove();
document.querySelector("#options").addEventListener("click", () => chrome.runtime.openOptionsPage());

void chrome.runtime.sendMessage({ type: "GET_COLLECTOR_STATE" }).then((state) => {
  renderState(state?.collectorState);
  if (state?.collectorLastResult) resultNode.textContent = summarize(state.collectorLastResult);
});
chrome.storage.onChanged.addListener((changes) => { if (changes.collectorState?.newValue) renderState(changes.collectorState.newValue); });

async function run(type) {
  renderState({ status: "collecting", phase: "MAIN_FEED", progress: "Skanowanie feedu…" });
  resultNode.textContent = "";
  const response = await chrome.runtime.sendMessage({ type });
  renderState(response?.ok ? { status: "idle", phase: "DONE", progress: "Zakończono" } : { status: "failed", progress: "Błąd" });
  resultNode.textContent = response?.ok ? summarize(response.result) : response?.error || "Nieznany blad";
}

function renderState(state) { if (!state) return; statusNode.textContent = state.status === "collecting" ? state.progress || "Zbieranie…" : state.progress || (state.status === "failed" ? "Błąd" : "Gotowy"); }

function summarize(value) {
  const sources = value?.sources || [value];
  return sources.map((item) => `${item.sourceId || item.sourceUrl || "source"}: ${item.captured ?? 0} unique (${item.health?.status || item.status || "UNKNOWN"})\n${item.merged ? `MAIN ${item.mainFeed?.captured ?? 0}; SEARCH ${item.search?.length ?? 0}; duplicates ${item.merged.duplicatesRemoved}` : ""}`).join("\n");
}
