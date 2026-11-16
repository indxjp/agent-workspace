/**
 * The times the skills code stamps, pinned before it takes a Clock (refactoring plan part 07,
 * step 7): an import's `createdAt`/`updatedAt`, a PATCH's and a file replacement's `updatedAt`, and
 * the `lastModified` the meta-column view answers. Only `Date` is faked, so storage I/O runs as usual.
 */
import crypto from 'node:crypto';

import { createInMemoryCatalog } from '@agent-workspace/core/db';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fixedClock } from '../clock';
import { importSkill, recordImportedSkill, replaceSkillFiles, type SkillDetail } from './handlers';
import { SKILL_META_PREFIX, skillMetaKey } from './keys';
import { withSkillMetaColumn } from './meta-column';
import { createSkillRowsWorld, ROWS_WORKSPACE_ID } from './rows-fixture';
import { patchSkill } from './skill-patch';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const SKILL_MD = '---\nname: timed\ndescription: A timed skill\n---\n\nDo it.\n';
const T0 = new Date('2026-03-01T09:00:00.000Z');
const T1 = new Date('2026-03-02T10:30:00.000Z');

let catalog: ReturnType<ReturnType<typeof createInMemoryCatalog>['forWorkspace']>;
let world: ReturnType<typeof createSkillRowsWorld>;
let store: ReturnType<typeof createInMemoryObjectStore>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  catalog = createInMemoryCatalog().forWorkspace(ROWS_WORKSPACE_ID);
  store = createInMemoryObjectStore();
  world = createSkillRowsWorld(createInMemoryObjectStore(), ROWS_WORKSPACE_ID, catalog);
});

afterEach(() => {
  vi.useRealTimers();
});

async function imported(): Promise<SkillDetail> {
  const result = await importSkill(
    store,
    { name: 'timed', files: [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }] },
    world.rows,
  );
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return (result.body as { skill: SkillDetail }).skill;
}

it('stamps an import with the current time, created and updated alike', async () => {
  const skill = await imported();
  expect(skill.createdAt).toBe(T0.toISOString());
  expect(skill.updatedAt).toBe(T0.toISOString());
});

it('stamps a PATCH with the current time and keeps createdAt', async () => {
  await imported();
  vi.setSystemTime(T1);
  const result = await patchSkill(store, 'timed', { enabled: false }, world.rows);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  const skill = (result.body as { skill: SkillDetail }).skill;
  expect(skill.createdAt).toBe(T0.toISOString());
  expect(skill.updatedAt).toBe(T1.toISOString());
});

it('stamps a file replacement with the current time and keeps createdAt', async () => {
  await imported();
  vi.setSystemTime(T1);
  const replaced = await replaceSkillFiles(
    store,
    'timed',
    [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }],
    world.rows,
  );
  expect(replaced.ok).toBe(true);
  if (!replaced.ok) return;
  expect(replaced.skill.createdAt).toBe(T0.toISOString());
  expect(replaced.skill.updatedAt).toBe(T1.toISOString());
});

it('answers a record held in the catalog column with the current time as lastModified', async () => {
  await catalog.putSkill({
    name: 'column',
    skillMd: SKILL_MD,
    enabled: true,
    ownerPrincipalId: crypto.randomUUID(),
  });
  await catalog.setSkillMeta('column', { name: 'column', enabled: true });
  const view = withSkillMetaColumn(createInMemoryObjectStore(), catalog);
  vi.setSystemTime(T1);

  const listed = await view.listPage(SKILL_META_PREFIX, { limit: 10 });
  const entry = listed.entries.find((e) => e.key === skillMetaKey('column'));
  expect(entry?.kind === 'file' ? entry.lastModified : null).toEqual(T1);

  const read = await view.read(skillMetaKey('column'));
  expect(read?.meta.lastModified).toEqual(T1);

  const written = await view.write(
    skillMetaKey('column'),
    new TextEncoder().encode(JSON.stringify({ name: 'column', enabled: false })),
    { contentType: 'application/json' },
  );
  expect(written.lastModified).toEqual(T1);
});

it('takes the time from a Clock passed in, not the system clock', async () => {
  const clock = fixedClock('2027-01-01T00:00:00.000Z');
  const imported = await importSkill(
    store,
    { name: 'clocked', files: [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }] },
    world.rows,
  );
  expect(imported.status).toBe(201);
  const recorded = await recordImportedSkill(store, 'clocked', world.rows, clock);
  expect((recorded.body as { skill: SkillDetail }).skill.createdAt).toBe(
    '2027-01-01T00:00:00.000Z',
  );

  clock.advance(1000);
  const replaced = await replaceSkillFiles(
    store,
    'clocked',
    [{ path: 'SKILL.md', contentBase64: b64(SKILL_MD) }],
    world.rows,
    clock,
  );
  expect(replaced.ok && replaced.skill.updatedAt).toBe('2027-01-01T00:00:01.000Z');

  clock.advance(1000);
  const patched = await patchSkill(store, 'clocked', { enabled: false }, world.rows, clock);
  expect((patched.body as { skill: SkillDetail }).skill.updatedAt).toBe('2027-01-01T00:00:02.000Z');

  await catalog.putSkill({
    name: 'column',
    skillMd: SKILL_MD,
    enabled: true,
    ownerPrincipalId: crypto.randomUUID(),
  });
  await catalog.setSkillMeta('column', { name: 'column', enabled: true });
  const view = withSkillMetaColumn(createInMemoryObjectStore(), catalog, clock);
  const listed = await view.listPage(SKILL_META_PREFIX, { limit: 10 });
  const entry = listed.entries.find((e) => e.key === skillMetaKey('column'));
  expect(entry?.kind === 'file' ? entry.lastModified : null).toEqual(clock.now());
  expect((await view.read(skillMetaKey('column')))?.meta.lastModified).toEqual(clock.now());
  const written = await view.write(
    skillMetaKey('column'),
    new TextEncoder().encode(JSON.stringify({ name: 'column', enabled: false })),
    { contentType: 'application/json' },
  );
  expect(written.lastModified).toEqual(clock.now());
});
