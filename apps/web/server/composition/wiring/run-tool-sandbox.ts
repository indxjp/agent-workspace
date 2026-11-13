/**
 * A run's tool sandbox (ADR-0118): its request, built from the version's pinned tool bundles, and the
 * record of where the allocation put it, so the gateway can reach it.
 */
import type { SecretsService } from '@agent-workspace/core/secrets';
import { toolSandboxRunToken } from '@agent-workspace/gateway/tokens';

import { buildToolSandboxRequest } from '../../compose/tool-sandbox';
import { atStep } from '../../runs/failures';
import type { LaunchContext } from '../../runs/environment';
import { isPlatformOwnedSecretName } from '../../secrets/contract';
import { readToolBundle } from '../../tool-bundles/handlers';
import { openToolBundleStore } from '../../tool-bundles/http';
import { log } from '../../telemetry/logger';
import type { RuntimeTargetDependencies } from './runtime-resolver';
import type { SubsystemsWiring } from './subsystems';

export type RunnerManager = NonNullable<SubsystemsWiring['runnerManager']>;

export type ToolSandboxDependencies = Pick<
  RuntimeTargetDependencies,
  'scopes' | 'secretsService' | 'runAgentOf' | 'gatewaySettings' | 'root'
>;

/**
 * A run's tool-sandbox secret source: the workspace secret `name`, or `null` when it is not set.
 * A platform-owned credential (a storage connection's, a webhook's signing secret) is never a
 * tool's: it is `null` without being read, whoever calls this.
 */
export function runToolSecretSource(
  dependencies: {
    readonly scopes: Pick<ToolSandboxDependencies['scopes'], 'forWorkspaceId'>;
    readonly secretsService: Pick<SecretsService, 'resolveByName'> | null;
  },
  workspaceId: string,
): (name: string) => Promise<string | null> {
  return (name) =>
    atStep('secrets', async () => {
      if (isPlatformOwnedSecretName(name)) return null;
      const scope = await dependencies.scopes.forWorkspaceId(workspaceId);
      const resolved =
        scope === null || dependencies.secretsService === null
          ? null
          : await dependencies.secretsService.resolveByName(scope, name);
      return resolved === null ? null : resolved.value.toString('utf8');
    });
}

/** The tool sandbox a version that pins code tools gets from its allocation, if it has any. */
export async function requestRunToolSandbox(
  { scopes, secretsService, gatewaySettings, runAgentOf }: ToolSandboxDependencies,
  context: LaunchContext,
) {
  const workspaceId = context.principal.workspaceId;
  const { toolBundles } = await atStep('tools', () => runAgentOf(context));
  if (toolBundles.length === 0) return undefined;
  return await atStep('tools', () =>
    buildToolSandboxRequest(context.run.id, toolBundles, {
      bundle: async (digest) => {
        const store = openToolBundleStore(workspaceId);
        return store === null ? null : readToolBundle(store, digest);
      },
      secret: runToolSecretSource({ scopes, secretsService }, workspaceId),
      runToken: (runId) => {
        if (!gatewaySettings.ok) throw new Error(gatewaySettings.reason);
        return toolSandboxRunToken(gatewaySettings.settings.signingSecret, runId);
      },
    }),
  );
}

/** Record where the run's tool sandbox is, so the gateway can reach it; throws if it is not recorded. */
async function recordRunToolSandbox(
  { scopes, root }: Pick<ToolSandboxDependencies, 'scopes' | 'root'>,
  context: LaunchContext,
  toolSandboxOrigin: string,
): Promise<void> {
  const workspaceId = context.principal.workspaceId;
  await atStep('tools', async () => {
    const scope = await scopes.forWorkspaceId(workspaceId);
    const outcome =
      scope === null
        ? null
        : await root.runs.forScope(scope).recordToolSandbox?.(context.run.id, toolSandboxOrigin);
    if (outcome?.kind !== 'recorded') {
      throw new Error(`the run tool sandbox was not recorded (${outcome?.kind ?? 'unavailable'})`);
    }
  });
}

/** Release the run's tool sandboxes, reporting (never throwing) a failure of the release itself. */
export async function releaseRunToolSandboxes(
  runnerManager: RunnerManager,
  context: LaunchContext,
  providerCredential: Parameters<RunnerManager['releaseRunToolSandboxes']>[2],
): Promise<void> {
  await runnerManager
    .releaseRunToolSandboxes(context.principal.workspaceId, context.run.id, providerCredential)
    .catch((releaseError: unknown) => {
      // The original failure is still thrown; the release failure must not vanish.
      log.error(`[runs] run ${context.run.id}: its tool sandbox could not be released`, {
        error: releaseError instanceof Error ? releaseError.name : 'unknown',
        message: releaseError instanceof Error ? releaseError.message : undefined,
      });
    });
}

/**
 * Record where the run's tool sandbox is. When that fails no target is returned, so the launcher
 * would never release the sandbox: `release` runs here, then the original failure is rethrown.
 */
export async function recordRunToolSandboxOrRelease(
  dependencies: Pick<ToolSandboxDependencies, 'scopes' | 'root'>,
  context: LaunchContext,
  toolSandboxOrigin: string,
  release: () => Promise<void>,
): Promise<void> {
  try {
    await recordRunToolSandbox(dependencies, context, toolSandboxOrigin);
  } catch (error) {
    await release();
    throw error;
  }
}
