/**
 * Everything `create-agent-workspace` writes, as a pure function of the deployment profile.
 *
 * Keeping the whole artefact set in one pure function is what makes the generator's refusals
 * total: `create` renders first, and only then touches the filesystem, so a profile the schema or
 * a renderer refuses leaves no partial project behind. It is also what the per-cloud golden files
 * pin — one committed artefact set per `--cloud` value, with secrets and digests stubbed.
 *
 * The Compose file is not here. It is copied verbatim from `templates/compose.yaml`, consumes the
 * rendered `.env` through `${VAR:?…}` interpolation, and is therefore the same bytes for every
 * profile that selects it.
 */
import type { DeploymentImages } from '../deployment.ts';
import { renderProfileDocument, type DeploymentProfile } from '../profile.ts';
import { renderCloudflareProject } from './cloudflare.ts';
import { renderEnv, type EnvRenderInput } from './env.ts';
import { renderHelmValues } from './helm-values.ts';
import { renderTerraformVariables, type TerraformVariableOptions } from './terraform-vars.ts';
import { renderVercelPartSettings, renderVercelProject } from './vercel.ts';

export interface RenderedArtefact {
  /** Path relative to the generated project directory. */
  readonly path: string;
  readonly contents: string;
}

/**
 * The generated project's `.gitignore`, for every `--cloud` value.
 *
 * `.env` is the one artefact that holds a live credential, and every cloud renders it with the
 * same generated secrets the Compose project gets; `docs/deploy/kubernetes.md` then tells the
 * operator to keep that directory next to `deploy/`, which is exactly what they will commit. It
 * is rendered rather than shipped in `templates/` for two reasons: `templates/` is copied for
 * `local` alone, and npm's packlist never publishes a file named `.gitignore`, so a template copy
 * would not reach anyone running the published generator.
 */
const GITIGNORE = [
  "# .env is this deployment's secrets: the generated administrator password, the session,",
  '# gateway and runner-manager tokens, the master encryption key and every store credential.',
  '# The profile beside it, agent-workspace.yaml, is the file that belongs in version control.',
  '.env',
  '',
].join('\n');

/**
 * The cloud artefacts the profile selects under `deploy/`: a Helm overlay and a Terraform variables
 * file, each only where the profile has that target. They take nothing but the profile, the
 * image references and the deployment's policy ceiling, which is what lets `agent-workspace
 * render` re-render them without the secrets `.env` holds.
 */
export function renderDeployArtefacts(
  profile: DeploymentProfile,
  images: DeploymentImages,
  options: TerraformVariableOptions = {},
): readonly RenderedArtefact[] {
  const artefacts: RenderedArtefact[] = [];

  const helm = renderHelmValues(profile, images, options.publicUrl);
  if (helm !== null) artefacts.push({ path: 'deploy/helm/values.yaml', contents: helm.contents });

  const terraform = renderTerraformVariables(profile, images, options);
  if (terraform !== null) {
    artefacts.push({
      path: `deploy/terraform/${terraform.fileName}`,
      contents: terraform.contents,
    });
  }

  const vercel = renderVercelProject(profile);
  if (vercel !== null) {
    artefacts.push({
      path: 'deploy/' + vercel.directory + '/' + vercel.fileName,
      contents: vercel.contents,
    });
  }

  for (const part of renderVercelPartSettings(profile)) {
    artefacts.push({
      path: 'deploy/' + part.directory + '/' + part.fileName,
      contents: part.contents,
    });
  }

  const cloudflare = renderCloudflareProject(profile, images);
  if (cloudflare !== null) {
    for (const file of cloudflare.files) {
      artefacts.push({
        path: 'deploy/' + cloudflare.directory + '/' + file.fileName,
        contents: file.contents,
      });
    }
  }

  return artefacts;
}

/** The profile document, the environment, and whichever cloud artefacts the profile selects. */
export function renderDeploymentArtefacts(input: EnvRenderInput): readonly RenderedArtefact[] {
  return [
    { path: 'agent-workspace.yaml', contents: renderProfileDocument(input.profile) },
    { path: '.env', contents: renderEnv(input) },
    { path: '.gitignore', contents: GITIGNORE },
    ...renderDeployArtefacts(input.profile, input.images),
  ];
}
