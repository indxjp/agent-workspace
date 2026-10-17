/**
 * Copy the release images into the Cloud Run module's Artifact Registry, by digest (issue #794).
 *
 * Cloud Run cannot pull from ghcr.io, where the release is published. Each image is copied with
 * `docker buildx imagetools create` and read back with `imagetools inspect`, so what the service
 * pulls is `<registry>/<name>@<the release's digest>`: a tag is only the label `imagetools`
 * requires and is never read. Docker's own credentials do the writing; this never handles one.
 */
import { createRedactor } from './redact.ts';
import { runStep, type DeployContext } from './steps.ts';

export const CLOUD_RUN_IMAGES = ['web', 'gateway', 'runner', 'runtime'] as const;
export type CloudRunImage = (typeof CLOUD_RUN_IMAGES)[number];
export type CloudRunImageReferences = Readonly<Record<CloudRunImage, string>>;

/** Cloud Run pulls from Artifact Registry; from ghcr.io, where the release is published, it cannot. */
const ARTIFACT_REGISTRY_IMAGE = /^[a-z0-9-]+-docker\.pkg\.dev\//u;
/** The module's `image_registry` output, `<region>-docker.pkg.dev/<project>/<repository>`. */
const IMAGE_REGISTRY = /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]*[a-z0-9]\/[a-z][a-z0-9-]*$/u;
/** What Terraform prints when the state holds no `image_registry` output yet. */
const MISSING_OUTPUT = /Output "image_registry" not found|No outputs found/u;

function isArtifactRegistryImage(reference: string): boolean {
  return ARTIFACT_REGISTRY_IMAGE.test(reference);
}

export interface ImageCopyRequest {
  readonly context: DeployContext;
  readonly moduleDirectory: string;
  /** The reference each image resolves to: digest references, all of them. */
  readonly references: CloudRunImageReferences;
  /** `--yes`: copy. Without it the copies are only listed. */
  readonly apply: boolean;
  /** The label `imagetools create` requires; the deployment never reads it. */
  readonly tag: string;
  readonly ownerEmail: string;
}

function digestOf(reference: string): string {
  return reference.slice(reference.lastIndexOf('@') + 1);
}

function copyCommand(source: string, registry: string, name: CloudRunImage, tag: string): string {
  return `docker buildx imagetools create --tag ${registry}/${name}:${tag} ${source}`;
}

/** The digest `inspect` reports for a manifest; `null` for anything else. */
function manifestDigest(output: string): string | null {
  try {
    const manifest: unknown = JSON.parse(output);
    if (typeof manifest !== 'object' || manifest === null) return null;
    const digest = (manifest as { readonly digest?: unknown }).digest;
    return typeof digest === 'string' ? digest : null;
  } catch {
    return null;
  }
}

/** The first line of Terraform's stderr with text on it, without its `╷ │ ╵` box drawing. */
function firstStderrLine(stderr: string): string {
  for (const line of stderr.split('\n')) {
    const text = line.replace(/^[\s╷│╵]+/u, '').trim();
    if (text !== '') return text;
  }
  return 'no error output';
}

/**
 * `terraform output -raw image_registry`, or the refusal that names the one command that creates
 * the repository. The module creates the repository, so a first deploy has none yet; creating it
 * is left to the Owner so that what is applied stays what was shown (ADR-0094). Any other failure
 * (a backend, credential or lock error) is reported as Terraform's own first line, redacted.
 */
async function imageRegistry(request: ImageCopyRequest): Promise<string> {
  const { context, moduleDirectory, references, ownerEmail } = request;
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-raw', 'image_registry'],
    { show: false, accept: [0, 1] },
  );
  const registry = result.stdout.trim();
  if (result.status === 0 && IMAGE_REGISTRY.test(registry)) return registry;
  if (result.status !== 0 && !MISSING_OUTPUT.test(result.stderr)) {
    const redact = createRedactor({});
    throw new Error(
      `\`terraform -chdir=${moduleDirectory} output -raw image_registry\` failed: ` +
        `${redact(firstStderrLine(result.stderr))}\nNothing was applied.`,
    );
  }
  const images = CLOUD_RUN_IMAGES.map((name) => `${name}="${references[name]}"`).join(',');
  throw new Error(
    "The module's Artifact Registry repository does not exist yet, so the release images have " +
      'nowhere to be copied. Create it once, then run this again:\n' +
      `  terraform -chdir=${moduleDirectory} apply -target=google_artifact_registry_repository.images ` +
      `-var bootstrap_admin_email=${ownerEmail} -var 'images={${images}}'\n` +
      'Nothing was applied.',
  );
}

