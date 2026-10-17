import type { ModelDiscovery } from './discovery';
import type { TestConnectionResult } from './probe';
import type { ModelsStoreProvider, ResolvedModelConnection } from './store';
// Read-only: `Role` is `rbac/roles.ts`'s own closed union of spec §21's four roles. Carrying it
// here — rather than a bare `string` — is what issue #149's write gate needs: `decide()` takes a
// `Role`, and a resolution that only ever held a display label had nowhere for one to come from.
import type { Role } from '../rbac/roles';
import type { TokenScope } from '../rbac/token-scope';

export type ModelsActorResolution =
  | {
      readonly kind: 'workspace';
      readonly workspaceId: string;
      readonly principalId: string;
      readonly userId: string | null;
      readonly userLabel: string;
      /**
       * The acting membership's role (issue #149). Required, not optional: an actor resolution
       * that could omit it would let a write route fall back to "no role", and `decide()` treats a
       * missing/unparseable role as `refuse`, not as the least-privileged one — the same
       * ADR-0031 shape as everywhere else in this program, applied to the one field a Viewer or
       * Builder could otherwise reach `MANAGE`-only routes through.
       */
      readonly role: Role;
      /**
       * The attenuation a browser-token credential carries (issue #236, SDK-04, S-1), or `null`
       * for a session or an API-key principal. `withModelsRuntime` (`./http.ts`) passes this to
       * `decide()`; `models`/`model-connections` are in no scope's grammar, so any browser token
       * reaching this route is denied `token_out_of_scope` before §21's own table is consulted.
       */
      readonly scope: TokenScope | null;
    }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

export type ModelsAuditEvent = {
  readonly workspaceId: string;
  readonly actorPrincipalId: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action: 'provider-credential-changed';
  readonly subjectId: string;
  readonly subjectLabel: string;
};

export interface ModelsRuntime {
  resolveActor(request: Request): Promise<ModelsActorResolution>;
  models: ModelsStoreProvider;
  probe(resolved: ResolvedModelConnection): Promise<TestConnectionResult>;
  /** #129: `GET /api/models`'s discovery call, one connection at a time. */
  discover: ModelDiscovery;
  audit(event: ModelsAuditEvent): Promise<void>;
  log(message: string): void;
}

interface Registry {
  __agentWorkspaceModelsRuntime__?: ModelsRuntime;
}
const registry = globalThis as typeof globalThis & Registry;

export function configureModelsRuntime(runtime: ModelsRuntime): void {
  registry.__agentWorkspaceModelsRuntime__ = runtime;
}

export function clearModelsRuntime(): void {
  delete registry.__agentWorkspaceModelsRuntime__;
}

export function currentModelsRuntime(): ModelsRuntime | null {
  return registry.__agentWorkspaceModelsRuntime__ ?? null;
}
