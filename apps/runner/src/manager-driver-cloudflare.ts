import { createCloudflareSandboxDriver } from '@agent-workspace/runtime/driver/cloudflare-sandbox';
import type { DriverOptions } from './manager-driver-settings.js';
import { engineImagesFor } from './manager-driver-settings.js';
import { noAgentStart } from './manager-driver-settings.js';
import { imagesFingerprint } from './manager-driver-settings.js';

/**
 * `RUNTIME_DRIVER=cloudflare-sandbox` (ADR-0120 LC1-LC4, LC6): one Cloudflare Container per session
 * behind the bridge Worker at `CLOUDFLARE_SANDBOX_BRIDGE_URL`. The bridge secret is not read here: a
 * caller sends it with each request (LC6). Images keep their digest pin in production (LC2).
 */
export function cloudflareSandboxDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
): DriverOptions {
  const bridgeUrl = env['CLOUDFLARE_SANDBOX_BRIDGE_URL']?.trim() ?? '';
  if (!bridgeUrl.startsWith('https://') || !URL.canParse(bridgeUrl)) {
    throw new Error(
      'runner manager: CLOUDFLARE_SANDBOX_BRIDGE_URL must be an https URL when RUNTIME_DRIVER is cloudflare-sandbox.',
    );
  }
  const images = engineImagesFor(env);
  const driver = createCloudflareSandboxDriver<never, never>({
    bridgeUrl,
    images,
    gatewayUrl: env['GATEWAY_PUBLIC_URL']?.trim() ?? '',
    startAgent: noAgentStart,
  });
  return {
    driver,
    expectedDriver: 'cloudflare-sandbox',
    runtimeRequestUrl: (handle, requestPath) => driver.requestUrl(handle, requestPath),
    runtimeAuthHeaders: (handle) => driver.authHeaders(handle),
    configurationFingerprint: `cloudflare-sandbox:${imagesFingerprint(images)}`,
    toolSandboxRefusal:
      'a tool sandbox is not started on the cloudflare-sandbox runtime yet (ADR-0120 LC5)',
  };
}
