import { describe, expect, it, vi } from 'vitest';

import { parseEnvironment, parseEnvLine } from './deployment.js';

const childProcess = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));

vi.mock('node:child_process', () => childProcess);

const ref = (name: string, digit: string) => `registry.example/${name}@sha256:${digit.repeat(64)}`;

describe('environment line syntax', () => {
  it('reads an `export NAME=` line under its name', () => {
    expect(parseEnvironment('export WEB_IMAGE=a\n  export\tKEY=b\nexport=c\n')).toEqual({
      WEB_IMAGE: 'a',
      KEY: 'b',
      export: 'c',
    });
    expect(parseEnvLine('export WEB_IMAGE=a  # pinned')).toEqual({
      kind: 'entry',
      prefix: 'export ',
      key: 'WEB_IMAGE',
      value: 'a',
      suffix: '  # pinned',
    });
  });

  it('keeps blank lines, comments and malformed lines apart', () => {
    expect(parseEnvLine('   ')).toEqual({ kind: 'blank' });
    expect(parseEnvLine('# WEB_IMAGE=x')).toEqual({ kind: 'blank' });
    expect(parseEnvLine('export ')).toEqual({ kind: 'invalid' });
    expect(parseEnvLine('=value')).toEqual({ kind: 'invalid' });
    expect(() => parseEnvironment('export NOVALUE\n')).toThrow('Invalid .env line 1');
    // The refusal never quotes the line: it may be a secret.
    expect(() => parseEnvironment('A=1\nANTHROPIC_API_KEY: sk-ant-secret\n')).toThrow(
      /^Invalid \.env line 2$/u,
    );
  });
});

describe('environment value quoting', () => {
  it('strips an inline comment after whitespace from an unquoted value only', () => {
    expect(
      parseEnvironment(
        [
          `WEB_IMAGE=${ref('web', 'a')} # pinned by ops`,
          'EMPTY= # nothing yet',
          'HASH=a#b',
          'QUOTED="a # b"',
          'PLAIN=value',
        ].join('\n'),
      ),
    ).toEqual({
      WEB_IMAGE: ref('web', 'a'),
      EMPTY: '',
      HASH: 'a#b',
      QUOTED: 'a # b',
      PLAIN: 'value',
    });
  });

  it('unquotes values as Compose does, and leaves unmatched quotes as written', () => {
    expect(
      parseEnvironment(
        [
          `POLICY='{"promotion":{"minEvalScore":1}}'`,
          String.raw`ESCAPED="x\"y\\z\nw"`,
          `LITERAL='a\\nb $HOME'`,
          `EMPTY_QUOTED=''`,
          `UNTERMINATED='abc`,
          `INNER_QUOTE='it's'`,
          `MIXED='a"`,
          `COMMENTED='x' # note`,
        ].join('\n'),
      ),
    ).toEqual({
      POLICY: '{"promotion":{"minEvalScore":1}}',
      ESCAPED: 'x"y\\z\nw',
      LITERAL: 'a\\nb $HOME',
      EMPTY_QUOTED: '',
      UNTERMINATED: "'abc",
      INNER_QUOTE: "'it's'",
      MIXED: `'a"`,
      // Not wholly quoted, so returned as written; Compose would give `x`. No writer emits this.
      COMMENTED: `'x' # note`,
    });
  });

  it('keeps a quoted value byte-for-byte in parseEnvLine, which writers rewrite from', () => {
    expect(parseEnvLine(`POLICY='{"a":1}'`)).toMatchObject({ key: 'POLICY', value: `'{"a":1}'` });
  });
});
