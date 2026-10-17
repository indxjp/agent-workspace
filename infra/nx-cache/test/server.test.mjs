// Contract tests for the Nx self-hosted cache API, run against every storage
// backend. Numbers in test names map to the acceptance list in
// infra/nx-cache/README.md ("Test matrix").
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  request as httpRequest,
} from "node:http";
import { connect } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { after, before, describe, test } from "node:test";
import { fsStorage } from "../src/storage/fs.mjs";
import { gcsStorage } from "../src/storage/gcs.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";
import {
  chunks,
  get,
  put,
  READ,
  sha256,
  startCache,
  startFakeGcs,
  WRITE,
} from "./helpers.mjs";

const backends = {
  memory: async () => ({ storage: memoryStorage(), cleanup: async () => {} }),
  fs: async () => {
    const root = await mkdtemp(join(tmpdir(), "nx-cache-test-"));
    return {
      storage: fsStorage({ root }),
      root,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  },
  "gcs (emulated)": async () => {
    const gcs = await startFakeGcs();
    return {
      storage: gcsStorage({
        bucket: "b",
        endpoint: gcs.endpoint,
        getToken: async () => "fake",
      }),
      gcs,
      cleanup: gcs.close,
    };
  },
};

let n = 0;
const freshHash = () => `${Date.now()}${n++}`;

for (const [name, make] of Object.entries(backends)) {
  describe(`nx cache contract — ${name}`, () => {
    let backend;
    let cache;
    before(async () => {
      backend = await make();
      cache = await startCache({ storage: backend.storage });
    });
    after(async () => {
      await cache.close();
      await backend.cleanup();
    });

    test("1. no Authorization header → 401 (GET and PUT)", async () => {
      assert.equal((await get(cache.url, freshHash(), null)).status, 401);
      assert.equal(
        (await put(cache.url, freshHash(), Buffer.from("x"), null)).status,
        401,
      );
    });

    test("2. invalid token → 401", async () => {
      assert.equal(
        (await get(cache.url, freshHash(), "nope".repeat(10))).status,
        401,
      );
      assert.equal(
        (await put(cache.url, freshHash(), Buffer.from("x"), "nope".repeat(10)))
          .status,
        401,
      );
      const res = await fetch(`${cache.url}/v1/cache/${freshHash()}`, {
        headers: { authorization: `Basic ${READ}` },
      });
      assert.equal(res.status, 401);
    });

    test("3+6. read and write tokens can both GET", async () => {
      const h = freshHash();
      assert.equal(
        (await put(cache.url, h, Buffer.from("payload"))).status,
        200,
      );
      assert.equal((await get(cache.url, h, READ)).status, 200);
      assert.equal((await get(cache.url, h, WRITE)).status, 200);
    });

    test("4. read token PUT → 403 and nothing is stored", async () => {
      const h = freshHash();
      const res = await put(cache.url, h, Buffer.from("poison"), READ);
      assert.equal(res.status, 403);
      assert.equal((await get(cache.url, h)).status, 404);
    });

    test("5. write token PUT of a new key → 200", async () => {
      assert.equal(
        (await put(cache.url, freshHash(), Buffer.from("new"))).status,
        200,
      );
    });

    test("7. missing object → 404", async () => {
      assert.equal((await get(cache.url, freshHash())).status, 404);
    });

    test("8. duplicate PUT → 409 and the first body is kept", async () => {
      const h = freshHash();
      assert.equal((await put(cache.url, h, Buffer.from("first"))).status, 200);
      assert.equal(
        (await put(cache.url, h, Buffer.from("second"))).status,
        409,
      );
      assert.equal(await (await get(cache.url, h)).text(), "first");
    });

    test("9. concurrent PUTs of one key → exactly one 200, the rest 409, winner's bytes stored", async () => {
      const h = freshHash();
      const bodies = Array.from({ length: 12 }, (_, i) =>
        Buffer.from(`writer-${i}-`.repeat(5000)),
      );
      const statuses = await Promise.all(
        bodies.map((b) => put(cache.url, h, b).then((r) => r.status)),
      );
      assert.equal(
        statuses.filter((s) => s === 200).length,
        1,
        `statuses: ${statuses}`,
      );
      assert.equal(statuses.filter((s) => s === 409).length, bodies.length - 1);
      const stored = Buffer.from(await (await get(cache.url, h)).arrayBuffer());
      assert.equal(stored.equals(bodies[statuses.indexOf(200)]), true);
    });

    test("10. binary round-trip is byte-exact (SHA-256)", async () => {
      const h = freshHash();
      const body = Buffer.concat([...chunks(3 * 1024 * 1024 + 7, 65536, 42)]);
      body[0] = 0;
      body[1] = 0xff;
      assert.equal((await put(cache.url, h, body)).status, 200);
      const res = await get(cache.url, h);
      assert.equal(res.headers.get("content-type"), "application/octet-stream");
      assert.equal(Number(res.headers.get("content-length")), body.length);
      assert.equal(sha256(Buffer.from(await res.arrayBuffer())), sha256(body));
    });

    test("12. malformed / unsafe hashes → 400 or 404, never touch storage", async () => {
      for (const bad of [
        "..%2F..%2Fetc",
        "a.b",
        "%2e%2e",
        "-leading",
        "x".repeat(200),
        "a%00b",
      ]) {
        const res = await get(cache.url, bad, READ);
        assert.ok([400, 404].includes(res.status), `${bad} → ${res.status}`);
        const w = await put(cache.url, bad, Buffer.from("x"));
        assert.ok([400, 404].includes(w.status), `${bad} → ${w.status}`);
      }
      const nested = await get(cache.url, "a/b", READ);
      assert.equal(nested.status, 404);
    });

    test("PUT without a usable Content-Length → 411", async () => {
      const res = await put(
        cache.url,
        freshHash(),
        Readable.from([Buffer.from("abc")]),
      );
      // fetch() sends chunked encoding for a stream body (no Content-Length).
      assert.equal(res.status, 411);
    });

    test("14. token values never appear in logs", async () => {
      await get(cache.url, freshHash(), READ);
      await put(cache.url, freshHash(), Buffer.from("x"), WRITE);
      await put(cache.url, freshHash(), Buffer.from("x"), READ);
      await get(cache.url, freshHash(), "leaky-invalid-token-value-0123456789");
      const all = cache.logs.join("\n");
      assert.ok(cache.logs.length > 0);
      for (const secret of [
        READ,
        WRITE,
        "leaky-invalid-token-value-0123456789",
        "Bearer",
      ]) {
        assert.equal(
          all.includes(secret),
          false,
          `log leaked ${secret.slice(0, 6)}…`,
        );
      }
    });
  });
}

describe("size limits and streaming", () => {
  test("413 above the configured maximum", async () => {
    const cache = await startCache({
      storage: memoryStorage(),
      maxBytes: 1024,
    });
    try {
      assert.equal(
        (await put(cache.url, "big1", Buffer.alloc(2048))).status,
        413,
      );
      assert.equal(
        (await put(cache.url, "ok1", Buffer.alloc(1024))).status,
        200,
      );
    } finally {
      await cache.close();
    }
  });

  // 11. Retained (post-GC) external memory is sampled while 256 MiB moves
  // each way. node:http is the client on purpose: undici fetch() buffers
  // whole bodies itself and would mask what the SERVER does. A buffering
  // server would retain >= 256 MiB; the streaming one stays at a few MiB.
  for (const kind of ["fs", "gcs (streaming upstream)"]) {
    test(`11. a 256 MiB object streams through without buffering — ${kind}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "nx-cache-big-"));
      const upstream = kind === "fs" ? null : await startStreamingFakeGcs();
      const storage =
        kind === "fs"
          ? fsStorage({ root })
          : gcsStorage({
              bucket: "b",
              endpoint: upstream.endpoint,
              getToken: async () => "fake",
            });
      const cache = await startCache({ storage });
      const size = 256 * 1024 * 1024;
      const gc = global.gc ?? (() => {});
      const base = process.memoryUsage().arrayBuffers;
      let peak = 0;
      const timer = setInterval(() => {
        gc();
        peak = Math.max(peak, process.memoryUsage().arrayBuffers - base);
      }, 25);
      try {
        const up = createHash("sha256");
        const status = await rawPut(
          cache.url,
          "huge1",
          size,
          (function* () {
            for (const c of aesChunks(size)) {
              up.update(c);
              yield c;
            }
          })(),
        );
        const uploadedSha = up.digest("hex");
        if (upstream)
          assert.equal(
            upstream.uploadedSha(),
            uploadedSha,
            "upstream received different bytes",
          );
        assert.equal(status, 200);
        const upPeak = peak;
        peak = 0;
        const down = await rawGetSha(cache.url, "huge1");
        assert.equal(down.bytes, size);
        assert.equal(down.sha, uploadedSha);
        const mib = (n) => (n / 1048576).toFixed(0);
        if (global.gc) {
          assert.ok(
            upPeak < 64 * 1048576,
            `upload retained ${mib(upPeak)} MiB`,
          );
          assert.ok(peak < 64 * 1048576, `download retained ${mib(peak)} MiB`);
        }
      } finally {
        clearInterval(timer);
        await cache.close();
        await upstream?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

function rawPut(url, hash, size, iterable) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${url}/v1/cache/${hash}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${WRITE}`, "content-length": size },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
    pipeline(Readable.from(iterable), req).catch(reject);
  });
}

function rawGetSha(url, hash) {
  return new Promise((resolve, reject) => {
    httpRequest(
      `${url}/v1/cache/${hash}`,
      { headers: { authorization: `Bearer ${READ}` } },
      (res) => {
        const h = createHash("sha256");
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
          h.update(c);
        });
        res.on("end", () => resolve({ bytes, sha: h.digest("hex") }));
        res.on("error", reject);
      },
    )
      .on("error", reject)
      .end();
  });
}

