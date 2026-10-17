import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  type AgentDefinition,
} from '@indx-workspace/contracts/agents';

import { EXIT_CODE } from '../output.js';
import {
  FIXTURES,
  IDS,
  json,
  runCli,
  stdoutJson,
  tempDirectory,
  tempFile,
  type Route,
} from '../testing.js';

/** Issue #452 (S1-14): `aw agents versions list|create` and `aw agents pointers set`. */

const AT = '2026-10-02T00:00:00.000Z';

const definition: AgentDefinition = {
  apiVersion: AGENT_DEFINITION_API_VERSION,
  kind: AGENT_DEFINITION_KIND,
  agent: {
    name: 'Summariser',
    instructions: 'Summarise.',
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    model: 'claude-x',
    modelConnectionName: 'anthropic',
    runtimeProfileName: null,
  },
  policy: {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: ['Bash'],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  },
  policySource: 'stored',
  resources: { files: [], skills: [], connectors: [] },
};

const body = { definition, surfaces: [] };

function versionResource(number: number, summary: string) {
  return {
    id: `99999999-9999-4999-8999-00000000000${String(number)}`,
    agentId: IDS.agent,
    workspaceId: IDS.workspace,
    number,
    summary,
    via: 'api',
    body,
    createdByPrincipalId: IDS.principal,
    createdAt: AT,
  };
}

const LIST = {
  items: [versionResource(1, 'First version'), versionResource(2, 'Second version')],
  pointers: [{ environment: 'local', number: 1, updatedAt: AT }],
  materialised: 1,
};

const VERSIONS_PATH = `/api/agents/${IDS.agent}/versions`;
const POINTERS_PATH = `/api/agents/${IDS.agent}/pointers`;

let directory = '';
let bodyFile = '';
let invalidBodyFile = '';

