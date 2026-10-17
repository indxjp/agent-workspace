/* global fetch, AbortSignal, URLSearchParams */
/**
 * Kills every E2B sandbox one lane created, so the lane ends with none alive and never holds the
 * shared account's concurrent-sandbox cap for the next lane or run (issue #832). The runner tags
 * each sandbox it creates (agent runtime and tool sandbox) with `awWorkspace=<workspace id>`, and a
 * lane's control plane has a database, and so a workspace, of its own: the id is a random UUID that
 * database generates, so listing by that tag finds this lane's sandboxes and no one else's (other
 * lanes, setup's `runtime-verification` sandbox and production keep theirs). The key travels in a
 * request header only.
 */
import { setTimeout as delay } from 'node:timers/promises';

const API = 'https://api.e2b.dev';
const LIST_LIMIT = 100;

/**
 * @param {{ apiKey: string, workspaceId: string, request?: typeof fetch,
 *   log?: (line: string) => void, polls?: number, pollMs?: number }} options
 * @returns {Promise<{ before: number, after: number }>} `after` is 0 when the sweep succeeded
 */
export async function killLaneSandboxes(options) {
  const {
    apiKey,
    workspaceId,
    request = fetch,
    log = () => {},
    polls = 10,
    pollMs = 3000,
  } = options;
  const headers = { 'x-api-key': apiKey, accept: 'application/json' };
  const query = new URLSearchParams({
    metadata: new URLSearchParams({ awWorkspace: workspaceId }).toString(),
    state: 'running',
    limit: String(LIST_LIMIT),
  });

  /** @returns {Promise<{ id: string, tool: boolean }[]>} a tool sandbox is the one tagged `awTools` */
  async function live() {
    const response = await request(`${API}/v2/sandboxes?${query.toString()}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`E2B listing answered ${String(response.status)}`);
    const items = /** @type {unknown} */ (await response.json());
    return (Array.isArray(items) ? items : []).flatMap((/** @type {unknown} */ item) => {
      const { sandboxID: id, metadata } =
        /** @type {{ sandboxID?: unknown, metadata?: { awTools?: unknown } | null }} */ (
          item ?? {}
        );
      return typeof id === 'string' ? [{ id, tool: metadata?.awTools !== undefined }] : [];
    });
  }

  let ids = await live();
  const before = ids.length;
  const tools = ids.filter(({ tool }) => tool).length;
  log(
    `E2B sandboxes alive for workspace ${workspaceId} before the sweep: ${String(before)} ` +
      `(runtime=${String(before - tools)} tool=${String(tools)})`,
  );
  for (let poll = 0; ids.length > 0 && poll < polls; poll += 1) {
    await Promise.all(
      ids.map(async ({ id }) => {
        const response = await request(`${API}/sandboxes/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok && response.status !== 404) {
          throw new Error(`E2B refused to kill ${id} (${String(response.status)})`);
        }
      }),
    );
    ids = await live();
    if (ids.length > 0 && poll + 1 < polls) await delay(pollMs);
  }
  log(`E2B sandboxes alive for workspace ${workspaceId} after the sweep: ${String(ids.length)}`);
  return { before, after: ids.length };
}
