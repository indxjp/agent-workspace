import { BUILDER_CATALOG_KINDS } from '@indx-workspace/contracts/builder';

import type { CatalogKind } from '../ports';
import type { Executor } from './types';

/**
 * The `aw` command that lists each kind (packages/aw/src/commands). `files` has none while the
 * catalog does not list files.
 */
const AW_LIST_COMMANDS = {
  engines: 'aw engines list',
  models: 'aw models connections list',
  skills: 'aw skills list',
  connectors: 'aw connectors list',
  runtimeProfiles: 'aw runtimes profiles list',
} as const satisfies Record<Exclude<CatalogKind, 'files'>, string>;

/** Names and ids of what a definition can reference, as the catalog port returns them. */
export const catalogList: Executor<'catalog_list'> = async (call, ctx, ports) => {
  const wanted = call.input.kinds ?? BUILDER_CATALOG_KINDS;
  const kinds = BUILDER_CATALOG_KINDS.filter((kind) => wanted.includes(kind));
  const entries = await ports.catalog.list(ctx, kinds);
  const commands = kinds.flatMap((kind) => (kind === 'files' ? [] : [AW_LIST_COMMANDS[kind]]));
  // No listable kind asked (`[]` or only files): name every listing command, never an empty one.
  const awCommand = (commands.length > 0 ? commands : Object.values(AW_LIST_COMMANDS)).join(' && ');
  return { ok: true, entries, awCommand };
};
