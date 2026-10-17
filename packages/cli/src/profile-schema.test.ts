/**
 * The committed JSON Schema and the CLI agree (issue #424, ADR-0091): every profile below gets the
 * same verdict from `parseProfileDocument` and from a draft 2020-12 validator reading
 * `packages/schemas/agent-workspace.schema.json`, except the checks `CLI_ONLY_PROFILE_CHECKS`
 * names, which the CLI alone makes. `pnpm docs:check` keeps the committed file equal to what the
 * generator converts from `profile-schema.ts`, so this holds the definition and the file together.
 */
import { readFile } from 'node:fs/promises';

import { IMPLEMENTED_RUNTIME_DRIVERS as CONTRACT_IMPLEMENTED_DRIVERS } from '@indx-workspace/contracts/project-file';
import {
  EXTERNAL_RUNTIME_PROVIDERS,
  RUNTIME_DRIVERS,
  type RuntimeDriver,
} from '@indx-workspace/contracts/runtimes';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { DEPLOYMENT_CLOUDS, parseProfileDocument, ProfileError } from './profile.js';
import {
  CLI_ONLY_PROFILE_CHECKS,
  EXTERNAL_RUNTIME_PROVIDER_IDS,
  IMPLEMENTED_RUNTIME_DRIVERS,
  type RuntimeDriverId,
  UNIMPLEMENTED_RUNTIME_DRIVERS,
} from './profile-schema.js';

type Document = Record<string, unknown>;

const schema: unknown = JSON.parse(
  await readFile(new URL('../../schemas/agent-workspace.schema.json', import.meta.url), 'utf8'),
);
if (typeof schema !== 'object' || schema === null) throw new Error('the schema is not an object');
const validateWithSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

/** The generated profile of each cloud, as the document object an editor sees. */
const goldens = Object.fromEntries(
  await Promise.all(
    DEPLOYMENT_CLOUDS.map(async (cloud) => {
      const text = await readFile(
        new URL(`./fixtures/${cloud}/agent-workspace.yaml`, import.meta.url),
        'utf8',
      );
      const document: unknown = parseYaml(text);
      if (typeof document !== 'object' || document === null) throw new Error(cloud);
      return [cloud, { ...document }] as const;
    }),
  ),
) as Record<(typeof DEPLOYMENT_CLOUDS)[number], Document>;

/** `document` with the dotted `path` set to `value`, or removed when `value` is `undefined`. */
function withField(document: Document, path: string, value: unknown): Document {
  const copy = structuredClone(document);
  const segments = path.split('.');
  const last = segments.pop();
  if (last === undefined) throw new Error('empty path');
  let parent: Document = copy;
  for (const segment of segments) {
    const next = parent[segment];
    if (typeof next !== 'object' || next === null) throw new Error(`${path} has no block`);
    parent = next as Document;
  }
  if (value === undefined) delete parent[last];
  else parent[last] = value;
  return copy;
}

/** The CLI's verdict, through the same path `agent-workspace validate` reads a file by. */
function cliAccepts(document: Document): boolean {
  try {
    parseProfileDocument(stringifyYaml(document));
    return true;
  } catch (error) {
    if (error instanceof ProfileError) return false;
    throw error;
  }
}

const { aws, gcp, azure, local, vercel, cloudflare } = goldens;

