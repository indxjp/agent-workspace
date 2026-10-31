/**
 * `/api/storage-connections` and `/api/storage-connections/:id[/credential]` (the storage design,
 * §05 and §06 Phase 5). The workspace is the principal's and nothing else; a credential goes to the
 * secret store and is never part of a response, an audit row or an error. Every successful write is
 * audited once, and so is every test. `test` and `browse` reach the customer's storage only through
 * `openConnectionStore`, which owns the egress guard, the pinned lookup or the outbound proxy, and
 * the read-only wrapper.
 */
import {
  CreateStorageConnectionInputSchema,
  parseStorageGrantPath,
  STORAGE_CONNECTION_PROBLEM_CODES,
  STORAGE_GRANT_SCHEME,
  StorageConnectionCredentialSchema,
  UpdateStorageConnectionPatchSchema,
  type StorageConnectionBrowseResponse,
  type StorageConnectionCredential,
  type StorageConnectionProblemCode,
  type StorageConnectionProvider,
  type StorageConnectionResource,
  type StorageConnectionTestOutcome,
} from '@indx-workspace/contracts/storage-connections';
import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { toObjectKey, UnsafeObjectKeyError } from '@agent-workspace/core/storage/keys';

import { isUnderAllowedPrefix } from '../agent-versions/storage-grants';
import { formatIssues, problem, type ApiResult } from '../http/result';
import { PROBE_TIMEOUT_MS } from '../models/probe';
import type { Principal } from '../rbac/principal';
import { isUuid } from '../secrets/contract';
import {
  ConnectionStoreError,
  folderFailure,
  openConnectionStore,
  resolveFileRoot,
  storageProviderStatus,
  storageRefusalClass,
  type ObjectPage,
} from '../storage/objects';
import { log } from '../telemetry/logger';
import type { StorageConnections, StorageConnectionsRuntime } from './runtime';
import { credentialTarget } from './store';
import type { WorkspaceStorageConnectionsStore } from './store';

function refusal(code: StorageConnectionProblemCode): ApiResult {
  return problem(STORAGE_CONNECTION_PROBLEM_CODES[code], code, `The request was refused: ${code}.`);
}

function isProblemCode(value: string): value is StorageConnectionProblemCode {
  return Object.hasOwn(STORAGE_CONNECTION_PROBLEM_CODES, value);
}

/** Run `work` over the serving runtime, or answer `503` when this deployment has none. */
export function withStorageConnections(
  connections: StorageConnections,
  work: (runtime: StorageConnectionsRuntime) => Promise<ApiResult>,
): Promise<ApiResult> {
  if (connections.kind === 'unavailable') {
    return Promise.resolve(
      problem(
        503,
        'storage_connections_not_configured',
        'Storage connections need the encrypted secrets service, which this deployment did not start.',
      ),
    );
  }
  return work(connections.runtime);
}

// @story US-STO-12
export async function listStorageConnections(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
): Promise<ApiResult> {
  const connections = await runtime.store.forWorkspace(principal.workspaceId).list();
  return { status: 200, body: { connections } };
}

// @story US-STO-12
export async function getStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
): Promise<ApiResult> {
  const connection = isUuid(id)
    ? await runtime.store.forWorkspace(principal.workspaceId).get(id)
    : null;
  return connection === null
    ? refusal('storage_connection_not_found')
    : { status: 200, body: connection };
}

// @story US-STO-12
export async function createStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  raw: unknown,
): Promise<ApiResult> {
  const parsed = parseBody(CreateStorageConnectionInputSchema, raw);
  if (!parsed.ok) return parsed.result;
  const input = parsed.value;
  const located = await locateUrl(runtime, input.url);
  if (!located.ok) return located.result;
  const created = await runtime.store.forWorkspace(principal.workspaceId).create({
    name: input.name,
    url: input.url,
    provider: located.provider,
    allowedPrefixes: input.allowedPrefixes,
    writeAllowed: input.writeAllowed,
    credential: input.credential,
  });
  if (created.kind === 'name-conflict') return refusal('storage_connection_name_taken');
  await audit(runtime, principal, 'storage-connection-created', created.connection);
  return { status: 201, body: created.connection };
}

