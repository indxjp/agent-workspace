// Integration test against REAL Google Cloud Storage. Skipped unless
//   NX_CACHE_IT_GCS_BUCKET=<bucket>  NX_CACHE_IT_GCS_TOKEN=$(gcloud auth print-access-token)
// are set. Writes under a unique `it/<run>/` prefix and deletes what it wrote
// (the caller's token needs objects.create/get/delete on the bucket — the
// service's own identity deliberately cannot delete).
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { after, describe, test } from "node:test";
import { gcsStorage } from "../src/storage/gcs.mjs";

const bucket = process.env.NX_CACHE_IT_GCS_BUCKET;
const token = process.env.NX_CACHE_IT_GCS_TOKEN;
const prefix = `it/${Date.now()}-${randomBytes(4).toString("hex")}/`;

function bytes(size, seed) {
  const c = createCipheriv(
    "aes-256-ctr",
    Buffer.alloc(32, seed),
    Buffer.alloc(16),
  );
  return c.update(Buffer.alloc(size));
}
const sha = (b) => createHash("sha256").update(b).digest("hex");

describe(
  "GCS backend — real bucket",
  {
    skip:
      !(bucket && token) &&
      "set NX_CACHE_IT_GCS_BUCKET + NX_CACHE_IT_GCS_TOKEN",
  },
  () => {
    const storage = gcsStorage({ bucket, prefix, getToken: async () => token });
    const written = new Set();

    after(async () => {
      for (const key of written) {
        await fetch(
          `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(prefix + key)}`,
          {
            method: "DELETE",
            headers: { authorization: `Bearer ${token}` },
          },
        );
      }
    });

    test("create, exists, byte-exact streamed read, missing → null", async () => {
      const body = bytes(40 * 1024 * 1024 + 3, 1); // > 32 MiB
      written.add("roundtrip");
      assert.equal(
        await storage.put("roundtrip", Readable.from([body]), body.length),
        "created",
      );
      assert.equal(await storage.exists("roundtrip"), true);
      const obj = await storage.get("roundtrip");
      assert.equal(obj.length, body.length);
      const h = createHash("sha256");
      for await (const c of obj.stream) h.update(c);
      assert.equal(h.digest("hex"), sha(body));
      assert.equal(await storage.get("does-not-exist"), null);
      assert.equal(await storage.exists("does-not-exist"), false);
    });

    test("ifGenerationMatch=0: 10 concurrent writers → exactly one created, first bytes kept", async () => {
      written.add("race");
      const bodies = Array.from({ length: 10 }, (_, i) =>
        bytes(256 * 1024, i + 10),
      );
      const results = await Promise.all(
        bodies.map((b) => storage.put("race", Readable.from([b]), b.length)),
      );
      assert.equal(
        results.filter((r) => r === "created").length,
        1,
        String(results),
      );
      assert.equal(results.filter((r) => r === "exists").length, 9);
      const winner = bodies[results.indexOf("created")];
      const chunks = [];
      for await (const c of (await storage.get("race")).stream) chunks.push(c);
      assert.equal(sha(Buffer.concat(chunks)), sha(winner));
    });

    test("a short body (client lied about Content-Length) commits nothing", async () => {
      await assert.rejects(
        storage.put("short", Readable.from([Buffer.alloc(100)]), 1000),
      );
      assert.equal(await storage.get("short"), null);
    });
  },
);