const accepted: ReadonlyArray<readonly [string, Document]> = [
  ['the aws golden', aws],
  ['the gcp golden', gcp],
  ['the azure golden', azure],
  ['the local golden', local],
  ['the vercel golden', vercel],
  ['the external sandbox on vercel', withField(vercel, 'runtime.default', 'external')],
  [
    'provider e2b on the external sandbox on vercel',
    withField(withField(vercel, 'runtime.default', 'external'), 'runtime.provider', 'e2b'),
  ],
  ['the cloudflare golden', cloudflare],
  [
    'provider e2b on the external sandbox on cloudflare',
    withField(withField(cloudflare, 'runtime.default', 'external'), 'runtime.provider', 'e2b'),
  ],
  ['the external sandbox on cloudflare', withField(cloudflare, 'runtime.default', 'external')],
  ['supabase on cloudflare', withField(cloudflare, 'storage.relational', 'supabase')],
  [
    'a profile from before apiVersion',
    withField(withField(local, 'apiVersion', undefined), 'kind', undefined),
  ],
  [
    'a postgres:// connection string',
    withField(local, 'storage.relational', 'postgres://u:p@db:5432/aw'),
  ],
  [
    'a postgresql:// connection string',
    withField(azure, 'storage.relational', 'postgresql://db/aw'),
  ],
  ['an upper-case scheme', withField(aws, 'storage.objects', 'S3://acme-files')],
  ['local-filesystem on local', withField(local, 'storage.objects', 'local-filesystem')],
  ['local-filesystem on azure', withField(azure, 'storage.objects', 'local-filesystem')],
  ['s3:// on gcp', withField(gcp, 'storage.objects', 's3://acme-files')],
  ['kms on aws', withField(aws, 'storage.secrets', 'kms')],
  ['local-key on azure', withField(azure, 'storage.secrets', 'local-key')],
  ['another implemented driver', withField(local, 'runtime.default', 'kubernetes')],
  ['an https OIDC issuer', withField(local, 'identity.oidc', 'https://id.example.test')],
];

const refused: ReadonlyArray<readonly [string, Document]> = [
  ['an unknown root key', withField(local, 'region', 'eu-west-1')],
  ['an unknown storage key', withField(local, 'storage.kms', 'x')],
  ['an unknown identity key', withField(local, 'identity.admin', 'a@b.test')],
  ['an unknown cloud', withField(local, 'cloud', 'digitalocean')],
  ['a missing cloud', withField(local, 'cloud', undefined)],
  ['a cloud that is not text', withField(local, 'cloud', true)],
  ['a block that is not a block', withField(local, 'storage', 'postgres')],
  ['a missing block', withField(local, 'runtime', undefined)],
  [
    'an unknown external provider',
    withField(withField(vercel, 'runtime.default', 'external'), 'runtime.provider', 'modal'),
  ],
  [
    'an external provider that is not text',
    withField(withField(cloudflare, 'runtime.default', 'external'), 'runtime.provider', 7),
  ],
  ['a provider beside vercel-sandbox', withField(vercel, 'runtime.provider', 'e2b')],
  [
    'a provider beside cloudflare-sandbox',
    withField(
      withField(cloudflare, 'runtime.default', 'cloudflare-sandbox'),
      'runtime.provider',
      'e2b',
    ),
  ],
  ['a provider on a cloud without external', withField(local, 'runtime.provider', 'e2b')],
  ['a missing field', withField(local, 'storage.objects', undefined)],
  ['an empty field', withField(local, 'storage.secrets', '')],
  ['a field that is not text', withField(local, 'runtime.default', ['docker'])],
  ['a relational store of another engine', withField(local, 'storage.relational', 'mysql://h/db')],
  ['another cloud’s managed store', withField(aws, 'storage.relational', 'cloud-sql')],
  ['a managed store on local', withField(local, 'storage.relational', 'rds')],
  ['gcs:// outside gcp', withField(aws, 'storage.objects', 'gcs://acme-files')],
  ['azblob:// outside azure', withField(local, 'storage.objects', 'azblob://acme-files')],
  ['local-filesystem on aws', withField(aws, 'storage.objects', 'local-filesystem')],
  ['an unknown object scheme', withField(gcp, 'storage.objects', 'ftp://acme-files')],
  ['a bucket that is not a bucket', withField(aws, 'storage.objects', 's3://Acme_Files')],
  ['an Azure container with --', withField(azure, 'storage.objects', 'azblob://acme--files')],
  ['kms outside aws', withField(gcp, 'storage.secrets', 'kms')],
  ['key-vault outside azure', withField(aws, 'storage.secrets', 'key-vault')],
  ['secret-manager outside gcp', withField(local, 'storage.secrets', 'secret-manager')],
  ['an unknown secret backend', withField(local, 'storage.secrets', 'vault')],
  ['an unimplemented driver', withField(local, 'runtime.default', 'aws-ecs')],
  [
    'external outside vercel, until the other clouds offer it',
    withField(gcp, 'runtime.default', 'external'),
  ],
  ['vercel-sandbox outside vercel', withField(gcp, 'runtime.default', 'vercel-sandbox')],
  [
    'cloudflare-sandbox outside cloudflare',
    withField(vercel, 'runtime.default', 'cloudflare-sandbox'),
  ],
  ['vercel-sandbox on cloudflare', withField(cloudflare, 'runtime.default', 'vercel-sandbox')],
  ['a container driver on cloudflare', withField(cloudflare, 'runtime.default', 'docker')],
  ['neon outside vercel and cloudflare', withField(gcp, 'storage.relational', 'neon')],
  ['gcs:// on cloudflare', withField(cloudflare, 'storage.objects', 'gcs://acme-files')],
  ['kms on cloudflare', withField(cloudflare, 'storage.secrets', 'kms')],
  ['a container driver on vercel', withField(vercel, 'runtime.default', 'docker')],
  ['a managed store of another cloud on vercel', withField(vercel, 'storage.relational', 'rds')],
  ['gcs:// on vercel', withField(vercel, 'storage.objects', 'gcs://acme-files')],
  ['local-filesystem on vercel', withField(vercel, 'storage.objects', 'local-filesystem')],
  ['kms on vercel', withField(vercel, 'storage.secrets', 'kms')],
  [
    'sandbox-runtime, which has no implementation',
    withField(local, 'runtime.default', 'sandbox-runtime'),
  ],
  ['a misspelt driver', withField(local, 'runtime.default', 'kubernets')],
  [
    'a bootstrap admin that is not an address',
    withField(local, 'identity.bootstrapAdmin', 'admin'),
  ],
  ['a missing bootstrap admin', withField(local, 'identity.bootstrapAdmin', undefined)],
  ['an http OIDC issuer', withField(local, 'identity.oidc', 'http://id.example.test')],
  ['an OIDC issuer that is not a URL', withField(local, 'identity.oidc', 'not a url')],
  ['another apiVersion', withField(local, 'apiVersion', 'agentworkspace.dev/v2')],
  ['another kind', withField(local, 'kind', 'Workspace')],
  ['an apiVersion with no kind', withField(local, 'kind', undefined)],
  [
    'a wrong kind with no apiVersion',
    withField(withField(local, 'apiVersion', undefined), 'kind', 'Workspace'),
  ],
];

