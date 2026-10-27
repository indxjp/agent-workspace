import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentPermissions, AgentPolicy } from '@indx-workspace/contracts/agents';

import {
  FIXTURE_PERMISSIONS,
  FIXTURE_POLICY,
  fixtureSurface,
  versionRequest,
} from '../../agent-versions/fixtures.js';
import { FIELD_CLASSES, widenings } from './never-wider.js';

type Edits = NonNullable<Parameters<typeof versionRequest>[0]>;

const body = (edits: Edits = {}): AgentVersionBody =>
  AgentVersionBodySchema.parse(versionRequest(edits).body);

const withFiles = (base: AgentVersionBody, files: readonly object[]): AgentVersionBody => ({
  ...base,
  definition: {
    ...base.definition,
    resources: {
      ...base.definition.resources,
      files: files as AgentVersionBody['definition']['resources']['files'],
    },
  },
});

const WITH_EXTRAS: AgentVersionBody = {
  ...body({ surfaces: [fixtureSurface('web')] }),
  knowledge: [{ kind: 'connector', name: 'crm' }],
};

const WITH_BUNDLE: AgentVersionBody = {
  ...body(),
  toolBundles: [{ tool: 'lookup_order', digest: 'a'.repeat(64) }],
};

const paths = (child: AgentVersionBody, creator: AgentVersionBody): string[] =>
  widenings(child, creator).map((widening) => widening.path);

const withModel = (base: AgentVersionBody, model: string | null): AgentVersionBody => ({
  ...base,
  definition: { ...base.definition, agent: { ...base.definition.agent, model } },
});

const limited = (maxTurns: number | null, maxBudgetUsd: number | null): AgentPolicy => ({
  ...FIXTURE_POLICY,
  limits: { maxTurns, maxBudgetUsd },
});

const openAi = (
  extra: { withheldPermissions?: readonly (keyof AgentPermissions)[] } = {},
): AgentPolicy => ({
  engine: 'openai-agents',
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
  ...extra,
});

const ALL_ON: AgentPermissions = {
  readFiles: true,
  writeFiles: true,
  runCommands: true,
  unrestrictedNetwork: true,
};
const grant = (path: string, access: 'read' | 'read-write' = 'read') => ({ path, access });

