import { EngineImageConfigurationError } from '@agent-workspace/runtime/engine-images';
import { expect, it } from 'vitest';
import { engineImagesFor } from './manager-start.js';

it('runner manager engine images > refuses to start when no runtime image is configured at all, naming no value', () => {
  let caught: unknown;
  try {
    engineImagesFor({ NODE_ENV: 'production' });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineImageConfigurationError);
  const refusal = caught as EngineImageConfigurationError;
  expect(refusal.message).toMatch(/no engine runtime image is configured/u);
  expect(refusal.keys).toEqual([]);
});

it('runner manager engine images > refuses a tag-only image in production, which the control plane admits (ADR-0073 D5)', () => {
  let caught: unknown;
  try {
    engineImagesFor({
      NODE_ENV: 'production',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-workspace/runtime:dev',
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(EngineImageConfigurationError);
  const refusal = caught as EngineImageConfigurationError;
  expect(refusal.keys).toEqual(['claude-agent-sdk']);
  expect(refusal.message).toMatch(/sha256 digest/u);
  expect(refusal.message).not.toContain('agent-workspace/runtime:dev');
});

it('runner manager engine images > starts from a tag outside production, as compose.yaml runs it', () => {
  expect([
    ...engineImagesFor({
      NODE_ENV: 'development',
      AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK: 'agent-workspace/runtime:dev',
    }),
  ]).toEqual([['claude-agent-sdk', 'agent-workspace/runtime:dev']]);
});

it('runner manager engine images > starts from the legacy RUNTIME_IMAGE alone', () => {
  const image = `registry.example/runtime@sha256:${'a'.repeat(64)}`;
  const images = engineImagesFor({ NODE_ENV: 'production', RUNTIME_IMAGE: image });
  expect([...images]).toEqual([['claude-agent-sdk', image]]);
});
