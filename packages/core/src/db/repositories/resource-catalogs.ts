import type { Database } from '../client.js';
import { requireWorkspaceScope } from './scope.js';
import { renameCount } from './resource-catalogs-model.js';
import type {
  ResourceCatalogRepository,
  ResourceCatalogRepositoryProvider,
} from './resource-catalogs-port.js';
import type { CatalogContext } from './resource-catalogs-sql.js';
import {
  confirmFile,
  forgetFile,
  moveUnder,
  removeFiles,
} from './resource-catalogs-file-writes.js';
import {
  countPendingFiles,
  deletingFiles,
  getFile,
  listFiles,
  pendingFile,
  referencingFiles,
  stalePendingFiles,
} from './resource-catalogs-file-reads.js';
import { createFolder, reserveFile } from './resource-catalogs-reserve.js';
import {
  backfillSkillPendingDelete,
  createSkill,
  deleteSkill,
  getSkill,
  listSkillRevisions,
  listSkills,
  markSkillDeleting,
  publishSkillRevision,
  putSkill,
  setSkillBuiltinDigest,
  setSkillMeta,
} from './resource-catalogs-skills.js';

export {
  CatalogPathPendingError,
  CatalogPathTakenError,
  clampCatalogPageLimit,
  parsePendingSkillDelete,
  pendingDeleteFor,
  renameCount,
  renamedKey,
  sameReservation,
  SKILL_PUBLISH_POLL_MS,
  STALE_SKILL_REVISION_MS,
  type CatalogFile,
  type CatalogSkill,
  type CatalogSkillRevision,
  type ConfirmOutcome,
  type DeleteCatalogSkillOutcome,
  type MarkSkillDeletingOutcome,
  type PendingSkillDelete,
  type ReserveOutcome,
} from './resource-catalogs-model.js';
export {
  listCatalogFiles,
  type CatalogPort,
  type ResourceCatalogRepository,
  type ResourceCatalogRepositoryProvider,
} from './resource-catalogs-port.js';

export function createDatabaseResourceCatalogRepositoryProvider(
  db: Database,
): ResourceCatalogRepositoryProvider {
  return {
    forScope(scope) {
      const { workspaceId } = requireWorkspaceScope(scope, 'ResourceCatalogRepositoryProvider');
      return repositoryFor({ db, workspaceId });
    },
  };
}

function repositoryFor(context: CatalogContext): ResourceCatalogRepository {
  return {
    reserve: (path, input) => reserveFile(context, path, input),
    createFolder: (path, input) => createFolder(context, path, input),
    confirm: (row, input) => confirmFile(context, row, input),
    get: (path, options) => getFile(context, path, options),
    list: (folder, page) => listFiles(context, folder, page),
    countPending: (newerThan) => countPendingFiles(context, newerThan),
    pending: (path) => pendingFile(context, path),
    rename: async (from, to) => renameCount(await moveUnder(context, from, to)),
    remove: (path, options) => removeFiles(context, path, options),
    stalePending: (olderThan) => stalePendingFiles(context, olderThan),
    deleting: () => deletingFiles(context),
    forget: (row) => forgetFile(context, row),
    referencing: ({ objectIds }) => referencingFiles(context, objectIds),
    listSkills: () => listSkills(context),
    getSkill: (name) => getSkill(context, name),
    putSkill: (input) => putSkill(context, input),
    createSkill: (input) => createSkill(context, input),
    deleteSkill: (name, onlyId) => deleteSkill(context, name, onlyId),
    markSkillDeleting: (name) => markSkillDeleting(context, name),
    backfillSkillPendingDelete: (name, pending) =>
      backfillSkillPendingDelete(context, name, pending),
    setSkillMeta: (name, meta, onlyIfEmpty = false) =>
      setSkillMeta(context, name, meta, onlyIfEmpty),
    setSkillBuiltinDigest: (name, digest) => setSkillBuiltinDigest(context, name, digest),
    publishSkillRevision: (name, input) => publishSkillRevision(context, name, input),
    listSkillRevisions: (name, options) => listSkillRevisions(context, name, options),
  };
}
