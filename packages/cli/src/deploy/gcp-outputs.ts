import { firstStderrLine } from './cloud-run-images.ts';
import { field } from './gcp-json-fields.ts';
import { createRedactor } from './redact.ts';
import { runStep, type DeployContext } from './steps.ts';

/** `terraform output -raw <name>`, or `null` when the state has no such output yet. */
export async function readTerraformOutput(
  context: DeployContext,
  moduleDirectory: string,
  name: 'web_url' | 'image_registry' | 'load_balancer_ip',
): Promise<string | null> {
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-raw', name],
    { show: false, accept: [0, 1] },
  );
  const value = result.stdout.trim();
  return result.status === 0 && value !== '' ? value : null;
}

/**
 * `terraform output -json app_urls`: app name → its run.app URL (a string, or an object with a `url`).
 * Empty when the state has no such output yet, or when it is not that shape.
 */
export async function readAppUrls(
  context: DeployContext,
  moduleDirectory: string,
): Promise<Record<string, string>> {
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-json', 'app_urls'],
    { show: false, accept: [0, 1] },
  );
  if (result.status !== 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const urls: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const url = typeof value === 'string' ? value : field(value, 'url');
    if (typeof url === 'string' && url !== '') urls[name] = url;
  }
  return urls;
}

/**
 * The Owner's generated password, from the Terraform state. The one value printed by `aw deploy
 * production --show-owner-password`; no other path reads it.
 */
export async function readOwnerPassword(
  context: DeployContext,
  moduleDirectory: string,
): Promise<string> {
  const result = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'output', '-raw', 'bootstrap_admin_password'],
    { show: false, accept: [0, 1] },
  );
  const password = result.stdout.trim();
  if (result.status !== 0 || password === '') {
    throw new Error(
      'The Owner password is not in the Terraform state yet: run aw deploy production --yes first. ' +
        `Terraform said: ${createRedactor({})(firstStderrLine(result.stderr))}`,
    );
  }
  return password;
}
