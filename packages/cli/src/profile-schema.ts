/**
 * The one definition of `agent-workspace.yaml`: the CLI validates with these schemas, and
 * `packages/cli/scripts/generate-profile-schema.mjs` emits `packages/schemas/agent-workspace.schema.json`
 * from the same ones, so an editor's verdict cannot drift from the CLI's (ADR-0091).
 *
 * Each cloud is its own branch of a union on `cloud`, so the rules that depend on the cloud — which
 * managed store, object scheme and secret backend it may name — are structure the JSON Schema
 * carries, not cross-field code it would lose. Every accepted value is decided by a pattern or an
 * enum; the message attached to it only explains a refusal, in the words the profile's refusals
 * have always used. The checks JSON Schema has no form for are refinements, listed in
 * `CLI_ONLY_PROFILE_CHECKS`.
 */
import type { ImplementedRuntimeDriver } from '@indx-workspace/contracts/project-file';
import type { ExternalRuntimeProvider, RuntimeDriver } from '@indx-workspace/contracts/runtimes';
import { z } from 'zod';

/** The profile format this release reads and writes, as the document's `apiVersion`. */
export const PROFILE_API_VERSION = 'agentworkspace.dev/v1';

/** The one kind of document `agent-workspace.yaml` holds. */
export const PROFILE_KIND = 'Deployment';

export const DEPLOYMENT_CLOUDS = ['aws', 'gcp', 'azure', 'local', 'vercel', 'cloudflare'] as const;

export type DeploymentCloud = (typeof DEPLOYMENT_CLOUDS)[number];

/**
 * Spec §14.2's `RuntimeDriverId`, derived from the runtime contract in `@indx-workspace/contracts`
 * (a type-only import: this file is also loaded by `generate-profile-schema.mjs` through Node's
 * type stripping before any package is built, so no value may be imported from the contracts).
 * `packages/embedded/src/runtime-pins.test.ts` holds this type equal to `packages/runtime`'s.
 */
export type RuntimeDriverId = RuntimeDriver;

/**
 * The driver ids `packages/runtime` actually implements. `satisfies` keeps the list inside the
 * contracts' implemented drivers, so a renamed driver id fails to compile here rather than becoming
 * a profile that passes validation and then cannot be registered. `profile-schema.test.ts` holds
 * this list and `UNIMPLEMENTED_RUNTIME_DRIVERS` to the contracts' catalogue.
 */
export const IMPLEMENTED_RUNTIME_DRIVERS = [
  'local',
  'docker',
  'kubernetes',
  'cloud-run-service',
  'aca-sessions',
] as const satisfies readonly ImplementedRuntimeDriver[];

/**
 * Ids §14.2 names with no implementation in `packages/runtime`. Refused separately from a typo so
 * the operator learns the id is real but unbuilt, rather than being told it does not exist.
 */
export const UNIMPLEMENTED_RUNTIME_DRIVERS = [
  'sandbox-runtime',
  'gke-agent-sandbox',
  'aws-agentcore',
  'aws-ecs',
  'cloud-run-sandbox',
] as const satisfies readonly RuntimeDriverId[];

/**
 * The sandbox drivers cloud `vercel` offers, the default first: Vercel Sandbox is native to the
 * cloud, and E2B through `external` is offered on every cloud (ADR-0120 clause 10). Both are
 * served by the runner manager (`apps/runner/src/manager-start.ts`).
 */
const VERCEL_RUNTIME_DRIVERS = [
  'vercel-sandbox',
  'external',
] as const satisfies readonly RuntimeDriverId[];

/**
 * The sandbox drivers cloud `cloudflare` offers: Cloudflare Sandbox is native to the cloud (the
 * bridge Worker of `infra/cloudflare/sandbox-bridge`), and E2B through `external` is offered on
 * every cloud (ADR-0120 clause 10). `external` is the default (`profile-defaults.ts`), as the
 * native driver refuses every network policy for now (ADR-0131).
 */
const CLOUDFLARE_RUNTIME_DRIVERS = [
  'cloudflare-sandbox',
  'external',
] as const satisfies readonly RuntimeDriverId[];

/**
 * The sandbox providers `runtime.default: external` reaches. `satisfies` keeps the list inside the
 * contracts' `EXTERNAL_RUNTIME_PROVIDERS`; `profile-schema.test.ts` holds the two equal. Absent
 * means `e2b`, which is what `external` has always meant.
 */
export const EXTERNAL_RUNTIME_PROVIDER_IDS = [
  'e2b',
] as const satisfies readonly ExternalRuntimeProvider[];

