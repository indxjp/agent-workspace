import { appendFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, type Route } from '../testing.js';
import { dev } from './dev.test-support.js';
import {
  projectWithAgent,
  agentsRoute,
  workspaceRoute,
  DEFAULT_MODEL_YAML,
  GITHUB_YAML,
} from './dev.routes.test-support.js';

/** Edit the project file once `aw dev` has synced, and stop when `done` holds (issue #695). */
async function saveYaml(
  cwd: string,
  edit: (yaml: string) => string,
  done: (output: { readonly stdout: string; readonly stderr: string }) => boolean,
  { env = {}, route = workspaceRoute() }: { env?: Record<string, string>; route?: Route } = {},
) {
  let edited = false;
  return dev(cwd, {
    env,
    route,
    until: (output) => {
      if (!edited && output.stdout.includes('synced: ')) {
        edited = true;
        void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
          writeFile(path.join(cwd, 'agent-workspace.yaml'), edit(yaml)),
        );
      }
      return edited && done(output);
    },
  });
}

describe('aw dev applies the project file (issue #547): prints a refused policy widening', () => {
  it("prints the server's 403 policy_cannot_widen and keeps syncing on the next save (C14)", async () => {
    const cwd = await projectWithAgent();
    let dryRuns = 0;
    const route: Route = (request) => {
      if (request.method === 'POST' && request.url.pathname === '/api/agents') {
        const body = CreateAgentFromVersionRequestSchema.parse(request.json);
        if (body.dryRun === true) dryRuns += 1;
        if (body.dryRun === true && dryRuns === 1) {
          return json(403, {
            error: {
              code: 'policy_cannot_widen',
              message: 'the policy ceiling refuses it',
              details: ['permissions.runCommands'],
            },
          });
        }
      }
      return agentsRoute(request);
    };
    let saved = false;
    const { run } = await dev(cwd, {
      route,
      until: ({ stdout }) => {
        if (!saved && stdout.includes('403 policy_cannot_widen')) {
          saved = true;
          void appendFile(path.join(cwd, 'agents/assistant.ts'), '// saved again\n');
        }
        return stdout.includes('synced: ');
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(run.stdout).toContain(
      'agents/assistant.ts: 403 policy_cannot_widen [permissions.runCommands]\n',
    );
    expect(run.stdout).toContain('synced: "assistant" created at version 1');
  });
});

describe('aw dev applies the project file (issue #547): applies added resources', () => {
  it('applies a connector added to agent-workspace.yaml without a restart (#695)', async () => {
    const cwd = await projectWithAgent();
    const { run } = await saveYaml(
      cwd,
      (yaml) => `${yaml}${GITHUB_YAML}`,
      ({ stdout }) => stdout.includes('connectors.github: MCP tools'),
      { env: { ORDERS_TOKEN: 'orders-token-value' } },
    );
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const posts = run.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(posts).toHaveLength(1);
    // The runtime was forked with ORDERS_TOKEN in its environment: say so, once, as the only restart.
    expect(run.stderr).toContain(
      "ORDERS_TOKEN was in aw dev's environment when the runtime started; restart aw dev to withhold it from the runtime\n",
    );
    expect(run.stderr.match(/restart aw dev to withhold/gu)).toHaveLength(1);
    expect(JSON.stringify(run.stdout + run.stderr)).not.toContain('orders-token-value');
  });

  it('applies a model connection added to agent-workspace.yaml without a restart (#695)', async () => {
    const cwd = await projectWithAgent();
    const { run } = await saveYaml(
      cwd,
      (yaml) => `${yaml}${DEFAULT_MODEL_YAML}`,
      ({ stdout }) => stdout.split('model connection: default (anthropic)').length > 2,
      { env: { ANTHROPIC_API_KEY: 'sk-ant-test-live' } },
    );
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const posts = run.calls.filter(
      (call) => call.method === 'POST' && call.url.pathname === '/api/model-connections',
    );
    expect(posts).toHaveLength(2);
    expect(run.stderr).not.toContain('restart aw dev');
    expect(run.stdout + run.stderr).not.toContain('sk-ant-test-live');
  });
});

describe('aw dev applies the project file (issue #547): names a changed restart-only key', () => {
  it.each([
    [
      'environments.local.port',
      (yaml: string) => yaml.replace('cloud: local', 'cloud: local\n    port: 3999'),
    ],
    [
      'environments.local.runtime',
      (yaml: string) =>
        yaml.replace('cloud: local', 'cloud: local\n    runtime:\n      default: docker'),
    ],
    ['engine', (yaml: string) => `${yaml}engine: pi\n`],
    ['policy', (yaml: string) => `${yaml}policy:\n  permissions:\n    runCommands: false\n`],
    ['features', (yaml: string) => `${yaml}features: [chat, files]\n`],
  ])(
    'names a changed %s in one restart line and applies nothing for it (#695)',
    async (key, edit) => {
      const cwd = await projectWithAgent();
      const inner = workspaceRoute();
      let created = false;
      const { run } = await saveYaml(cwd, edit, ({ stderr }) => stderr.includes(`${key} changed`), {
        env: { ANTHROPIC_API_KEY: 'sk-ant-test-restart' },
        // The workspace keeps the default connection the start-up created.
        route: (request) => {
          const connections = request.url.pathname === '/api/model-connections';
          if (connections && request.method === 'POST') created = true;
          if (connections && request.method === 'GET' && created) {
            return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
          }
          return inner(request);
        },
      });
      expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
      expect(run.stderr).toContain(
        `agent-workspace.yaml: ${key} changed; restart aw dev to apply\n`,
      );
      expect(run.stderr.match(/restart aw dev to apply/gu)).toHaveLength(1);
      const writes = run.calls.filter(
        (call) =>
          call.method === 'POST' &&
          (call.url.pathname === '/api/connectors' ||
            call.url.pathname === '/api/model-connections'),
      );
      // Only the start-up default connection was created; the save sent nothing.
      expect(writes.filter((call) => call.url.pathname === '/api/connectors')).toEqual([]);
      expect(writes.filter((call) => call.url.pathname === '/api/model-connections')).toHaveLength(
        1,
      );
    },
  );
});

describe('aw dev applies the project file (issue #547): says an unset connector secret once', () => {
  it('says an unset connector secret once across two saves of the file (#695)', async () => {
    const cwd = await projectWithAgent();
    const controller = new AbortController();
    const inner = workspaceRoute();
    let lists = 0;
    let saves = 0;
    const { run } = await dev(cwd, {
      controller,
      route: (request) => {
        if (request.method === 'GET' && request.url.pathname === '/api/connectors') lists += 1;
        // The agents sync that follows the second apply: its notices are already printed.
        if (lists >= 2 && request.url.pathname.startsWith('/api/agents')) controller.abort();
        return inner(request);
      },
      until: ({ stdout, stderr }) => {
        if (saves === 0 && stdout.includes('synced: ')) {
          saves = 1;
          void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
            writeFile(path.join(cwd, 'agent-workspace.yaml'), `${yaml}${GITHUB_YAML}`),
          );
        } else if (saves === 1 && stderr.includes('ORDERS_TOKEN is not set:')) {
          saves = 2;
          void appendFile(path.join(cwd, 'agent-workspace.yaml'), '# again\n');
        }
        return false;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(lists).toBeGreaterThanOrEqual(2);
    expect(run.stderr.split('\n').filter((line) => line.includes('ORDERS_TOKEN'))).toHaveLength(1);
    expect(run.stderr).toContain('run export ORDERS_TOKEN=');
    expect(run.stderr).not.toContain('aw secrets');
  });
});

describe('aw dev applies the project file (issue #547): applies overlapping saves', () => {
  it('applies a second save of the file made while the first is still applying (#695)', async () => {
    const cwd = await projectWithAgent();
    const inner = workspaceRoute();
    let posts = 0;
    let started = false;
    const { run } = await dev(cwd, {
      env: { ORDERS_TOKEN: 'orders-token-value' },
      route: async (request) => {
        const created = request.method === 'POST' && request.url.pathname === '/api/connectors';
        if (created) posts += 1;
        if (created && posts === 1) {
          // A second save lands while this one is being applied.
          await appendFile(
            path.join(cwd, 'agent-workspace.yaml'),
            '  other:\n    url: https://mcp2.example.com\n',
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return inner(request);
      },
      until: ({ stdout }) => {
        if (stdout.includes('synced: ') && !started) {
          started = true;
          void readFile(path.join(cwd, 'agent-workspace.yaml'), 'utf8').then((yaml) =>
            writeFile(path.join(cwd, 'agent-workspace.yaml'), `${yaml}${GITHUB_YAML}`),
          );
        }
        return stdout.split('connectors.').length > 2;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const created = run.calls
      .filter((call) => call.method === 'POST' && call.url.pathname === '/api/connectors')
      .map((call) => JSON.stringify(call.json));
    expect(created.some((body) => body.includes('"other"'))).toBe(true);
  });
});

describe('aw dev applies the project file (issue #547): says a late secret once', () => {
  it('says a secret() named after it started once, and withholds it from later loaders', async () => {
    const cwd = await projectWithAgent();
    const late = `import { defineAgent, postgresTool, secret } from '@indx-workspace/sdk/define';
console.log('ENV ' + Object.keys(process.env).join(','));
const warehouse = postgresTool({ name: 'warehouse', url: secret('LATE_TOKEN'), readOnly: true, tables: ['public.orders'] });
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [warehouse] });
`;
    let step = 0;
    const { run } = await dev(cwd, {
      route: workspaceRoute(),
      until: ({ stdout, stderr }) => {
        if (step === 0 && stdout.includes('synced: ')) {
          step = 1;
          void writeFile(path.join(cwd, 'agents/assistant.ts'), late);
        } else if (step === 1 && stderr.includes('LATE_TOKEN is not set:')) {
          step = 2;
          void appendFile(path.join(cwd, 'agents/assistant.ts'), '// saved again\n');
        }
        return step === 2 && (stderr.match(/^ENV /gmu) ?? []).length >= 2;
      },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    // One line names it: the tool notice, not a second contradicting one.
    expect(
      run.stderr
        .split('\n')
        .filter((line) => line.includes('LATE_TOKEN') && !line.startsWith('ENV ')),
    ).toHaveLength(1);
    expect(run.stderr).not.toContain('aw secrets');
    // The runtime was forked withholding it: a later loader does not see it either.
    const envLines = run.stderr.split('\n').filter((line) => line.startsWith('ENV '));
    expect(envLines.at(-1)).not.toContain('LATE_TOKEN');
  });
});
