import { readFile, rm } from 'node:fs/promises';

import {
  AgentVersionResourceSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, tempDirectory, tempFile, type Route } from '../testing.js';

/** Issue #797: the release workflow in guides/evaluations.mdx ("In CI") runs against a fake server. */

const AT = '2026-10-07T00:00:00.000Z';
const NAME = FIXTURES.agent.name;
const AGENT_PATH = `/api/agents/${IDS.agent}`;
const AGENT = { ...FIXTURES.agent, modelConnectionId: null };
const KEY_SECRET = '${{ secrets.AGENT_WORKSPACE_API_KEY }}';

const AGENT_FILE = `import { defineAgent } from '@indx-workspace/sdk/define';
export default defineAgent({ name: '${NAME}', instructions: 'Help people.' });
`;
const EVALS = `cases:
  - name: greets
    input: "Hello"
    expect: { contains: ["hello"] }
`;

interface Step {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** The `aw` steps of the "A release workflow" block, in the order the workflow runs them. */
async function releaseSteps(): Promise<readonly Step[]> {
  const page = await readFile(
    new URL('../../../../docs/sdk/site/guides/evaluations.mdx', import.meta.url),
    'utf8',
  );
  const accordion = page.split('<Accordion title="A release workflow')[1];
  const block = /```yaml[^\n]*\n([\s\S]*?)```/u.exec(accordion ?? '')?.[1];
  if (block === undefined) throw new Error('evaluations.mdx has no release workflow block');
  return block
    .split(/^ {6}- /mu)
    .slice(1)
    .flatMap((step) => {
      const run = /^run: npx aw (.+)$/mu.exec(step)?.[1];
      if (run === undefined) return [];
      const env = Object.fromEntries(
        [...step.matchAll(/^ {10}(\w+): (.+)$/gmu)].flatMap(([, key, value]) =>
          key === undefined || value === undefined ? [] : [[key, value] as const],
        ),
      );
      return [{ argv: run.split(' '), env }];
    });
}

function evaluation(version: number, score: number) {
  return {
    id: '88888888-8888-4888-8888-888888888888',
    agentId: IDS.agent,
    version,
    score,
    passed: score === 1 ? 1 : 0,
    total: 1,
    results: [
      {
        name: 'greets',
        passed: score === 1,
        runId: IDS.run,
        failures: score === 1 ? [] : ['contains: "hello"'],
      },
    ],
    createdAt: AT,
  };
}

/**
 * A control plane holding one agent: push saves a version and points `local` at it, an evaluation
 * scores `local`'s version, and a promote answers `promote`.
 */
function server(promote: () => Response, versions: AgentVersionResource[]): Route {
  return (request) => {
    const route = `${request.method} ${request.url.pathname}`;
    const local = versions.at(-1)?.number ?? null;
    if (route === 'GET /api/agents') return json(200, { agents: [AGENT] });
    if (route === `POST ${AGENT_PATH}/versions`) {
      const body = CreateAgentVersionRequestSchema.parse(request.json);
      if (body.dryRun === true) return json(200, { ok: true, number: versions.length + 1 });
      const version = AgentVersionResourceSchema.parse({
        id: `v-${String(versions.length + 1)}`,
        agentId: IDS.agent,
        workspaceId: IDS.workspace,
        number: versions.length + 1,
        summary: body.summary,
        via: body.via,
        body: body.body,
        createdByPrincipalId: IDS.principal,
        createdAt: AT,
      });
      versions.push(version);
      return json(201, version);
    }
    if (route === `GET ${AGENT_PATH}/versions`) {
      const pointers =
        local === null ? [] : [{ environment: 'local', number: local, updatedAt: AT }];
      return json(200, { items: versions, pointers, materialised: local });
    }
    if (route === `PUT ${AGENT_PATH}/pointers`) {
      const { version } = SetAgentPointerRequestSchema.parse(request.json);
      return json(200, {
        agent: AGENT,
        pointer: { environment: 'local', number: version, updatedAt: AT },
      });
    }
    if (route === `POST ${AGENT_PATH}/evaluation-runs`) {
      return json(202, { ...evaluation(local ?? 0, 1), status: 'completed' });
    }
    if (route === `GET ${AGENT_PATH}`) return json(200, AGENT);
    if (route === `GET ${AGENT_PATH}/policy`) return json(200, { policy: FIXTURES.policy });
    if (route === `GET ${AGENT_PATH}/resources`) {
      return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
    }
    if (route === `POST ${AGENT_PATH}/promote`) return promote();
    return json(404, { error: { code: 'not_found', message: route } });
  };
}

let project = '';

beforeAll(async () => {
  project = await tempDirectory();
  await tempFile(project, 'agents/assistant.ts', AGENT_FILE);
  await tempFile(project, `evals/${NAME}.yaml`, EVALS);
});

afterAll(async () => {
  await rm(project, { recursive: true, force: true });
});

describe('the release workflow in guides/evaluations.mdx (#797)', () => {
  it('pushes, evaluates and promotes, in that order, with the key from the repository secrets', async () => {
    const steps = await releaseSteps();

    expect(steps.map(({ argv }) => argv.slice(0, 4))).toEqual([
      ['push', '--yes'],
      ['eval', 'run', '--min-score', '0.9'],
      ['promote', '--yes'],
    ]);
    for (const { env } of steps) {
      expect(env['AGENT_WORKSPACE_API_KEY']).toBe(KEY_SECRET);
      expect(env['AGENT_WORKSPACE_URL']).toBe('${{ secrets.AGENT_WORKSPACE_URL }}');
    }
  });

  it('exits 0 for every step against a server that accepts the version', async () => {
    const versions: AgentVersionResource[] = [];
    const route = server(
      () => json(200, { environment: 'production', from: null, to: 1, saved: true, bar: 0.9 }),
      versions,
    );

    for (const { argv } of await releaseSteps()) {
      const run = await runCli(argv, { cwd: project, route });
      expect(run.stderr).toBe('');
      expect(run.code).toBe(EXIT_CODE.ok);
    }
    expect(versions).toHaveLength(1);
  });

  it('fails the job at promote when the deployment refuses a version below its bar', async () => {
    const versions: AgentVersionResource[] = [];
    const refusal = () =>
      json(422, {
        error: {
          code: 'promotion_gate_failed',
          message: 'refused',
          details: ['version:1', 'score:0.5', 'bar:0.9', 'case:greets'],
        },
      });
    const route = server(refusal, versions);
    const codes: number[] = [];

    for (const { argv } of await releaseSteps()) {
      const run = await runCli(argv, { cwd: project, route });
      codes.push(run.code);
      if (argv[0] === 'promote') expect(run.stderr).toContain('production refused');
    }

    expect(codes.slice(0, 2)).toEqual([EXIT_CODE.ok, EXIT_CODE.ok]);
    expect(codes[2]).not.toBe(EXIT_CODE.ok);
  });
});
