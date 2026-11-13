import path from 'node:path';
import type { FakeRequestRecord } from '../generated-project/fake-anthropic.mjs';
import { JourneyFailure } from './harness.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export const HERE = import.meta.dirname;

/** What the renderer (`packages/sdk/src/project/render.ts`) writes for the surface. */
export const SURFACE_SOURCE = [
  "import { defineSurface } from '@indx-workspace/sdk/define';",
  '',
  'export default defineSurface({',
  "  name: 'main',",
  "  agent: 'assistant',",
  "  title: 'Ask us',",
  '  theme: {',
  "    colour: '#2F5FD0',",
  '  },',
  '});',
  '',
].join('\n');

export const AGENT_SOURCE = [
  "import { defineAgent } from '@indx-workspace/sdk/define';",
  '',
  'export default defineAgent({',
  "  name: 'assistant',",
  "  instructions: 'You are a helpful assistant.',",
  "  engine: 'claude-agent-sdk',",
  "  model: 'default',",
  '});',
  '',
].join('\n');

export const KEY = 'sk-ant-e2e-fake-0123456789abcdef';

export const NONCE = 'e2e-nonce-abc123';

export function record(overrides: Partial<FakeRequestRecord>): FakeRequestRecord {
  return {
    at: '2026-10-02T00:00:00.000Z',
    method: 'POST',
    path: '/v1/messages',
    model: 'claude-sonnet-4-5',
    stream: true,
    reply: `Fake Anthropic reply to ${NONCE}: the generated project answered.`,
    apiKey: KEY,
    ...overrides,
  };
}

export function failureOf(action: () => unknown): JourneyFailure {
  try {
    action();
  } catch (error) {
    if (error instanceof JourneyFailure) return error;
    throw error;
  }
  throw new Error('expected a JourneyFailure');
}
