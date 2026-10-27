import { describe, expect, it } from 'vitest';

import { ConnectorResourceSchema, connectorKindOf } from '@indx-workspace/contracts/connectors';
import { ModelConnectionResourceSchema } from '@indx-workspace/contracts/models';

import { createClient } from './index.js';
import { fetchDouble, fixtures, jsonResponse } from './testing.js';

describe('@indx-workspace/sdk/testing fixtures (issue #246, P-2)', () => {
  it('builds a settled run for a terminal status the way the testing guide shows', () => {
    const run = fixtures.run({ status: 'completed' });
    expect(run.status).toBe('completed');
    expect(run.startedAt).not.toBeNull();
    expect(run.endedAt).not.toBeNull();
    expect(run.durationMs).toBe(1000);
    expect(run.accountingState).toBe('complete');
    expect(run.error).toBeNull();
  });

  it('leaves a queued run unstarted and gives a failed run its public error text', () => {
    const queued = fixtures.run();
    expect([queued.status, queued.startedAt, queued.endedAt]).toEqual(['queued', null, null]);
    expect(fixtures.run({ status: 'running' }).startedAt).not.toBeNull();
    expect(fixtures.run({ status: 'failed' }).error).toBe('The run failed.');
    expect(queued.output).toBeNull();
    const output = { text: 'done', structured: { ok: true } };
    expect(fixtures.run({ status: 'completed', output }).output).toEqual(output);
  });

  it('applies overrides last, so a caller can name any field', () => {
    expect(fixtures.run({ status: 'completed', endedAt: null }).endedAt).toBeNull();
    expect(fixtures.agent({ name: 'Triage' }).name).toBe('Triage');
    expect(fixtures.session({ status: 'archived' }).status).toBe('archived');
  });

  it('refuses an override the server could never send', () => {
    expect(() => fixtures.agent({ name: '' })).toThrow();
    expect(() => fixtures.run({ createdAt: 'yesterday' })).toThrow();
  });

  it('links the fixtures through shared ids', () => {
    const run = fixtures.run();
    expect(run.agentId).toBe(fixtures.agent().id);
    expect(run.sessionId).toBe(fixtures.session().id);
    expect(fixtures.session().agentId).toBe(fixtures.agent().id);
  });

  it('builds version 1 of the fixture agent and the local pointer at it (S1-09, issue #447)', () => {
    const agent = fixtures.agent();
    const version = fixtures.agentVersion();
    expect(version.agentId).toBe(agent.id);
    expect(version.workspaceId).toBe(agent.workspaceId);
    expect(version.createdByPrincipalId).toBe(agent.ownerPrincipalId);
    expect(version.body.definition.agent.name).toBe(agent.name);
    expect(version.body.surfaces).toEqual([]);
    expect(fixtures.agentVersionPointer()).toEqual({
      environment: 'local',
      number: version.number,
      updatedAt: version.createdAt,
    });
    expect(fixtures.agentVersion({ number: 2 }).number).toBe(2);
    expect(() => fixtures.agentVersion({ number: 0 })).toThrow();
    expect(() => fixtures.agentVersionPointer({ number: 0 })).toThrow();
  });

  it('answers a client with a fixture the SDK accepts unchanged', async () => {
    const run = fixtures.run({ status: 'completed' });
    const api = fetchDouble(() => jsonResponse(200, { run }));
    const aw = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_test' },
      fetch: api.fetch,
    });
    expect(await aw.runs.get(run.id)).toEqual(run);
    expect(api.calls[0]?.url.pathname).toBe(`/api/runs/${run.id}`);
  });

  it('builds a model connection and one connector of each kind the contracts parse (#533)', () => {
    const connection = fixtures.modelConnection();
    expect(ModelConnectionResourceSchema.parse(connection)).toEqual(connection);
    expect([connection.name, connection.provider, connection.hasCredential]).toEqual([
      'default',
      'anthropic',
      true,
    ]);
    const connectors = [
      fixtures.connector(),
      fixtures.openApiConnector(),
      fixtures.postgresConnector(),
    ];
    for (const connector of connectors) {
      expect(ConnectorResourceSchema.parse(connector)).toEqual(connector);
      expect(connector.workspaceId).toBe(fixtures.agent().workspaceId);
    }
    expect(connectors.map(connectorKindOf)).toEqual(['mcp', 'openapi', 'postgres']);
    expect(new Set(connectors.map((connector) => connector.id)).size).toBe(3);
  });

  it('applies connector and connection overrides, and refuses one the server could never send', () => {
    expect(fixtures.modelConnection({ name: 'openai', provider: 'openai' }).provider).toBe(
      'openai',
    );
    expect(fixtures.connector({ transport: 'sse' }).transport).toBe('sse');
    expect(fixtures.openApiConnector({ name: 'billing' }).name).toBe('billing');
    expect(fixtures.postgresConnector({ hasCredential: true }).hasCredential).toBe(true);
    expect(() => fixtures.modelConnection({ name: '' })).toThrow();
    expect(() => fixtures.connector({ transport: null })).toThrow();
    expect(() => fixtures.postgresConnector({ hasCredential: false })).toThrow();
    expect(() =>
      fixtures.openApiConnector({ postgres: fixtures.postgresConnector().postgres }),
    ).toThrow();
  });
});
