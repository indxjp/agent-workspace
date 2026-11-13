import { isUuid } from '@indx-workspace/contracts';
import { StorageConnectionNameSchema } from '@indx-workspace/contracts/storage-connections';
import {
  ApiProblemError,
  type CreateStorageConnectionInput,
  type StorageConnectionCredential,
  type StorageConnectionResource,
  type StorageConnectionTestOutcome,
  type UpdateStorageConnectionPatch,
} from '@indx-workspace/sdk';

import { storageStrings, type StorageModelWords } from './storage-messages';

export type StorageProvider = StorageConnectionResource['provider'];

/** The model's sentences in English: the default for a caller that does not pass the reader's. */
const ENGLISH: StorageModelWords = storageStrings('en');
export type { StorageConnectionResource };

export const PROVIDER_OPTIONS: ReadonlyArray<{ value: StorageProvider; label: string }> = [
  { value: 's3', label: 'Amazon S3 or compatible' },
  { value: 'gcs', label: 'Google Cloud Storage' },
  { value: 'azblob', label: 'Azure Blob Storage' },
  { value: 'file', label: 'Local folder' },
];

export const URL_HINTS: Record<StorageProvider, string> = {
  s3: 's3://bucket/optional-prefix?endpoint=https://s3.example.com',
  gcs: 'gcs://bucket/optional-prefix',
  azblob: 'azblob://account/container/optional-prefix',
  file: 'file:///srv/storage/team-folder',
};

export interface CredentialFields {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly serviceAccountJson: string;
  readonly azureKind: 'accountKey' | 'sasToken';
  readonly azureSecret: string;
}

export const EMPTY_CREDENTIALS: CredentialFields = {
  accessKeyId: '',
  secretAccessKey: '',
  serviceAccountJson: '',
  azureKind: 'accountKey',
  azureSecret: '',
};

export interface ConnectionFormValues {
  readonly name: string;
  readonly provider: StorageProvider;
  readonly url: string;
  readonly folders: string;
  readonly writeAllowed: boolean;
  readonly credentials: CredentialFields;
}

/** One folder per line, without surrounding slashes: the stored grammar has none. */
function parseFolders(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^\/+|\/+$/gu, ''))
    .filter((line) => line !== '');
}

export function credentialFor(
  provider: StorageProvider,
  fields: CredentialFields,
): StorageConnectionCredential | undefined {
  switch (provider) {
    case 's3':
      return fields.accessKeyId === '' && fields.secretAccessKey === ''
        ? undefined
        : { provider, accessKeyId: fields.accessKeyId, secretAccessKey: fields.secretAccessKey };
    case 'gcs':
      return fields.serviceAccountJson === ''
        ? undefined
        : { provider, serviceAccountJson: fields.serviceAccountJson };
    case 'azblob':
      if (fields.azureSecret === '') return undefined;
      return fields.azureKind === 'accountKey'
        ? { provider, accountKey: fields.azureSecret }
        : { provider, sasToken: fields.azureSecret };
    case 'file':
      return undefined;
  }
}

/**
 * What is wrong with a connection name, before it is sent. The server's refusal is a generic
 * `invalid_storage_connection`, which the screen could only show as "could not be saved"
 * (UX-08 in #2086), so the form checks the same rule the contract does and names the problem.
 */
export function connectionNameProblem(
  name: string,
  words: StorageModelWords = ENGLISH,
): string | null {
  const trimmed = name.trim();
  if (!StorageConnectionNameSchema.safeParse(trimmed).success) return words.nameInvalid;
  return isUuid(trimmed) ? words.nameLooksLikeId : null;
}

/** S3 needs both halves of a key pair or neither; the server's refusal would not say which. */
export function credentialProblem(
  provider: StorageProvider,
  fields: CredentialFields,
  words: StorageModelWords = ENGLISH,
): string | null {
  return provider === 's3' && (fields.accessKeyId === '') !== (fields.secretAccessKey === '')
    ? words.keyPairHalf
    : null;
}

