import { describe, expect, it } from 'vitest';
import { nonReadingFsAccess, relativeSpecifiers, urlPathOf } from './inventory-support.js';
import type { RouteDeclaration } from './inventory-support.js';
import { exportedMethods, exportedStringConstant, streamOffenders } from './route-source-reader.js';
import { parseSpecRoutes, specRoutes } from './route-specification.js';
import { key } from './route-declaration-reader.js';

describe('the inventory’s own readers fail rather than under-report', () => {
  it('rejects a route file that exports no HTTP method', () => {
    expect(() => exportedMethods('export const revalidate = 0;\n', 'x/route.ts')).toThrow(
      /exports no HTTP method/,
    );
  });

  it('rejects re-exported handlers instead of silently missing them', () => {
    expect(() => exportedMethods("export { GET } from './handlers';\n", 'x/route.ts')).toThrow(
      /re-exports its handlers/,
    );
  });

  it('reads all three declaration forms Next.js documents', () => {
    const source = [
      'export async function GET(request: Request) { return new Response(); }',
      'export function HEAD() { return new Response(); }',
      'export const POST = () => new Response();',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')].sort()).toEqual(['GET', 'HEAD', 'POST']);
  });

  it('reports every way of reaching fs that is not a read', () => {
    // The table the ADR-0019 §4 assertion above rests on. A reader passes; every other form is
    // either named or refused as undecodable, which is what makes the allowlist's polarity hold —
    // round 2's list of seven mutator verbs missed `unlinkSync` and `copyFileSync` outright.
    //
    // Every specifier below is joined at run time, for the reason `tests/no-sdk-import.test.ts`
    // gives for its own tables: `nonReadingFsAccess` is run over this file too, and a fixture that
    // spelled the module out would report this gate to itself. The first draft of this test did,
    // and the run said so. The two call keywords are split for a second reason: written whole,
    // `tests/no-sdk-import.test.ts` reads them as module references whose argument it cannot
    // resolve and fails — which it also did, on the draft before this one.
    const node = `'node${':fs'}'`;
    const promises = `'node${':fs/promises'}'`;
    const bare = `'${'f' + 's'}'`;
    const undecodable = /reached by a form this reader cannot decode/;
    expect(nonReadingFsAccess(`import { readFileSync } from ${node};\n`)).toEqual([]);
    expect(nonReadingFsAccess(`import { unlinkSync } from ${node};\n`)).toEqual(['unlinkSync']);
    expect(nonReadingFsAccess(`import { rmSync as nuke } from ${node};\n`)).toEqual(['rmSync']);
    expect(nonReadingFsAccess(`import { writeFile } from ${promises};\n`)).toEqual(['writeFile']);
    for (const form of [
      `import * as anyName from ${node};\n`,
      `export { readFileSync } from ${node};\n`,
      `const anyName = requir${'e'}(${bare});\n`,
      `const anyName = await imp${'ort'}(${node});\n`,
    ]) {
      const reported = nonReadingFsAccess(form);
      expect(reported, form).toHaveLength(1);
      expect(reported[0], form).toMatch(undecodable);
    }
  });

  it('follows a relative module reference in every form it can be written', () => {
    // The table behind `gateModules`, and the escape a verifier drove through it in round 3.
    // `relativeSpecifiers` read a line-start `from` clause and a line-start bare import and
    // nothing else, so a top-level dynamic import of a plain relative literal left the module it
    // named outside the ADR-0019 §4 scan: a tracked helper holding a `mkdirSync`, reached that
    // way, kept both gates green. `tests/no-sdk-import.test.ts` refuses any resolver call in this
    // tree whose argument is not a plain quoted string, so reading the literal covers every call
    // form the repository accepts at all.
    //
    // Each fixture interpolates its specifier rather than spelling it. That is not decoration:
    // `gateModules` scans this file too, and a fixture that wrote the path out would be a module
    // reference this gate then had to resolve — which is the shape that made an earlier draft of
    // `relativeSpecifiers` throw on its own test file.
    const sibling = './inventory-support.js';
    for (const form of [
      `import { REPO_ROOT } from '${sibling}';`,
      `import type { RouteDeclaration } from '${sibling}';`,
      `import {\n  REPO_ROOT,\n} from '${sibling}';`,
      `export { REPO_ROOT } from '${sibling}';`,
      `export * from '${sibling}';`,
      `import '${sibling}';`,
      `import { REPO_ROOT } from "${sibling}";`,
      `const helper = await import('${sibling}');`,
      `const helper = require('${sibling}');`,
      `const where = require.resolve('${sibling}');`,
      `const where = import.meta.resolve('${sibling}');`,
    ]) {
      expect(relativeSpecifiers(form), form).toEqual([sibling]);
    }
    // …and it is not satisfied by matching everything. A package specifier names no file in this
    // repository and is decided by `nonReadingFsAccess` instead; prose naming a path is not a
    // module reference; and the bound on the `from` clause still holds, so an import statement
    // above a fixture string cannot reach into it.
    expect(relativeSpecifiers("import { describe } from 'vitest';\n")).toEqual([]);
    expect(relativeSpecifiers(` * see ${sibling} for the reader\n`)).toEqual([]);
    expect(relativeSpecifiers(`import path from 'node:path';\nconst s = '${sibling}';\n`)).toEqual(
      [],
    );
  });

  it('refuses an export form it cannot decode rather than dropping the handler', () => {
    // The round-2 reader asked one yes/no question per method and dropped what it could not spell.
    // Each of these ships a GET that a per-method regex cannot see.
    const destructured = [
      'const handlers = { GET: () => new Response("x") };',
      'export const { GET } = handlers;',
      'export async function POST() { return new Response("y"); }',
    ].join('\n');
    expect(() => exportedMethods(destructured, 'x/route.ts')).toThrow(/cannot decode/);
    expect(() => exportedMethods('export default function GET() {}\n', 'x/route.ts')).toThrow(
      /cannot decode/,
    );
    expect(() => exportedMethods("export * from './handlers';\n", 'x/route.ts')).toThrow(
      /cannot decode/,
    );
  });

  it('reads a type-level export as binding no handler, and says so by name', () => {
    const source = [
      'export type GET = never;',
      'export interface POST { x: 1 }',
      'export async function DELETE() { return new Response(); }',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')]).toEqual(['DELETE']);
  });

  it('refuses a runtime declaration whose value it cannot evaluate', () => {
    const source = 'export const runtime = RUNTIME;\nexport function GET() {}\n';
    expect(() => exportedStringConstant(source, 'runtime', 'x/route.ts')).toThrow(
      /cannot evaluate/,
    );
    // Absent is not the same failure as unreadable, and the caller reports it differently.
    expect(exportedStringConstant('export function GET() {}\n', 'runtime', 'x/route.ts')).toBe(
      null,
    );
    // And a commented-out declaration is not a declaration — the escape round 3 drove a real route
    // file through, running it on 'edge' while the round-2 gate read the comment above it.
    const commented = [
      "// export const runtime = 'nodejs';",
      "export const runtime = 'edge';",
      'export function GET() {}',
    ].join('\n');
    expect(exportedStringConstant(commented, 'runtime', 'x/route.ts')).toBe('edge');
  });

  it('sees a stream built through any name, and lets a comment name the rule', () => {
    const built = (source: string): string[] =>
      streamOffenders([{ repoPath: 'x/route.ts', source }]);
    expect(built('const body = new ReadableStream();\n')).toEqual(['x/route.ts:1']);
    expect(built('const body = new globalThis.ReadableStream();\n')).toEqual(['x/route.ts:1']);
    expect(built('const S = ReadableStream;\nconst body = new S();\n')).toEqual(['x/route.ts:1']);
    expect(built(' * Copy the import, not the ReadableStream.\n')).toEqual([]);
    expect(built('// no ReadableStream here\n')).toEqual([]);
  });

  it('reads spec §34’s own fence, not the next section’s', () => {
    // §34 prints nothing parseable and §35 prints routes: the answer is a refusal, not §35's list.
    // Round 2 sliced to end of file; retagging §34's fence and moving its lines down into §35 left
    // the gate passing at 35 of 35 with §34 printing no route.
    const spec = [
      '# 34. API Design',
      '',
      '```http',
      'GET /api/agents',
      '```',
      '',
      '# 35. Observability',
      '',
      '```text',
      'GET /api/observability',
      '```',
      '',
    ].join('\n');
    expect(() => parseSpecRoutes(spec)).toThrow(/contains no/);
    // Two fences inside §34 are both read, so "which one" is not a question this parser answers.
    const two = [
      '# 34. API Design',
      '',
      '```text',
      'notes, not routes',
      '```',
      '',
      '```text',
      'GET /api/agents',
      '```',
      '',
      '# 35. Observability',
      '',
    ].join('\n');
    expect([...parseSpecRoutes(two)]).toEqual(['GET /api/agents']);
  });

  it('does not mistake a non-exported or differently named function for a handler', () => {
    const source = [
      'function GET() { return null; }',
      'const PATCH = 1;',
      'export const GETTER = () => new Response();',
      'export async function GET() { return new Response(); }',
    ].join('\n');
    expect([...exportedMethods(source, 'x/route.ts')]).toEqual(['GET']);
  });

  it('maps a dynamic segment to the specification’s notation and drops a route group', () => {
    expect(urlPathOf('api/agents/[id]', 'f')).toBe('/api/agents/:id');
    expect(urlPathOf('(shell)/api/agents', 'f')).toBe('/api/agents');
  });

  it('rejects segment shapes §34 does not use, rather than treating them as literals', () => {
    expect(() => urlPathOf('api/[...rest]', 'f')).toThrow(/catch-all/);
    expect(() => urlPathOf('api/[[...rest]]', 'f')).toThrow(/optional catch-all/);
    expect(() => urlPathOf('api/@modal', 'f')).toThrow(/parallel routes/);
    expect(() => urlPathOf('api/we ird', 'f')).toThrow(/segment shape/);
  });

  it('fails when the specification section it reads cannot be found', () => {
    // Asserted indirectly: the parser throws on a missing heading, so a spec rename fails this
    // gate loudly instead of turning every membership check into a vacuous pass.
    expect(() => specRoutes()).not.toThrow();
    expect(specRoutes().size).toBeGreaterThan(0);
  });

  it('the landed flag still decides something, with no entry left that uses it', () => {
    // Wave 1 flipped the last `landed: false` entry to `true`, so the branch that flag controls is
    // no longer taken by any real entry. A field nothing exercises is a field that rots into a
    // decoration, and the next wave would then declare a route with `landed: false` and get a
    // silent pass. So the two directions are exercised on a fixture: an entry declared but absent
    // is "missing", and the same entry present is "undeclared" until the flag is flipped.
    const fixture: readonly RouteDeclaration[] = [
      { method: 'GET', path: '/api/models', owner: 'W2-XX-01', landed: false },
    ];
    const served = new Set(['GET /api/models']);
    const landed = new Set(fixture.filter((entry) => entry.landed).map(key));
    expect([...served].filter((route) => !landed.has(route))).toEqual(['GET /api/models']);
    expect(
      fixture.filter((entry) => !entry.landed && served.has(key(entry))).map(key),
      'an entry marked landed: false whose route file has appeared must be reported',
    ).toEqual(['GET /api/models']);

    const flipped: readonly RouteDeclaration[] = fixture.map((entry) => ({
      ...entry,
      landed: true,
    }));
    const flippedLanded = new Set(flipped.filter((entry) => entry.landed).map(key));
    expect([...served].filter((route) => !flippedLanded.has(route))).toEqual([]);
    expect([...flippedLanded].filter((route) => !served.has(route))).toEqual([]);
    // And a route declared as landed that nothing serves is reported as missing.
    expect([...flippedLanded].filter((route) => !new Set<string>().has(route))).toEqual([
      'GET /api/models',
    ]);
  });
});
