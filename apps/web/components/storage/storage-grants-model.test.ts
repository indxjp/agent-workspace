import { createClient } from '@indx-workspace/sdk';
import {
  fetchDouble,
  fixtures,
  jsonResponse,
  type RecordedRequest,
} from '@indx-workspace/sdk/testing';
import { describe, expect, it } from 'vitest';

import {
  grantKey,
  grantFocusedAfterRemoval,
  removeStorageGrant,
  saveStorageGrant,
  storageGrantPath,
  withoutStorageGrant,
  withStorageGrant,
} from './storage-grants-model';

const base = fixtures.agentVersion().body;
const withFile = withStorageGrant(base, 'docs/guide.md', 'read');

describe('storageGrantPath', () => {
  it('trims slashes and keeps a folder name with a space', () => {
    expect(storageGrantPath('acme-data', '/reports/Q3 drafts/')).toBe(
      'storage://acme-data/reports/Q3 drafts',
    );
  });
});

describe('grantFocusedAfterRemoval', () => {
  const grant = (prefix: string) => ({ connectionId: 'c-1', prefix, access: 'read' as const });
  const [a, b, c] = [grant('a'), grant('b'), grant('c')];

  it('names the grant that moves into the removed row', () => {
    expect(grantFocusedAfterRemoval([a, b, c], grantKey(b), [a, c])).toBe(grantKey(c));
  });

  it('names the grant above when the last one was removed', () => {
    expect(grantFocusedAfterRemoval([a, b, c], grantKey(c), [a, b])).toBe(grantKey(b));
  });

  it('is null when no grant is left', () => {
    expect(grantFocusedAfterRemoval([a], grantKey(a), [])).toBeNull();
  });

  it('skips a neighbour that is gone from the saved list', () => {
    expect(grantFocusedAfterRemoval([a, b, c], grantKey(b), [a])).toBe(grantKey(a));
  });

  it('falls back to the first saved grant when the removed one was not listed', () => {
    expect(grantFocusedAfterRemoval([a], grantKey(b), [c])).toBe(grantKey(c));
  });
});

describe('withStorageGrant', () => {
  it('appends the grant and keeps the other files', () => {
    const next = withStorageGrant(withFile, 'storage://acme/reports', 'read');
    expect(next.definition.resources.files).toEqual([
      { path: 'docs/guide.md', access: 'read' },
      { path: 'storage://acme/reports', access: 'read' },
    ]);
  });

  it('replaces an equal path instead of repeating it', () => {
    const once = withStorageGrant(withFile, 'storage://acme/reports', 'read');
    const twice = withStorageGrant(once, 'storage://acme/reports', 'read-write');
    expect(twice.definition.resources.files).toEqual([
      { path: 'docs/guide.md', access: 'read' },
      { path: 'storage://acme/reports', access: 'read-write' },
    ]);
  });
});

describe('withoutStorageGrant', () => {
  it('drops only the grant at that path', () => {
    const both = withStorageGrant(withFile, 'storage://acme/reports', 'read');
    expect(withoutStorageGrant(both, 'storage://acme/reports').definition.resources.files).toEqual([
      { path: 'docs/guide.md', access: 'read' },
    ]);
  });
});

const STORED = { files: [], skillIds: [], connectorIds: [], storageGrants: [] };

function agentApi(options: {
  readonly versioned: boolean;
  readonly materialised?: number | null;
  readonly body?: typeof base;
}) {
  let versioned = options.versioned;
  let materialised =
    options.materialised === undefined ? (versioned ? 1 : null) : options.materialised;
  const double = fetchDouble((request: RecordedRequest) => {
    const route = `${request.method} ${request.url.pathname}`;
    if (route.endsWith('/versions') && request.method === 'GET') {
      return jsonResponse(200, {
        items: versioned ? [fixtures.agentVersion(options.body ? { body: options.body } : {})] : [],
        pointers: versioned ? [fixtures.agentVersionPointer()] : [],
        materialised,
      });
    }
    if (route.startsWith('PUT') && route.endsWith('/resources')) {
      versioned = true;
      materialised = 1;
      return jsonResponse(200, { assignments: STORED });
    }
    if (route.startsWith('GET') && route.endsWith('/resources')) {
      return jsonResponse(200, { assignments: STORED });
    }
    if (route.endsWith('/versions') && request.method === 'POST') {
      return jsonResponse(201, fixtures.agentVersion({ number: 2, via: 'ui' }));
    }
    if (route.startsWith('PUT') && route.endsWith('/pointers')) {
      return jsonResponse(200, {
        agent: fixtures.agent(),
        pointer: fixtures.agentVersionPointer({ number: 2 }),
      });
    }
    return jsonResponse(404, { error: { code: 'unexpected', message: route } });
  });
  const client = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'session' },
    fetch: double.fetch,
  });
  const shape = () => double.calls.map((call) => `${call.method} ${call.url.pathname}`);
  return { client, calls: double.calls, shape };
}

