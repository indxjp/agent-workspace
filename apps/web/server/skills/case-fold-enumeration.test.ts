/**
 * ADR-0048's third step, made executable: "make the enumeration a gate, so a site added later fails
 * rather than joining silently."
 *
 * ## The property, stated once
 *
 * No caller-supplied relative path becomes a `skillFileKey` store key without passing through a
 * case-fold collision check — `keys.ts#createCaseFoldGuard`, seeded with whatever the check needs
 * seeding with for that call site (nothing, for a brand-new import; the skill's existing directory,
 * for a `PATCH`), or `patchSkill`'s own `removesSkillMdByName` check for `removeFiles`.
 *
 * ## Why this is read out of the compiled AST rather than grepped
 *
 * ADR-0030: import edges — and, by the same reasoning, call-argument shapes — are resolved by the
 * compiler, not matched by regex. A text search for `skillFileKey(name,` would miss a call written
 * across two lines, or one where `name` had been renamed, and would not distinguish "the second
 * argument is a caller-controlled variable" from "the second argument is the `SKILL_MD_FILENAME`
 * constant" without hand-rolled string surgery that is exactly the fragile shape ADR-0030 replaced.
 * This walks the real `ts.SourceFile`.
 *
 * ## How this is a gate, not just a test of today's three sites
 *
 * `expectedArgumentCounts` below is the enumeration, derived from and asserted against
 * `handlers.ts`'s own source. It does not merely check that the three known-good call sites
 * (`importSkill`'s `files`, `patchSkill`'s `files`, `patchSkill`'s `removeFiles`) are each guarded —
 * `describeCollidingCallSites` first collects the FULL, unfiltered set of every `skillFileKey(...)`
 * call's second-argument text and how many times each spelling appears, with no allowlist filtering
 * anything out beforehand. The final assertion requires that set to equal `expectedArgumentCounts`
 * exactly: an unrecognised argument expression (a fourth caller-controlled site, or an existing one
 * renamed) changes the derived set and fails the count-of-distinct-expressions assertion below, by
 * name, rather than being silently skipped as "not one we check." A future site is caught for
 * *existing* the moment it is added, before anyone has to remember to add a matching guard test for
 * it — the failure message names the unrecognised expression and its line, so the next person knows
 * exactly what to go look at.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HANDLERS_FILE = fileURLToPath(new URL('./handlers.ts', import.meta.url));
const VALIDATE_FILE = fileURLToPath(new URL('./validate.ts', import.meta.url));

interface CallSite {
  readonly argumentText: string;
  readonly line: number; // 1-based, for a human chasing a failure
}

/** Every `skillFileKey(<first>, <second>)` call in `handlers.ts`, with `<second>`'s exact source
 * text — not its value, since three of the four expected spellings are variables, not literals. */