export function createConnectionInput(values: ConnectionFormValues): CreateStorageConnectionInput {
  const credential = credentialFor(values.provider, values.credentials);
  return {
    name: values.name.trim(),
    url: values.url.trim(),
    allowedPrefixes: parseFolders(values.folders),
    writeAllowed: values.writeAllowed,
    ...(credential === undefined ? {} : { credential }),
  };
}

export interface EditFormValues {
  readonly url: string;
  readonly folders: string;
  readonly writeAllowed: boolean;
}

export function editFormValues(connection: StorageConnectionResource): EditFormValues {
  return {
    url: connection.url,
    folders: connection.allowedPrefixes.join('\n'),
    writeAllowed: connection.writeAllowed,
  };
}

/** Only what differs from the stored connection, so an untouched field is never re-sent. */
export function updatePatch(
  connection: StorageConnectionResource,
  values: EditFormValues,
  credential: StorageConnectionCredential | undefined,
): UpdateStorageConnectionPatch {
  const url = values.url.trim();
  const folders = parseFolders(values.folders);
  const foldersChanged =
    folders.length !== connection.allowedPrefixes.length ||
    folders.some((folder, index) => folder !== connection.allowedPrefixes[index]);
  return {
    ...(url === connection.url ? {} : { url }),
    ...(foldersChanged ? { allowedPrefixes: folders } : {}),
    ...(values.writeAllowed === connection.writeAllowed
      ? {}
      : { writeAllowed: values.writeAllowed }),
    ...(credential === undefined ? {} : { credential }),
  };
}

/** A fixed sentence per API code: the server's own message is never shown. */
export function storageProblemMessage(
  error: unknown,
  fallback: string,
  words: StorageModelWords = ENGLISH,
): string {
  if (!(error instanceof ApiProblemError)) return fallback;
  if (Object.hasOwn(words.problems, error.code))
    return words.problems[error.code as keyof StorageModelWords['problems']];
  return error.status === 403 ? words.noAccess : fallback;
}

export function testOutcomeMessage(
  outcome: StorageConnectionTestOutcome,
  words: StorageModelWords = ENGLISH,
): string {
  if (outcome.ok) {
    // A bucket cannot tell a missing folder from an empty one, so this is a warning, not a failure.
    const empty = outcome.emptyFolders ?? [];
    return empty.length === 0 ? words.testOk : words.testOkEmpty(empty.join(', '));
  }
  switch (outcome.code) {
    case 'forbidden':
      return words.testForbidden;
    case 'not_found':
      return words.testNotFound;
    default:
      return words.testUnreachable;
  }
}

/** What "Save and test" shows once the new connection's test answers (UX-07 in #2086). */
export interface SavedTestResult {
  /** `ok`: it works. `warn`: it opened, but a folder looks wrong. `fail`: it did not open. */
  readonly level: 'ok' | 'warn' | 'fail';
  readonly message: string;
  /** What to do next when the test did not pass cleanly; `null` when nothing is needed. */
  readonly next: string | null;
}

/** The connection is saved either way; this says whether it works and what to fix if not. */
export function savedTestResult(
  outcome: StorageConnectionTestOutcome,
  words: StorageModelWords = ENGLISH,
): SavedTestResult {
  if (outcome.ok) {
    const empty = outcome.emptyFolders ?? [];
    return empty.length === 0
      ? { level: 'ok', message: words.savedConnected, next: null }
      : {
          level: 'warn',
          message: words.savedConnectedEmpty(empty.join(', ')),
          next: words.savedEmptyNext,
        };
  }
  const message = words.savedTestFailed(testOutcomeMessage(outcome, words));
  switch (outcome.code) {
    case 'forbidden':
      return { level: 'fail', message, next: words.savedForbiddenNext };
    case 'not_found':
      return { level: 'fail', message, next: words.savedNotFoundNext };
    default:
      return { level: 'fail', message, next: words.savedUnreachableNext };
  }
}

/** A test that could not run at all (refused, or the request failed); the connection is saved. */
export function savedTestFailure(
  error: unknown,
  words: StorageModelWords = ENGLISH,
): SavedTestResult {
  return {
    level: 'fail',
    message: words.savedNotTested(storageProblemMessage(error, words.couldNotTest, words)),
    next: words.savedNotTestedNext,
  };
}