// @story US-STO-12
export async function updateStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
  raw: unknown,
): Promise<ApiResult> {
  const store = runtime.store.forWorkspace(principal.workspaceId);
  const current = isUuid(id) ? await store.get(id) : null;
  if (current === null) return refusal('storage_connection_not_found');
  const parsed = parseBody(UpdateStorageConnectionPatchSchema, raw);
  if (!parsed.ok) return parsed.result;
  const { credential, ...patch } = parsed.value;
  if (patch.url !== undefined) {
    const located = await locateUrl(runtime, patch.url);
    if (!located.ok) return located.result;
    // The stored credential is shaped for the provider the connection was created with.
    if (located.provider !== current.provider) return refusal('storage_connection_url_invalid');
  }
  if (
    credential !== undefined &&
    (credential.provider === 'file' ||
      credential.provider !== current.provider ||
      isProjectlessGcsToken(patch.url ?? current.url, credential))
  ) {
    return refusal('storage_connection_url_invalid');
  }
  // The stored credential never follows the connection to another host, account or bucket.
  if (
    credential === undefined &&
    current.hasCredential &&
    patch.url !== undefined &&
    credentialTarget(patch.url) !== credentialTarget(current.url)
  ) {
    return refusal('storage_connection_credential_required');
  }
  // Judged against `current.url`: a row another writer moved since is refused, never re-bound.
  const updated = await store.update(current.id, current.url, patch, credential);
  if (updated.kind === 'not-found') return refusal('storage_connection_not_found');
  if (updated.kind === 'name-conflict') return refusal('storage_connection_name_taken');
  if (updated.kind === 'target-changed') return refusal('storage_connection_credential_required');
  await audit(runtime, principal, 'storage-connection-updated', updated.connection);
  return { status: 200, body: updated.connection };
}

// @story US-STO-12
export async function rotateStorageConnectionCredential(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
  raw: unknown,
): Promise<ApiResult> {
  const store = runtime.store.forWorkspace(principal.workspaceId);
  const current = isUuid(id) ? await store.get(id) : null;
  if (current === null) return refusal('storage_connection_not_found');
  const parsed = parseBody(StorageConnectionCredentialSchema, raw);
  if (!parsed.ok) return parsed.result;
  // A `file` connection has nothing to authenticate with, and any other must keep its provider.
  if (
    parsed.value.provider === 'file' ||
    parsed.value.provider !== current.provider ||
    isProjectlessGcsToken(current.url, parsed.value)
  ) {
    return refusal('storage_connection_url_invalid');
  }
  const rotated = await store.rotate(current.id, current.url, parsed.value);
  if (rotated.kind === 'not-found') return refusal('storage_connection_not_found');
  // The connection moved after it was read: this credential was supplied for its old target.
  if (rotated.kind === 'target-changed') return refusal('storage_connection_credential_required');
  await audit(runtime, principal, 'storage-connection-credential-changed', rotated.connection);
  return { status: 200, body: rotated.connection };
}

// @story US-STO-12
export async function deleteStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
): Promise<ApiResult> {
  if (!isUuid(id)) return refusal('storage_connection_not_found');
  // A granted connection stays: the grant would dangle (and the database refuses it anyway).
  if (await runtime.isConnectionGranted(principal.workspaceId, id)) {
    return refusal('storage_connection_in_use');
  }
  const removed = await runtime.store.forWorkspace(principal.workspaceId).remove(id);
  if (removed.kind === 'not-found') {
    return refusal('storage_connection_not_found');
  }
  await audit(runtime, principal, 'storage-connection-deleted', removed.connection);
  return { status: 204, body: null };
}

/**
 * Open the connection read-only with its stored credential and list one page. Nothing is dialled
 * until `openConnectionStore` has checked the endpoint; any failure is thrown for the caller to map.
 * `signal` aborts the open and the listing once the probe has timed out.
 */
async function listConnection(
  runtime: StorageConnectionsRuntime,
  store: WorkspaceStorageConnectionsStore,
  connection: StorageConnectionResource,
  prefix: string,
  options: { readonly cursor?: string; readonly limit?: number; readonly signal: AbortSignal },
): Promise<ObjectPage> {
  const credential =
    connection.provider === 'file'
      ? ({ provider: 'file' } as const)
      : await store.credential(connection.id, connection.url);
  if (credential === null) throw new ConnectionStoreError('storage_connection_credential_required');
  const objects = await openConnectionStore(connection.url, credential, {
    writable: false,
    fileRoots: runtime.fileRoots,
    egress: runtime.egress,
    ...(runtime.proxy === undefined ? {} : { proxy: runtime.proxy }),
    signal: options.signal,
    // Counts and the id only: a name or path could carry the target of a link.
    onSkipped: (counts) =>
      log.warn('[storage-connections] a listing skipped entries', {
        connectionId: connection.id,
        ...counts,
      }),
  });
  return objects.listPage(prefix, options);
}

/** `work` until `PROBE_TIMEOUT_MS`; then its signal is aborted and the probe is `unreachable`. */
function withProbeTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ConnectionStoreError('storage_connection_unreachable'));
      controller.abort();
    }, PROBE_TIMEOUT_MS);
  });
  return Promise.race([work(controller.signal), expired]).finally(() => clearTimeout(timer));
}

/**
 * A `file` connection's own failure, logged by its reason code alone: its message names the
 * customer's key. `null` for any other error.
 */
