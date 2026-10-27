import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, type CliRun } from '../testing.js';

const CLIENT_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_AGENT = {
  ...FIXTURES.agent,
  id: '99999999-9999-4999-8999-999999999999',
  name: 'Other',
};

const CLIENT = {
  id: CLIENT_ID,
  name: 'support-bot',
  kind: 'a2a-agent',
  agentIds: [IDS.agent],
  toolNames: null,
  redirectUris: ['https://app.example.com/oauth/callback'],
  hasClientSecret: false,
  actsForPrincipalId: IDS.principal,
  apiKeyIds: [FIXTURES.apiKey.id],
  revokedAt: null,
  createdAt: '2026-10-11T00:00:00.000Z',
  updatedAt: '2026-10-11T00:00:00.000Z',
};

const ROTATED = {
  clientId: CLIENT_ID,
  clientSecret: 'awcs_live_RotatedSecretForTheTest0123456789',
  warning: 'Store this secret now; it is not shown again.',
};

const MINTED = { apiKey: FIXTURES.apiKey, key: FIXTURES.mintedKey, warning: 'Store it now.' };

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function route(request: { readonly method: string; readonly url: URL }): Response {
  const { pathname } = request.url;
  if (pathname === '/api/agents') return json(200, { agents: [FIXTURES.agent, OTHER_AGENT] });
  if (pathname.endsWith('/secret')) return json(201, ROTATED);
  if (pathname.endsWith('/keys')) return json(201, MINTED);
  if (pathname === '/api/endpoint-clients' && request.method === 'GET') {
    return json(200, { endpointClients: [CLIENT] });
  }
  if (pathname === '/api/endpoint-clients') return json(201, { endpointClient: CLIENT });
  return json(200, { endpointClient: CLIENT });
}

function sent(run: CliRun, method: string): number {
  return run.calls.filter((call) => call.method === method).length;
}

