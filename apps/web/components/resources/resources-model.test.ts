import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  createApiKey,
  createFolder,
  createSkill,
  deleteFile,
  errorText,
  loadApiKeys,
  loadMe,
  probeSettings,
  renameFile,
  revokeApiKey,
  saveSkill,
  submitConnector,
  testConnector,
  uploadFile,
} from './resources-model';

function api(route: (request: RecordedRequest) => Response) {
  const double = fetchDouble(route);
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  return { client, calls: double.calls };
}

const problem = (status: number, code: string, details?: string[]) =>
  jsonResponse(status, {
    error: { code, message: `${code} happened`, ...(details && { details }) },
  });

const file = {
  id: 'f1',
  path: 'a/b.txt',
  kind: 'file',
  sizeBytes: 3,
  contentType: 'text/plain',
  lastModified: null,
};
const keyId = 'A'.repeat(22);
const apiKey = {
  id: 'k1',
  name: 'ci',
  role: 'builder',
  keyPrefix: `ak_live_${keyId}`,
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
};

describe('errorText', () => {
  it('appends the details a refusal carries, as the screens always showed', async () => {
    const { client } = api(() => problem(400, 'invalid_body', ['name is required.']));
    const error = await createFolder(client, 'x').catch((reason: unknown) => reason);
    expect(errorText(error)).toBe('invalid_body happened name is required.');
  });
});

describe('files', () => {
  it('creates a folder and uploads a file with the percent-encoded path headers', async () => {
    const { client, calls } = api(() => jsonResponse(201, { file }));
    await createFolder(client, 'a/b c');
    await uploadFile(client, 'a/b.txt', new File(['abc'], 'b.txt', { type: 'text/plain' }));
    expect(calls[0]?.headers.get('x-folder-path')).toBe('a%2Fb%20c');
    expect(calls[1]?.headers.get('x-file-path')).toBe('a%2Fb.txt');
    expect(calls[1]?.headers.get('content-type')).toBe('text/plain');
  });

  // @story US-STO-02
  it('[US-STO-02][unit][web] says a file is too large for the deployment on a 413', async () => {
    const { client } = api(() => problem(413, 'too_large'));
    await expect(uploadFile(client, 'a.txt', new File(['x'], 'a.txt'))).rejects.toThrow(
      'This file is too large for this deployment.',
    );
  });

  it('[US-STO-02][unit][web] reports any other refused upload by status', async () => {
    const { client } = api(() => problem(500, 'internal'));
    await expect(uploadFile(client, 'a.txt', new File(['x'], 'a.txt'))).rejects.toThrow(
      'Upload returned 500.',
    );
  });

  it('renames through PATCH and refuses a partial folder move', async () => {
    const ok = api(() => jsonResponse(200, { file }));
    await renameFile(ok.client, 'a/b.txt', 'c.txt');
    expect(ok.calls[0]?.method).toBe('PATCH');
    expect(ok.calls[0]?.json).toEqual({ newPath: 'c.txt' });

    const partial = api(() => jsonResponse(200, { status: 'partial', moved: 1, total: 3 }));
    await expect(renameFile(partial.client, 'dir', 'dir2')).rejects.toThrow(
      'Move did not finish: 1 of 3 items moved; the rest are still at the old location.',
    );
  });

  it('retries a non-empty folder recursively only once the caller confirms', async () => {
    const { client, calls } = api((request) =>
      request.url.searchParams.get('recursive') === 'true'
        ? jsonResponse(200, { status: 'ok', deleted: ['dir/a'] })
        : problem(409, 'folder_not_empty'),
    );
    await expect(deleteFile(client, 'dir', () => false)).rejects.toThrow(
      'folder_not_empty happened',
    );
    expect(calls).toHaveLength(1);
    await deleteFile(client, 'dir', () => true);
    expect(calls.map((call) => call.url.search)).toEqual(['', '', '?recursive=true']);
  });

  it('does not offer recursion for any other conflict, and reports a partial delete', async () => {
    const conflict = api(() => problem(409, 'name_conflict'));
    let asked = false;
    await expect(
      deleteFile(conflict.client, 'x', () => {
        asked = true;
        return true;
      }),
    ).rejects.toThrow('name_conflict happened');
    expect(asked).toBe(false);

    const partial = api(() =>
      jsonResponse(200, { status: 'partial', deleted: ['a'], remaining: ['b', 'c'] }),
    );
    await expect(deleteFile(partial.client, 'dir', () => true)).rejects.toThrow(
      'Delete did not finish: 1 removed, 2 still present. Try again.',
    );
    const gone = api(() => new Response(null, { status: 204 }));
    await expect(deleteFile(gone.client, 'a.txt', () => true)).resolves.toBeUndefined();
  });
});

describe('skills', () => {
  it('sends SKILL.md as a multipart file on create and as base64 on update', async () => {
    const { client, calls } = api(() => problem(400, 'stop'));
    const files = [{ path: 'SKILL.md', contentBase64: btoa('hello') }];
    await createSkill(client, 'my-skill', 'hello').catch(() => undefined);
    await saveSkill(client, 'my-skill', false, 'hello').catch(() => undefined);
    expect(calls[0]?.method).toBe('POST');
    const form = calls[0]?.init.body as FormData;
    expect(form.get('name')).toBe('my-skill');
    expect(await (form.get('file') as File).text()).toBe('hello');
    expect((form.get('file') as File).name).toBe('SKILL.md');
    expect(calls[1]?.method).toBe('PATCH');
    expect(calls[1]?.url.pathname).toBe('/api/skills/my-skill');
    expect(calls[1]?.json).toEqual({ enabled: false, files });
  });
});

