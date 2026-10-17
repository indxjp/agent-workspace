/**
 * The deployment profile: one validated document naming where a deployment's relational store,
 * objects, secrets, default runtime and identity live.
 *
 * The platform itself is unchanged by this file — it keeps reading the same environment variables.
 * The profile is what *writes* them, so validation here is the last point at which a deployment
 * pointed at a store that does not exist, or at a backend this release has not delivered, can
 * still be refused before any file is written. Every refusal names the offending dotted path, and
 * a refusal of a file also names its line and column.
 *
 * Decisions, the schemes each store accepts, and the two meanings of "validated" are recorded in
 * `docs/adr/0055-the-deployment-profile-is-one-validated-document-the-installer-renders.md`; the
 * parser, `apiVersion` and `kind` in `docs/adr/0089-…`; the one schema definition the CLI and the
 * published JSON Schema share (`profile-schema.ts`) in `docs/adr/0091-…`.
 */
import { PROJECT_API_VERSION, PROJECT_KIND } from '@indx-workspace/contracts/project-file';
import type { ExternalRuntimeProvider } from '@indx-workspace/contracts/runtimes';
import type { z } from 'zod';

import {
  readProfileDocumentText,
  serializeProfileDocument,
  type ProfileDocument,
  type ProfileDocumentPosition,
} from './profile-document.ts';
import {
  deploymentProfileSchemas,
  profileDocumentSchemas,
  PROFILE_API_VERSION,
  PROFILE_KIND,
  type DeploymentCloud,
  type RuntimeDriverId,
} from './profile-schema.ts';
import { CLI_VERSION } from './version.ts';

export {
  COMPOSE_RELATIONAL_STORE,
  DEPLOYMENT_CLOUDS,
  type DeploymentCloud,
  type RuntimeDriverId,
} from './profile-schema.ts';

interface StorageProfile {
  /** A `postgres://` connection string, or the cloud's managed PostgreSQL by name. */
  readonly relational: string;
  /** An `s3://`, `gcs://`, or `azblob://` store URL, or `local-filesystem`. */
  readonly objects: string;
  /** `local-key`, or the native backend implemented for the selected cloud. */
  readonly secrets: string;
}

interface RuntimeProfile {
  /** The sandbox driver an agent's runtime profile falls back to. */
  readonly default: RuntimeDriverId;
  /** The sandbox provider `external` reaches; `e2b` when it is absent. Only `external` takes it. */
  readonly provider?: ExternalRuntimeProvider;
}

interface IdentityProfile {
  /** The OIDC issuer URL, when the deployment signs people in through an identity provider. */
  readonly oidc?: string;
  /** The first workspace Owner's sign-in identity. */
  readonly bootstrapAdmin: string;
}

export interface DeploymentProfile {
  readonly cloud: DeploymentCloud;
  readonly storage: StorageProfile;
  readonly runtime: RuntimeProfile;
  readonly identity: IdentityProfile;
}

/**
 * A refusal by the profile schema, carrying the dotted path of the offending field — and, when the
 * profile was read from a file, the line and column that path is written at.
 */
export class ProfileError extends Error {
  readonly path: string;
  readonly detail: string;
  readonly position: ProfileDocumentPosition | undefined;

  constructor(path: string, detail: string, position?: ProfileDocumentPosition) {
    super(
      position === undefined
        ? `agent-workspace.yaml: ${path} ${detail}`
        : `agent-workspace.yaml line ${position.line}, column ${position.column}: ${path} ${detail}`,
    );
    this.name = 'ProfileError';
    this.path = path;
    this.detail = detail;
    this.position = position;
  }
}

/**
 * What `render`, `validate`, `deploy` and `doctor` say about a v2 `kind: Project` file, the one
 * `npm create @indx-workspace` and `aw init` write (S1-16). That file is read by `aw dev`; the
 * commands that render and deploy it arrive with P-2, so until then they refuse it by name rather
 * than report its first schema mismatch as if it were a broken deployment profile.
 */
export const PROJECT_KIND_REFUSAL =
  'kind: Project is read by aw dev; render and deploy arrive with P-2';

/**
 * The command that generates the v1 Compose project `start`, `stop`, `validate`, `render`,
 * `doctor` and `deploy` operate. Without `--cloud`, `npm create @indx-workspace` writes a v2
 * `kind: Project` directory instead, which `aw dev` runs (#496).
 */
export const COMPOSE_PROJECT_CREATE_COMMAND =
  'npm create @indx-workspace <directory> -- --cloud local';

