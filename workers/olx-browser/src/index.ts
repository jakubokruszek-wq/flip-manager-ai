import { fetchOlxWithBrowser } from "./browser.ts";
import { startWorkerProcess } from "./process-main.ts";

void startWorkerProcess({ scrape: fetchOlxWithBrowser });
