"use strict";

const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { URL } = require("url");

/**
 * Curl tool bridge — main-process side of the built-in HTTP client.
 *
 * Requests are sent with node's http/https modules rather than fetch so the
 * client owns redirects, TLS verification, timeouts and cancellation, and can
 * stream a response while enforcing the body cap. Nothing is persisted here:
 * the renderer owns request storage (encrypted vault) and passes a resolved
 * wire payload per call.
 */

const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Bodies above this size are not mirrored as base64 (re-decoding needs the bytes). */
const MAX_BODY_BASE64_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_COUNT = 200;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Decoded (decompressed) bodies are capped too, so a gzip bomb cannot exhaust memory. */
const MAX_DECODED_BODY_BYTES = MAX_BODY_BYTES;
/** A cancel that arrives before its request registered is remembered this long. */
const EARLY_CANCEL_TTL_MS = 30000;
/** Headers that must not follow a redirect to another origin (curl does the same). */
const CROSS_ORIGIN_SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
/** Headers describing a body that a 301/302/303 redirect drops. */
const BODY_HEADERS = new Set(["content-type", "content-length", "transfer-encoding", "content-encoding"]);

/**
 * One controller per in-flight request id so `cancel` can abort it at any
 * point: while connecting, while streaming the body, or between redirect hops.
 */
const activeRequests = new Map();
/** Request ids cancelled before `send` registered them (renderer races). */
const earlyCancels = new Map();

function rememberEarlyCancel(requestId) {
  const now = Date.now();
  for (const [id, at] of earlyCancels) {
    if (now - at > EARLY_CANCEL_TTL_MS) earlyCancels.delete(id);
  }
  earlyCancels.set(requestId, now);
}

function consumeEarlyCancel(requestId) {
  const at = earlyCancels.get(requestId);
  if (at === undefined) return false;
  earlyCancels.delete(requestId);
  return Date.now() - at <= EARLY_CANCEL_TTL_MS;
}

function cancelledError() {
  return Object.assign(new Error("Request cancelled"), { code: "ABORT_ERR" });
}

function clampTimeout(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 30000;
  return Math.min(120000, Math.max(1000, Math.round(numeric)));
}

function clampRedirects(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 10;
  return Math.min(20, Math.round(numeric));
}

function normalizeError(error, fallbackMessage) {
  const code = typeof error?.code === "string" ? error.code : "";
  const message = error?.message ? String(error.message) : fallbackMessage || "request failed";
  let normalized = "connection";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") normalized = "dns";
  else if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") normalized = "timeout";
  else if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    normalized = "tls";
  } else if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    normalized = "connection";
  } else if (code === "ABORT_ERR" || /aborted|cancelled|canceled/i.test(message)) {
    normalized = "cancelled";
  }
  if (code === "ERR_INVALID_URL") normalized = "invalid-url";
  return { code: normalized, message, ...(code ? { detail: code } : {}) };
}

/** Header values must not smuggle CRLF or bogus names into the request. */
function sanitizeHeaderList(input) {
  if (!Array.isArray(input)) return [];
  const result = [];
  for (const entry of input.slice(0, MAX_HEADER_COUNT)) {
    if (!entry || typeof entry !== "object") continue;
    const key = String(entry.key ?? "").trim();
    const rawValue = entry.value === undefined || entry.value === null ? "" : String(entry.value);
    if (!key) continue;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) continue;
    if (/[\r\n\0]/.test(rawValue)) continue;
    result.push({ key, value: rawValue });
  }
  return result;
}

function headersToNode(list) {
  const headers = {};
  for (const { key, value } of list) {
    const existingKey = Object.keys(headers).find((name) => name.toLowerCase() === key.toLowerCase());
    if (existingKey) headers[existingKey] = `${headers[existingKey]}, ${value}`;
    else headers[key] = value;
  }
  return headers;
}

function rawHeadersToList(rawHeaders) {
  const list = [];
  if (!Array.isArray(rawHeaders)) return list;
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    list.push({ key: String(rawHeaders[index]), value: String(rawHeaders[index + 1]) });
  }
  return list;
}