/**
 * What to do about a `kind: Project` file, as `doctor` advises it: run it with `aw dev`, and
 * where the Compose project this CLI operates comes from (#496).
 */
export const PROJECT_KIND_ADVICE =
  'agent-workspace.yaml is a kind: Project file: run `aw dev` in this directory. ' +
  `agent-workspace operates the Compose project \`${COMPOSE_PROJECT_CREATE_COMMAND}\` generates.`;

/**
 * The refusal of a v2 project file. It is a `ProfileError`, so every command that reports a
 * refused profile — `doctor`'s failed check included — reports this one the same way.
 */
export class ProjectKindRefusedError extends ProfileError {
  constructor(path: string, position: ProfileDocumentPosition) {
    super(path, PROJECT_KIND_REFUSAL, position);
    this.name = 'ProjectKindRefusedError';
    this.message = `agent-workspace.yaml line ${position.line}, column ${position.column}: ${PROJECT_KIND_REFUSAL}`;
  }
}

/**
 * Whether a read document is a v2 project file: `kind: Project`, or the v2 `apiVersion` with no
 * `kind`. A v2 `apiVersion` beside another kind (`kind: Deployment`) is a profile with a wrong
 * version, and keeps the schema's refusal naming the version this CLI reads.
 */
function isProjectDocument(value: unknown): value is { readonly kind?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if ('kind' in value) return value.kind === PROJECT_KIND;
  return 'apiVersion' in value && value.apiVersion === PROJECT_API_VERSION;
}

/**
 * The order the profile is checked in, and so which refusal is reported when a profile has more
 * than one: the envelope, then the root block's keys, then each block — its own keys before its
 * fields. `*` stands for a block's unknown keys. Zod reports every issue it finds, in its own
 * order; this picks the one an operator has always been shown first.
 */
const REFUSAL_ORDER = [
  '',
  'apiVersion',
  'kind',
  '*',
  'cloud',
  'storage',
  'storage.*',
  'storage.relational',
  'storage.objects',
  'storage.secrets',
  'runtime',
  'runtime.*',
  'runtime.default',
  'runtime.provider',
  'identity',
  'identity.*',
  'identity.bootstrapAdmin',
  'identity.oidc',
];

/** The dotted path an issue refuses: an unknown key's own path, or the field's. */
function refusedPath(issue: z.core.$ZodIssue): string {
  const path = issue.path.map(String);
  if (issue.code === 'unrecognized_keys' && issue.keys[0] !== undefined) {
    path.push(issue.keys[0]);
  }
  return path.join('.');
}

function refusalRank(issue: z.core.$ZodIssue): number {
  const block = issue.path.map(String).join('.');
  const slot = issue.code === 'unrecognized_keys' ? (block === '' ? '*' : `${block}.*`) : block;
  const rank = REFUSAL_ORDER.indexOf(slot);
  return rank === -1 ? REFUSAL_ORDER.length : rank;
}

/** The refusal an operator is shown for a failed stage: its first issue, in `REFUSAL_ORDER`. */
function firstRefusal(issues: readonly z.core.$ZodIssue[]): ProfileError {
  const [first, ...rest] = issues;
  if (first === undefined) return new ProfileError('the profile', 'is not a deployment profile');
  const chosen = rest.reduce(
    (best, issue) => (refusalRank(issue) < refusalRank(best) ? issue : best),
    first,
  );
  const path = refusedPath(chosen);
  return new ProfileError(path === '' ? 'the profile' : path, chosen.message);
}

/** The two stages of `profile-schema.ts`, the root's keys and then the cloud's branch. */
interface ProfileSchemas<Output> {
  readonly root: z.ZodType;
  readonly branches: z.ZodType<Output>;
}

function parseWith<Output>(schemas: ProfileSchemas<Output>, value: unknown): Output {
  const root = schemas.root.safeParse(value);
  if (!root.success) throw firstRefusal(root.error.issues);
  const parsed = schemas.branches.safeParse(value);
  if (!parsed.success) throw firstRefusal(parsed.error.issues);
  return parsed.data;
}

/** The profile's own fields, without the envelope a document carries. */
function toProfile(parsed: z.output<typeof deploymentProfileSchemas.branches>): DeploymentProfile {
  return {
    cloud: parsed.cloud,
    storage: {
      relational: parsed.storage.relational,
      objects: parsed.storage.objects,
      secrets: parsed.storage.secrets,
    },
    runtime: {
      default: parsed.runtime.default,
      ...('provider' in parsed.runtime && parsed.runtime.provider !== undefined
        ? { provider: parsed.runtime.provider }
        : {}),
    },
    identity: {
      ...(parsed.identity.oidc === undefined ? {} : { oidc: parsed.identity.oidc }),
      bootstrapAdmin: parsed.identity.bootstrapAdmin,
    },
  };
}