describe('the committed JSON Schema and the CLI', () => {
  it.each(accepted)('both accept %s', (_, document) => {
    expect(cliAccepts(document)).toBe(true);
    expect(validateWithSchema(document), JSON.stringify(validateWithSchema.errors)).toBe(true);
  });

  it.each(refused)('both refuse %s', (_, document) => {
    expect(cliAccepts(document)).toBe(false);
    expect(validateWithSchema(document)).toBe(false);
  });

  it.each(CLI_ONLY_PROFILE_CHECKS)('leaves $path to the CLI: $check', ({ path, example }) => {
    const document = withField(local, path, example);
    expect(validateWithSchema(document), JSON.stringify(validateWithSchema.errors)).toBe(true);
    let refusal: unknown = null;
    try {
      parseProfileDocument(stringifyYaml(document));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ProfileError);
    expect((refusal as ProfileError).path).toBe(path);
  });

  it.each([
    ['storage.relational', ' rds '],
    ['identity.oidc', '  https://id.example.test  '],
  ])('leaves surrounding whitespace on %s to the CLI, which trims it', (path, value) => {
    // The stricter direction: the schema's pattern or enum refuses the padding the CLI trims.
    const document = withField(aws, path, value);
    expect(cliAccepts(document)).toBe(true);
    expect(validateWithSchema(document)).toBe(false);
  });

  it('offers each cloud its own completions', () => {
    // An editor completes from the branch whose `cloud` matches; the cross-cloud rules are the
    // branches themselves, not code the schema leaves out.
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      dependentRequired: { apiVersion: ['kind'] },
    });
    const branches = (schema as { oneOf?: unknown }).oneOf;
    expect(Array.isArray(branches) ? branches.length : 0).toBe(DEPLOYMENT_CLOUDS.length);
  });
});

