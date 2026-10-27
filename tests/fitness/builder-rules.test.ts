// Fitness tests for the Builder CI rules (builder design §07 "Rules CI enforces", #1844 slice 3):
// (a) the default limits are defined once, (b) the Builder agent has only `aw-control` (#1848),
// (c) every `aw-control` tool maps to an SDK method that exists.
import { readdirSync, readFileSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AW_CONTROL_SERVER,
  BUILDER_DEFAULT_LIMITS,
  BUILDER_RUN_LIMITS,
  BUILDER_TOOLS,
  BUILDER_TOOL_SDK_METHODS,
  type BuilderToolName,
} from '@indx-workspace/contracts/builder';
import { describe, expect, it } from 'vitest';

import { builderAgent } from '../../apps/web/server/builder/agent/definition.js';
import { PROVING_ISSUES, MATRIX } from '../../scripts/stories/check.mts';
import { createClient } from '@indx-workspace/sdk';

const root = fileURLToPath(new URL('../../', import.meta.url));
const BUILDER_DIR = 'apps/web/server/builder';

describe('Builder stories', () => {
  it('registers the eight Builder stories, each naming the issue that proves it', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `US-BLD-0${i + 1}`);
    expect(ids.filter((id) => !(id in MATRIX))).toEqual([]);
    expect(ids.filter((id) => !/^#\d+$/.test(PROVING_ISSUES[id] ?? ''))).toEqual([]);
  });
});

interface Source {
  readonly path: string;
  readonly text: string;
}

