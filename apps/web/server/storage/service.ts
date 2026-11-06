import { createStorageOperations } from './service-operations';
import type { StorageDependencies, StorageService } from './service-contract';
export type {
  StorageAuditEvent,
  StorageContext,
  SaveInput,
  SaveResult,
  StorageService,
  SessionStateBlobCatalog,
} from './service-contract';
import { serviceSignedUploads } from './service-signed-uploads';
import { serviceSave } from './service-save';
import { serviceSessionState } from './service-session-state';
import { serviceCatalog } from './service-catalog';
import { serviceDownloads } from './service-downloads';
export function createStorageService(deps: StorageDependencies): StorageService {
  const operations = createStorageOperations(deps);
  const group0 = serviceSignedUploads(operations);
  const group1 = serviceSave(operations);
  const group2 = serviceSessionState(operations);
  const group3 = serviceCatalog(operations);
  const group4 = serviceDownloads(operations);
  return {
    reserveUpload: group0.reserveUpload,
    completeUpload: group0.completeUpload,
    save: group1.save,
    stage: group1.stage,
    unstage: group1.unstage,
    createFolder: group3.createFolder,
    list: group3.list,
    get: group3.get,
    saveSessionState: group2.saveSessionState,
    discardSessionState: group2.discardSessionState,
    open: group4.open,
    signDownload: group4.signDownload,
    rename: group3.rename,
    remove: group3.remove,
  };
}