/**
 * Level 1 of "validated": the document is schema-valid, every scheme is one this release serves,
 * and the cross-field rules hold. No network, no credential, no file written.
 */
export function validateProfile(value: unknown): DeploymentProfile {
  return toProfile(parseWith(deploymentProfileSchemas, value));
}

export interface ParseProfileDocumentOptions {
  /** Told about a profile that is read but should be edited — today, a missing `apiVersion`. */
  readonly onWarning?: (message: string) => void;
}

/** What a profile written before `apiVersion` existed is told, once, each time it is read. */
export const MISSING_API_VERSION_WARNING =
  `agent-workspace.yaml has no apiVersion, so it is read as ${PROFILE_API_VERSION}. ` +
  'Add these two lines at the top of the file; a later release will refuse a profile without them:\n' +
  `  apiVersion: ${PROFILE_API_VERSION}\n` +
  `  kind: ${PROFILE_KIND}`;

/**
 * Validate the document, `apiVersion` and `kind` included. They describe the document rather than
 * the deployment, so `DeploymentProfile` never carries them. A profile with neither is read as the
 * current version, for one minor release, with a warning; one that names a version must also name
 * its kind.
 */
function validateDocument(value: unknown, onWarning: (message: string) => void): DeploymentProfile {
  const isBlock = typeof value === 'object' && value !== null && !Array.isArray(value);
  // Told before any refusal, so a profile from before `apiVersion` hears it even when it is wrong.
  if (isBlock && !('apiVersion' in value)) onWarning(MISSING_API_VERSION_WARNING);
  return toProfile(parseWith(profileDocumentSchemas, value));
}

/** Read `agent-workspace.yaml`'s text into a validated profile. */
export function parseProfileDocument(
  text: string,
  options: ParseProfileDocumentOptions = {},
): DeploymentProfile {
  const reading = readProfileDocumentText(text);
  // Before the missing-apiVersion warning and every schema stage: a v2 project is not a broken
  // deployment profile, and none of their refusals would tell its author what to run instead.
  if (isProjectDocument(reading.value)) {
    const path = 'kind' in reading.value ? 'kind' : 'apiVersion';
    throw new ProjectKindRefusedError(path, reading.locate([path]));
  }
  try {
    return validateDocument(reading.value, options.onWarning ?? (() => undefined));
  } catch (error) {
    if (!(error instanceof ProfileError) || error.position !== undefined) throw error;
    throw new ProfileError(error.path, error.detail, reading.locate(error.path.split('.')));
  }
}

/**
 * Where the JSON Schema of the profile this CLI writes is published: the copy the published
 * `@indx-workspace/cli` tarball of this version ships under `schema/`, served by unpkg, so it never
 * changes under a committed profile (ADR-0091). Editors fetch it; the CLI never does.
 */
export const PROFILE_SCHEMA_URL = `https://unpkg.com/@indx-workspace/cli@${CLI_VERSION}/schema/agent-workspace.schema.json`;

function profileToDocument(profile: DeploymentProfile): ProfileDocument {
  return {
    apiVersion: PROFILE_API_VERSION,
    kind: PROFILE_KIND,
    cloud: profile.cloud,
    storage: {
      relational: profile.storage.relational,
      objects: profile.storage.objects,
      secrets: profile.storage.secrets,
    },
    runtime: {
      default: profile.runtime.default,
      ...(profile.runtime.provider === undefined ? {} : { provider: profile.runtime.provider }),
    },
    identity: {
      ...(profile.identity.oidc === undefined ? {} : { oidc: profile.identity.oidc }),
      bootstrapAdmin: profile.identity.bootstrapAdmin,
    },
  };
}

/** Write a validated profile back to the text form `parseProfileDocument` round-trips. */
export function renderProfileDocument(profile: DeploymentProfile): string {
  return serializeProfileDocument(profileToDocument(profile), [
    `yaml-language-server: $schema=${PROFILE_SCHEMA_URL}`,
    'The deployment profile: where this deployment keeps state, bytes, secrets, sandboxes and',
    'identity. `agent-workspace validate` checks it; the installer renders .env, the Compose',
    'file, Helm values and Terraform variables from it. No secret belongs in this file.',
  ]);
}