const isTest = (path: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Non-test sources under `apps/web/server/builder/`, read from disk so a scratch file counts. */
function builderSources(): Source[] {
  return readdirSync(root + BUILDER_DIR, { recursive: true, encoding: 'utf8' })
    .map((p) => `${BUILDER_DIR}/${p.split(sep).join('/')}`)
    .filter((p) => /\.[cm]?[jt]sx?$/.test(p) && !isTest(p))
    .map((path) => ({ path, text: readFileSync(root + path, 'utf8') }));
}

/**
 * A literal equal to a limit's value. Small whole numbers count only on a line naming the limit.
 * Ceiling: a heuristic. It misses a small number far from a recognisable name (`const n = 20`) and
 * a value built by arithmetic; review catches those, and importing the constant is the fix.
 */
const LIMIT_PATTERNS: Readonly<
  Record<keyof typeof BUILDER_DEFAULT_LIMITS | keyof typeof BUILDER_RUN_LIMITS, RegExp>
> = {
  maxFailedChecksInARow: /^.*fail.*(?<![\w.])5(?![\w.]).*$/im,
  maxToolCallsPerRun: /^.*tool\w*calls?.*(?<![\w.])50(?![\w.]).*$/im,
  trialBudgetUsd: /(?<![\w.])0?\.30?(?![\w.])/,
  creationsPerWorkspacePerDay: /^.*creat.*(?<![\w.])20(?![\w.]).*$/im,
  toolOutputMaxBytes: /(?<![\w.])32_?768(?![\w.])/,
  maxTurns: /^.*(?:max_?turns?|\bturns?\b).*(?<![\w.])40(?![\w.]).*$/im,
  maxBudgetUsd: /^.*budget.*(?<![\w.])2(?:\.0+)?(?![\w.]).*$/im,
};

/** Rule (a): `file::limit` for every copy of a default limit outside contracts. */
function findLimitCopies(files: readonly Source[]): string[] {
  return files
    .flatMap(({ path, text }) =>
      Object.entries(LIMIT_PATTERNS)
        .filter(([, pattern]) => pattern.test(text))
        .map(([name]) => `${path}::${name}`),
    )
    .sort();
}

describe('rule (a): the Builder default limits are defined once', () => {
  it('flags a planted copy', () => {
    const files = [
      { path: 'x.ts', text: 'const MAX_OUTPUT = 32_768;\nconst budget = 0.3;' },
      { path: 'y.ts', text: 'const maxToolCalls = 50;\nconst failedChecks = 5;' },
      { path: 'w.ts', text: 'const creationsPerDay = 20;' },
      {
        path: 'v.ts',
        text: 'const maxTurns = 40;\nconst maxBudgetUsd = 2.0;\nconst budgetUsd = 2;',
      },
      {
        path: 'z.ts',
        text: 'const unrelated = 50; const page = 5; const n = 20; const t = 40;\nreturn list.slice(0, 40);',
      },
    ];
    expect(findLimitCopies(files)).toEqual([
      'v.ts::maxBudgetUsd',
      'v.ts::maxTurns',
      'w.ts::creationsPerWorkspacePerDay',
      'x.ts::toolOutputMaxBytes',
      'x.ts::trialBudgetUsd',
      'y.ts::maxFailedChecksInARow',
      'y.ts::maxToolCallsPerRun',
    ]);
  });

  it('finds no copy under apps/web/server/builder/', () => {
    expect(findLimitCopies(builderSources())).toEqual([]);
  });
});

type DefinitionTool = { readonly connector: string } | { readonly name: string };

/** Rule (b): every tool or tool connector of a Builder definition that is not `aw-control`. */
function toolServersOutsideAwControl(definition: {
  readonly tools?: readonly DefinitionTool[] | undefined;
}): string[] {
  return (definition.tools ?? [])
    .map((tool) => ('connector' in tool ? tool.connector : tool.name))
    .filter((id) => id !== AW_CONTROL_SERVER);
}

describe('rule (b): the Builder agent has only the aw-control tool server', () => {
  it('names every tool server other than aw-control', () => {
    expect(toolServersOutsideAwControl({ tools: [{ connector: AW_CONTROL_SERVER }] })).toEqual([]);
    expect(
      toolServersOutsideAwControl({
        tools: [{ connector: AW_CONTROL_SERVER }, { connector: 'github' }, { name: 'shell' }],
      }),
    ).toEqual(['github', 'shell']);
  });

  it('the built-in Builder definition has only aw-control', () => {
    expect(toolServersOutsideAwControl(builderAgent)).toEqual([]);
  });
});

/** Rule (c): the object at a dotted path of the real client, or `undefined`. */
function resolveMethod(path: string): unknown {
  const client = createClient({
    baseUrl: 'http://localhost',
    auth: { kind: 'api-key', apiKey: 'fitness' },
  });
  return path
    .replace(/\(.*\)$/, '')
    .split('.')
    .reduce<unknown>((node, key) => {
      if (node === null || (typeof node !== 'object' && typeof node !== 'function')) {
        return undefined;
      }
      // Inherited from Object or Function (`toString`, `call`) is not an SDK method.
      const inherited = key in Object.prototype || key in Function.prototype;
      return inherited ? undefined : Reflect.get(node, key);
    }, client);
}

describe('rule (c): every aw-control tool maps to SDK methods that exist', () => {
  it('covers exactly the closed tool list', () => {
    expect(Object.keys(BUILDER_TOOL_SDK_METHODS).sort()).toEqual(Object.keys(BUILDER_TOOLS).sort());
  });

  const entries = Object.entries(BUILDER_TOOL_SDK_METHODS) as [
    BuilderToolName,
    readonly string[],
  ][];
  it.each(entries.flatMap(([tool, methods]) => methods.map((m) => [tool, m] as const)))(
    '%s -> %s is a function on the client',
    (_tool, method) => {
      expect(typeof resolveMethod(method)).toBe('function');
    },
  );

  it('rejects a path the client does not have', () => {
    expect(typeof resolveMethod('agents.pointers.nope')).not.toBe('function');
    expect(typeof resolveMethod('agents.toString')).not.toBe('function');
    expect(typeof resolveMethod('runs.start.call')).not.toBe('function');
  });
});