/** The cloud that offers each native sandbox driver; no other cloud accepts it. */
const NATIVE_DRIVER_CLOUD: ReadonlyMap<string, DeploymentCloud> = new Map([
  ['vercel-sandbox', 'vercel'],
  ['cloudflare-sandbox', 'cloudflare'],
]);

/**
 * The Compose project's own PostgreSQL service, named rather than spelled out as a URL.
 *
 * The connection string contains the generated password, and this document is the one an operator
 * commits; the URL is therefore rendered into `.env` alone, and `DATABASE_URL` is where anything
 * that needs it — including `agent-workspace validate` — reads it from.
 */
export const COMPOSE_RELATIONAL_STORE = 'compose-postgres';

/**
 * The relational store each cloud may name instead of writing a URL: the cloud's managed
 * PostgreSQL, or the Compose project's own service. A name belongs to exactly one cloud.
 */
const MANAGED_RELATIONAL_STORES: Readonly<Record<DeploymentCloud, readonly string[]>> = {
  aws: ['rds'],
  gcp: ['cloud-sql'],
  azure: ['azure-postgres'],
  local: [COMPOSE_RELATIONAL_STORE],
  // The Vercel Marketplace's Neon integration supplies the connection string (ADR-0120 clause 8).
  vercel: ['neon'],
  // Cloudflare has no Postgres of its own; an external one is reached over direct TCP (ADR-0120
  // clause 8).
  cloudflare: ['neon', 'supabase'],
};

/**
 * The local-filesystem object store remains a real deployment backend on the Compose project and
 * as an explicit Azure Files compatibility option. Generated Azure profiles select native Blob.
 */
const LOCAL_FILESYSTEM_OBJECT_STORE = 'local-filesystem';
const CLOUDS_ACCEPTING_LOCAL_FILESYSTEM: readonly DeploymentCloud[] = ['local', 'azure'];

/** The portable secret backend: one deployment-wide `MASTER_ENCRYPTION_KEY`, on every cloud. */
const LOCAL_KEY_SECRET_BACKEND = 'local-key';

/** The native secret backend each cloud implements, beside `local-key`. */
const NATIVE_SECRET_BACKENDS: Readonly<Record<DeploymentCloud, readonly string[]>> = {
  aws: ['kms'],
  gcp: ['secret-manager'],
  azure: ['key-vault'],
  local: [],
  vercel: [],
  cloudflare: [],
};

/**
 * A case-insensitive scheme as a pattern fragment. JSON Schema patterns carry no flags, so the
 * scheme matching the profile has always done case-insensitively is spelt out per character.
 */
function anyCase(scheme: string): string {
  return Array.from(scheme, (character) =>
    /[a-z]/u.test(character) ? `[${character}${character.toUpperCase()}]` : character,
  ).join('');
}

/** S3 and GCS bucket names: `[a-z0-9.-]`, 3–63 characters, no separator at either end. */
const BUCKET = '[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]';

/** Azure container names: `[a-z0-9-]`, 3–63 characters, no hyphen at either end, never `--`. */
const AZURE_CONTAINER = '(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]';

/** The scheme of a `scheme://rest` value, or `null` when the value carries no scheme. */
function schemeOf(value: string): string | null {
  const separator = value.indexOf('://');
  return separator < 1 ? null : value.slice(0, separator).toLowerCase();
}

function isParseableUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Every text field is read trimmed, as it always has been. */
function trimmed(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * The refusal of a text field: missing, not text, empty, or — once it is non-empty text — whatever
 * `explain` says about the value. Zod hands an error map the input of the failing check.
 */
function textRefusal(explain: (value: string) => string) {
  return (issue: { readonly input?: unknown }): string => {
    const { input } = issue;
    if (input === undefined) return 'is required';
    if (typeof input !== 'string') return 'must be text';
    if (input === '') return 'must not be empty';
    return explain(input);
  };
}

interface FieldMeta {
  readonly description: string;
  readonly examples?: readonly string[];
}

/** A check the CLI makes beyond `pattern`, one of `CLI_ONLY_PROFILE_CHECKS`. */
interface CliOnlyCheck {
  readonly accepts: (value: string) => boolean;
  readonly refusal: string;
}

/** A required, trimmed text field whose accepted values match `pattern`. */
function textField(
  pattern: RegExp,
  explain: (value: string) => string,
  meta: FieldMeta,
  cliOnly?: CliOnlyCheck,
) {
  const refusal = textRefusal(explain);
  const matching = z
    .string({ error: refusal })
    .min(1, { error: refusal })
    .regex(pattern, { error: refusal });
  const checked =
    cliOnly === undefined ? matching : matching.refine(cliOnly.accepts, { error: cliOnly.refusal });
  return z.preprocess(trimmed, checked.meta({ ...meta }));
}

/** A required, trimmed text field whose accepted values are `values`. */
function enumField<const Values extends readonly [string, ...string[]]>(
  values: Values,
  explain: (value: string) => string,
  description: string,
) {
  return z.preprocess(
    trimmed,
    z.enum(values, { error: textRefusal(explain) }).meta({ description }),
  );
}

/** A block of fields that refuses any key it does not declare, naming the keys it takes. */
function block<const Shape extends z.ZodRawShape>(
  shape: Shape,
  takes: readonly string[] = Object.keys(shape),
) {
  return z.strictObject(shape, {
    error: (issue) =>
      issue.code === 'unrecognized_keys'
        ? `is not a field of the deployment profile; this block takes ${takes.join(', ')}`
        : 'must be a block of fields',
  });
}

/**
 * `packages/core/src/db/client.ts` accepts `postgres:` and `postgresql:` and refuses every other
 * scheme. This agrees with it rather than restating it loosely: a profile that validates here and
 * is then refused at start-up would be the worst of both checks.
 */
function relationalStore(cloud: DeploymentCloud) {
  const managed = MANAGED_RELATIONAL_STORES[cloud];
  const explain = (value: string): string => {
    const scheme = schemeOf(value);
    if (scheme === null) {
      return (
        `must be a postgres:// connection string or ${managed.join(', ')} for cloud "${cloud}"; ` +
        `got "${value}"`
      );
    }
    return (
      `uses the "${scheme}://" scheme; PostgreSQL is the platform's only relational store, so ` +
      'this must be a postgres:// or postgresql:// connection string'
    );
  };
  return textField(
    new RegExp(
      `^(?:${anyCase('postgres')}(?:${anyCase('ql')})?://|(?:${managed.join('|')})$)`,
      'u',
    ),
    explain,
    {
      description:
        `A postgres:// or postgresql:// connection string, or ${managed.join(', ')}, the ` +
        `PostgreSQL cloud "${cloud}" names.`,
      examples: managed,
    },
    {
      accepts: (value) => schemeOf(value) === null || isParseableUrl(value),
      refusal: 'is not a parseable connection string',
    },
  );
}

/** `s3://` names any S3-compatible store, so every cloud takes it; the others belong to one cloud. */
function objectStore(cloud: DeploymentCloud) {
  const acceptsLocalFilesystem = CLOUDS_ACCEPTING_LOCAL_FILESYSTEM.includes(cloud);
  const accepted = [
    { pattern: `${anyCase('s3')}://${BUCKET}`, shown: 's3://<bucket>' },
    ...(cloud === 'gcp'
      ? [{ pattern: `${anyCase('gcs')}://${BUCKET}`, shown: 'gcs://<bucket>' }]
      : []),
    ...(cloud === 'azure'
      ? [{ pattern: `${anyCase('azblob')}://${AZURE_CONTAINER}`, shown: 'azblob://<container>' }]
      : []),
    ...(acceptsLocalFilesystem
      ? [{ pattern: LOCAL_FILESYSTEM_OBJECT_STORE, shown: LOCAL_FILESYSTEM_OBJECT_STORE }]
      : []),
  ];
  const explain = (value: string): string => {
    if (value === LOCAL_FILESYSTEM_OBJECT_STORE) {
      return (
        `"${LOCAL_FILESYSTEM_OBJECT_STORE}" is a store for cloud ` +
        `${CLOUDS_ACCEPTING_LOCAL_FILESYSTEM.join(' and ')}; cloud "${cloud}" names a bucket URL`
      );
    }
    const scheme = schemeOf(value);
    if (scheme === null) {
      return `must be an s3://, gcs://, or azblob:// store URL, or "${LOCAL_FILESYSTEM_OBJECT_STORE}"; got "${value}"`;
    }
    if (scheme === 'azblob') {
      return cloud === 'azure'
        ? `does not name a 3-63 character Azure container after "azblob://"; got "${value}"`
        : 'selects Azure Blob Storage outside cloud "azure"';
    }
    if (scheme === 'gcs') {
      return cloud === 'gcp'
        ? `does not name a bucket after "gcs://"; got "${value}"`
        : `uses gcs://, which belongs to cloud "gcp", not "${cloud}"`;
    }
    if (scheme === 's3') return `does not name a bucket after "s3://"; got "${value}"`;
    return `uses the "${scheme}://" scheme; choose s3://, gcs://, or azblob://`;
  };
  return textField(
    new RegExp(`^(?:${accepted.map(({ pattern }) => pattern).join('|')})$`, 'u'),
    explain,
    {
      description: `The object store cloud "${cloud}" keeps files in: ${accepted
        .map(({ shown }) => shown)
        .join(', or ')}.`,
    },
  );
}

function secretBackend(cloud: DeploymentCloud) {
  const values: [string, ...string[]] = [
    LOCAL_KEY_SECRET_BACKEND,
    ...NATIVE_SECRET_BACKENDS[cloud],
  ];
  const explain = (value: string): string => {
    if (value === 'kms') return `selects AWS KMS, which belongs to cloud "aws", not "${cloud}"`;
    if (value === 'key-vault') return 'selects Azure Key Vault outside cloud "azure"';
    if (value === 'secret-manager') {
      return `selects Google Secret Manager, which belongs to cloud "gcp", not "${cloud}"`;
    }
    return `must be ${values.map((backend) => `"${backend}"`).join(' or ')}; got "${value}"`;
  };
  return enumField(values, explain, `Where cloud "${cloud}" keeps the secrets it encrypts.`);
}

const RUNTIME_DRIVER_DESCRIPTION = "The sandbox driver an agent's runtime profile falls back to.";

function runtimeDriverAccepted(
  cloud: DeploymentCloud,
): readonly [RuntimeDriverId, ...RuntimeDriverId[]] {
  return cloud === 'vercel'
    ? VERCEL_RUNTIME_DRIVERS
    : cloud === 'cloudflare'
      ? CLOUDFLARE_RUNTIME_DRIVERS
      : IMPLEMENTED_RUNTIME_DRIVERS;
}

function explainRuntimeDriver(cloud: DeploymentCloud, accepted: readonly RuntimeDriverId[]) {
  return (value: string): string => {
    const home = NATIVE_DRIVER_CLOUD.get(value);
    if (home !== undefined) {
      return `names "${value}", which is offered only on cloud "${home}", not "${cloud}"; choose one of ${accepted.join(', ')}`;
    }
    return UNIMPLEMENTED_RUNTIME_DRIVERS.some((candidate) => candidate === value)
      ? `names "${value}", which the runtime contract lists but packages/runtime does not implement; ` +
          `choose one of ${accepted.join(', ')}`
      : `must be one of ${accepted.join(', ')}; got "${value}"`;
  };
}

function runtimeDriver(cloud: DeploymentCloud) {
  const accepted = runtimeDriverAccepted(cloud);
  return enumField(accepted, explainRuntimeDriver(cloud, accepted), RUNTIME_DRIVER_DESCRIPTION);
}

/**
 * The `runtime` block of a cloud that offers `external`: `provider` belongs to `external` alone, so
 * the block is a union on `default` and a native driver's branch does not take it. The profile is
 * read trimmed, so `default` is trimmed before the union looks at it.
 */
function externalRuntimeBlock(cloud: DeploymentCloud, native: RuntimeDriverId) {
  const refuseDriver = textRefusal(explainRuntimeDriver(cloud, runtimeDriverAccepted(cloud)));
  return z.preprocess(
    (value) =>
      typeof value === 'object' && value !== null && 'default' in value
        ? { ...value, default: trimmed(value.default) }
        : value,
    z.discriminatedUnion(
      'default',
      [
        block({
          default: z.literal('external'),
          provider: enumField(
            EXTERNAL_RUNTIME_PROVIDER_IDS,
            (value) =>
              `names provider "${value}", which the external driver does not have; ` +
              `choose ${EXTERNAL_RUNTIME_PROVIDER_IDS.join(', ')}`,
            'The sandbox provider the external driver reaches; e2b when omitted.',
          ).optional(),
        }),
        block({ default: z.literal(native) }),
      ],
      {
        error: (issue) =>
          typeof issue.input === 'object' && issue.input !== null && !Array.isArray(issue.input)
            ? refuseDriver({ input: (issue.input as { default?: unknown }).default })
            : 'must be a block of fields',
      },
    ),
  );
}

const bootstrapAdmin = textField(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u, () => 'must be an email address', {
  description: "The first workspace Owner's sign-in identity, an email address.",
});

const oidcIssuer = textField(
  new RegExp(`^${anyCase('https')}://`, 'u'),
  (value) =>
    isParseableUrl(value)
      ? 'must be an https:// issuer URL'
      : 'must be the issuer URL of an OIDC provider',
  { description: 'The https:// issuer URL of the OIDC provider people sign in through.' },
  { accepts: isParseableUrl, refusal: 'must be the issuer URL of an OIDC provider' },
);

/** The envelope: it describes the document, so `DeploymentProfile` never carries it. */
const envelopeShape = {
  apiVersion: z
    .literal(PROFILE_API_VERSION, {
      error: (issue) => `must be ${PROFILE_API_VERSION}; got ${JSON.stringify(issue.input)}`,
    })
    .optional(),
  kind: z
    .literal(PROFILE_KIND, {
      error: (issue) => `must be ${PROFILE_KIND}; got ${JSON.stringify(issue.input)}`,
    })
    .optional(),
};

const PROFILE_FIELDS = ['cloud', 'storage', 'runtime', 'identity'] as const;

function cloudBranch<const Cloud extends DeploymentCloud>(cloud: Cloud, withEnvelope: boolean) {
  return block(
    {
      ...(withEnvelope ? envelopeShape : {}),
      cloud: z.literal(cloud),
      storage: block({
        relational: relationalStore(cloud),
        objects: objectStore(cloud),
        secrets: secretBackend(cloud),
      }),
      runtime:
        cloud === 'vercel'
          ? externalRuntimeBlock(cloud, 'vercel-sandbox')
          : cloud === 'cloudflare'
            ? externalRuntimeBlock(cloud, 'cloudflare-sandbox')
            : block({ default: runtimeDriver(cloud) }),
      // `bootstrapAdmin` is declared first because it is checked, and so refused, first.
      identity: block({ bootstrapAdmin, oidc: oidcIssuer.optional() }, ['oidc', 'bootstrapAdmin']),
    },
    PROFILE_FIELDS,
  );
}

function cloudRefusal(document: unknown): string {
  const cloud =
    typeof document === 'object' && document !== null && 'cloud' in document
      ? document.cloud
      : undefined;
  if (cloud === undefined) return 'is required';
  if (typeof cloud !== 'string') return 'must be text';
  if (cloud.trim() === '') return 'must not be empty';
  return `must be one of ${DEPLOYMENT_CLOUDS.join(', ')}; got "${cloud}"`;
}

/**
 * The first stage: the value is a block, every root key is one the profile takes, and — for a
 * document — the envelope is this release's. It takes any value for the fields themselves.
 *
 * A union stops at an unmatched `cloud`, so on its own it would report a bad cloud before an
 * unknown root key, the opposite of the order the profile's refusals have always come in; the CLI
 * runs this stage first and the branches only once it passes.
 */
function rootKeys(withEnvelope: boolean) {
  const anyValue = z.unknown().optional();
  const keys = block(
    {
      ...(withEnvelope ? envelopeShape : {}),
      cloud: anyValue,
      storage: anyValue,
      runtime: anyValue,
      identity: anyValue,
    },
    PROFILE_FIELDS,
  );
  if (!withEnvelope) return keys;
  return keys.refine(
    (document) =>
      !('apiVersion' in document) ||
      document.apiVersion === undefined ||
      ('kind' in document && document.kind !== undefined),
    { path: ['kind'], error: `is required; write kind: ${PROFILE_KIND}` },
  );
}

/** The second stage: one branch per cloud, each carrying the rules that cloud's fields follow. */
function cloudBranches(withEnvelope: boolean) {
  return z.discriminatedUnion(
    'cloud',
    [
      cloudBranch('aws', withEnvelope),
      cloudBranch('gcp', withEnvelope),
      cloudBranch('azure', withEnvelope),
      cloudBranch('local', withEnvelope),
      cloudBranch('vercel', withEnvelope),
      cloudBranch('cloudflare', withEnvelope),
    ],
    { error: (issue) => cloudRefusal(issue.input) },
  );
}

/** A profile as a value: the four profile fields, no envelope. */
export const deploymentProfileSchemas = {
  root: rootKeys(false),
  branches: cloudBranches(false),
};

/**
 * `agent-workspace.yaml` as a document: the profile with its `apiVersion` and `kind`. The JSON
 * Schema is `branches`, converted, plus `kind` required once `apiVersion` is set — the one rule of
 * `root` the branches do not already carry.
 */
export const profileDocumentSchemas = {
  root: rootKeys(true),
  branches: cloudBranches(true),
};

/**
 * The checks the CLI makes that JSON Schema has no form for, so an editor knowingly accepts these
 * values and `agent-workspace validate` refuses them. `profile-schema.test.ts` holds each entry to
 * that: the CLI refuses its example and the committed JSON Schema accepts it.
 */
export const CLI_ONLY_PROFILE_CHECKS = [
  {
    path: 'storage.relational',
    check: 'a postgres:// or postgresql:// connection string parses as a URL',
    example: 'postgres://[db/agent_workspace',
  },
  {
    path: 'identity.oidc',
    check: 'the https:// issuer parses as a URL',
    example: 'https://id example.test',
  },
] as const;
