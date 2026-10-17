/**
 * The deployment profile rendered to a Helm values overlay.
 *
 * The chart (`infra/helm/agent-workspace`) takes no store configuration of its own: it pulls three
 * `secretRef`s and is otherwise fully defaulted by its own `values.yaml`, and each cloud's
 * flavour file already sets that cloud's storage class and load-balancer annotation. The only
 * values an operator must supply, and the only ones a profile can know, are therefore the four
 * images — `values.yaml` ships all-zero placeholder digests precisely so an unconfigured install
 * cannot start. Rendering anything the chart already defaults would be the duplicated default this
 * unit exists to remove, so the overlay stays exactly this wide, plus `publicUrl` (`AW_PUBLIC_URL`,
 * ADR-0135) when `.env` carries one: the chart cannot default an origin only the operator knows.
 */
import { serializeProfileDocument } from '../profile-document.ts';
import type { DeploymentImages } from '../deployment.ts';
import type { DeploymentCloud, DeploymentProfile } from '../profile.ts';

/** The chart flavour file each cloud's cluster is installed with, beneath the rendered overlay. */
const CHART_FLAVOURS: Readonly<Record<DeploymentCloud, string | null>> = {
  aws: 'values-eks.yaml',
  gcp: 'values-gke.yaml',
  azure: 'values-aks.yaml',
  // The chart has no single-host flavour: a `local` deployment is the Compose project.
  local: null,
  // Vercel deploys Functions, not a cluster.
  vercel: null,
  // Cloudflare deploys Workers and Containers, not a cluster.
  cloudflare: null,
};

export interface HelmValuesArtefact {
  /** The chart flavour file this overlay is layered on top of. */
  readonly flavour: string;
  readonly contents: string;
}

/**
 * Why this profile gets no chart overlay, in words an operator can act on, or `null` when it gets
 * one.
 *
 * The chart serves remote S3 and GCS object stores. Azure's generated profile selects native Blob
 * provider, which its Container Apps Terraform module wires through managed identity; the chart
 * does not carry that Azure-specific identity and endpoint wiring. Rendering an AKS overlay would
 * therefore offer a deployment the chart cannot serve, so it is withheld and the reason is
 * printed. The chart also mounts no volume and runs with `readOnlyRootFilesystem: true`; with
 * `storage.objects: local-filesystem`,
 * `apps/web/server/composition/storage.ts` falls back to the local-filesystem provider rooted at
 * `AW_FILE_STORAGE_ROOT`, a path that does not exist on a read-only root — and every file write
 * fails at runtime instead of at install time.
 */
export function helmOverlaySkipReason(profile: DeploymentProfile): string | null {
  if (CHART_FLAVOURS[profile.cloud] === null) return null;
  if (profile.storage.objects.startsWith('s3://') || profile.storage.objects.startsWith('gcs://')) {
    return null;
  }
  if (profile.storage.objects === 'local-filesystem') {
    return (
      `No chart overlay was rendered: the chart serves a remote object bucket only, and this ` +
      `profile's ` +
      `storage.objects is ${profile.storage.objects}. The chart mounts no volume and runs with a ` +
      'read-only root filesystem, so a local-filesystem store would fail every file write at ' +
      'runtime rather than at install time. Deploy this profile with its Terraform artefact. ' +
      '`agent-workspace render` renders no overlay for this profile either, so installing the ' +
      'chart instead means writing the values file yourself — it carries the four image digests ' +
      'and nothing else.'
    );
  }
  return (
    `No chart overlay was rendered: the chart serves a remote object bucket only, and this ` +
    `profile's storage.objects is ${profile.storage.objects}. Its ` +
    'native provider and identity wiring live in the cloud Terraform target, not the chart. ' +
    'Deploy this profile with its Terraform artefact. `agent-workspace render` renders no overlay ' +
    'for this profile either, so installing the chart instead means writing the values file ' +
    'yourself — it carries the four image digests and nothing else.'
  );
}

/**
 * `images.runtime`, the chart's `engine → image` map (ENG-07, ADR-0073), as the third level of the
 * overlay's `images:` mapping.
 *
 * Appended rather than passed to `serializeProfileDocument`, whose grammar is the two-level
 * profile document and deliberately has no third level. The engine ids and digest references it
 * writes are plain scalars (`[a-z0-9-]` and a registry reference), so no quoting is ever needed.
 * Only the Claude engine has an image today; each later engine unit adds its own entry.
 */
function runtimeImagesBlock(images: DeploymentImages): string {
  return `  runtime:\n    claude-agent-sdk: ${images.runtime}\n`;
}

/**
 * Render the overlay, or `null` when the profile's cloud has no chart flavour, or when the chart
 * cannot serve the object store the profile names — `helmOverlaySkipReason` is the second case's
 * reason, and `create` prints it.
 *
 * The chart runs one image per Deployment (`templates/deployments.yaml`), so each of its four
 * image values is pinned from the reference the release set resolved for that component.
 * `runnerManager` takes the `runner` reference: the runner manager is the root `Dockerfile`'s
 * `runner` target, which `infra/release/build-and-push.sh` publishes under that name.
 */
export function renderHelmValues(
  profile: DeploymentProfile,
  images: DeploymentImages,
  publicUrl?: string,
): HelmValuesArtefact | null {
  const flavour = CHART_FLAVOURS[profile.cloud];
  if (flavour === null) return null;
  if (helmOverlaySkipReason(profile) !== null) return null;

  const contents = serializeProfileDocument(
    {
      // Before `images`, which must stay the last key for `runtimeImagesBlock` to nest under it.
      ...(publicUrl === undefined ? {} : { publicUrl }),
      images: {
        web: images.web,
        gateway: images.gateway,
        runnerManager: images.runner,
      },
    },
    [
      'Generated by create-agent-workspace from agent-workspace.yaml.',
      '',
      `  helm upgrade --install agent-workspace infra/helm/agent-workspace \\`,
      `    -f infra/helm/agent-workspace/${flavour} -f <this file>`,
      '',
      'Only the images are rendered: the chart defaults everything else, and the',
      `${flavour} flavour already sets this cloud's storage class and load-balancer annotation.`,
      '',
      ...(publicUrl === undefined
        ? []
        : [
            "publicUrl is AW_PUBLIC_URL from .env (ADR-0135): web's A2A agent cards and OAuth issuer.",
            '',
          ]),
      'One image per component, as the chart deploys them. runnerManager is the runner reference:',
      "the runner manager is the root Dockerfile's runner target, published under that name.",
      '',
      'DATABASE_URL, the object-store credential and the application secrets are NOT here. The',
      'chart reads them from the three Secrets named by external.* and secrets.* in values.yaml;',
      'create them from the rendered .env.',
    ],
  );
  // The runtime block is appended, so it nests under `images:` only while `images` is the
  // document's last key and `runnerManager` its last entry. Fail loudly if that ever stops holding
  // rather than silently reparent `runtime:` under whichever key came last.
  if (!contents.trimEnd().endsWith(images.runner)) {
    throw new Error(
      'renderHelmValues: images.runnerManager must be the last entry for runtimeImagesBlock to nest under images',
    );
  }
  return { flavour, contents: `${contents}${runtimeImagesBlock(images)}` };
}
