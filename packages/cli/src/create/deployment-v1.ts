import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CreateUsageError } from '../cli-failure.ts';
import {
  assertDigestReferences,
  dockerSocketGroupId,
  resolveDeploymentImages,
  type DeploymentImages,
} from '../deployment.ts';
import type { DeploymentCloud, DeploymentProfile } from '../profile.ts';
import { defaultProfile, type LocalObjectStore } from '../profile-defaults.ts';
import { renderDeploymentArtefacts } from '../render/artefacts.ts';
import { composeProjectName } from '../render/env.ts';
import { helmOverlaySkipReason } from '../render/helm-values.ts';
import type { ProfileProbes } from '../validate.ts';
import type { CreateDeploymentArguments } from './args.ts';
import { shellArgument } from './output.ts';
import {
  DEFAULT_ANSWERS,
  collectGeneratorAnswers,
  processIsInteractive,
  type GeneratorAnswers,
} from './prompts.ts';

export interface GeneratedWorkspace {
  readonly destination: string;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly profile: DeploymentProfile;
  /** Paths written, relative to the destination, in the order they were written. */
  readonly artefacts: readonly string[];
}

function normalizedAnswer(answer: string): string {
  return answer.trim().toLowerCase().replaceAll(/\s+/gu, ' ');
}

/**
 * The interactive generator's four free-text answers, narrowed to the one dimension the profile
 * cannot derive from the cloud: which object store the Compose project runs. The other three
 * answers are kept as refusals so that an operator who asks for something the generated topology
 * does not deploy is told so, rather than silently given Docker and PostgreSQL anyway.
 */
function localObjectStoreFromAnswers(answers: GeneratorAnswers): LocalObjectStore {
  const database = normalizedAnswer(answers.database);
  // ADR-0159. A PostgreSQL 17 answer is refused by name rather than given 18: a new major is a data
  // migration the operator did not agree to. A deployment generated earlier keeps its 17 pin.
  if (/^(?:embedded )?postgresql 17(?: \(container\))?$/u.test(database)) {
    throw new Error(
      `Unsupported database ${JSON.stringify(answers.database)}. ` +
        'New Compose deployments run PostgreSQL 18; answer "PostgreSQL 18" or "PostgreSQL". ' +
        'A deployment generated earlier keeps its PostgreSQL 17 image until you migrate its data.',
    );
  }
  const databases = ['postgresql 18 (container)', 'postgresql 18', 'postgresql', 'postgres'];
  if (!databases.includes(database)) {
    throw new Error(
      `Unsupported database ${JSON.stringify(answers.database)}. ` +
        'The generated Compose deployment currently supports PostgreSQL 18 only.',
    );
  }

  const storageAnswer = normalizedAnswer(answers.storage);
  let storage: LocalObjectStore;
  if (
    storageAnswer === 'local filesystem (docker volume)' ||
    storageAnswer === 'local filesystem' ||
    storageAnswer === 'local'
  ) {
    storage = 'local-filesystem';
  } else if (storageAnswer === 'seaweedfs' || storageAnswer === 'seaweedfs object storage') {
    storage = 'seaweedfs';
  } else if (storageAnswer === 'minio' || storageAnswer === 'minio object storage') {
    // ADR-0067. Answering "MinIO" and silently getting SeaweedFS would be a substitution the
    // operator never agreed to; the answer is refused with the one that now means "bundled S3".
    throw new Error(
      `Unsupported storage ${JSON.stringify(answers.storage)}. ` +
        'The generated deployment no longer bundles MinIO (its images cannot be pulled ' +
        'anonymously); choose "SeaweedFS" for bundled S3-compatible storage, or "local filesystem".',
    );
  } else {
    throw new Error(
      `Unsupported storage ${JSON.stringify(answers.storage)}. ` +
        'Choose "local filesystem" or "SeaweedFS".',
    );
  }

  const runtime = normalizedAnswer(answers.runtime);
  if (runtime !== 'docker') {
    throw new Error(
      `Unsupported runtime ${JSON.stringify(answers.runtime)}. ` +
        'The generated production topology wires the isolated Docker runner; choose "docker".',
    );
  }

  const authentication = normalizedAnswer(answers.authentication);
  if (authentication !== 'local administrator' && authentication !== 'local') {
    throw new Error(
      `Unsupported authentication ${JSON.stringify(answers.authentication)}. ` +
        'The generated deployment currently supports a local administrator only.',
    );
  }

  return storage;
}