describe('[US-BLD-07][unit][sdk] widenings', () => {
  it('a child that adds one permission its creator lacks is wider at that path', () => {
    const creator = body({ permissions: FIXTURE_PERMISSIONS });
    const child = body({ permissions: { ...FIXTURE_PERMISSIONS, runCommands: true } });
    expect(widenings(child, creator)).toEqual([
      { path: 'definition.agent.permissions.runCommands', child: true, creator: false },
    ]);
  });

  const cases: readonly (readonly [
    string,
    AgentVersionBody,
    AgentVersionBody,
    readonly string[],
  ])[] = [
    [
      'a withheld permission makes the child narrower',
      body({ policy: openAi(), permissions: ALL_ON }),
      body({ policy: openAi({ withheldPermissions: ['runCommands'] }), permissions: ALL_ON }),
      [],
    ],
    [
      'a creator that withholds a permission is wider than a child that does not',
      body({ policy: openAi({ withheldPermissions: ['runCommands'] }), permissions: ALL_ON }),
      body({ policy: openAi(), permissions: ALL_ON }),
      ['definition.agent.permissions.runCommands'],
    ],
    [
      'a subset of connectors',
      body({ resources: { connectors: ['crm', 'mail'] } }),
      body({ resources: { connectors: ['mail'] } }),
      [],
    ],
    [
      'a connector the creator lacks',
      body(),
      body({ resources: { connectors: ['crm'] } }),
      ['definition.resources.connectors["crm"]'],
    ],
    [
      'a skill the creator lacks',
      body(),
      body({ resources: { skills: ['triage'] } }),
      ['definition.resources.skills["triage"]'],
    ],
    [
      'an allowlist that narrows the skills',
      body({ resources: { skills: ['a', 'b'] } }),
      body({
        resources: { skills: ['a', 'b'] },
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: ['a'] } },
      }),
      [],
    ],
    [
      'a creator allowlist that hides a skill the child can use',
      body({
        resources: { skills: ['a', 'b'] },
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: ['a'] } },
      }),
      body({ resources: { skills: ['a', 'b'] } }),
      ['definition.resources.skills["b"]'],
    ],
    [
      'a different pin of a shared skill',
      body({ resources: { skills: ['a'], skillRevisions: { a: 1 } } }),
      body({ resources: { skills: ['a'], skillRevisions: { a: 2 } } }),
      ['definition.resources.skillRevisions["a"]'],
    ],
    [
      'a file the creator lacks',
      body({ resources: { files: [grant('docs')] } }),
      body({ resources: { files: [grant('docs'), grant('secrets')] } }),
      ['definition.resources.files["secrets"]'],
    ],
    [
      'a narrower file path',
      body({ resources: { files: [grant('docs', 'read-write')] } }),
      body({ resources: { files: [grant('docs/public', 'read-write')] } }),
      [],
    ],
    [
      'read under read-write',
      body({ resources: { files: [grant('docs', 'read-write')] } }),
      body({ resources: { files: [grant('docs', 'read')] } }),
      [],
    ],
    [
      'read-write over read',
      body({ resources: { files: [grant('docs', 'read')] } }),
      body({ resources: { files: [grant('docs', 'read-write')] } }),
      ['definition.resources.files["docs"]'],
    ],
    [
      "a folder that spans the creator's narrower override is reported at the child's grant",
      body({ resources: { files: [grant('data', 'read-write'), grant('data/secret', 'read')] } }),
      body({ resources: { files: [grant('data', 'read-write')] } }),
      ['definition.resources.files["data"]'],
    ],
    [
      'a path only the creator names is never reported',
      body({ resources: { files: [grant('docs', 'read'), grant('docs/private', 'read-write')] } }),
      body({ resources: { files: [grant('docs', 'read-write')] } }),
      ['definition.resources.files["docs"]'],
    ],
    [
      'a file grant with a key the rules do not know',
      body({ resources: { files: [grant('docs')] } }),
      withFiles(body(), [{ ...grant('docs'), recursive: true }]),
      ['definition.resources.files["docs"]'],
    ],
    [
      'a subagent with a key the rules do not know',
      body({ subagents: ['a'] }),
      {
        ...body({ subagents: ['a'] }),
        subagents: [{ name: 'a', model: 'm' }] as unknown as AgentVersionBody['subagents'],
      },
      ['subagents["a"]'],
    ],
    [
      "a path that climbs out of the creator's folder",
      body({ resources: { files: [grant('docs', 'read')] } }),
      body({ resources: { files: [grant('docs/../secrets', 'read')] } }),
      ['definition.resources.files["docs/../secrets"]'],
    ],
    [
      'a lower turn limit',
      body({ policy: limited(10, null) }),
      body({ policy: limited(5, null) }),
      [],
    ],
    [
      'a capped limit under an unlimited creator',
      body({ policy: limited(null, null) }),
      body({ policy: limited(3, 2) }),
      [],
    ],
    [
      'a higher turn limit',
      body({ policy: limited(5, null) }),
      body({ policy: limited(10, null) }),
      ['definition.policy.limits.maxTurns'],
    ],
    [
      'an unlimited budget under a capped creator',
      body({ policy: limited(null, 1) }),
      body({ policy: limited(null, null) }),
      ['definition.policy.limits.maxBudgetUsd'],
    ],
    [
      'a different model',
      withModel(body(), 'm-1'),
      withModel(body(), 'm-2'),
      ['definition.agent.model'],
    ],
    [
      'a different engine',
      body({ policy: FIXTURE_POLICY }),
      body({ policy: openAi() }),
      ['definition.policy.engine', 'definition.policy.tools'],
    ],
    [
      'a subagent the creator lacks',
      body({ subagents: ['a'] }),
      body({ subagents: ['a', 'b'] }),
      ['subagents["b"]'],
    ],
    ['fewer subagents', body({ subagents: ['a', 'b'] }), body({ subagents: ['a'] }), []],
    ['an added tool bundle', body(), WITH_BUNDLE, ['toolBundles']],
    ['an added surface', body(), body({ surfaces: [fixtureSurface('web')] }), ['surfaces']],
    ['omitted surfaces and knowledge', WITH_EXTRAS, body(), []],
    ['empty knowledge', WITH_EXTRAS, { ...body(), knowledge: [] }, []],
    // No bundles means no sandbox and an unpinned dev-tools connector: removal is not narrowing.
    ['omitted tool bundles', WITH_BUNDLE, body(), ['toolBundles']],
    ['empty tool bundles', WITH_BUNDLE, { ...body(), toolBundles: [] }, ['toolBundles']],
    [
      'different knowledge than the creator has',
      { ...body(), knowledge: [{ kind: 'connector', name: 'crm' }] },
      { ...body(), knowledge: [{ kind: 'connector', name: 'erp' }] },
      ['knowledge'],
    ],
    [
      'a different name, instructions and description',
      body({ name: 'a', instructions: 'x' }),
      body({ name: 'b', instructions: 'y', description: 'z' }),
      [],
    ],
  ];
  it.each(cases)('%s', (_name, creator, child, expected) => {
    expect(paths(child, creator)).toEqual(expected);
  });

  it('lists every widening once, sorted by path', () => {
    const creator = body({ resources: { files: [grant('b')] } });
    const child = body({
      permissions: ALL_ON,
      resources: { connectors: ['z', 'a'], files: [grant('b', 'read-write'), grant('a')] },
      subagents: ['s'],
    });
    const found = widenings(child, creator);
    expect(found.map((widening) => widening.path)).toEqual([
      'definition.agent.permissions.runCommands',
      'definition.agent.permissions.unrestrictedNetwork',
      'definition.agent.permissions.writeFiles',
      'definition.resources.connectors["a"]',
      'definition.resources.connectors["z"]',
      'definition.resources.files["a"]',
      'definition.resources.files["b"]',
      'subagents["s"]',
    ]);
    expect(widenings(child, creator)).toEqual(found);
    expect(Object.isFrozen(found)).toBe(true);
  });
});