describe('connectors', () => {
  const draft = {
    name: 'docs',
    transport: 'http',
    endpoint: 'https://mcp.example.com',
    args: '',
    authType: 'bearer',
    credential: 's3cret',
  } as const;

  it('tests a saved connector and words a failed probe', async () => {
    const failed = api(() =>
      jsonResponse(200, { ok: false, kind: 'unreachable', message: 'No route.' }),
    );
    await expect(testConnector(failed.client, 'c1', 'docs')).resolves.toBe('docs: No route.');
    expect(failed.calls[0]?.url.pathname).toBe('/api/connectors/c1/test-connection');
  });

  it('dry-runs a draft without persisting, then saves it', async () => {
    const tested = api(() =>
      jsonResponse(200, {
        ok: true,
        kind: 'ok',
        message: 'ok',
        serverName: null,
        serverVersion: null,
        toolCount: 2,
      }),
    );
    await expect(submitConnector(tested.client, draft, true)).resolves.toBe(
      'Connection test passed.',
    );
    expect(tested.calls[0]?.json).toMatchObject({
      name: 'docs',
      url: 'https://mcp.example.com',
      authType: 'bearer',
      credential: 's3cret',
      dryRun: true,
    });

    const saved = api(() => jsonResponse(201, fixtures.connector()));
    await expect(submitConnector(saved.client, draft, false)).resolves.toBeNull();
    expect(saved.calls[0]?.json).not.toHaveProperty('dryRun');
  });

  it('sends stdio arguments split on whitespace and no credential without authentication', async () => {
    const { client, calls } = api(() => jsonResponse(201, fixtures.connector()));
    await submitConnector(
      client,
      { ...draft, transport: 'stdio', endpoint: 'npx', args: '-y  server', authType: 'none' },
      false,
    );
    expect(calls[0]?.json).toEqual({
      name: 'docs',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server'],
      authType: 'none',
    });
  });
});

describe('API keys', () => {
  it('lists keys with the contract field keyPrefix the screen shows', async () => {
    const { client } = api(() => jsonResponse(200, { apiKeys: [apiKey] }));
    const view = await loadApiKeys(client);
    expect(view['apiKeys']).toEqual([apiKey]);
  });

  it('mints a key and returns the plaintext once', async () => {
    const key = `ak_live_${keyId}_${'b'.repeat(43)}`;
    const { client, calls } = api(() => jsonResponse(201, { apiKey, key, warning: 'Shown once.' }));
    await expect(createApiKey(client, 'ci', 'builder')).resolves.toBe(key);
    expect(calls[0]?.json).toEqual({ name: 'ci', role: 'builder', expiresAt: null });
    await expect(createApiKey(client, 'ci', 'root')).rejects.toThrow('not a role');
  });

  it('reports a refused mint with the server message and revokes by id', async () => {
    const refused = api(() => problem(409, 'name_taken'));
    const error = await createApiKey(refused.client, 'ci', 'owner').catch(
      (reason: unknown) => reason,
    );
    expect(errorText(error)).toBe('name_taken happened');
    const revoked = api(() =>
      jsonResponse(200, { apiKey: { ...apiKey, revokedAt: apiKey.createdAt } }),
    );
    await revokeApiKey(revoked.client, 'k 1');
    expect(revoked.calls[0]?.method).toBe('DELETE');
    expect(revoked.calls[0]?.url.pathname).toBe('/api/api-keys/k%201');
  });

  it('reads the caller role for the role dropdown', async () => {
    const me = {
      principalId: 'p1',
      kind: 'membership',
      role: 'owner',
      workspaceId: 'w1',
      userId: 'u1',
      label: 'Ada',
      features: ['chat'],
    };
    const { client } = api(() => jsonResponse(200, me));
    await expect(loadMe(client)).resolves.toMatchObject({ role: 'owner' });
  });
});

describe('settings probe', () => {
  it('reports a drifted answer by its status, not as unreachable', async () => {
    const { client } = api(() => jsonResponse(200, { unexpected: true }));
    const statuses = await probeSettings(client);
    expect(Object.values(statuses)).toEqual([200, 200, 200, 200, 200]);
  });

  it('reports each subsystem by the status its list answers', async () => {
    const { client } = api((request) =>
      request.url.pathname === '/api/skills'
        ? problem(500, 'internal_error')
        : request.url.pathname === '/api/files'
          ? jsonResponse(200, { files: [] })
          : request.url.pathname === '/api/connectors'
            ? jsonResponse(200, { connectors: [] })
            : request.url.pathname === '/api/users'
              ? jsonResponse(200, { users: [] })
              : jsonResponse(200, { apiKeys: [] }),
    );
    await expect(probeSettings(client)).resolves.toEqual({
      '/api/files': 200,
      '/api/skills': 500,
      '/api/connectors': 200,
      '/api/users': 200,
      '/api/api-keys': 200,
    });
  });
});
