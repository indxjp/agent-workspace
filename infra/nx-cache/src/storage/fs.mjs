// Filesystem backend — for running the cache on a plain host/VM (or an
// existing service host with a persistent disk) instead of Cloud Run + GCS.
//
// Immutability is enforced by the kernel, not by a check-then-write: the body
// streams into a private temp file in the SAME directory, is fsync'd, and is
// then published with link(2). link() fails with EEXIST when the target
// already exists, atomically, so of two concurrent writers of one key exactly
// one link succeeds and the other gets "exists". A failed/short upload never
// reaches link(), so no partial object is ever visible under a cache key.
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { lengthGuard } from "../length-guard.mjs";

/** @param {{ root: string }} opts */
export function fsStorage({ root }) {
  const objectsDir = join(root, "objects");
  const tmpDir = join(root, "objects", ".tmp");
  const ready = (async () => {
    await mkdir(tmpDir, { recursive: true });
  })();
  const pathFor = (key) => join(objectsDir, key);

  return {
    kind: "fs",
    async exists(key) {
      await ready;
      try {
        await stat(pathFor(key));
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    },
    async get(key) {
      await ready;
      let st;
      try {
        st = await stat(pathFor(key));
      } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
      }
      return { stream: createReadStream(pathFor(key)), length: st.size };
    },
    async put(key, body, length) {
      await ready;
      const tmp = join(tmpDir, `${key}.${randomBytes(8).toString("hex")}`);
      try {
        await pipeline(
          body,
          lengthGuard(length),
          createWriteStream(tmp, { flags: "wx" }),
        );
        const fh = await open(tmp, "r+"); // Windows refuses fsync on a read-only handle
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        try {
          await link(tmp, pathFor(key));
          return "created";
        } catch (err) {
          if (err.code === "EEXIST") return "exists";
          throw err;
        }
      } finally {
        await unlink(tmp).catch(() => {});
      }
    },
  };
}
