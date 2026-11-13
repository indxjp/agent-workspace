import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { describe, expect, it } from 'vitest';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute, GET as listRoute } from '../../app/api/skills/route';
import { skillFileKey, skillMetaKey } from './keys';
import { fixture, nameContext, postJson, req, WORKSPACE_A } from './skill-routes.test-support';

describe('K-4: a non-UTF-8 SKILL.md is refused', () => {
  // A lone continuation byte (0x80) is never valid UTF-8 on its own.
  const invalidUtf8Base64 = Buffer.from([0x80]).toString('base64');

  it('POST /api/skills refuses it with 400 malformed_content', async () => {
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'broken',
        files: [{ path: 'SKILL.md', contentBase64: invalidUtf8Base64 }],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'malformed_content' } });
    // Nothing was written: a later import of the same name is not a 409.
    const retry = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'broken',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('ok').toString('base64') }],
      }),
    );
    expect(retry.status).toBe(201);
  });

  it('PATCH /api/skills/:name refuses replacing SKILL.md with invalid UTF-8 bytes', async () => {
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# ok').toString('base64') }],
      }),
    );
    const response = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ files: [{ path: 'SKILL.md', contentBase64: invalidUtf8Base64 }] }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'malformed_content' } });
  });
});

describe('K-4: a pre-existing unreadable SKILL.md answers 500 store_inconsistent', () => {
  it(
    'hides the whole GET /api/skills list rather than omitting the row or its id',
    hidesWholeGETApiSkillsListRatherThan,
  );

  /**
   * Review finding: `GET`/`PATCH /api/skills/:name` used to bail out of the catalog sync with a
   * bare `return response;` when the export carried no `SKILL.md`, answering `200` with a body
   * that has no `id` — which `SkillDetailSchema` rejects — for exactly the row `GET /api/skills`
   * answers `500` for. The two routes must not disagree about one row.
   */
  it(
    'answers 500 on GET and PATCH /api/skills/:name for a row with no SKILL.md object',
    answers500GETPATCHApiSkillsNameRow,
  );

  /**
   * Review finding, the other half: a `SKILL.md` that *exists* but whose bytes are not valid UTF-8
   * is the same residual — `describeSkill` reports `source: null` for both — but `exportSkill`
   * base64-encodes those bytes just the same, so `manifest === undefined` is false and the route
   * used to answer `200` with an id built from a lossy `U+FFFD` decode, writing mojibake into the
   * catalog while `GET /api/skills` answered `500` for the very same row.
   */
  it(
    'answers 500 on GET and PATCH /api/skills/:name for a SKILL.md with invalid UTF-8 bytes',
    answers500GETPATCHApiSkillsNameSKILL,
  );

  /**
   * The export path is deliberately unaffected: `SkillExportSchema` carries no `id`, so an export
   * of the same row needs no catalog and still answers 200 (with no files).
   */
  it(
    'still exports the same row, because an export carries no id',
    stillExportsSameRowBecauseExportCarriesNo,
  );
});

async function hidesWholeGETApiSkillsListRatherThan() {
  // A well-formed skill, so the list is provably non-empty before the broken one is added.
  await importRoute(
    postJson(WORKSPACE_A, {
      name: 'fine',
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Fine').toString('base64') }],
    }),
  );
  // Simulate a pre-K-4 row: write the meta record and an unreadable SKILL.md directly to the
  // object store, bypassing the route layer's new UTF-8 guard entirely.
  const objectStore = createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(
    WORKSPACE_A,
  );
  const now = new Date().toISOString();
  await objectStore.write(
    skillMetaKey('broken'),
    new TextEncoder().encode(
      JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
    ),
    { contentType: 'application/json' },
  );
  await objectStore.write(skillFileKey('broken', 'SKILL.md'), Uint8Array.from([0x80]), {
    contentType: null,
  });

  const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
}

async function answers500GETPATCHApiSkillsNameRow() {
  // A meta record with no SKILL.md object at all: reachable from a pre-existing row, and from
  // `patchSkill`'s rollback path when no prior copy of SKILL.md was available to restore.
  const objectStore = createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(
    WORKSPACE_A,
  );
  const now = new Date().toISOString();
  await objectStore.write(
    skillMetaKey('orphan'),
    new TextEncoder().encode(
      JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
    ),
    { contentType: 'application/json' },
  );

  const getResponse = await detailRoute(
    req('GET', '/api/skills/orphan', { workspace: WORKSPACE_A }),
    nameContext('orphan'),
  );
  expect(getResponse.status, await getResponse.clone().text()).toBe(500);
  expect(await getResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });

  const patchResponse = await patchRoute(
    req('PATCH', '/api/skills/orphan', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ enabled: false }),
      contentType: 'application/json',
    }),
    nameContext('orphan'),
  );
  expect(patchResponse.status, await patchResponse.clone().text()).toBe(500);
  expect(await patchResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
}

async function answers500GETPATCHApiSkillsNameSKILL() {
  const objectStore = createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(
    WORKSPACE_A,
  );
  const now = new Date().toISOString();
  await objectStore.write(
    skillMetaKey('broken'),
    new TextEncoder().encode(
      JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
    ),
    { contentType: 'application/json' },
  );
  // The same lone continuation byte the list test above writes: never valid UTF-8 on its own.
  await objectStore.write(skillFileKey('broken', 'SKILL.md'), Uint8Array.from([0x80]), {
    contentType: null,
  });

  const getResponse = await detailRoute(
    req('GET', '/api/skills/broken', { workspace: WORKSPACE_A }),
    nameContext('broken'),
  );
  expect(getResponse.status, await getResponse.clone().text()).toBe(500);
  expect(await getResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });

  const patchResponse = await patchRoute(
    req('PATCH', '/api/skills/broken', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({ enabled: false }),
      contentType: 'application/json',
    }),
    nameContext('broken'),
  );
  expect(patchResponse.status, await patchResponse.clone().text()).toBe(500);
  expect(await patchResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
}

async function stillExportsSameRowBecauseExportCarriesNo() {
  const objectStore = createLocalFilesystemObjectStoreProvider(fixture.rootDir).forWorkspace(
    WORKSPACE_A,
  );
  const now = new Date().toISOString();
  await objectStore.write(
    skillMetaKey('orphan'),
    new TextEncoder().encode(
      JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
    ),
    { contentType: 'application/json' },
  );

  const response = await detailRoute(
    req('GET', '/api/skills/orphan?export=true', { workspace: WORKSPACE_A }),
    nameContext('orphan'),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ skill: { name: 'orphan', files: [] } });
}