/**
 * Point the generated project's `package.json` at this CLI, by the name and version it was itself
 * published as, and name the project after its directory. The template's own specifier is only a
 * placeholder: a version written there by hand drifts from the lock-step release, and a workspace
 * name never resolves outside this repository. The generated project depends on the CLI and
 * nothing else. The package name is the Compose project name, which is already a valid npm name.
 */
export async function pinCliDependency(manifestFile: string, packageName?: string): Promise<void> {
  const cli = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as {
    readonly name: string;
    readonly version: string;
  };
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
  if (packageName !== undefined) manifest['name'] = packageName;
  manifest['dependencies'] = { [cli.name]: cli.version };
  await writeFile(
    manifestFile,
    `${JSON.stringify(manifest, null, 2)}
`,
    'utf8',
  );
}

/**
 * The Compose project `create` copies for `local`; `agent-workspace render` restores its
 * `compose.yaml` from the same file, so there is one copy of every template.
 */
export const TEMPLATES_DIRECTORY = new URL('../../templates/', import.meta.url);

/** The artefact `render/artefacts.ts` renders the deployment's secrets into. */
const ENV_ARTEFACT = '.env';

export interface CreateWorkspaceOptions {
  readonly images?: DeploymentImages;
  /** `--port`: the host port the Compose web service is published on. */
  readonly webPort?: number;
  /** Defaults to `local`, the cloud the interactive answers describe. */
  readonly cloud?: DeploymentCloud;
  /**
   * The internal deployment of a v2 project's environment (issue #621): its bridged profile is
   * used instead of the cloud's defaults, the project's name instead of the directory's, and the
   * directory is created owner-only because it is internal state holding the `.env` secrets.
   */
  readonly deployState?: {
    readonly profile: DeploymentProfile;
    readonly projectName: string;
  };
}

/**
 * Generate a project.
 *
 * Nothing is written until the profile validates, the images resolve to verified digests, and
 * every artefact has rendered — so a refusal at any of those points leaves no directory behind.
 * Pass `answers` for the interactive Compose path, or `null` when `options.cloud` selects the
 * profile instead.
 */
