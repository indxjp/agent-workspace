/**
 * The apps-e2e lane's blueprint scenario, its pure half (`blueprint.mjs`, ADR-0166, issue #1533):
 * the fixture app blueprint assembled from `examples/service-desk` is a valid blueprint, made only
 * of that app's files and the fixture's own recipe, and carries no secret, environment file or
 * connector URL. The scenario itself (npm pack, `aw blueprint add`, the build and the tests) runs
 * in the `apps-e2e` lane.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  BLUEPRINT_PACKAGE_KEYWORD,
  BlueprintManifestSchema,
  destructiveMigrations,
  parseBlueprintManifest,
} from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import {
  appKitVersion,
  BLUEPRINT_KEYWORD,
  BLUEPRINT_NAME,
  BLUEPRINT_PACKAGE,
  CHANGED_IN_V2,
  DESTRUCTIVE_MIGRATION,
  FIXTURE_VERSIONS,
  fixtureFiles,
  MIGRATION,
  scenarioTestProblem,
  SCENARIO_TESTS,
  SERVICE_DESK,
  SERVICE_DESK_MIGRATION,
  SERVICE_DESK_PARTS,
  SLA_RECIPE_TEST_PATH,
} from './blueprint.mjs';

const appKit = appKitVersion();
const variants = ['v1', 'v2', 'destructive'] as const;

describe('the fixture app blueprint', () => {
  it.each(variants)(
    '%s parses with BlueprintManifestSchema and pins its exact version',
    (variant) => {
      const files = fixtureFiles(variant, { appKit });
      const manifest = BlueprintManifestSchema.parse(JSON.parse(files.get('blueprint.json') ?? ''));
      const packageJson = JSON.parse(files.get('package.json') ?? '') as Record<string, unknown>;

      expect(parseBlueprintManifest(files.get('blueprint.json') ?? '')).toStrictEqual(manifest);
      expect(manifest.name).toBe(BLUEPRINT_NAME);
      expect(manifest.version).toBe(FIXTURE_VERSIONS[variant]);
      expect(manifest.appKit).toBe(`^${appKit}`);
      const { description, ...pinned } = packageJson;
      expect(typeof description).toBe('string');
      expect(BLUEPRINT_KEYWORD).toBe(BLUEPRINT_PACKAGE_KEYWORD);
      expect(pinned).toStrictEqual({
        name: BLUEPRINT_PACKAGE,
        version: FIXTURE_VERSIONS[variant],
        keywords: [BLUEPRINT_KEYWORD],
        license: 'Apache-2.0',
      });
      expect([...files.keys()].sort()).toStrictEqual(
        [
          'blueprint.json',
          'package.json',
          ...manifest.parts.map((part) => part.path),
          ...manifest.migrations,
        ].sort(),
      );
    },
  );

  it("takes every part but its own test from examples/service-desk's files", () => {
    for (const file of [...SERVICE_DESK_PARTS.map((part) => part.path), SERVICE_DESK_MIGRATION]) {
      expect(existsSync(path.join(SERVICE_DESK, file)), file).toBe(true);
    }
    expect(existsSync(path.join(SERVICE_DESK, SLA_RECIPE_TEST_PATH))).toBe(false);
    const manifest = parseBlueprintManifest(
      fixtureFiles('v1', { appKit }).get('blueprint.json') ?? '',
    );
    expect(manifest.parts).toStrictEqual([
      ...SERVICE_DESK_PARTS,
      { path: SLA_RECIPE_TEST_PATH, kind: 'test' },
    ]);
    expect(manifest.migrations).toStrictEqual([MIGRATION]);
    expect(manifest.slots).toStrictEqual({ connectors: [], secrets: [], agents: [] });
  });

  it("names the installer's schema in its migration, never the service desk's", () => {
    const migration = fixtureFiles('v1', { appKit }).get(MIGRATION) ?? '';

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "{{appSchema}}"."tickets"');
    expect(migration).not.toContain('app_service_desk');
    expect(destructiveMigrations(MIGRATION, migration)).toStrictEqual([]);
  });

  it('makes its recipe part a recipe: the rule with a default-exported defineRecipe', () => {
    const rule = fixtureFiles('v1', { appKit }).get(CHANGED_IN_V2) ?? '';

    expect(rule).toContain("export default defineRecipe({\n  name: 'sla-rule',");
    expect(rule).toContain('export function isBreached(');
  });

  it('carries no environment file, secret value or connector URL', () => {
    for (const variant of variants) {
      for (const [file, text] of fixtureFiles(variant, { appKit })) {
        expect(file).not.toMatch(/(?:^|\/)\.env/u);
        expect(text, file).not.toMatch(/https?:\/\//u);
        expect(text, file).not.toMatch(/aw[kuo]_live_|sk-ant-|BEGIN [A-Z ]*PRIVATE KEY/u);
        expect(text, file).not.toMatch(/"(?:url|token|secret|password)"\s*:/iu);
      }
    }
  });

  it('changes exactly one part in 1.1.0 and appends a destructive migration in 2.0.0', () => {
    const v1 = fixtureFiles('v1', { appKit });
    const v2 = fixtureFiles('v2', { appKit });
    const destructive = fixtureFiles('destructive', { appKit });
    const changed = (from: Map<string, string>, to: Map<string, string>) =>
      [...new Set([...from.keys(), ...to.keys()])]
        .filter((file) => from.get(file) !== to.get(file))
        .sort();

    expect(changed(v1, v2)).toStrictEqual(['blueprint.json', 'package.json', CHANGED_IN_V2]);
    expect(changed(v2, destructive)).toStrictEqual([
      'blueprint.json',
      DESTRUCTIVE_MIGRATION,
      'package.json',
    ]);
    const sql = destructive.get(DESTRUCTIVE_MIGRATION) ?? '';
    expect(destructiveMigrations(DESTRUCTIVE_MIGRATION, sql).map((each) => each.path)).toContain(
      DESTRUCTIVE_MIGRATION,
    );
  });

  it('refuses to assemble when a service desk file no longer holds what it rewrites', () => {
    const read = (file: string) =>
      file === SERVICE_DESK_MIGRATION ? 'CREATE TABLE "other"."tickets" ();\n' : 'export {};\n';

    expect(() => fixtureFiles('v1', { appKit, read })).toThrow(
      `${SERVICE_DESK_MIGRATION} no longer holds "app_service_desk"`,
    );
    expect(() =>
      fixtureFiles('v2', {
        appKit,
        read: (file) => (file === SERVICE_DESK_MIGRATION ? '"app_service_desk"' : 'export {};\n'),
      }),
    ).toThrow(`${CHANGED_IN_V2} no longer holds`);
  });
});

describe('scenarioTestProblem', () => {
  const passed = SCENARIO_TESTS.map((title) => ({ title, status: 'passed' }));

  it('passes when the command passed and every scenario test passed', () => {
    expect(scenarioTestProblem({ status: 0, output: '' }, passed)).toBeUndefined();
  });

  it('names a failed command, a missing test and an unsettled one', () => {
    expect(scenarioTestProblem({ status: 1, output: 'boom' }, passed)).toBe(
      'the tests exited 1:\nboom',
    );
    expect(scenarioTestProblem({ status: 0, output: '' }, passed.slice(1))).toBe(
      `no test is titled '${String(SCENARIO_TESTS[0])}'`,
    );
    expect(
      scenarioTestProblem({ status: 0, output: '' }, [
        ...passed.slice(0, 2),
        { title: String(SCENARIO_TESTS[2]), status: 'skipped' },
      ]),
    ).toBe(`the test '${String(SCENARIO_TESTS[2])}' is skipped, not passed`);
  });
});