/**
 * GCS stand-in that never holds an object in memory: uploads are hashed and
 * discarded, downloads replay deterministic bytes with the same hash — so
 * the only thing that could retain the artifact is the cache server itself.
 */
async function startStreamingFakeGcs() {
  let stored = null;
  let uploaded = null;
  const server = createHttpServer(async (req, res) => {
    if (req.method === "GET" && req.url.includes("fields=generation")) {
      res.writeHead(stored ? 200 : 404).end("{}");
      return;
    }
    if (req.method === "POST") {
      const h = createHash("sha256");
      let n = 0;
      for await (const c of req) {
        h.update(c);
        n += c.length;
      }
      uploaded = h.digest("hex");
      stored = { size: n };
      res.writeHead(200).end("{}");
      return;
    }
    if (req.method === "GET" && stored) {
      res.writeHead(200, { "content-length": stored.size });
      await pipeline(Readable.from(aesChunks(stored.size)), res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    uploadedSha: () => uploaded,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Deterministic, fast, incompressible bytes: AES-256-CTR keystream. */
function* aesChunks(size) {
  const cipher = createCipheriv(
    "aes-256-ctr",
    Buffer.alloc(32, 7),
    Buffer.alloc(16, 0),
  );
  const zero = Buffer.alloc(1 << 20);
  for (let left = size; left > 0; left -= zero.length) {
    yield cipher.update(left >= zero.length ? zero : zero.subarray(0, left));
  }
}

describe("13. storage failures", () => {
  test("a backend error mid-upload → 500, no record, nothing leaks", async () => {
    const gcs = await startFakeGcs({ failUploads: true });
    const cache = await startCache({
      storage: gcsStorage({
        bucket: "b",
        endpoint: gcs.endpoint,
        getToken: async () => "fake",
      }),
    });
    try {
      const res = await put(cache.url, "fail1", Buffer.alloc(4096, 1));
      assert.equal(res.status, 500);
      assert.equal(await res.text(), "internal error");
      assert.equal(gcs.objects.size, 0);
      assert.equal((await get(cache.url, "fail1")).status, 404);
    } finally {
      await cache.close();
      await gcs.close();
    }
  });

  test("storage throwing on get → 500 without leaking internals", async () => {
    const storage = {
      kind: "broken",
      exists: async () => false,
      get: async () => {
        throw new Error("secret-internal-detail");
      },
      put: async () => "created",
    };
    const cache = await startCache({ storage });
    try {
      const res = await get(cache.url, "x1");
      assert.equal(res.status, 500);
      assert.equal(
        (await res.text()).includes("secret-internal-detail"),
        false,
      );
    } finally {
      await cache.close();
    }
  });

  test("a client that disconnects mid-upload leaves no partial record (fs)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nx-cache-abort-"));
    const cache = await startCache({ storage: fsStorage({ root }) });
    try {
      const ac = new AbortController();
      const body = Readable.from(
        (async function* () {
          yield Buffer.alloc(1 << 20, 1);
          await new Promise((r) => setTimeout(r, 50));
          ac.abort();
          yield Buffer.alloc(1 << 20, 1);
        })(),
      );
      await fetch(`${cache.url}/v1/cache/abort1`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${WRITE}`,
          "content-length": String(8 << 20),
        },
        body,
        duplex: "half",
        signal: ac.signal,
      }).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      assert.equal((await get(cache.url, "abort1")).status, 404);
      assert.deepEqual(await readdir(join(root, "objects", ".tmp")), []);
    } finally {
      await cache.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("operational endpoints", () => {
  test("health endpoint is unauthenticated", async () => {
    const cache = await startCache({ storage: memoryStorage() });
    try {
      const res = await fetch(`${cache.url}/v1/health`);
      assert.equal(res.status, 200);
      assert.equal(
        (
          await fetch(`${cache.url}/v1/cache/abc`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${WRITE}` },
          })
        ).status,
        405,
      );
    } finally {
      await cache.close();
    }
  });

  test("h2c mode serves the same contract over cleartext HTTP/2 (Cloud Run --use-http2)", async () => {
    const cache = await startCache({ storage: memoryStorage(), http2: true });
    const client = connect(cache.url);
    const request = (headers, body) =>
      new Promise((resolve, reject) => {
        const req = client.request(headers);
        const parts = [];
        let status;
        req.on("response", (h) => {
          status = h[":status"];
        });
        req.on("data", (c) => parts.push(c));
        req.on("end", () => resolve({ status, body: Buffer.concat(parts) }));
        req.on("error", reject);
        req.end(body);
      });
    try {
      const payload = Buffer.concat([...chunks(40 * 1024 * 1024, 1 << 20, 5)]); // > 32 MiB
      const up = await request(
        {
          ":method": "PUT",
          ":path": "/v1/cache/h2big",
          authorization: `Bearer ${WRITE}`,
          "content-length": payload.length,
        },
        payload,
      );
      assert.equal(up.status, 200);
      const down = await request({
        ":method": "GET",
        ":path": "/v1/cache/h2big",
        authorization: `Bearer ${READ}`,
      });
      assert.equal(down.status, 200);
      assert.equal(sha256(down.body), sha256(payload));
      const forbidden = await request(
        {
          ":method": "PUT",
          ":path": "/v1/cache/h2ro",
          authorization: `Bearer ${READ}`,
          "content-length": 1,
        },
        Buffer.from("x"),
      );
      assert.equal(forbidden.status, 403);
    } finally {
      client.close();
      await cache.close();
    }
  });
});
