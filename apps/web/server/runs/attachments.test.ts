import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promptWithAttachments, resolveRunAttachments } from './attachments';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import type { RunPrincipal } from './environment';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';
import { seedCatalogFile } from '@agent-workspace/core/db';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const ME = '77777777-7777-4777-8777-777777777777';
const SOMEONE_ELSE = '88888888-8888-4888-8888-888888888888';
const PRINCIPAL: RunPrincipal = {
  principalId: ME,
  ownerPrincipalId: ME,
  userId: '66666666-6666-4666-8666-666666666666',
  workspaceId: WORKSPACE,
  role: 'owner',
  scope: null,
};

const row = (path: string, ownerPrincipalId = ME, sizeBytes = 3) => ({
  path,
  kind: 'file' as const,
  storageKey: path,
  sizeBytes,
  contentType: 'text/plain',
  ownerPrincipalId,
});

const MIB = 1024 * 1024;
const SESSION = 'b0000000-0000-4000-8000-000000000001';

/** A ready row of area `skills`, as saving a skill writes it. */
async function skillRow(catalog: ResourceCatalogRepository, path: string) {
  const reserved = await catalog.reserve(path, {
    objectId: crypto.randomUUID(),
    ownerPrincipalId: ME,
    sizeBytes: 3,
    contentType: 'text/plain',
    area: 'skills',
  });
  const confirmed = await catalog.confirm(reserved.row, {
    sizeBytes: 3,
    contentType: 'text/plain',
  });
  if (confirmed === null) throw new Error('the skill row did not confirm');
  return confirmed.row;
}

const seed = async (catalog: ResourceCatalogRepository) => ({
  MINE: await seedCatalogFile(catalog, row('notes/brief.md')),
  THEIRS: await seedCatalogFile(catalog, row('notes/theirs.md', SOMEONE_ELSE)),
  RESERVED: await seedCatalogFile(catalog, row('.Attachments/s1/scan.pdf')),
  SKILL_ROW: await skillRow(catalog, '.skills/demo/SKILL.md'),
  BESIDE_SKILLS: await seedCatalogFile(catalog, row('.skills/notes.txt')),
  UPLOADED: await seedCatalogFile(
    catalog,
    row(`.attachments/${SESSION}/c0000000-0000-4000-8000-000000000001/scan.pdf`),
  ),
  FOREIGN_UPLOAD: await seedCatalogFile(
    catalog,
    row(
      '.attachments/b0000000-0000-4000-8000-000000000002/c0000000-0000-4000-8000-000000000002/scan.pdf',
    ),
  ),
  BIG: await seedCatalogFile(catalog, row('big.bin', ME, 10 * MIB + 1)),
  NINE_A: await seedCatalogFile(catalog, row('nine-a.bin', ME, 9 * MIB)),
  NINE_B: await seedCatalogFile(catalog, row('nine-b.bin', ME, 9 * MIB)),
  NINE_C: await seedCatalogFile(catalog, row('nine-c.bin', ME, 9 * MIB)),
  FOLDER: await seedCatalogFile(catalog, {
    ...row('docs'),
    kind: 'folder',
    sizeBytes: 0,
    contentType: null,
  }),
  IN_FOLDER: await seedCatalogFile(catalog, row('docs/a.md')),
});

let seeded: Awaited<ReturnType<typeof seed>>;
let workspaceCatalog: ResourceCatalogRepository;

beforeEach(async () => {
  const catalog = createInMemoryCatalogStore();
  workspaceCatalog = catalog.forWorkspaceSync(WORKSPACE);
  seeded = await seed(workspaceCatalog);
  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
        store: {} as never,
        catalog,
      },
    },
  });
});

afterEach(clearApplicationContext);

async function refusal(principal: RunPrincipal, fileId: string): Promise<[number, unknown]> {
  const verdict = await resolveRunAttachments(principal, [{ fileId }]);
  if (verdict.kind !== 'refused') throw new Error('expected a refusal');
  return [verdict.response.status, await verdict.response.json()];
}

