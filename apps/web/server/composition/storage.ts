import type { DatabaseRoot } from '@agent-workspace/core/db';
import type { WorkspaceResolution } from '../agents/runtime';
import type { ObjectStoreProvider } from '../files/object-store-bridge';
import { configureFilesRuntime } from '../files/runtime';
import { createResourceCatalogStoreProvider } from '../resources/catalog-store';
import { configureSkillsRuntime } from '../skills/runtime';
import {
  configuredPath,
  FILE_STORAGE_ROOT_ENV,
  configuredObjectStorageBackend,
  OBJECT_STORAGE_BUCKET_ENV,
  SESSION_STATE_STORAGE_ROOT_ENV,
  SKILL_STORAGE_ROOT_ENV,
  storageRootsOverlap,
} from './config';

type ObjectStoreBridge = Pick<
  typeof import('../files/object-store-bridge'),
  | 'createAzureBlobObjectStoreProviderFromConfig'
  | 'createGcsObjectStoreProviderFromConfig'
  | 'createS3ObjectStoreProviderFromConfig'
>;
type BucketBackend = NonNullable<ReturnType<typeof configuredObjectStorageBackend>>;

const OBJECT_STORAGE_READINESS_TIMEOUT_MS = 10_000;

/** Keep provider URLs and credential-bearing messages out of deployment logs. */
export function storageReadinessFailure(
  resource: 'files' | 'skills' | 'session-state',
  cause: unknown,
): string {
  const errorName = safeProviderErrorName(cause);
  const statusCode = safeProviderStatusCode(cause);
  return `[compose] ${resource} API NOT installed: object storage failed readiness (name=${errorName}, status=${statusCode}).`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function safeProviderErrorName(cause: unknown): string {
  if (!isRecord(cause)) return 'UnknownProviderError';
  const name = cause['name'];
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
    ? name
    : 'UnknownProviderError';
}

function safeProviderStatusCode(cause: unknown): string {
  if (!isRecord(cause)) return 'unknown';
  const metadata = cause['$metadata'];
  if (!isRecord(metadata)) return 'unknown';
  const statusCode = metadata['httpStatusCode'];
  return typeof statusCode === 'number' &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
    ? String(statusCode)
    : 'unknown';
}

async function resolveBucketStore(
  bridge: ObjectStoreBridge,
  backend: BucketBackend,
  bucket: string,
  keyPrefix: 'files' | 'skills' | 'session-state',
  explicitBackend: boolean,
): Promise<ObjectStoreProvider> {
  if (backend === 'azure-blob') {
    const serviceUrl = configuredPath('OBJECT_STORAGE_ENDPOINT');
    const managedIdentityClientId = configuredPath('AZURE_CLIENT_ID');
    if (serviceUrl === null) {
      throw new Error('OBJECT_STORAGE_ENDPOINT is required for object backend azure-blob.');
    }
    return bridge.createAzureBlobObjectStoreProviderFromConfig({
      serviceUrl,
      container: bucket,
      ...(managedIdentityClientId === null ? {} : { managedIdentityClientId }),
      keyPrefix,
    });
  }
  if (backend === 'gcs') {
    const projectId = configuredPath('GCP_PROJECT');
    return bridge.createGcsObjectStoreProviderFromConfig({
      bucket,
      keyPrefix,
      timeoutMs: OBJECT_STORAGE_READINESS_TIMEOUT_MS,
      ...(projectId === null ? {} : { projectId }),
    });
  }
  if (backend === 's3') {
    const endpoint = configuredPath('OBJECT_STORAGE_ENDPOINT');
    const accessKeyId = configuredPath('AWS_ACCESS_KEY_ID');
    const secretAccessKey = configuredPath('AWS_SECRET_ACCESS_KEY');
    return bridge.createS3ObjectStoreProviderFromConfig({
      bucket,
      region: configuredPath('AWS_REGION') ?? 'us-east-1',
      ...(endpoint === null ? {} : { endpoint }),
      ...(accessKeyId === null ? {} : { accessKeyId }),
      ...(secretAccessKey === null ? {} : { secretAccessKey }),
      forcePathStyle: process.env['OBJECT_STORAGE_FORCE_PATH_STYLE'] === 'true',
      createBucketIfMissing: !explicitBackend && endpoint !== null,
      keyPrefix,
    });
  }
  throw new Error('Unsupported object storage backend.');
}

export async function installFilesApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  scopes: DatabaseRoot['scopes'],
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
): Promise<void> {
  const bucket = configuredPath(OBJECT_STORAGE_BUCKET_ENV);
  let explicitBackend: ReturnType<typeof configuredObjectStorageBackend>;
  try {
    explicitBackend = configuredObjectStorageBackend();
  } catch (error) {
    console.error(
      `[compose] files API NOT installed: ${error instanceof Error ? error.message : 'invalid object storage backend'}`,
    );
    return;
  }
  if (bucket === null && explicitBackend !== null) {
    console.error(
      `[compose] files API NOT installed: ${OBJECT_STORAGE_BUCKET_ENV} is required when OBJECT_STORAGE_BACKEND is set.`,
    );
    return;
  }
  if (bucket !== null) {
    try {
      const bridge = await import('../files/object-store-bridge');
      const { createRepositoryObjectStoreProvider } = await import('../files/store');
      const backend = explicitBackend ?? 's3';
      const store = await resolveBucketStore(
        bridge,
        backend,
        bucket,
        'files',
        explicitBackend !== null,
      );
      configureFilesRuntime({
        resolveWorkspace,
        store: createRepositoryObjectStoreProvider({ store, scopes }),
        catalog,
      });
      console.log(`[compose] files API installed: ${backend} bucket ${bucket}, prefix files/`);
      return;
    } catch (error) {
      console.error(storageReadinessFailure('files', error));
      return;
    }
  }
  const root = configuredPath(FILE_STORAGE_ROOT_ENV);
  if (root === null) {
    console.error(
      `[compose] files API NOT installed: ${FILE_STORAGE_ROOT_ENV} is unset or blank, and this ` +
        `deployment will not invent a directory to keep a workspace's files in. Every ` +
        `/api/files* route answers 503 files_runtime_not_configured.`,
    );
    return;
  }
  const bridge = await import('../files/object-store-bridge');
  const { createRepositoryObjectStoreProvider } = await import('../files/store');
  configureFilesRuntime({
    resolveWorkspace,
    catalog,
    store: createRepositoryObjectStoreProvider({
      store: bridge.createLocalFilesystemObjectStoreProvider(root),
      scopes,
    }),
  });
  console.log(
    `[compose] files API installed: local filesystem object store rooted at ${root} (spec §16)`,
  );
}

