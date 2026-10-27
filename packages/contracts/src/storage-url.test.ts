import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  AZURE_CONTAINER_NAME_PATTERN,
  BUCKET_NAME_PATTERN,
  formatStorageUrl,
  parseStorageUrl,
  type StorageLocation,
} from './storage-url.js';

const CREDENTIALS = 'credentials do not belong in AW_STORAGE_URL';
const ENDPOINT = 'endpoint must be an http or https URL without credentials, query, or fragment';
const PUBLIC_ENDPOINT =
  'publicEndpoint must be an http or https URL without credentials, query, or fragment';
const NOT_A_URL = 'not a storage URL; expected scheme://…';
const FILE_SEGMENT = 'file: path has an empty, relative, or escaped segment';
const S3_BUCKET = 's3 URL must name a valid bucket';
const PREFIX_SEGMENT = 'prefix has an empty, relative, or escaped segment';
const DRIVE_PREFIX = 'prefix must not start with a drive letter';
/** An AWS-access-key-shaped ID, assembled at run time so no key-shaped literal sits in the source. */
const FAKE_KEY_ID = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const AZBLOB_CONTAINER =
  'azblob URL must be azblob://account/container[/prefix] with a valid container';
const AZBLOB_ACCOUNT = 'azblob account must be 3-24 lowercase letters or digits';

function location(raw: string): StorageLocation {
  const result = parseStorageUrl(raw);
  if (!result.ok) throw new Error(`expected ${raw} to parse: ${result.reason}`);
  return result.location;
}

function refusal(raw: string): string {
  const result = parseStorageUrl(raw);
  if (result.ok) throw new Error('expected a refusal');
  return result.reason;
}

