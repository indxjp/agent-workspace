import { describe, expect, it } from 'vitest';
import type { EndpointClientResource } from '@indx-workspace/contracts/endpoint-clients';
import { PLATFORM_EXPORT_MAX_BYTES } from '@indx-workspace/contracts/platforms';
import { exportAgentVersion } from './export';
import {
  assertExported,
  CLIENT,
  encode,
  exportV2,
  problemOf,
  seedAgentVersion,
  withExtras,
  type World,
  world,
} from './export.test-support';

describe('exportAgentVersion with subagents, knowledge files and a tool endpoint', () => {
  it('carries a subagent at its production version', async () => {
    const seeded = await world();
    await seedAgentVersion(seeded, 'researcher', 'production');
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    assertExported(outcome);
    expect(JSON.stringify(outcome.response.files)).toContain('researcher');
  });

  it('falls back to the local version when the subagent has no production one', async () => {
    const seeded = await world();
    await seedAgentVersion(seeded, 'researcher', 'local');
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    assertExported(outcome);
    expect(JSON.stringify(outcome.response.files)).toContain('researcher');
  });

  it.each([
    ['no agent of that name', async () => Promise.resolve()],
    [
      'no version pointed at',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', null);
      },
    ],
    [
      'a version of another name',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', 'production', { bodyName: 'someone-else' });
      },
    ],
    [
      'a subagent of its own',
      async (seeded: World) => {
        await seedAgentVersion(seeded, 'researcher', 'production', { subagents: ['nested'] });
      },
    ],
  ])('refuses with platform_agent_not_found for %s', async (_name, seed) => {
    const seeded = await world();
    await seed(seeded);
    await withExtras(seeded, { subagents: ['researcher'] });

    const outcome = await exportV2(seeded);

    if (outcome.ok) throw new Error('expected a refusal');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result)).toMatchObject({
      code: 'platform_agent_not_found',
      details: ['support-triage.subagents.researcher'],
    });
  });

  it('carries a granted knowledge file from the workspace', async () => {
    const seeded = await world({
      workspaceFiles: { 'docs/faq.md': encode('Q: how?\nA: like this.\n') },
    });
    await withExtras(seeded, { knowledgePaths: ['docs/faq.md'] });

    const outcome = await exportV2(seeded, 'copilot-studio', { publisherPrefix: 'contoso' });

    assertExported(outcome);
    expect(seeded.reads).toContain('docs/faq.md');
    expect(JSON.stringify(outcome.response.files)).toContain('A: like this.');
  });

  it.each([
    ['claude-managed-agents', undefined],
    [
      'gemini-enterprise',
      {
        projectId: 'acme-agents',
        location: 'global',
        engineId: 'acme-support-app',
        publicBaseUrl: 'https://aw.example.com',
      },
    ],
  ])(
    'reports a knowledge file the workspace no longer has instead of failing (%s)',
    async (platform, options) => {
      const seeded = await world();
      await withExtras(seeded, { knowledgePaths: ['docs/gone.md'] });

      const outcome = await exportV2(seeded, platform, options);

      assertExported(outcome);
      expect(outcome.response.report).toContainEqual(
        expect.objectContaining({
          path: 'agents.support-triage.knowledge.0',
          verdict: 'dropped',
          note: expect.stringContaining('docs/gone.md') as unknown,
        }),
      );
      expect(outcome.response.files.map((file) => file.path)).not.toContainEqual(
        expect.stringContaining('docs/gone.md'),
      );
    },
  );

  it('counts a knowledge file toward the size cap', async () => {
    const seeded = await world({
      workspaceFiles: { 'docs/huge.md': new Uint8Array(PLATFORM_EXPORT_MAX_BYTES + 1) },
    });
    await withExtras(seeded, { knowledgePaths: ['docs/huge.md'] });

    const outcome = await exportV2(seeded);

    if (outcome.ok) throw new Error('the over-size export is refused');
    expect(outcome.result.status).toBe(422);
    expect(problemOf(outcome.result).code).toBe('platform_export_too_large');
  });

  it('reports several publishing endpoint clients as a dropped toolEndpoint', async () => {
    const seeded = await world();
    const publishing = (name: string): EndpointClientResource => ({
      ...CLIENT,
      name,
      agentIds: [seeded.agentId],
    });
    const outcome = await exportAgentVersion(
      seeded.agentId,
      { version: 1, platform: 'claude-managed-agents' },
      {
        ...seeded.sources,
        endpointClients: () => Promise.resolve([publishing('a'), publishing('b')]),
      },
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({ path: 'toolEndpoint', verdict: 'dropped' }),
    );
  });
});
