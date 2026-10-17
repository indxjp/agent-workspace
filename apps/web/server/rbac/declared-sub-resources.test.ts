/**
 * The gate on the sub-resource partition: the union {@link DECLARED_SUB_RESOURCES} composes is
 * exactly the union the tracked tree declares.
 *
 * ## Why this gate has to exist
 *
 * `decide()` runs inside a Next.js server bundle, so the declarations reach it through the static
 * imports written out in `declared-sub-resources.ts` — a directory read at run time is not
 * available there, and `tests/no-sdk-import.test.ts` refuses a module reference whose argument is
 * not a string literal in any case. A written-out import list has exactly one failure mode: a task
 * adds `apps/web/server/rbac/declarations/<TASK-ID>.ts`, nobody adds the import, and the union is
 * quietly one task short. Nothing about that is visible — the file type-checks, lints and formats
 * — and the only symptom is `authorisation-matrix.test.ts` refusing the routes the declaration was
 * written to classify, which reads like a wrong classification rather than an absent one.
 *
 * So the file set is derived from the tracked tree, twice and through a wider pathspec, the way
 * `tests/route-inventory.test.ts` derives its own (ADR-0027 §1), and compared against what the
 * module actually composed. The comparison is on the **owners**, because that is what both sides
 * know independently: a declaration file is named for its owning task, and every entry in it must
 * name the same task.
 *
 * ## Why this file and not `tests/`
 *
 * It is a repository-wide gate over a directory every route-shipping track writes into, so by
 * ADR-0019 it belongs to the integration level — but it cannot live in `tests/`. That directory
 * type-checks under `tsconfig.root.json`'s `nodenext` resolution and `apps/web`'s sources are
 * written for `bundler` resolution (extensionless relative specifiers), so a `tests/` file
 * importing `permissions.ts` fails `pnpm typecheck` before it can assert anything. It sits beside
 * the module it gates instead, and its ownership is declared on W2-INT-01's PR.
 *
 * ## What it cannot decide, stated rather than implied (ADR-0031)
 *
 * It does not check that a declaration's `because` is a *true* reading of §21 — no mechanical test
 * can — only that one is present, so a classification always arrives with its evidence attached
 * and a reviewer has something to disagree with. And it reads the declaration files as text rather
 * than importing them, for the reason `tests/inventory-support.ts`'s header gives at length, so a
 * declaration built by an expression rather than written as data is a hard failure from that
 * reader rather than something this gate quietly accepts.
 */
import { describe, expect, it } from 'vitest';

import {
  declarationPaths,
  readDeclarationFiles,
  requireString,
  unknownFields,
} from '../../../../tests/inventory-support';

import { composeSubResources, DECLARED_SUB_RESOURCES } from './declared-sub-resources';
import { RESOURCES, SUB_RESOURCES } from './permissions';

/** The partition ADR-0040 splits the sub-resource classification into. */
const DECLARATIONS = 'apps/web/server/rbac/declarations';

/** The fields a declaration entry may carry. A field nobody reads is refused, not ignored. */
const FIELDS = ['owner', 'resource', 'sub', 'because'];

const files = readDeclarationFiles(DECLARATIONS, 'subResources');

