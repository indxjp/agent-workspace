import type {
  AuditEventRepositoryProvider,
  WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { defineSlot } from '../runtime-slot';

export interface AuditRuntime {
  /** Resolves the scope of the workspace `authorise` has already verified the caller belongs to. */
  readonly scopes: Pick<WorkspaceScopeResolver, 'forWorkspaceId'>;
  readonly repositories: AuditEventRepositoryProvider;
}

const slot = defineSlot<AuditRuntime>('__agentWorkspaceAuditRuntime__');

export function configureAuditRuntime(runtime: AuditRuntime): void {
  slot.set(runtime);
}

export function clearAuditRuntime(): void {
  slot.clear();
}

export function currentAuditRuntime(): AuditRuntime | null {
  return slot.current();
}