/** Whether `destination` is in the registry at its own digest, per `imagetools inspect`. */
async function isPresent(context: DeployContext, destination: string): Promise<boolean> {
  const inspected = await runStep(
    context,
    'docker',
    ['buildx', 'imagetools', 'inspect', destination, '--format', '{{json .Manifest}}'],
    { show: false, accept: [0, 1] },
  );
  return inspected.status === 0 && manifestDigest(inspected.stdout) === digestOf(destination);
}

/**
 * The references Cloud Run will pull: those already in Artifact Registry as they are, the rest
 * as `<image_registry>/<name>@<same digest>`. A copy is pending while `imagetools inspect` does
 * not find that destination at its digest. With pending copies the result is `null` and Terraform
 * must not run: without `apply` they are only listed; with it they are copied and verified, and
 * the Owner is sent back to `--plan`, so the first apply is one a plan showed (ADR-0094).
 *
 * @throws {Error} naming the exact `docker buildx imagetools create` commands when a copy fails,
 * and the one `terraform apply -target` command when the repository does not exist yet.
 */
export async function copyImagesToArtifactRegistry(
  request: ImageCopyRequest,
): Promise<CloudRunImageReferences | null> {
  const { context, references, apply, tag } = request;
  const outside = CLOUD_RUN_IMAGES.filter((name) => !isArtifactRegistryImage(references[name]));
  if (outside.length === 0) return references;

  const registry = await imageRegistry(request);
  const copied: Record<CloudRunImage, string> = { ...references };
  const copies: { name: CloudRunImage; source: string; destination: string }[] = [];
  for (const name of outside) {
    const destination = `${registry}/${name}@${digestOf(references[name])}`;
    copied[name] = destination;
    if (!(await isPresent(context, destination))) {
      copies.push({ name, source: references[name], destination });
    }
  }
  if (copies.length === 0) return copied;

  if (!apply) {
    for (const { source, destination } of copies) {
      context.out(`Would copy ${source} to ${destination}; re-run with --yes to copy.\n`);
    }
    return null;
  }

  try {
    for (const { name, source, destination } of copies) {
      await runStep(
        context,
        'docker',
        ['buildx', 'imagetools', 'create', '--tag', `${registry}/${name}:${tag}`, source],
        { show: true },
      );
      if (!(await isPresent(context, destination))) {
        throw new Error(`${destination} is not the release's digest after the copy`);
      }
    }
  } catch (error) {
    const host = registry.slice(0, registry.indexOf('/'));
    const commands = copies.map(({ name, source }) => copyCommand(source, registry, name, tag));
    throw new Error(
      `Could not copy the release images into ${registry}: ${error instanceof Error ? error.message : String(error)} ` +
        `If this account may not write to it, grant roles/artifactregistry.writer and run ` +
        `\`gcloud auth configure-docker ${host}\`, then re-run this, or copy them yourself:\n` +
        `${commands.map((command) => `  ${command}`).join('\n')}\n` +
        'Nothing was applied.',
      { cause: error },
    );
  }
  context.out('Images copied. Run --plan to review, then --yes.\n');
  return null;
}

/** A context for the steps that run before the deployment's own `.env` exists. */
export function copyContext(
  runner: DeployContext['runner'],
  env: NodeJS.ProcessEnv,
  directory: string,
): DeployContext {
  const redact = createRedactor({});
  return {
    runner,
    directory,
    env,
    cloud: 'gcp',
    out: (text) => void process.stdout.write(redact(text)),
    err: (text) => void process.stderr.write(redact(text)),
  };
}
