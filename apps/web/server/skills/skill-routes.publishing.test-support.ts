import { SkillResponseSchema, SkillRevisionResponseSchema } from '@indx-workspace/contracts/skills';
import { describe, expect, it } from 'vitest';
import { POST as publishRoute } from '../../app/api/skills/[name]/revisions/route';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as importRoute } from '../../app/api/skills/route';
import { skillRevisionRowFolder } from './keys';
import {
  fixture,
  nameContext,
  postJson,
  req,
  WORKSPACE_A,
  WORKSPACE_B,
} from './skill-routes.test-support';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const skillMd = (body: string): string => b64(`---\nname: demo\n---\n${body}\n`);

function publish(files: unknown, name = 'demo', workspace = WORKSPACE_A): Promise<Response> {
  return publishRoute(
    req('POST', `/api/skills/${name}/revisions`, {
      workspace,
      body: JSON.stringify({ files }),
      contentType: 'application/json',
    }),
    nameContext(name),
  );
}

async function revisionRows(revision: number): Promise<Record<string, string>> {
  const ctx = { workspaceId: WORKSPACE_A };
  const listed = await fixture.skillsService.list(
    ctx,
    'skills',
    skillRevisionRowFolder('demo', revision),
  );
  const out: Record<string, string> = {};
  for (const row of listed.rows) {
    const opened = await fixture.skillsService.open(ctx, row);
    if (opened === null) throw new Error(`${row.path} has no bytes`);
    out[row.path] = await new Response(opened.body).text();
  }
  return out;
}

async function revisionBytes(revision: number): Promise<string | null> {
  const rows = await revisionRows(revision);
  return rows[`${skillRevisionRowFolder('demo', revision)}/SKILL.md`] ?? null;
}

async function importDemo(): Promise<void> {
  const response = await importRoute(
    postJson(WORKSPACE_A, {
      name: 'demo',
      files: [{ path: 'SKILL.md', contentBase64: skillMd('v0') }],
    }),
  );
  expect(response.status).toBe(201);
}

describe('POST /api/skills/:name/revisions (SDK-19, N-1)', () => {
  /** The text of every file row of one published revision, by catalog path. */

  it(
    'numbers revisions 1, 2 and lists them newest first on GET',
    numbersRevisions12ListsThemNewestFirst,
  );

  it(
    'leaves a published revision unchanged by a later publish, PATCH or disable',
    leavesPublishedRevisionUnchangedLaterPublishPATCHDisable,
  );

  it(
    'cannot be written through import, PATCH or a re-publish: every route leaves the published bytes alone',
    cannotBeWrittenImportPATCHRePublishEvery,
  );

  it(
    'replaces the current content, dropping files the published set does not name',
    replacesCurrentContentDroppingFilesPublishedSetDoes,
  );

  it(
    '404s an unknown skill and refuses a body with no SKILL.md or bad base64 with 400',
    checks404sUnknownSkillRefusesBodyNoSKILLMd,
  );

  it(
    'refuses a body with a key other than files with 400 malformed_body',
    refusesBodyKeyOtherThanFiles400Malformed,
  );

  it("does not publish another workspace's skill", doesNotPublishAnotherWorkspaceSSkill);
});

async function numbersRevisions12ListsThemNewestFirst() {
  await importDemo();
  const first = await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
  expect(first.status, await first.clone().text()).toBe(201);
  const published = SkillRevisionResponseSchema.safeParse(await first.json());
  expect(published.success, JSON.stringify(published)).toBe(true);
  expect(published.data?.revision).toMatchObject({ number: 1, fileCount: 1 });
  const second = await publish([
    { path: 'SKILL.md', contentBase64: skillMd('v2') },
    { path: 'notes.txt', contentBase64: b64('n') },
  ]);
  expect(((await second.json()) as { revision: { number: number } }).revision.number).toBe(2);

  const detail = await detailRoute(
    req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
    nameContext('demo'),
  );
  const parsed = SkillResponseSchema.safeParse(await detail.json());
  expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  const skill = parsed.data?.skill;
  expect(skill?.revisions?.map((r) => [r.number, r.fileCount])).toEqual([
    [2, 2],
    [1, 1],
  ]);
  expect(skill?.files.map((f) => f.path)).toEqual(['SKILL.md', 'notes.txt']);
}

