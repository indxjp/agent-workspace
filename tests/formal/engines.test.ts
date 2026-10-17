/**
 * Differential conformance for the `engines` family's **CLI** half (ENG-02c, #319), replayed
 * against the real `aw` binary through its public `main`/`CliIo` boundary.
 *
 * `apps/web/formal/engines.test.ts` replays the route and the contracts; this file replays
 * `cli.json` — the two halves of decision D-012, which puts a suite that imports application code
 * under `apps/<app>/formal/` and one that reaches a package through its exports here.
 *
 * What is proved is that the CLI is a *projection*: `aw engines list` prints every descriptor the
 * catalogue returned, in order, in every output mode, and `--engine` is either resolved against
 * that same catalogue or refused before anything is created.
 *
 * A disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 */
import { main, type CliIo } from '@indx-workspace/aw';
import { describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from './vectors.js';

const cliVectors = loadVectors('engines', 'cli.json');

const AGENT = '11111111-1111-4111-8111-111111111111';

const CLAUDE_CAPABILITIES = {
  mcp: true,
  skills: true,
  subagents: false,
  resume: true,
  fork: false,
  interrupt: true,
  streamingText: false,
  reasoning: true,
  maxTurns: 'native',
  maxBudget: 'native',
  wireProtocols: ['anthropic-messages'],
};

const POLICY = {
  engine: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
};

const AGENT_RESOURCE = {
  id: AGENT,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  name: 'Summariser',
  instructions: 'Summarise.',
  modelConnectionId: null,
  model: null,
  runtimeProfileId: null,
  permissions: {
    readFiles: false,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
  createdBy: null,
  ownerPrincipalId: 'a7367c68-ea61-4b03-bbf1-3cfd0fcac445',
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface Call {
  readonly url: URL;
  readonly method: string;
}

/** The control plane as these vectors describe it: one registered engine, one agent. */
function route(registry: readonly unknown[]): (call: Call) => Response {
  return ({ url, method }) => {
    if (url.pathname === '/api/engines') return json(200, { engines: registry });
    if (url.pathname === `/api/agents/${AGENT}/policy`) return json(200, { policy: POLICY });
    if (method === 'POST' && url.pathname === '/api/agents') return json(201, AGENT_RESOURCE);
    if (url.pathname === `/api/agents/${AGENT}`) return json(200, AGENT_RESOURCE);
    return json(500, { error: { code: 'unexpected', message: url.pathname } });
  };
}

async function runMain(
  argv: readonly string[],
  registry: readonly unknown[],
): Promise<{ code: number; stdout: string; stderr: string; calls: Call[] }> {
  const calls: Call[] = [];
  const answer = route(registry);
  let stdout = '';
  let stderr = '';
  const fetchDouble: typeof fetch = (input, init = {}) => {
    const call: Call = {
      url: input instanceof Request ? new URL(input.url) : new URL(input),
      method: init.method ?? 'GET',
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {
      AGENT_WORKSPACE_URL: 'https://aw.example.com',
      AGENT_WORKSPACE_API_KEY: 'ak_live_test',
    },
    homeDir: '/nonexistent-home',
    fetch: fetchDouble,
    isTty: false,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, calls };
}

/** The `{ id, displayName, version, installed }` projection the Lean model states. */
function projectDescriptor(value: unknown, what: string): Record<string, unknown> {
  const descriptor = asRecord(value, what);
  return {
    id: descriptor['id'],
    displayName: descriptor['displayName'],
    version: descriptor['version'],
    installed: descriptor['installed'],
  };
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}

function asStringArray(value: unknown, what: string): readonly string[] {
  return asArray(value, what).map((entry, index) => asString(entry, `${what}[${String(index)}]`));
}

/**
 * A registry the route can serve: the vector's own four-field descriptors, with the capabilities
 * `EngineDescriptorSchema` requires and the projection deliberately does not model.
 */
function servedRegistry(rows: readonly unknown[], what: string): readonly unknown[] {
  return rows.map((row, index) => ({
    ...projectDescriptor(row, `${what}[${String(index)}]`),
    capabilities: CLAUDE_CAPABILITIES,
  }));
}

describe('aw engines through the public main/CliIo boundary', () => {
  it.each(cliVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    const input = asRecord(vector.input, vector.id);
    const expected = asRecord(vector.expected, vector.id);

    if (vector.id.startsWith('list/')) {
      const rows = asArray(expected['rows'], `${vector.id} rows`);
      const registry = servedRegistry(
        asArray(input['registry'], `${vector.id} registry`),
        vector.id,
      );
      const argv = asStringArray(input['argv'], `${vector.id} argv`);

      const run = await runMain(argv, registry);

      expect(run.code).toBe(expected['exitCode']);
      expect(run.calls.map((call) => call.url.pathname)).toEqual(['/api/engines']);
      if (argv.includes('--json')) {
        const printed = asArray(JSON.parse(run.stdout) as unknown, `${vector.id} stdout`);
        expect(
          printed.map((entry, index) => projectDescriptor(entry, `${vector.id}[${index}]`)),
        ).toEqual(
          rows.map((entry, index) => projectDescriptor(entry, `${vector.id} expected[${index}]`)),
        );
        return;
      }
      // The table: one header line naming exactly the model's columns, then one line per row, in
      // the catalogue's order.
      const lines = run.stdout.trimEnd().split('\n');
      expect(lines[0]?.split(/\s\s+/u)).toEqual(
        asStringArray(expected['columns'], `${vector.id} columns`),
      );
      expect(lines).toHaveLength(rows.length + 2);
      for (const [index, row] of rows.entries()) {
        const id = asString(projectDescriptor(row, vector.id)['id'], `${vector.id} id`);
        expect(lines[index + 2]).toContain(id);
      }
      return;
    }

    // `engine-flag/*`: `--engine` is resolved against the catalogue, or refused with nothing
    // created. The outcome the model states decides which of the two the CLI must have done.
    const requested = input['requested'];
    const argv =
      requested === null
        ? ['agents', 'update', AGENT, '--name', 'Renamed']
        : ['agents', 'update', AGENT, '--engine', asString(requested, `${vector.id} requested`)];
    // The catalogue the vector is taken against, served exactly as the model states it.
    const registry = servedRegistry(asArray(input['registry'], `${vector.id} registry`), vector.id);
    const run = await runMain(argv, registry);
    const outcome = asString(expected['outcome'], `${vector.id} outcome`);
    const paths = run.calls.map((call) => `${call.method} ${call.url.pathname}`);

    if (outcome === 'absent') {
      // No flag: the catalogue is never read and the policy arm is left to the server.
      expect(run.code).toBe(0);
      expect(paths).toEqual([`PATCH /api/agents/${AGENT}`]);
      return;
    }
    if (outcome.startsWith('refused:')) {
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(outcome.slice('refused:'.length));
      // Refused before anything was written: the catalogue was read, and nothing else.
      expect(paths).toEqual(['GET /api/engines']);
      return;
    }
    expect(run.code).toBe(0);
    expect(paths).toEqual([
      'GET /api/engines',
      `GET /api/agents/${AGENT}`,
      `GET /api/agents/${AGENT}/policy`,
      `PUT /api/agents/${AGENT}/policy`,
    ]);
  });
});
