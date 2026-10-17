/**
 * The single seam between the connector routes and the rest of the application — who the caller
 * is, and where connectors are stored. Copies `apps/web/server/secrets/runtime.ts`'s shape and
 * reasoning exactly; see that file's header for why a `globalThis`-anchored registry and not a
 * module-level `let` (Next.js compiles route handlers and `instrumentation.ts` into separate
 * module graphs).
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until something calls {@link configureConnectorsRuntime}, {@link currentConnectorsRuntime}
 * returns `null` and every connector route answers `503 connectors_runtime_not_configured`.
 *
 * ## The production composition root
 *
 * `apps/web/instrumentation.ts` installs the real repository adapter after the encrypted secrets
 * service is available. If that service cannot start, the connector seam remains uninstalled and
 * every route answers 503 by name; connector credentials never fall back to plaintext or memory.
 * Decision 5 of `docs/adr/W2-CP-05-connectors-and-test-connection.md` records this composition.
 */
import type { ConnectorsStoreProvider } from './store';

/**
 * Who the caller is, as far as the connector routes need to know. The same shape
 * `apps/web/server/secrets/runtime.ts` declares, duplicated here rather than imported for the
 * reason that file's own header gives: this task has no business depending on a sibling task's
 * file it cannot change, and the shape is three lines.
 */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/**
 * The one fact `POST /api/connectors` needs about the caller beyond their workspace: the
 * `memberships.user_id` to stamp as `created_by` (issue #117). Named after `recordAudit`'s own
 * existing actor, because it is the same identity, reused rather than re-derived — this adds one
 * field to what the composition root already builds, not a new lookup.
 */
export interface ConnectorActor {
  readonly principalId: string;
  readonly userId: string | null;
}

/** Everything the connector routes need from the rest of the application, and nothing more. */
export interface ConnectorsRuntime {
  /** Decide which workspace this request acts in (spec §25). Never derived from caller input. */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Connector persistence and probe resolution, scoped to one workspace. */
  connectors: ConnectorsStoreProvider;
  /** Durable audit sink. Mutating routes await this before reporting success. */
  recordAudit(
    request: Request,
    event: Readonly<{ subjectId: string; subjectLabel: string }>,
  ): Promise<void>;
  /**
   * The verified member behind this request, or `null` when none can be established (no session,
   * an API key, or a session whose membership was removed). issue #117: `POST /api/connectors`
   * needs this to stamp `created_by`; a `null` here refuses the create rather than fabricating an
   * owner, which `recordAudit`'s own pre-existing behaviour already requires an actor to avoid.
   */
  identifyActor(request: Request): Promise<ConnectorActor | null>;
}

interface ConnectorsRuntimeRegistry {
  __agentWorkspaceConnectorsRuntime__?: ConnectorsRuntime;
}

const registry = globalThis as typeof globalThis & ConnectorsRuntimeRegistry;

/** Install the runtime the connector routes use. Called once, from application wiring. */
export function configureConnectorsRuntime(runtime: ConnectorsRuntime): void {
  registry.__agentWorkspaceConnectorsRuntime__ = runtime;
}

/** Remove the installed runtime. Exists so a test can assert the unconfigured path really fails. */
export function clearConnectorsRuntime(): void {
  delete registry.__agentWorkspaceConnectorsRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentConnectorsRuntime(): ConnectorsRuntime | null {
  return registry.__agentWorkspaceConnectorsRuntime__ ?? null;
}
