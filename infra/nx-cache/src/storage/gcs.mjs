// Google Cloud Storage backend over the plain JSON API (no SDK dependency).
//
// Immutability: every upload carries `ifGenerationMatch=0`, GCS's documented
// "create only if no live object exists" precondition. GCS evaluates it
// atomically when the upload commits, so of N concurrent uploads of one key
// exactly one returns 200 and the others 412 — which this backend reports as
// "exists" (HTTP 409 to Nx). There is no exists-then-upload race to lose.
// The service identity should additionally hold only
// roles/storage.objectCreator + objectViewer on the bucket: overwriting an
// object needs storage.objects.delete, which that pair does not grant, so
// even a bug here could not replace a committed artifact.
//
// Streaming: the data path uses node:http(s) + stream.pipeline, NOT fetch().
// undici's fetch() was measured buffering an entire 256 MiB request/response
// body in memory (no backpressure through its web-stream bridge); with
// node:https the process stays at a few MiB regardless of artifact size.
//
// Partial writes: a simple (uploadType=media) upload is all-or-nothing — the
// object only becomes visible once GCS has the full body. The body is also
// piped through lengthGuard(), and Content-Length is sent explicitly, so a
// short client body aborts the request instead of committing fewer bytes.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { lengthGuard } from "../length-guard.mjs";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export class StorageError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

/**
 * Access-token provider. Order: a static token (local integration tests:
 * `gcloud auth print-access-token`), then the GCE/Cloud Run metadata server.
 * Tokens are cached until a minute before expiry.
 */
export function gcsTokenProvider({ staticToken, fetchImpl = fetch } = {}) {
  if (staticToken) return async () => staticToken;
  let cached = null;
  let expiresAt = 0;
  return async () => {
    if (cached && Date.now() < expiresAt) return cached;
    const res = await fetchImpl(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (!res.ok)
      throw new StorageError(
        `metadata token request failed: ${res.status}`,
        res.status,
      );
    const body = await res.json();
    cached = body.access_token;
    expiresAt = Date.now() + Math.max(0, (body.expires_in - 60) * 1000);
    return cached;
  };
}

/**
 * One HTTP(S) exchange. `body`: undefined | Readable (streamed with
 * backpressure). Resolves with the IncomingMessage once headers arrive;
 * the caller consumes or discards it.
 */
function send(
  url,
  { method = "GET", headers = {}, body, timeoutMs = 15 * 60_000 } = {},
) {
  const u = new URL(url);
  const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
    method,
    headers,
    timeout: timeoutMs,
  });
  return new Promise((resolve, reject) => {
    req.once("response", resolve);
    req.once("error", reject);
    req.once("timeout", () =>
      req.destroy(new StorageError("GCS request timed out", 504)),
    );
    if (body) {
      pipeline(body, req).catch((err) => {
        req.destroy(err);
        reject(err);
      });
    } else {
      req.end();
    }
  });
}

const drain = (res) => {
  res.resume();
};

/**
 * @param {{ bucket: string, prefix?: string, endpoint?: string,
 *           getToken?: () => Promise<string|null> }} opts
 * `endpoint` defaults to https://storage.googleapis.com; point it at a GCS
 * emulator (e.g. fake-gcs-server) for integration tests.
 */
export function gcsStorage({
  bucket,
  prefix = "nx/v1/",
  endpoint = "https://storage.googleapis.com",
  getToken = gcsTokenProvider(),
}) {
  if (!bucket) throw new Error("gcsStorage: bucket is required");
  const base = endpoint.replace(/\/+$/, "");
  const objectName = (key) => `${prefix}${key}`;
  const objectUrl = (key) =>
    `${base}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName(key))}`;
  const authHeaders = async () => {
    const token = await getToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  };
  return {
    kind: "gcs",
    async exists(key) {
      const res = await send(`${objectUrl(key)}?fields=generation`, {
        headers: await authHeaders(),
      });
      drain(res);
      if (res.statusCode === 404) return false;
      if (res.statusCode === 200) return true;
      throw new StorageError(
        `GCS metadata lookup failed: ${res.statusCode}`,
        res.statusCode,
      );
    },
    async get(key) {
      const res = await send(`${objectUrl(key)}?alt=media`, {
        headers: await authHeaders(),
      });
      if (res.statusCode === 404) {
        drain(res);
        return null;
      }
      if (res.statusCode !== 200) {
        drain(res);
        throw new StorageError(
          `GCS download failed: ${res.statusCode}`,
          res.statusCode,
        );
      }
      const len = res.headers["content-length"];
      return { stream: res, length: len === undefined ? null : Number(len) };
    },
    async put(key, body, length) {
      const url =
        `${base}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
        `?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(objectName(key))}`;
      const guarded = lengthGuard(length);
      // A client that aborts mid-upload must abort the GCS request too, not
      // leave it waiting on a body that will never finish.
      const abort = () => guarded.destroy(new Error("client aborted upload"));
      body.once("aborted", abort);
      body.once("error", (err) => guarded.destroy(err));
      body.pipe(guarded);
      let res;
      try {
        res = await send(url, {
          method: "POST",
          headers: {
            ...(await authHeaders()),
            "content-type": "application/octet-stream",
            "content-length": String(length),
          },
          body: guarded,
        });
      } finally {
        body.off("aborted", abort);
      }
      drain(res);
      if (res.statusCode === 200 || res.statusCode === 201) return "created";
      if (res.statusCode === 412) return "exists";
      throw new StorageError(
        `GCS upload failed: ${res.statusCode}`,
        res.statusCode,
      );
    },
  };
}
