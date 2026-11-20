/**
 * The two things a demo workspace needs before an agent is copied into it: the sandbox profile the
 * agent runs in (no internet) and the `default` model connection holding the demo key. Both are
 * found by name when an earlier copy made them, so copying is safe to repeat.
 */
import type { ModelsStoreProvider } from '../../integrations';
import type { RuntimeProfileStoreProvider } from '../../execution';
import type { DemoSandbox } from './ports';
import type { Visitor } from './template-copy-types';

/** The name of the demo workspace's runtime profile. */
export const DEMO_RUNTIME_PROFILE_NAME = 'demo-sandbox';
/** The model connection every run without one of its own resolves to (contract C7). */
export const DEMO_MODEL_CONNECTION_NAME = 'default';

type RuntimeDriverName = NonNullable<DemoSandbox['runtimeDriver']>;

export interface SandboxSetupDependencies {
  /** The runtimes domain: the visitor workspace's sandbox profile is made through it. */
  readonly runtimeProfiles: Pick<RuntimeProfileStoreProvider, 'forWorkspace'>;
  /** The models domain: the visitor workspace's `default` connection is made through it. */
  readonly models: Pick<ModelsStoreProvider, 'forWorkspace'>;
  /** What the demo runs on: the deployment's runtime driver and Anthropic API key. */
  readonly sandbox: DemoSandbox;
}

type ProfileStore = ReturnType<RuntimeProfileStoreProvider['forWorkspace']>;

/** The one profile a demo may have: network policy `none`, no allowed domain. */
function sandboxProfileDefinition(driver: RuntimeDriverName) {
  return {
    name: DEMO_RUNTIME_PROFILE_NAME,
    driver,
    runtimeConnectionId: null,
    cpu: null,
    memoryMb: null,
    diskMb: null,
    networkPolicy: 'none' as const,
    allowedDomains: null,
    filesystem: 'read-write' as const,
    persistPaths: null,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    driverConfig: null,
  };
}

type SandboxProfileDefinition = ReturnType<typeof sandboxProfileDefinition>;

async function findProfileByName(store: ProfileStore) {
  return (await store.list()).find((profile) => profile.name === DEMO_RUNTIME_PROFILE_NAME);
}

/** Set an earlier copy's profile back to the definition if it drifted from it. */
async function resetProfileIfChanged(
  store: ProfileStore,
  present: NonNullable<Awaited<ReturnType<typeof findProfileByName>>>,
  definition: SandboxProfileDefinition,
): Promise<void> {
  const same =
    present.driver === definition.driver &&
    present.networkPolicy === 'none' &&
    present.allowedDomains === null;
  if (same) return;
  const updated = await store.update(present.id, definition);
  if (updated.kind !== 'updated') throw new Error('the demo sandbox profile was not reset');
}

/**
 * The visitor workspace's one sandbox profile: on the deployment's driver, network policy `none`,
 * no allowed domain. Found by name when an earlier copy made it, and set back to this definition
 * if it is not (a profile that is not `none` is never left to a demo). `null` without a driver,
 * or on a driver that cannot enforce `none`.
 */
export async function ensureSandboxProfile(
  deps: SandboxSetupDependencies,
  visitor: Visitor,
): Promise<string | null> {
  const { runtimeDriver } = deps.sandbox;
  if (runtimeDriver === null) return null;
  if (!(await deps.sandbox.enforcesNoNetwork(runtimeDriver))) return null;
  const store = deps.runtimeProfiles.forWorkspace(visitor.workspaceId);
  const definition = sandboxProfileDefinition(runtimeDriver);
  const present = await findProfileByName(store);
  if (present !== undefined) {
    await resetProfileIfChanged(store, present, definition);
    return present.id;
  }
  const made = await store.create(definition);
  if (made.kind === 'created') return made.profile.id;
  // A name taken by a copy running at the same time is that copy's profile.
  const raced = await findProfileByName(store);
  if (raced === undefined) throw new Error(`the demo sandbox profile was not made: ${made.kind}`);
  return raced.id;
}

/**
 * The visitor workspace's `default` model connection holding the demo key, made through the models
 * domain (which seals the key; nothing here keeps it). `true` when the workspace has one.
 */
export async function ensureModelConnection(
  deps: SandboxSetupDependencies,
  visitor: Visitor,
): Promise<boolean> {
  const { anthropicApiKey } = deps.sandbox;
  if (anthropicApiKey === null) return false;
  const store = deps.models.forWorkspace(visitor.workspaceId);
  const has = async () =>
    (await store.list()).some((connection) => connection.name === DEMO_MODEL_CONNECTION_NAME);
  if (await has()) return true;
  const made = await store.create({
    name: DEMO_MODEL_CONNECTION_NAME,
    provider: 'anthropic',
    apiKey: anthropicApiKey,
    config: {},
  });
  // A name taken by a copy running at the same time is that copy's connection.
  if (made.kind !== 'created' && !(await has())) {
    throw new Error(`the demo model connection was not made: ${made.kind}`);
  }
  return true;
}
