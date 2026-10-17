import { describe, expect, it } from 'vitest';

import {
  isReservedSecretName,
  RESERVED_SECRET_NAME_PREFIX,
  RESERVED_SECRET_NAMES,
  SecretNameSchema,
  SecretReferenceSchema,
} from './secret-reference.js';
import { SECRET_NAME_MAX_LENGTH, SECRET_NAME_PATTERN } from './secrets.js';

const PASTED_KEY = 'sk-live-0123456789abcdefSECRETVALUE';

describe('SecretReferenceSchema (C10, issue #524)', () => {
  it('accepts { secret: NAME } and freezes it', () => {
    const parsed = SecretReferenceSchema.parse({ secret: 'ANTHROPIC_API_KEY' });
    expect(parsed).toEqual({ secret: 'ANTHROPIC_API_KEY' });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('accepts a name at the length bound and refuses one past it', () => {
    const atBound = `A${'B'.repeat(SECRET_NAME_MAX_LENGTH - 1)}`;
    expect(SecretReferenceSchema.safeParse({ secret: atBound }).success).toBe(true);
    const result = SecretReferenceSchema.safeParse({ secret: `${atBound}C` });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['secret']]);
  });

  it('refuses a lower-case name at secret', () => {
    const result = SecretReferenceSchema.safeParse({ secret: 'anthropic_api_key' });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['secret']]);
  });

  it('refuses an extra key, so no value can ride along', () => {
    const result = SecretReferenceSchema.safeParse({ secret: 'TOKEN', value: PASTED_KEY });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(JSON.stringify(result.error?.issues)).not.toContain(PASTED_KEY);
  });

  it('refuses a string where a reference belongs, at its path, without echoing it', () => {
    const result = SecretReferenceSchema.safeParse(PASTED_KEY);
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.map((issue) => issue.path)).toEqual([[]]);
    expect(issues[0]?.message).toBe('must be a secret reference { secret: NAME }, never the value');
    expect(result.error?.message).not.toContain(PASTED_KEY);
    for (const issue of issues) expect(issue.message).not.toContain(PASTED_KEY);
  });

  it('refuses a pasted value in secret without echoing it', () => {
    const result = SecretReferenceSchema.safeParse({ secret: PASTED_KEY });
    expect(result.success).toBe(false);
    expect(result.error?.message).not.toContain(PASTED_KEY);
  });
});

function reservedMessage(upper: string): string {
  return `${upper} is a variable the local runtime uses; name the secret something else`;
}

/** Each issue as `[path, message]`. */
function issuesOf(input: unknown): [PropertyKey[], string][] {
  const result = SecretReferenceSchema.safeParse(input);
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).map((issue) => [[...issue.path], issue.message]);
}

function mixedCase(name: string): string {
  return [...name]
    .map((char, index) => (index % 2 === 0 ? char.toLowerCase() : char.toUpperCase()))
    .join('');
}

describe('reserved secret names (ADR-0109 slice-2 amendment, issue #564)', () => {
  it.each([
    ['PATH', 'PATH'],
    ['path', 'PATH'],
    ['port', 'PORT'],
    ['Aw_X', 'AW_X'],
    ['AW_ANYTHING', 'AW_ANYTHING'],
    ['NODE_OPTIONS', 'NODE_OPTIONS'],
    ['tmpdir', 'TMPDIR'],
    ['database_url', 'DATABASE_URL'],
  ])('refuses %s at secret, naming it upper-cased', (name, upper) => {
    expect(issuesOf({ secret: name })).toEqual([[['secret'], reservedMessage(upper)]]);
  });

  it('lists upper-case names that match the secret grammar, with no repeat', () => {
    expect(new Set(RESERVED_SECRET_NAMES).size).toBe(RESERVED_SECRET_NAMES.length);
    expect(Object.isFrozen(RESERVED_SECRET_NAMES)).toBe(true);
    for (const name of RESERVED_SECRET_NAMES) expect(name).toMatch(SECRET_NAME_PATTERN);
    expect(RESERVED_SECRET_NAME_PREFIX).toBe('AW_');
  });

  it.each(RESERVED_SECRET_NAMES)('refuses %s in upper, lower and mixed case', (name) => {
    for (const spelling of [name, name.toLowerCase(), mixedCase(name)]) {
      expect(issuesOf({ secret: spelling })).toEqual([[['secret'], reservedMessage(name)]]);
      expect(isReservedSecretName(spelling)).toBe(true);
    }
  });

  it.each(['GITHUB_TOKEN', 'AWS_KEY', 'AW', 'PATHS', 'MY_PATH', 'HOSTNAME'])(
    'accepts %s, which is not reserved',
    (name) => {
      expect(SecretReferenceSchema.parse({ secret: name })).toEqual({ secret: name });
      expect(isReservedSecretName(name)).toBe(false);
    },
  );

  it('keeps the grammar message for a lower-case name that is not reserved', () => {
    expect(issuesOf({ secret: 'github_token' })).toEqual([
      [['secret'], 'must be a secret name: A-Z first, then A-Z, 0-9 or _, at most 128 characters'],
    ]);
  });

  it.each([
    ['a dotless i (U+0131)', 'paıh'],
    ['a long s (U+017F)', 'hoſe'],
    ['a hyphen', 'aw-x'],
    ['a leading digit', '1PATH'],
    ['a leading underscore', '_AW_X'],
    ['an empty name', ''],
    ['an AW_ name past the length bound', `AW_${'X'.repeat(SECRET_NAME_MAX_LENGTH)}`],
  ])('isReservedSecretName is false for %s', (_name, input) => {
    expect(isReservedSecretName(input)).toBe(false);
  });

  it('is true for an AW_ name at the length bound', () => {
    expect(isReservedSecretName(`AW_${'X'.repeat(SECRET_NAME_MAX_LENGTH - 3)}`)).toBe(true);
  });

  it('refuses a non-ASCII spelling with the grammar message, never the reserved one', () => {
    const [[path, message] = [[], '']] = issuesOf({ secret: 'paıh' });
    expect(path).toEqual(['secret']);
    expect(message).not.toContain('local runtime');
  });

  it('refuses a pasted aw_ key without echoing it', () => {
    const pasted = 'aw_live-0123456789abcdefSECRET';
    const result = SecretReferenceSchema.safeParse({ secret: pasted });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['secret']]);
    expect(result.error?.message).not.toContain(pasted);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.message).not.toContain(pasted);
      expect(issue.message.toUpperCase()).not.toContain(pasted.toUpperCase());
    }
  });

  it('refuses an over-length AW_ name with the length message, never naming it', () => {
    const long = `AW_${'X'.repeat(SECRET_NAME_MAX_LENGTH)}`;
    expect(issuesOf({ secret: long })).toEqual([[['secret'], 'must be a secret name']]);
  });

  it('exports SecretNameSchema, the name alone', () => {
    expect(SecretNameSchema.parse('GITHUB_TOKEN')).toBe('GITHUB_TOKEN');
    expect(SecretNameSchema.safeParse('home').error?.issues[0]?.message).toBe(
      reservedMessage('HOME'),
    );
    expect(SecretNameSchema.safeParse(42).error?.issues[0]?.message).toBe('must be a secret name');
  });
});
