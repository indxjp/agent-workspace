import { createExternalDriver } from '@agent-workspace/runtime/driver/external';
import { createVercelSandboxProvider } from '@agent-workspace/runtime/driver/vercel-sandbox';
import type { DriverOptions } from './manager-driver-settings.js';
import { engineImagesFor } from './manager-driver-settings.js';
import { noAgentStart } from './manager-driver-settings.js';
import { sealSecretFor } from './manager-driver-settings.js';
import { imagesFingerprint } from './manager-driver-settings.js';

/**
 * `RUNTIME_DRIVER=vercel-sandbox` (ADR-0120 LC1-LC4, LC6): one Vercel Sandbox microVM per session,
 * reached at its exposed-port URL with a per-sandbox bearer. It runs on the `external` driver's
 * implementation under its own driver id. The access token is not read here: a caller sends it with
 * each request (LC6). The team and project ids are identifiers, not secrets.
 */
export function vercelSandboxDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
): DriverOptions {
  const tier = env['VERCEL_PLAN_TIER']?.trim() || 'hobby';
  if (tier !== 'hobby' && tier !== 'pro') {
    throw new Error('runner manager: VERCEL_PLAN_TIER must be hobby or pro, or unset.');
  }
  const identifier = (name: 'VERCEL_TEAM_ID' | 'VERCEL_PROJECT_ID'): string => {
    // `AW_<NAME>` first: Vercel reserves the VERCEL_ prefix for its own variables, so a deploy
    // sets the team id under the other name.
    const value = (env[`AW_${name}`] ?? env[name])?.trim() ?? '';
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) {
      throw new Error(`runner manager: ${name} must be set when RUNTIME_DRIVER is vercel-sandbox.`);
    }
    return value;
  };
  const teamId = identifier('VERCEL_TEAM_ID');
  const projectId = identifier('VERCEL_PROJECT_ID');
  const gatewayUrl = env['GATEWAY_PUBLIC_URL']?.trim() ?? '';
  // LC2: the image is a digest-pinned reference in Vercel Container Registry, so the digest rule of
  // the other image-pinned drivers applies in production.
  const images = engineImagesFor(env);
  const driver = createExternalDriver<never, never>({
    provider: createVercelSandboxProvider({ teamId, projectId, tier }),
    driverId: 'vercel-sandbox',
    images,
    gatewayUrl,
    startAgent: noAgentStart,
    ...sealSecretFor(env, 'vercel-sandbox'),
  });
  return {
    driver,
    expectedDriver: 'vercel-sandbox',
    runtimeRequestUrl: (handle, requestPath) => driver.requestUrl(handle, requestPath),
    runtimeAuthHeaders: (handle) => driver.authHeaders(handle),
    configurationFingerprint: `vercel-sandbox:${tier}:${teamId}:${projectId}:${imagesFingerprint(images)}`,
    toolSandboxRefusal:
      'a tool sandbox is not started on the vercel-sandbox runtime: the restricted network policy a tool sandbox with allowedDomains needs is refused until the E7 proof (ADR-0120 LC4, LC5)',
  };
}
