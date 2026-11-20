/** The runtime-profile repository's public types; see `./runtime-profiles.ts` for the contract. */
import type {
  RuntimeProfileDriver,
  RuntimeProfileFilesystem,
  RuntimeProfileNetworkPolicy,
} from '../schema/runtime-profiles.js';
import type { WorkspaceScope } from './scope.js';

/** One `runtime_profiles` row, with `timestamptz` columns as `Date`. */
export interface RuntimeProfileRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly driver: RuntimeProfileDriver;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: RuntimeProfileNetworkPolicy;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: RuntimeProfileFilesystem;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything an insert supplies. The workspace is not among them — it comes from the scope. */
export interface CreateRuntimeProfileInput {
  readonly name: string;
  readonly driver: RuntimeProfileDriver;
  readonly runtimeConnectionId: string | null;
  readonly cpu: number | null;
  readonly memoryMb: number | null;
  readonly diskMb: number | null;
  readonly networkPolicy: RuntimeProfileNetworkPolicy;
  readonly allowedDomains: readonly string[] | null;
  readonly filesystem: RuntimeProfileFilesystem;
  readonly persistPaths: readonly string[] | null;
  readonly timeoutSeconds: number | null;
  readonly idleTimeoutSeconds: number | null;
  readonly driverConfig: Record<string, unknown> | null;
}

/** Everything an update may change. An absent key is "leave it alone". */
export type UpdateRuntimeProfilePatch = Partial<CreateRuntimeProfileInput>;

export type CreateRuntimeProfileOutcome =
  | { readonly kind: 'created'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-runtime-connection'; readonly runtimeConnectionId: string };

export type UpdateRuntimeProfileOutcome =
  | { readonly kind: 'updated'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'unknown-runtime-connection'; readonly runtimeConnectionId: string };

export type DeleteRuntimeProfileOutcome =
  { readonly kind: 'deleted' } | { readonly kind: 'not-found' };

/**
 * What {@link RuntimeProfileRepository.ensureWorkspaceDefault} did.
 *
 *   * `kept` — the workspace already had a default; it is returned unchanged and not replaced
 *     (only the caller's `replaceable` can let `adopted` or `created` replace it).
 *   * `adopted` — a profile with `input.name` and `input.driver` already existed and the caller's
 *     `adoptable` accepted it; it is now the default, and its other settings are left as they were
 *     (only `updatedAt` moves).
 *   * `created` — no such profile existed; it was inserted and made the default.
 *   * `name-conflict` — a profile named `input.name` exists with another driver. Nothing was
 *     written, and the workspace still has no default.
 *   * `not-adoptable` — a profile with `input.name` and `input.driver` exists, but the caller's
 *     `adoptable` refused it (`profile` is that profile, unchanged). Nothing was written, and the
 *     workspace still has no default.
 *
 * After `kept`, `adopted` and `created`, the default has also been attached, in the same
 * transaction, to the agents that should already carry it (see the module comment).
 */
export type EnsureWorkspaceDefaultRuntimeProfileOutcome =
  | { readonly kind: 'kept'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'adopted'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'created'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | { readonly kind: 'not-adoptable'; readonly profile: RuntimeProfileRecord };

/** How {@link RuntimeProfileRepository.ensureWorkspaceDefault} treats a profile that already exists. */
export interface EnsureWorkspaceDefaultOptions {
  /**
   * Whether an existing profile with the input's name and driver may become the default. The
   * repository does not know what a driver can enforce; the caller does.
   */
  readonly adoptable: (existing: RuntimeProfileRecord) => boolean;
  /**
   * Whether the current default, when it is not the input's profile, may be replaced by it. Unset,
   * a default is never replaced. When it answers `true` and the input's profile is created or
   * adopted, the old default loses the mark and every agent that carried it only because it was
   * the default (see `attachDefaultToUnprofiledAgents`) moves to the new one. The local runtime uses
   * it to swap its own `local` and `docker` profiles between sessions (#786).
   */
  readonly replaceable?: (currentDefault: RuntimeProfileRecord) => boolean;
}

/** Runtime-profile persistence for exactly one workspace. No method takes a workspace id. */
export interface RuntimeProfileRepository {
  /** Every profile in this workspace, oldest first, ties broken by id. */
  list(): Promise<readonly RuntimeProfileRecord[]>;
  get(id: string): Promise<RuntimeProfileRecord | null>;
  create(input: CreateRuntimeProfileInput): Promise<CreateRuntimeProfileOutcome>;
  update(id: string, patch: UpdateRuntimeProfilePatch): Promise<UpdateRuntimeProfileOutcome>;
  delete(id: string): Promise<DeleteRuntimeProfileOutcome>;
  /** This workspace's default runtime profile, or `null` when it has chosen none. */
  findWorkspaceDefault(): Promise<RuntimeProfileRecord | null>;
  /**
   * Make sure this workspace has a default runtime profile, in one transaction that first locks
   * the workspace row, so concurrent calls serialise and leave exactly one profile. See
   * {@link EnsureWorkspaceDefaultRuntimeProfileOutcome} for the answers. A `runtimeConnectionId`
   * that is not this workspace's is not an outcome here: the call rejects (ADR-0015).
   */
  ensureWorkspaceDefault(
    input: CreateRuntimeProfileInput,
    options: EnsureWorkspaceDefaultOptions,
  ): Promise<EnsureWorkspaceDefaultRuntimeProfileOutcome>;
}

export interface RuntimeProfileRepositoryProvider {
  forScope(scope: WorkspaceScope): RuntimeProfileRepository;
}
