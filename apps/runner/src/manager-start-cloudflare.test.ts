import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { expect, it } from 'vitest';
import { managerDriverOptions } from './manager-start.js';

const digest = `registry.example.com/agent-runtime@sha256:${'a'.repeat(64)}`;

const cloudflare = {
  RUNTIME_DRIVER: 'cloudflare-sandbox',
  CLOUDFLARE_SANDBOX_BRIDGE_URL: 'https://bridge.example.workers.dev',
  GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: digest,
};

it('runner manager cloudflare-sandbox composition (ADR-0120) > serves cloudflare-sandbox with its own driver id and refuses tool sandboxes by name', () => {
  const options = managerDriverOptions(cloudflare);
  expect(options.expectedDriver).toBe('cloudflare-sandbox');
  expect(options.configurationFingerprint).toBe(`cloudflare-sandbox:claude-agent-sdk=${digest}`);
  expect(options.toolSandboxes).toBeUndefined();
  expect(options.toolSandboxRefusal).toContain('LC5');
});

it('runner manager cloudflare-sandbox composition (ADR-0120) > refuses a missing or non-https bridge URL, and a missing or non-https gateway URL', () => {
  for (const url of [undefined, '', 'http://bridge.example.workers.dev']) {
    expect(() =>
      managerDriverOptions({ ...cloudflare, CLOUDFLARE_SANDBOX_BRIDGE_URL: url }),
    ).toThrow(/CLOUDFLARE_SANDBOX_BRIDGE_URL/u);
  }
  for (const url of [undefined, 'http://gateway.example.com']) {
    expect(() => managerDriverOptions({ ...cloudflare, GATEWAY_PUBLIC_URL: url })).toThrow(
      /gatewayUrl/u,
    );
  }
});

it('runner manager cloudflare-sandbox composition (ADR-0120) > LC2: production keeps the image digest pin', () => {
  expect(() => managerDriverOptions({ ...cloudflare, NODE_ENV: 'production' })).not.toThrow();
  expect(() =>
    managerDriverOptions({
      ...cloudflare,
      NODE_ENV: 'production',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'registry.example.com/agent-runtime:latest',
    }),
  ).toThrow(EngineImageConfigurationError);
});
