import { PROJECT_LIST_FILTERS } from '@indx-workspace/contracts/projects';

import { command, enumValue, positional, readBody, value, type Command } from '../command.js';
import { CreateProjectBody, UpdateProjectBody } from '../inputs.js';

const PROJECT_COLUMNS = ['id', 'name', 'visibility', 'defaultAgentId', 'archivedAt', 'updatedAt'];

/** §5.10 — `aw projects`. */
export const projectCommands: readonly Command[] = [
  command(
    'projects list',
    '[--archived active|archived|all]',
    'Active projects, or archived ones, or all',
    async (context) => {
      const archived = enumValue(context, 'archived', PROJECT_LIST_FILTERS);
      return {
        value: await context.client.projects.list(archived === undefined ? {} : { archived }, {
          signal: context.signal,
        }),
        columns: PROJECT_COLUMNS,
      };
    },
  ),
  command('projects get', '<id>', 'One project', async (context) => ({
    value: await context.client.projects.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'projects create',
    '--file <json> [--name <name>]',
    'Create a project',
    async (context) => ({
      value: await context.client.projects.create(
        await readBody(context, CreateProjectBody, { name: value(context, 'name') }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'projects update',
    '<id> [--file <json>] [--name <name>]',
    'Change a project',
    async (context) => ({
      value: await context.client.projects.update(
        positional(context, 0, 'id'),
        await readBody(context, UpdateProjectBody, { name: value(context, 'name') }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'projects archive',
    '<id>',
    'Retire a project; it keeps its history',
    async (context) => ({
      value: await context.client.projects.archive(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command('projects restore', '<id>', 'Bring an archived project back', async (context) => ({
    value: await context.client.projects.restore(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'projects start-session',
    '<id> [agent-id]',
    'Open a session attributed to the project',
    async (context) => {
      const agentId = context.positionals[1];
      return {
        value: await context.client.projects.startSession(
          positional(context, 0, 'id'),
          agentId === undefined ? {} : { agentId },
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'projects adopt-session',
    '<id> <session-id>',
    'Move an existing session into the project',
    async (context) => ({
      value: await context.client.projects.adoptSession(
        positional(context, 0, 'id'),
        positional(context, 1, 'session-id'),
        { signal: context.signal },
      ),
    }),
  ),
];