function headerValue(list, name) {
  const target = name.toLowerCase();
  const match = list.find((entry) => entry.key.toLowerCase() === target);
  return match ? match.value : undefined;
}

function decodeBody(buffer, encoding) {
  const normalized = String(encoding || "").toLowerCase().trim();
  try {
    if (normalized === "gzip" || normalized === "x-gzip") return zlib.gunzipSync(buffer);
    if (normalized === "deflate") return zlib.inflateSync(buffer);
    if (normalized === "br") return zlib.brotliDecompressSync(buffer);
    if (normalized === "zstd" && typeof zlib.zstdDecompressSync === "function") {
      return zlib.zstdDecompressSync(buffer);
    }
  } catch {
    return buffer;
  }
  return buffer;
}

function createDecoder(encoding) {
  const normalized = String(encoding || "").toLowerCase().trim();
  if (normalized === "gzip" || normalized === "x-gzip") {
    return zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
  if (normalized === "deflate") {
    // Some servers send raw deflate without the zlib wrapper; unzip detects both.
    return zlib.createUnzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
  if (normalized === "br") {
    return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
  }
  if (normalized === "zstd" && typeof zlib.createZstdDecompress === "function") {
    return zlib.createZstdDecompress();
  }
  return null;
}

/**
 * Streams `buffer` through the content decoder off the main thread pool and
 * stops at `limit` decoded bytes. A body truncated on the wire still decodes
 * as far as it goes. Falls back to the raw bytes when nothing decodes.
 */
function decodeBodyCapped(buffer, encoding, limit = MAX_DECODED_BODY_BYTES) {
  const decoder = buffer.length > 0 ? createDecoder(encoding) : null;
  if (!decoder) return Promise.resolve({ buffer, truncated: false, decoded: false });
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let truncated = false;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (!ok && total === 0) {
        resolve({ buffer, truncated: false, decoded: false });
        return;
      }
      // A decode error after some output means the tail is missing.
      resolve({ buffer: Buffer.concat(chunks, total), truncated: truncated || !ok, decoded: true });
    };
    decoder.on("data", (chunk) => {
      if (settled) return;
      const remaining = limit - total;
      if (chunk.length >= remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total += Math.max(0, remaining);
        truncated = true;
        finish(true);
        decoder.destroy();
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    decoder.on("end", () => finish(true));
    decoder.on("error", () => finish(false));
    decoder.on("close", () => finish(true));
    decoder.end(buffer);
  });
}

function classifyBody(contentType, buffer) {
  const type = String(contentType || "").toLowerCase();
  const looksBinary = buffer.includes(0);
  if (type.includes("json")) return "json";
  if (type.includes("html")) return "html";
  if (type.includes("xml")) return "xml";
  if (type.startsWith("text/") || type.includes("javascript") || type.includes("x-www-form-urlencoded")) {
    return looksBinary ? "binary" : "text";
  }
  if (!type) return looksBinary ? "binary" : "text";
  return "binary";
}

function shapeResponse({ status, statusText, httpVersion, headers, buffer, truncated, durationMs, redirects }) {
  const contentType = headerValue(headers, "content-type");
  const kind = classifyBody(contentType, buffer);
  const response = {
    status,
    statusText: statusText || "",
    headers,
    durationMs,
    sizeBytes: buffer.length,
    truncated,
    redirects,
    bodyKind: kind,
  };
  if (httpVersion) response.httpVersion = httpVersion;
  if (contentType) response.contentType = contentType;
  if (buffer.length > 0 && buffer.length <= MAX_BODY_BASE64_BYTES) {
    response.bodyBase64 = buffer.toString("base64");
  }
  if (kind !== "binary") response.bodyText = buffer.toString("utf8");
  if (buffer.length === 0) response.bodyKind = "empty";
  return response;
}

function hasHeader(headers, name) {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

/**
 * Headers for the next redirect hop: body headers go when the body is
 * dropped, credentials go when the redirect leaves the original origin
 * (same rule curl applies without --location-trusted).
 */
function headersForRedirect(headers, { dropsBody, crossOrigin }) {
  return headers.filter(({ key }) => {
    const lower = key.toLowerCase();
    if (dropsBody && BODY_HEADERS.has(lower)) return false;
    if (crossOrigin && (CROSS_ORIGIN_SENSITIVE_HEADERS.has(lower) || lower === "host")) return false;
    return true;
  });
}

function sendOnce(wire, redirectHistory, deadline, controller, startedAt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer = null;
    let request = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (controller.request === request) controller.request = null;
      fn(value);
    };
    const fail = (error) => settle(reject, error);
    const succeed = (value) => settle(resolve, value);

    if (controller.cancelled) {
      fail(cancelledError());
      return;
    }

    let target;
    try {
      target = new URL(wire.url);
    } catch (error) {
      fail(Object.assign(error, { code: "ERR_INVALID_URL" }));
      return;
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      fail(Object.assign(new Error(`Unsupported protocol: ${target.protocol}`), { code: "ERR_INVALID_URL" }));
      return;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      fail(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
      return;
    }

    const isHttps = target.protocol === "https:";
    const headers = headersToNode(wire.headers);
    if (!hasHeader(headers, "accept-encoding")) headers["Accept-Encoding"] = "gzip, deflate, br";
    const sendsBody = wire.method !== "GET" && wire.method !== "HEAD" && typeof wire.bodyText === "string";
    const body = sendsBody ? Buffer.from(wire.bodyText, "utf8") : null;
    // An explicit length (what curl sends) instead of chunked transfer
    // encoding, which a number of servers and proxies reject.
    if (body && !hasHeader(headers, "content-length") && !hasHeader(headers, "transfer-encoding")) {
      headers["Content-Length"] = String(body.length);
    }

    const options = {
      protocol: target.protocol,
      hostname: target.hostname.replace(/^\[|\]$/g, ""),
      port: target.port ? Number(target.port) : isHttps ? 443 : 80,
      path: `${target.pathname}${target.search}`,
      method: wire.method,
      headers,
    };
    if (isHttps && wire.verifyTls === false) options.rejectUnauthorized = false;

    try {
      request = (isHttps ? https : http).request(options, (response) => {
        const headerList = rawHeadersToList(response.rawHeaders);
        const status = response.statusCode || 0;
        // Late socket errors must never reach an unhandled 'error' event.
        response.on("error", fail);

        if (REDIRECT_STATUSES.has(status) && wire.followRedirects !== false) {
          const location = headerValue(headerList, "location");
          if (location) {
            succeed({ redirect: { status, location, headers: headerList, httpVersion: response.httpVersion } });
            response.resume();
            return;
          }
        }

        const chunks = [];
        let total = 0;
        let truncated = false;
        let finished = false;
        const finishBody = () => {
          if (finished) return;
          finished = true;
          // The bytes are in; decoding must not race the network deadline.
          if (hardTimer) {
            clearTimeout(hardTimer);
            hardTimer = null;
          }
          const raw = Buffer.concat(chunks, total);
          decodeBodyCapped(raw, headerValue(headerList, "content-encoding"))
            .then((decoded) => {
              succeed({
                response: shapeResponse({
                  status,
                  statusText: response.statusMessage,
                  httpVersion: response.httpVersion,
                  headers: headerList,
                  buffer: decoded.buffer,
                  truncated: truncated || decoded.truncated,
                  durationMs: Date.now() - startedAt,
                  redirects: redirectHistory,
                }),
              });
            })
            .catch(fail);
        };
        response.on("data", (chunk) => {
          if (finished) return;
          const remaining = MAX_BODY_BYTES - total;
          if (chunk.length >= remaining) {
            if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
            total = MAX_BODY_BYTES;
            truncated = true;
            finishBody();
            // Stop downloading: the rest would only be thrown away.
            response.destroy();
            request.destroy();
            return;
          }
          chunks.push(chunk);
          total += chunk.length;
        });
        response.on("end", finishBody);
        response.on("close", () => {
          if (!finished) {
            fail(Object.assign(new Error("Connection closed before the response finished"), { code: "ECONNRESET" }));
          }
        });
      });
    } catch (error) {
      fail(error);
      return;
    }

    hardTimer = setTimeout(() => {
      request.destroy(Object.assign(new Error("Request timed out"), { code: "ETIMEDOUT" }));
    }, remainingMs);
    request.on("error", fail);
    controller.request = request;
    if (body) request.end(body);
    else request.end();
  });
}

async function send({ wire }) {
  if (!wire || typeof wire !== "object" || typeof wire.url !== "string") {
    return { ok: false, error: { code: "invalid-request", message: "Missing request URL" } };
  }
  const requestId = typeof wire.id === "string" && wire.id ? wire.id : `http-${Date.now()}`;
  const payload = { ...wire, id: requestId, headers: sanitizeHeaderList(wire.headers) };
  const started = Date.now();
  const deadline = started + clampTimeout(wire.timeoutMs);
  const redirects = [];
  const maxRedirects = clampRedirects(wire.maxRedirects);
  const controller = { id: requestId, cancelled: consumeEarlyCancel(requestId), request: null };
  activeRequests.set(requestId, controller);
  let current = { ...payload };

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      if (controller.cancelled) throw cancelledError();
      const outcome = await sendOnce(current, redirects.slice(), deadline, controller, started);
      if (!outcome.redirect) {
        return { ok: true, response: outcome.response };
      }
      const { status, location } = outcome.redirect;
      redirects.push({ status: status, location: location });
      if (redirects.length > maxRedirects) {
        return {
          ok: false,
          error: {
            code: "too-many-redirects",
            message: `Exceeded ${maxRedirects} redirects`,
            detail: location,
          },
        };
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, current.url).toString();
      } catch (error) {
        return { ok: false, error: normalizeError(error, "Invalid redirect location") };
      }
      const dropsBody = status === 303 || ((status === 301 || status === 302) && current.method === "POST");
      const crossOrigin = originOf(nextUrl) !== originOf(current.url);
      current = {
        ...current,
        url: nextUrl,
        method: dropsBody && current.method !== "HEAD" ? "GET" : current.method,
        headers: headersForRedirect(current.headers, { dropsBody, crossOrigin }),
        ...(dropsBody ? { bodyText: undefined } : {}),
      };
    }
    return {
      ok: false,
      error: { code: "too-many-redirects", message: `Exceeded ${maxRedirects} redirects` },
    };
  } catch (error) {
    if (controller.cancelled) {
      return { ok: false, error: { code: "cancelled", message: "Request cancelled" } };
    }
    return { ok: false, error: normalizeError(error) };
  } finally {
    if (activeRequests.get(requestId) === controller) activeRequests.delete(requestId);
  }
}

function cancel({ requestId }) {
  if (typeof requestId !== "string" || !requestId) return { ok: true, cancelled: false };
  const controller = activeRequests.get(requestId);
  if (!controller) {
    // The renderer can cancel before the send IPC reached us.
    rememberEarlyCancel(requestId);
    return { ok: true, cancelled: false };
  }
  controller.cancelled = true;
  try {
    controller.request?.destroy(cancelledError());
  } catch {
    // ignore
  }
  return { ok: true, cancelled: true };
}

const handlers = { send, cancel };

function registerHttpHandlers(ipcMain) {
  ipcMain.handle("netcatty:http:request", (_event, payload) => handlers.send(payload || {}));
  ipcMain.handle("netcatty:http:cancel", (_event, payload) => handlers.cancel(payload || {}));
}

module.exports = {
  registerHttpHandlers,
  handlers,
  MAX_BODY_BYTES,
  MAX_BODY_BASE64_BYTES,
  __test: {
    clampTimeout,
    clampRedirects,
    normalizeError,
    sanitizeHeaderList,
    headersToNode,
    rawHeadersToList,
    decodeBody,
    decodeBodyCapped,
    classifyBody,
    headersForRedirect,
    activeRequests,
    earlyCancels,
  },
};
