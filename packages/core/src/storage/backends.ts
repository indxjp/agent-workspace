/**
 * Emulator stores for tests outside this package (the storage design, §07 "Load test"): each
 * takes the emulator's endpoint and opens a new, empty container or bucket, so the caller needs no
 * Azure or Google Cloud dependency of its own. A deployment never imports this module: it opens a
 * store with `openObjectStore`, which loads one backend file. Importing this one loads the Azure
 * and Google Cloud libraries.
 */
export { createAzuriteObjectStore } from './azure-blob-store.js';
export { createFakeGcsObjectStore } from './gcs-store.js';
