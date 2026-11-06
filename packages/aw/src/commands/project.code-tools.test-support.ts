import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { json, stdoutJson, tempFile, type CliRun } from '../testing.js';
import {
  aw,
  CODE_TOOL_PROJECT,
  emptyServer,
  problem,
  project,
  requests,
  server,
  writes,
} from './project.fixture.test-support.js';

export function describeProjectCodeTools(): void {
  const uploads = (run: CliRun): readonly string[] =>
    requests(run).filter((call) => call === 'POST /api/tool-bundles');

  it('uploads the bundle once and pins its digest in the saved version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toHaveLength(1);
    expect(state.connectors.map(({ name, url }) => [name, url])).toEqual([
      ['aw-dev-tools', 'https://tool-sandbox.invalid/mcp'],
    ]);
    expect(stdoutJson(run)).toMatchObject({
      tools: [{ file: 'tools/get-order.ts', name: 'aw-dev-tools', action: 'create' }],
    });
    const [bundle] = (stdoutJson(run) as { bundles: { digest: string; saved: boolean }[] }).bundles;
    expect(bundle).toMatchObject({ tool: 'get_order', action: 'upload', saved: true });
    expect([...state.bundles]).toEqual([bundle?.digest]);
    expect(state.versions[0]?.body.toolBundles).toMatchObject([
      {
        tool: 'get_order',
        digest: bundle?.digest,
        description: 'Look up an order',
        inputSchema: { type: 'object' },
        timeoutMs: 30_000,
      },
    ]);
    // A tool that declares no network pins no domain: aw never injects a default (issue #827).
    expect(state.versions[0]?.body.toolBundles?.[0]).not.toHaveProperty('allowedDomains');
  });

  it('pins the secrets and allowed domains a tool declares, never a value', async () => {
    const root = await project({
      ...CODE_TOOL_PROJECT,
      'tools/get-order.ts': CODE_TOOL_PROJECT['tools/get-order.ts']
        .replace('{ defineTool, z }', '{ defineTool, secret, z }')
        .replace(
          "run: './tools/get-order.run.ts',",
          "run: './tools/get-order.run.ts',\n  secrets: [secret('ORDERS_API_KEY')],\n  allowedDomains: ['api.example.com'],",
        ),
    });
    const state = emptyServer();
    const run = await aw(root, ['push', '--yes', '--json'], server(state), {
      env: {
        AGENT_WORKSPACE_URL: 'https://aw.example.com',
        AGENT_WORKSPACE_API_KEY: 'ak_live_test',
        ORDERS_API_KEY: 'orders-key',
      },
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(state.versions[0]?.body.toolBundles?.[0]).toMatchObject({
      tool: 'get_order',
      secrets: ['ORDERS_API_KEY'],
      allowedDomains: ['api.example.com'],
    });
    expect(JSON.stringify(state.versions[0]?.body)).not.toContain('orders-key');
  });

  it('a second push of the same source uploads nothing and saves no version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    await aw(root, ['push', '--yes'], server(state));
    const run = await aw(root, ['push', '--yes', '--json'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toEqual([]);
    expect(writes(run)).toEqual([]);
    expect(state.versions).toHaveLength(1);
    expect(stdoutJson(run)).toMatchObject({
      bundles: [{ tool: 'get_order', action: 'unchanged', saved: false }],
      agents: [{ action: 'none' }],
    });
  });

  it('changing an imported module gives a new digest, a new upload and a new version', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    await aw(root, ['push', '--yes'], server(state));
    await tempFile(
      root,
      'tools/shout.ts',
      'export const shout = (text: string): string => text.toLowerCase();\n',
    );
    const run = await aw(root, ['push', '--yes'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(uploads(run)).toHaveLength(1);
    expect(state.bundles.size).toBe(2);
    expect(state.versions).toHaveLength(2);
  });

  it('without --yes sends no upload and accepts the dry run that waits on it', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const state = emptyServer();
    const run = await aw(root, ['push'], server(state));
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(writes(run)).toEqual([]);
    expect(run.stdout).toContain('would be uploaded');
    expect(state.bundles.size).toBe(0);
  });

  it('refuses a run file that is not there before anything is uploaded or saved', async () => {
    const root = await project({
      'agents/assistant.ts': CODE_TOOL_PROJECT['agents/assistant.ts'],
      'tools/get-order.ts': CODE_TOOL_PROJECT['tools/get-order.ts'],
    });
    const run = await aw(root, ['push', '--yes', '--json'], server(emptyServer()));
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      saved: false,
      problems: [{ file: 'tools/get-order.ts', code: 'tool_run_file_missing' }],
    });
    expect(writes(run)).toEqual([]);
  });

  it('reports a version the server refuses for an unknown digest as that agent problem', async () => {
    const root = await project(CODE_TOOL_PROJECT);
    const digest = 'a'.repeat(64);
    const run = await aw(root, ['push', '--yes', '--json'], (request) => {
      if (request.url.pathname.startsWith('/api/tool-bundles')) {
        return json(200, { bundle: { digest, sizeBytes: 1 } });
      }
      if (request.url.pathname === '/api/connectors') return json(200, { connectors: [] });
      return request.method === 'GET'
        ? json(200, { agents: [] })
        : problem(422, 'tool_bundle_unknown', [`tool_bundle:${digest}`]);
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(stdoutJson(run)).toMatchObject({
      problems: [{ file: 'agents/assistant.ts', status: 422, code: 'tool_bundle_unknown' }],
    });
  });
}
