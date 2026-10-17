/**
 * `:id` <-> workspace-relative key, for the routes under `/api/files/:id`.
 *
 * ## Why an id at all, and why it is not the human-readable path
 *
 * `tests/route-inventory.test.ts`'s shape rule requires `/api/<resource>/:id`, where `:id` is a
 * single dynamic segment — the path a §16 file lives at is not that shape (`contracts/agreement.pdf`
 * has a `/` in it). This task's `Owns` globs do not include the `files` metadata table's repository
 * (`packages/core/src/db/repositories/**`, W2-DB-02's — see this task's PR "outside Owns" section),
 * so there is no independent, database-assigned id to use instead. The id is therefore *derived*
 * from the path: base64url-encode it into one opaque segment, and decode it back on the way in.
 *
 * Base64url rather than `encodeURIComponent` on purpose: a percent-encoded path still contains a
 * literal `/` once decoded (`contracts%2Fagreement.pdf` decodes to `contracts/agreement.pdf`), and
 * whether a URL router treats an encoded slash inside one path segment as a segment boundary is
 * exactly the ambiguity the R-15 research note §1e's percent-encoding discussion is
 * about. Base64url output never contains `/` (it uses `-` and `_` in its alphabet instead), so the
 * question does not arise: the id Next.js's `[id]` segment receives is always exactly one segment,
 * whatever router is in front of it.
 *
 * A path is never guessable from its id in a way that matters: `key-safety.ts`'s guard runs again
 * on the decoded string before it reaches an `ObjectStore` (see `handlers.ts`), so an id crafted to
 * decode to a traversal string is refused the same way a raw one is.
 */

/** The workspace-relative path, base64url-encoded into one URL-safe segment. */
export function encodeFileId(relativePath: string): string {
  return Buffer.from(relativePath, 'utf8').toString('base64url');
}

/**
 * The reverse of {@link encodeFileId}. `null` for a segment that is not valid base64url or does
 * not decode to valid UTF-8 — never a guess at what the caller "probably meant" (ADR-0015): an id
 * this route did not itself mint is simply not a file this route can name.
 */
export function decodeFileId(id: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  try {
    const buffer = Buffer.from(id, 'base64url');
    // `Buffer.from(str, 'base64url')` silently drops characters it cannot place rather than
    // throwing, so a segment that merely *contains* base64url characters without being a real
    // encoding of anything is caught by round-tripping it back and comparing, not by trusting the
    // decode succeeded.
    if (buffer.toString('base64url') !== id) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}
