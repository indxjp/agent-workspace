// @story US-STO-12
import { describe, expect, it } from 'vitest';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { StorageClient } from './storage.js';

const ID = '33333333-3333-4333-8333-333333333333';

const connection = {
  id: ID,
  name: 'acme-data',
  provider: 's3',
  url: 's3://acme-data/exports',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:00.000Z',
};

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `The request was refused: ${code}.` } });
}

function client(route: (request: RecordedRequest) => Response) {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com/control',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { storage: new StorageClient(http), calls: api.calls };
}

const secret = (): string => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID();

describe('StorageClient.connections', () => {
  it('[US-STO-12][api][sdk] connect a bucket and browse a granted folder', async () => {
    const { storage, calls } = client((request) => {
      if (request.method === 'POST') return json(201, connection);
      const cursor = request.url.searchParams.get('cursor');
      return cursor === null
        ? json(200, { entries: [{ path: 'reports/2026', kind: 'folder' }], next: 'c+1/=' })
        : json(200, { entries: [{ path: 'reports/a.txt', kind: 'file', size: 3 }] });
    });
    const created = await storage.connections.create({
      name: 'acme-data',
      url: 's3://acme-data/exports',
      allowedPrefixes: ['reports'],
      credential: { provider: 's3', accessKeyId: 'id', secretAccessKey: secret() },
    });
    const paths: string[] = [];
    for await (const entry of storage.connections.browse(created.id, { prefix: 'reports/2026' })) {
      paths.push(entry.path);
    }
    expect(paths).toEqual(['reports/2026', 'reports/a.txt']);
    expect(calls.map((call) => call.url.search)).toEqual([
      '',
      '?prefix=reports%2F2026',
      `?prefix=reports%2F2026&cursor=${encodeURIComponent('c+1/=')}`,
    ]);
    expect(calls[2]?.url.searchParams.get('cursor')).toBe('c+1/=');
  });

  it('[US-STO-12][api][sdk] get takes a UUID as an id and anything else as a name', async () => {
    const { storage, calls } = client((request) =>
      request.url.pathname.endsWith(`/${ID}`)
        ? json(200, connection)
        : json(200, { connections: [connection] }),
    );
    expect(await storage.connections.get(ID)).toEqual(connection);
    expect(calls.map((call) => call.url.pathname)).toEqual([
      `/control/api/storage-connections/${ID}`,
    ]);
    expect(await storage.connections.get('acme-data')).toEqual(connection);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.pathname).toBe('/control/api/storage-connections');

    const unknown = await storage.connections.get('nope').catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(ApiProblemError);
    expect(unknown).toMatchObject({ status: 404, code: 'storage_connection_not_found' });
  });

  it('[US-STO-12][api][sdk] a prefix is percent-encoded once, so the server reads it unchanged', async () => {
    const { storage, calls } = client(() => json(200, { entries: [] }));
    const prefixes = ['Q3 reports/', 'é', 'a+b', 'a&b', 'a#b', '50%25', '%2e%2e'];
    for (const prefix of prefixes) {
      for await (const entry of storage.connections.browse(ID, { prefix })) {
        throw new Error(`unexpected ${entry.path}`);
      }
    }
    expect(calls.map((call) => call.url.search)).toEqual(
      prefixes.map((prefix) => `?prefix=${encodeURIComponent(prefix)}`),
    );
    expect(calls.map((call) => call.url.searchParams.get('prefix'))).toEqual(prefixes);
  });

  it('[US-STO-12][api][sdk] a credential is never echoed', async () => {
    const [accessKeyId, secretAccessKey, rotated] = [secret(), secret(), secret()];
    const { storage, calls } = client((request) =>
      request.method === 'POST' && request.url.pathname.endsWith('/storage-connections')
        ? problem(409, 'storage_connection_name_taken')
        : json(200, connection),
    );
    const results: unknown[] = [
      await storage.connections.rotateCredential(ID, {
        provider: 's3',
        accessKeyId,
        secretAccessKey: rotated,
      }),
      await storage.connections.update(ID, {
        credential: { provider: 's3', accessKeyId, secretAccessKey },
      }),
    ];
    const refused = await storage.connections
      .create({
        name: 'acme-data',
        url: 's3://acme-data/exports',
        allowedPrefixes: ['reports'],
        credential: { provider: 's3', accessKeyId, secretAccessKey },
      })
      .catch((error: unknown) => error);
    results.push(refused, String(refused), storage);
    expect(calls[0]?.method).toBe('PUT');
    expect(JSON.stringify(calls[0]?.json)).toContain(rotated);

    const text = JSON.stringify(results);
    for (const value of [accessKeyId, secretAccessKey, rotated]) {
      for (let at = 0; at + 6 <= value.length; at += 1) {
        expect(text).not.toContain(value.slice(at, at + 6));
      }
    }
  });

  it('[US-STO-12][api][sdk] test resolves a failed probe, remove resolves on 204, and a body outside the contract is refused', async () => {
    const answers = [
      json(200, { ok: false, code: 'forbidden' }),
      new Response(null, { status: 204 }),
      json(200, { ok: true, extra: 1 }),
    ];
    const { storage } = client(() => answers.shift() ?? json(500, {}));
    expect(await storage.connections.test(ID)).toEqual({ ok: false, code: 'forbidden' });
    expect(await storage.connections.remove(ID)).toBeUndefined();
    await expect(storage.connections.test(ID)).rejects.toBeInstanceOf(ContractViolationError);
  });
});
