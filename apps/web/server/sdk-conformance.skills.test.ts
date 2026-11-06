/**
 * SDK conformance, skills: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiProblemSchema, COMMON_PROBLEM_CODES } from '@indx-workspace/contracts';
import {
  SKILL_NAME_PATTERN,
  SkillExportResponseSchema,
  SkillListResponseSchema,
  SkillResponseSchema,
  SKILLS_PROBLEM_CODES,
  type SkillsProblemCode,
} from '@indx-workspace/contracts/skills';
import { createInMemoryCatalog } from '@agent-workspace/core/db';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import {
  exportSkill,
  getSkill,
  importSkill as importSkillInto,
  listSkills,
  patchSkill as patchSkillIn,
  requireSkillName,
} from './skills/handlers';
import { createSkillRowsWorld } from './skills/rows-fixture';
import type { SkillRowsWriter } from './skills/tree';
import type { SkillObjects } from './storage/store';
import { isValidSkillName } from './skills/keys';
import {
  ToolBundleResponseSchema,
  UploadToolBundleResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import { getToolBundle, uploadToolBundle } from './tool-bundles/handlers';

const SKILLS_WORKSPACE = '99999999-9999-4999-8999-999999999999';

const SKILL_MD_TEXT =
  '---\nname: demo\ndescription: A demo skill\nallowed-tools: Read Grep\n---\n\nDo the thing.\n';

const skillsBase64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

const skillMdEntry = { path: 'SKILL.md', contentBase64: skillsBase64(SKILL_MD_TEXT) };

const skillsStore = () => createInMemoryObjectStoreProvider().forWorkspace(SKILLS_WORKSPACE);

// The handlers write a skill as catalog rows; each test gets a fresh in-memory catalog behind them.
let skillRows: SkillRowsWriter;

const importSkill = (store: SkillObjects, body: unknown) => importSkillInto(store, body, skillRows);

const patchSkill = (store: SkillObjects, name: string, body: unknown) =>
  patchSkillIn(store, name, body, skillRows);

/**
 * The one piece of `apps/web/app/api/skills/route.ts`'s `GET` this suite composes by hand: the
 * catalog row's id, from the shared in-memory catalog's `putSkill` (same name, same id).
 */
const catalog = createInMemoryCatalog().forWorkspace(SKILLS_WORKSPACE);

/**
 * The composition every route under `apps/web/app/api/skills/**` performs: the handler body
 * plus the catalog row's id (K-4, issue #234). `source` is `null` only for a skill whose
 * `SKILL.md` was pre-existing and unreadable — `listSkills` itself now refuses that state
 * (500 `store_inconsistent`), so no composed body this helper builds ever needs a fallback.
 */
async function withCatalogId<T extends { name: string; enabled: boolean; source: string | null }>(
  skill: T,
): Promise<T & { id: string }> {
  const row = await catalog.putSkill({
    name: skill.name,
    skillMd: skill.source ?? '',
    enabled: skill.enabled,
    ownerPrincipalId: 'principal-1',
    createdBy: null,
  });
  return { ...skill, id: row.id };
}

const bytes = Buffer.from('export default () => 1;\n').toString('base64');

type SkillsStore = ReturnType<typeof skillsStore>;
type SkillBody = { name: string; enabled: boolean; source: string | null };

/** A fresh in-memory catalog behind the skill handlers. */
function resetSkillRows(): void {
  skillRows = createSkillRowsWorld(
    createInMemoryObjectStore(),
    SKILLS_WORKSPACE,
    createInMemoryCatalog().forWorkspace(SKILLS_WORKSPACE),
  ).rows;
}

async function expectImportRendered(store: SkillsStore): Promise<void> {
  const imported = await importSkill(store, {
    name: 'demo',
    files: [skillMdEntry, { path: 'scripts/run.sh', contentBase64: skillsBase64('#!/bin/sh\n') }],
  });
  expect(imported.status).toBe(201);
  const importedBody = imported.body as { skill: SkillBody };
  // K-4: every pin below is the composed route serializer — the handler body plus the catalog
  // row's id (`apps/web/app/api/skills/route.ts`) — through a real (in-memory) catalog's
  // `putSkill`, never a hand-written id, so every id comes from a real serializer.
  const created = SkillResponseSchema.safeParse({
    skill: await withCatalogId(importedBody.skill),
  });
  expect(created.success, JSON.stringify(created)).toBe(true);
  if (!created.success) return;
  expect(created.data.skill.description).toBe('A demo skill');
  expect(created.data.skill.allowedTools).toEqual(['Read', 'Grep']);
  expect(created.data.skill.fileCount).toBe(2);
}

