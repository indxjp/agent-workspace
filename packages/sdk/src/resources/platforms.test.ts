import { PLATFORM_CAPABILITY_KEYS } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { PlatformsClient } from './platforms.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const DESCRIPTOR = {
  id: 'copilot-studio',
  displayName: 'Copilot Studio',
  docsUrl: 'https://example.com/docs',
  capabilities: Object.fromEntries(PLATFORM_CAPABILITY_KEYS.map((key) => [key, 'native'])),
};

const EXPORT = {
  agentId: AGENT_ID,
  version: 3,
  platform: 'copilot-studio',
  files: [{ path: 'PLATFORM_REPORT.md', encoding: 'utf8', content: '# report\n' }],
  report: [{ path: 'agents.a.name', verdict: 'native', note: 'kept' }],
};

function client(route: (request: RecordedRequest) => Response): {
  readonly platforms: PlatformsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/control',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { platforms: new PlatformsClient(http), calls: api.calls };
}

describe('PlatformsClient.list', () => {
  it('unwraps the envelope', async () => {
    const { platforms, calls } = client(() => json(200, { platforms: [DESCRIPTOR] }));

    expect(await platforms.list()).toEqual([DESCRIPTOR]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe('/control/api/platforms');
  });

  it('refuses a descriptor that carries an options schema', async () => {
    const { platforms } = client(() =>
      json(200, { platforms: [{ ...DESCRIPTOR, optionsSchema: {} }] }),
    );

    await expect(platforms.list()).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('PlatformsClient.export', () => {
  it('posts the version and target to the agent and parses the files and report', async () => {
    const { platforms, calls } = client(() => json(200, EXPORT));

    const exported = await platforms.export(AGENT_ID, 3, {
      platform: 'copilot-studio',
      options: { region: 'eu' },
    });

    expect(exported).toEqual(EXPORT);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/control/api/agents/${AGENT_ID}/platform-exports`);
    expect(calls[0]?.json).toEqual({
      version: 3,
      platform: 'copilot-studio',
      options: { region: 'eu' },
    });
  });

  it('encodes the agent id as one path segment', async () => {
    const { platforms, calls } = client(() => json(200, EXPORT));

    await platforms.export('a/b', 1, { platform: 'copilot-studio' });

    expect(calls[0]?.url.pathname).toBe('/control/api/agents/a%2Fb/platform-exports');
  });

  it('throws the typed problem for a refusal', async () => {
    const { platforms } = client(() =>
      json(404, {
        error: {
          code: 'agent_version_not_found',
          message: 'No such version.',
          details: ['version:9'],
        },
      }),
    );

    const error: unknown = await platforms
      .export(AGENT_ID, 9, { platform: 'copilot-studio' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).code).toBe('agent_version_not_found');
  });

  it('refuses a response that has drifted from the contract', async () => {
    const { platforms } = client(() => json(200, { ...EXPORT, files: [{ path: '../x' }] }));

    await expect(
      platforms.export(AGENT_ID, 3, { platform: 'copilot-studio' }),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });
});

describe('PlatformsClient.exportArchive', () => {
  it('returns the tar bytes with the server file name', async () => {
    const { platforms, calls } = client(
      () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-type': 'application/x-tar',
            'content-disposition': 'attachment; filename="agent-copilot-studio-v3.tar"',
          },
        }),
    );

    const archive = await platforms.exportArchive(AGENT_ID, 3, { platform: 'copilot-studio' });

    expect(archive).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      filename: 'agent-copilot-studio-v3.tar',
      contentType: 'application/x-tar',
    });
    expect(calls[0]?.url.pathname).toBe(`/control/api/agents/${AGENT_ID}/platform-archives`);
    expect(calls[0]?.json).toEqual({ version: 3, platform: 'copilot-studio' });
  });

  it('names the file itself when the server sent no disposition', async () => {
    const { platforms } = client(() => new Response(new Uint8Array(), { status: 200 }));

    const archive = await platforms.exportArchive(AGENT_ID, 2, { platform: 'copilot-studio' });

    expect(archive.filename).toBe(`${AGENT_ID}-copilot-studio-v2.tar`);
  });
});
