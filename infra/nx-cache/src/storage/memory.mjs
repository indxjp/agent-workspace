// In-memory backend — unit tests and local experiments only. The
// check-and-set at the end of put() runs synchronously on the single JS
// thread, so it is atomic with respect to every other request in the process:
// two concurrent PUTs of one key can both stream their bodies, but exactly one
// reaches `objects.set`.
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lengthGuard } from "../length-guard.mjs";

export function memoryStorage() {
  /** @type {Map<string, Buffer>} */
  const objects = new Map();
  return {
    kind: "memory",
    objects,
    async exists(key) {
      return objects.has(key);
    },
    async get(key) {
      const buf = objects.get(key);
      if (!buf) return null;
      return { stream: Readable.from([buf]), length: buf.length };
    },
    async put(key, body, length) {
      const chunks = [];
      await pipeline(body, lengthGuard(length), async (source) => {
        for await (const chunk of source) chunks.push(chunk);
      });
      if (objects.has(key)) return "exists";
      objects.set(key, Buffer.concat(chunks));
      return "created";
    },
  };
}
