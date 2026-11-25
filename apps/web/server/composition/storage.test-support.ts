import type { DatabaseRoot } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  type ObjectStore,
  type ObjectStoreProvider,
  type OpenObjectStoreOptions,
  type StorageArea,
} from '@agent-workspace/core/storage';
import type { StorageLocation } from '@indx-workspace/contracts/storage-url';
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
import type { WorkspaceResolution } from '../files/wiring';
import type { ResourceCatalogStoreProvider } from '../storage/store';
import { createStorageService } from '../storage/service';
import { log as webLogger } from '../telemetry/logger';
import { installFilesApi, installSkillsApi } from './storage';

/** The injected object-store openers the tests mock `@agent-workspace/core/storage` with. */
export const injected = {
  open: vi.fn<
    (
      location: StorageLocation,
      area: StorageArea,
      options?: OpenObjectStoreOptions,
    ) => Promise<ObjectStoreProvider>
  >(),
  openRoot:
    vi.fn<(location: StorageLocation, options?: OpenObjectStoreOptions) => Promise<ObjectStore>>(),
};

const scopes: DatabaseRoot['scopes'] = {
  forWorkspaceId: () => Promise.resolve(null),
  forWorkspaceSlug: () => Promise.resolve(null),
};
export const catalog: ResourceCatalogStoreProvider = {
  forWorkspace: () => Promise.reject(new Error('the composition test never reads the catalog')),
};
export const fileTexts: DatabaseRoot['fileTexts'] = {
  forScope: () => {
    throw new Error('the composition test never reads file texts');
  },
};
const resolveWorkspace = (): Promise<WorkspaceResolution> =>
  Promise.resolve({ kind: 'unauthenticated', reason: 'composition test' });

/** The dependencies both storage APIs are installed with. */
export const deps = { resolveWorkspace, scopes, catalog };

export const installFiles = () => installFilesApi(deps, fileTexts);
export const installSkills = () => installSkillsApi(deps);

const STORAGE_ENVIRONMENT = [
  'AW_STORAGE_URL',
  'AW_FILE_STORAGE_ROOT',
  'AW_SKILL_STORAGE_ROOT',
  'AW_SESSION_TRANSCRIPT_ROOT',
  'OBJECT_STORAGE_BACKEND',
  'OBJECT_STORAGE_BUCKET',
  'OBJECT_STORAGE_ENDPOINT',
  'OBJECT_STORAGE_PUBLIC_ENDPOINT',
  'OBJECT_STORAGE_FORCE_PATH_STYLE',
  'AW_STORAGE_CREATE_BUCKET',
];

export function clearStorageEnvironment(): void {
  for (const name of STORAGE_ENVIRONMENT) vi.stubEnv(name, '');
}

export function setStorageUrl(url = 'file:///srv/aw'): void {
  clearStorageEnvironment();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
  vi.stubEnv('AWS_SESSION_TOKEN', '');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AZURE_CLIENT_ID', '11111111-1111-1111-1111-111111111111');
  vi.stubEnv('AW_STORAGE_URL', url);
}

/** An s3:// root on a bundled S3-compatible endpoint, with a key pair and no session token. */
export function useS3Root(): void {
  clearStorageEnvironment();
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'access-key');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret-key');
  vi.stubEnv('AWS_REGION', 'eu-west-1');
  vi.stubEnv('AW_STORAGE_URL', 's3://aw-bucket/p?endpoint=http://seaweedfs.example.test:8333');
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

/** A storage service on an in-memory store whose catalog is never opened. */
export function createUnusedStorageService() {
  return createStorageService({
    catalog: () => Promise.reject(new Error('unused')),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
}

/**
 * Registers the per-test mocks and returns accessors for the web logger spies, which are only
 * set once `beforeEach` has run.
 */
export function useStorageTestHooks(): {
  info: () => MockInstance<typeof webLogger.info>;
  error: () => MockInstance<typeof webLogger.error>;
} {
  let logInfo: MockInstance<typeof webLogger.info>;
  let logError: MockInstance<typeof webLogger.error>;

  beforeEach(() => {
    injected.open.mockResolvedValue(createInMemoryObjectStoreProvider());
    injected.openRoot.mockResolvedValue(createInMemoryObjectStore());
    logInfo = vi.spyOn(webLogger, 'info').mockImplementation(() => undefined);
    vi.spyOn(webLogger, 'warn').mockImplementation(() => undefined);
    logError = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  return { info: () => logInfo, error: () => logError };
}
