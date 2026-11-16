import { extractUstarStream, RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { DomainError, InfrastructureError } from '../errors';
import type { RuntimeLaunchTarget } from './launch-target';

/** The coded failure (e.g. `run_file_corrupt`) an aborted request body carried, if any. */
function domainCause(error: unknown): DomainError | null {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (at instanceof DomainError) return at;
  }
  return null;
}

/** Stream the input archive into the runtime's `POST /files`; the body is never held whole. */
// @story US-STO-06
export async function hydrateRuntime(
  archive: ReadableStream<Uint8Array>,
  base: string,
  doFetch: typeof globalThis.fetch,
  requestHeaders: Readonly<Record<string, string>>,
): Promise<void> {
  // A variable, not a literal: the DOM `RequestInit` apps/web type-checks against has no `duplex`.
  const init = {
    method: 'POST',
    headers: { ...requestHeaders, 'Content-Type': 'application/x-tar' },
    body: archive,
    duplex: 'half' as const,
    // Not only a policy: unless redirects are an error, fetch clones the request to replay it, and
    // the clone tees the body, buffering every byte of it (measured: 127 MiB for 128 MiB sent).
    redirect: 'error' as const,
  };
  let response: Response;
  try {
    response = await doFetch(`${base}/files`, init);
  } catch (error) {
    // A corrupt file aborts the body; fetch rejects with that reason somewhere in its causes.
    throw domainCause(error) ?? error;
  }
  if (!response.ok) {
    throw new InfrastructureError({
      component: 'runtime',
      operation: 'hydrate-workspace',
      failureKind: 'upstream',
      cause: await runtimeHttpFailure(response),
    });
  }
}

/**
 * A `local` runner runs on this host and creates the run's `cwd` under `target.workspaceRoot`, so
 * its input archive is extracted there directly: its `/files` endpoint is not session-scoped
 * (issue #881). The runner then checks the references against what landed.
 */
export async function hydrateLocalWorkspace(
  archive: ReadableStream<Uint8Array>,
  target: RuntimeLaunchTarget,
): Promise<void> {
  await extractUstarStream(archive, target.workspaceRoot, { maxBytes: RUN_FILES_MAX_BYTES });
}

/**
 * The runner's own error body is the only place the real reason lives; it stays in the server log.
 * Only the first chunk is read, so an arbitrarily large error page is never buffered.
 */
export async function runtimeHttpFailure(response: Response): Promise<Error> {
  const reader = response.body?.getReader();
  const first = reader === undefined ? undefined : await reader.read().catch(() => undefined);
  await reader?.cancel().catch(() => undefined);
  const body =
    first?.value === undefined ? '' : new TextDecoder().decode(first.value.subarray(0, 500));
  return new Error(
    `runtime returned HTTP ${String(response.status)}${body === '' ? '' : `: ${body}`}`,
  );
}
