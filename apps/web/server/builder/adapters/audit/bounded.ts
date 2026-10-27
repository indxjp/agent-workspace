import { BUILDER_DEFAULT_LIMITS, type BuilderToolName } from '@indx-workspace/contracts/builder';

import { callDigest } from '../../call-digest';

/**
 * A value as the journal stores it. Anything JSON cannot serialise (a cycle, a bigint) becomes
 * `{ unserialisable: true }`, and anything over the tool-output limit becomes a `truncated` marker
 * with its size, so a journal row stays small and says why it is not the whole value. `undefined`
 * (or a value JSON drops) is `empty`. With `digest`, the truncated marker also carries the digest
 * of the whole value, so a later call can still be matched against it.
 */
export function bounded(
  value: unknown,
  empty: unknown,
  digest?: (whole: unknown) => string,
): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { unserialisable: true };
  }
  if (json === undefined) return empty;
  const bytes = Buffer.byteLength(json);
  if (bytes <= BUILDER_DEFAULT_LIMITS.toolOutputMaxBytes) return value;
  return digest === undefined
    ? { truncated: true, bytes }
    : { truncated: true, bytes, sha256: digest(value) };
}

/** How a journaled input too big to keep is still told apart: by the digest of the whole call. */
export const inputDigest = (tool: BuilderToolName | null) =>
  tool === null ? undefined : (whole: unknown) => callDigest(tool, whole);
