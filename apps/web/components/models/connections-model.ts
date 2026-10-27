import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import { readCatalog, type Catalog } from './catalog';
import {
  agentsReferencing,
  createConnectionPayload,
  formatApiError,
  readAgentSummaries,
  readModelConnections,
  updateConnectionPayload,
  type EditFormValues,
  type ModelConnectionView,
  type ProviderFormValues,
  type ReferencingAgent,
} from './model';

/**
 * The model screens' calls through the SDK client. Each resolves with what the screen shows, or
 * rejects with an `Error` whose message is the text the screen has always shown for that failure.
 */

/** The platform's problem as the provider panel shows it; `The request failed.` when it sent none. */
function problemError(error: unknown): unknown {
  if (!(error instanceof ApiProblemError)) return error;
  return new Error(
    error.code === 'unrecognised_error_body'
      ? formatApiError(null)
      : formatApiError({ error: { message: error.message, details: error.details } }),
    { cause: error },
  );
}

/** `GET /api/model-connections` for the providers list. */
export async function loadConnections(
  client: AgentWorkspaceClient,
): Promise<readonly ModelConnectionView[]> {
  try {
    return readModelConnections({ models: await client.models.connections.list() });
  } catch (error) {
    if (error instanceof ApiProblemError)
      throw new Error(`Model connections request returned ${String(error.status)}.`, {
        cause: error,
      });
    throw error;
  }
}

/**
 * `GET /api/models` joined with `GET /api/model-connections`. A refused read (a `503` when the
 * models runtime is not configured) contributes nothing; a transport failure rejects.
 */
export async function loadCatalog(client: AgentWorkspaceClient): Promise<Catalog> {
  const optional = <T>(read: Promise<T>, empty: T): Promise<T> =>
    read.catch((error: unknown) => {
      if (error instanceof ApiProblemError) return empty;
      throw error;
    });
  const [discovery, connections] = await Promise.all([
    optional(client.models.discover(), { models: [] }),
    optional(client.models.connections.list(), []),
  ]);
  return readCatalog(discovery, { models: connections });
}

/** `POST /api/model-connections`: the credential goes to the server once, here, and nowhere else. */
export async function createConnection(
  client: AgentWorkspaceClient,
  values: ProviderFormValues,
): Promise<void> {
  try {
    await client.models.connections.create(createConnectionPayload(values));
  } catch (error) {
    if (!(error instanceof ApiProblemError)) throw error;
    throw new Error(
      error.code === 'unrecognised_error_body'
        ? `Provider request returned ${String(error.status)}.`
        : error.message,
      { cause: error },
    );
  }
}

/** The row's Test button: the server's message, or the status that refused or failed the probe. */
export async function testConnection(
  client: AgentWorkspaceClient,
  connectionId: string,
): Promise<string> {
  try {
    const outcome = await client.models.connections.test(connectionId);
    // A failed probe answers `502` with the outcome; the screen has always named that status.
    if (!outcome.ok) throw new Error('Connection test returned 502.');
    return outcome.message;
  } catch (error) {
    if (error instanceof ApiProblemError)
      throw new Error(`Connection test returned ${String(error.status)}.`, { cause: error });
    throw error;
  }
}

/** `PATCH /api/model-connections/:id`: the saved connection as the panel shows it. */
export async function updateConnection(
  client: AgentWorkspaceClient,
  connection: Pick<ModelConnectionView, 'id' | 'provider'>,
  values: EditFormValues,
): Promise<ModelConnectionView | undefined> {
  try {
    const updated = await client.models.connections.update(
      connection.id,
      updateConnectionPayload(values, connection.provider),
    );
    return readModelConnections({ models: [updated] })[0];
  } catch (error) {
    throw problemError(error);
  }
}

/** `POST /api/model-connections/:id/credential`: write-only, the key is never read back. */
export async function rotateCredential(
  client: AgentWorkspaceClient,
  connectionId: string,
  apiKey: string,
): Promise<void> {
  try {
    await client.models.connections.rotateCredential(connectionId, apiKey);
  } catch (error) {
    throw problemError(error);
  }
}

/** The probe after a rotation: the line the panel shows, whether or not the probe passed. */
export async function testAfterRotation(
  client: AgentWorkspaceClient,
  connectionId: string,
): Promise<string> {
  try {
    const outcome = await client.models.connections.test(connectionId);
    return outcome.ok
      ? `Credential rotated. ${outcome.message}`
      : `Credential rotated. Test failed: ${outcome.message}`;
  } catch (error) {
    if (error instanceof ApiProblemError)
      return `Credential rotated. Test failed: HTTP ${String(error.status)}`;
    throw error;
  }
}

/** `GET /api/agents`: who references the connection, for the remove confirmation's preview. */
export async function referencingAgents(
  client: AgentWorkspaceClient,
  connectionId: string,
): Promise<readonly ReferencingAgent[]> {
  const agents = await client.agents.list();
  return agentsReferencing(readAgentSummaries({ agents }), connectionId);
}

/** `DELETE /api/model-connections/:id`. */
export async function removeConnection(
  client: AgentWorkspaceClient,
  connectionId: string,
): Promise<void> {
  try {
    await client.models.connections.remove(connectionId);
  } catch (error) {
    throw problemError(error);
  }
}
