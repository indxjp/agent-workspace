/**
 * Property tests for {@link planBlueprintUpdate} (ADR-0166 D7): for any installed entry, any local
 * edits and any next version, an unedited file is never a conflict, an edited file the new version
 * changes or drops always is, and nothing is ever written over an edited file: a conflict writes
 * only to its `<file>.blueprint-<version>` sidecar. On a failure fast-check prints the seed and
 * path that reproduce it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  blueprintSidecarPath,
  planBlueprintUpdate,
  type BlueprintFile,
  type BlueprintLocalState,
  type BlueprintManifest,
} from './blueprint.js';
import { EMPTY_GENERATED_MANIFEST, type GeneratedEntry } from './generated-manifest.js';

const hash = (n: number): string => n.toString(16).padStart(64, '0');

const source = {
  package: '@acme/helpdesk-blueprint',
  version: '1.0.0',
  integrity: `sha512-${'A'.repeat(86)}==`,
};
const nextSource = { ...source, version: '2.0.0', integrity: `sha512-${'B'.repeat(86)}==` };

/** One installed file: whether it is edited on disk, and what the next version does with it. */
const installedFile = fc.record({
  local: fc.constantFrom('unedited', 'edited', 'missing'),
  next: fc.constantFrom('same', 'changed', 'removed', 'matches-local'),
});

interface Case {
  readonly installed: GeneratedEntry;
  readonly files: readonly BlueprintFile[];
  readonly hashes: Readonly<Record<string, string>>;
}

function buildCase(
  specs: readonly { readonly local: string; readonly next: string }[],
  added: number,
): Case {
  const installed: Record<string, string> = {};
  const hashes: Record<string, string> = {};
  const files: BlueprintFile[] = [];
  specs.forEach((spec, index) => {
    const path = `tests/f${String(index)}.ts`;
    const recorded = hash(index * 4);
    installed[path] = recorded;
    const local = spec.local === 'unedited' ? recorded : hash(index * 4 + 1);
    if (spec.local !== 'missing') hashes[path] = local;
    const next =
      spec.next === 'same'
        ? recorded
        : spec.next === 'changed'
          ? hash(index * 4 + 2)
          : spec.next === 'matches-local' && spec.local === 'edited'
            ? local
            : undefined;
    if (next !== undefined) files.push({ path, contents: `// ${next}\n`, sha256: next });
  });
  for (let index = 0; index < added; index += 1) {
    const sha256 = hash(10_000 + index);
    files.push({ path: `tests/new${String(index)}.ts`, contents: `// ${sha256}\n`, sha256 });
  }
  return {
    installed: { files: installed, edits: [], source, migrations: {} },
    files,
    hashes,
  };
}

function plan(testCase: Case): ReturnType<typeof planBlueprintUpdate> {
  const manifest: BlueprintManifest = {
    name: 'helpdesk',
    version: nextSource.version,
    appKit: '^0.9.0',
    parts: testCase.files.map((file) => ({ path: file.path, kind: 'test' as const })),
    slots: { connectors: [], secrets: [], agents: [] },
    migrations: [],
  };
  const local: BlueprintLocalState = {
    paths: ['package.json', ...Object.keys(testCase.hashes)],
    appKitVersion: '0.9.1',
    manifest: EMPTY_GENERATED_MANIFEST,
    agents: [],
    connectors: [],
    secrets: [],
    nextMigrationIndex: 0,
    hashes: testCase.hashes,
  };
  return planBlueprintUpdate(
    testCase.installed,
    { manifest, files: testCase.files, source: nextSource },
    local,
  );
}

const cases = fc
  .tuple(fc.array(installedFile, { minLength: 1, maxLength: 12 }), fc.nat({ max: 3 }))
  .map(([specs, added]) => buildCase(specs, added));

describe('planBlueprintUpdate properties', () => {
  it('never reports an unedited file as a conflict', () => {
    fc.assert(
      fc.property(cases, (testCase) => {
        for (const change of plan(testCase).changes) {
          const recorded = testCase.installed.files[change.path];
          if (recorded !== undefined && testCase.hashes[change.path] === recorded) {
            expect(change.action).not.toBe('conflict');
          }
        }
      }),
    );
  });

  it('always reports an edited file the new version changes or drops as a conflict', () => {
    fc.assert(
      fc.property(cases, (testCase) => {
        const next = new Map(testCase.files.map((file) => [file.path, file.sha256]));
        for (const change of plan(testCase).changes) {
          const recorded = testCase.installed.files[change.path];
          const local = testCase.hashes[change.path];
          const upcoming = next.get(change.path);
          const edited = recorded !== undefined && local !== recorded;
          const touched = upcoming !== recorded && (upcoming === undefined || upcoming !== local);
          if (edited && touched) expect(change.action).toBe('conflict');
          if (!edited || !touched) expect(change.action).not.toBe('conflict');
        }
      }),
    );
  });

  it('writes a conflict only to its sidecar, and never over an edited file', () => {
    fc.assert(
      fc.property(cases, (testCase) => {
        for (const change of plan(testCase).changes) {
          if (change.action === 'conflict') {
            expect(change.write).not.toBe(change.path);
            if (change.write !== undefined) {
              expect(change.write).toBe(blueprintSidecarPath(change.path, nextSource.version));
            }
          }
          const recorded = testCase.installed.files[change.path];
          if (change.write === change.path && recorded !== undefined) {
            expect(testCase.hashes[change.path]).toBe(recorded);
          }
        }
      }),
    );
  });
});
