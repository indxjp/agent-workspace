import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ProductionGcp, ProjectDocument } from '@indx-workspace/contracts/project-file';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import { CLI_VERSION } from '../version.js';
import { gatherStatus, type StatusStack } from './gcp-status.js';
import { deployStatus } from './project.js';
import type { ToolInvocation, ToolResult, ToolRunner } from './runner.js';
import type { DeployContext } from './steps.js';

const GCP: ProductionGcp = { project: 'acme-prod', region: 'asia-northeast1' };
const STACK: StatusStack = {
  moduleDirectory: '/state/gcp-cloudrun',
  variablesFile: '/state/deploy/terraform/gcp-cloudrun.auto.tfvars.json',
  gcp: GCP,
  name: 'acme-ai',
};
const digest = (character: string) => `sha256:${character.repeat(64)}`;

interface Protection {
  readonly sql: boolean;
  readonly services: boolean;
  readonly bucketsForceDestroy: boolean;
}
const PROTECTED: Protection = { sql: true, services: true, bucketsForceDestroy: false };

function cloudRunService(
  name: string,
  image: string,
  env: readonly [string, string][],
  on: boolean,
) {
  return {
    type: 'google_cloud_run_v2_service',
    name,
    values: {
      deletion_protection: on,
      template: [
        {
          containers: [
            { image, env: env.map(([key, value]) => ({ name: key, value })) },
            { image: 'sidecar.example/proxy:1', env: [] },
          ],
        },
      ],
    },
  };
}

function stateJson(protection: Protection = PROTECTED): string {
  return JSON.stringify({
    format_version: '1.0',
    values: {
      root_module: {
        resources: [
          cloudRunService('web', `registry.example/web@${digest('1')}`, [], protection.services),
          cloudRunService(
            'gateway',
            `registry.example/gateway@${digest('2')}`,
            [],
            protection.services,
          ),
          cloudRunService(
            'runner_manager',
            `registry.example/runner@${digest('3')}`,
            [
              ['NODE_ENV', 'production'],
              [
                'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK',
                `registry.example/runtime@${digest('4')}`,
              ],
            ],
            protection.services,
          ),
          {
            type: 'google_sql_database_instance',
            name: 'main',
            values: { deletion_protection: protection.sql },
          },
          {
            type: 'google_storage_bucket',
            name: 'objects',
            values: { force_destroy: protection.bucketsForceDestroy },
          },
          {
            type: 'random_password',
            name: 'owner',
            values: { result: 'S3cretOwnerPassword-0123456789' },
          },
        ],
      },
    },
  });
}

function describeJson(
  ready: boolean,
  revisions: readonly [string, string] = ['r-2', 'r-2'],
): string {
  return JSON.stringify({
    status: {
      conditions: [
        { type: 'RoutesReady', status: 'True' },
        {
          type: 'Ready',
          status: ready ? 'True' : 'False',
          message: ready ? '' : 'Revision r-2 failed: container exited with status 1',
        },
      ],
      latestReadyRevisionName: revisions[0],
      latestCreatedRevisionName: revisions[1],
    },
  });
}

const planJson = (applyable: boolean, actions: readonly string[] = []): string =>
  JSON.stringify({
    format_version: '1.2',
    applyable,
    resource_changes: actions.map((action, index) => ({
      address: `google_x.y${String(index)}`,
      change: { actions: [action] },
    })),
  });

interface World {
  state: string;
  /** Per service name; absent means ready. */
  health: Record<string, string>;
  planExit: number;
  plan: string;
}

function world(overrides: Partial<World> = {}): World {
  return {
    state: stateJson(),
    health: {},
    planExit: 0,
    plan: planJson(false, ['no-op']),
    ...overrides,
  };
}

function fake(state: World) {
  const calls: ToolInvocation[] = [];
  const runner: ToolRunner = (invocation): Promise<ToolResult> => {
    calls.push(invocation);
    const args = invocation.args.filter((argument) => !argument.startsWith('-chdir='));
    const line = [invocation.tool, ...args].join(' ');
    const result = (stdout: string, status = 0): Promise<ToolResult> =>
      Promise.resolve({ status, stdout, stderr: '' });
    if (line === 'terraform show -json') return result(state.state);
    if (line.startsWith('terraform plan ')) return result('Plan: 1 to add.', state.planExit);
    if (line.startsWith('terraform show -json ')) return result(state.plan);
    if (line.startsWith('gcloud run services describe ')) {
      const service = args[3] ?? '';
      return result(state.health[service] ?? describeJson(true));
    }
    return Promise.resolve({ status: 1, stdout: '', stderr: `unexpected call: ${line}` });
  };
  return { runner, calls };
}

async function run(overrides: Partial<World> = {}) {
  const { runner, calls } = fake(world(overrides));
  const printed: string[] = [];
  const context: DeployContext = {
    runner,
    directory: '/state',
    env: {},
    cloud: 'gcp',
    out: (text) => void printed.push(text),
    err: (text) => void printed.push(text),
  };
  const report = await gatherStatus(context, STACK);
  return { report, calls, printed: printed.join('') };
}

