import { describe, expect, it } from 'vitest';
import { exportAgentVersion } from './export';
import {
  assertExported,
  PRINCIPAL,
  SECRET_SENTINEL,
  seedConnector,
  WORKSPACE,
  world,
} from './export.test-support';

describe('exportAgentVersion connectors', () => {
  it('never carries a connector credential; it appears only as a reference by name', async () => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: async (connectors) => {
        const created = await connectors.forWorkspace(WORKSPACE).create(
          {
            name: 'crm',
            transport: 'http',
            command: null,
            args: null,
            url: 'https://crm.example.com/mcp',
            authType: 'bearer',
            credential: SECRET_SENTINEL,
          },
          { principalId: PRINCIPAL, userId: null },
        );
        if (created.kind !== 'created') throw new Error('the memory store creates the connector');
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    const serialised = JSON.stringify(outcome.response);
    expect(serialised).not.toContain(SECRET_SENTINEL);
    expect(serialised).toContain('CONNECTOR_CRM');
  });

  it.each([
    ['a known query parameter', 'https://crm.example.com/mcp?token=URL-SENTINEL-1234'],
    ['an unknown query parameter', 'https://crm.example.com/mcp?code=URL-SENTINEL-1234'],
    ['a fragment', 'https://crm.example.com/mcp#access_token=URL-SENTINEL-1234'],
    ['the user info', 'https://user:URL-SENTINEL-1234@crm.example.com/mcp'],
    ['an unparseable URL', 'https://crm.example.com:URL-SENTINEL-1234/mcp'],
  ])('drops a connector whose URL is %s, naming it and never the URL', async (_form, url) => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: (connectors) => seedConnector(connectors, 'crm', { url }),
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual({
      path: 'agents.support-triage.definition.resources.connectors.0',
      verdict: 'dropped',
      code: 'field_unsupported',
      note: 'the connector crm: the URL carries a query, fragment or credential; re-register it without one',
    });
    const serialised = JSON.stringify(outcome.response);
    expect(serialised).not.toContain('URL-SENTINEL-1234');
    expect(serialised).not.toContain('crm.example.com');
  });

  it('still exports a connector whose URL is a clean https URL', async () => {
    const { agentId, sources } = await world({
      connectors: ['crm'],
      seed: (connectors) =>
        seedConnector(connectors, 'crm', { url: 'https://crm.example.com/mcp' }),
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(JSON.stringify(outcome.response.files)).toContain('https://crm.example.com/mcp');
    expect(outcome.response.report).not.toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
      }),
    );
  });

  it.each(['bearer', 'api-key'] as const)(
    'drops a %s connector with no credential on file instead of exporting it without auth',
    async (authType) => {
      const { agentId, sources } = await world({
        connectors: ['crm'],
        seed: (connectors) => seedConnector(connectors, 'crm', { authType, credential: null }),
      });

      const outcome = await exportAgentVersion(
        agentId,
        { version: 1, platform: 'claude-managed-agents' },
        sources,
      );

      assertExported(outcome);
      expect(outcome.response.report).toContainEqual({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
        code: 'field_unsupported',
        note: `the connector crm requires a ${authType} credential but none is on file; add one and export again`,
      });
      expect(
        JSON.stringify(outcome.response.files.filter((file) => file.path !== 'PLATFORM_REPORT.md')),
      ).not.toContain('crm.example.com');
    },
  );

  it('drops every connector whose secret name collides and still carries the others', async () => {
    const { agentId, sources } = await world({
      connectors: ['a-b', 'a_b', 'crm'],
      seed: async (connectors) => {
        await seedConnector(connectors, 'a-b', { authType: 'bearer' });
        await seedConnector(connectors, 'a_b', { authType: 'bearer' });
        await seedConnector(connectors, 'crm', { authType: 'bearer' });
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    const note =
      'the connectors a-b, a_b would share the secret name CONNECTOR_A_B; rename one and export again';
    for (const index of [0, 1]) {
      expect(outcome.response.report).toContainEqual({
        path: `agents.support-triage.definition.resources.connectors.${index}`,
        verdict: 'dropped',
        code: 'field_unsupported',
        note,
      });
    }
    const serialised = JSON.stringify(outcome.response.files);
    expect(serialised).toContain('CONNECTOR_CRM');
    expect(
      JSON.stringify(outcome.response.files.filter((file) => file.path !== 'PLATFORM_REPORT.md')),
    ).not.toContain('CONNECTOR_A_B');
  });

  it('reports a connector this workspace does not have as dropped', async () => {
    const { agentId, sources } = await world({ connectors: ['missing'] });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual(
      expect.objectContaining({
        path: 'agents.support-triage.definition.resources.connectors.0',
        verdict: 'dropped',
        note: 'this workspace has no connector named missing',
      }),
    );
  });
});
