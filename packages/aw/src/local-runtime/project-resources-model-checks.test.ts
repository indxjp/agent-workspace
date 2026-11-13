import { describe, expect, it } from 'vitest';

import { FIXTURES, json } from '../testing.js';

import {
  KEY,
  TOKEN,
  YAML,
  apply,
  applyDeferred,
  existing,
  freshRoot,
} from './project-resources.fixture.test-support.js';
describe('applyProjectResources', () => {
  it("names the declared connection's variable when its provider cannot be reached (#661)", async () => {
    const root = await freshRoot();
    const yaml = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  main:
    provider: anthropic
    credential:
      secret: MAIN_MODEL_KEY
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const reason = 'Model list unavailable (the provider could not be reached).';
    const { stderr, stdout } = await apply({
      root: root,
      env: { MAIN_MODEL_KEY: KEY },
      answer: (route) => {
        if (route === 'GET /api/model-connections') {
          return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'main' }] });
        }
        if (route === 'GET /api/models') {
          return json(200, {
            models: [],
            unavailable: [
              {
                connectionId: FIXTURES.modelConnection.id,
                connectionName: 'main',
                reason,
                kind: 'unreachable',
              },
              // A connection the project does not use is not this start's business.
              { connectionId: 'other-id', connectionName: 'stale', reason },
            ],
          });
        }
        return existing(route);
      },
      yaml: yaml,
    });
    expect(stderr).toBe(
      `warning: model connection "main": ${reason} The key was not rejected: check the base URL and this machine's network, then restart aw dev.\n`,
    );
    expect(stdout + stderr).not.toContain(KEY);
  });

  it('returns the problem for a rejected key, with its status and the variable to fix, when deferred', async () => {
    const found = await applyDeferred({
      connectionId: FIXTURES.modelConnection.id,
      connectionName: 'default',
      reason: 'The provider rejected the API key (HTTP 401). Replace the key on this connection.',
      kind: 'credential-rejected',
      status: 401,
    });
    expect(found.check).toEqual({
      checked: true,
      problems: [
        {
          connection: 'default',
          rejected: true,
          problem: 'the key was rejected (401)',
          fix: 'Set ANTHROPIC_API_KEY to a valid key and restart aw dev.',
        },
      ],
    });
    expect(found.stderr).not.toContain('warning: model connection');
  });

  it('does not say a key was not rejected when the failure is unclassified or the provider unsupported', async () => {
    for (const kind of [undefined, 'unsupported-provider']) {
      const found = await applyDeferred({
        connectionId: FIXTURES.modelConnection.id,
        connectionName: 'default',
        reason: 'Model list unavailable.',
        ...(kind === undefined ? {} : { kind }),
      });
      expect(found.check.problems).toEqual([
        {
          connection: 'default',
          problem: 'Model list unavailable.',
          fix: 'Restart aw dev to check again.',
        },
      ]);
    }
  });

  it('names no connection when the discovery call itself is refused', async () => {
    const { stderr } = await apply({
      root: await freshRoot(),
      env: { ANTHROPIC_API_KEY: KEY, ORDERS_TOKEN: TOKEN },
      answer: (route) =>
        route === 'GET /api/models'
          ? json(500, { error: { code: 'internal', message: 'down' } })
          : existing(route),
      yaml: YAML,
    });
    expect(stderr.startsWith("warning: could not check the model connections' keys: ")).toBe(true);
    expect(stderr.endsWith(' Restart aw dev to check again.\n')).toBe(true);
  });

  it('checks no key when the project has no model connection yet', async () => {
    const root = await freshRoot();
    const { sent, stderr } = await apply({
      root: root,
      env: {},
      answer: (route) => json(200, route.includes('model') ? { models: [] } : { connectors: [] }),
    });
    expect(sent.map((request) => request.route)).not.toContain('GET /api/models');
    expect(stderr).not.toContain('warning: model connection');
  });

  it('says a missing model key once: the planner notice only when the screen will not (#690)', async () => {
    const answer = (route: string): Response =>
      json(200, route.includes('model') ? { models: [] } : { connectors: [] });
    const quiet = await apply({ root: await freshRoot(), env: {}, answer: answer });
    expect(quiet.stderr).toContain('ANTHROPIC_API_KEY');
    const screen = await apply({
      root: await freshRoot(),
      env: {},
      answer: answer,
      yaml: YAML,
      deferModelCheck: true,
    });
    expect(screen.stderr).not.toContain('ANTHROPIC_API_KEY');
  });

  it('lists every unset model key once, and still prints a prefix-named connector notice (#690)', async () => {
    const yaml = `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
models:
  first:
    provider: anthropic
    credential:
      secret: FIRST_KEY
  second:
    provider: anthropic
    credential:
      secret: SECOND_KEY
connectors:
  github:
    url: https://mcp.example.com
    auth:
      scheme: bearer
      credential:
        secret: FIRST_KEY_ORG
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
`;
    const answer = (route: string): Response =>
      json(200, route.includes('model') ? { models: [] } : { connectors: [] });
    const { stderr, check } = await apply({
      root: await freshRoot(),
      env: {},
      answer: answer,
      yaml: yaml,
      deferModelCheck: true,
    });
    expect(check.problems.map((problem) => problem.secret)).toEqual(['FIRST_KEY', 'SECOND_KEY']);
    expect(stderr).not.toContain('notice: FIRST_KEY is not set');
    expect(stderr).not.toContain('notice: SECOND_KEY is not set');
    expect(stderr).toContain('notice: FIRST_KEY_ORG is not set');
  });
});
