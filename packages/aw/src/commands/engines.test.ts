import { EngineDescriptorSchema } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson } from '../testing.js';

describe('aw engines list', () => {
  it('prints the catalogue as a table with the chosen columns', async () => {
    const run = await runCli(['engines', 'list'], {
      route: () => json(200, { engines: [FIXTURES.engine] }),
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.calls[0]?.url.pathname).toBe('/api/engines');
    expect(run.stdout.split('\n')[0]).toMatch(/^id\s+displayName\s+version\s+installed$/u);
    expect(run.stdout).toContain('claude-agent-sdk  Claude Agent SDK  0.3.278  true');
  });

  it('--json prints the same descriptors the contract publishes, capabilities included', async () => {
    const run = await runCli(['engines', 'list', '--json'], {
      route: () => json(200, { engines: [FIXTURES.engine] }),
    });

    expect(EngineDescriptorSchema.array().parse(stdoutJson(run))).toEqual([FIXTURES.engine]);
    expect(stdoutJson(run)).toEqual([
      expect.objectContaining({
        id: 'claude-agent-sdk',
        installed: true,
        capabilities: expect.objectContaining({ wireProtocols: ['anthropic-messages'] }) as unknown,
      }) as unknown,
    ]);
  });

  it('--jsonl prints one descriptor per line', async () => {
    const run = await runCli(['engines', 'list', '--jsonl'], {
      route: () => json(200, { engines: [FIXTURES.engine] }),
    });

    expect(run.stdout).toBe(`${JSON.stringify(FIXTURES.engine)}\n`);
  });

  it('says so, rather than printing an empty table, for a deployment that registers none', async () => {
    const run = await runCli(['engines', 'list'], { route: () => json(200, { engines: [] }) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toBe('(none)\n');
  });

  it('reports the server refusal with its code and exits 1', async () => {
    const run = await runCli(['engines', 'list'], {
      route: () =>
        json(500, {
          error: { code: 'engine_catalogue_invalid', message: 'the catalogue cannot be served.' },
        }),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: engine_catalogue_invalid:');
  });

  it('has no write command: an engine is installed by deploying an adapter', async () => {
    const run = await runCli(['engines', 'create']);

    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('unknown command "engines create"');
  });
});
