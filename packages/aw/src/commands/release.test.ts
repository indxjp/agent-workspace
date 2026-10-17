import { rm } from 'node:fs/promises';

import { ApiProblemError } from '@indx-workspace/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { promotionRefusalText } from './release.js';
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

/** Issue #615: `aw promote`, `aw rollback` and `aw versions`. */

const AT = '2026-10-04T00:00:00.000Z';
const NAME = FIXTURES.agent.name;
const PROMOTE_PATH = `/api/agents/${IDS.agent}/promote`;
const ROLLBACK_PATH = `/api/agents/${IDS.agent}/rollback`;

const LIST = {
  items: [],
  pointers: [
    { environment: 'local', number: 7, updatedAt: AT },
    { environment: 'production', number: 6, updatedAt: AT },
  ],
  materialised: 7,
  moves: [
    {
      environment: 'production',
      number: 6,
      reason: 'rollback',
      movedByPrincipalId: IDS.principal,
      movedAt: AT,
    },
    {
      environment: 'production',
      number: 7,
      reason: 'promote',
      movedByPrincipalId: IDS.principal,
      movedAt: AT,
    },
  ],
};

/** The agents by name, the version listing, and `answer` for a promote or rollback POST. */
function route(answer: (body: unknown) => Response): Route {
  return (request) => {
    const { pathname } = request.url;
    if (pathname === '/api/agents') return json(200, { agents: [FIXTURES.agent] });
    if (pathname === `/api/agents/${IDS.agent}/versions`) return json(200, LIST);
    if (request.method === 'POST') return answer(request.json);
    return json(404, { error: { code: 'not_found', message: pathname } });
  };
}

/** The move the server answers: `saved` exactly when the request was not a dry run. */
function moved(from: number, to: number): (body: unknown) => Response {
  return (body) => {
    const dryRun = typeof body === 'object' && body !== null && 'dryRun' in body;
    return json(200, { environment: 'production', from, to, saved: !dryRun });
  };
}

let project = '';

