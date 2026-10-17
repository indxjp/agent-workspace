import type { RuntimeProfileStoreProvider } from '../runtimes/store';
import type { AgentsRuntime } from './runtime';

export interface RuntimeSwitchActor {
  readonly principalId: string;
  /** Compatibility attribution for membership principals; null for API keys. */
  readonly userId: string | null;
  readonly userLabel: string;
  readonly workspaceId: string;
}

export interface RuntimeSwitchAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: 'agent-changed';
  readonly subjectId: string;
  readonly subjectLabel: string;
}

/** Build the one §36 writer used after `PATCH /api/agents/:id` persists a profile change. */
export function createRuntimeSwitchAudit(
  dependencies: Readonly<{
    profiles: RuntimeProfileStoreProvider;
    identifyActor(request: Request): Promise<RuntimeSwitchActor | null>;
    recordAuditEvent(event: RuntimeSwitchAuditEvent): Promise<void>;
  }>,
): NonNullable<AgentsRuntime['runtimeSwitchAudit']> {
  return {
    async record(request, change): Promise<void> {
      const actor = await dependencies.identifyActor(request);
      if (actor === null) {
        throw new Error(
          'the authenticated runtime switch no longer resolves to a workspace member',
        );
      }
      const store = dependencies.profiles.forWorkspace(actor.workspaceId);
      const [fromProfile, toProfile] = await Promise.all([
        change.fromRuntimeProfileId === null
          ? Promise.resolve(null)
          : store.get(change.fromRuntimeProfileId),
        change.toRuntimeProfileId === null
          ? Promise.resolve(null)
          : store.get(change.toRuntimeProfileId),
      ]);
      if (change.fromRuntimeProfileId !== null && fromProfile === null) {
        throw new Error(`the previous runtime profile ${change.fromRuntimeProfileId} disappeared`);
      }
      if (change.toRuntimeProfileId !== null && toProfile === null) {
        throw new Error(`the next runtime profile ${change.toRuntimeProfileId} disappeared`);
      }
      const fromDriver = fromProfile?.driver ?? 'default';
      const toDriver = toProfile?.driver ?? 'default';
      await dependencies.recordAuditEvent({
        workspaceId: actor.workspaceId,
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.userLabel,
        action: 'agent-changed',
        subjectId: change.agentId,
        subjectLabel: `${change.agentName}: runtime ${fromDriver} -> ${toDriver}`,
      });
    },
  };
}