describe('resolveRunAttachments', () => {
  it('resolves a readable id to its catalogue id and path', async () => {
    expect(await resolveRunAttachments(PRINCIPAL, [{ fileId: seeded.MINE.id }])).toEqual({
      kind: 'ok',
      files: [{ fileId: seeded.MINE.id, path: seeded.MINE.path, kind: 'file' }],
    });
  });

  it('answers the same concealed 404 for a missing, foreign-workspace, reserved or unreadable id', async () => {
    const missing = await refusal(PRINCIPAL, 'a0000000-0000-4000-8000-0000000000ff');
    expect(missing[0]).toBe(404);
    expect(missing[1]).toMatchObject({ error: { code: 'file_not_found' } });
    expect(await refusal({ ...PRINCIPAL, workspaceId: 'other-workspace' }, seeded.MINE.id)).toEqual(
      missing,
    );
    expect(await refusal(PRINCIPAL, seeded.RESERVED.id)).toEqual(missing);
    expect(await refusal(PRINCIPAL, seeded.SKILL_ROW.id)).toEqual(missing);
    const roleless: RunPrincipal = {
      principalId: ME,
      ownerPrincipalId: ME,
      userId: null,
      workspaceId: WORKSPACE,
      scope: null,
    };
    expect(await refusal(roleless, seeded.MINE.id)).toEqual(missing);
    // A session-scoped browser token has no files cell, and a member cannot attach a visitor's file.
    expect(
      await refusal({ ...PRINCIPAL, scope: { kind: 'session', id: 'a-session' } }, seeded.MINE.id),
    ).toEqual(missing);
    expect(await refusal(PRINCIPAL, seeded.UPLOADED.id)).toEqual(missing);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] refuses a skill row by its area, and attaches a user file under .skills/', async () => {
    expect(await resolveRunAttachments(PRINCIPAL, [{ fileId: seeded.BESIDE_SKILLS.id }])).toEqual({
      kind: 'ok',
      files: [{ fileId: seeded.BESIDE_SKILLS.id, path: '.skills/notes.txt', kind: 'file' }],
    });
    expect(await refusal(PRINCIPAL, seeded.SKILL_ROW.id)).toEqual(
      await refusal(PRINCIPAL, 'a0000000-0000-4000-8000-0000000000ff'),
    );
  });

  it('lets a session token attach its own uploads, and nothing else (ADR-0146 D5)', async () => {
    const visitor: RunPrincipal = { ...PRINCIPAL, scope: { kind: 'session', id: SESSION } };
    expect(await resolveRunAttachments(visitor, [{ fileId: seeded.UPLOADED.id }])).toEqual({
      kind: 'ok',
      files: [{ fileId: seeded.UPLOADED.id, path: seeded.UPLOADED.path, kind: 'file' }],
    });
    const missing = await refusal(PRINCIPAL, 'a0000000-0000-4000-8000-0000000000ff');
    expect(await refusal(visitor, seeded.FOREIGN_UPLOAD.id)).toEqual(missing);
    expect(await refusal(visitor, seeded.MINE.id)).toEqual(missing);
    expect(await refusal(visitor, seeded.RESERVED.id)).toEqual(missing);
  });

  it('refuses a file another principal owns when the role may read only its own', async () => {
    const missing = await refusal(PRINCIPAL, 'a0000000-0000-4000-8000-0000000000ff');
    expect(await refusal({ ...PRINCIPAL, role: 'viewer' }, seeded.THEIRS.id)).toEqual(missing);
  });

  it('resolves a folder as a directory attachment', async () => {
    expect(await resolveRunAttachments(PRINCIPAL, [{ fileId: seeded.FOLDER.id }])).toEqual({
      kind: 'ok',
      files: [{ fileId: seeded.FOLDER.id, path: 'docs', kind: 'directory' }],
    });
  });

  it('refuses a file over 10 MiB with 422 run_attachments_too_large before any run exists (ADR-0146)', async () => {
    const [status, body] = await refusal(PRINCIPAL, seeded.BIG.id);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('run_attachments_too_large');
  });

  it('refuses the whole start when one of several ids is refused', async () => {
    const verdict = await resolveRunAttachments(PRINCIPAL, [
      { fileId: seeded.MINE.id },
      { fileId: seeded.RESERVED.id },
    ]);
    expect(verdict.kind).toBe('refused');
  });
});

const UPLOAD_ROOT = `.attachments/${SESSION}`;
const VISITOR: RunPrincipal = { ...PRINCIPAL, scope: { kind: 'session', id: SESSION } };

/** `count` rows of `sizeBytes` each in the session's upload folder; sizes are metadata, nothing is allocated. */
async function sessionUploads(count: number, sizeBytes: number, tag = 'u') {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(
      await seedCatalogFile(
        workspaceCatalog,
        row(`${UPLOAD_ROOT}/${tag}${String(index)}/f.bin`, ME, sizeBytes),
      ),
    );
  }
  return made;
}

/** `count` ordinary workspace files of `sizeBytes` each. */
async function plainFiles(count: number, sizeBytes: number) {
  const made = [];
  for (let index = 0; index < count; index += 1) {
    made.push(
      await seedCatalogFile(workspaceCatalog, row(`plain/${String(index)}.bin`, ME, sizeBytes)),
    );
  }
  return made;
}

