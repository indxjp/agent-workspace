import { describe, expect, it } from 'vitest';
import { PLATFORM_EXPORT_MAX_BYTES } from '@indx-workspace/contracts/platforms';
import { createConnector } from '../connectors/handlers';
import { exportAgentVersion, exportFileBytes } from './export';
import {
  assertExported,
  assertProjectBuilt,
  encode,
  PETSTORE,
  PETSTORE_JSON,
  PRINCIPAL,
  SECRET_SENTINEL,
  seedAgentVersion,
  seedConnector,
  withExtras,
  WORKSPACE,
  world,
} from './export.test-support';
import {
  buildPortableProject,
  PlatformExportTooLargeError,
  type PortableProjectSources,
} from './project';

describe('an OpenAPI connector', () => {
  const CONNECTOR_PATH = 'agents.support-triage.definition.resources.connectors.0';

  async function openApiWorld(
    options: { readonly name?: string; readonly auth?: 'none' | 'bearer' } = {},
  ) {
    const name = options.name ?? 'petstore';
    return world({
      connectors: [name],
      seed: async (connectors) => {
        const created = await createConnector(
          connectors.forWorkspace(WORKSPACE),
          {
            kind: 'openapi',
            name,
            document: PETSTORE,
            allow: ['GET /pets'],
            ...(options.auth === 'bearer' ? { auth: 'bearer', credential: SECRET_SENTINEL } : {}),
          },
          { principalId: PRINCIPAL, userId: null },
          () => Promise.resolve({ ok: true }),
        );
        if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      },
    });
  }

  const noDocument = (sources: PortableProjectSources): PortableProjectSources => ({
    ...sources,
    connectors: { ...sources.connectors, openapiDocument: () => Promise.resolve(null) },
  });

  it('carries the stored document in the project and never drops the connector', async () => {
    const { agentId, sources } = await openApiWorld({ auth: 'bearer' });

    const built = await buildPortableProject(agentId, 1, sources);

    assertProjectBuilt(built);
    expect(built.project.openapiSpecs).toHaveLength(1);
    const [spec] = built.project.openapiSpecs;
    expect(spec?.content).toBe(PETSTORE);
    expect(spec?.ref).toMatch(/^openapi\/[0-9a-f-]{36}\.yaml$/u);
    expect(built.dropped.map((each) => each.path)).not.toContain(CONNECTOR_PATH);
    const [tool] = built.project.agents[0]?.tools ?? [];
    expect(tool).toMatchObject({
      kind: 'openapi',
      name: 'petstore',
      auth: { secretRef: 'CONNECTOR_PETSTORE' },
    });
    expect(JSON.stringify(built)).not.toContain(SECRET_SENTINEL);
    expect(JSON.stringify(built)).toContain('CONNECTOR_PETSTORE');
  });

  it('is exported to a platform without a dropped verdict for the connector', async () => {
    const { agentId, sources } = await openApiWorld();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).not.toContainEqual(
      expect.objectContaining({ path: CONNECTOR_PATH, verdict: 'dropped' }),
    );
  });

  it.each([
    [
      'its base URL has an unknown query parameter',
      { document: PETSTORE, baseUrl: 'https://93.184.216.34/v1?code=URL-SENTINEL-1234' },
      'the connector petstore: the base URL carries a query, fragment or credential; re-register it without one',
    ],
    [
      "its document's servers[0].url has a query",
      {
        document: PETSTORE.replace('https://{host}/v1', 'https://{host}/v1?code=URL-SENTINEL-1234'),
        baseUrl: 'https://93.184.216.34/v1',
      },
      'the connector petstore: a server URL in its document carries a query, fragment or credential; replace it with a document without one',
    ],
  ])('is dropped when %s, naming it and never the URL', async (_form, body, note) => {
    const { agentId, sources } = await world({
      connectors: ['petstore'],
      seed: async (connectors) => {
        const created = await createConnector(
          connectors.forWorkspace(WORKSPACE),
          { kind: 'openapi', name: 'petstore', allow: ['GET /pets'], ...body },
          { principalId: PRINCIPAL, userId: null },
          () => Promise.resolve({ ok: true }),
        );
        if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      },
    });

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      sources,
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual({
      path: CONNECTOR_PATH,
      verdict: 'dropped',
      code: 'field_unsupported',
      note,
    });
    const report = outcome.response.files.find((file) => file.path === 'PLATFORM_REPORT.md');
    if (report === undefined) throw new Error('the export carries PLATFORM_REPORT.md');
    const text = (file: typeof report): string => new TextDecoder().decode(exportFileBytes(file));
    expect(text(report)).toContain('the connector petstore');
    for (const file of outcome.response.files) {
      expect(text(file)).not.toContain('URL-SENTINEL-1234');
    }
    expect(JSON.stringify(outcome.response)).not.toContain('URL-SENTINEL-1234');
  });

  it('is dropped with a note to register it again when no document is stored', async () => {
    const { agentId, sources } = await openApiWorld();

    const outcome = await exportAgentVersion(
      agentId,
      { version: 1, platform: 'claude-managed-agents' },
      noDocument(sources),
    );

    assertExported(outcome);
    expect(outcome.response.report).toContainEqual({
      path: CONNECTOR_PATH,
      verdict: 'dropped',
      code: 'field_unsupported',
      note: 'the connector petstore was registered before Agent Workspace kept OpenAPI documents; replace it with its document and export again',
    });
  });

  it('is dropped, not exported as the wrong spec, when the stored text misses its digest', async () => {
    const { agentId, sources } = await openApiWorld();
    const stale: PortableProjectSources = {
      ...sources,
      connectors: {
        ...sources.connectors,
        openapiDocument: () => Promise.resolve(`${PETSTORE}\n# edited`),
      },
    };

    const built = await buildPortableProject(agentId, 1, stale);

    assertProjectBuilt(built);
    expect(built.project.openapiSpecs).toEqual([]);
    expect(built.dropped).toContainEqual(
      expect.objectContaining({
        path: CONNECTOR_PATH,
        note: "the connector petstore's stored document does not match its digest; replace it with its document and export again",
      }),
    );
  });

  it('is dropped before its document is read when its name is not a portable tool name', async () => {
    const { agentId, sources } = await openApiWorld({ name: 'Pet Store' });
    const read: string[] = [];
    const watched: PortableProjectSources = {
      ...sources,
      connectors: {
        ...sources.connectors,
        openapiDocument: (id) => {
          read.push(id);
          return sources.connectors.openapiDocument(id);
        },
      },
    };

    const built = await buildPortableProject(agentId, 1, watched);

    assertProjectBuilt(built);
    expect(read).toEqual([]);
    expect(built.project.openapiSpecs).toEqual([]);
    expect(built.dropped).toContainEqual(
      expect.objectContaining({
        path: CONNECTOR_PATH,
        note: 'the connector Pet Store cannot be a portable tool name (1-64 letters, digits, "_" or "-"); rename it and export again',
      }),
    );
  });

  it("carries a subagent's JSON document under a .json ref", async () => {
    const seeded = await world({
      seed: async (connectors) => {
        const created = await createConnector(
          connectors.forWorkspace(WORKSPACE),
          { kind: 'openapi', name: 'petstore', document: PETSTORE_JSON, allow: ['GET /pets'] },
          { principalId: PRINCIPAL, userId: null },
          () => Promise.resolve({ ok: true }),
        );
        if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      },
    });
    await seedAgentVersion(seeded, 'researcher', 'production', { connectors: ['petstore'] });
    await withExtras(seeded, { subagents: ['researcher'] });

    const built = await buildPortableProject(seeded.agentId, 2, seeded.sources);

    assertProjectBuilt(built);
    expect(built.project.openapiSpecs).toHaveLength(1);
    const [spec] = built.project.openapiSpecs;
    expect(spec?.content).toBe(PETSTORE_JSON);
    expect(spec?.ref).toMatch(/^openapi\/[0-9a-f-]{36}\.json$/u);
    expect(built.dropped.map((each) => each.path)).not.toContainEqual(
      expect.stringContaining('resources.connectors'),
    );
  });

  it('is dropped when it needs a credential and none is on file', async () => {
    const { agentId, sources } = await openApiWorld({ auth: 'bearer' });
    const uncredentialed: PortableProjectSources = {
      ...sources,
      connectors: {
        ...sources.connectors,
        list: async () =>
          (await sources.connectors.list()).map((each) => ({ ...each, hasCredential: false })),
      },
    };

    const built = await buildPortableProject(agentId, 1, uncredentialed);

    assertProjectBuilt(built);
    expect(built.project.openapiSpecs).toEqual([]);
    expect(built.dropped).toContainEqual(
      expect.objectContaining({
        path: CONNECTOR_PATH,
        note: 'the connector petstore requires a credential but none is on file; add one and export again',
      }),
    );
  });

  it('is dropped with an MCP connector whose secret name it would share', async () => {
    const seeded = await world({
      connectors: ['a_b', 'a-b'],
      seed: async (connectors) => {
        await seedConnector(connectors, 'a_b', { authType: 'bearer' });
        const created = await createConnector(
          connectors.forWorkspace(WORKSPACE),
          {
            kind: 'openapi',
            name: 'a-b',
            document: PETSTORE,
            allow: ['GET /pets'],
            auth: 'bearer',
            credential: SECRET_SENTINEL,
          },
          { principalId: PRINCIPAL, userId: null },
          () => Promise.resolve({ ok: true }),
        );
        if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      },
    });

    const built = await buildPortableProject(seeded.agentId, 1, seeded.sources);

    assertProjectBuilt(built);
    expect(built.project.openapiSpecs).toEqual([]);
    expect(built.dropped).toHaveLength(2);
    for (const each of built.dropped) {
      expect(each.note).toContain('would share the secret name CONNECTOR_A_B');
    }
  });

  it('is not exported from another workspace, which cannot see the connector', async () => {
    const { agentId, otherWorkspace } = await openApiWorld();

    const built = await buildPortableProject(agentId, 1, otherWorkspace);

    expect(built.ok).toBe(false);
  });

  it('counts its document toward the size cap with the skills', async () => {
    const skill = encode('---\nname: triage-guide\ndescription: Triage.\n---\nBody\n');
    const { agentId, sources } = await world({
      connectors: ['petstore'],
      skills: ['triage-guide'],
      skillFiles: {
        'triage-guide': [
          { path: 'SKILL.md', bytes: skill },
          {
            path: 'assets/big.bin',
            bytes: new Uint8Array(PLATFORM_EXPORT_MAX_BYTES - skill.byteLength - 10),
          },
        ],
      },
      seed: async (connectors) => {
        const created = await createConnector(
          connectors.forWorkspace(WORKSPACE),
          { kind: 'openapi', name: 'petstore', document: PETSTORE, allow: ['GET /pets'] },
          { principalId: PRINCIPAL, userId: null },
          () => Promise.resolve({ ok: true }),
        );
        if (created.status !== 201) throw new Error(JSON.stringify(created.body));
      },
    });

    await expect(buildPortableProject(agentId, 1, sources)).rejects.toBeInstanceOf(
      PlatformExportTooLargeError,
    );
  });
});
