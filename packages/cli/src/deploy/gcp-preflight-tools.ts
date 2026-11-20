/** The checks of the tools the deploy runs on this machine: gcloud, Terraform and Docker buildx. */
import { check, probe, type GcpPreflightCheck } from './gcp-preflight-check.ts';
import type { DeployContext } from './steps.ts';

const MINIMUM_TERRAFORM = [1, 8, 0] as const;
const GCLOUD_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const TERRAFORM_VERSION = '1.9.8';
const TERRAFORM_DOWNLOADS = 'https://developer.hashicorp.com/terraform/install';
const TERRAFORM_ARCHITECTURES: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' };
const DOCKER_BUILDX_INSTALL = 'https://docs.docker.com/build/concepts/overview/#install-buildx';

export interface DeployHost {
  readonly platform: string;
  readonly arch: string;
}

/**
 * The command that installs Terraform for this machine: the archive for its platform and
 * architecture when HashiCorp ships one this command can unpack, else the download page.
 */
function terraformInstall(platform: string, arch: string): string {
  const architecture = TERRAFORM_ARCHITECTURES[arch];
  if ((platform !== 'linux' && platform !== 'darwin') || architecture === undefined) {
    return TERRAFORM_DOWNLOADS;
  }
  const archive = `terraform_${TERRAFORM_VERSION}_${platform}_${architecture}.zip`;
  const release = `https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}`;
  return (
    'tmp="$(mktemp -d)" && mkdir -p ~/bin && ' +
    `curl -fsSLo "$tmp/${archive}" ${release}/${archive} && ` +
    `curl -fsSLo "$tmp/SHA256SUMS" ${release}/terraform_${TERRAFORM_VERSION}_SHA256SUMS && ` +
    `(cd "$tmp" && grep " ${archive}$" SHA256SUMS | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)) && ` +
    `unzip -oq "$tmp/${archive}" -d ~/bin && export PATH="$HOME/bin:$PATH"`
  );
}

function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (const [index, wanted] of minimum.entries()) {
    const have = parts[index] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== wanted) return have > wanted;
  }
  return true;
}

function terraformVersion(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && 'terraform_version' in parsed) {
      const version = parsed.terraform_version;
      return typeof version === 'string' ? version : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function checkGcloud(context: DeployContext): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'gcloud', ['--version']);
  return result.ok
    ? check('gcloud', 'The Google Cloud command line (gcloud) is installed', 'ok')
    : check(
        'gcloud',
        'The Google Cloud command line (gcloud) is not installed',
        'fail',
        GCLOUD_INSTALL_URL,
      );
}

export async function checkTerraform(
  context: DeployContext,
  host: DeployHost,
): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'terraform', ['version', '-json']);
  const version = result.ok ? terraformVersion(result.stdout) : undefined;
  return version !== undefined && atLeast(version, MINIMUM_TERRAFORM)
    ? check('terraform', `Terraform ${version} is installed`, 'ok')
    : check(
        'terraform',
        `Terraform ${MINIMUM_TERRAFORM.join('.')} or newer is not installed`,
        'fail',
        terraformInstall(host.platform, host.arch),
      );
}

export async function checkBuildx(context: DeployContext): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'docker', ['buildx', 'version']);
  return result.ok
    ? check('docker-buildx', 'Docker buildx is available to copy the images', 'ok')
    : check(
        'docker-buildx',
        'Docker buildx is not available to copy the images',
        'fail',
        DOCKER_BUILDX_INSTALL,
      );
}
