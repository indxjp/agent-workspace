import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import { runStep, type DeployContext } from './steps.ts';

/** An image the Workers run, and where Cloudflare's registry holds it. */
export interface RegistryImage {
  readonly label: string;
  /** The reference in `.env`, digest-pinned. */
  readonly reference: string;
  /** What a local `docker tag` and `wrangler containers push` name it: content-addressed. */
  readonly localTag: string;
  /** The tag alone, `sha256-<digest>`. */
  readonly tag: string;
  /** What a Worker's configuration names after the push. */
  readonly registryReference: string;
}

export function registryImage(
  dotEnv: Readonly<Record<string, string>>,
  service: 'web' | 'gateway' | 'runner',
  account: string,
): RegistryImage {
  const key = ENV_IMAGE_KEYS[service];
  const reference = dotEnv[key]?.trim() ?? '';
  const digest = /@sha256:([0-9a-f]{64})$/u.exec(reference)?.[1];
  if (digest === undefined) {
    throw new Error(
      `${key} is ${JSON.stringify(reference)} in .env: it must be pinned by digest ` +
        '(name@sha256:<64 hex digits>), because the Cloudflare registry tag is the digest and an ' +
        'unchanged image is not pushed again. Nothing was run.',
    );
  }
  const tag = `sha256-${digest}`;
  // Already in Cloudflare's registry: the Workers run it as it is, and nothing is pushed.
  if (reference.startsWith('registry.cloudflare.com/')) {
    return { label: service, reference, localTag: reference, tag, registryReference: reference };
  }
  const repository = `agent-workspace-${service}`;
  return {
    label: service,
    reference,
    localTag: `${repository}:${tag}`,
    tag,
    registryReference: `registry.cloudflare.com/${account}/${repository}:${tag}`,
  };
}

/** Whether the registry already holds `image`: named there in `.env`, or its digest tag listed. */
export const inRegistry = (image: RegistryImage, listing: string) =>
  image.registryReference === image.reference || listing.includes(image.tag);

/** Push each image the registry does not hold yet: pull for `linux/amd64`, tag by digest, push. */
export async function pushImages(
  context: DeployContext,
  images: readonly RegistryImage[],
  listing: string,
): Promise<void> {
  for (const image of images) {
    if (inRegistry(image, listing)) {
      context.out(`Image ${image.label} (${image.tag}) is already in the Cloudflare registry.\n`);
      continue;
    }
    await runStep(context, 'docker', ['pull', '--platform', 'linux/amd64', image.reference], {
      show: false,
    });
    await runStep(context, 'docker', ['tag', image.reference, image.localTag], { show: false });
    await runStep(context, 'wrangler', ['containers', 'push', image.localTag], { show: true });
  }
}

/** Run `use` with `configuration` written to a file outside the project, then remove the file. */
export async function withTemporaryConfiguration<T>(
  fileName: string,
  configuration: unknown,
  use: (file: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), 'aw-cloudflare-'));
  try {
    const file = path.join(directory, fileName);
    await writeFile(file, JSON.stringify(configuration, null, 2) + '\n');
    return await use(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * A container Worker's rendered configuration with its image replaced by the one pushed to the
 * registry and the Worker named. It is deployed from a copy outside the project, so `main` is made
 * absolute. Wrangler validates the file before it applies `--name`, and refuses a `containers` entry
 * without a top-level `name`; the rendered file stays name-free so one file serves every
 * deployment (ADR-0125), and the name is stamped here, where `--name` is known.
 */
export async function registryConfiguration(
  source: string,
  image: RegistryImage,
  name: string,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(source, 'utf8'));
  } catch (error) {
    throw new Error(
      `${source} is not readable JSON: render the project again, or restore the file. Nothing was applied.`,
      { cause: error },
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${source} is not a JSON object. Nothing was applied.`);
  }
  const configuration = parsed as Record<string, unknown>;
  const containers = Array.isArray(configuration['containers']) ? configuration['containers'] : [];
  const main = typeof configuration['main'] === 'string' ? configuration['main'] : '';
  return {
    ...configuration,
    name,
    main: path.resolve(path.dirname(source), main),
    containers: containers.map((container: unknown) =>
      typeof container === 'object' && container !== null
        ? { ...container, image: image.registryReference }
        : container,
    ),
  };
}