async function expectGetAndListRendered(store: SkillsStore): Promise<void> {
  const fetched = await getSkill(store, 'demo', skillRows);
  expect(fetched.status).toBe(200);
  const fetchedBody = fetched.body as { skill: SkillBody };
  expect(
    SkillResponseSchema.safeParse({ skill: await withCatalogId(fetchedBody.skill) }).success,
  ).toBe(true);

  const listed = await listSkills(store, skillRows);
  expect(listed.status).toBe(200);
  const listedBody = listed.body as { skills: SkillBody[] };
  const composedSkills = await Promise.all(listedBody.skills.map(withCatalogId));
  const page = SkillListResponseSchema.safeParse({ skills: composedSkills });
  expect(page.success, JSON.stringify(page)).toBe(true);
}

async function expectPatchRendered(store: SkillsStore): Promise<void> {
  const patched = await patchSkill(store, 'demo', {
    enabled: false,
    files: [{ path: 'notes.txt', contentBase64: '' }],
    removeFiles: ['scripts/run.sh'],
  });
  expect(patched.status).toBe(200);
  const patchedBody = patched.body as { skill: SkillBody };
  const updated = SkillResponseSchema.safeParse({
    skill: await withCatalogId(patchedBody.skill),
  });
  expect(updated.success, JSON.stringify(updated)).toBe(true);
  if (!updated.success) return;
  expect(updated.data.skill.enabled).toBe(false);
  expect(updated.data.skill.files.map((file) => file.path)).toEqual(['SKILL.md', 'notes.txt']);
}

async function expectExportRendered(store: SkillsStore): Promise<void> {
  const exported = await exportSkill(store, 'demo', skillRows);
  expect(exported.status).toBe(200);
  const directory = SkillExportResponseSchema.safeParse(exported.body);
  expect(directory.success, JSON.stringify(directory)).toBe(true);
  if (!directory.success) return;
  expect(directory.data.skill.files).toEqual([
    { path: 'SKILL.md', contentBase64: skillMdEntry.contentBase64 },
    { path: 'notes.txt', contentBase64: '' },
  ]);
}

/** One pending handler answer per documented refusal, keyed by the code it must carry. */
function documentedRefusals(
  store: SkillsStore,
): readonly (readonly [SkillsProblemCode, Promise<{ status: number; body: unknown }>])[] {
  const other = (files: unknown[]) => importSkill(store, { name: 'other', files });
  return [
    ['missing_name', importSkill(store, { files: [skillMdEntry] })],
    ['invalid_name', importSkill(store, { name: 'Not-A-Slug', files: [skillMdEntry] })],
    ['missing_files', other([])],
    ['malformed_file_entry', other([{ path: 'x' }])],
    ['inadmissible_path', other([{ path: 'SKILL.md::$DATA', contentBase64: '' }])],
    ['duplicate_path', other([skillMdEntry, skillMdEntry])],
    ['missing_skill_md', other([{ path: 'notes.txt', contentBase64: '' }])],
    ['malformed_content', other([{ path: 'SKILL.md', contentBase64: '%%%' }])],
    ['skill_already_exists', importSkill(store, { name: 'demo', files: [skillMdEntry] })],
    ['colliding_paths', other([skillMdEntry, { path: 'skill.md', contentBase64: '' }])],
    ['skill_not_found', getSkill(store, 'absent', skillRows)],
    ['skill_not_found', exportSkill(store, 'absent', skillRows)],
    ['empty_patch', patchSkill(store, 'demo', {})],
    ['cannot_remove_skill_md', patchSkill(store, 'demo', { removeFiles: ['skill.MD'] })],
    [
      'colliding_paths',
      patchSkill(store, 'demo', { files: [{ path: 'skill.md', contentBase64: '' }] }),
    ],
  ];
}

