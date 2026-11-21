/**
 * The demo's side of `DemoApprovedWrites` (ADR-0169 D3): an approved call to a recorded write of a
 * records stand-in is kept in that stand-in's row of the run's own workspace, so the continuation's
 * stand-in, and every later one, answers with it. The row is the visitor's: no other workspace
 * sees it, and it goes with the workspace.
 */
import type { ConnectorsStoreProvider } from '../../integrations';
import {
  readRecordsServerState,
  recordsServerArgs,
  RecordsTooLargeError,
} from '../provision/records-server';
import { approvedCallOf, keepApprovedWrite, mcpToolOf } from './keep-write';

type ConnectorStore = ReturnType<ConnectorsStoreProvider['forWorkspace']>;
type Connector = Awaited<ReturnType<ConnectorStore['list']>>[number];

/** Whether `server`, the server key of an engine tool name, names `connector`. */
function namesConnector(server: string, connector: Connector): boolean {
  return server === connector.name || server === `connector-${connector.id}`;
}

/** Keep one approved call in the stand-in it names, when it is a recorded write of one. */
async function keepCall(
  store: ConnectorStore,
  connectors: readonly Connector[],
  canonicalCall: string,
): Promise<void> {
  const call = approvedCallOf(canonicalCall);
  const target = call === null ? null : mcpToolOf(call.toolName);
  if (call === null || target === null) return;
  const connector = connectors.find((candidate) => namesConnector(target.server, candidate));
  // A tool connector (`openapi`, `postgres`) is never a stand-in; an MCP row may omit its kind.
  if (connector === undefined || connector.kind === 'openapi' || connector.kind === 'postgres') {
    return;
  }
  const state = readRecordsServerState(connector);
  if (state === null) return;
  const next = keepApprovedWrite(state, target.tool, call.input);
  if (next === null) return;
  let args: readonly string[];
  try {
    ({ args } = recordsServerArgs(next));
  } catch (error) {
    // A stand-in that would carry more than one process can take keeps nothing more (D5).
    if (error instanceof RecordsTooLargeError) return;
    throw error;
  }
  const updated = await store.update(connector.id, { args });
  if (updated.kind !== 'updated') {
    throw new Error(`the demo records stand-in ${connector.id} was not updated: ${updated.kind}`);
  }
}

/**
 * What the run API's `DemoApprovedWrites` port asks for, declared here as the caps gate declares
 * its own, so the demo never imports the runs context; the composition root joins the two.
 */
export interface DemoApprovedWritesKeeper {
  readonly keep: (approved: {
    readonly workspaceId: string;
    readonly calls: readonly { readonly canonicalCall: string }[];
  }) => Promise<void>;
}

export function createDemoApprovedWrites(deps: {
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  /**
   * Whether the workspace keeps demo writes: a visitor's demo workspace (it has a demo end) or the
   * verification workspace (`PUT /api/demo/verification` marked it). No other keeps anything.
   */
  readonly keepsDemoWrites: (workspaceId: string) => Promise<boolean>;
}): DemoApprovedWritesKeeper {
  return {
    async keep({ workspaceId, calls }) {
      // Any other workspace's continuation reads nothing: no connector list, no row.
      if (calls.length === 0 || !(await deps.keepsDemoWrites(workspaceId))) return;
      const store = deps.connectors.forWorkspace(workspaceId);
      for (const { canonicalCall } of calls) {
        // Read again for each call, so a second call to the same stand-in builds on the first.
        await keepCall(store, await store.list(), canonicalCall);
      }
    },
  };
}
