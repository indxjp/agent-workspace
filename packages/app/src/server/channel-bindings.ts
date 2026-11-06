/**
 * The channel bindings of a process (issue #1519): which `channel()` publishes the writes of which
 * resource. `resourceRoutes(resource, { publish })` and `resourceItemRoutes(resource, { publish })`
 * bind; the runtime's stores call {@link publishBoundWrite} as their `afterWrite` hook, in the
 * write's transaction, so a write through a generated route and one through an agent tool
 * (`mcpEndpoint`) both publish, and one that rolls back publishes nothing.
 *
 * Each written record is published to the key its `keyField` names (`channel` of a message), as
 * `{ type: 'created' | 'updated' | 'deleted', data: <the record> }`; a record whose key field is
 * empty is not published. Everyone the channel admits on that key (its resource's `read` access
 * on the key's record) sees every record published to it.
 *
 * The bindings live under a global registry key, as the recipe runner does, because a Next.js app
 * evaluates its route modules in more than one module graph of the one process.
 *
 * shortcut: a binding exists once a module that binds it has been evaluated in the process (a
 * route file of the resource, which the channel page loads before it subscribes), so an agent
 * write that reaches a freshly started process before any of those routes is not published;
 * upgrade by listing an app's channels in `defineApp`, so `mcpEndpoint` binds them itself.
 */
import type { AfterWrite } from '../db/port.js';
import { isPageResource } from '../pages/define-pages.js';
import type { DefinedResource } from '../resource.js';
import type { Channel } from './channel.js';

const BINDINGS_KEY = Symbol.for('agentworkspace.dev/app/channel-bindings');

type Registry = Record<symbol, Map<string, Map<string, Channel>> | undefined>;

/** The bindings of this process: the channels by name, by the resource name they publish. */
function bindings(): Map<string, Map<string, Channel>> {
  const registry = globalThis as unknown as Registry;
  let found = registry[BINDINGS_KEY];
  if (found === undefined) {
    found = new Map();
    registry[BINDINGS_KEY] = found;
  }
  return found;
}

/**
 * Makes `channel` publish every write of `resource`; binding the same channel again changes
 * nothing.
 *
 * @throws {TypeError} when `resource` is a `definePages` resource, whose page store does not run
 *   the `afterWrite` hook.
 */
export function bindChannel(resource: DefinedResource, channel: Channel): void {
  if (isPageResource(resource)) {
    throw new TypeError(
      `channel(): the pages resource ${resource.name} cannot publish its writes to a channel`,
    );
  }
  const all = bindings();
  const bound = all.get(resource.name) ?? new Map<string, Channel>();
  bound.set(channel.name, channel);
  all.set(resource.name, bound);
}

/** The channels bound to the resource named `resource`, for a test. */
export function boundChannels(resource: string): readonly Channel[] {
  return [...(bindings().get(resource)?.values() ?? [])];
}

/** Forgets every binding of this process; for a test. */
export function clearChannelBindings(): void {
  bindings().clear();
}

/** The `afterWrite` hook of the runtime's stores: publishes the write on each bound channel. */
export const publishBoundWrite: AfterWrite = async (tx, change) => {
  const bound = bindings().get(change.resource);
  if (bound === undefined) return;
  for (const channel of bound.values()) {
    const key = change.row[channel.keyField];
    if (typeof key !== 'string' || key === '') continue;
    await channel.publish(tx, {
      key,
      type: change.type,
      data: change.row,
      workspaceId: change.person.workspaceId,
    });
  }
};