/** Install `/api/skills*` (spec §7, W2-CP-04) over its own private object-store root. */
export async function installSkillsApi(
  resolveWorkspace: (request: Request) => Promise<WorkspaceResolution>,
  scopes: DatabaseRoot['scopes'],
  catalog: ReturnType<typeof createResourceCatalogStoreProvider>,
): Promise<void> {
  const bucket = configuredPath(OBJECT_STORAGE_BUCKET_ENV);
  let explicitBackend: ReturnType<typeof configuredObjectStorageBackend>;
  try {
    explicitBackend = configuredObjectStorageBackend();
  } catch (error) {
    console.error(
      `[compose] skills API NOT installed: ${error instanceof Error ? error.message : 'invalid object storage backend'}`,
    );
    return;
  }
  if (bucket === null && explicitBackend !== null) {
    console.error(
      `[compose] skills API NOT installed: ${OBJECT_STORAGE_BUCKET_ENV} is required when OBJECT_STORAGE_BACKEND is set.`,
    );
    return;
  }
  if (bucket !== null) {
    try {
      const bridge = await import('../skills/object-store-bridge');
      const { createRepositorySkillsStoreProvider } = await import('../skills/store');
      const backend = explicitBackend ?? 's3';
      const store = await resolveBucketStore(
        bridge,
        backend,
        bucket,
        'skills',
        explicitBackend !== null,
      );
      configureSkillsRuntime({
        resolveWorkspace,
        store: createRepositorySkillsStoreProvider({ store, scopes }),
        catalog,
      });
      console.log(`[compose] skills API installed: ${backend} bucket ${bucket}, prefix skills/`);
      return;
    } catch (error) {
      console.error(storageReadinessFailure('skills', error));
      return;
    }
  }
  const root = configuredPath(SKILL_STORAGE_ROOT_ENV);
  if (root === null) {
    console.error(
      `[compose] skills API NOT installed: ${SKILL_STORAGE_ROOT_ENV} is unset or blank. ` +
        `It must name a directory distinct from ${FILE_STORAGE_ROOT_ENV}; every /api/skills* ` +
        `route answers 503 skills_runtime_not_configured.`,
    );
    return;
  }

  const filesRoot = configuredPath(FILE_STORAGE_ROOT_ENV);
  if (filesRoot !== null && (await storageRootsOverlap(filesRoot, root))) {
    console.error(
      `[compose] skills API NOT installed: ${SKILL_STORAGE_ROOT_ENV} and ` +
        `${FILE_STORAGE_ROOT_ENV} must be non-overlapping directories. Sharing or nesting ` +
        `them would let /api/files address private skills platform state.`,
    );
    return;
  }

  const bridge = await import('../skills/object-store-bridge');
  const { createRepositorySkillsStoreProvider } = await import('../skills/store');
  configureSkillsRuntime({
    resolveWorkspace,
    catalog,
    store: createRepositorySkillsStoreProvider({
      store: bridge.createLocalFilesystemObjectStoreProvider(root),
      scopes,
    }),
  });
  console.log(
    `[compose] skills API installed: private local filesystem object store rooted at ${root}`,
  );
}