export async function createWorkspace(
  target: string,
  answers: GeneratorAnswers | null,
  options: CreateWorkspaceOptions = {},
): Promise<GeneratedWorkspace> {
  const { deployState } = options;
  const cloud = deployState?.profile.cloud ?? options.cloud ?? 'local';
  if (answers !== null && (cloud !== 'local' || deployState !== undefined)) {
    throw new Error(
      `Interactive answers describe the local Compose project, not --cloud ${cloud}.`,
    );
  }
  const localObjectStore = answers === null ? undefined : localObjectStoreFromAnswers(answers);

  const destination = path.resolve(target);
  const secrets = {
    adminPassword: randomBytes(24).toString('base64url'),
    postgresPassword: randomBytes(24).toString('base64url'),
    objectStoreSecretKey: randomBytes(24).toString('base64url'),
    masterEncryptionKey: randomBytes(32).toString('hex'),
    gatewayTokenSecret: randomBytes(32).toString('hex'),
    runnerManagerToken: randomBytes(32).toString('hex'),
    sessionSecret: randomBytes(32).toString('hex'),
    cronSecret: randomBytes(32).toString('hex'),
  };
  const projectName = deployState?.projectName ?? path.basename(destination);
  const profile =
    deployState?.profile ??
    defaultProfile({
      cloud,
      projectName,
      ...(localObjectStore === undefined ? {} : { localObjectStore }),
    });

  const images = assertDigestReferences(options.images ?? resolveDeploymentImages(cloud));
  const dockerGroupId = await dockerSocketGroupId();
  const artefacts = renderDeploymentArtefacts({
    profile,
    secrets,
    images,
    dockerGroupId,
    projectName,
    ...(options.webPort === undefined ? {} : { webPort: options.webPort }),
  });

  const templates = fileURLToPath(TEMPLATES_DIRECTORY);
  await mkdir(destination, {
    recursive: false,
    ...(deployState === undefined ? {} : { mode: 0o700 }),
  });
  // `templates/` is the Compose project — the Compose file itself plus the workspace manifests
  // whose `start` script runs it. A cloud target deploys through Helm or Terraform instead, and
  // the cloud `.env` holds none of the variables the Compose file demands, so shipping these
  // there would hand the operator files that cannot run.
  const templateFiles: string[] = [];
  if (cloud === 'local') {
    await cp(templates, destination, { recursive: true });
    await pinCliDependency(path.join(destination, 'package.json'), composeProjectName(projectName));
    templateFiles.push(...(await readdir(templates)).sort());
  } else if (deployState === undefined) {
    // No Compose here, but `render`, `validate` and `deploy` are still this CLI's: pin it, so
    // `npm install` in the project gives the release's own `agent-workspace` (BH061-058).
    const manifest = path.join(destination, 'package.json');
    const scripts = { deploy: 'agent-workspace deploy .' };
    await writeFile(manifest, `${JSON.stringify({ private: true, scripts }, null, 2)}\n`, 'utf8');
    await pinCliDependency(manifest, composeProjectName(projectName));
    templateFiles.push('package.json');
  }
  for (const artefact of artefacts) {
    const file = path.join(destination, artefact.path);
    await mkdir(path.dirname(file), { recursive: true });
    // `.env` is the one artefact holding live credentials — the generated administrator password,
    // the session, gateway and runner-manager secrets, and the master encryption key — and is the
    // only entry in the rendered `.gitignore`. Every other artefact is safe to commit and keeps
    // the default mode; this one is the owner's alone.
    await writeFile(
      file,
      artefact.contents,
      artefact.path === ENV_ARTEFACT ? { encoding: 'utf8', mode: 0o600 } : 'utf8',
    );
  }

  return {
    destination,
    adminEmail: profile.identity.bootstrapAdmin,
    adminPassword: secrets.adminPassword,
    profile,
    artefacts: [...templateFiles, ...artefacts.map(({ path: written }) => written)],
  };
}

/** The two artefact paths `nextSteps` names, as `render/artefacts.ts` writes them. */
const HELM_OVERLAY = 'deploy/helm/values.yaml';
const TERRAFORM_DIRECTORY = 'deploy/terraform/';
const VERCEL_SETTINGS = 'deploy/vercel/vercel.json';
const CLOUDFLARE_SETTINGS = 'deploy/cloudflare/wrangler.jsonc';

/**
 * What an operator does next with the project that has just been written.
 *
 * A rendered `deploy/terraform/<module>.auto.tfvars.json` is applied by copying it into
 * `infra/terraform/<module>/`, because Terraform auto-loads `*.auto.tfvars.json` only from the
 * directory it runs in. The generated `deploy/terraform/` holds no `.tf` file at all, so
 * `terraform apply` there would initialise an empty configuration and apply nothing — which is
 * what the previous "apply deploy/ against your <cloud> account" invited. The steps are derived
 * from the artefacts actually rendered, so a cloud that gets no chart overlay is not told to
 * install one.
 */
