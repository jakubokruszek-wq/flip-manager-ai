import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";

export function accessConfig(env) {
  const password = env.WATCHER_DESKTOP_PASSWORD;
  if (typeof password !== "string" || password.length < 24 || password.length > 256 || /[\r\n]/.test(password)) throw new Error("WATCHER_DESKTOP_PASSWORD must contain 24–256 characters");
  const origin = new URL(env.WATCHER_DESKTOP_ORIGIN || "");
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("WATCHER_DESKTOP_ORIGIN must be an HTTPS origin");
  return { origin: origin.origin, authorization: `Basic ${Buffer.from(`flip:${password}`).toString("base64")}` };
}
const digest = value => createHash("sha256").update(value).digest();
export function authorized(request, config, websocket = false) {
  if (request.headers["x-forwarded-proto"] !== "https" || request.headers.host !== new URL(config.origin).host) return false;
  if (request.headers.origin && request.headers.origin !== config.origin) return false;
  if (websocket && request.headers.origin !== config.origin) return false;
  const header = request.headers.authorization;
  return typeof header === "string" && header.length <= 1024 && timingSafeEqual(digest(header), digest(config.authorization));
}

/** The only exposed port. VNC and noVNC listen on loopback, never publicly. */
export function createDesktopServer({ config, healthy, status, upstreamPort = 6081 }) {
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "frame-ancestors 'none'" };
  const reject = response => {
    response.writeHead(401, { ...headers, "WWW-Authenticate": 'Basic realm="Flip Watcher", charset="UTF-8"' });
    response.end("Authentication required");
  };
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(healthy() ? 200 : 503, headers); response.end(healthy() ? "up" : "starting"); return;
    }
    if (!authorized(request, config)) { reject(response); return; }
    if (!["GET", "HEAD"].includes(request.method)) { response.writeHead(405, headers); response.end(); return; }
    if (request.url === "/status") {
      try { response.writeHead(200, { ...headers, "Content-Type": "application/json" }); response.end(JSON.stringify(await status())); }
      catch { response.end(JSON.stringify({ state: "UNAVAILABLE" })); }
      return;
    }
    if (request.url === "/") {
      response.writeHead(302, { ...headers, Location: "/vnc.html?autoconnect=true&resize=remote&path=websockify" }); response.end(); return;
    }
    const upstream = http.request({ hostname: "127.0.0.1", port: upstreamPort, method: request.method, path: request.url, headers: { host: "localhost" } }, incoming => {
      response.writeHead(incoming.statusCode || 502, { ...incoming.headers, ...headers }); incoming.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502, headers); response.end("Desktop unavailable"); });
    upstream.setTimeout(15_000, () => upstream.destroy());
    request.on("aborted", () => upstream.destroy()); upstream.end();
  });
  server.headersTimeout = 15_000; server.requestTimeout = 30_000;
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, client, head) => {
    if (request.url !== "/websockify" || !authorized(request, config, true)) { client.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); return; }
    const upstream = http.request({ hostname: "127.0.0.1", port: upstreamPort, path: "/websockify", headers: {
      host: "localhost", connection: "Upgrade", upgrade: "websocket", origin: config.origin,
      "sec-websocket-key": request.headers["sec-websocket-key"], "sec-websocket-version": "13",
      ...(request.headers["sec-websocket-protocol"] ? { "sec-websocket-protocol": request.headers["sec-websocket-protocol"] } : {}),
    } });
    const close = () => { upstream.destroy(); client.destroy(); };
    upstream.on("error", close); client.on("error", close); client.on("close", () => upstream.destroy());
    upstream.setTimeout(10_000, close);
    upstream.on("response", () => close());
    upstream.on("upgrade", (incoming, remote, upstreamHead) => {
      upstream.setTimeout(0); remote.setTimeout(0);
      client.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(incoming.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) client.write(upstreamHead);
      if (head.length) remote.write(head);
      remote.on("error", close); remote.on("close", () => client.destroy());
      client.on("close", () => remote.destroy()); client.pipe(remote); remote.pipe(client);
    });
    upstream.end();
  });
  return { server, close: () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); } };
}