describe('skills', () => {
  beforeEach(resetSkillRows);

  it('answers import, get, list, patch and export through the real handlers with bodies the contract accepts', async () => {
    const store = skillsStore();
    await expectImportRendered(store);
    await expectGetAndListRendered(store);
    await expectPatchRendered(store);
    await expectExportRendered(store);
  });
});

describe('skills', () => {
  beforeEach(resetSkillRows);

  it('K-4: refuses a SKILL.md whose bytes are not valid UTF-8, in the published problem shape', async () => {
    // Before K-4 this imported and rendered with every text field null; K-4 refuses it outright
    // (issue #234) so no new skill can reach the state `SkillDetail.id` being required cannot
    // honestly describe — see `store_inconsistent` in the "skills" describe block above this one.
    const store = skillsStore();
    const imported = await importSkill(store, {
      name: 'binary',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from([0xff, 0xfe, 0x00]).toString('base64') },
      ],
    });
    expect(imported.status).toBe(400);
    const envelope = ApiProblemSchema.safeParse(imported.body);
    expect(envelope.success, JSON.stringify(envelope)).toBe(true);
    if (!envelope.success) return;
    expect(envelope.data.error.code).toBe('malformed_content');
  });
});

describe('skills', () => {
  beforeEach(resetSkillRows);

  it('refuses what the contract documents, under the status and code the contract publishes', async () => {
    const store = skillsStore();
    expect((await importSkill(store, { name: 'demo', files: [skillMdEntry] })).status).toBe(201);

    const refusals = documentedRefusals(store);
    for (const [code, pending] of refusals) {
      const result = await pending;
      const envelope = ApiProblemSchema.safeParse(result.body);
      expect(envelope.success, `${code}: ${JSON.stringify(result.body)}`).toBe(true);
      if (!envelope.success) continue;
      expect(envelope.data.error.code).toBe(code);
      expect(result.status).toBe(SKILLS_PROBLEM_CODES[code]);
    }

    const notASlug = requireSkillName('Not-A-Slug');
    expect(notASlug.ok).toBe(false);
    if (!notASlug.ok) {
      expect(notASlug.result.status).toBe(SKILLS_PROBLEM_CODES.skill_not_found);
      expect(ApiProblemSchema.parse(notASlug.result.body).error.code).toBe('skill_not_found');
    }

    const malformed = await patchSkill(store, 'demo', { enabled: 'yes' });
    expect(malformed.status).toBe(COMMON_PROBLEM_CODES.malformed_body);
    expect(ApiProblemSchema.parse(malformed.body).error.code).toBe('malformed_body');
  });
});

describe('skills', () => {
  beforeEach(resetSkillRows);

  it('accepts exactly the names the contract grammar accepts', () => {
    const probes = [
      'a',
      'demo',
      'my-skill-2',
      'Demo',
      '-leading',
      'trailing-',
      'double--hyphen',
      'under_score',
      '',
      'a'.repeat(64),
      'a'.repeat(65),
      `a${'-'.repeat(62)}a`,
    ];
    for (const probe of probes) {
      expect(isValidSkillName(probe), JSON.stringify(probe)).toBe(SKILL_NAME_PATTERN.test(probe));
    }
  });
});

describe('tool bundles (issue #790)', () => {
  it('answers upload and get through the real handlers with bodies the contract accepts', async () => {
    const store = createInMemoryObjectStoreProvider().forWorkspace(
      '99999999-9999-4999-8999-999999999999',
    );
    const first = await uploadToolBundle(store, { contentBase64: bytes });
    const again = await uploadToolBundle(store, { contentBase64: bytes });
    const parsed = UploadToolBundleResponseSchema.parse(first.body);
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(UploadToolBundleResponseSchema.parse(again.body).created).toBe(false);
    const fetched = await getToolBundle(store, parsed.bundle.digest);
    expect(ToolBundleResponseSchema.parse(fetched.body)).toEqual({ bundle: parsed.bundle });
  });
});