describe('gatherStatus', () => {
  it('reports ready services and no drift as healthy', async () => {
    const { report } = await run();

    expect(report.ready).toBe(true);
    expect(report.changes).toBe(false);
    expect(report.text).toContain(`CLI        ${CLI_VERSION}`);
    expect(report.text).toContain(`web        registry.example/web@${digest('1')}`);
    expect(report.text).toContain(`gateway    registry.example/gateway@${digest('2')}`);
    expect(report.text).toContain(`runner-mgr registry.example/runner@${digest('3')}`);
    expect(report.text).toContain(`runtime    registry.example/runtime@${digest('4')}`);
    expect(report.text).toContain('acme-ai-web');
    expect(report.text).toContain('acme-ai-gateway');
    expect(report.text).toContain('acme-ai-runner-mgr');
    expect(report.text).toContain('ready  r-2');
    expect(report.text).toContain('Data protection: on');
    expect(report.text).toContain('Drift: none');
  });

  it('describes the three services in the project and region', async () => {
    const { calls } = await run();

    const described = calls
      .filter((call) => call.tool === 'gcloud')
      .map((call) => call.args.join(' '));
    expect(described).toEqual([
      'run services describe acme-ai-web --project acme-prod --region asia-northeast1 --format=json',
      'run services describe acme-ai-gateway --project acme-prod --region asia-northeast1 --format=json',
      'run services describe acme-ai-runner-mgr --project acme-prod --region asia-northeast1 --format=json',
    ]);
  });

  it('reports a service that is not ready with the condition message', async () => {
    const { report } = await run({ health: { 'acme-ai-gateway': describeJson(false) } });

    expect(report.ready).toBe(false);
    expect(report.text).toContain('acme-ai-gateway');
    expect(report.text).toContain('NOT READY  Revision r-2 failed: container exited with status 1');
  });

  it('reports a service whose latest created revision is not the ready one', async () => {
    const { report } = await run({
      health: { 'acme-ai-web': describeJson(true, ['r-1', 'r-2']) },
    });

    expect(report.ready).toBe(false);
    expect(report.text).toContain('latest ready r-1, latest created r-2');
  });

  it('reports a service gcloud cannot describe as not ready', async () => {
    const state = world();
    const { runner } = fake(state);
    const failing: ToolRunner = (invocation) =>
      invocation.tool === 'gcloud'
        ? Promise.resolve({ status: 1, stdout: '', stderr: 'ERROR: service not found\n' })
        : runner(invocation);

    const report = await gatherStatus(
      {
        runner: failing,
        directory: '/state',
        env: {},
        cloud: 'gcp',
        out: () => undefined,
        err: () => undefined,
      },
      STACK,
    );

    expect(report.ready).toBe(false);
    expect(report.text).toContain('ERROR: service not found');
  });

  it('counts a plan that exits 2 as drift', async () => {
    const { report } = await run({
      planExit: 2,
      plan: planJson(true, ['update', 'create', 'no-op']),
    });

    expect(report.changes).toBe(true);
    expect(report.text).toContain('Drift: 2 change(s); aw deploy production shows them');
  });

  it('counts a plan that exits 0 but that terraform show says is applyable as drift', async () => {
    const { report } = await run({ planExit: 0, plan: planJson(true, ['update']) });

    expect(report.changes).toBe(true);
    expect(report.text).toContain('Drift: 1 change(s)');
  });

  it('plans without locking the state and never applies or destroys', async () => {
    const { calls } = await run({ planExit: 2, plan: planJson(true, ['update']) });

    const terraform = calls.filter((call) => call.tool === 'terraform');
    const verbs = terraform.map((call) => call.args.find((argument) => !argument.startsWith('-')));
    expect(verbs).toEqual(['show', 'plan', 'show']);
    const plan = terraform.find((call) => call.args.includes('plan'));
    expect(plan?.args).toEqual(
      expect.arrayContaining([
        '-detailed-exitcode',
        '-lock=false',
        '-input=false',
        `-var-file=${STACK.variablesFile}`,
      ]),
    );
    for (const call of calls) {
      expect(call.args).not.toContain('apply');
      expect(call.args).not.toContain('destroy');
      expect(call.args).not.toContain('-destroy');
    }
  });

  it.each([
    ['on', PROTECTED, 'Data protection: on'],
    ['off', { sql: false, services: false, bucketsForceDestroy: true }, 'Data protection: off'],
    [
      'partial',
      { sql: true, services: false, bucketsForceDestroy: true },
      'Data protection: partial (off for google_cloud_run_v2_service.web, ' +
        'google_cloud_run_v2_service.gateway, google_cloud_run_v2_service.runner_manager, ' +
        'google_storage_bucket.objects)',
    ],
  ])('says data protection is %s', async (_name, protection, expected) => {
    const { report } = await run({ state: stateJson(protection) });

    expect(report.text).toContain(expected);
  });

  it('prints no value of the state beyond the images', async () => {
    const { report, printed } = await run();

    expect(report.text).not.toContain('S3cretOwnerPassword');
    expect(printed).not.toContain('S3cretOwnerPassword');
  });

  it('refuses output that is not a plan rather than reading it as empty', async () => {
    await expect(run({ plan: 'not json' })).rejects.toThrow('did not print JSON');
  });
});

describe('deployStatus', () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((entry) => rm(entry, { recursive: true, force: true })),
    );
  });

  async function project(): Promise<ProjectDocument> {
    const read = parseProjectFile(
      await readFile(
        new URL('./fixtures/production-gcp-cloudrun.project.yaml', import.meta.url),
        'utf8',
      ),
    );
    if (read.lifted) throw new Error('not a v2 project file');
    const production = read.project.environments.production;
    if (production === undefined) throw new Error('no production environment');
    return {
      ...read.project,
      environments: { ...read.project.environments, production: { ...production, gcp: GCP } },
    };
  }

  it('refuses when nothing was deployed from this machine, and runs no tool', async () => {
    const stateDirectory = await mkdtemp(path.join(os.tmpdir(), 'aw-gcp-status-'));
    temporary.push(stateDirectory);
    const { runner, calls } = fake(world());

    await expect(
      deployStatus({
        project: await project(),
        environment: 'production',
        stateDirectory,
        runner,
        env: {},
      }),
    ).rejects.toThrow(/Nothing was deployed from this machine.*aw deploy production/u);
    expect(calls).toEqual([]);
  });
});
