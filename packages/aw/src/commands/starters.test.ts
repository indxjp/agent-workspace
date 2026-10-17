import { rm } from 'node:fs/promises';
import path from 'node:path';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { readEvalCaseFile, renderProjectFiles } from '@indx-workspace/sdk/project';
import { afterAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { fakeReplyText } from '../../../../tests/generated-project/fake-anthropic.mjs';
import { FIXTURES, IDS, json, runCli, tempDirectory, tempFile } from '../testing.js';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A theme's starter rendered into a temporary project directory. */
async function starter(theme: 'support' | 'copilot' | 'automation') {
  const answers = withRecommendedAnswers({ 'setup.theme': theme });
  const files = renderProjectFiles(answers, { name: 'ops', version: '0.4.0' });
  const root = await tempDirectory();
  directories.push(root);
  for (const file of files) await tempFile(root, file.path, file.contents);
  return { root, files, agent: answers['content.agentName'] };
}

describe('the automation starter', () => {
  it('is complete: a code tool, an API tool and its fake API, a README and an eval file', async () => {
    const { files, agent } = await starter('automation');
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        `agents/${agent}.ts`,
        'tools/delivery-estimate.ts',
        'tools/delivery-estimate.run.ts',
        'tools/orders.ts',
        'fake-api/server.ts',
        'fake-api/openapi.json',
        'README.md',
        `evals/${agent}.yaml`,
      ]),
    );
    const readme = files.find((file) => file.path === 'README.md')?.contents ?? '';
    expect(readme).toContain(`agents/${agent}.ts`);
    expect(readme).not.toContain('{{');
    const agentFile = files.find((file) => file.path === `agents/${agent}.ts`)?.contents ?? '';
    expect(agentFile).toContain("import deliveryEstimateTool from '../tools/delivery-estimate';");
    expect(agentFile).toContain("import ordersTool from '../tools/orders';");
  });

  it('passes aw check, reporting the code tool and the agent', async () => {
    const { root, agent } = await starter('automation');
    const run = await runCli(['check'], {
      cwd: root,
      route: ({ method, url }) => {
        // The connector routes: the list, and the tool dry-run of `tools/orders.ts`.
        if (url.pathname.startsWith('/api/connectors')) {
          return method === 'GET'
            ? json(200, { connectors: [] })
            : json(200, {
                ok: true,
                kind: 'ok',
                message: 'The openapi connector is valid; nothing was saved.',
                serverName: 'Orders',
                serverVersion: null,
                toolCount: 1,
              });
        }
        // No bundle is stored yet: a push would upload the code tool's.
        if (url.pathname.startsWith('/api/tool-bundles/')) {
          return json(404, { error: { code: 'tool_bundle_not_found', message: 'no bundle' } });
        }
        return method === 'GET' ? json(200, { agents: [] }) : json(200, { ok: true, number: 1 });
      },
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain('tools/orders.ts: orders (openapi) ok');
    expect(run.stdout).toContain('tools/delivery-estimate.ts: delivery_estimate (code) ok');
    expect(run.stdout).toMatch(/tools\/delivery-estimate\.ts: tool bundle "delivery_estimate" \(/u);
    expect(run.stdout).toContain(`agents/${agent}.ts: ok (would be version 1)`);
  });

  it('has an eval file whose three cases the eval schema accepts', async () => {
    const { files, agent } = await starter('automation');
    const file = files.find((candidate) => candidate.path === `evals/${agent}.yaml`);
    const parsed = readEvalCaseFile(file?.contents ?? '', file?.path ?? '');
    expect(parsed.cases).toHaveLength(3);
    expect(path.basename(file?.path ?? '')).toBe(`${agent}.yaml`);
  });
});

describe('the support and copilot starters', () => {
  it('support: renders an example skill, a README, feedback and evals, and passes aw check', async () => {
    const { root, files, agent } = await starter('support');
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(['skills/refund-policy/SKILL.md', 'README.md', `evals/${agent}.yaml`]),
    );
    expect(files.find((file) => file.path === 'surfaces/main.ts')?.contents).toContain(
      'feedback: true',
    );
    const run = await runCli(['check'], {
      cwd: root,
      route: ({ method, url }) => {
        if (url.pathname === '/api/skills') return json(200, { skills: [] });
        return method === 'GET' ? json(200, { agents: [] }) : json(200, { ok: true, number: 1 });
      },
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain(`agents/${agent}.ts: ok`);
  });

  it('copilot: renders a Vite page on @indx-workspace/react, a README and evals, and passes aw check', async () => {
    const { root, files, agent } = await starter('copilot');
    const main = files.find((file) => file.path === 'web/main.jsx')?.contents ?? '';
    expect(main).toContain("import '@indx-workspace/react/styles.css';");
    expect(main).toContain('<Chat');
    expect(main).not.toContain('{{');
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['web/package.json', 'README.md', `evals/${agent}.yaml`]),
    );
    expect(files.map((file) => file.path).filter((each) => each.includes('.template'))).toEqual([]);
    const run = await runCli(['check'], {
      cwd: root,
      route: ({ method }) =>
        method === 'GET' ? json(200, { agents: [] }) : json(200, { ok: true, number: 1 }),
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain(`agents/${agent}.ts: ok`);
  });

  it.each(['support', 'copilot'] as const)(
    '%s: its eval file has cases the schema accepts',
    async (theme) => {
      const { files, agent } = await starter(theme);
      const file = files.find((candidate) => candidate.path === `evals/${agent}.yaml`);
      expect(
        readEvalCaseFile(file?.contents ?? '', file?.path ?? '').cases.length,
      ).toBeGreaterThanOrEqual(2);
    },
  );
});

describe('the starters evals', () => {
  // automation's tool case needs a tool-calling fake; FH-13 covers it.
  it.each(['support', 'copilot'] as const)(
    '%s: every case passes against the fake reply',
    async (theme) => {
      const { root, agent } = await starter(theme);
      const run = await runCli(['eval', agent], {
        cwd: root,
        route: ({ method, url, json: body }) => {
          if (url.pathname === '/api/agents')
            return json(200, { agents: [{ ...FIXTURES.agent, name: agent }] });
          if (url.pathname.endsWith('/versions')) {
            return json(200, {
              items: [],
              pointers: [
                { environment: 'local', number: 1, updatedAt: '2026-10-04T00:00:00.000Z' },
              ],
              materialised: 1,
            });
          }
          if (method !== 'POST')
            return json(404, { error: { code: 'not_found', message: url.pathname } });
          const cases = (
            body as {
              cases: {
                name: string;
                input: string;
                expect: { contains?: string[]; notContains?: string[] };
              }[];
            }
          ).cases;
          const results = cases.map((each) => {
            const reply = fakeReplyText(each.input);
            const failures = [
              ...(each.expect.contains ?? []).filter((text) => !reply.includes(text)),
              ...(each.expect.notContains ?? []).filter((text) => reply.includes(text)),
            ];
            return { name: each.name, passed: failures.length === 0, runId: IDS.run, failures };
          });
          const passed = results.filter((result) => result.passed).length;
          return json(202, {
            id: '88888888-8888-4888-8888-888888888888',
            status: 'completed',
            agentId: IDS.agent,
            version: 1,
            score: passed / results.length,
            passed,
            total: results.length,
            results,
            createdAt: '2026-10-04T00:00:00.000Z',
          });
        },
      });
      expect(run.stderr).toBe('');
      expect(run.code).toBe(EXIT_CODE.ok);
    },
  );
});
