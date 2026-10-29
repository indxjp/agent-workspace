import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentDefinitionResourcesSchema } from './agents/definition.js';
import { UUID_PATTERN } from './identifiers.js';
import {
  CreateStorageConnectionInputSchema,
  parseStorageGrantPath,
  STORAGE_CONNECTION_PROBLEM_CODES,
  StorageConnectionCredentialSchema,
  StorageConnectionResourceSchema,
  UpdateStorageConnectionPatchSchema,
} from './storage-connections.js';

/** An AWS-access-key-shaped ID, assembled at run time so no key-shaped literal sits in the source. */
const FAKE_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const FAKE_SECRET = ['fake', 'secret', '0123456789'].join('-');

const body = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  name: 'acme-data',
  url: 's3://bucket-a/reports',
  allowedPrefixes: ['reports'],
  ...overrides,
});

function refusals(overrides: Record<string, unknown>): string[] {
  const result = CreateStorageConnectionInputSchema.safeParse(body(overrides));
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const resource = {
  id: '6f1c1f7e-8c1f-4f5e-9d0e-1a2b3c4d5e6f',
  name: 'acme-data',
  provider: 's3',
  url: 's3://bucket-a/reports',
  allowedPrefixes: ['reports'],
  writeAllowed: false,
  hasCredential: true,
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
};

// @story US-STO-12
describe('storage connection contract', () => {
  it('[US-STO-12][contract][sdk] a connection URL never carries a secret', () => {
    const urls = [
      `s3://${FAKE_KEY_ID}:${FAKE_SECRET}@bucket-a/reports`,
      `s3://bucket-a/reports?X-Amz-Signature=${FAKE_SECRET}`,
      `azblob://acme/data?sig=${FAKE_SECRET}`,
    ];
    for (const url of urls) {
      const messages = refusals({ url });
      expect(messages).toEqual(['storage_connection_url_has_secret']);
      for (const leaked of [FAKE_SECRET, FAKE_KEY_ID, url]) {
        expect(messages.join()).not.toContain(leaked);
      }
    }
    expect(refusals({ url: 'not a url' })).toEqual(['storage_connection_url_invalid']);
    expect(refusals({ url: 'gcs://bucket-a/reports?region=us-east-1' })).toEqual([
      'storage_connection_url_invalid',
    ]);
    expect(refusals({ url: 's3://bucket-a/reports' })).toEqual([]);
    expect(CreateStorageConnectionInputSchema.parse(body({})).writeAllowed).toBe(false);
  });

  it('[US-STO-12][contract][sdk] a connection name is never shaped like an id', () => {
    const id = 'abcdef12-3456-4789-8abc-def012345678';
    expect(CreateStorageConnectionInputSchema.safeParse(body({ name: id })).success).toBe(false);
    expect(UpdateStorageConnectionPatchSchema.safeParse({ name: id }).success).toBe(false);
  });

  it('[US-STO-12][contract][sdk] credentials are provider-shaped', () => {
    const credentials = {
      s3: { provider: 's3', accessKeyId: FAKE_KEY_ID, secretAccessKey: FAKE_SECRET },
      gcs: {
        provider: 'gcs',
        serviceAccountJson: JSON.stringify({ type: 'service_account', private_key: FAKE_SECRET }),
      },
      azblobKey: { provider: 'azblob', accountKey: FAKE_SECRET },
      azblobSas: { provider: 'azblob', sasToken: FAKE_SECRET },
      file: { provider: 'file' },
    };
    const urls = {
      s3: 's3://bucket-a/reports',
      gcs: 'gcs://bucket-a/reports',
      azblob: 'azblob://acme/data',
      file: 'file:///srv/aw/data',
    };
    expect(refusals({ url: urls.s3, credential: credentials.s3 })).toEqual([]);
    expect(refusals({ url: urls.gcs, credential: credentials.gcs })).toEqual([]);
    expect(refusals({ url: urls.azblob, credential: credentials.azblobKey })).toEqual([]);
    expect(refusals({ url: urls.azblob, credential: credentials.azblobSas })).toEqual([]);
    expect(refusals({ url: urls.file, credential: credentials.file })).toEqual([]);
    expect(refusals({ url: urls.gcs, credential: credentials.s3 })).toEqual([
      'storage_connection_url_invalid',
    ]);
    expect(refusals({ url: urls.file, credential: credentials.azblobKey })).not.toEqual([]);
    expect(refusals({ credential: { ...credentials.s3, sessionToken: FAKE_SECRET } })).toEqual([]);
    expect(refusals({ credential: { ...credentials.s3, sessionToken: '' } })).not.toEqual([]);
    expect(
      refusals({
        url: urls.azblob,
        credential: { ...credentials.azblobSas, sessionToken: FAKE_SECRET },
      }),
    ).not.toEqual([]);
    expect(refusals({ credential: { ...credentials.s3, sasToken: FAKE_SECRET } })).not.toEqual([]);
    expect(refusals({ credential: { provider: 's3', accessKeyId: FAKE_KEY_ID } })).not.toEqual([]);
  });

  it('[US-STO-12][contract][sdk] a GCS connection takes a short-lived access token, never external_account JSON', () => {
    const token = ['ya29', 'contract-token-0123456789'].join('');
    const withProject = 'gcs://bucket-a/reports?project=acme-prod';
    const accessToken = { provider: 'gcs', accessToken: token };
    expect(refusals({ url: withProject, credential: accessToken })).toEqual([]);
    expect(
      refusals({ url: withProject, credential: { ...accessToken, accessToken: '' } }),
    ).not.toEqual([]);
    expect(
      refusals({ url: withProject, credential: { ...accessToken, serviceAccountJson: '{}' } }),
    ).not.toEqual([]);
    expect(refusals({ url: 'gcs://bucket-a/reports', credential: accessToken })).toEqual([
      'storage_connection_url_invalid',
    ]);

    const externalAccount = JSON.stringify({
      type: 'external_account',
      credential_source: { file: '/etc/passwd' },
    });
    const keyJson = (type?: string): string =>
      JSON.stringify({ ...(type === undefined ? {} : { type }), client_email: 'a@b.c' });
    const refused = ['storage_connection_url_invalid'];
    expect(
      refusals({
        url: withProject,
        credential: { provider: 'gcs', serviceAccountJson: externalAccount },
      }),
    ).toEqual(refused);
    const patched = UpdateStorageConnectionPatchSchema.safeParse({
      credential: { provider: 'gcs', serviceAccountJson: externalAccount },
    });
    expect(patched.success ? [] : patched.error.issues.map((issue) => issue.message)).toEqual(
      refused,
    );
    const rotated = StorageConnectionCredentialSchema.safeParse({
      provider: 'gcs',
      serviceAccountJson: keyJson('authorized_user'),
    });
    expect(rotated.success ? [] : rotated.error.issues.map((issue) => issue.message)).toEqual(
      refused,
    );
    expect(
      StorageConnectionCredentialSchema.safeParse({
        provider: 'gcs',
        serviceAccountJson: keyJson('service_account'),
      }).success,
    ).toBe(true);
    // An untyped key is refused too (owner decision, #1835): only a key that says what it is.
    const untyped = StorageConnectionCredentialSchema.safeParse({
      provider: 'gcs',
      serviceAccountJson: keyJson(),
    });
    expect(untyped.success ? [] : untyped.error.issues.map((issue) => issue.message)).toEqual(
      refused,
    );
    expect(refusals({ url: withProject, credential: accessToken }).join()).not.toContain(token);
  });

  it('[US-STO-12][contract][sdk] storage:// grant paths parse and refuse traversal', () => {
    expect(parseStorageGrantPath('storage://acme-data/reports/2026')).toEqual({
      connection: 'acme-data',
      prefix: 'reports/2026',
    });
    for (const plain of ['reports/2026', '/storage://acme-data/x', 'storage:/acme-data/x']) {
      expect(parseStorageGrantPath(plain)).toBeNull();
    }
    for (const refused of [
      'storage://',
      'storage://acme-data',
      'storage://acme-data/',
      'storage:///reports',
      'storage://Acme/reports',
      'storage://acme-data//reports',
      'storage://acme-data/reports/',
      'storage://acme-data/\\reports',
      // A connection is addressed by name, never by id, whichever character the id starts with.
      'storage://abcdef12-3456-4789-8abc-def012345678/reports',
      'storage://12345678-9abc-4def-8012-3456789abcde/reports',
    ]) {
      expect(parseStorageGrantPath(refused)).toBeNull();
    }

    const connection = fc
      .stringMatching(/^[a-z][a-z0-9-]{0,62}$/u)
      .filter((name) => !UUID_PATTERN.test(name));
    const segment = fc
      .stringMatching(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,15}$/u)
      .filter((value) => value !== '.' && value !== '..');
    const folder = fc.array(segment, { minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(connection, folder, (name, segments) => {
        const prefix = segments.join('/');
        expect(parseStorageGrantPath(`storage://${name}/${prefix}`)).toEqual({
          connection: name,
          prefix,
        });
      }),
    );
    fc.assert(
      fc.property(connection, folder, fc.nat(), (name, segments, at) => {
        const index = at % (segments.length + 1);
        const withDots = (dots: string): string =>
          [...segments.slice(0, index), dots, ...segments.slice(index)].join('/');
        for (const dots of ['..', '.', '']) {
          expect(parseStorageGrantPath(`storage://${name}/${withDots(dots)}`)).toBeNull();
        }
        expect(parseStorageGrantPath(`storage://${name}//${segments.join('/')}`)).toBeNull();
        expect(parseStorageGrantPath(`storage://${name}/../${segments.join('/')}`)).toBeNull();
      }),
    );
    fc.assert(
      fc.property(folder, (segments) => {
        expect(parseStorageGrantPath(`storage:///${segments.join('/')}`)).toBeNull();
      }),
    );
  });

  it('[US-STO-12][contract][sdk] an agent definition accepts a storage:// grant only when it parses', () => {
    const files = (path: string) => ({
      files: [{ path, access: 'read' }],
      skills: [],
      connectors: [],
    });
    expect(
      AgentDefinitionResourcesSchema.safeParse(files('storage://acme-data/reports/2026')).success,
    ).toBe(true);
    expect(AgentDefinitionResourcesSchema.safeParse(files('reports/2026')).success).toBe(true);
    for (const path of ['storage://acme-data/../x', 'storage://acme-data', 'storage:///x']) {
      expect(AgentDefinitionResourcesSchema.safeParse(files(path)).success).toBe(false);
    }
  });

  it('[US-STO-12][contract][sdk] a resource never carries a credential', () => {
    expect(StorageConnectionResourceSchema.safeParse(resource).success).toBe(true);
    expect(
      StorageConnectionResourceSchema.safeParse({ ...resource, secretAccessKey: FAKE_SECRET })
        .success,
    ).toBe(false);
    expect(
      StorageConnectionResourceSchema.safeParse({ ...resource, allowedPrefixes: [] }).success,
    ).toBe(false);
  });

  // #1835: a response's `url` is parsed again, so a reader never trusts an unchecked URL.
  it('[US-STO-12][contract][sdk] a resource url is a storage URL of its own provider', () => {
    for (const url of ['ftp://bucket-a/reports', 'not a url', 'gcs://bucket-a/reports']) {
      const parsed = StorageConnectionResourceSchema.safeParse({ ...resource, url });
      expect(parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)).toEqual([
        'storage_connection_url_invalid',
      ]);
    }
    const withSecret = StorageConnectionResourceSchema.safeParse({
      ...resource,
      url: `s3://bucket-a/reports?k=${FAKE_SECRET}`,
    });
    expect(withSecret.success ? [] : withSecret.error.issues.map((issue) => issue.message)).toEqual(
      ['storage_connection_url_has_secret'],
    );
  });

  it('[US-STO-12][contract][sdk] a patch changes the name, URL, prefixes or write flag', () => {
    expect(UpdateStorageConnectionPatchSchema.safeParse({ writeAllowed: true }).success).toBe(true);
    expect(UpdateStorageConnectionPatchSchema.safeParse({}).success).toBe(false);
    expect(
      UpdateStorageConnectionPatchSchema.safeParse({ name: 'renamed', url: 's3://other/x' })
        .success,
    ).toBe(true);
    expect(UpdateStorageConnectionPatchSchema.safeParse({ url: 'nonsense' }).success).toBe(false);
    const leaky = UpdateStorageConnectionPatchSchema.safeParse({ url: 's3://key@host/x' });
    expect(leaky.error?.issues.map((issue) => issue.message)).toContain(
      'storage_connection_url_has_secret',
    );
    expect(UpdateStorageConnectionPatchSchema.safeParse({ credential: {} }).success).toBe(false);
    expect(
      UpdateStorageConnectionPatchSchema.safeParse({ allowedPrefixes: ['a/../b'] }).success,
    ).toBe(false);
  });

  it('[US-STO-12][contract][sdk] the problem codes keep their statuses', () => {
    expect(STORAGE_CONNECTION_PROBLEM_CODES).toEqual({
      storage_connection_not_found: 404,
      storage_connection_name_taken: 409,
      storage_connection_credential_required: 409,
      storage_connection_in_use: 409,
      storage_connection_url_invalid: 422,
      storage_connection_url_has_secret: 422,
      storage_connection_endpoint_forbidden: 422,
      storage_connection_prefix_not_allowed: 403,
      storage_connection_write_not_allowed: 403,
      storage_connection_unreachable: 502,
    });
  });
});
