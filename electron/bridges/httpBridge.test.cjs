"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const zlib = require("node:zlib");

const { handlers, MAX_BODY_BYTES, __test } = require("./httpBridge.cjs");

let server;
let baseUrl;
let otherServer;
let otherBaseUrl;

const listen = () =>
  new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/json") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "X-Trace": "trace-1" });
        res.end(JSON.stringify({ ok: true, path: "/json" }));
        return;
      }
      if (url.pathname === "/echo") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ method: req.method, body, auth: req.headers.authorization ?? null }));
        });
        return;
      }
      if (url.pathname === "/redirect") {
        res.writeHead(302, { Location: "/json" });
        res.end();
        return;
      }
      if (url.pathname === "/loop") {
        res.writeHead(302, { Location: "/loop" });
        res.end();
        return;
      }
      if (url.pathname === "/gzip") {
        const payload = zlib.gzipSync(Buffer.from(JSON.stringify({ compressed: true })));
        res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
        res.end(payload);
        return;
      }
      if (url.pathname === "/binary") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3, 255]));
        return;
      }
      if (url.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("late");
        }, 3000);
        return;
      }
      if (url.pathname === "/echo-headers") {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            method: req.method,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: req.headers,
          }));
        });
        return;
      }
      if (url.pathname === "/redirect-303") {
        req.resume();
        res.writeHead(303, { Location: "/echo-headers" });
        res.end();
        return;
      }
      if (url.pathname === "/redirect-same-origin") {
        res.writeHead(302, { Location: "/echo-headers" });
        res.end();
        return;
      }
      if (url.pathname === "/redirect-cross-origin") {
        res.writeHead(302, { Location: `${otherBaseUrl}/echo-headers` });
        res.end();
        return;
      }
      if (url.pathname === "/stream-forever") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        const chunk = Buffer.alloc(256 * 1024, 7);
        const pump = () => {
          while (!res.destroyed && res.write(chunk)) {
            // keep the socket buffer full
          }
          if (!res.destroyed) res.once("drain", pump);
        };
        res.on("close", () => res.removeAllListeners("drain"));
        pump();
        return;
      }
      if (url.pathname === "/gzip-bomb") {
        const payload = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 0x61));
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
        res.end(payload);
        return;
      }
      if (url.pathname === "/trickle") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        const timer = setInterval(() => {
          if (res.destroyed) {
            clearInterval(timer);
            return;
          }
          res.write(".");
        }, 100);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing");
    });
    server.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

const wire = (overrides) => ({
  id: `test-${Math.random().toString(36).slice(2)}`,
  method: "GET",
  url: `${baseUrl}/json`,
  headers: [],
  timeoutMs: 5000,
  followRedirects: true,
  maxRedirects: 10,
  verifyTls: true,
  ...overrides,
});

const listenOther = () =>
  new Promise((resolve) => {
    otherServer = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ headers: req.headers }));
    });
    otherServer.listen(0, "127.0.0.1", () => {
      // Same host, different port: a different origin.
      otherBaseUrl = `http://localhost:${otherServer.address().port}`;
      resolve();
    });
  });

test.before(async () => {
  await listenOther();
  await listen();
});
test.after(async () => {
  server.closeAllConnections?.();
  otherServer.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => otherServer.close(resolve));
});

test("send returns a shaped JSON response", async () => {
  const result = await handlers.send({ wire: wire() });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.bodyKind, "json");
  assert.match(result.response.bodyText, /"ok":true/);
  assert.equal(
    result.response.headers.find((header) => header.key.toLowerCase() === "x-trace").value,
    "trace-1"
  );
  assert.equal(result.response.truncated, false);
  assert.ok(result.response.durationMs >= 0);
});

test("send forwards method, body and auth header", async () => {
  const result = await handlers.send({
    wire: wire({
      method: "POST",
      url: `${baseUrl}/echo`,
      bodyText: '{"hello":"world"}',
      headers: [
        { key: "Content-Type", value: "application/json" },
        { key: "Authorization", value: "Bearer token-1" },
      ],
    }),
  });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.response.bodyText);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.body, '{"hello":"world"}');
  assert.equal(parsed.auth, "Bearer token-1");
});

