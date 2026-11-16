import { expect, it } from 'vitest';
import { POST as ROTATE } from '../../app/api/model-connections/[id]/credential/route';
import { GET as LIST_CONNECTIONS, POST as CREATE } from '../../app/api/model-connections/route';

import { API_KEY, request } from './routes.fixture.test-support';
export function registerModelHttpConnectionsTests() {
  it('creates a keyless vertex connection from the install defaults and refuses a credential for it', async () => {
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', { name: 'Vertex', provider: 'vertex' }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      hasCredential: boolean;
      ready: boolean;
      config: Record<string, string>;
    };
    expect(body).toMatchObject({
      hasCredential: false,
      ready: true,
      config: { projectId: 'install-project-1', location: 'eu' },
    });
    const withKey = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Vertex 2',
        provider: 'vertex',
        apiKey: API_KEY,
      }),
    );
    expect(withKey.status).toBe(400);
    expect(await withKey.text()).toContain('apiKey is not used');
    const rotated = await ROTATE(
      request(`http://web/api/model-connections/${body.id}/credential`, 'POST', {
        apiKey: API_KEY,
      }),
      { params: Promise.resolve({ id: body.id }) },
    );
    expect(rotated.status).toBe(409);
    expect(await rotated.text()).toContain('credential_not_used');
  });

  it('lists connections (names, provider, readiness) at GET /api/model-connections — issue #130', async () => {
    const created = await CREATE(
      request('http://web/api/model-connections', 'POST', {
        name: 'Claude for the selector',
        provider: 'anthropic',
        apiKey: API_KEY,
        config: {},
      }),
    );
    const createdBody = (await created.json()) as { id: string };

    const listed = await LIST_CONNECTIONS(request('http://web/api/model-connections'));
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      models: readonly { id: string; name: string; provider: string; ready: boolean }[];
    };
    const row = listedBody.models.find((entry) => entry.id === createdBody.id);
    expect(row).toMatchObject({
      name: 'Claude for the selector',
      provider: 'anthropic',
      ready: true,
    });
    expect(JSON.stringify(listedBody).toLowerCase()).not.toContain(API_KEY.toLowerCase());
  });
}