const AGENT = fixtures.agent().id;

describe('saveStorageGrant', () => {
  it('creates a console-edit version holding the grant, then moves local onto it', async () => {
    const { client, calls, shape } = agentApi({ versioned: true });
    await saveStorageGrant(client, AGENT, 'storage://acme/reports', 'read');
    expect(shape()).toEqual([
      `GET /api/agents/${AGENT}/versions`,
      `POST /api/agents/${AGENT}/versions`,
      `PUT /api/agents/${AGENT}/pointers`,
      `GET /api/agents/${AGENT}/resources`,
    ]);
    expect(calls[1]?.json).toMatchObject({
      via: 'ui',
      summary: 'Console edit: storage grant',
      body: {
        definition: { resources: { files: [{ path: 'storage://acme/reports', access: 'read' }] } },
      },
    });
    expect(calls[2]?.json).toEqual({ environment: 'local', version: 2 });
  });

  it('first saves the stored assignments when the agent has no local version', async () => {
    const { client, shape } = agentApi({ versioned: false });
    await saveStorageGrant(client, AGENT, 'storage://acme/reports', 'read');
    expect(shape().slice(0, 4)).toEqual([
      `GET /api/agents/${AGENT}/versions`,
      `GET /api/agents/${AGENT}/resources`,
      `PUT /api/agents/${AGENT}/resources`,
      `GET /api/agents/${AGENT}/versions`,
    ]);
    expect(shape()).toContain(`PUT /api/agents/${AGENT}/pointers`);
  });

  it('rebuilds from the agent row when it was edited since local was materialised', async () => {
    const { client, shape } = agentApi({ versioned: true, materialised: null });
    await saveStorageGrant(client, AGENT, 'storage://acme/reports', 'read');
    expect(shape()).toEqual([
      `GET /api/agents/${AGENT}/versions`,
      `GET /api/agents/${AGENT}/resources`,
      `PUT /api/agents/${AGENT}/resources`,
      `GET /api/agents/${AGENT}/versions`,
      `POST /api/agents/${AGENT}/versions`,
      `PUT /api/agents/${AGENT}/pointers`,
      `GET /api/agents/${AGENT}/resources`,
    ]);
  });
});

describe('removeStorageGrant', () => {
  it('creates a console-edit version without the grant, then moves local onto it', async () => {
    const body = withStorageGrant(base, 'storage://acme/reports', 'read');
    const { client, calls, shape } = agentApi({ versioned: true, body });
    await removeStorageGrant(client, AGENT, 'storage://acme/reports');
    expect(shape()).toEqual([
      `GET /api/agents/${AGENT}/versions`,
      `POST /api/agents/${AGENT}/versions`,
      `PUT /api/agents/${AGENT}/pointers`,
      `GET /api/agents/${AGENT}/resources`,
    ]);
    expect(calls[1]?.json).toMatchObject({
      via: 'ui',
      summary: 'Console edit: storage grant removed',
    });
    expect(calls[2]?.json).toEqual({ environment: 'local', version: 2 });
  });

  it('refuses a grant missing from the local body without saving a version', async () => {
    const { client, shape } = agentApi({ versioned: true });
    await expect(removeStorageGrant(client, AGENT, 'storage://acme/reports')).rejects.toThrow(
      "The grant is not in the agent's current version.",
    );
    expect(shape()).toEqual([`GET /api/agents/${AGENT}/versions`]);
  });
});
