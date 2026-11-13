import { beforeEach, describe, expect, it, vi } from 'vitest';

import { composerStrings } from '../../components/composer/composer-messages';
import type { AgentRecord } from '../../server/agents/contract';
import {
  composerFileOptions,
  composerFilesByAgent,
  type ComposerCatalogRow,
} from './composer-files';

// RF-502 (#2089): the "+ Files" picker offers the agent's granted workspace files and folders.
const reader = { permissions: { readFiles: true } } as const;
const rows = (list: readonly ComposerCatalogRow[]) => new Map(list.map((row) => [row.id, row]));
const EN = composerStrings('en');
const CATALOG = rows([
  { id: 'f-q3', path: 'notes/q3.md', kind: 'file' },
  { id: 'd-reports', path: 'reports', kind: 'folder' },
  { id: 'f-deep', path: 'reports/2026/a.pdf', kind: 'file' },
  { id: 's-skill', path: '.skills/raced/SKILL.md', kind: 'file', area: 'skills' },
]);

describe('composerFileOptions', () => {
  it('lists each granted file and folder by path, folders with a trailing slash, sorted', () => {
    const options = composerFileOptions(
      reader,
      {
        // Granted in the other order: the picker sorts by path.
        files: [
          { fileId: 'd-reports', access: 'read-write' },
          { fileId: 'f-q3', access: 'read' },
        ],
      },
      CATALOG,
      EN,
    );
    expect(options).toEqual([
      { id: 'notes/q3.md', name: 'q3.md', detail: 'notes/q3.md · read-only' },
      { id: 'reports', name: 'reports/', detail: 'reports · read/write' },
    ]);
  });

  it('says the access in Japanese for a Japanese reader', () => {
    const [option] = composerFileOptions(
      reader,
      { files: [{ fileId: 'd-reports', access: 'read-write' }] },
      CATALOG,
      composerStrings('ja'),
    );
    expect(option?.detail).toBe('reports · 読み書き');
  });

  it('offers nothing to an agent that cannot read files, since its run reads none', () => {
    expect(
      composerFileOptions(
        { permissions: { readFiles: false } },
        { files: [{ fileId: 'f-q3', access: 'read' }] },
        CATALOG,
        EN,
      ),
    ).toEqual([]);
  });

  it('offers nothing without assignments, and skips a grant whose row is gone or is a skill file', () => {
    expect(composerFileOptions(reader, null, CATALOG, EN)).toEqual([]);
    expect(
      composerFileOptions(
        reader,
        {
          files: [
            { fileId: 'gone', access: 'read' },
            { fileId: 's-skill', access: 'read' },
            { fileId: 'f-deep', access: 'read' },
          ],
        },
        CATALOG,
        EN,
      ).map((option) => option.id),
    ).toEqual(['reports/2026/a.pdf']);
  });

  it('offers at most as many paths as one run may be narrowed to', () => {
    const many = rows(
      Array.from({ length: 105 }, (_, index) => ({
        id: `f${String(index)}`,
        path: `bulk/${String(index).padStart(3, '0')}.txt`,
        kind: 'file' as const,
      })),
    );
    const options = composerFileOptions(
      reader,
      { files: [...many.keys()].map((fileId) => ({ fileId, access: 'read' as const })) },
      many,
      EN,
    );
    expect(options).toHaveLength(100);
    expect(options[99]?.id).toBe('bulk/099.txt');
  });
});

// The RBAC gate and the plumbing around composerFileOptions.
interface Mocks {
  context: unknown;
  access: () => { ok: boolean; principal?: { workspaceId: string } };
  asked: string[];
}
const mocks = vi.hoisted((): Mocks => ({
  context: null,
  access: () => ({ ok: true, principal: { workspaceId: 'w1' } }),
  asked: [],
}));
vi.mock('../../server/application-context', () => ({ applicationContext: () => mocks.context }));
vi.mock('../../server/resources/authorise', () => ({
  requireResourceAccess: (request: Request) => {
    mocks.asked.push(
      `${request.method} ${new URL(request.url).pathname} ${request.headers.get('cookie') ?? ''}`,
    );
    return Promise.resolve(mocks.access());
  },
}));

describe('composerFilesByAgent', () => {
  const agent = (id: string, readFiles = true) =>
    ({ id, permissions: { readFiles } }) as unknown as AgentRecord;
  const installed = (assignments: Record<string, unknown>) => {
    mocks.context = {
      agents: {
        agentResources: {
          forWorkspace: (workspaceId: string) => ({
            get: (id: string) =>
              Promise.resolve(workspaceId === 'w1' ? (assignments[id] ?? null) : null),
          }),
        },
      },
      files: {
        kind: 'serving',
        runtime: {
          catalog: {
            forWorkspace: () =>
              Promise.resolve({
                list: () =>
                  Promise.resolve({
                    rows: [{ id: 'f-q3', path: 'notes/q3.md', kind: 'file' }],
                    cursor: null,
                  }),
              }),
          },
        },
      },
    };
  };

  beforeEach(() => {
    mocks.asked = [];
    mocks.access = () => ({ ok: true, principal: { workspaceId: 'w1' } });
  });

  it('asks the resources route’s own RBAC question with this render’s cookie, per agent', async () => {
    installed({ a1: { files: [{ fileId: 'f-q3', access: 'read' }] } });
    const out = await composerFilesByAgent('aw_session=s', 'w1', [agent('a1')], EN);
    expect(out.get('a1')?.map((option) => option.id)).toEqual(['notes/q3.md']);
    expect(mocks.asked).toEqual(['GET /api/agents/a1/resources aw_session=s']);
  });

  it('lists nothing for an agent whose resources the caller may not read', async () => {
    installed({ a1: { files: [{ fileId: 'f-q3', access: 'read' }] } });
    mocks.access = () => ({ ok: false });
    expect((await composerFilesByAgent('c', 'w1', [agent('a1')], EN)).get('a1')).toBeUndefined();
  });

  it('lists nothing when the cookie now identifies another workspace', async () => {
    installed({ a1: { files: [{ fileId: 'f-q3', access: 'read' }] } });
    mocks.access = () => ({ ok: true, principal: { workspaceId: 'w2' } });
    expect((await composerFilesByAgent('c', 'w1', [agent('a1')], EN)).get('a1')).toBeUndefined();
  });

  it('does not ask for an agent that cannot read files, and lists nothing without a catalog', async () => {
    installed({ a1: { files: [{ fileId: 'f-q3', access: 'read' }] } });
    await composerFilesByAgent('c', 'w1', [agent('a1', false)], EN);
    expect(mocks.asked).toEqual([]);
    mocks.context = { agents: { agentResources: undefined }, files: { kind: 'unavailable' } };
    expect((await composerFilesByAgent('c', 'w1', [agent('a1')], EN)).size).toBe(0);
  });

  it('lists nothing for any agent when the lookup fails, rather than failing the page', async () => {
    installed({});
    (mocks.context as { files: { runtime: { catalog: unknown } } }).files.runtime.catalog = {
      forWorkspace: () => Promise.reject(new Error('database down')),
    };
    expect((await composerFilesByAgent('c', 'w1', [agent('a1')], EN)).size).toBe(0);
  });
});
