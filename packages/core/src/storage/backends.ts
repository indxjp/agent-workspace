/**
 * Backend constructors for tests that wrap an emulator client by hand (the storage design, §07
 * "Load test"). A deployment never imports this module: it opens a store with `openObjectStore`,
 * which loads one backend file. Importing this one loads the Azure and Google Cloud libraries.
 */
export {
  createAzureBlobObjectStoreProvider,
  createAzureSdkBlobContainer,
} from './azure-blob-store.js';
export { createGcsObjectStoreProvider, createNativeGcsClient } from './gcs-store.js';