beforeAll(async () => {
  directory = await tempDirectory();
  bodyFile = await tempFile(directory, 'body.json', JSON.stringify(body));
  invalidBodyFile = await tempFile(
    directory,
    'invalid.json',
    JSON.stringify({ definition: { ...definition, kind: 'Nope' } }),
  );
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Every request the double saw that could change something. */
function writes(calls: readonly { readonly method: string; readonly json: unknown }[]) {
  return calls.filter((call) => {
    if (call.method === 'GET') return false;
    if (call.method !== 'POST') return true;
    const sent = call.json;
    return !(typeof sent === 'object' && sent !== null && 'dryRun' in sent && sent.dryRun === true);
  });
}

describe('aw agents versions list', () => {
  const route: Route = () => json(200, LIST);

  it('prints the versions as a table and one line per pointer', async () => {
    const run = await runCli(['agents', 'versions', 'list', IDS.agent], { route });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.calls[0]?.url.pathname).toBe(VERSIONS_PATH);
    const lines = run.stdout.split('\n');
    expect(lines[0]).toMatch(/^number\s+summary\s+via\s+createdAt\s+score$/u);
    expect(run.stdout).toContain('First version');
    expect(run.stdout).toContain('Second version');
    expect(lines).toContain('local -> 1');
  });

  it("shows each version's newest score, and — when it has none (issue #736)", async () => {
    const evaluations = [{ version: 2, score: 0.5, passed: 1, total: 2 }];
    const run = await runCli(['agents', 'versions', 'list', IDS.agent], {
      route: () => json(200, { ...LIST, evaluations }),
    });
    const rows = run.stdout.split('\n');
    expect(rows.find((row) => row.includes('First version'))).toMatch(/ — *$/u);
    expect(rows.find((row) => row.includes('Second version'))).toMatch(/ 0\.50 *$/u);
  });

  it('prints exactly the SDK value under --json', async () => {
    const run = await runCli(['agents', 'versions', 'list', IDS.agent, '--json'], { route });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({ ...LIST, moves: [], evaluations: [] });
  });

  it('says so when there are no versions and no pointers', async () => {
    const run = await runCli(['agents', 'versions', 'list', IDS.agent], {
      route: () => json(200, { items: [], pointers: [], materialised: null }),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('(no versions)');
    expect(run.stdout).toContain('(no pointers)');
  });
});

describe('aw agents versions create', () => {
  it('without --yes sends exactly one dry-run POST and prints the number it would get', async () => {
    const run = await runCli(['agents', 'versions', 'create', IDS.agent, '--file', bodyFile], {
      route: () => json(200, { ok: true, number: 3 }),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.url.pathname).toBe(VERSIONS_PATH);
    expect(run.calls[0]?.json).toEqual({
      body,
      summary: 'aw agents versions create',
      via: 'api',
      dryRun: true,
    });
    expect(writes(run.calls)).toEqual([]);
    expect(run.stdout).toBe('would be saved as version 3; pass --yes to save\n');
  });

  it('without --yes prints the check response under --json', async () => {
    const run = await runCli(
      ['agents', 'versions', 'create', IDS.agent, '--file', bodyFile, '--json'],
      { route: () => json(200, { ok: true, number: 3 }) },
    );

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({ ok: true, number: 3 });
  });

  it('with --yes sends one POST without dryRun, via api, with the given summary', async () => {
    const saved = versionResource(3, 'Tighter limits');
    const run = await runCli(
      [
        'agents',
        'versions',
        'create',
        IDS.agent,
        '--file',
        bodyFile,
        '--summary',
        'Tighter limits',
        '--yes',
        '--json',
      ],
      { route: () => json(201, saved) },
    );

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.json).toEqual({ body, summary: 'Tighter limits', via: 'api' });
    expect(stdoutJson(run)).toEqual(saved);
  });

  it('reads the body from stdin with --file -', async () => {
    const run = await runCli(['agents', 'versions', 'create', IDS.agent, '--file', '-'], {
      stdin: JSON.stringify(body),
      route: () => json(200, { ok: true, number: 1 }),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.json).toMatchObject({ body, dryRun: true });
  });

  it('prints the code and details of a 422 and exits 1', async () => {
    const run = await runCli(['agents', 'versions', 'create', IDS.agent, '--file', bodyFile], {
      route: () =>
        json(422, {
          error: {
            code: 'engine_capability_unsupported',
            message: 'The engine cannot run MCP servers.',
            details: ['mcp'],
          },
        }),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('engine_capability_unsupported');
    expect(run.stderr).toContain('  mcp');
  });

  it('refuses an invalid body with exit 2 and sends nothing', async () => {
    const run = await runCli([
      'agents',
      'versions',
      'create',
      IDS.agent,
      '--file',
      invalidBodyFile,
    ]);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('invalid body');
    expect(run.calls).toEqual([]);
  });

  it('refuses an invalid --summary with exit 2 and sends nothing', async () => {
    for (const summary of [' padded', 'x'.repeat(201), 'two\nlines']) {
      const run = await runCli([
        'agents',
        'versions',
        'create',
        IDS.agent,
        '--file',
        bodyFile,
        `--summary=${summary}`,
      ]);

      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('--summary');
      expect(run.calls).toEqual([]);
    }
  });
});

describe('aw agents pointers set', () => {
  it('without --yes sends only a GET and shows the move', async () => {
    const run = await runCli(['agents', 'pointers', 'set', IDS.agent, 'local', '2'], {
      route: () => json(200, LIST),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.calls[0]?.url.pathname).toBe(VERSIONS_PATH);
    expect(run.stdout).toBe('local: 1 -> 2; pass --yes to move it\n');
  });

  it('without --yes names "none" when the environment has no pointer yet', async () => {
    const run = await runCli(['agents', 'pointers', 'set', IDS.agent, 'local', '1', '--json'], {
      route: () => json(200, { items: LIST.items, pointers: [], materialised: null }),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({ environment: 'local', from: null, to: 1, saved: false });
    expect(writes(run.calls)).toEqual([]);
  });

  it('with --yes sends one PUT with the environment and version', async () => {
    const answer = {
      agent: FIXTURES.agent,
      pointer: { environment: 'local', number: 2, updatedAt: AT },
    };
    const run = await runCli(
      ['agents', 'pointers', 'set', IDS.agent, 'local', '2', '--yes', '--json'],
      { route: () => json(200, answer) },
    );

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('PUT');
    expect(run.calls[0]?.url.pathname).toBe(POINTERS_PATH);
    expect(run.calls[0]?.json).toEqual({ environment: 'local', version: 2 });
    expect(stdoutJson(run)).toEqual(answer);
  });

  it('refuses an unknown environment with exit 2, listing the allowed ones', async () => {
    const run = await runCli(['agents', 'pointers', 'set', IDS.agent, 'preview', '2', '--yes']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('<environment> must be one of local, production');
    expect(run.calls).toEqual([]);
  });

  it('refuses a version that is not a positive integer with exit 2', async () => {
    for (const version of ['0', '-1', '1.5', 'two', '1e2', '2147483648']) {
      const run = await runCli(['agents', 'pointers', 'set', IDS.agent, 'local', version, '--yes']);

      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('<version> must be a positive integer');
      expect(run.calls).toEqual([]);
    }
  });

  it('refuses a missing version with exit 2', async () => {
    const run = await runCli(['agents', 'pointers', 'set', IDS.agent, 'local']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('missing <version>');
    expect(run.calls).toEqual([]);
  });
});
