import { rm } from 'node:fs/promises';

import { createClient } from '@indx-workspace/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import type { CliIo } from '../io.js';
import { json, tempDirectory, tempFile } from '../testing.js';
import { checkProject, orderBySubagents } from './check.js';
import { formatProblem } from './problems.js';

/**
 * Issue #789: without `--yes`, `aw push` passes the catalog tools it would create as
 * `pendingConnectors`, and a dry run refused only for those connectors is accepted.
 */

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/** Checks a one-agent project against a server that refuses its dry run for `details`. */
async function check(details: readonly string[], pendingConnectors: ReadonlySet<string>) {
  const root = await tempDirectory();
  directories.push(root);
  await tempFile(
    root,
    'agents/assistant.ts',
    `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({ name: 'assistant', instructions: 'Help people.' });
`,
  );
  const fetchDouble = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const route = `${init?.method ?? 'GET'} ${new URL(href).pathname}`;
    if (route === 'GET /api/agents') return Promise.resolve(json(200, { agents: [] }));
    return Promise.resolve(
      json(422, {
        error: {
          code: 'agent_definition_references_missing',
          message: 'The definition names resources this workspace does not have.',
          details,
        },
      }),
    );
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    homeDir: root,
    fetch: fetchDouble,
    isTty: false,
  };
  const client = createClient({
    baseUrl: 'http://127.0.0.1:3000',
    auth: { kind: 'api-key', apiKey: `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}` },
    fetch: fetchDouble,
  });
  return checkProject({
    client,
    root,
    io,
    signal: new AbortController().signal,
    pendingConnectors,
  });
}

describe("checkProject's pendingConnectors (issue #789)", () => {
  it('accepts a dry run refused only for a pending connector', async () => {
    const report = await check(['connector:orders'], new Set(['orders']));
    expect(report.problems).toEqual([]);
    expect(report.agents.map((agent) => [agent.name, agent.number])).toEqual([['assistant', 1]]);
  });

  it('still reports the refusal when the connector is not pending', async () => {
    const report = await check(['connector:orders'], new Set());
    expect(report.problems.map(formatProblem)).toEqual([
      expect.stringContaining('agent_definition_references_missing [connector:orders]'),
    ]);
  });

  it('still reports the refusal when one of its details is not pending', async () => {
    const report = await check(['connector:orders', 'connector:billing'], new Set(['orders']));
    expect(report.problems.map(formatProblem)).toEqual([
      expect.stringContaining('agent_definition_references_missing'),
    ]);
    expect(report.agents).toEqual([]);
  });
});

describe('orderBySubagents', () => {
  const agent = (name: string, ...subagents: string[]) => ({
    name,
    body: { subagents: subagents.map((subagent) => ({ name: subagent })) },
  });
  const names = (result: ReturnType<typeof orderBySubagents>) =>
    'ordered' in result ? result.ordered.map((entry) => entry.name) : result.cycle;

  it('keeps alphabetical order when no agent names another', () => {
    expect(names(orderBySubagents([agent('c'), agent('a'), agent('b')]))).toEqual(['a', 'b', 'c']);
  });

  it('puts a subagent before its parent even when it sorts later; unknown names are ignored', () => {
    expect(names(orderBySubagents([agent('a', 'z', 'ghost'), agent('z')]))).toEqual(['z', 'a']);
  });

  it('answers the cycle from its alphabetically first agent, closed', () => {
    expect(names(orderBySubagents([agent('c', 'a'), agent('b', 'c'), agent('a', 'b')]))).toEqual([
      'a',
      'b',
      'c',
      'a',
    ]);
  });
});
