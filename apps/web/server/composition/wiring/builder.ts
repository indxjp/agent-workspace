import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';

import type { AgentVersionsRuntime } from '../../agent-versions/runtime';
import { storageConnectionLookup } from '../../agent-versions/storage-grants';
import type { AgentsRuntime } from '../../agents/runtime';
import type { AgentStoreProvider } from '../../agents/store';
import type { AuditDeps } from '../../builder/adapters/audit/store';
import {
  builderRunReader,
  productionBuilderPorts,
  type BuilderRunDatabase,
} from '../../builder/transport/composition';
import { createAllowedOwnerWarning } from '../../builder/transport/allowed-owner-warning';
import { createBuilderCallerVerifier, type BuilderDoor } from '../../builder/transport/mcp';
import type { Connectors } from '../../connectors/runtime';
import type { Models } from '../../models/runtime';
import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { DirectoryRoot } from '../../rbac/directory';
import { getRunApi } from '../../runs/environment';
import type { Runtimes } from '../../runtimes/runtime';
import { catalogNotConfigured, listSkillsWithIds } from '../../skills/service';
import type { Skills } from '../../skills/runtime';
import type { StorageConnections } from '../../storage-connections/runtime';
import { log } from '../../telemetry/logger';
import { openToolBundleLookup } from '../../tool-bundles/http';

type Scope = NonNullable<Awaited<ReturnType<AuditDeps['scopes']['forWorkspaceId']>>>;

interface BuilderWiringInput {
  /** The slices of the database root the door reads; a `DatabaseRoot` satisfies it. */
  readonly root: RunTokenDatabase<Scope> &
    BuilderRunDatabase<Scope> & {
      readonly scopes: AuditDeps['scopes'];
      readonly builderToolCalls: AuditDeps['repositories'];
    };
  readonly tokenSecret: string | null;
  readonly policyCeiling: ProjectPolicy | null;
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  readonly agents: AgentStoreProvider;
  readonly agentsRuntime: Pick<AgentsRuntime, 'agentGrants'>;
  readonly agentVersions: AgentVersionsRuntime;
  readonly connectors: Connectors;
  readonly models: Models;
  readonly runtimes: Runtimes;
  readonly skills: Skills;
  readonly storageConnections: StorageConnections;
}

/**
 * The `aw-control` door: who a run token acts for, and the Builder's ports. A deployment missing
 * any store the tools read gets no ports, so every `tools/call` stays `builder_disabled`.
 */
export function wireBuilder(input: BuilderWiringInput): BuilderDoor {
  const { root, connectors, models, runtimes, skills, storageConnections } = input;
  const serving =
    connectors.kind === 'serving' &&
    models.kind === 'serving' &&
    runtimes.kind === 'serving' &&
    skills.kind === 'serving';
  return {
    verifyCaller: createBuilderCallerVerifier(
      input.tokenSecret === null
        ? null
        : {
            tokens: createRunTokenCodec({ secret: input.tokenSecret }),
            database: root,
            directory: input.directory,
            agents: input.agents,
            ceiling: input.policyCeiling,
            onAllowedAgent: createAllowedOwnerWarning({
              directory: input.directory,
              warn: (message, fields) => log.warn(message, fields),
            }),
          },
    ),
    ports: !serving
      ? null
      : productionBuilderPorts({
          agents: input.agents,
          agentGrants: input.agentsRuntime.agentGrants,
          versions: input.agentVersions,
          connectors: connectors.runtime.connectors,
          models: models.runtime.models,
          runtimeProfiles: runtimes.runtime.profiles,
          skills: async (principal) => {
            const { store, catalog } = skills.runtime;
            if (catalog === undefined) return catalogNotConfigured();
            const workspaceId = principal.workspaceId;
            return listSkillsWithIds(
              store.forWorkspace(workspaceId),
              await catalog.forWorkspace(workspaceId),
              principal,
              skills.runtime.storage === undefined
                ? undefined
                : { storage: skills.runtime.storage, workspaceId },
            );
          },
          storageConnections: (workspaceId) =>
            storageConnections.kind === 'serving'
              ? storageConnectionLookup(storageConnections.runtime.store.forWorkspace(workspaceId))
              : null,
          toolBundles: openToolBundleLookup,
          journal: { repositories: root.builderToolCalls, scopes: root.scopes },
          directory: input.directory,
          approvals: { scopes: root.scopes, runs: root.runs },
          runApi: getRunApi,
          deploymentPolicy: input.policyCeiling,
        }),
    readRun: builderRunReader(root),
  };
}
