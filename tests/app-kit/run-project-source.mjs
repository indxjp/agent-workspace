/** The names the run generates. */
export const APP_NAME = 'desk';

export const PROJECT_NAME = 'desk-project';

export const SCRIPTED_MODEL = 'close-ticket';

/**
 * `source` with the resource's `agents` setting replaced by `{ read: true, write: ['status'] }`,
 * the one edit the developer makes to `resources/ticket.ts`. Throws when the generated line moved.
 *
 * @param {string} source
 */
export function withAgentWrite(source) {
  const line = '  agents: { read: true, write: false },';
  if (!source.includes(line)) throw new Error('resources/ticket.ts has no generated agents line');
  return source.replace(line, "  agents: { read: true, write: ['status'] },");
}

/**
 * `source` with its agent on the model `model` of the `default` connection: any `model:` line is
 * dropped and `model: { connection: 'default', id: '<model>' }` follows the agent's `name:` line.
 * Every agent of the project runs on a scripted model, so `aw dev` needs no provider key.
 *
 * @param {string} source @param {string} model
 */
export function withModel(source, model) {
  const without = source.replace(/^ {2}model: .*,\n/mu, '');
  const match = /^ {2}name: '[^']+',$/mu.exec(without);
  if (match === null) throw new Error('the agent file has no name line');
  const at = match.index + match[0].length;
  return `${without.slice(0, at)}\n  model: { connection: 'default', id: '${model}' },${without.slice(at)}`;
}

/**
 * The scripted model's turns: close the ticket through the app's tool, then say so.
 *
 * @param {string | undefined} ticketId undefined: a text-only placeholder, before the ticket exists
 */
export function closeTicketScript(ticketId) {
  if (ticketId === undefined) return { turns: [{ text: 'There is no ticket yet.' }] };
  return {
    turns: [
      {
        toolUses: [
          { name: `mcp__${APP_NAME}__ticket_update`, input: { id: ticketId, status: 'closed' } },
        ],
      },
      { text: 'Closed the ticket.' },
    ],
  };
}
