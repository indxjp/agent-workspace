/**
 * `tests/conformance/fixtures/archive.ts` — a harness-only archive format, used only to prove
 * scenario 3 (`hydrate-and-collect-files`) and scenario 9's `putFiles`/`getFiles` branch actually
 * works, end to end, against `fixtures/file-transfer-fixture.ts`.
 *
 * `packages/runtime/src/driver.ts` types `putFiles`/`getFiles`'s archive as a bare
 * `ReadableStream` (a platform global), not a committed wire format — the format is a private
 * agreement between one driver and whatever calls it. Production drivers agree with the runtime
 * HTTP contract's POSIX ustar (`packages/runtime/src/transfer.ts`, W3-CP-07's, two levels below
 * this task and out of `tests/conformance/**`'s glob). This file is *not* that codec: it is a
 * JSON-over-bytes format this fixture invents and reads back itself, sufficient to prove the
 * harness's own branching logic (mount vs. `putFiles`/`getFiles`) is correct without duplicating
 * work that belongs to a different task at a different level.
 */
export type ArchiveEntry = { readonly path: string; readonly content: string };

export function encodeArchive(entries: readonly ArchiveEntry[]): ReadableStream {
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

export async function decodeArchive(archive: ReadableStream): Promise<readonly ArchiveEntry[]> {
  // Node's global `ReadableStream` implements the WHATWG async-iterable protocol at run time
  // (verified: a plain `for await` drains it in source order); the ambient `ReadableStream` type
  // this repository's `tsconfig.json` sees does not declare `[Symbol.asyncIterator]`, so the cast
  // below is to a narrower, accurate interface rather than to `unknown`/`any`.
  const chunks: Uint8Array[] = [];
  for await (const chunk of archive as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(merged));
  if (!Array.isArray(parsed)) {
    throw new Error('fixture archive did not decode to an array of entries.');
  }
  return parsed as ArchiveEntry[];
}
