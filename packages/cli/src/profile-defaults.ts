/**
 * The profile `create-agent-workspace` derives for each `--cloud` value.
 *
 * These are starting points an operator edits, not a claim about their account: the profile is the
 * declaration, and `agent-workspace validate` is what checks it against a real deployment. Every
 * default here is either what the platform already does today (the Compose project) or what the
 * deploy guides already document for that cloud — no default invents a capability.
 */
import {
  validateProfile,
  COMPOSE_RELATIONAL_STORE,
  ProfileError,
  type DeploymentCloud,
  type DeploymentProfile,
} from './profile.ts';

/** The generator's two object-store answers for the Compose project. */
export type LocalObjectStore = 'local-filesystem' | 'seaweedfs';

export interface ProfileDefaultsInput {
  readonly cloud: DeploymentCloud;
  /** The generated project's directory name; the object bucket is named after it. */
  readonly projectName: string;
  /** Which object store the interactive answers chose. Ignored unless `cloud` is `local`. */
  readonly localObjectStore?: LocalObjectStore;
}

/**
 * The bootstrap administrator every generated project starts with, for every cloud. It is a
 * starting point the operator replaces in `agent-workspace.yaml`, not a claim about their domain.
 */
const GENERATED_BOOTSTRAP_ADMIN = 'admin@localhost.test';

/** The bucket the Compose project's SeaweedFS service serves, as `.env.example` documents it. */
const COMPOSE_BUCKET = 'agent-workspace';

/**
 * S3 bucket names are `[a-z0-9.-]`, 3–63 characters, and may not start or end with a separator.
 * A project directory that cannot produce one is refused here rather than at `terraform apply`.
 */
function bucketFor(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, '-')
    .replaceAll(/-+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '');
  const bucket = `${slug}-files`;
  if (slug === '' || bucket.length > 63) {
    throw new ProfileError(
      'storage.objects',
      `cannot be derived from the project directory "${projectName}"; name the bucket in ` +
        'agent-workspace.yaml, or generate into a directory whose name is 1–57 characters of ' +
        'letters, digits and hyphens',
    );
  }
  return bucket;
}

/**
 * The relational store, object store and default sandbox driver each cloud gets, as
 * `docs/sdk/site/concepts/data-plane.mdx` records them today.
 *
 * `azure` selects native Blob Storage and Key Vault through managed identity. `aws` takes
 * `kubernetes` because no AWS managed driver is implemented — `aws-ecs` and `aws-agentcore` are
 * contract ids with no code behind them.
 */
function cloudDefaults(
  cloud: Exclude<DeploymentCloud, 'local'>,
  projectName: string,
): Pick<DeploymentProfile, 'storage' | 'runtime'> {
  switch (cloud) {
    case 'aws':
      return {
        storage: {
          relational: 'rds',
          objects: `s3://${bucketFor(projectName)}`,
          // KMS needs an operator-supplied key id and encrypted deployment key. Keep generated
          // projects bootable; an operator opts in after provisioning those two values.
          secrets: 'local-key',
        },
        runtime: { default: 'kubernetes' },
      };
    case 'gcp':
      return {
        storage: {
          relational: 'cloud-sql',
          objects: `gcs://${bucketFor(projectName)}`,
          secrets: 'secret-manager',
        },
        runtime: { default: 'cloud-run-service' },
      };
    case 'azure':
      return {
        storage: {
          relational: 'azure-postgres',
          objects: `azblob://${bucketFor(projectName)}`,
          secrets: 'key-vault',
        },
        runtime: { default: 'aca-sessions' },
      };
    case 'vercel':
      return {
        storage: {
          // The Vercel Marketplace's Neon integration supplies DATABASE_URL; any S3-compatible
          // store serves objects, as Vercel Blob is not accepted (ADR-0120 clause 8).
          relational: 'neon',
          objects: `s3://${bucketFor(projectName)}`,
          secrets: 'local-key',
        },
        runtime: { default: 'vercel-sandbox' },
      };
    case 'cloudflare':
      return {
        storage: {
          // An external PostgreSQL over direct TCP; R2 is reached through the S3 adapter
          // (ADR-0120 clause 8).
          relational: 'neon',
          objects: `s3://${bucketFor(projectName)}`,
          secrets: 'local-key',
        },
        // E2B, not the native `cloudflare-sandbox`: that driver refuses every network policy until a
        // providers-live run proves Cloudflare denies egress (ADR-0131), so it runs no session.
        runtime: { default: 'external' },
      };
    default: {
      const unreachable: never = cloud;
      throw new ProfileError('cloud', `has no defaults: ${String(unreachable)}`);
    }
  }
}

/**
 * The profile a freshly generated project starts from. Always returned through `validateProfile`,
 * so a default that stops satisfying the schema fails here rather than in a rendered artefact.
 */
export function defaultProfile(input: ProfileDefaultsInput): DeploymentProfile {
  const identity = { bootstrapAdmin: GENERATED_BOOTSTRAP_ADMIN };

  if (input.cloud !== 'local') {
    return validateProfile({
      cloud: input.cloud,
      ...cloudDefaults(input.cloud, input.projectName),
      identity,
    });
  }

  return validateProfile({
    cloud: 'local',
    storage: {
      // The Compose project's own service, by name: its connection string carries the generated
      // password, so it is rendered into `.env` and never into the document an operator commits.
      relational: COMPOSE_RELATIONAL_STORE,
      objects:
        input.localObjectStore === 'seaweedfs' ? `s3://${COMPOSE_BUCKET}` : 'local-filesystem',
      secrets: 'local-key',
    },
    runtime: { default: 'docker' },
    identity,
  });
}