/**
 * The object store session-state **blobs** are written to, or `null` when this deployment has none.
 *
 * Its own prefix and its own root, never the files or skills store: a session-state blob is platform
 * bookkeeping about a conversation, and putting it inside `/api/files`' address space would make an
 * engine's internal state something a tenant can list, download and delete.
 *
 * `null` is a real answer, not a failure. Every *entry* is a database row and stays durable without
 * this, so a deployment with no object storage keeps working for every engine that has one — and the
 * two blob routes answer 503 naming the variable rather than pretending to have stored something
 * (ADR-0035).
 */
export async function sessionStateBlobStore(): Promise<ObjectStoreProvider | null> {
  const bucket = configuredPath(OBJECT_STORAGE_BUCKET_ENV);
  let explicitBackend: ReturnType<typeof configuredObjectStorageBackend>;
  try {
    explicitBackend = configuredObjectStorageBackend();
  } catch (error) {
    console.error(
      `[compose] session-state blobs NOT installed: ${error instanceof Error ? error.message : 'invalid object storage backend'}`,
    );
    return null;
  }
  if (bucket !== null) {
    try {
      const bridge = await import('../files/object-store-bridge');
      const backend = explicitBackend ?? 's3';
      const store = await resolveBucketStore(
        bridge,
        backend,
        bucket,
        'session-state',
        explicitBackend !== null,
      );
      console.log(
        `[compose] session-state blobs installed: ${backend} bucket ${bucket}, prefix session-state/`,
      );
      return store;
    } catch (error) {
      console.error(storageReadinessFailure('session-state', error));
      return null;
    }
  }
  const root = configuredPath(SESSION_STATE_STORAGE_ROOT_ENV);
  if (root === null) {
    console.error(
      `[compose] session-state blobs NOT installed: ${SESSION_STATE_STORAGE_ROOT_ENV} is unset or ` +
        `blank. Stream entries stay durable — they are database rows — and PUT/GET ` +
        `/api/sessions/:id/state-blobs answer 503 session_state_blobs_not_configured.`,
    );
    return null;
  }
  const bridge = await import('../files/object-store-bridge');
  console.log(
    `[compose] session-state blobs installed: local filesystem object store rooted at ${root}`,
  );
  return bridge.createLocalFilesystemObjectStoreProvider(root);
}
