import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { expect, it } from 'vitest';
import { managerDriverOptions } from './manager-start.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

const IMAGE = `registry.example.com/agent-runtime@${DIGEST}`;

const vercel = {
  RUNTIME_DRIVER: 'vercel-sandbox',
  VERCEL_TEAM_ID: 'team_abc123',
  VERCEL_PROJECT_ID: 'prj_abc123',
  GATEWAY_PUBLIC_URL: 'https://gateway.example.com',
  AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: IMAGE,
};

it('runner manager vercel-sandbox composition (ADR-0120) > serves vercel-sandbox with its own driver id and refuses tool sandboxes by name', () => {
  const options = managerDriverOptions(vercel);
  expect(options.expectedDriver).toBe('vercel-sandbox');
  expect(options.configurationFingerprint).toBe(
    `vercel-sandbox:hobby:team_abc123:prj_abc123:claude-agent-sdk=${IMAGE}`,
  );
  expect(options.toolSandboxes).toBeUndefined();
  expect(options.toolSandboxRefusal).toContain('LC5');
  expect(options.toolSandboxRefusal).toContain('vercel-sandbox');
});

it('runner manager vercel-sandbox composition (ADR-0120) > refuses a missing team or project, an unknown tier and a non-https gateway URL', () => {
  expect(() => managerDriverOptions({ ...vercel, VERCEL_TEAM_ID: undefined })).toThrow(
    /VERCEL_TEAM_ID/u,
  );
  expect(() => managerDriverOptions({ ...vercel, VERCEL_PROJECT_ID: 'a b' })).toThrow(
    /VERCEL_PROJECT_ID/u,
  );
  expect(() => managerDriverOptions({ ...vercel, VERCEL_PLAN_TIER: 'free' })).toThrow(
    /VERCEL_PLAN_TIER/u,
  );
  expect(() =>
    managerDriverOptions({ ...vercel, GATEWAY_PUBLIC_URL: 'http://gateway.example.com' }),
  ).toThrow(/https/u);
  expect(
    managerDriverOptions({ ...vercel, VERCEL_PLAN_TIER: 'pro' }).configurationFingerprint,
  ).toMatch(/^vercel-sandbox:pro:/u);
});

it('runner manager vercel-sandbox composition (ADR-0120) > LC2: production requires a digest-pinned image', () => {
  expect(() => managerDriverOptions({ ...vercel, NODE_ENV: 'production' })).not.toThrow();
  expect(() =>
    managerDriverOptions({
      ...vercel,
      NODE_ENV: 'production',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'registry.example.com/agent-runtime:latest',
    }),
  ).toThrow(EngineImageConfigurationError);
});