test("send follows redirects and records them", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/redirect` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.response.redirects, [{ status: 302, location: "/json" }]);
});

test("send surfaces the 3xx response when redirects are disabled", async () => {
  const result = await handlers.send({
    wire: wire({ url: `${baseUrl}/redirect`, followRedirects: false }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 302);
  assert.deepEqual(result.response.bodyKind, "empty");
});

test("send stops after maxRedirects", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/loop`, maxRedirects: 2 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "too-many-redirects");
});

test("send decodes gzip bodies", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/gzip` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.bodyKind, "json");
  assert.deepEqual(JSON.parse(result.response.bodyText), { compressed: true });
});

test("send returns binary bodies as base64", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/binary` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.bodyKind, "binary");
  assert.equal(Buffer.from(result.response.bodyBase64, "base64").toString("hex"), "00010203ff");
});

test("send reports http errors as data, not exceptions", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/missing` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.status, 404);
  assert.equal(result.response.bodyText, "missing");
});

test("send times out and maps the error code", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/slow`, timeoutMs: 200 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
});

test("cancel aborts an in-flight request", async () => {
  const target = wire({ url: `${baseUrl}/slow`, timeoutMs: 5000 });
  const pending = handlers.send({ wire: target });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(handlers.cancel({ requestId: target.id }), { ok: true, cancelled: true });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
});

test("invalid urls and missing wires are rejected", async () => {
  assert.equal((await handlers.send({})).error.code, "invalid-request");
  const result = await handlers.send({ wire: wire({ url: "not a url" }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-url");
});

test("header sanitization drops CRLF and bogus names", () => {
  const list = __test.sanitizeHeaderList([
    { key: "X-Ok", value: "fine" },
    { key: "X-Bad", value: "a\r\nInjected: 1" },
    { key: "Bad Name", value: "value" },
    { key: "", value: "empty" },
    null,
  ]);
  assert.deepEqual(list, [{ key: "X-Ok", value: "fine" }]);
  assert.deepEqual(__test.headersToNode(list), { "X-Ok": "fine" });
});

test("helpers clamp and classify", () => {
  assert.equal(__test.clampTimeout(undefined), 30000);
  assert.equal(__test.clampTimeout(10), 1000);
  assert.equal(__test.clampRedirects(-1), 10);
  assert.equal(__test.clampRedirects(99), 20);
  assert.equal(__test.classifyBody("application/json", Buffer.from("{}")), "json");
  assert.equal(__test.classifyBody("", Buffer.from([0, 1])), "binary");
  assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
});

test("normalizeError maps node error codes", () => {
  assert.equal(__test.normalizeError({ code: "ENOTFOUND", message: "x" }).code, "dns");
  assert.equal(__test.normalizeError({ code: "ECONNREFUSED", message: "x" }).code, "connection");
  assert.equal(__test.normalizeError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", message: "x" }).code, "tls");
  assert.equal(__test.normalizeError(new Error("Request cancelled")).code, "cancelled");
});

test("a cancel that arrives before send registers still cancels the request", async () => {
  const target = wire({ url: `${baseUrl}/slow`, timeoutMs: 5000 });
  assert.deepEqual(handlers.cancel({ requestId: target.id }), { ok: true, cancelled: false });
  const started = Date.now();
  const result = await handlers.send({ wire: target });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "cancelled");
  assert.ok(Date.now() - started < 1000, "the request must not run to completion");
  assert.equal(__test.activeRequests.has(target.id), false);
});

test("bodies are sent with Content-Length instead of chunked encoding", async () => {
  const result = await handlers.send({
    wire: wire({ method: "POST", url: `${baseUrl}/echo-headers`, bodyText: "héllo" }),
  });
  assert.equal(result.ok, true);
  const echoed = JSON.parse(result.response.bodyText);
  assert.equal(echoed.body, "héllo");
  assert.equal(echoed.headers["content-length"], String(Buffer.byteLength("héllo")));
  assert.equal(echoed.headers["transfer-encoding"], undefined);
});

test("a 303 redirect switches to GET and drops the body headers", async () => {
  const result = await handlers.send({
    wire: wire({
      method: "POST",
      url: `${baseUrl}/redirect-303`,
      bodyText: '{"a":1}',
      headers: [{ key: "Content-Type", value: "application/json" }],
    }),
  });
  assert.equal(result.ok, true);
  const echoed = JSON.parse(result.response.bodyText);
  assert.equal(echoed.method, "GET");
  assert.equal(echoed.body, "");
  assert.equal(echoed.headers["content-type"], undefined);
  assert.equal(echoed.headers["content-length"], undefined);
});

test("credentials follow same-origin redirects but not cross-origin ones", async () => {
  const headers = [
    { key: "Authorization", value: "Bearer secret" },
    { key: "Cookie", value: "sid=1" },
    { key: "X-Trace", value: "keep" },
  ];
  const same = await handlers.send({ wire: wire({ url: `${baseUrl}/redirect-same-origin`, headers }) });
  assert.equal(same.ok, true);
  const sameHeaders = JSON.parse(same.response.bodyText).headers;
  assert.equal(sameHeaders.authorization, "Bearer secret");
  assert.equal(sameHeaders.cookie, "sid=1");

  const cross = await handlers.send({ wire: wire({ url: `${baseUrl}/redirect-cross-origin`, headers }) });
  assert.equal(cross.ok, true);
  const crossHeaders = JSON.parse(cross.response.bodyText).headers;
  assert.equal(crossHeaders.authorization, undefined);
  assert.equal(crossHeaders.cookie, undefined);
  assert.equal(crossHeaders["x-trace"], "keep");
});

test("an endless body is cut at the cap instead of downloading until the timeout", async () => {
  const started = Date.now();
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/stream-forever`, timeoutMs: 20000 }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.truncated, true);
  assert.equal(result.response.sizeBytes, MAX_BODY_BYTES);
  assert.ok(Date.now() - started < 10000, "truncation must stop the download");
});

test("decompression output is capped (gzip bomb)", async () => {
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/gzip-bomb` }) });
  assert.equal(result.ok, true);
  assert.equal(result.response.truncated, true);
  assert.ok(result.response.sizeBytes <= MAX_BODY_BYTES);
  assert.ok(result.response.bodyText.startsWith("aaaa"));
});

