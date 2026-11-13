/** `/api/skills*` over its own private object-store root (spec §7, W2-CP-04). */
import { log } from '../telemetry/logger';
import type { Skills } from '../skills/runtime';
import type { StorageService } from '../storage/service';
import { startSkillsAdopt } from './storage-jobs';
import { describePlace, logAreaNotOpened, openArea, storageReadinessFailure } from './storage-open';
import type { ApiWiring, SkillsAdoptWiring } from './storage';

/**
 * Build `/api/skills*` (spec §7, W2-CP-04) over its own private object-store root, for the root to
 * install as `ApplicationContext.skills`. Every refusal is logged by name and answers `unavailable`.
 */
export async function installSkillsApi(
  { resolveWorkspace, scopes, catalog }: ApiWiring,
  storage?: StorageService,
  adopt?: SkillsAdoptWiring,
): Promise<Skills> {
  const selection = await openArea('skills');
  if (selection.kind !== 'opened') {
    logAreaNotOpened('skills', selection);
    return { kind: 'unavailable' };
  }
  try {
    const { createRepositorySkillsStoreProvider } = await import('../storage/store');
    const runtime = {
      resolveWorkspace,
      store: createRepositorySkillsStoreProvider({ store: selection.store, scopes }),
      catalog,
      ...(storage === undefined ? {} : { storage }),
    };
    log.info(`[compose] skills API installed: ${describePlace(selection.location, 'skills')}`);
    if (storage !== undefined && adopt !== undefined) {
      void startSkillsAdopt(runtime.store, catalog, storage, adopt);
    }
    return { kind: 'serving', runtime };
  } catch (error) {
    log.error(storageReadinessFailure('skills', error));
    return { kind: 'unavailable' };
  }
}
