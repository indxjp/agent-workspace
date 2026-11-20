// Fitness test for the shared in-memory catalog (the storage design, §07 rule 4): the scan
// (tests/fitness/catalog-fakes-scan.ts) on planted fixtures. Its run over every tracked test file
// is tests/catalog-fakes.policy-check.ts, in `pnpm policy:check`.
import { describe, expect, it } from 'vitest';

import { compare, findCatalogFakes } from './fitness/catalog-fakes-scan.js';

const planted = (text: string) => findCatalogFakes([{ path: 'x.test.ts', text }]);
const one = { 'x.test.ts': 1 };

describe('catalog fakes are not hand-written', () => {
  it('flags a planted literal', () => {
    expect(
      planted('const c: ResourceCatalogRepository = { list: () => Promise.resolve([]) };'),
    ).toEqual(one);
    expect(planted('const c = { list, reserve };')).toEqual(one);
    expect(planted('const c = { listSkills, putSkill };')).toEqual(one);
  });

  it("flags a planted fake of the two-step file catalog by the port's own members", () => {
    for (const member of [
      'reserve',
      'confirm',
      'createFolder',
      'referencing',
      'deleting',
      'forget',
    ])
      expect(planted(`run({ catalog: { ${member} } as never });`), member).toEqual(one);
  });

  it('flags a planted cast, however it is spelled', () => {
    expect(planted('const c = { reserve } as unknown as ResourceCatalogRepository;')).toEqual(one);
    expect(planted('const c = { get } as CatalogPort;')).toEqual(one);
    expect(planted('const c = { get } satisfies Pick<CatalogPort, "get">;')).toEqual(one);
    expect(planted('const c: Partial<ResourceCatalogRepository> = { get };')).toEqual(one);
    expect(planted('class C implements CatalogPort {}')).toEqual(one);
    expect(planted('class C implements db.CatalogPort {}')).toEqual(one);
    expect(planted('const c = { confirm } as unknown as db.ResourceCatalogRepository;')).toEqual(
      one,
    );
    expect(planted('const c = repo as unknown as ResourceCatalogRepository;')).toEqual(one);
  });

  it('counts a literal cast through a variable once', () => {
    expect(
      planted(
        'const repo = { listSkills, putSkill };\nconst c = repo as unknown as ResourceCatalogRepository;',
      ),
    ).toEqual(one);
  });

  it('flags a fake passed as `never` where a catalog is expected', () => {
    expect(planted('run({ catalog: { listSkills } as never });')).toEqual(one);
    expect(
      planted('const catalog = { forWorkspace: () => Promise.resolve({ listSkills }) };'),
    ).toEqual(one);
    expect(
      planted(
        'const p = { forWorkspace: () => ({ reserve } as unknown as Awaited<ReturnType<P["forWorkspace"]>>) };',
      ),
    ).toEqual(one);
  });

  it('ignores a wrapper that spreads a real catalog and overrides one member', () => {
    expect(
      planted(
        'const p = { async forWorkspace(id) { const c = await inner.forWorkspace(id); return { ...c, reserve: gated }; } };',
      ),
    ).toEqual({});
    expect(
      planted(
        'const p = { async forWorkspace(id) { const c = await inner.forWorkspace(id); return { reserve: gated }; } };',
      ),
    ).toEqual(one);
  });

  it('ignores vi.fn() and reserve on a type that is not a catalog port', () => {
    expect(
      planted('const p = { reserve: vi.fn(), readFile: vi.fn() } as unknown as Source;'),
    ).toEqual({});
    expect(planted('const reserve = vi.fn();\nconst store = { put: vi.fn() };')).toEqual({});
    expect(planted('const p: Source = { reserve: () => Promise.resolve([]) };')).toEqual({});
    expect(planted('const i: Parameters<ResourceCatalogRepository["putSkill"]>[0] = {};')).toEqual(
      {},
    );
    expect(planted('function f(catalog: ResourceCatalogRepository) {}')).toEqual({});
    expect(
      planted("const a: ResourceCatalogRepository = createInMemoryCatalog().forWorkspace('ws');"),
    ).toEqual({});
    expect(planted("const b: CatalogPort = await provider.forWorkspace('ws');")).toEqual({});
  });

  it('ignores a fake named only inside a string or comment', () => {
    expect(
      planted("// as unknown as ResourceCatalogRepository\nconst s = 'x as CatalogPort';"),
    ).toEqual({});
  });

  it('compares with the allowlist', () => {
    const none = { added: [], grown: [], stale: [], shrunk: [] };
    expect(compare({ a: 1 }, { a: 1 })).toEqual(none);
    expect(compare({ a: 1, b: 1 }, { a: 1 })).toEqual({ ...none, added: ['b'] });
    expect(compare({ a: 2 }, { a: 1 })).toEqual({ ...none, grown: ['a'] });
    expect(compare({}, { a: 1 })).toEqual({ ...none, stale: ['a'] });
    expect(compare({ a: 1 }, { a: 2 })).toEqual({ ...none, shrunk: ['a'] });
  });
});
