/**
 * What a log line may say about a thrown value. A message can carry a credential, a URL or a row
 * (a provider echoes its key, a driver its SQL), and redaction only matches the shapes it knows, so
 * a log names the failure by its class and, when it has one, a code from a closed alphabet.
 */

/** The class name of a thrown `Error`, or the `typeof` of anything else. */
export const errorNameOf = (cause: unknown): string =>
  cause instanceof Error ? cause.name : typeof cause;

/**
 * A system or driver error code (`ECONNRESET`, `ERR_STREAM_PREMATURE_CLOSE`, a PostgreSQL SQLSTATE
 * such as `57P01`): upper case, digits and underscores. Anything else a library puts in `code`
 * (a lower-case token, a URL, a key) is not logged.
 */
const SAFE_CODE = /^[A-Z0-9][A-Z0-9_]{1,39}$/;

/** `cause.code` when it is a string of the closed alphabet above, else `undefined`. */
export function safeErrorCode(cause: unknown): string | undefined {
  if (!(cause instanceof Error) || !('code' in cause)) return undefined;
  const { code } = cause;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

/** The fields a log line carries for `cause`: its class and, when safe, its code. */
export function safeErrorFields(cause: unknown): { errorName: string; errorCode?: string } {
  const errorCode = safeErrorCode(cause);
  return { errorName: errorNameOf(cause), ...(errorCode === undefined ? {} : { errorCode }) };
}
