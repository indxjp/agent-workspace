import {
  ApiProblemError,
  ContractViolationError,
  TransportError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';
import {
  type ProjectResourceCreate,
  type ProjectResourceUpdate,
} from '@indx-workspace/sdk/project';
import type { CliIo } from '../io.js';
import { withCredential } from '../project/tools.js';

/** HTTP 409 on a create: another `aw dev` made the resource between the listing and the create. */
const CONFLICT_STATUS = 409;

export type Action = ProjectResourceCreate | ProjectResourceUpdate;

/** The Demo's line for a connector applied live: `applied: connector github (new)`. */
function appliedLine(action: Action): string {
  return `applied: connector ${nameOf(action)} (${'id' in action ? 'updated' : 'new'})\n`;
}

/** The last segment of `models.<name>` or `connectors.<name>`. */
function nameOf(action: Action): string {
  return action.path.slice(action.path.indexOf('.') + 1);
}

function isModel(action: Action): boolean {
  return action.kind === 'model' || action.kind === 'model-credential';
}

/** Send one action of the plan, reading the value of the secret it names from `values`. */
export async function send(
  client: AgentWorkspaceClient,
  action: Action,
  values: ReadonlyMap<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const valueOf = (name: string): string => {
    const value = values.get(name);
    // The plan names only a set secret; anything else is a bug, said without a value.
    if (value === undefined) throw new Error(`the plan named ${name}, which is not set`);
    return value;
  };
  const secret = 'secret' in action ? action.secret : undefined;
  const credential = secret === undefined ? {} : { credential: valueOf(secret) };
  switch (action.kind) {
    case 'model':
      if ('id' in action) {
        await client.models.connections.update(
          action.id,
          { ...action.patch, apiKey: valueOf(action.secret) },
          { signal },
        );
      } else {
        await client.models.connections.create(
          { ...action.input, apiKey: valueOf(action.secret) },
          { signal },
        );
      }
      return;
    case 'model-credential':
      await client.models.connections.rotateCredential(action.id, valueOf(action.secret), {
        signal,
      });
      return;
    case 'connector': {
      // A catalog tool (C15) is sent whole, with its credential when it has one.
      const value = secret === undefined ? undefined : valueOf(secret);
      if ('id' in action) {
        const { patch } = action;
        const body = 'kind' in patch ? withCredential(patch, value) : { ...patch, ...credential };
        await client.connectors.update(action.id, body, { signal });
      } else {
        const { input } = action;
        const body = 'kind' in input ? withCredential(input, value) : { ...input, ...credential };
        await client.connectors.create(body, { signal });
      }
      return;
    }
    case 'connector-credential':
      await client.connectors.rotateCredential(action.id, valueOf(action.secret), { signal });
      return;
    default: {
      const unreachable: never = action;
      throw new Error(`unknown action ${String(unreachable)}`);
    }
  }
}

export function isServerRefusal(error: unknown): error is Error {
  return (
    error instanceof ApiProblemError ||
    error instanceof TransportError ||
    error instanceof ContractViolationError
  );
}

/**
 * Send every action of the plan, in order. A server refusal is a warning and the next action is
 * tried; an abort or any other failure is thrown.
 */
interface SendActionsOptions {
  readonly client: AgentWorkspaceClient;
  readonly actions: readonly Action[];
  readonly values: ReadonlyMap<string, string>;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  readonly defaultTakesBaseUrl: boolean;
}

export async function sendActions(options: SendActionsOptions): Promise<{
  readonly sentSecrets: ReadonlySet<string>;
  readonly failedSecrets: ReadonlySet<string>;
  readonly created: readonly string[];
  readonly baseUrlTaken: boolean;
}> {
  const { actions, io, defaultTakesBaseUrl } = options;
  // SD16: a secret is recorded only after the loop, and only when every action naming it in this
  // apply succeeded, so a shared secret's refused or interrupted send is retried on the next start.
  const sentSecrets = new Set<string>();
  const failedSecrets = new Set<string>();
  const created: string[] = [];
  let baseUrlTaken = defaultTakesBaseUrl;
  for (const action of actions) {
    const secret = 'secret' in action ? action.secret : undefined;
    if (!(await sendResourceAction(options, action))) {
      if (secret !== undefined) failedSecrets.add(secret);
      if (action.kind === 'model' && action.path === 'models.default') baseUrlTaken = false;
      continue;
    }
    if (secret !== undefined) sentSecrets.add(secret);
    if (action.kind === 'model' && !('id' in action)) {
      created.push(`model connection: ${nameOf(action)} (${action.input.provider})\n`);
    }
    // SD4: every connector the project file declares is MCP; a tool (S2-09c) is `tools.<name>`.
    if (action.path.startsWith('connectors.')) {
      io.stdout(appliedLine(action));
      io.stdout(`${action.path}: MCP tools that write run without confirmation (ADR-0108)\n`);
    }
  }
  return { sentSecrets, failedSecrets, created, baseUrlTaken };
}

async function sendResourceAction(options: SendActionsOptions, action: Action): Promise<boolean> {
  const { client, values, io, signal } = options;
  const what = isModel(action)
    ? `the "${nameOf(action)}" model connection`
    : `the "${nameOf(action)}" connector`;
  try {
    await send(client, action, values, signal);
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    const creating = !('id' in action);
    if (creating && error instanceof ApiProblemError && error.status === CONFLICT_STATUS)
      return false;
    if (!isServerRefusal(error)) throw error;
    io.stderr(`warning: could not set up ${what}: ${error.message}\n`);
    return false;
  }
}
