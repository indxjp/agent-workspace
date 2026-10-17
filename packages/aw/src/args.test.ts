import { describe, expect, it } from 'vitest';

import { API_KEY_FLAG_REFUSED, parseArguments } from './args.js';
import { UsageError } from './io.js';

describe('parseArguments', () => {
  it('separates the command words from value flags and switches', () => {
    const parsed = parseArguments([
      'agents',
      'update',
      'id-1',
      '--name',
      'Bot',
      '--json',
      '--file=-',
    ]);
    expect(parsed.positionals).toEqual(['agents', 'update', 'id-1']);
    expect(parsed.values.get('name')).toBe('Bot');
    expect(parsed.values.get('file')).toBe('-');
    expect(parsed.switches.has('json')).toBe(true);
  });

  it('refuses a key as a flag value, in both spellings', () => {
    expect(() => parseArguments(['workspaces', 'list', '--api-key', 'ak_live_x'])).toThrow(
      API_KEY_FLAG_REFUSED,
    );
    expect(() => parseArguments(['workspaces', 'list', '--api-key=ak_live_x'])).toThrow(
      API_KEY_FLAG_REFUSED,
    );
  });

  it('accepts --api-key-stdin as the switch it is', () => {
    expect(
      parseArguments(['--api-key-stdin', 'agents', 'list']).switches.has('api-key-stdin'),
    ).toBe(true);
  });

  it('refuses an unknown flag, a repeated flag, a switch with a value and a value flag without one', () => {
    expect(() => parseArguments(['--unknown'])).toThrow(UsageError);
    expect(() => parseArguments(['--name', 'a', '--name', 'b'])).toThrow('more than once');
    expect(() => parseArguments(['--json=yes'])).toThrow('takes no value');
    expect(() => parseArguments(['--name'])).toThrow('needs a value');
    expect(() => parseArguments(['--name', '--json'])).toThrow('needs a value');
  });

  it('treats a bare dash as a value and -- as the end of flags', () => {
    const parsed = parseArguments(['secrets', 'create', '--file', '-', '--', '--not-a-flag']);
    expect(parsed.values.get('file')).toBe('-');
    expect(parsed.positionals).toEqual(['secrets', 'create', '--not-a-flag']);
  });

  it('reads -h as --help', () => {
    expect(parseArguments(['-h']).switches.has('help')).toBe(true);
  });

  it('reads --yes as a switch and refuses a value for it (issue #451)', () => {
    const parsed = parseArguments(['init', '--yes']);
    expect(parsed.switches.has('yes')).toBe(true);
    expect(parsed.positionals).toEqual(['init']);
    expect(() => parseArguments(['init', '--yes=true'])).toThrow('--yes takes no value');
  });

  it('reads the aw platforms flags (ADR-0133)', () => {
    const parsed = parseArguments([
      'platforms',
      'export',
      '--platform',
      'eject-mastra',
      '--out=dist',
      '--from',
      'x',
      '--strict',
    ]);
    expect(parsed.values.get('platform')).toBe('eject-mastra');
    expect(parsed.values.get('out')).toBe('dist');
    expect(parsed.values.get('from')).toBe('x');
    expect(parsed.switches.has('strict')).toBe(true);
    expect(() => parseArguments(['--strict=yes'])).toThrow('--strict takes no value');
  });

  describe('repeatable value flags (S-13/K-2, issue #234)', () => {
    it('accepts a repeated --skill, in the order given', () => {
      const parsed = parseArguments([
        'agents',
        'create',
        '--skill',
        's1',
        '--skill',
        's2',
        '--skill=s3',
      ]);
      expect(parsed.repeatableValues.get('skill')).toEqual(['s1', 's2', 's3']);
    });

    it('keeps each repeatable flag on its own key, and never touches an unrepeated one', () => {
      const parsed = parseArguments(['agents', 'create', '--skill', 's1', '--connector', 'c1']);
      expect(parsed.repeatableValues.get('skill')).toEqual(['s1']);
      expect(parsed.repeatableValues.get('connector')).toEqual(['c1']);
      expect(parsed.repeatableValues.has('grant-file')).toBe(false);
    });

    it('accepts a repeated --grant-file', () => {
      const parsed = parseArguments([
        'agents',
        'create',
        '--grant-file',
        'f1:read',
        '--grant-file',
        'f2:read-write',
      ]);
      expect(parsed.repeatableValues.get('grant-file')).toEqual(['f1:read', 'f2:read-write']);
    });

    it('still refuses a repeated single-value flag, unaffected by the repeatable table', () => {
      expect(() =>
        parseArguments(['agents', 'update', 'id-1', '--name', 'a', '--name', 'b']),
      ).toThrow('more than once');
    });

    it('collects repeated --agent and --tool occurrences (issue #949)', () => {
      const parsed = parseArguments([
        'endpoint-clients',
        'create',
        '--agent',
        'a',
        '--agent',
        'b',
        '--tool',
        't1',
        '--tool',
        't2',
      ]);
      expect(parsed.repeatableValues.get('agent')).toEqual(['a', 'b']);
      expect(parsed.repeatableValues.get('tool')).toEqual(['t1', 't2']);
    });

    it('needs a value, the same as an ordinary value flag', () => {
      expect(() => parseArguments(['agents', 'create', '--skill'])).toThrow('needs a value');
    });
  });
});
