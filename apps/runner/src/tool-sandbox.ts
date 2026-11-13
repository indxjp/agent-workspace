import { TOKENS_FILE } from './tool-sandbox-contracts.js';
import type { SandboxContext } from './tool-sandbox-context.js';
import { withCompensation } from '@agent-workspace/core';
import type { ToolSandboxes } from './tool-sandbox-contracts.js';
import { createSandboxContext } from './tool-sandbox-context.js';
import type { ToolSandboxOptions } from './tool-sandbox-contracts.js';
import { openSandbox } from './tool-sandbox-lifecycle.js';
import { sessionTags } from './tool-sandbox-config.js';

export {
  TOOL_SANDBOX_ENGINE,
  ToolSandboxUnavailableError,
  parseToolSandboxRequest,
} from './tool-sandbox-contracts.js';

export type {
  ToolSandboxDriver,
  ToolSandboxes,
  ToolSandboxSession,
  ToolSandboxUpstream,
} from './tool-sandbox-contracts.js';

export function createToolSandboxes(options: ToolSandboxOptions): ToolSandboxes {
  const context = createSandboxContext(options);
  const upstreamOf = context.upstreamOf;
  return {
    open(session, request) {
      const previous = context.queue.get(session.key) ?? Promise.resolve();
      const next = previous.then(
        () => openSandbox(context, session, request),
        () => openSandbox(context, session, request),
      );
      context.queue.set(session.key, next);
      void next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    close: (session, credential) => closeSandbox(context, session, credential),
    release: (run, credential) => releaseSandboxes(context, run, credential),
    ...(upstreamOf === undefined
      ? {}
      : {
          upstream(id: string) {
            const handle =
              context.options.recover?.(id) ??
              [...context.sandboxes.values()].find((entry) => entry.handle.id === id)?.handle;
            return handle === undefined ? undefined : upstreamOf(handle);
          },
        }),
  };
}

async function closeSandbox(
  context: SandboxContext,
  session: Parameters<ToolSandboxes['close']>[0],
  providerCredential?: string,
): Promise<void> {
  const { key } = session;
  await context.queue.get(key)?.catch(() => undefined);
  context.queue.delete(key);
  const current = context.sandboxes.get(key);
  context.sandboxes.delete(key);
  await withCompensation(
    async () => {
      if (context.options.driver.destroyTagged !== undefined) {
        await context.options.driver.destroyTagged(sessionTags(session), providerCredential);
      } else if (current !== undefined) {
        await context.options.driver.destroy(current.handle, providerCredential);
      }
    },
    async () => {
      // The sandbox outlives the close: at least the run token it holds stops working.
      if (current !== undefined) {
        await context.options.driver.writeFile(
          current.handle,
          TOKENS_FILE,
          '[]',
          providerCredential,
        );
      }
    },
  );
}

async function releaseSandboxes(
  context: SandboxContext,
  run: { workspaceId: string; runId: string },
  providerCredential?: string,
): Promise<void> {
  const startedBy = `${run.workspaceId}/${run.runId}`;
  const started = [...context.sandboxes].filter(([, entry]) => entry.startedBy === startedBy);
  for (const [key] of started) context.sandboxes.delete(key);
  if (context.options.driver.destroyTagged !== undefined) {
    // Another invocation of a stateless manager may have started it: the provider knows.
    await context.options.driver.destroyTagged(
      { awWorkspace: run.workspaceId, awRun: run.runId },
      providerCredential,
    );
  } else {
    await Promise.all(
      started.map(([, entry]) => context.options.driver.destroy(entry.handle, providerCredential)),
    );
  }
}
