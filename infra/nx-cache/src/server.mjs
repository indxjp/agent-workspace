// Nx self-hosted remote cache — HTTP surface.
//
// Implements exactly the Nx self-hosted cache OpenAPI contract
// (https://nx.dev/docs/kb/self-hosted-caching):
//   GET /v1/cache/{hash}  → 200 octet-stream | 401 | 403 | 404
//   PUT /v1/cache/{hash}  → 200 | 401 | 403 (read-only token) | 409 (exists)
// plus two operational endpoints that Nx never calls:
//   GET  /v1/health         → 200 (unauthenticated liveness)
//   POST /v1/token        → exchange a GitHub Actions OIDC JWT for a
//                           short-lived cache token (oidc.mjs explains why)
//
// Bodies stream end to end (client → storage, storage → client); nothing
// buffers a whole artifact in this process except the memory test backend.
import { createServer as createHttp1Server } from "node:http";
import { createServer as createH2cServer } from "node:http2";
import { pipeline } from "node:stream/promises";
import { bearer } from "./auth.mjs";
import { LengthMismatchError } from "./length-guard.mjs";
import { OidcError, roleForClaims, verifyGithubJwt } from "./oidc.mjs";

// Nx task hashes are decimal/alphanumeric digests. Anything outside this
// alphabet (dots, slashes, percent-escapes, …) is rejected before it can
// become part of a storage key / filesystem path.
export const HASH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const DEFAULT_MAX_BYTES = 2 * 1024 ** 3; // 2 GiB

function send(res, status, body = "", headers = {}) {
  if (res.headersSent) return;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type":
      typeof body === "string"
        ? "text/plain; charset=utf-8"
        : "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * @param {{ storage: any, auth: ReturnType<import('./auth.mjs').createAuth>,
 *           log: ReturnType<import('./log.mjs').createLogger>,
 *           maxBytes?: number,
 *           oidc?: { audience: string, getKey: Function, policy: object, ttlSeconds: number, now?: () => number } }} deps
 */
export function createCacheHandler({
  storage,
  auth,
  log,
  maxBytes = DEFAULT_MAX_BYTES,
  oidc,
}) {
  async function handleToken(req, res, entry) {
    if (!oidc || !auth.canMint) return send(res, 404, "not found");
    const jwt = bearer(req.headers.authorization);
    if (!jwt) return send(res, 401, "missing bearer token");
    let claims;
    try {
      claims = await verifyGithubJwt(jwt, {
        audience: oidc.audience,
        getKey: oidc.getKey,
        now: oidc.now,
      });
    } catch (err) {
      if (err instanceof OidcError) {
        entry.reason = err.message;
        return send(res, 401, "invalid OIDC token");
      }
      throw err;
    }
    const role = roleForClaims(claims, oidc.policy);
    Object.assign(entry, {
      repository: claims.repository,
      ref: claims.ref,
      event: claims.event_name,
      run: claims.run_id,
      role,
    });
    if (!role) return send(res, 403, "OIDC subject not allowed");
    const sub = `${claims.repository}@${claims.ref}#${claims.run_id}`;
    const { token, exp } = auth.mint({
      role,
      sub,
      ttlSeconds: oidc.ttlSeconds,
    });
    return send(res, 200, {
      token,
      role,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  }

  async function handleGet(res, hash, entry) {
    const obj = await storage.get(hash);
    if (!obj) return send(res, 404, "not found");
    const headers = { "content-type": "application/octet-stream" };
    if (obj.length !== null && obj.length !== undefined)
      headers["content-length"] = obj.length;
    res.writeHead(200, headers);
    entry.bytes = obj.length;
    await pipeline(obj.stream, res);
  }

  async function handlePut(req, res, hash, entry) {
    const raw = req.headers["content-length"];
    if (raw === undefined || !/^\d+$/.test(raw))
      return send(res, 411, "Content-Length required");
    const length = Number(raw);
    entry.bytes = length;
    if (length > maxBytes)
      return send(res, 413, "artifact too large", { connection: "close" });
    // Fast path only — saves uploading bytes that would be refused anyway.
    // Correctness does NOT depend on it: storage.put() is the atomic
    // create-if-absent and is what actually decides 200 vs 409.
    if (await storage.exists(hash))
      return send(res, 409, "cannot override an existing record");
    const outcome = await storage.put(hash, req, length);
    if (outcome === "exists")
      return send(res, 409, "cannot override an existing record");
    return send(res, 200, "");
  }

  return async function handler(req, res) {
    const started = process.hrtime.bigint();
    const entry = { method: req.method, route: "other" };
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/v1/health") {
        entry.route = "health";
        return req.method === "GET" || req.method === "HEAD"
          ? send(res, 200, "ok")
          : send(res, 405, "method not allowed");
      }
      if (path === "/v1/token") {
        entry.route = "token";
        return req.method === "POST"
          ? await handleToken(req, res, entry)
          : send(res, 405, "method not allowed");
      }
      const m = /^\/v1\/cache\/([^/]*)$/.exec(path);
      if (!m) return send(res, 404, "not found");
      entry.route = "cache";
      const hash = m[1];
      if (!HASH_RE.test(hash)) return send(res, 400, "invalid hash");
      entry.hash = hash;
      if (req.method !== "GET" && req.method !== "PUT")
        return send(res, 405, "method not allowed");
      const who = auth.authenticate(req.headers.authorization);
      if (!who) return send(res, 401, "unauthorized");
      entry.role = who.role;
      entry.principal = who.principal;
      if (req.method === "GET") return await handleGet(res, hash, entry);
      if (who.role !== "write")
        return send(res, 403, "read-only token cannot write");
      return await handlePut(req, res, hash, entry);
    } catch (err) {
      entry.error =
        err instanceof LengthMismatchError
          ? err.message
          : `${err.name}: ${err.message}`;
      if (err instanceof LengthMismatchError) {
        send(res, 400, "body did not match Content-Length", {
          connection: "close",
        });
      } else if (!res.headersSent) {
        send(res, 500, "internal error");
      } else {
        res.destroy(err);
      }
    } finally {
      entry.durationMs = Number(
        (process.hrtime.bigint() - started) / 1_000_000n,
      );
      entry.status = res.statusCode;
      const level = entry.status >= 500 ? "error" : "info";
      log[level]("request", entry);
    }
  };
}

/**
 * @param {ReturnType<typeof createCacheHandler>} handler
 * @param {{ http2?: boolean, requestTimeoutMs?: number }} opts
 * http2=true serves cleartext HTTP/2 (h2c, prior knowledge) — what Cloud Run
 * sends with `--use-http2`, and the only way past its 32 MiB HTTP/1
 * request-size limit. http2=false serves HTTP/1.1 (local, VM behind a proxy).
 */
export function createCacheServer(
  handler,
  { http2 = false, requestTimeoutMs = 15 * 60_000 } = {},
) {
  if (http2) {
    const server = createH2cServer({}, handler);
    server.setTimeout(requestTimeoutMs);
    return server;
  }
  const server = createHttp1Server(
    { requestTimeout: requestTimeoutMs, headersTimeout: 60_000 },
    handler,
  );
  server.keepAliveTimeout = 65_000;
  return server;
}