describe('[US-BLD-07][unit][sdk] widenings classifies every key of the body', () => {
  /** The lists whose element shapes are walked too: a key added inside one needs a rule as well. */
  const WALKED_LISTS = ['definition.resources.files', 'subagents'];

  function unitPaths(schema: z.ZodType, path: string, out: Set<string>): void {
    if (
      schema instanceof z.ZodReadonly ||
      schema instanceof z.ZodOptional ||
      schema instanceof z.ZodNullable ||
      schema instanceof z.ZodDefault
    ) {
      unitPaths(schema.unwrap() as z.ZodType, path, out);
    } else if (schema instanceof z.ZodArray && WALKED_LISTS.includes(path)) {
      out.add(path);
      unitPaths(schema.element as z.ZodType, `${path}[]`, out);
    } else if (Object.hasOwn(FIELD_CLASSES, path)) out.add(path);
    else if (schema instanceof z.ZodObject) {
      for (const [key, child] of Object.entries<z.ZodType>(schema.shape)) {
        unitPaths(child, path === '' ? key : `${path}.${key}`, out);
      }
    } else if (schema instanceof z.ZodDiscriminatedUnion) {
      for (const option of schema.options as z.ZodType[]) unitPaths(option, path, out);
    } else out.add(path);
  }

  const reached = new Set<string>();
  unitPaths(AgentVersionBodySchema, '', reached);

  it('names a rule, an identity or the fail-closed default for each key, element keys of files and subagents included', () => {
    expect([...reached].filter((path) => !Object.hasOwn(FIELD_CLASSES, path))).toEqual([]);
  });

  it('names no key the body does not have', () => {
    expect(Object.keys(FIELD_CLASSES).filter((path) => !reached.has(path))).toEqual([]);
  });
});