function skillFileKeyCallSites(): readonly CallSite[] {
  const text = readFileSync(HANDLERS_FILE, 'utf8');
  const source = ts.createSourceFile(
    HANDLERS_FILE,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const sites: CallSite[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'skillFileKey'
    ) {
      const second = node.arguments[1];
      if (second === undefined) {
        throw new Error(
          `skillFileKey called with fewer than 2 arguments at line ` +
            `${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)} — ` +
            'this function has no 1-argument overload, so this is malformed code this gate refuses ' +
            'to reason past silently (ADR-0015).',
        );
      }
      sites.push({
        argumentText: second.getText(source),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (sites.length === 0) {
    throw new Error(
      'found zero skillFileKey(...) call sites in handlers.ts — this gate has nothing to assert ' +
        'coverage against, which is indistinguishable from every site being covered (ADR-0015).',
    );
  }
  return sites;
}

/** How many times each distinct second-argument spelling appears, across all call sites. */
function countsByArgumentText(sites: readonly CallSite[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const site of sites) counts.set(site.argumentText, (counts.get(site.argumentText) ?? 0) + 1);
  return counts;
}

/**
 * The enumeration, as of round 4. Each entry names the call sites it stands for and why that
 * spelling is either caller-controlled-and-guarded or a constant needing no guard at all — this
 * comment is itself part of the gate (ADR-0048, "the enumeration is written down and asserted, not
 * remembered").
 */
const expectedArgumentCounts: ReadonlyMap<string, number> = new Map([
  // Caller-controlled, and guarded:
  //   - importSkill: `decoded.push({ key: skillFileKey(name, file.path), ... })` — every `file.path`
  //     already passed `createCaseFoldGuard` seeded with `[]` inside `validateImportBody`.
  //   - patchSkill: `puts.push({ key: skillFileKey(name, file.path), ... })` — every `file.path`
  //     already passed `createCaseFoldGuard` seeded with this skill's existing directory, in the
  //     loop directly above where `puts` is built (round 4, B2-PATCH's own repair).
  ['file.path', 2],
  // Caller-controlled, and guarded:
  //   - patchSkill: `deletes.push(skillFileKey(name, relativePath))` — every `relativePath` in
  //     `removeFiles` already passed `removesSkillMdByName`'s case-fold check, just above.
  ['relativePath', 1],
  // NOT caller-controlled — the literal `SKILL_MD_FILENAME` constant, needing no case-fold guard
  // because it is never a value a request supplied:
  //   - describeSkill's own SKILL.md read, patchSkill's pre-delete capture, its post-delete
  //     still-present check, and its restore-on-failure put.
  ['SKILL_MD_FILENAME', 4],
]);

describe('B2-PATCH enumeration gate (ADR-0048)', () => {
  it('finds exactly the enumerated skillFileKey(...) call sites in handlers.ts, by argument spelling', () => {
    const sites = skillFileKeyCallSites();
    const actual = countsByArgumentText(sites);

    const actualKeys = [...actual.keys()].sort();
    const expectedKeys = [...expectedArgumentCounts.keys()].sort();
    const unrecognised = actualKeys.filter((k) => !expectedArgumentCounts.has(k));
    const missing = expectedKeys.filter((k) => !actual.has(k));

    if (unrecognised.length > 0) {
      const detail = sites
        .filter((s) => unrecognised.includes(s.argumentText))
        .map((s) => `  handlers.ts:${String(s.line)}: skillFileKey(..., ${s.argumentText})`)
        .join('\n');
      throw new Error(
        `skillFileKey(...) is called with an argument expression this gate does not recognise:\n` +
          `${detail}\n` +
          'This is either a new site where a caller-supplied path becomes a store key — it must be ' +
          'seeded through keys.ts#createCaseFoldGuard (or an equivalent, named, case-fold check) ' +
          'before it reaches this call, the same way every other site in this enumeration already ' +
          'is — or it is one of the four existing constant-argument sites, renamed, in which case ' +
          "update this test's expectedArgumentCounts and its comment to match (ADR-0048: the " +
          'enumeration is written down and asserted, not remembered).',
      );
    }
    expect(missing, `expected call sites missing from handlers.ts: ${missing.join(', ')}`).toEqual(
      [],
    );

    for (const [argumentText, expectedCount] of expectedArgumentCounts) {
      expect(
        actual.get(argumentText),
        `count of skillFileKey(..., ${argumentText}) call sites`,
      ).toBe(expectedCount);
    }
  });

  it('handlers.ts calls the shared case-fold guard exactly at the two caller-controlled write sites', () => {
    // Ties the enumeration above to the actual guard, so removing the guard call while leaving the
    // skillFileKey(name, file.path) call untouched still fails this gate. Counted via the compiler
    // for the same ADR-0030 reason as skillFileKeyCallSites, not grepped.
    let guardCalls = 0;
    let removesSkillMdByNameDeclarations = 0;
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createCaseFoldGuard'
      ) {
        guardCalls += 1;
      }
      if (ts.isIdentifier(node) && node.text === 'removesSkillMdByName') {
        removesSkillMdByNameDeclarations += 1;
      }
      ts.forEachChild(node, walk);
    };
    for (const file of [HANDLERS_FILE, VALIDATE_FILE]) {
      walk(
        ts.createSourceFile(
          file,
          readFileSync(file, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        ),
      );
    }
    // One call in validate.ts's validateImportBody (seeded []), one in handlers.ts's patchSkill
    // (seeded from the existing directory) — exactly the two 'file.path' sites the enumeration
    // above counted.
    expect(guardCalls, 'createCaseFoldGuard(...) call sites in handlers.ts and validate.ts').toBe(
      2,
    );
    // At least a declaration and a use — proves the identifier was not deleted while its call site
    // (deletes.push(skillFileKey(name, relativePath))) was left standing unguarded.
    expect(
      removesSkillMdByNameDeclarations,
      'occurrences of the identifier removesSkillMdByName in handlers.ts',
    ).toBeGreaterThanOrEqual(2);
  });
});
