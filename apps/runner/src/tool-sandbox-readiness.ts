import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import { type ToolSandboxUpstream, ToolSandboxUnavailableError } from './tool-sandbox-contracts.js';
import type { SandboxContext } from './tool-sandbox-context.js';

/** How long one readiness probe waits for the sandbox to answer before it counts as not serving. */
const PROBE_TIMEOUT_MS = 2_000;

export async function probe(
  context: SandboxContext,
  target: ToolSandboxUpstream,
): Promise<boolean> {
  return await context
    .doFetch(target.url, {
      method: 'POST',
      headers: { ...target.headers },
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    .then(
      async (response) => {
        await response.body?.cancel();
        context.lastStatus = response.status;
        return context.servingWhen(response.status);
      },
      () => false,
    );
}

export function targetOf(
  context: SandboxContext,
  handle: RuntimeHandle,
  publicBase: string,
): ToolSandboxUpstream {
  return (
    context.upstreamOf?.(handle) ?? {
      url: `${context.options.origin(handle, publicBase)}/mcp`,
      headers: {},
    }
  );
}

export async function waitUntilServing(
  context: SandboxContext,
  handle: RuntimeHandle,
  publicBase: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const target = targetOf(context, handle, publicBase);
  while (Date.now() < deadline) {
    if (!(await context.options.driver.isLive(handle))) {
      throw new ToolSandboxUnavailableError(
        'the tool sandbox stopped before it served: a tool bundle did not start',
      );
    }
    const answered = await probe(context, target);
    if (answered) {
      if (await context.options.driver.isLive(handle)) return;
      throw new ToolSandboxUnavailableError(
        'the tool sandbox stopped after it answered: a tool bundle did not start',
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new ToolSandboxUnavailableError(
    `the tool sandbox did not become ready in time (${context.lastStatus === undefined ? 'no answer' : `last answer HTTP ${String(context.lastStatus)}`})`,
  );
}