describe('the sub-resource partition is read from the tracked tree', () => {
  it('reads every tracked declaration file, derived twice from the tracked tree', () => {
    // The wider pathspec is `apps/web`, so the failure this catches is the enumerating call itself
    // going narrow — which would satisfy every assertion below by having nothing left to check.
    const derived = declarationPaths(DECLARATIONS, 'apps/web');
    expect(files.map((file) => file.repoPath)).toEqual(derived);
    expect(derived.length).toBeGreaterThan(0);
  });

  it('gives every entry an owner equal to its file, a classified resource, a sub and a reason', () => {
    const known: readonly string[] = RESOURCES;
    for (const file of files) {
      for (const [index, entry] of file.entries.entries()) {
        const where = `${file.repoPath} entry ${String(index)}`;
        expect(unknownFields(entry, FIELDS), where).toEqual([]);
        expect(requireString(entry, 'owner', where), where).toBe(file.owner);
        const resource = requireString(entry, 'resource', where);
        expect(
          known,
          `${where}: "${resource}" is not a resource §21's table classifies, so this declaration ` +
            `would attach a sub segment to nothing. Add the resource with its four grants in ` +
            `permissions.ts first.`,
        ).toContain(resource);
        expect(requireString(entry, 'sub', where).length, where).toBeGreaterThan(0);
        expect(requireString(entry, 'because', where).length, where).toBeGreaterThan(0);
      }
    }
  });

  it('composes exactly the tracked files — an unimported declaration fails, it is not skipped', () => {
    // The whole point of the gate. Left: what the module composed at import time, through the
    // written-out import list. Right: what `git ls-files` says is there. Both derived; no literal
    // list of task ids anywhere in this file.
    const composed = [...new Set(DECLARED_SUB_RESOURCES.map((entry) => entry.owner))].sort();
    const tracked = [...new Set(files.map((file) => file.owner))].sort();
    expect(
      composed,
      'apps/web/server/rbac/declared-sub-resources.ts composes a different set of tasks from the ' +
        'one tracked under apps/web/server/rbac/declarations/. Add the missing import — or delete ' +
        'the file that no longer declares anything. A declaration nothing imports contributes ' +
        'nothing to decide() and reads exactly like a wrong classification.',
    ).toEqual(tracked);
  });

  it('reaches the table decide() actually reads, for every declared pair', () => {
    // Derived from the union rather than named: this is what makes the assertion above a statement
    // about `decide()` and not only about two lists of task ids.
    expect(DECLARED_SUB_RESOURCES.length).toBeGreaterThan(0);
    for (const entry of DECLARED_SUB_RESOURCES) {
      expect(SUB_RESOURCES[entry.resource], `${entry.owner} declared "${entry.sub}"`).toContain(
        entry.sub,
      );
    }
    // …and §34's own classifications survived the composition rather than being displaced by it.
    expect(SUB_RESOURCES.agents).toContain('runs');
    expect(SUB_RESOURCES.runs).toContain('events');
    expect(SUB_RESOURCES.sessions).toContain('messages');
  });
});

describe('the composition fails closed — the counter-examples, run', () => {
  /**
   * ADR-0029: a claim about a gate stays a claim until a tree the gate must reject is built and
   * the gate is watched rejecting it. These build that tree in memory and hand it to the same
   * `composeSubResources` `permissions.ts` calls, so what is proved is the function's behaviour
   * and not a paraphrase of it.
   */
  // The base is the live table, not a fixture built beside it. A synthetic `Record<Resource, …>`
  // would need a type assertion to construct and would be a second copy of the thing under test;
  // this way the counter-examples run against exactly what `decide()` reads.
  const base = SUB_RESOURCES;

  it('refuses two tasks classifying the same (resource, sub) pair', () => {
    expect(() =>
      composeSubResources(base, [
        { owner: 'W2-XX-98', resource: 'sessions', sub: 'annotations', because: 'first' },
        { owner: 'W2-XX-99', resource: 'sessions', sub: 'annotations', because: 'second' },
      ]),
    ).toThrow(/W2-XX-99 declares "annotations"/);
  });

  it('refuses a declaration restating one the specification table already carries', () => {
    expect(() =>
      composeSubResources(base, [
        { owner: 'W2-XX-99', resource: 'runs', sub: 'events', because: 'already §34’s' },
      ]),
    ).toThrow(/permissions\.ts already classifies it/);
  });

  it('refuses a declaration restating one another task already declared', () => {
    const existing = DECLARED_SUB_RESOURCES[0];
    expect(existing).toBeDefined();
    if (existing === undefined) throw new Error('the union declares nothing to restate');
    expect(() =>
      composeSubResources(base, [
        { owner: 'W2-XX-99', resource: existing.resource, sub: existing.sub, because: 'again' },
      ]),
    ).toThrow(new RegExp(`W2-XX-99 declares "${existing.sub}"`));
  });

  it('leaves the record total, and every undeclared resource exactly as it was', () => {
    const composed = composeSubResources(base, [
      { owner: 'W2-XX-99', resource: 'skills', sub: 'versions', because: 'a reading of §21' },
    ]);
    expect(composed.skills).toEqual([...base.skills, 'versions']);
    expect(composed.runs).toEqual(base.runs);
    expect(composed.agents).toEqual(base.agents);
    // Total over every resource, so a declaration cannot drop a key and turn a lookup undefined —
    // which `noUncheckedIndexedAccess` would not catch on a `Record` whose key type is total.
    expect(Object.keys(composed).sort()).toEqual([...RESOURCES].sort());
  });
});