function nextSteps(target: string, artefacts: readonly string[]): readonly string[] {
  const steps: string[] = [`review ${target}/agent-workspace.yaml, then:`];
  if (artefacts.includes(HELM_OVERLAY)) {
    steps.push(
      `  helm upgrade --install agent-workspace infra/helm/agent-workspace \\`,
      `    -f infra/helm/agent-workspace/<flavour>.yaml -f ${target}/${HELM_OVERLAY}`,
    );
  }
  // `npm run deploy` is the project's pinned `agent-workspace deploy .`; it plans until `-- --yes`.
  if (artefacts.includes(VERCEL_SETTINGS)) {
    steps.push(
      `  cd ${target} && npm install`,
      '  VERCEL_TOKEN=<token> VERCEL_TEAM_ID=<team id> npm run deploy',
    );
  }
  if (artefacts.includes(CLOUDFLARE_SETTINGS)) {
    steps.push(
      `  cd ${target} && npm install`,
      '  CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \\',
      '    CLOUDFLARE_WORKERS_SUBDOMAIN=<workers.dev subdomain> CONTROL_PLANE_URL=<url> npm run deploy',
    );
  }
  for (const artefact of artefacts.filter((file) => file.startsWith(TERRAFORM_DIRECTORY))) {
    const module = path.basename(artefact, '.auto.tfvars.json');
    steps.push(
      `  cp ${target}/${artefact} infra/terraform/${module}/`,
      `  terraform -chdir=infra/terraform/${module} apply`,
    );
  }
  return steps;
}

export interface CreateDeploymentOptions {
  /** Injected by the suite; production resolves every reference from the registry. */
  readonly images?: DeploymentImages;
  /** Injected by the suite; production reads the four answers from the terminal. */
  readonly answers?: GeneratorAnswers;
  /** Injected by the suite; production opens real sockets. */
  readonly probes?: ProfileProbes;
  /** Injected by the suite; production uses this process's platform. */
  readonly platform?: NodeJS.Platform;
}

/** `create <dir> --cloud <cloud> [--validate]`. */
export async function runCreateDeployment(
  args: CreateDeploymentArguments,
  options: CreateDeploymentOptions,
): Promise<void> {
  const { target, cloud, validate, yes, generator, port } = args;
  let answers: GeneratorAnswers | null = null;
  if (cloud === 'local') {
    // A refused flag is the caller's to fix, and nothing is asked or written before it is known.
    try {
      localObjectStoreFromAnswers({ ...DEFAULT_ANSWERS, ...generator });
    } catch (error) {
      if (error instanceof Error) throw new CreateUsageError(error.message);
      throw error;
    }
    answers =
      options.answers ?? (await collectGeneratorAnswers(generator, !yes && processIsInteractive()));
  }
  const generated = await createWorkspace(target, answers, {
    cloud,
    ...(options.images === undefined ? {} : { images: options.images }),
    ...(port === undefined ? {} : { webPort: port }),
  });

  // A profile the chart cannot serve gets no overlay, and silence there would look like a bug in
  // the generator; saying which store the chart needs is what makes it a decision.
  const skipped = helmOverlaySkipReason(generated.profile);

  process.stdout.write(
    `\nCreated ${generated.destination}\n` +
      `${generated.artefacts.map((file) => `  ${file}\n`).join('')}` +
      (skipped === null ? '' : `${skipped}\n`) +
      `Administrator: ${generated.adminEmail}\n` +
      `One-time setup password: ${generated.adminPassword}\n` +
      (cloud === 'local'
        ? `Next: cd ${shellArgument(target, options.platform)} && pnpm install --frozen-lockfile=false && pnpm start\n`
        : `Next: ${nextSteps(target, generated.artefacts).join('\n')}\n`),
  );

  if (!validate) return;
  const { ProbeRefusedError, describeProbeResults, projectEnvironment, runProfileProbes } =
    await import('../validate.ts');
  // The probes read the credentials from the project that has just been written — the same
  // layering `agent-workspace validate` uses — rather than from an empty environment, which
  // could only ever report skips.
  const environment = await projectEnvironment(generated.destination);
  try {
    process.stdout.write(
      describeProbeResults(
        await runProfileProbes(generated.profile, {
          environment,
          ...(options.probes === undefined ? {} : { probes: options.probes }),
        }),
      ),
    );
  } catch (cause) {
    if (!(cause instanceof ProbeRefusedError)) throw cause;
    // `--validate` runs after the artefacts exist, so the refusal has to say so: the generation
    // succeeded and only the connectivity check did not, which is a non-zero exit either way.
    throw new Error(
      `${cause.message}\nThe project was written to ${generated.destination}; fix the store, ` +
        `then re-run \`agent-workspace validate ${target}\`.`,
      { cause },
    );
  }
}
