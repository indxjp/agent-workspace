import { command, type Command } from '../command.js';

/**
 * §5.2's "Who am I" row — `aw me`, and the first thing a newly configured CLI should be asked.
 *
 * No `columns`: a principal is one resource, so `renderRecord` prints it as a `field  value`
 * listing in the contract's own field order, and a column list here would be a second, silently
 * divergent copy of that order.
 */
export const meCommands: readonly Command[] = [
  command(
    'me',
    '',
    'The workspace, role and principal this credential resolves to',
    async ({ client, signal }) => ({ value: await client.me({ signal }) }),
  ),
];
