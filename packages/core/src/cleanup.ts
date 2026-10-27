/**
 * Cleanup that never discards a failure (`docs/architecture.md`, "Error boundary"): a cleanup that
 * fails after the operation failed is thrown with it as one `AggregateError`, the operation's
 * failure first; a cleanup that fails after the operation succeeded is thrown on its own.
 */

/** Run `body`, then `cleanup` whether `body` succeeded or not. */
export async function withCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<unknown>,
): Promise<T> {
  const result = await withCompensation(body, cleanup);
  await cleanup();
  return result;
}

/** Run `body`; only when it fails, run `compensate` (undo what `body` started) and rethrow. */
export async function withCompensation<T>(
  body: () => Promise<T>,
  compensate: () => Promise<unknown>,
): Promise<T> {
  try {
    return await body();
  } catch (primary) {
    try {
      await compensate();
    } catch (failure) {
      throw new AggregateError([primary, failure], 'cleanup failed after an earlier failure', {
        cause: failure,
      });
    }
    throw primary;
  }
}
