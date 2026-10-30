import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { accessConfig, authorized, createDesktopServer } from "./access.mjs";
const env = { WATCHER_DESKTOP_PASSWORD: "a-test-password-with-32-characters", WATCHER_DESKTOP_ORIGIN: "https://desktop.example" };
const config = accessConfig(env);
const validHeaders = { host: "desktop.example", "x-forwarded-proto": "https", authorization: config.authorization };

test("desktop fails closed without credentials or a canonical TLS origin", () => {
  for (const patch of [{ WATCHER_DESKTOP_PASSWORD: "short" }, { WATCHER_DESKTOP_ORIGIN: "http://desktop.example" }, { WATCHER_DESKTOP_ORIGIN: "https://user:pass@desktop.example" }, { WATCHER_DESKTOP_ORIGIN: "https://desktop.example/path" }]) assert.throws(() => accessConfig({ ...env, ...patch }));
  assert(authorized({ headers: validHeaders }, config));
  for (const patch of [{ authorization: "Basic bad" }, { "x-forwarded-proto": "http" }, { host: "attacker.example" }, { origin: "https://attacker.example" }]) assert(!authorized({ headers: { ...validHeaders, ...patch } }, config));
  assert(!authorized({ headers: validHeaders }, config, true));
  assert(authorized({ headers: { ...validHeaders, origin: config.origin } }, config, true));
});

async function listen(server) { await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
function request(port, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body, headers: response.headers }));
    }); req.on("error", reject); req.end();
  });
}
test("HTTP desktop is protected, credentials never reach noVNC, health is truthful", async t => {
  let forwardedHeaders;
  const upstream = http.createServer((req, res) => { forwardedHeaders = req.headers; res.end("desktop-assets"); });
  const upstreamPort = await listen(upstream);
  let healthy = false;
  const desktop = createDesktopServer({ config, healthy: () => healthy, status: async () => ({ pairing: "DISCONNECTED" }), upstreamPort });
  const port = await listen(desktop.server);
  t.after(async () => { await desktop.close(); await new Promise(resolve => upstream.close(resolve)); });
  assert.equal((await request(port, "/healthz")).status, 503); healthy = true;
  assert.equal((await request(port, "/healthz")).status, 200);
  assert.equal((await request(port, "/vnc.html")).status, 401);
  assert.equal((await request(port, "/status", validHeaders)).body, '{"pairing":"DISCONNECTED"}');
  assert.equal((await request(port, "/", validHeaders)).status, 302);
  const response = await request(port, "/vnc.html", validHeaders);
  assert.equal(response.body, "desktop-assets"); assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(forwardedHeaders.authorization, undefined);
  assert.equal((await request(port, "/vnc.html", validHeaders, "POST")).status, 405);
});
test("WebSocket rejects unauthenticated and cross-origin upgrades before connecting upstream", async t => {
  const desktop = createDesktopServer({ config, healthy: () => true, status: async () => ({}) });
  const port = await listen(desktop.server); t.after(() => desktop.close());
  for (const extra of ["", `Authorization: ${config.authorization}\r\nOrigin: https://attacker.example\r\n`]) {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET /websockify HTTP/1.1\r\nHost: desktop.example\r\nX-Forwarded-Proto: https\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`));
      socket.setTimeout(2000, () => socket.destroy(new Error("socket timeout")));
      let data = ""; socket.on("data", chunk => { data += chunk; }); socket.on("end", () => resolve(data)); socket.on("error", reject);
    });
    assert.match(reply, /401 Unauthorized/);
  }
});
test("authenticated same-origin WebSocket tunnels data and removes desktop credentials", async t => {
  let forwarded;
  const upstream = http.createServer();
  upstream.on("upgrade", (request, socket) => {
    forwarded = request.headers;
    const accept = createHash("sha1").update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", data => socket.write(data));
    socket.on("end", () => socket.destroy());
  });
  const desktop = createDesktopServer({ config, healthy: () => true, status: async () => ({}), upstreamPort: await listen(upstream) });
  const port = await listen(desktop.server);
  t.after(async () => { await desktop.close(); await new Promise(resolve => upstream.close(resolve)); });
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET /websockify HTTP/1.1\r\nHost: desktop.example\r\nX-Forwarded-Proto: https\r\nAuthorization: ${config.authorization}\r\nOrigin: https://desktop.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.setTimeout(2000, () => socket.destroy(new Error("socket timeout")));
    let data = "", sent = false;
    socket.on("data", chunk => {
      data += chunk;
      if (!sent && data.includes("101 Switching Protocols")) { sent = true; socket.write("probe"); }
      if (data.includes("probe")) { socket.destroy(); resolve(); }
    }); socket.on("error", reject);
  });
  assert.equal(forwarded.authorization, undefined);
});
