/* eslint-disable @typescript-eslint/no-require-imports */
const http = require("node:http");
const { spawn } = require("node:child_process");

const operatorUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "operator@example.test",
  app_metadata: { role: "operator" },
  user_metadata: {},
  aud: "authenticated",
  created_at: "2026-09-06T12:00:00.000Z",
};

const operatorSession = {
  access_token: "browser-test-access-token",
  refresh_token: "browser-test-refresh-token",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 4_102_444_800,
  user: operatorUser,
};

async function startFakeSupabaseAuthServer() {
  const server = http.createServer((request, response) => {
    if (request.url === "/auth/v1/user") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(operatorUser));
      return;
    }
    if (request.url?.startsWith("/auth/v1/token")) {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        let credentials = {};
        try { credentials = JSON.parse(body || "{}"); } catch { /* Supabase will receive a normal error below. */ }
        if (credentials.password !== "correct-password") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_grant", error_description: "Invalid login credentials" }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(operatorSession));
      });
      return;
    }
    if (request.url === "/auth/v1/logout") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url?.startsWith("/rest/v1/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  const requestedPort = Number(process.env.BROWSER_AUTH_PORT ?? 0);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

async function addOperatorSessionCookie(context, baseUrl) {
  await context.addCookies([{
    name: "sb-127-auth-token",
    value: JSON.stringify(operatorSession),
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function ensureProductionBuild(nextBin, root, env) {
  if (process.env.SKIP_BROWSER_BUILD === "1") return;
  await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nextBin, "build"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    build.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
    build.once("error", reject);
    build.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`next build failed with exit code ${code}; output: ${output}`)));
  });
}

module.exports = { addOperatorSessionCookie, ensureProductionBuild, operatorSession, operatorUser, startFakeSupabaseAuthServer };
