/**
 * Gives every workspace with the `builder` feature on its Builder (#1848 slice 1c). The composition
 * root runs {@link BuilderProvisioner.provisionAll} once at start-up and hands
 * {@link BuilderProvisioner.provision} to the feature-switch route and to workspace creation, so a
 * restart, the switch turning on and a new workspace all reach the one idempotent
 * `ensureBuilderAgent`. Each call re-reads the switch inside the workspace's lock, so a switch-off
 * that lands between a switch-on and its provisioning leaves no Builder behind.
 *
 * Where the Builder's model connection and runtime profile come into existence, it is provisioned
 * again (slice 1d): after first-run setup ({@link provisioningAfterSetup}) and after a model
 * connection is created or changed ({@link provisioningAfterConnectionWrites}). The workspace's
 * default runtime profile is only ever set by setup and by the embedded local runtime before
 * start-up, so no profile route needs a hook.
 *
 * A failure never escapes: start-up and a committed feature switch must not fail because the
 * Builder could not be written, and the next start-up or switch tries again.
 */
import type { AgentVersionsRuntime } from '../agent-versions/runtime';
import type { AgentStoreProvider } from '../agents/store';
import { builderShippedBody } from '../builder/agent/definition';
import { ensureBuilderAgent } from '../builder/agent/provision';
import type { FeatureSwitches } from '../features/runtime';
import type { Models } from '../models/runtime';
import type { Setup } from '../setup/runtime';
import { log } from '../telemetry/logger';

/** Long enough for another process to finish writing the Builder, short enough not to stall start-up. */
const LOCK_WAIT_MS = 30_000;

export interface BuilderProvisioner {
  /** Ensure the Builder of one workspace if its `builder` feature is on; never throws. */
  provision(workspaceId: string): Promise<void>;
  /** Ensure the Builder of every workspace that has the feature on, one at a time. */
  provisionAll(): Promise<void>;
}

interface BuilderProvisioningInput {
  readonly root: {
    readonly workspaces: { ownerPrincipalId(workspaceId: string): Promise<string | null> };
    listWorkspaceIds(): Promise<readonly string[]>;
    withWorkspaceSetupLock(
      workspaceId: string,
      waitMs: number,
      work: () => Promise<void>,
    ): Promise<{ readonly acquired: boolean }>;
  };
  readonly agents: AgentStoreProvider;
  readonly agentVersions: AgentVersionsRuntime;
  readonly switches: FeatureSwitches;
}

export function builderProvisioner(input: BuilderProvisioningInput): BuilderProvisioner {
  const { root, agents, agentVersions } = input;

  const ensure = async (workspaceId: string): Promise<void> => {
    // Read inside the lock: a switch-off may have committed since the switch-on that asked for this.
    if (!(await input.switches.enabledFor(workspaceId)).includes('builder')) return;
    // The workspace's earliest Owner owns the Builder; a workspace with none has no one to act for.
    const principalId = await root.workspaces.ownerPrincipalId(workspaceId);
    if (principalId === null) {
      log.warn('[compose] the Builder was not provisioned: the workspace has no Owner', {
        workspaceId,
      });
      return;
    }
    const outcome = await ensureBuilderAgent(workspaceId, {
      shippedBody: builderShippedBody(),
      owner: {
        principalId,
        ownerPrincipalId: principalId,
        userId: null,
        // Audited as the Owner; no `ceiling` is passed, so the default (none) applies.
        role: 'owner',
        actorLabel: 'platform',
      },
      versions: agentVersions.versions,
      agents,
      toolHost: agentVersions.toolHost,
      toolDomainsRefusal: agentVersions.toolDomainsRefusal,
    });
    if (outcome.kind === 'refused') {
      log.warn('[compose] the Builder was not provisioned: the version pipeline refused it', {
        workspaceId,
        status: outcome.result.status,
      });
    }
  };

  const provision = async (workspaceId: string): Promise<void> => {
    try {
      const locked = await root.withWorkspaceSetupLock(workspaceId, LOCK_WAIT_MS, () =>
        ensure(workspaceId),
      );
      if (!locked.acquired) {
        log.warn('[compose] the Builder was not provisioned: another process held the lock', {
          workspaceId,
        });
      }
    } catch {
      // The error may carry SQL or provider text, so the warning names only the workspace.
      log.warn('[compose] the Builder was not provisioned: a read or write failed', {
        workspaceId,
      });
    }
  };

  return {
    provision,
    async provisionAll() {
      let workspaceIds: readonly string[];
      try {
        workspaceIds = await root.listWorkspaceIds();
      } catch {
        log.warn('[compose] the Builders were not provisioned: the workspaces could not be read');
        return;
      }
      for (const workspaceId of workspaceIds) await provision(workspaceId);
    },
  };
}

/** First-run setup that provisions every Builder again once it has made the connection and profile. */
export function provisioningAfterSetup(setup: Setup, builders: BuilderProvisioner): Setup {
  if (setup.kind !== 'serving') return setup;
  return {
    kind: 'serving',
    runtime: {
      async complete(input) {
        const result = await setup.runtime.complete(input);
        if (result.ok) await builders.provisionAll();
        return result;
      },
    },
  };
}

/** The models API, provisioning a workspace's Builder again after a connection is created or changed. */
export function provisioningAfterConnectionWrites(
  models: Models,
  builders: BuilderProvisioner,
): Models {
  if (models.kind !== 'serving') return models;
  const { runtime } = models;
  return {
    kind: 'serving',
    runtime: {
      ...runtime,
      models: {
        forWorkspace(workspaceId) {
          const store = runtime.models.forWorkspace(workspaceId);
          return {
            ...store,
            async create(input) {
              const outcome = await store.create(input);
              if (outcome.kind === 'created') await builders.provision(workspaceId);
              return outcome;
            },
            async update(id, input) {
              const outcome = await store.update(id, input);
              if (outcome.kind === 'updated') await builders.provision(workspaceId);
              return outcome;
            },
          };
        },
      },
    },
  };
}
