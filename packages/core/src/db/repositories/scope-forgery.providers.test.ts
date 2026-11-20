/**
 * **The run-time half of the two DECLARED compile-time escapes: every provider factory in the
 * database layer refuses a forged scope, and the set of factories is derived from the tracked tree
 * by the compiler's own types.**
 *
 * ## Why this block exists
 *
 * The fixture above tags an `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)`
 * `DECLARED`, and until verification round 1 the tag carried the sentence "`isWorkspaceScope`
 * refuses the value at run time". It did not. `WorkspaceScope.isWorkspaceScope` had **no call site
 * outside its own unit test**, and the verifier used both forgeries against a real PostgreSQL to
 * read another workspace's rows. A declared gap presented as mitigated by a control that is never
 * invoked is worse than an undeclared one, because it stops the next reader looking.
 *
 * `requireWorkspaceScope` is now that call site, and this block is what keeps it one.
 *
 * ## How the provider set is derived (ADR-0027), and why it is no longer derived from text
 *
 * Verification round 2 wrote `packages/core/src/db/repositories/skills.ts` containing
 *
 * ```text
 * export const createDatabaseSkillRepositoryProvider = (db: Database): SkillRepositoryProvider =>
 *   ({ forScope(scope) { … } });        // no requireWorkspaceScope anywhere
 * ```
 *
 * and this suite stayed green, because the set was derived by matching
 * `/^export function (createDatabase[A-Za-z]*Provider)\(/` against each module's text. A regular
 * expression over source text recognises a *syntax*, and the arrow-function form is a different
 * syntax for the same thing. So the derivation now asks the type checker instead:
 *
 *   1. the contributing set is `git ls-files` under the database layer, whose location comes from
 *      this file's own path rather than from a written one; every tracked path there is either
 *      `<name>.test.ts` (a suite) or `<name>.ts` (a module), and anything else is a hard failure
 *      naming the file, never a skip;
 *   2. a `ts.Program` is built over the modules, and **every exported value in every one of them**
 *      is classified by its type: a value with a call signature whose return type has a `forScope`
 *      member is a provider factory, whatever syntax declared it; a value without one is not, and
 *      that is the arm that makes this a classification;
 *   3. a factory so found must be reachable through `./unscoped.js` — one that is not is a hard
 *      failure naming the file and the export, because a gate that silently checked fewer
 *      providers than exist is the filter-instead-of-classifier failure ADR-0027 clause 3 is
 *      about.
 *
 * There is no list of provider names and no naming convention in this file, and the failure output
 * prints what was derived.
 */
import { describe, expect, it } from 'vitest';

import {
  ForgedWorkspaceScopeError,
  createInMemoryWorkspaceScopeResolver,
  WorkspaceScope,
} from './scope.js';
import { deriveProviders } from './scope-forgery.providers.test-support.js';
// The declared escape, imported here because the `db`-taking provider factories live on it and
// this file is a *.test.ts — the one importer shape `database-reachability.test.ts` admits.
import * as unscoped from './unscoped.js';

describe('every repository provider refuses a forged scope at run time', () => {
  const { layerDir, modules, suites, derived } = deriveProviders(unscoped);

  /** The set this block derived, printed on every failure (ADR-0027 clause 4). */
  const derivedSet = derived.map((row) => `${row.name} (${row.file})`).join(', ');

  /** A handle that would throw on any query, so a refusal cannot be mistaken for a query result. */
  const noDatabase = {} as never;

  /** The two forgeries the fixture above tags DECLARED, plus the object-literal cast. */
  const forgeries: readonly (readonly [string, () => unknown])[] = [
    ['a workspace id string cast to WorkspaceScope', (): unknown => 'workspace-b'],
    ['an object literal cast to WorkspaceScope', (): unknown => ({ workspaceId: 'workspace-b' })],
    [
      'Object.create(WorkspaceScope.prototype)',
      (): unknown => Object.create(WorkspaceScope.prototype) as unknown,
    ],
    ['a JSON round trip of a real scope', (): unknown => JSON.parse('{"workspaceId":"b"}')],
  ];

  it('derived at least one provider from the tracked tree, and a suite alongside it', () => {
    // ADR-0015: a check that cannot run must fail. An empty derivation would make every assertion
    // below vacuous, which is exactly how a broken shape rule passes.
    expect(
      derived.length,
      `no provider factory was derived from ${String(modules.length)} tracked modules under ` +
        `${layerDir}. The type rule, the program or the tracked listing is broken.`,
    ).toBeGreaterThan(0);
    expect(suites.length, 'no *.test.ts was found in the same listing').toBeGreaterThan(0);
  });

  it.each(derived.map((row) => [row.name, row.factory] as const))(
    '%s refuses every forged scope and admits a minted one',
    (name, factory) => {
      const provider = factory(noDatabase);
      for (const [label, forge] of forgeries) {
        expect(
          () => provider.forScope(forge()),
          `${name} did not refuse ${label}. Derived providers: ${derivedSet}`,
        ).toThrow(ForgedWorkspaceScopeError);
      }
    },
  );

  it.each(derived.map((row) => [row.name, row.factory] as const))(
    '%s admits a scope the resolver minted, so the refusal is not refusing everything',
    async (name, factory) => {
      const workspaceId = '5f0f6b1e-0f8f-4a1e-9f4a-1c2d3e4f5a6b';
      const scope = await createInMemoryWorkspaceScopeResolver([
        { id: workspaceId, slug: 'acme' },
      ]).forWorkspaceId(workspaceId);
      expect(scope, 'the in-memory resolver minted no scope for a workspace it was given').not.toBe(
        null,
      );
      expect(
        () => factory(noDatabase).forScope(scope),
        `${name} refused a scope the resolver minted. Derived providers: ${derivedSet}`,
      ).not.toThrow();
    },
  );
});
