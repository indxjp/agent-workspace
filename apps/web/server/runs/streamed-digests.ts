/** The `sha256` a file reference carries until its bytes have gone through the input archive. */
export const STREAMED_SHA256 = '0'.repeat(64);

interface BodyWithFiles {
  readonly resources?: { readonly files?: unknown };
}

/**
 * The `/run` body with each placeholder checksum replaced by the digest the archive computed while
 * streaming that file (the storage design, §05). A reference the archive never reported fails the
 * run: the runner would refuse it anyway, and a wrong checksum must not be sent.
 */
// @story US-STO-12
export function withStreamedDigests(body: unknown, digests: ReadonlyMap<string, string>): unknown {
  const resources = (body as BodyWithFiles | null)?.resources;
  if (resources === undefined || !Array.isArray(resources.files)) return body;
  const files = (resources.files as { path?: string; sha256?: string }[]).map((file) => {
    if (file.sha256 !== STREAMED_SHA256) return file;
    const sha256 = file.path === undefined ? undefined : digests.get(file.path);
    if (sha256 === undefined) {
      throw new Error('a streamed run file was never read into the archive');
    }
    return { ...file, sha256 };
  });
  return { ...(body as object), resources: { ...resources, files } };
}
