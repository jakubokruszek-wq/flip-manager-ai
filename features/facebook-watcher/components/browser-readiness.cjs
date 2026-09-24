/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("node:http");

function isValidReadinessResponse(response) {
  if (!response || response.statusCode !== 200) return false;
  const contentType = String(response.headers?.["content-type"] ?? "").toLowerCase();
  if (!contentType.split(";", 1)[0].trim().includes("application/json")) return false;
  const body = response.body;
  return Boolean(
    body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      Object.prototype.hasOwnProperty.call(body, "commitSha") &&
      Object.prototype.hasOwnProperty.call(body, "environment"),
  );
}

function probeReadiness(url, { get = http.get, timeoutMs = 1_500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let request;
    try {
      request = get(url, { headers: { accept: "application/json" } }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes <= 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          const text = chunks.join("");
          let body = null;
          let parseError = null;
          try {
            body = JSON.parse(text);
          } catch (error) {
            parseError = error instanceof Error ? error.message : String(error);
          }
          const result = {
            ready: isValidReadinessResponse({
              statusCode: response.statusCode,
              headers: response.headers,
              body,
            }),
            statusCode: response.statusCode ?? null,
            contentType: response.headers["content-type"] ?? null,
            body,
            parseError,
          };
          finish(result);
        });
        response.on("error", (error) => finish({ ready: false, error: error.message }));
        response.setTimeout(timeoutMs, () => response.destroy(new Error("readiness response timeout")));
      });
      request.setTimeout(timeoutMs, () => request.destroy(new Error("readiness request timeout")));
      request.once("error", (error) => finish({ ready: false, error: error.message }));
    } catch (error) {
      finish({ ready: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = null;
  while (Date.now() < deadline) {
    lastProbe = await probeReadiness(url);
    if (lastProbe.ready) return lastProbe;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Local Next server did not expose valid readiness at ${url} within ${timeoutMs}ms; last probe: ${JSON.stringify(lastProbe)}`);
}

module.exports = { isValidReadinessResponse, probeReadiness, waitForServer };