beforeAll(async () => {
  project = await tempDirectory();
  await tempFile(
    project,
    'agents/assistant.ts',
    `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({ name: '${NAME}', instructions: 'Help people.' });
`,
  );
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('aw promote', () => {
  it('without --yes sends only the dry run and prints the plan', async () => {
    const run = await runCli(['promote', NAME], { route: route(moved(6, 7)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    const posts = run.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => [call.url.pathname, call.json])).toEqual([
      [PROMOTE_PATH, { dryRun: true }],
    ]);
    expect(run.stdout).toBe('production: 6 -> 7; pass --yes to move it\n');
  });

  it('with --yes moves production and prints the move', async () => {
    const run = await runCli(['promote', NAME, '--yes'], { route: route(moved(6, 7)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    const posts = run.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => [call.url.pathname, call.json])).toEqual([[PROMOTE_PATH, {}]]);
    expect(run.stdout).toBe('production: 6 -> 7\n');
  });

  it('sends [version] and prints the server answer under --json', async () => {
    const run = await runCli(['promote', NAME, '3', '--yes', '--json'], {
      route: route(moved(6, 3)),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls.at(-1)?.json).toEqual({ version: 3 });
    expect(stdoutJson(run)).toEqual({
      environment: 'production',
      from: 6,
      to: 3,
      saved: true,
      bar: null,
    });
  });

  it('defaults the agent to the only one the project defines', async () => {
    const run = await runCli(['promote'], { cwd: project, route: route(moved(6, 7)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('production: 6 -> 7; pass --yes to move it\n');
  });

  it('refuses no [agent] in a project without agents, and sends nothing', async () => {
    const empty = await tempDirectory();
    try {
      const run = await runCli(['promote'], { cwd: empty, route: route(moved(6, 7)) });

      // Loading the project refuses it first, with the command that makes an agent.
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('no agents/*.ts in this directory');
      expect(run.stderr).toContain('aw init --yes');
      expect(run.calls).toEqual([]);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('refuses no [agent] in a project with two agents, naming both, and sends nothing', async () => {
    const two = await tempDirectory();
    try {
      for (const name of ['Alpha', 'Beta']) {
        await tempFile(
          two,
          `agents/${name.toLowerCase()}.ts`,
          `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({ name: '${name}', instructions: 'Help people.' });
`,
        );
      }
      const run = await runCli(['promote'], { cwd: two, route: route(moved(6, 7)) });

      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.stderr).toContain('missing <agent>');
      expect(run.stderr).toContain('Alpha, Beta');
      expect(run.calls).toEqual([]);
    } finally {
      await rm(two, { recursive: true, force: true });
    }
  });

  it('refuses a blank [agent], and sends nothing', async () => {
    const run = await runCli(['promote', ' ']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('<agent> must not be empty');
    expect(run.calls).toEqual([]);
  });

  it('refuses a lone version with a hint to name the agent first, and sends nothing', async () => {
    const run = await runCli(['promote', '7'], { cwd: project });

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('name the agent before [version]: aw promote <agent> 7');
    expect(run.calls).toEqual([]);
  });

  it('refuses a flag it would ignore, and sends nothing', async () => {
    const run = await runCli(['promote', NAME, '--summary', 'x']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('aw promote does not take --summary');
    expect(run.calls).toEqual([]);
  });

  it('refuses a third positional and sends nothing', async () => {
    const run = await runCli(['promote', NAME, '3', 'production']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls).toEqual([]);
  });

  it('prints a problem code it does not know, and exits 1', async () => {
    const run = await runCli(['promote', NAME, '--yes'], {
      route: route(() =>
        json(409, { error: { code: 'no_pointer', message: 'local points at no version.' } }),
      ),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe('error: no_pointer: local points at no version.\n');
  });
});

describe('aw promote: code tools (issue #693, ADR-0115)', () => {
  it('names the code tool the project declares, and says why production refuses', async () => {
    const withTool = await tempDirectory();
    try {
      await tempFile(
        withTool,
        'tools/get-order.ts',
        `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './get-order.run.ts',
});
`,
      );
      await tempFile(
        withTool,
        'agents/assistant.ts',
        `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';
export default defineAgent({ name: '${NAME}', instructions: 'Help.', tools: [getOrder] });
`,
      );
      // Another agent's tool must not be named for the promoted one.
      await tempFile(
        withTool,
        'tools/other.ts',
        `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'other_tool',
  description: 'Another',
  input: z.object({ id: z.string() }),
  run: './other.run.ts',
});
`,
      );
      await tempFile(
        withTool,
        'agents/other.ts',
        `import { defineAgent } from '@indx-workspace/sdk/define';
import other from '../tools/other.ts';
export default defineAgent({ name: 'Other agent', instructions: 'Help.', tools: [other] });
`,
      );
      const run = await runCli(['promote', NAME, '--yes'], {
        cwd: withTool,
        route: route(() =>
          json(422, {
            error: {
              code: 'code_tool_needs_host',
              message: 'Refused.',
              details: ['connector:aw-dev-tools', 'environment:production'],
            },
          }),
        ),
      });

      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toBe(
        'error: production refused: this version uses the code tool get_order, which this deployment cannot run\n' +
          'fix: ask the operator to enable the tool sandbox (AGENT_WORKSPACE_TOOL_HOST_IMAGE), or push again with aw push so every code tool is bundled\n',
      );
    } finally {
      await rm(withTool, { recursive: true, force: true });
    }
  });
});

describe('aw promote: the promotion gate (issue #619)', () => {
  const refused = (code: string, details: readonly string[]) =>
    route(() => json(409, { error: { code, message: 'Refused.', details } }));

  it('says when no bar is set, on stderr', async () => {
    const run = await runCli(['promote', NAME], {
      route: route(() =>
        json(200, { environment: 'production', from: 6, to: 7, saved: false, bar: null }),
      ),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('production: 6 -> 7; pass --yes to move it\n');
    expect(run.stderr).toBe('no promotion bar is set; production needs no evaluation\n');
  });

  it('prints nothing more when the move passed a bar', async () => {
    const run = await runCli(['promote', NAME, '--yes'], {
      route: route(() =>
        json(200, { environment: 'production', from: 6, to: 7, saved: true, bar: 0.9 }),
      ),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toBe('');
  });

  it('prints the refusal below the bar, the first three failing cases, and how to score again', async () => {
    const run = await runCli(['promote', NAME, '--yes'], {
      route: refused('promotion_gate_failed', [
        'version:8',
        'score:0.7',
        'bar:0.9',
        'case:no refund promises',
        'case:tone',
        'case:greets',
        'case:signs off',
      ]),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: production refused: v8 scored 0.70 (bar 0.90). Failing cases: ' +
        '"no refund promises", "tone", "greets", …\n' +
        `fix: run \`aw eval ${NAME} 8\` after fixing, then promote again\n`,
    );
  });

  it('prints the refusal of an unevaluated version, dry run included', async () => {
    const run = await runCli(['promote', NAME], {
      route: refused('promotion_not_evaluated', ['version:8', 'bar:1']),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: production refused: v8 has no evaluation (bar 1.00)\n' +
        `fix: run \`aw eval ${NAME} 8\` after fixing, then promote again\n`,
    );
  });
});

describe('aw promote: a bar edited while aw dev runs (issue #734)', () => {
  const LOCAL_ENV = {
    AGENT_WORKSPACE_URL: 'http://127.0.0.1:3000',
    AGENT_WORKSPACE_API_KEY: 'ak_live_test',
  };
  let gated = '';

  beforeAll(async () => {
    gated = await tempDirectory();
    await tempFile(
      gated,
      'agent-workspace.yaml',
      `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
policy:
  promotion:
    minEvalScore: 0.9
`,
    );
  });

  afterAll(async () => {
    await rm(gated, { recursive: true, force: true });
  });

  /** The server's move with `bar`, saved exactly when the request was not a dry run. */
  const withBar = (bar: number | null): Route =>
    route((body) => {
      const dryRun = typeof body === 'object' && body !== null && 'dryRun' in body;
      return json(200, { environment: 'production', from: 6, to: 7, saved: !dryRun, bar });
    });
  const posts = (run: { readonly calls: readonly { method: string; json: unknown }[] }) =>
    run.calls.filter((call) => call.method === 'POST').map((call) => call.json);

  it('refuses, naming both bars and the restart, and moves nothing', async () => {
    const run = await runCli(['promote', NAME, '--yes'], {
      cwd: gated,
      env: LOCAL_ENV,
      route: withBar(null),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toBe(
      'error: agent-workspace.yaml sets bar 0.90, but the running aw dev has no bar; production was not moved\n' +
        'fix: restart aw dev to apply agent-workspace.yaml, then run aw promote again\n',
    );
    expect(run.stderr).not.toContain('no promotion bar is set');
    expect(posts(run)).toEqual([{ dryRun: true }]);
  });

  it('moves after the dry run when the running bar is the file’s', async () => {
    const run = await runCli(['promote', NAME, '--yes'], {
      cwd: gated,
      env: LOCAL_ENV,
      route: withBar(0.9),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('production: 6 -> 7\n');
    expect(posts(run)).toEqual([{ dryRun: true }, {}]);
  });

  it('does not compare against a server the project file does not describe', async () => {
    const run = await runCli(['promote', NAME, '--yes'], { cwd: gated, route: withBar(null) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(posts(run)).toEqual([{}]);
  });
});

describe('promotionRefusalText (issue #619)', () => {
  const gateFailed = new ApiProblemError({
    status: 409,
    problem: {
      code: 'promotion_gate_failed',
      message: 'Refused.',
      details: ['version:2', 'score:0.5', 'bar:1', 'case:a'],
    },
  });

  it('quotes an agent name the shell would split', () => {
    expect(promotionRefusalText(gateFailed, 'Support triage')?.fix).toBe(
      'run `aw eval "Support triage" 2` after fixing, then promote again',
    );
  });

  it.each([
    ['0.8999', '0.9', 'scored 0.89 (bar 0.90)'],
    ['0.57', '0.9', 'scored 0.57 (bar 0.90)'],
  ])('rounds score %s down so it never prints at or above bar %s', (score, bar, shown) => {
    const refusal = promotionRefusalText(
      new ApiProblemError({
        status: 409,
        problem: {
          code: 'promotion_gate_failed',
          message: 'Refused.',
          details: ['version:8', `score:${score}`, `bar:${bar}`, 'case:a'],
        },
      }),
      'a',
    );
    expect(refusal?.message).toContain(shown);
  });

  it('answers null for any other failure', () => {
    expect(promotionRefusalText(new Error('boom'), 'a')).toBeNull();
  });
});

describe('aw rollback', () => {
  it('without --yes sends only the dry run and prints the plan', async () => {
    const run = await runCli(['rollback', NAME], { route: route(moved(7, 6)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    const posts = run.calls.filter((call) => call.method === 'POST');
    expect(posts.map((call) => [call.url.pathname, call.json])).toEqual([
      [ROLLBACK_PATH, { dryRun: true }],
    ]);
    expect(run.stdout).toBe('production: 7 -> 6; pass --yes to move it\n');
  });

  it('with --yes moves production back', async () => {
    const run = await runCli(['rollback', NAME, '--yes', '--json'], { route: route(moved(7, 6)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls.at(-1)?.json).toEqual({});
    expect(stdoutJson(run)).toEqual({
      environment: 'production',
      from: 7,
      to: 6,
      saved: true,
      bar: null,
    });
  });

  it('exits 1 with nothing_to_roll_back when there is no earlier version', async () => {
    const run = await runCli(['rollback', NAME, '--yes'], {
      route: route(() =>
        json(409, {
          error: { code: 'nothing_to_roll_back', message: 'production has no earlier version.' },
        }),
      ),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('nothing_to_roll_back');
  });

  it('refuses a second positional and sends nothing', async () => {
    const run = await runCli(['rollback', NAME, '3']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.calls).toEqual([]);
  });
});

describe('aw versions', () => {
  it('prints the pointers and the moves with the aw agents versions list renderer', async () => {
    const versions = await runCli(['versions', NAME], { route: route(moved(0, 0)) });
    const list = await runCli(['agents', 'versions', 'list', IDS.agent], {
      route: route(moved(0, 0)),
    });

    expect(versions.code).toBe(EXIT_CODE.ok);
    expect(versions.stdout).toBe(list.stdout);
    const lines = versions.stdout.split('\n');
    expect(lines).toContain('local -> 7');
    expect(lines).toContain('production -> 6');
    expect(versions.stdout).toMatch(/movedAt\s+environment\s+version\s+reason/u);
    expect(versions.stdout).toMatch(/production\s+6\s+rollback/u);
  });

  it('prints exactly the SDK value under --json', async () => {
    const run = await runCli(['versions', NAME, '--json'], { route: route(moved(0, 0)) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(stdoutJson(run)).toEqual({ ...LIST, evaluations: [] });
  });

  it('refuses an agent the workspace does not have', async () => {
    const run = await runCli(['versions', 'Nobody'], { route: route(moved(0, 0)) });

    expect(run.code).not.toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('no agent named "Nobody"');
  });
});
