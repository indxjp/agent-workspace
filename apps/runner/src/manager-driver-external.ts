import { type RuntimeHandle } from '@agent-workspace/runtime/driver';
import {
  assertBuildIdPinnedTemplates,
  createE2bProvider,
  createExternalDriver,
} from '@agent-workspace/runtime/driver/external';
import { type EngineImageMap } from '@agent-workspace/runtime/engine-images';
import { createToolSandboxes, TOOL_SANDBOX_ENGINE } from './tool-sandbox.js';
import type { DriverOptions } from './manager-driver-settings.js';
import { engineImagesFor } from './manager-driver-settings.js';
import { noAgentStart } from './manager-driver-settings.js';
import { AGENT_RUNTIME_IDLE_SECONDS } from './manager-driver-settings.js';
import { sealSecretFor } from './manager-driver-settings.js';
import { imagesFingerprint } from './manager-driver-settings.js';
import { toolSandboxTimeoutSeconds } from './manager-driver-settings.js';

/**
 * `RUNTIME_DRIVER=external` with `EXTERNAL_PROVIDER=e2b` (ADR-0120 LC1-LC6): one E2B sandbox per
 * session, reached at its public URL with a per-sandbox bearer. The provider key is not read here:
 * a caller sends it with each request (LC6). `GATEWAY_PUBLIC_URL` is the sandbox-facing gateway
 * URL; its host is the only one a `none` sandbox may reach (LC3, LC4).
 */
export function externalDriverOptions(
  env: Readonly<Record<string, string | undefined>>,
): DriverOptions {
  const provider = env['EXTERNAL_PROVIDER']?.trim() ?? '';
  if (provider !== 'e2b') {
    throw new Error(
      'runner manager: EXTERNAL_PROVIDER must be e2b when RUNTIME_DRIVER is external.',
    );
  }
  const tier = env['E2B_PLAN_TIER']?.trim() || 'hobby';
  if (tier !== 'hobby' && tier !== 'pro') {
    throw new Error('runner manager: E2B_PLAN_TIER must be hobby or pro, or unset.');
  }
  const gatewayUrl = env['GATEWAY_PUBLIC_URL']?.trim() ?? '';
  // A template is `<name>:<build_id>`, not a digest (LC2), so the digest rule does not apply.
  const images = engineImagesFor(env, false);
  if (env['NODE_ENV'] === 'production') assertBuildIdPinnedTemplates(images);
  const driver = createExternalDriver<never, never>({
    provider: createE2bProvider({ tier }),
    images,
    gatewayUrl,
    startAgent: noAgentStart,
    sessionIdleSeconds: AGENT_RUNTIME_IDLE_SECONDS,
    ...sealSecretFor(env, 'external'),
  });
  const base = {
    driver,
    expectedDriver: 'external',
    runtimeRequestUrl: (handle: RuntimeHandle, requestPath: string) =>
      driver.requestUrl(handle, requestPath),
    runtimeAuthHeaders: (handle: RuntimeHandle) => driver.authHeaders(handle),
  } as const;
  // ADR-0120 LC5: the tool sandbox is a second `create()` on the same provider, from a template of
  // the tool-host image. Unset, a run that needs one is refused by name.
  const toolHostTemplate = env['AGENT_WORKSPACE_TOOL_HOST_IMAGE']?.trim() ?? '';
  if (toolHostTemplate === '') {
    return {
      ...base,
      configurationFingerprint: `external:e2b:${tier}:${imagesFingerprint(images)}`,
      toolSandboxRefusal:
        'a tool sandbox is not started on the external runtime: set AGENT_WORKSPACE_TOOL_HOST_IMAGE to the tool-host E2B template (ADR-0120 LC5)',
    };
  }
  const toolImages: EngineImageMap = new Map([[TOOL_SANDBOX_ENGINE, toolHostTemplate]]);
  if (env['NODE_ENV'] === 'production') assertBuildIdPinnedTemplates(toolImages);
  const toolDriver = createExternalDriver<never, never>({
    provider: createE2bProvider({ tier }),
    images: toolImages,
    gatewayUrl,
    startAgent: noAgentStart,
    workload: 'tool-host',
    ...sealSecretFor(env, 'external'),
  });
  return {
    ...base,
    configurationFingerprint: `external:e2b:${tier}:${imagesFingerprint(images)}+tools=${toolHostTemplate}`,
    toolSandboxes: createToolSandboxes({
      driver: toolDriver,
      driverId: 'external',
      // The manager serves the sandbox's /mcp, so the provider's access token stays here.
      origin: (handle, publicBase) => `${publicBase}/tool-sandboxes/${handle.id}`,
      upstream: (handle) => ({
        url: toolDriver.requestUrl(handle, '/mcp'),
        headers: toolDriver.accessHeaders(handle),
      }),
      recover: (id) => toolDriver.recover?.(id),
      timeoutSeconds: toolSandboxTimeoutSeconds(env),
    }),
  };
}
