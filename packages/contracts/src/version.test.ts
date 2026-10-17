import { describe, expect, it } from 'vitest';

import {
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_PROBLEM_CODES,
  judgeContractsVersion,
  parseContractsVersion,
  type ContractsVersion,
} from './version.js';

function version(text: string): ContractsVersion {
  const parsed = parseContractsVersion(text);
  if (parsed === null) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('parseContractsVersion', () => {
  it('parses plain MAJOR.MINOR.PATCH, including the version of this build', () => {
    expect(parseContractsVersion('0.1.0')).toEqual({ major: 0, minor: 1, patch: 0 });
    expect(parseContractsVersion('12.34.56')).toEqual({ major: 12, minor: 34, patch: 56 });
    expect(parseContractsVersion(CONTRACTS_VERSION)).not.toBeNull();
  });

  it.each([
    '',
    '1',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.2.3-beta.1',
    '1.2.3+build',
    ' 1.2.3',
    '1.2.3 ',
    '1.-2.3',
    '1234567890.0.0',
    'latest',
  ])('refuses %j', (text) => {
    expect(parseContractsVersion(text)).toBeNull();
  });
});

describe('judgeContractsVersion', () => {
  const range = { minimum: version('1.2.0'), current: version('1.3.4') };

  it('serves every version between the minimum and the current minor, whatever the patch', () => {
    for (const text of ['1.2.0', '1.2.9', '1.3.0', '1.3.4', '1.3.99']) {
      expect(judgeContractsVersion(version(text), range)).toEqual({ kind: 'served' });
    }
  });

  it('asks an older client to upgrade', () => {
    for (const text of ['1.1.9', '0.9.0']) {
      expect(judgeContractsVersion(version(text), range)).toEqual({
        kind: 'unsupported',
        upgrade: 'client',
      });
    }
  });

  it('asks for the server to upgrade when the client is newer than it', () => {
    for (const text of ['1.4.0', '2.0.0']) {
      expect(judgeContractsVersion(version(text), range)).toEqual({
        kind: 'unsupported',
        upgrade: 'server',
      });
    }
  });

  it('pins the negotiation problem codes to their statuses', () => {
    expect(CONTRACTS_VERSION_PROBLEM_CODES).toEqual({
      contracts_version_unsupported: 426,
      contracts_version_malformed: 400,
    });
  });
});