function loggedFolderFailure(
  route: 'test' | 'browse',
  connectionId: string,
  error: unknown,
): ReturnType<typeof folderFailure> {
  const failure = folderFailure(error);
  if (failure !== null) {
    log.warn(`[storage-connections] ${route}: the connection's folder failed`, {
      connectionId,
      reason: failure.reason,
    });
  }
  return failure;
}

/** Only the code or the status is read: the message and `cause` may echo the provider's reply. */
function testOutcome(connectionId: string, error: unknown): StorageConnectionTestOutcome {
  const folder = loggedFolderFailure('test', connectionId, error);
  if (folder !== null) return { ok: false, code: folder.refusal };
  if (error instanceof ConnectionStoreError) {
    return error.code === 'storage_connection_endpoint_forbidden'
      ? { ok: false, code: 'forbidden' }
      : { ok: false, code: 'unreachable' };
  }
  if (storageProviderStatus(error) === null) logUnclassified('test', error);
  return { ok: false, code: storageRefusalClass(error) };
}

/** An error that is neither the connection store's nor a provider status; the logger redacts it. */
function logUnclassified(route: 'test' | 'browse', error: unknown): void {
  log.error(`[storage-connections] ${route} failed outside the provider; answered unreachable`, {
    error,
  });
}

// @story US-STO-12
export async function testStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
): Promise<ApiResult> {
  const store = runtime.store.forWorkspace(principal.workspaceId);
  const connection = isUuid(id) ? await store.get(id) : null;
  if (connection === null) return refusal('storage_connection_not_found');
  let outcome: StorageConnectionTestOutcome = { ok: true };
  try {
    // One entry of an allowed folder: a test never lists beyond what browse may show.
    const [folder = ''] = connection.allowedPrefixes;
    await withProbeTimeout((signal) =>
      listConnection(runtime, store, connection, folder, { limit: 1, signal }),
    );
  } catch (error) {
    outcome = testOutcome(connection.id, error);
  }
  await audit(runtime, principal, 'storage-connection-tested', connection);
  return { status: 200, body: outcome };
}

/**
 * A query value exactly as it reached the route, before any decoding. `URLSearchParams.get` is not
 * used because it repairs a malformed escape instead of refusing it.
 */
function rawQueryParam(url: string, name: string): string | null {
  for (const pair of new URL(url).search.slice(1).split('&')) {
    const equals = pair.indexOf('=');
    if ((equals === -1 ? pair : pair.slice(0, equals)) === name) {
      return equals === -1 ? '' : pair.slice(equals + 1);
    }
  }
  return null;
}

/**
 * A query value decoded once as `application/x-www-form-urlencoded`: `+` is a space and `%2B` a
 * literal `+`. `null` for a malformed percent escape.
 *
 * The form reading is the only one the route can rely on: before a route handler runs, `next start`
 * rebuilds `request.url`'s query from its parsed values with `URLSearchParams`
 * (`normalizeCdnUrl` in `next/dist/server/server-utils`), which writes a space as `+`. A client's
 * `Q3%20drafts` reaches the handler as `Q3+drafts`, so a plain `decodeURIComponent` would name the
 * folder `Q3+drafts` instead. Both readings agree on every other escape, so the value is still
 * decoded exactly once.
 */