describe('aw endpoint-clients', () => {
  it('lists and gets without any key in the output', async () => {
    const list = await runCli(['endpoint-clients', 'list'], { route });
    expect(list.code).toBe(EXIT_CODE.ok);
    expect(list.stdout).toContain('support-bot');
    const get = await runCli(['endpoint-clients', 'get', CLIENT_ID, '--json'], { route });
    expect(get.calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}`);
    for (const run of [list, get]) {
      expect(run.stdout + run.stderr).not.toContain(FIXTURES.mintedKey);
    }
  });

  it('resolves --agent names to ids with exactly one agents list', async () => {
    const run = await runCli(
      [
        'endpoint-clients',
        'create',
        '--name',
        'search',
        '--kind',
        'mcp-project',
        '--agent',
        'Summariser',
        '--agent',
        'Other',
        '--tool',
        'lookup',
      ],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls.filter((call) => call.url.pathname === '/api/agents')).toHaveLength(1);
    const post = run.calls.find((call) => call.method === 'POST');
    expect(post?.json).toEqual({
      name: 'search',
      kind: 'mcp-project',
      agentIds: [IDS.agent, OTHER_AGENT.id],
      toolNames: ['lookup'],
    });
  });

  it('exits with the usage code for an unknown agent, sending no create', async () => {
    const run = await runCli(
      ['endpoint-clients', 'create', '--name', 'x', '--kind', 'a2a-agent', '--agent', 'Nobody'],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('no agent named "Nobody"');
    expect(sent(run, 'POST')).toBe(0);
  });

  it('refuses a bad --kind before anything is sent', async () => {
    const run = await runCli(
      ['endpoint-clients', 'create', '--name', 'x', '--kind', 'oauth', '--agent', 'Summariser'],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--kind must be one of');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses two agents for an a2a-agent client with the contract rule, sending no create', async () => {
    const run = await runCli(
      [
        'endpoint-clients',
        'create',
        '--name',
        'x',
        '--kind',
        'a2a-agent',
        '--agent',
        'Summariser',
        '--agent',
        'Other',
      ],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(sent(run, 'POST')).toBe(0);
  });

  it('creates a builder client with an empty agent list, and refuses an --agent for it', async () => {
    const created = await runCli(
      ['endpoint-clients', 'create', '--kind', 'builder', '--name', 'x'],
      { route },
    );
    expect(created.code).toBe(EXIT_CODE.ok);
    expect(created.calls.find((call) => call.method === 'POST')?.json).toEqual({
      name: 'x',
      kind: 'builder',
      agentIds: [],
    });
    const refused = await runCli(
      ['endpoint-clients', 'create', '--kind', 'builder', '--name', 'x', '--agent', 'Summariser'],
      { route },
    );
    expect(refused.code).toBe(EXIT_CODE.usage);
    expect(sent(refused, 'POST')).toBe(0);
  });

  it('updates only what was given, and refuses an empty update', async () => {
    const update = await runCli(['endpoint-clients', 'update', CLIENT_ID, '--tool', 'lookup'], {
      route,
    });
    expect(update.calls).toHaveLength(1);
    expect(update.calls[0]?.method).toBe('PATCH');
    expect(update.calls[0]?.json).toEqual({ toolNames: ['lookup'] });
    const empty = await runCli(['endpoint-clients', 'update', CLIENT_ID], { route });
    expect(empty.code).toBe(EXIT_CODE.usage);
    expect(empty.calls).toHaveLength(0);
  });

  it('sends repeated --redirect-uri as redirectUris and nothing else', async () => {
    const run = await runCli(
      [
        'endpoint-clients',
        'update',
        CLIENT_ID,
        '--redirect-uri',
        'https://app.example.com/a',
        '--redirect-uri',
        'http://localhost:8080/b',
      ],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.json).toEqual({
      redirectUris: ['https://app.example.com/a', 'http://localhost:8080/b'],
    });
  });

  it.each(['http://evil.example/cb', 'https://app.example.com/cb#frag', 'not a uri'])(
    'refuses --redirect-uri %s before any request is sent',
    async (uri) => {
      const run = await runCli(['endpoint-clients', 'update', CLIENT_ID, '--redirect-uri', uri], {
        route,
      });
      expect(run.code).toBe(EXIT_CODE.usage);
      expect(run.calls).toHaveLength(0);
    },
  );

  it.each([[[]], [['--json']]])('prints a rotated secret exactly once (%j)', async (extra) => {
    const run = await runCli(['endpoint-clients', 'secret', 'rotate', CLIENT_ID, ...extra], {
      route,
    });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}/secret`);
    expect(occurrences(run.stdout, ROTATED.clientSecret)).toBe(1);
    expect(run.stderr).not.toContain(ROTATED.clientSecret);
    for (const later of [
      ['endpoint-clients', 'get', CLIENT_ID],
      ['endpoint-clients', 'list'],
    ]) {
      const output = await runCli(later, { route });
      expect(output.stdout + output.stderr).not.toContain(ROTATED.clientSecret);
    }
  });

  it('revokes with DELETE', async () => {
    const run = await runCli(['endpoint-clients', 'revoke', CLIENT_ID], { route });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('DELETE');
  });

  it.each([[[]], [['--json']]])('prints a minted key exactly once (%j)', async (extra) => {
    const run = await runCli(
      ['endpoint-clients', 'keys', 'create', CLIENT_ID, '--name', 'vault', ...extra],
      { route },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.url.pathname).toBe(`/api/endpoint-clients/${CLIENT_ID}/keys`);
    expect(run.calls[0]?.json).toEqual({ name: 'vault' });
    expect(occurrences(run.stdout, FIXTURES.mintedKey)).toBe(1);
    expect(run.stderr).not.toContain(FIXTURES.mintedKey);
  });

  it('sends --expires-at with the key', async () => {
    const run = await runCli(
      [
        'endpoint-clients',
        'keys',
        'create',
        CLIENT_ID,
        '--name',
        'vault',
        '--expires-at',
        '2027-01-01T00:00:00.000Z',
      ],
      { route },
    );
    expect(run.calls[0]?.json).toEqual({ name: 'vault', expiresAt: '2027-01-01T00:00:00.000Z' });
  });
});