// @story US-STO-10
describe('parseStorageUrl', () => {
  it('[US-STO-10][unit][cli] AW_STORAGE_URL with a password is refused without echoing it', () => {
    const raw = 's3://AKIA:secret@aw/prod';
    const reason = refusal(raw);
    expect(reason).toBe(CREDENTIALS);
    expect(parseStorageUrl(raw)).toMatchObject({ secret: true });
    expect(parseStorageUrl('s3://aws-bucket?sig=x')).toMatchObject({ secret: true });
    expect(parseStorageUrl('s3://aws-bucket/../x')).not.toHaveProperty('secret');
    expect(parseStorageUrl('gcs://aw-bucket?region=us-east-1')).not.toHaveProperty('secret');
    for (const leaked of ['secret', 'AKIA', raw]) expect(reason).not.toContain(leaked);
  });

  it.each([
    ['file:///var/lib/aw/objects', { kind: 'file', root: '/var/lib/aw/objects' }],
    ['file://localhost/var/lib/aw/', { kind: 'file', root: '/var/lib/aw' }],
    ['file:///', { kind: 'file', root: '/' }],
    ['file:///home/my%20dir', { kind: 'file', root: '/home/my dir' }],
    ['s3://aws-bucket', { kind: 's3', bucket: 'aws-bucket', prefix: '', forcePathStyle: false }],
    [
      'S3://aws-bucket/prod/blobs/',
      { kind: 's3', bucket: 'aws-bucket', prefix: 'prod/blobs', forcePathStyle: false },
    ],
    [
      's3://aws-bucket/prod?endpoint=https://acct.r2.cloudflarestorage.com&region=auto',
      {
        kind: 's3',
        bucket: 'aws-bucket',
        prefix: 'prod',
        endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto',
        forcePathStyle: false,
      },
    ],
    [
      's3://aws-bucket?endpoint=http://seaweed:8333&pathStyle=true',
      {
        kind: 's3',
        bucket: 'aws-bucket',
        prefix: '',
        endpoint: 'http://seaweed:8333',
        forcePathStyle: true,
      },
    ],
    [
      's3://aws-bucket?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true',
      {
        kind: 's3',
        bucket: 'aws-bucket',
        prefix: '',
        endpoint: 'http://seaweedfs:8333',
        publicEndpoint: 'http://localhost:8333',
        forcePathStyle: true,
      },
    ],
    ['gcs://gcs-bucket/a/b', { kind: 'gcs', bucket: 'gcs-bucket', prefix: 'a/b' }],
    [
      'gcs://gcs-bucket?project=my-project',
      { kind: 'gcs', bucket: 'gcs-bucket', prefix: '', projectId: 'my-project' },
    ],
    [
      'azblob://acct/objects/prod',
      {
        kind: 'azblob',
        account: 'acct',
        serviceUrl: 'https://acct.blob.core.windows.net',
        container: 'objects',
        prefix: 'prod',
      },
    ],
    [
      'azblob://devstoreaccount1/objects?endpoint=http://127.0.0.1:10000/devstoreaccount1',
      {
        kind: 'azblob',
        account: 'devstoreaccount1',
        serviceUrl: 'http://127.0.0.1:10000/devstoreaccount1',
        container: 'objects',
        prefix: '',
      },
    ],
  ] satisfies [string, StorageLocation][])(
    '[US-STO-10][unit][cli] parses file/s3/gcs/azblob: %s',
    (raw, expected) => {
      expect(location(raw)).toEqual(expected);
    },
  );

  it.each([
    's3://user@aws-bucket',
    's3://user:pass@aws-bucket/prod',
    'gcs://user:pass@gcs-bucket',
    'azblob://user:pass@acct/objects',
    'file://user:pass@localhost/var/aw',
    'ftp://user:pass@host/x',
  ])('[US-STO-10][unit][cli] refuses userinfo: %s', (raw) => {
    expect(refusal(raw)).toBe(CREDENTIALS);
  });

  it.each([
    ['s3://aws-bucket?secret=hunter2', 'an unknown query parameter is not allowed for s3:'],
    ['s3://aws-bucket?sig=hunter2', 'an unknown query parameter is not allowed for s3:'],
    [
      'azblob://acct/objects?sv=2022&sig=hunter2',
      'an unknown query parameter is not allowed for azblob:',
    ],
    ['gcs://gcs-bucket?region=auto', 'query parameter "region" is not allowed for gcs:'],
    [
      'gcs://gcs-bucket?publicEndpoint=http://localhost:8333',
      'query parameter "publicEndpoint" is not allowed for gcs:',
    ],
    ['s3://aws-bucket?project=p', 'query parameter "project" is not allowed for s3:'],
    ['file:///var/aw?x=hunter2', 'an unknown query parameter is not allowed for file:'],
    ['s3://b?hunter2Pass', 'an unknown query parameter is not allowed for s3:'],
    [`s3://b?${FAKE_KEY_ID}=1`, 'an unknown query parameter is not allowed for s3:'],
  ])('[US-STO-10][unit][cli] refuses unknown query parameters: %s', (raw, expected) => {
    const reason = refusal(raw);
    expect(reason).toBe(expected);
    for (const secret of ['hunter2', FAKE_KEY_ID]) {
      expect(reason).not.toContain(secret);
    }
  });

  it.each([
    ['s3://aws-bucket?region=auto&region=eu', 'query parameter "region" appears more than once'],
    ['s3://aws-bucket?pathStyle=yes', 'pathStyle must be true or false'],
    ['s3://aws-bucket?endpoint=ftp://host', ENDPOINT],
    ['s3://aws-bucket?endpoint=https://user:hunter2@host', ENDPOINT],
    ['s3://aws-bucket?endpoint=https://host/x?sig=hunter2', ENDPOINT],
    ['s3://aws-bucket?publicEndpoint=ftp://host', PUBLIC_ENDPOINT],
    ['s3://aws-bucket?publicEndpoint=https://user:hunter2@host', PUBLIC_ENDPOINT],
    ['s3://aws-bucket?publicEndpoint=https://host/x?sig=hunter2', PUBLIC_ENDPOINT],
    ['s3://aws-bucket?region=a%20b', 'region is not valid'],
  ])('[US-STO-10][unit][cli] refuses invalid query values: %s', (raw, expected) => {
    const reason = refusal(raw);
    expect(reason).toBe(expected);
    expect(reason).not.toContain('hunter2');
  });

  // Customer storage connections share this parser, and a connection must never create a bucket:
  // bucket creation is the platform's own `AW_STORAGE_CREATE_BUCKET`, never a URL parameter.
  it.each(['createBucket=true', 'createBucketIfMissing=true', 'AW_STORAGE_CREATE_BUCKET=true'])(
    '[US-STO-10][unit][cli] a storage URL cannot ask for its bucket to be created: %s',
    (query) => {
      expect(refusal(`s3://aws-bucket?${query}`)).toBe(
        'an unknown query parameter is not allowed for s3:',
      );
    },
  );

  it('[US-STO-10][unit][cli] names a refused parameter only when the allow-list lists it', () => {
    expect(refusal('azblob://acct/objects?region=hunter2')).toBe(
      'query parameter "region" is not allowed for azblob:',
    );
  });

  it.each([
    ['not a url', NOT_A_URL],
    ['', NOT_A_URL],
    ['http://aws-bucket/x', 'scheme must be one of file, s3, gcs, azblob'],
    ['file:relative/path', NOT_A_URL],
    ['file:///var/../etc', FILE_SEGMENT],
    ['file://remote-host/var/aw', 'file: URLs must have an empty host'],
    ['file:///var/%2e%2e/etc', FILE_SEGMENT],
    ['file:///var/a%2fb', FILE_SEGMENT],
    ['file:///var//aw', FILE_SEGMENT],
    ['s3://Aws-Bucket', S3_BUCKET],
    ['s3://-aws-bucket', S3_BUCKET],
    ['s3://ab', S3_BUCKET],
    ['s3://aws-bucket:9000/x', S3_BUCKET],
    ['s3://', S3_BUCKET],
    ['s3://aws-bucket/a/../b', PREFIX_SEGMENT],
    ['s3://aws-bucket/./b', PREFIX_SEGMENT],
    ['s3://aws-bucket/a//b', PREFIX_SEGMENT],
    ['s3://aws-bucket/a%2fb', PREFIX_SEGMENT],
    ['s3://aws-bucket/a%2Fb', PREFIX_SEGMENT],
    ['s3://aws-bucket/a\\b', PREFIX_SEGMENT],
    ['s3://aws-bucket/C:/x', DRIVE_PREFIX],
    ['gcs://gcs-bucket/d:', DRIVE_PREFIX],
    ['azblob://acct/objects/C:/x', DRIVE_PREFIX],
    ['s3://aws-bucket/prod#frag', 'a #fragment is not allowed in a storage URL'],
    ['azblob://acct', AZBLOB_CONTAINER],
    ['azblob://acct/bad--name', AZBLOB_CONTAINER],
    ['azblob://Acct/objects', AZBLOB_ACCOUNT],
    ['azblob://ac/objects', AZBLOB_ACCOUNT],
    ['azblob://acct/objects/../x', 'path has an empty, relative, or escaped segment'],
  ])('[US-STO-10][unit][cli] refuses a malformed URL without echoing it: %s', (raw, expected) => {
    const reason = refusal(raw);
    expect(reason).toBe(expected);
    if (raw !== '') expect(reason).not.toContain(raw);
    expect(reason).not.toMatch(/hunter2|Aws-Bucket|remote-host/u);
  });

  it('[US-STO-10][unit][cli] file URL on Windows', () => {
    expect(location('file:///C:/aw/objects')).toEqual({ kind: 'file', root: 'C:/aw/objects' });
    expect(location('file://localhost/d:/')).toEqual({ kind: 'file', root: 'd:/' });
    expect(formatStorageUrl({ kind: 'file', root: 'C:/aw/objects' })).toBe('file:///C:/aw/objects');
  });

  it('[US-STO-10][unit][cli] shares its name patterns as unanchored, flagless fragments', () => {
    for (const pattern of [BUCKET_NAME_PATTERN, AZURE_CONTAINER_NAME_PATTERN]) {
      expect(pattern.startsWith('^')).toBe(false);
      expect(pattern.endsWith('$')).toBe(false);
    }
  });
});

