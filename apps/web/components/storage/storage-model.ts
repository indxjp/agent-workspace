import {
  ApiProblemError,
  type CreateStorageConnectionInput,
  type StorageConnectionCredential,
  type StorageConnectionResource,
  type UpdateStorageConnectionPatch,
} from '@indx-workspace/sdk';

export type StorageProvider = StorageConnectionResource['provider'];
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

/** S3 needs both halves of a key pair or neither; the server's refusal would not say which. */
export function credentialProblem(
  provider: StorageProvider,
  fields: CredentialFields,
): string | null {
  return provider === 's3' && (fields.accessKeyId === '') !== (fields.secretAccessKey === '')
    ? 'Fill both the access key ID and the secret access key, or leave both empty.'
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

const PROBLEM_MESSAGES: Readonly<Record<string, string>> = {
  storage_connection_url_invalid: 'That is not a valid storage URL for the chosen provider.',
  storage_connection_url_has_secret:
    'The URL must not carry a password, key or signed parameter. Use the credential fields instead.',
  storage_connection_endpoint_forbidden:
    'This deployment does not allow that endpoint or folder. Ask an operator which locations are permitted.',
  storage_connection_name_taken: 'Another storage connection already has that name.',
  storage_connection_not_found: 'That storage connection no longer exists.',
  storage_connection_prefix_not_allowed: 'That folder is outside the connection’s allowed folders.',
  storage_connection_write_not_allowed: 'This connection does not allow writing.',
  storage_connection_credential_required:
    'Moving the connection to another endpoint, bucket or account needs a new credential. Enter it under Credential and save again.',
  storage_connection_in_use:
    'Agents still grant this connection. Remove their storage grants first, then delete it.',
  storage_connection_unreachable: 'The storage did not answer. Try again, or check the connection.',
  agent_definition_references_missing:
    'The agent refers to something that no longer exists, so the grant could not be saved.',
};

/** A fixed sentence per API code: the server's own message is never shown. */
export function storageProblemMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiProblemError)) return fallback;
  const known = PROBLEM_MESSAGES[error.code];
  if (known !== undefined) return known;
  return error.status === 403 ? 'You don’t have access to connected storage.' : fallback;
}

export function testOutcomeMessage(
  outcome: { readonly ok: true } | { readonly ok: false; readonly code: string },
): string {
  if (outcome.ok) return 'Connection OK';
  switch (outcome.code) {
    case 'forbidden':
      return 'The storage refused the credential or the endpoint.';
    case 'not_found':
      return 'The storage location was not found.';
    default:
      return 'The storage did not answer.';
  }
}
