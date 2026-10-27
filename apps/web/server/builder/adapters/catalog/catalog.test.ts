import crypto from 'node:crypto';

import { BUILDER_CATALOG_KINDS } from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { createInMemoryConnectorsStoreProvider } from '../../../connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../../models/memory-store';
import type { Role } from '../../../rbac/roles';
import { createInMemoryRuntimeProfileStoreProvider } from '../../../runtimes/memory-store';
import type { CatalogEntry, CatalogPort } from '../../ports';
import { callContextOf } from '../../testing/context';
import { describeCatalogConformance } from './catalog.contract';
import { MemoryCatalog } from './memory';
import { readableKinds } from './access';
import { createCatalog } from './production';

const WORKSPACE = crypto.randomUUID();
const SECRET_KEY = /secret|token|password|credential|authorization|apiKey|url/i;
const CREDENTIAL = 'sk-live-credential-0001';
const CONNECTOR_URL = 'https://crm.example.test/mcp?token=abc';

const ctxOf = (role: Role | null) => callContextOf(WORKSPACE, role);

/** Real in-memory stores holding rows with every secret-bearing field a list handler can see. */
async function productionCatalog(): Promise<CatalogPort> {
  const owner = { principalId: crypto.randomUUID(), userId: null };
  const connectors = createInMemoryConnectorsStoreProvider();
  const connectorStore = connectors.forWorkspace(WORKSPACE);
  await connectorStore.create(
    {
      name: 'crm',
      transport: 'http',
      command: null,
      args: null,
      url: CONNECTOR_URL,
      authType: 'bearer',
      credential: CREDENTIAL,
    },
    owner,
  );
  await connectorStore.create(
    {
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['mcp-files', '--token=abc'],
      url: null,
      authType: 'none',
      credential: null,
    },
    owner,
  );
  const models = createInMemoryModelsStoreProvider([WORKSPACE]);
  await models.forWorkspace(WORKSPACE).create({
    name: 'Primary',
    provider: 'anthropic-compatible',
    apiKey: CREDENTIAL,
    config: { baseUrl: 'https://llm.example.test' },
  });
  const runtimeProfiles = createInMemoryRuntimeProfileStoreProvider();
  await runtimeProfiles.forWorkspace(WORKSPACE).create({
    name: 'Standard',
    driver: 'docker',
    runtimeConnectionId: null,
    cpu: 1,
    memoryMb: 1024,
    diskMb: 5120,
    networkPolicy: 'restricted',
    allowedDomains: ['api.anthropic.com'],
    filesystem: 'read-write',
    persistPaths: ['/workspace/output'],
    timeoutSeconds: 3600,
    idleTimeoutSeconds: 600,
    driverConfig: { note: 'default' },
  });
  return createCatalog({
    connectors,
    models,
    runtimeProfiles,
    skills: () =>
      Promise.resolve({
        status: 200,
        body: {
          skills: [
            {
              id: crypto.randomUUID(),
              name: 'triage',
              enabled: true,
              source: `---\nname: triage\n---\nuse ${CREDENTIAL}`,
            },
          ],
        },
      }),
  });
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

describe('the production catalog', () => {
  it('never returns a secret-like key, and a connector is exactly {id, kind, name}', async () => {
    const entries = await (await productionCatalog()).list(ctxOf('owner'), BUILDER_CATALOG_KINDS);

    expect(entries.map((entry) => entry.kind)).toContain('connectors');
    expect(keysOf(entries).filter((key) => SECRET_KEY.test(key))).toEqual([]);
    for (const entry of entries.filter((candidate) => candidate.kind === 'connectors')) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'name']);
    }
    const text = JSON.stringify(entries);
    expect(text).not.toContain(CREDENTIAL);
    expect(text).not.toContain(CONNECTOR_URL);
  });
});

describe('catalog_list is no wider for an Owner than for an Admin', () => {
  it('readableKinds gives an Owner exactly the kinds an Admin gets', () => {
    expect(readableKinds('owner', BUILDER_CATALOG_KINDS)).toEqual(
      readableKinds('admin', BUILDER_CATALOG_KINDS),
    );
  });

  it('the production catalog lists the same entries for both roles, skills included', async () => {
    const catalog = await productionCatalog();
    const key = (entry: CatalogEntry) => `${entry.kind}:${entry.name}`;
    const listed = async (role: Role) =>
      (await catalog.list(ctxOf(role), BUILDER_CATALOG_KINDS)).map(key).sort();
    const owner = await listed('owner');
    expect(owner).toContain('skills:triage');
    expect(owner).toEqual(await listed('admin'));
  });
});

/** The same workspace `productionCatalog` seeds, as fixed rows for the memory adapter. */
const MEMORY_ENTRIES: readonly CatalogEntry[] = [
  { kind: 'engines', id: crypto.randomUUID(), name: 'Claude Code' },
  { kind: 'models', id: crypto.randomUUID(), name: 'Primary' },
  { kind: 'skills', id: crypto.randomUUID(), name: 'triage' },
  { kind: 'connectors', id: crypto.randomUUID(), name: 'crm' },
  { kind: 'connectors', id: crypto.randomUUID(), name: 'files' },
  { kind: 'runtimeProfiles', id: crypto.randomUUID(), name: 'Standard' },
];

describeCatalogConformance('the production adapter', async () => {
  const port = await productionCatalog();
  return { port, entries: await port.list(ctxOf('owner'), BUILDER_CATALOG_KINDS), ctxOf };
});
describeCatalogConformance('the memory adapter', () =>
  Promise.resolve({ port: new MemoryCatalog(MEMORY_ENTRIES), entries: MEMORY_ENTRIES, ctxOf }),
);