async function tooLargeBody(principal: RunPrincipal, ids: readonly string[]) {
  const verdict = await resolveRunAttachments(
    principal,
    ids.map((fileId) => ({ fileId })),
  );
  if (verdict.kind !== 'refused') throw new Error('expected a refusal');
  expect(verdict.response.status).toBe(422);
  const body = (await verdict.response.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('run_attachments_too_large');
  return body.error.message;
}

describe('attachment limits: 20 files, 10 MiB each, 50 MiB per session (storage design §04)', () => {
  // @story US-STO-11
  it('[US-STO-11][api][run] a 21st attachment in one session is refused with run_attachments_too_large', async () => {
    // The seeded upload is the session's first; twenty more make a 22nd file in the session.
    const stored = await sessionUploads(19, 1);
    expect((await resolveRunAttachments(VISITOR, [{ fileId: stored[0]?.id ?? '' }])).kind).toBe(
      'ok',
    );
    await sessionUploads(1, 1, 'twenty-first');
    expect(await tooLargeBody(VISITOR, [stored[0]?.id ?? ''])).toContain(
      'more than 20 attachments',
    );
  });

  // @story US-STO-11
  it('[US-STO-11][api][run] 50 MiB + 1 byte in one session (6 files, under the file cap) is refused by the total', async () => {
    // The seeded upload holds 3 bytes of this session: 3 + 4 x 10 MiB + (10 MiB - 2) = 50 MiB + 1.
    const stored = await sessionUploads(4, 10 * MIB);
    await seedCatalogFile(workspaceCatalog, row(`${UPLOAD_ROOT}/last/f.bin`, ME, 10 * MIB - 2));
    const message = await tooLargeBody(VISITOR, [stored[0]?.id ?? '']);
    expect(message).toContain('the attachments total over 50 MiB');
  });

  it('counts a folder as one attachment: a folder of 21 one-byte files is accepted', async () => {
    for (let index = 0; index < 21; index += 1) {
      await seedCatalogFile(workspaceCatalog, row(`bulk/${String(index)}.md`, ME, 1));
    }
    const folder = await seedCatalogFile(workspaceCatalog, {
      ...row('bulk'),
      kind: 'folder',
      sizeBytes: 0,
      contentType: null,
    });
    expect((await resolveRunAttachments(PRINCIPAL, [{ fileId: folder.id }])).kind).toBe('ok');
  });

  it('accepts exactly 20 files and exactly 50 MiB, and names the limits when it refuses', async () => {
    const twenty = await plainFiles(20, 1);
    const ok = await resolveRunAttachments(
      PRINCIPAL,
      twenty.map((r) => ({ fileId: r.id })),
    );
    expect(ok.kind).toBe('ok');
    const more = await seedCatalogFile(workspaceCatalog, row('one-more.bin'));
    const message = await tooLargeBody(PRINCIPAL, [...twenty.map((r) => r.id), more.id]);
    expect(message).toContain('20 attachments');
  });

  it('accepts five 10 MiB files (50 MiB) and refuses one byte more', async () => {
    const five = [];
    for (let index = 0; index < 5; index += 1) {
      five.push(
        await seedCatalogFile(workspaceCatalog, row(`ten-${String(index)}.bin`, ME, 10 * MIB)),
      );
    }
    expect(
      (
        await resolveRunAttachments(
          PRINCIPAL,
          five.map((r) => ({ fileId: r.id })),
        )
      ).kind,
    ).toBe('ok');
    const one = await seedCatalogFile(workspaceCatalog, row('one.bin', ME, 1));
    const message = await tooLargeBody(PRINCIPAL, [...five.map((r) => r.id), one.id]);
    expect(message).toContain('50 MiB');
  });

  it('refuses a file of 10 MiB + 1 byte and accepts one of exactly 10 MiB', async () => {
    const exact = await seedCatalogFile(workspaceCatalog, row('exact.bin', ME, 10 * MIB));
    expect((await resolveRunAttachments(PRINCIPAL, [{ fileId: exact.id }])).kind).toBe('ok');
    expect(await tooLargeBody(PRINCIPAL, [seeded.BIG.id])).toContain('10 MiB');
  });

  it('counts what the session already stored: a later request that crosses 50 MiB is refused', async () => {
    // The seeded upload holds 3 bytes of this session, so the last file is 3 bytes short of 10 MiB.
    const stored = await sessionUploads(4, 10 * MIB);
    await seedCatalogFile(workspaceCatalog, row(`${UPLOAD_ROOT}/last/f.bin`, ME, 10 * MIB - 3));
    const first = stored[0];
    if (first === undefined) throw new Error('no upload');
    // Exactly 50 MiB stored: attaching one of them is within the limit.
    expect((await resolveRunAttachments(VISITOR, [{ fileId: first.id }])).kind).toBe('ok');
    // One more byte lands in the session; the same request now crosses 50 MiB.
    await sessionUploads(1, 1, 'late');
    await tooLargeBody(VISITOR, [first.id]);
  });

  it('does not count another session uploads', async () => {
    await seedCatalogFile(
      workspaceCatalog,
      row('.attachments/b0000000-0000-4000-8000-000000000002/x/big.bin', ME, 10 * MIB),
    );
    const mine = await sessionUploads(1, 10 * MIB);
    expect((await resolveRunAttachments(VISITOR, [{ fileId: mine[0]?.id ?? '' }])).kind).toBe('ok');
  });
});

describe('promptWithAttachments', () => {
  it('returns the prompt unchanged without attachments', () => {
    expect(promptWithAttachments('hello', [])).toBe('hello');
  });

  it('names each file and says the run cannot run commands', () => {
    const prompt = promptWithAttachments('summarise', [
      { fileId: seeded.MINE.id, path: seeded.MINE.path, kind: 'file' },
    ]);
    expect(prompt.startsWith('summarise\n\n')).toBe(true);
    expect(prompt).toContain('Attached (read-only): notes/brief.md');
    expect(prompt).toContain('cannot run commands');
  });
});
