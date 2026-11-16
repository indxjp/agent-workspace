/**
 * The folder rule of a storage connection: whether a folder is inside one of the connection's
 * allowed folders. Test, browse, run delivery and write-back all decide with it. It belongs to the
 * storage context (refactoring plan part 10, step 3); agents import it from here.
 */

/**
 * Whether `prefix` is `allowed` or below it, compared segment by segment: `reports-old/x` is not
 * under `reports`. Neither side is decoded, so `%2e%2e` is an ordinary segment.
 */
export function isUnderAllowedPrefix(prefix: string, allowed: string): boolean {
  const segments = prefix.split('/');
  return allowed.split('/').every((segment, index) => segments[index] === segment);
}
