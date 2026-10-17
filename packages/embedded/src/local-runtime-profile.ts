/**
 * S1-22 (issue #504, ADR-0109 and ADR-0101 as amended): the runtime profile the local runtime gives
 * its workspace before `aw dev` pushes anything.
 *
 * A version whose `runtimeProfileName` is `null` runs on the workspace's default runtime profile,
 * resolved when the version is applied. A fresh local workspace has no runtime profile at all, so
 * without this every agent `aw dev` pushes would be refused with `agent_runtime_profile_missing`.
 * The launcher therefore ensures one profile named `local`, on the `local` driver, and makes it the
 * workspace default unless the workspace already has one — a default someone chose is never
 * replaced. Core then attaches the default to every agent applied while the workspace had none.
 *
 * The profile this module creates asks the in-process runner for nothing it cannot enforce: every
 * optional constraint is `null`, the network is `open` and the filesystem `read-write`, so it passes
 * `localRuntimeRunSpecRejection`. An existing `local` profile on the `local` driver is adopted as
 * the default only when it passes that rule too ({@link localRunnerUnenforceable}); one that asks
 * for more is left alone and reported as `unenforceable`, because every run on it would be accepted
 * and then fail while it is prepared.
 *
 * Under `aw dev --sandbox docker` (#786) the launcher ensures the `docker` profile instead and makes
 * it the default for the session: it replaces the launcher's own `local` default, and the agents that
 * carried that one as the default move with it, so no run of the session reaches the in-process
 * runner. A later session on `local` swaps them back. A default someone else chose is still never
 * replaced; the launcher refuses a docker session over it instead.
 *
 * Only types are imported from core: the launcher hands in the database root it already opened.
 */
import type {
  CreateRuntimeProfileInput,
  DatabaseRoot,
  RuntimeProfileRecord,
} from '@agent-workspace/core/db';

/** The profile the local runtime ensures and makes the workspace default. */
export const LOCAL_RUNTIME_PROFILE = {
  name: 'local',
  driver: 'local',
  runtimeConnectionId: null,
  cpu: null,
  memoryMb: null,
  diskMb: null,
  networkPolicy: 'open',
  allowedDomains: null,
  filesystem: 'read-write',
  persistPaths: null,
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  driverConfig: null,
} as const satisfies CreateRuntimeProfileInput;

/**
 * The profile `aw dev --sandbox docker` ensures and makes the workspace default (#786). The docker
 * driver mounts `/workspace` as a tmpfs of `diskMb` and sets `--memory` to the memory budget plus
 * that workspace (#808). The network is `open`: without an egress proxy the docker driver refuses
 * `restricted`.
 */
export const DOCKER_RUNTIME_PROFILE = {
  ...LOCAL_RUNTIME_PROFILE,
  name: 'docker',
  driver: 'docker',
  // The docker driver's own default workspace size (`DOCKER_DEFAULT_WORKSPACE_MB`), spelled out so
  // the launcher's entry does not load the runtime package.
  diskMb: 1_024,
} as const satisfies CreateRuntimeProfileInput;

/** The drivers the local runtime prepares a default profile for. */
export type LocalRuntimeProfileDriver = 'local' | 'docker';

/** What the preparation needs from the database root. */
export type LocalRuntimeProfileRoot = Pick<DatabaseRoot, 'scopes' | 'runtimeProfiles'>;

/** What {@link prepareLocalRuntimeProfile} answered. */
export type LocalRuntimeProfileOutcome =
  | { readonly kind: 'kept' | 'adopted' | 'created'; readonly profile: RuntimeProfileRecord }
  | { readonly kind: 'name-conflict'; readonly name: string }
  | {
      readonly kind: 'unenforceable';
      readonly name: string;
      /** The settings the in-process runner cannot enforce, e.g. `networkPolicy=restricted`. */
      readonly settings: readonly string[];
    };

/** The workspace the launcher seeded is not there to scope by. */
export class LocalRuntimeProfileWorkspaceMissingError extends Error {
  constructor() {
    super('the seeded workspace could not be found to prepare its runtime profile');
    this.name = 'LocalRuntimeProfileWorkspaceMissingError';
  }
}

