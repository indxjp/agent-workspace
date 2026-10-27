/**
 * What the resource screens (files, skills, connectors, API keys, settings) ask of the API, as
 * functions over an SDK client so they are testable with the SDK's `fetchDouble`. The client
 * validates every answer against the contracts, so a screen never reads an unchecked body.
 */
import type { FileResource } from '@indx-workspace/contracts/files';
import type { ConnectorAuthType, CreateConnectorInput } from '@indx-workspace/contracts/connectors';
import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';
import {
  ApiProblemError,
  ContractViolationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';

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

/** A failed call as the one-line `<what> returned <status>.` a few screens use. */
function statusText(error: unknown, what: string): Error {
  return error instanceof ApiProblemError
    ? new Error(`${what} returned ${String(error.status)}.`)
    : error instanceof Error
      ? error
      : new Error(String(error));
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

export async function createFolder(client: AgentWorkspaceClient, path: string): Promise<void> {
  await client.files.createFolder(path);
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
      throw new Error('This file is too large for this deployment.', { cause: error });
    }
    throw statusText(error, 'Upload');
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
    throw new Error(
      `Move did not finish: ${String(result.moved)} of ${String(result.total)} items moved; the rest are still at the old location.`,
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
    throw new Error(
      `Delete did not finish: ${String(outcome.deleted.length)} removed, ${String(outcome.remaining.length)} still present. Try again.`,
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