function decodeQueryValue(value: string): string | null {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function browseFailure(connectionId: string, error: unknown): ApiResult {
  if (error instanceof ConnectionStoreError) return refusal(error.code);
  // A key resolved outside the folder is refused like a forbidden endpoint; anything else the
  // folder failed with (an I/O error, the walk cap) is unreachable.
  const folder = loggedFolderFailure('browse', connectionId, error);
  if (folder !== null) {
    return refusal(
      folder.reason === 'outside_root'
        ? 'storage_connection_endpoint_forbidden'
        : 'storage_connection_unreachable',
    );
  }
  // A key the store's guard refuses (`%2e%2e` and the like) is a folder this API will not show.
  if (error instanceof UnsafeObjectKeyError)
    return refusal('storage_connection_prefix_not_allowed');
  if (storageProviderStatus(error) === null) logUnclassified('browse', error);
  return refusal('storage_connection_unreachable');
}

/**
 * Whether a listed key may be shown under `prefix`. The key passes the store's key guard first, so
 * a `..`, `.` or empty segment, raw or percent-encoded, never reaches the segment comparison.
 */
function isListedUnder(key: string, prefix: string): boolean {
  try {
    toObjectKey(key);
  } catch (error) {
    if (error instanceof UnsafeObjectKeyError) return false;
    throw error;
  }
  return isUnderAllowedPrefix(key, prefix);
}

// @story US-STO-12
export async function browseStorageConnection(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  id: unknown,
  requestUrl: string,
): Promise<ApiResult> {
  const store = runtime.store.forWorkspace(principal.workspaceId);
  const connection = isUuid(id) ? await store.get(id) : null;
  if (connection === null) return refusal('storage_connection_not_found');
  const sent = rawQueryParam(requestUrl, 'prefix') ?? '';
  if (sent === '') {
    const entries = connection.allowedPrefixes.map((path) => ({ path, kind: 'folder' as const }));
    return { status: 200, body: { entries } satisfies StorageConnectionBrowseResponse };
  }
  // Decoded exactly once and validated after: `%2e%2e` becomes `..`, which the grammar refuses,
  // and `%252e%252e` becomes the literal folder name `%2e%2e`, never `..`.
  const raw = decodeQueryValue(sent);
  if (raw === null) return refusal('storage_connection_prefix_not_allowed');
  // `reports/` names the folder `reports`; the grammar has no trailing slash.
  const folder = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const parsed = parseStorageGrantPath(`${STORAGE_GRANT_SCHEME}${connection.name}/${folder}`);
  if (
    parsed === null ||
    !connection.allowedPrefixes.some((allowed) => isUnderAllowedPrefix(parsed.prefix, allowed))
  ) {
    return refusal('storage_connection_prefix_not_allowed');
  }
  // The cursor is an opaque token the client hands back.
  const cursor = new URL(requestUrl).searchParams.get('cursor');
  let page: ObjectPage;
  try {
    page = await withProbeTimeout((signal) =>
      listConnection(
        runtime,
        store,
        connection,
        parsed.prefix,
        cursor === null || cursor === '' ? { signal } : { cursor, signal },
      ),
    );
  } catch (error) {
    return browseFailure(connection.id, error);
  }
  // Whatever the cursor was, nothing outside the prefix is shown.
  const entries = page.entries
    .filter((entry) => isListedUnder(entry.key, parsed.prefix))
    .map((entry) =>
      entry.kind === 'file'
        ? { path: entry.key, kind: entry.kind, size: entry.sizeBytes }
        : { path: entry.key, kind: entry.kind },
    );
  const body: StorageConnectionBrowseResponse = {
    entries,
    ...(page.cursor === null ? {} : { next: page.cursor }),
  };
  return { status: 200, body };
}

type ParsedBody<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: ApiResult };

/** Parse a body; an issue whose message is a problem code answers with that code. */
function parseBody<T>(
  schema: {
    safeParse(raw: unknown):
      | { readonly success: true; readonly data: T }
      | {
          readonly success: false;
          readonly error: {
            readonly issues: readonly {
              readonly path: readonly PropertyKey[];
              readonly message: string;
            }[];
          };
        };
  },
  raw: unknown,
): ParsedBody<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const code = parsed.error.issues.map((issue) => issue.message).find(isProblemCode);
  return {
    ok: false,
    result:
      code === undefined
        ? problem(
            400,
            'invalid_storage_connection',
            'The body is not a storage connection.',
            formatIssues(parsed.error.issues),
          )
        : refusal(code),
  };
}

/** The provider a URL names; a folder must sit under one of the operator's roots. */
async function locateUrl(
  runtime: StorageConnectionsRuntime,
  url: string,
): Promise<
  | { readonly ok: true; readonly provider: StorageConnectionProvider }
  | { readonly ok: false; readonly result: ApiResult }
> {
  const located = parseStorageUrl(url);
  if (!located.ok) return { ok: false, result: refusal('storage_connection_url_invalid') };
  if (located.location.kind === 'file') {
    try {
      await resolveFileRoot(located.location.root, runtime.fileRoots);
    } catch (error) {
      if (error instanceof ConnectionStoreError) return { ok: false, result: refusal(error.code) };
      throw error;
    }
  }
  return { ok: true, provider: located.location.kind };
}

/**
 * A GCS token on a URL with no `?project=`, refused as on create: a token names no project, and
 * every open of the connection would then fail as `unreachable`.
 */
function isProjectlessGcsToken(url: string, credential: StorageConnectionCredential): boolean {
  const parsed = parseStorageUrl(url);
  return (
    parsed.ok &&
    parsed.location.kind === 'gcs' &&
    parsed.location.projectId === undefined &&
    'accessToken' in credential
  );
}

function audit(
  runtime: StorageConnectionsRuntime,
  principal: Principal,
  action: Parameters<StorageConnectionsRuntime['audit']>[0]['action'],
  connection: { readonly id: string; readonly name: string },
): Promise<void> {
  return runtime.audit({
    workspaceId: principal.workspaceId,
    actorPrincipalId: principal.principalId,
    actorUserId: principal.userId,
    actorLabel: principal.label,
    action,
    subjectId: connection.id,
    subjectLabel: connection.name,
  });
}