/** The stored settings {@link localRunnerUnenforceable} reads. */
type EnforcedSettings = Pick<
  RuntimeProfileRecord,
  'cpu' | 'memoryMb' | 'diskMb' | 'networkPolicy' | 'allowedDomains' | 'filesystem' | 'driverConfig'
>;

/**
 * The settings of `profile` the in-process runner cannot enforce; empty when it can run on it.
 *
 * The same rule as the web runtime's `localRuntimeRunSpecRejection`
 * (`apps/web/server/compose/runtime-profile.ts`), read from the stored profile instead of the run
 * spec built from it (a `null` there is an absent key in the spec). The launcher cannot import the
 * web server's composition, so the rule is restated here, with that function's setting names.
 */
export function localRunnerUnenforceable(profile: EnforcedSettings): readonly string[] {
  const unsupported: string[] = [];
  if (profile.cpu !== null) unsupported.push('cpu');
  if (profile.memoryMb !== null) unsupported.push('memoryMb');
  if (profile.diskMb !== null) unsupported.push('diskMb');
  if (profile.networkPolicy !== 'open') unsupported.push(`networkPolicy=${profile.networkPolicy}`);
  if (profile.allowedDomains !== null && profile.allowedDomains.length > 0) {
    unsupported.push('allowedDomains');
  }
  if (profile.filesystem !== 'read-write') unsupported.push(`filesystem=${profile.filesystem}`);
  if (profile.driverConfig !== null && Object.keys(profile.driverConfig).length > 0) {
    unsupported.push('driverConfig');
  }
  return unsupported;
}

/** The settings of `profile` the docker driver refuses; empty when it can run on it. */
export function dockerRunnerUnenforceable(profile: EnforcedSettings): readonly string[] {
  const unsupported: string[] = [];
  if (profile.networkPolicy === 'restricted') unsupported.push('networkPolicy=restricted');
  if (profile.allowedDomains !== null && profile.allowedDomains.length > 0) {
    unsupported.push('allowedDomains');
  }
  return unsupported;
}

const PREPARED: Readonly<
  Record<
    LocalRuntimeProfileDriver,
    {
      readonly profile: CreateRuntimeProfileInput;
      readonly other: CreateRuntimeProfileInput;
      readonly unenforceable: (profile: EnforcedSettings) => readonly string[];
    }
  >
> = {
  local: {
    profile: LOCAL_RUNTIME_PROFILE,
    other: DOCKER_RUNTIME_PROFILE,
    unenforceable: localRunnerUnenforceable,
  },
  docker: {
    profile: DOCKER_RUNTIME_PROFILE,
    other: LOCAL_RUNTIME_PROFILE,
    unenforceable: dockerRunnerUnenforceable,
  },
};

/**
 * Ensure the `driver`'s runtime profile (`local` by default) in `workspaceId` and make it the
 * default when the workspace has none, or when its default is the launcher's profile for the other
 * driver. Answers `kept` (a default already existed and was left alone), `adopted` (a `local`
 * profile on the `local` driver that the runner can enforce existed and became the default),
 * `created`, `name-conflict` (a profile named `local` uses another driver), or `unenforceable` (a
 * `local` profile on the `local` driver asks for settings the runner cannot enforce). The last two
 * write nothing.
 */
export async function prepareLocalRuntimeProfile(
  workspaceId: string,
  root: LocalRuntimeProfileRoot,
  driver: LocalRuntimeProfileDriver = 'local',
): Promise<LocalRuntimeProfileOutcome> {
  const scope = await root.scopes.forWorkspaceId(workspaceId);
  if (scope === null) throw new LocalRuntimeProfileWorkspaceMissingError();
  const { profile, other, unenforceable } = PREPARED[driver];
  const outcome = await root.runtimeProfiles.forScope(scope).ensureWorkspaceDefault(profile, {
    adoptable: (existing) => unenforceable(existing).length === 0,
    replaceable: (current) => current.name === other.name && current.driver === other.driver,
  });
  if (outcome.kind !== 'not-adoptable') return outcome;
  return {
    kind: 'unenforceable',
    name: outcome.profile.name,
    settings: unenforceable(outcome.profile),
  };
}