describe('[US-BLD-07][unit][sdk] widenings properties', () => {
  interface Spec {
    permissions: AgentPermissions;
    connectors: string[];
    skills: string[];
    files: { path: string; access: 'read' | 'read-write' }[];
    limits: { maxTurns: number | null; maxBudgetUsd: number | null };
    subagents: string[];
  }
  const BASE = body();
  const bodyOf = (spec: Spec): AgentVersionBody => ({
    ...BASE,
    subagents: spec.subagents.map((name) => ({ name })),
    definition: {
      ...BASE.definition,
      agent: { ...BASE.definition.agent, permissions: spec.permissions },
      policy: { ...FIXTURE_POLICY, limits: spec.limits },
      resources: { files: spec.files, skills: spec.skills, connectors: spec.connectors },
    },
  });

  const names = (prefix: string) =>
    fc.uniqueArray(fc.constantFrom(`${prefix}0`, `${prefix}1`, `${prefix}2`, `${prefix}3`), {
      maxLength: 4,
    });
  const specs: fc.Arbitrary<Spec> = fc.record({
    permissions: fc.record({
      readFiles: fc.boolean(),
      writeFiles: fc.boolean(),
      runCommands: fc.boolean(),
      unrestrictedNetwork: fc.boolean(),
    }),
    connectors: names('conn'),
    skills: names('skill'),
    files: fc.uniqueArray(
      fc.record({
        path: fc.constantFrom('f0', 'f1', 'f2', 'f3'),
        access: fc.constantFrom('read', 'read-write'),
      }),
      { selector: (file) => file.path, maxLength: 4 },
    ),
    limits: fc.record({
      maxTurns: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
      maxBudgetUsd: fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
    }),
    subagents: names('sub'),
  });
  const coins = fc.array(fc.boolean(), { minLength: 64, maxLength: 64 });
  const RUNS = { numRuns: 500 };

  function narrowed(spec: Spec, flips: readonly boolean[]): Spec {
    let next = 0;
    const flip = (): boolean => flips[next++ % flips.length] === true;
    const lower = (value: number | null): number | null =>
      value === null ? (flip() ? null : 7) : flip() ? value : Math.max(1, value - 1);
    return {
      permissions: {
        readFiles: spec.permissions.readFiles && flip(),
        writeFiles: spec.permissions.writeFiles && flip(),
        runCommands: spec.permissions.runCommands && flip(),
        unrestrictedNetwork: spec.permissions.unrestrictedNetwork && flip(),
      },
      connectors: spec.connectors.filter(flip),
      skills: spec.skills.filter(flip),
      files: spec.files.filter(flip).map((file) => ({
        path: flip() ? file.path : `${file.path}/sub`,
        access: flip() ? file.access : 'read',
      })),
      limits: {
        maxTurns: lower(spec.limits.maxTurns),
        maxBudgetUsd: lower(spec.limits.maxBudgetUsd),
      },
      subagents: spec.subagents.filter(flip),
    };
  }

  it('narrowing is never wider', () => {
    fc.assert(
      fc.property(specs, coins, (spec, flips) => {
        expect(paths(bodyOf(narrowed(spec, flips)), bodyOf(spec))).toEqual([]);
      }),
      RUNS,
    );
  });

  const mutators: readonly (readonly [(spec: Spec) => AgentVersionBody, string])[] = [
    [
      (spec) => bodyOf({ ...spec, permissions: { ...spec.permissions, runCommands: true } }),
      'definition.agent.permissions.runCommands',
    ],
    [
      (spec) => bodyOf({ ...spec, connectors: [...spec.connectors, 'fresh'] }),
      'definition.resources.connectors["fresh"]',
    ],
    [
      (spec) => bodyOf({ ...spec, skills: [...spec.skills, 'fresh'] }),
      'definition.resources.skills["fresh"]',
    ],
    [
      (spec) => bodyOf({ ...spec, files: [...spec.files, { path: 'fresh', access: 'read' }] }),
      'definition.resources.files["fresh"]',
    ],
    [
      (spec) =>
        bodyOf({
          ...spec,
          files: [
            ...spec.files.filter((file) => file.path !== 'f0'),
            { path: 'f0', access: 'read-write' },
          ],
        }),
      'definition.resources.files["f0"]',
    ],
    [
      (spec) => bodyOf({ ...spec, limits: { ...spec.limits, maxTurns: 101 } }),
      'definition.policy.limits.maxTurns',
    ],
    [
      (spec) => bodyOf({ ...spec, limits: { ...spec.limits, maxBudgetUsd: null } }),
      'definition.policy.limits.maxBudgetUsd',
    ],
    [(spec) => bodyOf({ ...spec, subagents: [...spec.subagents, 'fresh'] }), 'subagents["fresh"]'],
    [(spec) => withModel(bodyOf(spec), 'fresh-model'), 'definition.agent.model'],
  ];

  it('any single widening is caught at exactly that path', () => {
    fc.assert(
      fc.property(specs, fc.constantFrom(...mutators), (spec, [mutate, path]) => {
        // The creator sits at the floor of every field a mutation raises.
        const creatorSpec: Spec = {
          ...spec,
          permissions: { ...spec.permissions, runCommands: false },
          files: spec.files.map((file) =>
            file.path === 'f0' ? { ...file, access: 'read' } : file,
          ),
          limits: { maxTurns: 100, maxBudgetUsd: 100 },
        };
        expect(paths(mutate(creatorSpec), bodyOf(creatorSpec))).toEqual([path]);
      }),
      RUNS,
    );
  });

  it('is reflexive', () => {
    fc.assert(
      fc.property(specs, (spec) => {
        expect(widenings(bodyOf(spec), bodyOf(spec))).toEqual([]);
      }),
      RUNS,
    );
  });
});
