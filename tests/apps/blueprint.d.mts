export type FixtureVariant = 'v1' | 'v2' | 'destructive';
export type ScenarioOutcome = { readonly status: 'ok' | 'failed'; readonly reason: string };
export type TestResult = { readonly title: string; readonly status: string };

export const SERVICE_DESK: string;
export const BLUEPRINT_NAME: string;
export const BLUEPRINT_PACKAGE: string;
export const BLUEPRINT_KEYWORD: string;
export const FIXTURE_VERSIONS: Readonly<Record<FixtureVariant, string>>;
export const SERVICE_DESK_PARTS: readonly { readonly path: string; readonly kind: string }[];
export const SLA_RECIPE_TEST_PATH: string;
export const SERVICE_DESK_MIGRATION: string;
export const MIGRATION: string;
export const DESTRUCTIVE_MIGRATION: string;
export const CHANGED_IN_V2: string;
export const SCENARIO_TESTS: readonly string[];
export const SLA_RECIPE_IMPORTS: string;
export const SLA_RECIPE: string;
export const SLA_RECIPE_TEST: string;
export function appKitVersion(): string;
export function fixtureFiles(
  variant: FixtureVariant,
  options: { appKit: string; read?: (file: string) => string },
): Map<string, string>;
export function packFixture(
  variant: FixtureVariant,
  directory: string,
  packs: string,
  options: { env: NodeJS.ProcessEnv; appKit: string },
): string;
export function scenarioTestProblem(
  command: { status: number; output: string },
  results: readonly TestResult[],
): string | undefined;
export function runBlueprintScenario(options: {
  work: string;
  env: NodeJS.ProcessEnv;
  install: (copy: string) => { status: string; reason: string };
  nodeTests: (copy: string) => {
    status: number;
    output: string;
    results?: readonly TestResult[];
  };
}): Promise<ScenarioOutcome>;