const name = fc
  .stringMatching(/^[a-z0-9][a-z0-9-]{1,10}[a-z0-9]$/u)
  .filter((v) => !v.includes('--'));
const prefix = fc
  .array(fc.stringMatching(/^[A-Za-z0-9_ -][A-Za-z0-9_. -]{0,7}$/u), { maxLength: 3 })
  .map((segments) => segments.join('/'));
const endpoint = fc.constantFrom('https://acct.r2.cloudflarestorage.com', 'http://seaweed:8333/s3');
const optional = <T>(arbitrary: fc.Arbitrary<T>) => fc.option(arbitrary, { nil: undefined });

const locations: fc.Arbitrary<StorageLocation> = fc.oneof(
  fc
    .array(
      fc.stringMatching(/^[A-Za-z0-9 _%#?.-]{1,8}$/u).filter((v) => v !== '.' && v !== '..'),
      {
        maxLength: 3,
      },
    )
    .chain((segments) =>
      fc.constantFrom(
        { kind: 'file' as const, root: `/${segments.join('/')}` },
        ...(segments.length === 0
          ? []
          : [{ kind: 'file' as const, root: `C:/${segments.join('/')}` }]),
      ),
    ),
  fc
    .record({
      bucket: name,
      prefix,
      endpoint: optional(endpoint),
      publicEndpoint: optional(endpoint),
      region: optional(fc.constantFrom('auto', 'eu-west-1')),
      forcePathStyle: fc.boolean(),
    })
    .map(({ endpoint: e, publicEndpoint: p, region, ...rest }) => ({
      kind: 's3' as const,
      ...rest,
      ...(e === undefined ? {} : { endpoint: e }),
      ...(p === undefined ? {} : { publicEndpoint: p }),
      ...(region === undefined ? {} : { region }),
    })),
  fc
    .record({ bucket: name, prefix, projectId: optional(fc.constantFrom('my-project', 'a:b.c')) })
    .map(({ projectId, ...rest }) => ({
      kind: 'gcs' as const,
      ...rest,
      ...(projectId === undefined ? {} : { projectId }),
    })),
  fc
    .record({
      account: fc.stringMatching(/^[a-z0-9]{3,24}$/u),
      container: name,
      prefix,
      serviceUrl: optional(endpoint),
    })
    .map(({ account, serviceUrl, ...rest }) => ({
      kind: 'azblob' as const,
      account,
      serviceUrl: serviceUrl ?? `https://${account}.blob.core.windows.net`,
      ...rest,
    })),
);

describe('publicEndpoint', () => {
  // @story US-STO-02
  it('[US-STO-02][unit][cli] round-trips publicEndpoint and refuses a bad one by parameter name', () => {
    const raw =
      's3://aws-bucket?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333';
    expect(formatStorageUrl(location(raw))).toBe(raw);
    const reason = refusal('s3://aws-bucket?publicEndpoint=ftp://hunter2.example');
    expect(reason).toContain('publicEndpoint');
    expect(reason).not.toContain('hunter2');
  });
});

describe('formatStorageUrl', () => {
  // @story US-STO-10
  it('[US-STO-10][unit][cli] round-trips', () => {
    fc.assert(
      fc.property(locations, (original) => {
        expect(parseStorageUrl(formatStorageUrl(original))).toEqual({
          ok: true,
          location: original,
        });
      }),
    );
  });

  it('[US-STO-10][unit][cli] writes the documented forms', () => {
    expect(
      formatStorageUrl(
        location('s3://aws-bucket/prod?endpoint=https://acct.r2.cloudflarestorage.com&region=auto'),
      ),
    ).toBe('s3://aws-bucket/prod?endpoint=https://acct.r2.cloudflarestorage.com&region=auto');
    expect(formatStorageUrl(location('azblob://acct/objects/prod/'))).toBe(
      'azblob://acct/objects/prod',
    );
  });
});
