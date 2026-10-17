import { command, type Command } from '../command.js';

/**
 * The table columns. `capabilities` is deliberately not one of them: it is an object of ten
 * fields, and a table cell would render it as JSON nobody can read across. `--json` prints the
 * whole descriptor, capabilities included, which is the mode a caller inspecting them wants.
 */
const ENGINE_COLUMNS = ['id', 'displayName', 'version', 'installed'];

/**
 * §5.15 — `aw engines`. Read-only: an engine is installed by deploying an adapter, never through
 * the API, so there is no `create`, `update` or `remove` and there never will be one here.
 */
export const engineCommands: readonly Command[] = [
  command(
    'engines list',
    '',
    'Every engine this deployment can run an agent on',
    async ({ client, signal }) => ({
      value: await client.engines.list({ signal }),
      columns: ENGINE_COLUMNS,
    }),
  ),
];
