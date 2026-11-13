import { describe, expect, it } from 'vitest';

import {
  KEY,
  apply,
  freshRoot,
  modelRoute,
  modelsYaml,
} from './project-resources.fixture.test-support.js';
describe('applyProjectResources', () => {
  it('lists an unset key whose connection the runtime lacks, though another connection passes (#690)', async () => {
    const { stderr, check } = await apply({
      root: await freshRoot(),
      env: { MAIN_KEY: KEY },
      answer: modelRoute({ held: ['main'], rejected: [] }),
      yaml: modelsYaml(['main', 'fast']),
      deferModelCheck: true,
    });
    expect(check.problems.map((problem) => problem.secret)).toEqual(['FAST_KEY']);
    expect(stderr).not.toContain('FAST_KEY');
  });
  describe('reports every model problem exactly once (#690)', () => {
    interface State {
      readonly key: 'set' | 'unset';
      readonly connection: 'passing' | 'rejected' | 'not held';
    }

    const states: readonly State[] = (['set', 'unset'] as const).flatMap((key) =>
      (['passing', 'rejected', 'not held'] as const).map((connection) => ({ key, connection })),
    );

    interface Case {
      /** The declared `models`; none is the C6 `default` connection on ANTHROPIC_API_KEY. */
      readonly names: readonly string[];
      readonly states: readonly State[];
    }

    const cases: readonly Case[] = [
      ...states.map((state) => ({ names: [], states: [state] })),
      ...states.map((state) => ({ names: ['main'], states: [state] })),
      ...states.flatMap((a) => states.map((b) => ({ names: ['main', 'fast'], states: [a, b] }))),
    ];

    const connectionsOf = ({ names }: Case): readonly string[] =>
      names.length === 0 ? ['default'] : names;

    const label = (entry: Case): string =>
      connectionsOf(entry)
        .map((name, index) => {
          const state = entry.states[index];
          return `${name}: key ${state?.key ?? ''}, ${state?.connection ?? ''}`;
        })
        .join('; ');

    it.each(cases.map((entry) => [label(entry), entry] as const))('%s', async (_, entry) => {
      const connections = connectionsOf(entry);
      const secretOf = (name: string): string =>
        entry.names.length === 0 ? 'ANTHROPIC_API_KEY' : `${name.toUpperCase()}_KEY`;
      const stated = connections.map((name, index) => ({
        name,
        secret: secretOf(name),
        ...(entry.states[index] ?? { key: 'set', connection: 'passing' }),
      }));
      const env = Object.fromEntries(
        stated.filter(({ key }) => key === 'set').map(({ secret }) => [secret, KEY]),
      );
      const { stdout, stderr, check } = await apply({
        root: await freshRoot(),
        env: env,
        answer: modelRoute({
          held: stated
            .filter(({ connection }) => connection !== 'not held')
            .map(({ name }) => name),
          rejected: stated
            .filter(({ connection }) => connection === 'rejected')
            .map(({ name }) => name),
        }),
        yaml: modelsYaml(entry.names),
        deferModelCheck: true,
      });

      const expected = stated.flatMap(({ name, secret, key, connection }) => [
        ...(key === 'unset' && connection !== 'passing' ? [`unset ${secret}`] : []),
        // A key unset on a passing connection is no problem: the plan's notice alone says it.
        ...(key === 'unset' && connection === 'passing' && entry.names.length > 0
          ? [`notice ${secret}`]
          : []),
        ...(connection === 'rejected' ? [`check ${name}`] : []),
      ]);
      const reported = [
        ...check.problems.map((problem) =>
          problem.secret === undefined
            ? `check ${problem.connection ?? ''}`
            : `unset ${problem.secret}`,
        ),
        ...[...stderr.matchAll(/^notice: (\w+) is not set:/gmu)].map(
          ([, name]) => `notice ${name}`,
        ),
        ...(stderr.includes('no "default" model connection yet')
          ? ['notice ANTHROPIC_API_KEY']
          : []),
        ...[...stderr.matchAll(/^warning: model connection "(\w+)"/gmu)].map(
          ([, name]) => `check ${name}`,
        ),
      ];
      expect(reported.sort()).toEqual(expected.sort());
      expect(stdout + stderr).not.toContain(KEY);
    });
  });
});