async function leavesPublishedRevisionUnchangedLaterPublishPATCHDisable() {
  await importDemo();
  await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
  await publish([{ path: 'SKILL.md', contentBase64: skillMd('v2') }]);
  const patch = await patchRoute(
    req('PATCH', '/api/skills/demo', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        files: [{ path: 'SKILL.md', contentBase64: skillMd('patched') }],
        enabled: false,
      }),
      contentType: 'application/json',
    }),
    nameContext('demo'),
  );
  expect(patch.status, await patch.clone().text()).toBe(200);

  expect(await revisionBytes(1)).toContain('v1');
  expect(await revisionBytes(2)).toContain('v2');
  expect(await revisionBytes(3)).toBeNull();
}

async function cannotBeWrittenImportPATCHRePublishEvery() {
  await importDemo();
  await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
  const reimport = await importRoute(
    postJson(WORKSPACE_A, {
      name: 'demo',
      files: [{ path: 'SKILL.md', contentBase64: skillMd('reimported') }],
    }),
  );
  expect(reimport.status).toBe(409);

  // A skill file spelled like a revision key lands inside the skill's own prefix, not the revision's.
  const aimed = await patchRoute(
    req('PATCH', '/api/skills/demo', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        files: [{ path: 'skill-revisions/demo/1/SKILL.md', contentBase64: skillMd('aimed') }],
      }),
      contentType: 'application/json',
    }),
    nameContext('demo'),
  );
  expect(aimed.status, await aimed.clone().text()).toBe(200);
  const nested = await patchRoute(
    req('PATCH', '/api/skills/demo', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        files: [{ path: '1/SKILL.md', contentBase64: skillMd('nested') }],
      }),
      contentType: 'application/json',
    }),
    nameContext('demo'),
  );
  expect(nested.status, await nested.clone().text()).toBe(200);

  const second = await publish([{ path: 'SKILL.md', contentBase64: skillMd('v2') }]);
  expect(second.status).toBe(201);
  expect(await revisionBytes(1)).toContain('v1');
  expect(await revisionBytes(2)).toContain('v2');
  // Each revision holds its SKILL.md alone: the files PATCHed in did not land in a revision.
  expect(Object.keys(await revisionRows(1))).toEqual([
    `${skillRevisionRowFolder('demo', 1)}/SKILL.md`,
  ]);
  expect(Object.keys(await revisionRows(2))).toEqual([
    `${skillRevisionRowFolder('demo', 2)}/SKILL.md`,
  ]);
  expect(await revisionRows(3)).toEqual({});
}

async function replacesCurrentContentDroppingFilesPublishedSetDoes() {
  await importRoute(
    postJson(WORKSPACE_A, {
      name: 'demo',
      files: [
        { path: 'SKILL.md', contentBase64: skillMd('v0') },
        { path: 'old.txt', contentBase64: b64('old') },
      ],
    }),
  );
  await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
  const detail = await detailRoute(
    req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
    nameContext('demo'),
  );
  const body = (await detail.json()) as { skill: { files: { path: string }[] } };
  expect(body.skill.files.map((f) => f.path)).toEqual(['SKILL.md']);
}

async function checks404sUnknownSkillRefusesBodyNoSKILLMd() {
  expect((await publish([{ path: 'SKILL.md', contentBase64: skillMd('x') }], 'nope')).status).toBe(
    404,
  );
  await importDemo();
  expect((await publish([{ path: 'a.txt', contentBase64: b64('a') }])).status).toBe(400);
  expect((await publish([{ path: 'SKILL.md', contentBase64: '***' }])).status).toBe(400);
  expect((await publish('not-an-array')).status).toBe(400);
  const detail = await detailRoute(
    req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
    nameContext('demo'),
  );
  const body = (await detail.json()) as { skill: { revisions: unknown[] } };
  expect(body.skill.revisions).toEqual([]);
}

async function refusesBodyKeyOtherThanFiles400Malformed() {
  await importDemo();
  for (const body of [
    { files: [{ path: 'SKILL.md', contentBase64: skillMd('x') }], name: 'other' },
    { files: [{ path: 'SKILL.md', contentBase64: skillMd('x') }], typo: 1 },
    [],
  ]) {
    const response = await publishRoute(
      req('POST', '/api/skills/demo/revisions', {
        workspace: WORKSPACE_A,
        body: JSON.stringify(body),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'malformed_body' } });
  }
  expect(await revisionBytes(1)).toBeNull();
}

async function doesNotPublishAnotherWorkspaceSSkill() {
  await importDemo();
  const response = await publish(
    [{ path: 'SKILL.md', contentBase64: skillMd('x') }],
    'demo',
    WORKSPACE_B,
  );
  expect(response.status).toBe(404);
}
