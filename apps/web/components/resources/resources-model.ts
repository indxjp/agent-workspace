/**
 * What the resource screens (files, skills, connectors, API keys, settings) ask of the API, as
 * functions over an SDK client so they are testable with the SDK's `fetchDouble`. The client
 * validates every answer against the contracts, so a screen never reads an unchecked body.
 */
import {
  MAX_SEARCH_LIMIT,
  MAX_UPLOAD_BYTES,
  type FileResource,
  type FileSearchResponse,
} from '@indx-workspace/contracts/files';
import type { ConnectorAuthType, CreateConnectorInput } from '@indx-workspace/contracts/connectors';
import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';
import {
  ApiProblemError,
  ContractViolationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';

import { ENGLISH_FILES_STRINGS as EN_FILES, type FilesStrings } from './files-messages';

/** What a failed call says: the server's message and details, as the screens always showed. */
/** The SDK client the screens hand to the model; only this file imports the SDK. */
export type ResourcesClient = AgentWorkspaceClient;

export function errorText(error: unknown): string {
  if (error instanceof ApiProblemError)
    return error.details.length === 0
      ? error.message
      : `${error.message} ${error.details.join(' ')}`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * A failure the Files screen worded itself, not the server: `message` is the English sentence the
 * screen always printed, and `say` words it for another reader (UX-15 in #2086).
 */
export class FilesClientError extends Error {
  constructor(
    message: string,
    readonly say: (words: FilesStrings) => string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FilesClientError';
  }
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// --- files -------------------------------------------------------------------------------------

export function listFiles(
  client: AgentWorkspaceClient,
  path: string,
): Promise<readonly FileResource[]> {
  return client.files.list({ path });
}

/** The text search of the workspace's files, as many passages as one answer may carry. */
export function searchFiles(
  client: AgentWorkspaceClient,
  query: string,
): Promise<FileSearchResponse> {
  return client.files.search(query, { limit: MAX_SEARCH_LIMIT });
}

/** `bytes` in MiB, one decimal under 10 MiB: "64 MiB", "2.5 MiB". */
function mebibytes(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return `${value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value))} MiB`;
}

/** The status and code of a refused call, or `null` when it failed some other way. */
export function problemOf(
  error: unknown,
): { readonly status: number; readonly code: string } | null {
  return error instanceof ApiProblemError ? { status: error.status, code: error.code } : null;
}

export async function createFolder(client: AgentWorkspaceClient, path: string): Promise<void> {
  await client.files.createFolder(path);
}

/**
 * Create the empty folder at `path` for a folder upload. One already there (`409 name_conflict`)
 * is the result the upload asked for, so it is not a failure.
 */
export async function ensureFolder(client: AgentWorkspaceClient, path: string): Promise<void> {
  try {
    await client.files.createFolder(path);
  } catch (error) {
    if (error instanceof ApiProblemError && error.status === 409 && error.code === 'name_conflict')
      return;
    throw error;
  }
}

export async function uploadFile(
  client: AgentWorkspaceClient,
  path: string,
  file: File,
): Promise<void> {
  try {
    await client.files.upload(path, file, { contentType: file.type || 'application/octet-stream' });
  } catch (error) {
    // The relay answers 413 above its limit, and the SDK falls back to it when the deployment
    // cannot sign (no direct transfer, or a size over the signed-upload limit).
    if (error instanceof ApiProblemError && error.status === 413) {
      // Two limits answer 413: the relay's fixed MAX_UPLOAD_BYTES, and a signing deployment's own
      // AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES, which the browser cannot read (the problem envelope
      // carries no number). The relay's limit is the one size every deployment accepts, so it is
      // named as that, not as the maximum, beside the file's own size (UX-16 in #2086).
      const size = mebibytes(file.size);
      const always = mebibytes(MAX_UPLOAD_BYTES);
      throw new FilesClientError(
        EN_FILES.overDeployment(file.name, size, always),
        (words) => words.overDeployment(file.name, size, always),
        { cause: error },
      );
    }
    if (error instanceof ApiProblemError) {
      const status = String(error.status);
      throw new FilesClientError(
        EN_FILES.uploadReturned(status),
        (words) => words.uploadReturned(status),
        { cause: error },
      );
    }
    // No answer at all, or one that broke the contract: that failure's own sentence.
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Rename or move. A folder answers `200` with a `partial` outcome when it stopped part-way, which
 * is not a transport failure, so it is raised here rather than looking like success.
 */
export async function renameFile(
  client: AgentWorkspaceClient,
  path: string,
  newPath: string,
): Promise<void> {
  const result = await client.files.move(path, newPath);
  if ('status' in result && result.status === 'partial') {
    const moved = String(result.moved);
    const total = String(result.total);
    throw new FilesClientError(EN_FILES.moveUnfinished(moved, total), (words) =>
      words.moveUnfinished(moved, total),
    );
  }
}

/**
 * Delete a file or folder. A folder with contents answers `409 folder_not_empty`; the caller's
 * `confirmRecursive` decides whether to retry with `recursive`, and declining raises the refusal.
 */
export async function deleteFile(
  client: AgentWorkspaceClient,
  path: string,
  confirmRecursive: () => boolean,
): Promise<void> {
  let outcome;
  try {
    outcome = await client.files.remove(path);
  } catch (error) {
    if (!(error instanceof ApiProblemError) || error.status !== 409) throw error;
    if (error.code !== 'folder_not_empty' || !confirmRecursive()) throw error;
    outcome = await client.files.remove(path, { recursive: true });
  }
  if (outcome?.status === 'partial') {
    const deleted = String(outcome.deleted.length);
    const remaining = String(outcome.remaining.length);
    throw new FilesClientError(EN_FILES.deleteUnfinished(deleted, remaining), (words) =>
      words.deleteUnfinished(deleted, remaining),
    );
  }
}

// --- skills ------------------------------------------------------------------------------------

export async function loadSkills(client: AgentWorkspaceClient): Promise<Record<string, unknown>> {
  return { skills: await client.skills.list() };
}

export async function loadSkill(
  client: AgentWorkspaceClient,
  name: string,
): Promise<Record<string, unknown>> {
  return { skill: await client.skills.get(name) };
}

export async function createSkill(
  client: AgentWorkspaceClient,
  name: string,
  source: string,
): Promise<void> {
  await client.skills.import({ name, files: [{ path: 'SKILL.md', body: source }] });
}

export async function saveSkill(
  client: AgentWorkspaceClient,
  name: string,
  enabled: boolean,
  source: string,
): Promise<void> {
  await client.skills.update(name, {
    enabled,
    files: [{ path: 'SKILL.md', contentBase64: base64(source) }],
  });
}

// --- connectors --------------------------------------------------------------------------------

export async function loadConnectors(
  client: AgentWorkspaceClient,
): Promise<Record<string, unknown>> {
  return { connectors: await client.connectors.list() };
}

export async function deleteConnector(client: AgentWorkspaceClient, id: string): Promise<void> {
  await client.connectors.remove(id);
}

/** The sentence a connection probe reports; a failed probe is a `200` with `ok: false`. */
export async function testConnector(client: AgentWorkspaceClient, id: string, name: string) {
  const outcome = await client.connectors.test(id);
  return outcome.ok
    ? `${name} connection passed.`
    : `${name}: ${outcome.message || 'Connection failed.'}`;
}

export interface ConnectorDraft {
  readonly name: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly args: string;
  readonly authType: ConnectorAuthType;
  readonly credential: string;
}

/** Test the draft (returns the sentence to show) or save it (returns `null`). */
export async function submitConnector(
  client: AgentWorkspaceClient,
  draft: ConnectorDraft,
  dryRun: boolean,
): Promise<string | null> {
  const auth = {
    authType: draft.authType,
    ...(draft.authType === 'none' ? {} : { credential: draft.credential }),
  };
  const input: CreateConnectorInput =
    draft.transport === 'stdio'
      ? {
          name: draft.name,
          transport: 'stdio',
          command: draft.endpoint,
          args: draft.args.split(/\s+/u).filter(Boolean),
          ...auth,
        }
      : {
          name: draft.name,
          transport: draft.transport === 'sse' ? 'sse' : 'http',
          url: draft.endpoint,
          ...auth,
        };
  if (!dryRun) {
    await client.connectors.create(input);
    return null;
  }
  const outcome = await client.connectors.testDraft(input);
  return outcome.ok ? 'Connection test passed.' : outcome.message || 'Connection test failed.';
}

// --- API keys and settings ---------------------------------------------------------------------

export async function loadApiKeys(client: AgentWorkspaceClient): Promise<Record<string, unknown>> {
  return { apiKeys: await client.team.apiKeys.list() };
}

export async function loadMe(client: AgentWorkspaceClient): Promise<Record<string, unknown>> {
  return { ...(await client.me()) };
}

export async function revokeApiKey(client: AgentWorkspaceClient, id: string): Promise<void> {
  await client.team.apiKeys.revoke(id);
}

/** Mint a key; the plaintext, shown to the caller exactly once. */
export async function createApiKey(
  client: AgentWorkspaceClient,
  name: string,
  role: string,
): Promise<string> {
  const confer = MEMBERSHIP_ROLES.find((candidate) => candidate === role);
  if (confer === undefined) throw new Error(`Create key: ${role} is not a role.`);
  return (await client.team.apiKeys.create({ name, role: confer, expiresAt: null })).key;
}

/** The subsystems the settings page probes, each by listing what it holds. */
export const SETTINGS_ENDPOINTS = [
  '/api/files',
  '/api/skills',
  '/api/connectors',
  '/api/users',
  '/api/api-keys',
] as const;

/** The HTTP status each subsystem answers: `200` when its list is readable, `0` if unreachable. */
export async function probeSettings(client: AgentWorkspaceClient): Promise<Record<string, number>> {
  const probes: Record<(typeof SETTINGS_ENDPOINTS)[number], () => Promise<unknown>> = {
    '/api/files': () => client.files.list(),
    '/api/skills': () => client.skills.list(),
    '/api/connectors': () => client.connectors.list(),
    '/api/users': () => client.team.users.list(),
    '/api/api-keys': () => client.team.apiKeys.list(),
  };
  const entries = await Promise.all(
    SETTINGS_ENDPOINTS.map(async (endpoint) => {
      try {
        await probes[endpoint]();
        return [endpoint, 200] as const;
      } catch (error) {
        const status =
          error instanceof ApiProblemError || error instanceof ContractViolationError
            ? error.status
            : 0;
        return [endpoint, status] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
