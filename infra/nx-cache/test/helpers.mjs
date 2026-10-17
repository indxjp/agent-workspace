import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createAuth } from "../src/auth.mjs";
import { createCacheHandler, createCacheServer } from "../src/server.mjs";

export const READ = "r".repeat(40);
export const WRITE = "w".repeat(40);
export const SIGNING_KEY = "s".repeat(48);

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Start a cache server on an ephemeral port. Returns { url, logs, close }. */
export async function startCache({
  storage,
  http2 = false,
  maxBytes,
  oidc,
  auth,
} = {}) {
  const logs = [];
  const log = {
    info: (message, fields) =>
      logs.push(JSON.stringify({ severity: "INFO", message, ...fields })),
    warn: (message, fields) =>
      logs.push(JSON.stringify({ severity: "WARNING", message, ...fields })),
    error: (message, fields) =>
      logs.push(JSON.stringify({ severity: "ERROR", message, ...fields })),
  };
  const handler = createCacheHandler({
    storage,
    auth:
      auth ??
      createAuth({
        readTokens: [READ],
        writeTokens: [WRITE],
        signingKey: SIGNING_KEY,
      }),
    log,
    maxBytes,
    oidc,
  });
  const server = createCacheServer(handler, { http2 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    logs,
    server,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export const put = (url, hash, body, token = WRITE, extra = {}) =>
  fetch(`${url}/v1/cache/${hash}`, {
    method: "PUT",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/octet-stream",
      ...extra.headers,
    },
    body,
    duplex: "half",
  });

export const get = (url, hash, token = READ) =>
  fetch(`${url}/v1/cache/${hash}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

/** Deterministic pseudo-random bytes (seeded), generated chunk by chunk. */
export function* chunks(totalBytes, chunkSize = 1 << 20, seed = 1) {
  let x = seed >>> 0 || 1;
  let left = totalBytes;
  while (left > 0) {
    const n = Math.min(chunkSize, left);
    const buf = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i += 4) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      buf.writeUInt32LE(x >>> 0, i <= n - 4 ? i : n - 4);
    }
    left -= n;
    yield buf;
  }
}

/**
 * Minimal in-process GCS JSON-API emulator: the three calls gcs.mjs makes
 * (metadata GET, media GET, media upload POST) with real `ifGenerationMatch=0`
 * semantics — the precondition is evaluated when the upload COMMITS (after
 * the whole body arrived), exactly like GCS, so concurrent uploads race the
 * same way they would against the real service.
 */
export async function startFakeGcs({ failUploads = false } = {}) {
  const objects = new Map(); // name -> Buffer
  let generation = 1;
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    calls.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    });
    const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
    const object = /^\/storage\/v1\/b\/([^/]+)\/o\/(.+)$/.exec(url.pathname);
    if (req.method === "POST" && upload) {
      const name = url.searchParams.get("name");
      const parts = [];
      try {
        for await (const c of req) parts.push(c);
      } catch {
        return; // client aborted: nothing committed
      }
      const body = Buffer.concat(parts);
      if (
        req.headers["content-length"] &&
        Number(req.headers["content-length"]) !== body.length
      ) {
        res.writeHead(400).end("length mismatch");
        return;
      }
      if (failUploads) {
        res.writeHead(503).end("backend unavailable");
        return;
      }
      if (
        url.searchParams.get("ifGenerationMatch") === "0" &&
        objects.has(name)
      ) {
        res.writeHead(412).end(JSON.stringify({ error: { code: 412 } }));
        return;
      }
      objects.set(name, body);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ name, generation: generation++ }));
      return;
    }
    if (req.method === "GET" && object) {
      const name = decodeURIComponent(object[2]);
      const buf = objects.get(name);
      if (!buf) {
        res.writeHead(404).end("not found");
        return;
      }
      if (url.searchParams.get("alt") === "media") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": buf.length,
        });
        res.end(buf);
      } else {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ generation: 1 }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    objects,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
