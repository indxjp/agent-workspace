/**
 * The tool connector handlers (ADR-0113 C15) over the in-memory store, with the egress check
 * injected where a test needs a refusal and the real policy where it judges a literal address.
 * The parity table is the C8 rule: a dry run and a save of one refused body answer the same.
 */
import { readFileSync } from 'node:fs';

import { TestConnectionOutcomeSchema } from '@indx-workspace/contracts/connectors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConnector, deleteConnector, getConnector, updateConnector } from './handlers';
import { createInMemoryConnectorsStoreProvider } from './memory-store';
import { defaultCheckConnectorEgress, type CheckConnectorEgress } from './tools';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = { principalId: '77777777-7777-4777-8777-777777777777', userId: null };
const PETSTORE = readFileSync(
  new URL('../openapi/fixtures/petstore-3.0.yaml', import.meta.url),
  'utf8',
);
const PG_URL = 'postgres://reader:pw-DO-NOT-ECHO@10.0.0.5:5432/shop';

const open: CheckConnectorEgress = () => Promise.resolve({ ok: true });
const privateRefused: CheckConnectorEgress = (url) =>
  Promise.resolve(
    url.includes('10.0.0.') ? { ok: false, reason: 'a private address' } : { ok: true },
  );

const openapiBody = {
  kind: 'openapi',
  name: 'pets',
  document: PETSTORE,
  allow: ['GET /pets', 'GET /pets/*', 'GET /pets/*/photos'],
};
const postgresBody = {
  kind: 'postgres',
  name: 'shop',
  credential: 'postgres://reader:pw@93.184.216.34:5432/shop',
  tables: ['public.orders'],
  readOnly: true,
};

function store() {
  return createInMemoryConnectorsStoreProvider().forWorkspace(WORKSPACE);
}