test("the timeout is a hard deadline even while bytes keep trickling in", async () => {
  const started = Date.now();
  const result = await handlers.send({ wire: wire({ url: `${baseUrl}/trickle`, timeoutMs: 1000 }) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.ok(Date.now() - started < 4000);
});

test("decodeBodyCapped decodes truncated gzip input as far as it goes", async () => {
  const full = zlib.gzipSync(Buffer.from("x".repeat(100000)));
  const partial = full.subarray(0, Math.floor(full.length / 2));
  const decoded = await __test.decodeBodyCapped(partial, "gzip", 1024 * 1024);
  assert.equal(decoded.decoded, true);
  assert.ok(decoded.buffer.length > 0);
  assert.ok(/^x+$/.test(decoded.buffer.toString("utf8")));
  const passthrough = await __test.decodeBodyCapped(Buffer.from("plain"), "", 10);
  assert.equal(passthrough.decoded, false);
  assert.equal(passthrough.buffer.toString("utf8"), "plain");
});

test("headersForRedirect drops body and credential headers as requested", () => {
  const headers = [
    { key: "Authorization", value: "a" },
    { key: "Content-Type", value: "b" },
    { key: "Host", value: "example.com" },
    { key: "X-Keep", value: "c" },
  ];
  assert.deepEqual(
    __test.headersForRedirect(headers, { dropsBody: true, crossOrigin: false }).map((h) => h.key),
    ["Authorization", "Host", "X-Keep"],
  );
  assert.deepEqual(
    __test.headersForRedirect(headers, { dropsBody: false, crossOrigin: true }).map((h) => h.key),
    ["Content-Type", "X-Keep"],
  );
});
