import { describe, expect, it } from 'vitest';
import { parseCreateArguments } from './create.js';
import './create-test-fixtures.test-support.js';

export function describeCreateArguments(): void {
  describe('parseCreateArguments', () => {
    // S1-16: with no --cloud, create writes the v2 project `aw dev` runs.
    it('defaults to the v2 project, with or without --yes', () => {
      expect(parseCreateArguments([])).toEqual({
        kind: 'project',
        target: 'my-agent',
        yes: false,
        answers: {},
        named: false,
        install: undefined,
        start: undefined,
      });
      expect(parseCreateArguments(['acme-ai'])).toEqual({
        kind: 'project',
        target: 'acme-ai',
        yes: false,
        answers: {},
        named: true,
        install: undefined,
        start: undefined,
      });
      expect(parseCreateArguments(['--yes', 'acme-ai'])).toEqual({
        kind: 'project',
        target: 'acme-ai',
        yes: true,
        answers: {},
        named: true,
        install: undefined,
        start: undefined,
      });
    });

    it('reads a flag for every setup question, and --help', () => {
      expect(
        parseCreateArguments([
          'acme',
          '--provider',
          'openai',
          '--color=#0f6b77',
          '--tools',
          'postgres',
        ]),
      ).toEqual({
        kind: 'project',
        target: 'acme',
        yes: false,
        answers: {
          'admin.modelProvider': 'openai',
          'embedder.brandColour': '#0f6b77',
          'content.internalTools': ['postgres'],
        },
        named: true,
        install: undefined,
        start: undefined,
      });
      expect(parseCreateArguments(['--help'])).toEqual({ kind: 'help' });
      expect(() => parseCreateArguments(['acme', '--color', 'teal'])).toThrow(
        /^--color: "teal" is not accepted: a hex colour/u,
      );
      expect(() => parseCreateArguments(['acme', '--cloud', 'aws', '--theme', 'blank'])).toThrow(
        /setup flags/u,
      );
    });

    it('accepts every cloud, in either argument order, with --validate', () => {
      for (const cloud of ['aws', 'gcp', 'azure', 'local'] as const) {
        expect(parseCreateArguments(['acme', '--cloud', cloud])).toEqual({
          kind: 'deployment',
          target: 'acme',
          cloud,
          validate: false,
          yes: false,
          generator: {},
        });
        expect(parseCreateArguments(['--cloud', cloud, '--validate', 'acme'])).toEqual({
          kind: 'deployment',
          target: 'acme',
          cloud,
          validate: true,
          yes: false,
          generator: {},
        });
      }
    });

    // Roadmap §5: no option is accepted and then ignored.
    it('refuses the options a cloud would ignore, and --validate without one', () => {
      expect(() => parseCreateArguments(['acme', '--cloud', 'aws', '--yes'])).toThrow(
        /--yes answers questions; --cloud aws asks no setup questions/u,
      );
      expect(() => parseCreateArguments(['--yes', 'acme', '--cloud', 'gcp'])).toThrow(/--yes/u);
      expect(() => parseCreateArguments(['acme', '--cloud', 'local', '--theme', 'blank'])).toThrow(
        /--database, --storage, --runtime and --auth, or take the defaults with --yes/u,
      );
      expect(() =>
        parseCreateArguments(['acme', '--cloud', 'local', '--answers', 'answers.yaml']),
      ).toThrow(/setup flags and --answers/u);
      expect(() => parseCreateArguments(['acme', '--cloud', 'gcp', '--storage', 'x'])).toThrow(
        /--database, --storage, --runtime and --auth answer the questions of --cloud local; --cloud gcp asks none/u,
      );
      expect(() => parseCreateArguments(['acme', '--auth', 'local'])).toThrow(
        /pass them with --cloud local/u,
      );
      expect(() => parseCreateArguments(['acme', '--validate'])).toThrow(
        /--validate .*pass it with --cloud/u,
      );
    });

    it('reads --yes and the four generator flags with --cloud local, and --answers without a cloud', () => {
      expect(
        parseCreateArguments([
          'acme',
          '--cloud',
          'local',
          '--yes',
          '--database',
          'postgres',
          '--storage=SeaweedFS',
          '--runtime',
          'docker',
          '--auth',
          'local',
        ]),
      ).toEqual({
        kind: 'deployment',
        target: 'acme',
        cloud: 'local',
        validate: false,
        yes: true,
        generator: {
          database: 'postgres',
          storage: 'SeaweedFS',
          runtime: 'docker',
          authentication: 'local',
        },
      });
      expect(parseCreateArguments(['acme', '--answers=a.yaml'])).toMatchObject({
        kind: 'project',
        answersFile: 'a.yaml',
      });
    });

    it('reads --template from its closed list, and refuses an unknown one or one with --cloud (#1510, #1511)', () => {
      for (const template of ['portal', 'chat', 'wiki', 'crm', 'desk']) {
        expect(parseCreateArguments(['acme', '--template', template])).toMatchObject({
          kind: 'project',
          template,
        });
      }
      expect(parseCreateArguments(['acme'])).toMatchObject({
        kind: 'project',
        template: undefined,
      });
      expect(() => parseCreateArguments(['acme', '--template', 'helpdesk'])).toThrow(
        'Unknown --template "helpdesk". Choose one of portal, chat, wiki, crm, desk.',
      );
      expect(() => parseCreateArguments(['acme', '--template'])).toThrow(
        '--template needs a value.',
      );
      expect(() =>
        parseCreateArguments(['acme', '--template', 'portal', '--cloud', 'aws']),
      ).toThrow('--template writes an app over the project create writes without --cloud');
    });

    it('reads --port with --cloud local alone, as a port number (BH061-069)', () => {
      expect(parseCreateArguments(['acme', '--cloud', 'local', '--port', '3417'])).toMatchObject({
        kind: 'deployment',
        port: 3417,
      });
      expect(parseCreateArguments(['acme', '--cloud', 'local'])).not.toHaveProperty('port');
      for (const value of ['0', '65536', '3000x', '-1', '03000']) {
        expect(() => parseCreateArguments(['acme', '--cloud', 'local', `--port=${value}`])).toThrow(
          /is not a port/u,
        );
      }
      for (const argv of [
        ['acme', '--port', '3417'],
        ['acme', '--cloud', 'gcp', '--port', '3417'],
      ]) {
        expect(() => parseCreateArguments(argv)).toThrow(/pass it with --cloud local/u);
      }
    });

    // Silently dropping `--clod gcp` would build a Compose project for an operator who asked for a
    // cloud one, so an unrecognised option is a refusal rather than a default.
    it.each([
      [['acme', '--clod', 'gcp'], /Unknown option/u],
      [['acme', '-c', 'gcp'], /Unknown option/u],
      [['acme', '--cloud'], /--cloud needs a value/u],
      [['acme', '--cloud', '--validate'], /--cloud needs a value/u],
      [['acme', '--yes=false'], /--yes takes no value/u],
      [['acme', '--cloud', 'digitalocean'], /Unsupported --cloud/u],
      [['acme', 'extra'], /Unexpected extra argument/u],
      [['acme', '-y'], /Unknown option/u],
    ])('refuses %j', (argv, expected) => {
      expect(() => parseCreateArguments(argv)).toThrow(expected);
    });
  });
}