function errorOf(body: unknown): { code: string; details?: readonly string[] } {
  return (body as { error: { code: string; details?: readonly string[] } }).error;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('tool connector registration', () => {
  const refusals: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [
      'an external $ref',
      {
        ...openapiBody,
        document: PETSTORE.replace('#/components/parameters/PetId', './other.yaml#/X'),
      },
    ],
    ['POST /pets in allow', { ...openapiBody, allow: ['POST /pets'] }],
    ['operationId:addPet', { ...openapiBody, allow: ['operationId:addPet'] }],
    [
      'a relative server',
      { ...openapiBody, document: PETSTORE.replace('https://{host}/v1', '/v1') },
    ],
    ['a private baseUrl', { ...openapiBody, baseUrl: 'https://10.0.0.1/v1' }],
    ['a private database host', { ...postgresBody, credential: PG_URL }],
    ['readOnly false', { ...postgresBody, readOnly: false }],
    ['an unknown key', { ...openapiBody, extra: 1 }],
  ];

  it.each(refusals)(
    '%s: the dry run and the save answer the same, and the dry run writes nothing',
    async (_, body) => {
      const connectors = store();
      const dry = await createConnector(
        connectors,
        { ...body, dryRun: true },
        null,
        privateRefused,
      );
      expect(await connectors.list()).toEqual([]);
      const saved = await createConnector(connectors, body, OWNER, privateRefused);
      expect(dry).toEqual(saved);
      expect(saved.status).toBeGreaterThanOrEqual(400);
      expect(await connectors.list()).toEqual([]);
    },
  );

  it('refuses a private baseUrl with 422 connector_spec_invalid', async () => {
    const result = await createConnector(
      store(),
      { ...openapiBody, baseUrl: 'https://10.0.0.1/v1' },
      OWNER,
      privateRefused,
    );
    expect(result.status).toBe(422);
    expect(errorOf(result.body).code).toBe('connector_spec_invalid');
    expect(errorOf(result.body).details?.[0]).toMatch(/^baseUrl: /u);
  });

  it('judges loopback by the deployment posture', async () => {
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'production');
    const production = await createConnector(
      store(),
      { ...openapiBody, baseUrl: 'https://127.0.0.1/v1' },
      OWNER,
      defaultCheckConnectorEgress,
    );
    expect(production.status).toBe(422);
    vi.stubEnv('AW_DEPLOYMENT_POSTURE', 'local');
    vi.stubEnv('HOST', '127.0.0.1');
    const local = await createConnector(
      store(),
      { ...openapiBody, baseUrl: 'http://127.0.0.1:1/v1' },
      OWNER,
      defaultCheckConnectorEgress,
    );
    expect(local.status).toBe(201);
  });

  it('refuses a private database host without echoing the connection URL', async () => {
    const result = await createConnector(
      store(),
      { ...postgresBody, credential: PG_URL },
      OWNER,
      privateRefused,
    );
    expect(result.status).toBe(422);
    expect(JSON.stringify(result.body)).not.toContain('10.0.0.5');
    expect(JSON.stringify(result.body)).not.toContain('pw-DO-NOT-ECHO');
  });

  it('answers a successful dry run with a TestConnectionOutcome and writes no row', async () => {
    const connectors = store();
    for (const body of [openapiBody, postgresBody]) {
      const result = await createConnector(connectors, { ...body, dryRun: true }, null, open);
      expect(result.status).toBe(200);
      const outcome = TestConnectionOutcomeSchema.parse(result.body);
      expect(outcome.ok && outcome.toolCount).toBe(3);
    }
    expect(await connectors.list()).toEqual([]);
  });

  it('refuses an unknown kind with 400 connector_kind_unsupported', async () => {
    const result = await createConnector(store(), { kind: 'ftp', name: 'x' }, OWNER, open);
    expect(result.status).toBe(400);
    expect(errorOf(result.body).code).toBe('connector_kind_unsupported');
  });

  it('refuses dryRun: false, an option that would be ignored', async () => {
    const result = await createConnector(store(), { ...postgresBody, dryRun: false }, OWNER, open);
    expect(result.status).toBe(400);
  });

  it('deletes a tool connector', async () => {
    const connectors = store();
    const created = await createConnector(
      connectors,
      { ...openapiBody, auth: 'bearer', credential: 'tok' },
      OWNER,
      open,
    );
    const { id } = created.body as { id: string };
    expect((await deleteConnector(connectors, id)).status).toBe(204);
    expect((await getConnector(connectors, id)).status).toBe(404);
  });

  it('carries the document verbatim to the store, and none for postgres', async () => {
    const connectors = store();
    const pets = await createConnector(connectors, openapiBody, OWNER, open);
    const shop = await createConnector(connectors, postgresBody, OWNER, open);
    expect(await connectors.openapiDocument((pets.body as { id: string }).id)).toBe(PETSTORE);
    expect(await connectors.openapiDocument((shop.body as { id: string }).id)).toBeNull();
  });

  describe('PATCH', () => {
    async function created() {
      const connectors = store();
      const result = await createConnector(connectors, openapiBody, OWNER, open);
      return { connectors, id: (result.body as { id: string }).id };
    }

    it('replaces the document and updates the operations', async () => {
      const { connectors, id } = await created();
      const result = await updateConnector(
        connectors,
        id,
        { ...openapiBody, allow: ['GET /pets'] },
        open,
      );
      expect(result.status).toBe(200);
      expect(
        (result.body as { openapi: { operations: unknown[] } }).openapi.operations,
      ).toHaveLength(1);
    });

    it('answers a dry run without changing the row', async () => {
      const { connectors, id } = await created();
      const before = await connectors.get(id);
      const result = await updateConnector(
        connectors,
        id,
        { ...openapiBody, allow: ['GET /pets'], dryRun: true },
        open,
      );
      expect(result.status).toBe(200);
      expect(TestConnectionOutcomeSchema.safeParse(result.body).success).toBe(true);
      expect(await connectors.get(id)).toEqual(before);
    });

    it('refuses a changed kind, and a credential alone', async () => {
      const { connectors, id } = await created();
      expect((await updateConnector(connectors, id, { ...postgresBody }, open)).status).toBe(400);
      expect((await updateConnector(connectors, id, { credential: 'x' }, open)).status).toBe(400);
    });

    it('refuses a name-only PATCH with a control or bidi character', async () => {
      const { connectors, id } = await created();
      for (const name of ['a\0b', 'a\u202Eb']) {
        const result = await updateConnector(connectors, id, { name }, open);
        expect(result.status).toBe(400);
      }
    });

    it('changes enabled alone', async () => {
      const { connectors, id } = await created();
      const result = await updateConnector(connectors, id, { enabled: false }, open);
      expect(result.status).toBe(200);
      expect((result.body as { enabled: boolean }).enabled).toBe(false);
    });
  });

  it('refuses a name another kind already holds with 409', async () => {
    const connectors = store();
    await createConnector(
      connectors,
      { name: 'shared', transport: 'http', url: 'https://x.invalid' },
      OWNER,
    );
    const result = await createConnector(
      connectors,
      { ...openapiBody, name: 'shared' },
      OWNER,
      open,
    );
    expect(result.status).toBe(409);
  });
});
