import { ApiProblemError, type StorageConnectionResource } from '@indx-workspace/sdk';
import { describe, expect, it } from 'vitest';

import {
  credentialProblem,
  EMPTY_CREDENTIALS,
  editFormValues,
  storageProblemMessage,
  updatePatch,
} from './storage-model';

const CONNECTION: StorageConnectionResource = {
  id: '3f2b6c1e-8a4d-4f0e-9b57-2d1c0a9e7b11',
  name: 'acme-data',
  provider: 's3',
  url: 's3://acme-bucket',
  allowedPrefixes: ['reports', 'signed'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('credentialProblem', () => {
  it('refuses an S3 key pair with only one half filled', () => {
    const halves = [{ accessKeyId: 'id' }, { secretAccessKey: 'secret' }];
    for (const half of halves) {
      expect(credentialProblem('s3', { ...EMPTY_CREDENTIALS, ...half })).toBe(
        'Fill both the access key ID and the secret access key, or leave both empty.',
      );
    }
  });

  it('accepts both halves, neither, or another provider', () => {
    const pair = { ...EMPTY_CREDENTIALS, accessKeyId: 'id', secretAccessKey: 'secret' };
    expect(credentialProblem('s3', pair)).toBeNull();
    expect(credentialProblem('s3', EMPTY_CREDENTIALS)).toBeNull();
    expect(credentialProblem('gcs', { ...EMPTY_CREDENTIALS, accessKeyId: 'id' })).toBeNull();
  });
});

describe('updatePatch', () => {
  it('sends nothing for an untouched form', () => {
    expect(updatePatch(CONNECTION, editFormValues(CONNECTION), undefined)).toEqual({});
  });

  it('sends only the changed fields, folders trimmed and one per line', () => {
    const values = {
      ...editFormValues(CONNECTION),
      folders: '/reports/\n\n archive ',
      writeAllowed: true,
    };
    expect(updatePatch(CONNECTION, values, undefined)).toEqual({
      allowedPrefixes: ['reports', 'archive'],
      writeAllowed: true,
    });
  });

  it('carries a new URL together with the credential it needs', () => {
    const credential = { provider: 's3', accessKeyId: 'id', secretAccessKey: 'secret' } as const;
    const values = { ...editFormValues(CONNECTION), url: ' s3://other-bucket ' };
    expect(updatePatch(CONNECTION, values, credential)).toEqual({
      url: 's3://other-bucket',
      credential,
    });
  });
});

describe('storageProblemMessage', () => {
  it('explains the two edit conflicts in fixed sentences', () => {
    const problem = (code: string) =>
      new ApiProblemError({ status: 409, problem: { code, message: 'server text' } });
    expect(storageProblemMessage(problem('storage_connection_in_use'), 'x')).toMatch(
      /Remove their storage grants first/u,
    );
    expect(storageProblemMessage(problem('storage_connection_credential_required'), 'x')).toMatch(
      /needs a new credential/u,
    );
  });
});