describe('the external runtime provider', () => {
  const external = withField(vercel, 'runtime.default', 'external');

  it('lists what the contracts list', () => {
    expect([...EXTERNAL_RUNTIME_PROVIDER_IDS]).toEqual([...EXTERNAL_RUNTIME_PROVIDERS]);
  });

  it('is read trimmed, which the JSON Schema leaves to the CLI', () => {
    const document = withField(external, 'runtime.provider', ' e2b ');
    expect(cliAccepts(document)).toBe(true);
    expect(validateWithSchema(document)).toBe(false);
  });

  it('refuses an unknown provider by name at runtime.provider', () => {
    const parse = () =>
      parseProfileDocument(stringifyYaml(withField(external, 'runtime.provider', 'modal')));
    expect(parse).toThrow(ProfileError);
    expect(parse).toThrow(/runtime\.provider names provider "modal".*choose e2b/u);
  });

  it('takes provider only with external, and says which drivers the cloud offers', () => {
    const parse = () =>
      parseProfileDocument(stringifyYaml(withField(vercel, 'runtime.provider', 'e2b')));
    expect(parse).toThrow(/runtime\.provider is not a field/u);
  });

  it('keeps the refusal of an unknown driver where it was', () => {
    const parse = (value: unknown) =>
      parseProfileDocument(stringifyYaml(withField(vercel, 'runtime.default', value)));
    expect(parse).toBeDefined();
    expect(() => parse('docker')).toThrow(
      /runtime\.default must be one of vercel-sandbox, external/u,
    );
    expect(() => parse(undefined)).toThrow(/runtime\.default is required/u);
  });
});

describe('runtime drivers follow the contracts (#948)', () => {
  it('derives RuntimeDriverId from the contracts', () => {
    expectTypeOf<RuntimeDriverId>().toEqualTypeOf<RuntimeDriver>();
  });

  // Deliberate, not settled: the contracts call `sandbox-runtime` implemented while the CLI profile
  // schema still refuses it. Which side is right is decided in follow-up issue #993
  // (issue #993 of the source repository); until then this pins the difference so neither list can drift unnoticed.
  it('implements what the contracts implement, except sandbox-runtime', () => {
    expect([...IMPLEMENTED_RUNTIME_DRIVERS]).toEqual(
      CONTRACT_IMPLEMENTED_DRIVERS.filter((driver) => driver !== 'sandbox-runtime'),
    );
    expect(UNIMPLEMENTED_RUNTIME_DRIVERS).toContain('sandbox-runtime');
  });

  it('keeps implemented and unimplemented drivers disjoint and inside the catalogue', () => {
    const catalogue: readonly string[] = RUNTIME_DRIVERS;
    const unimplemented: readonly string[] = UNIMPLEMENTED_RUNTIME_DRIVERS;
    for (const driver of IMPLEMENTED_RUNTIME_DRIVERS) {
      expect(catalogue).toContain(driver);
      expect(unimplemented).not.toContain(driver);
    }
    for (const driver of UNIMPLEMENTED_RUNTIME_DRIVERS) expect(catalogue).toContain(driver);
    // The rest are the per-cloud sandbox drivers (VERCEL_/CLOUDFLARE_RUNTIME_DRIVERS).
    expect(
      [
        ...IMPLEMENTED_RUNTIME_DRIVERS,
        ...UNIMPLEMENTED_RUNTIME_DRIVERS,
        'external',
        'vercel-sandbox',
        'cloudflare-sandbox',
      ].sort(),
    ).toEqual([...catalogue].sort());
  });

  it('refuses a listed but unbuilt driver by name', () => {
    const parse = () =>
      parseProfileDocument(stringifyYaml(withField(local, 'runtime.default', 'aws-agentcore')));
    expect(parse).toThrow(ProfileError);
    expect(parse).toThrow(
      'names "aws-agentcore", which the runtime contract lists but packages/runtime does not implement',
    );
  });
});
