import { vi } from 'vitest';
import type { RuntimeConfig, RuntimeHandle } from '@agent-workspace/runtime/driver';
import {
  createToolSandboxes,
  parseToolSandboxRequest,
  type ToolSandboxDriver,
} from './tool-sandbox.js';

export const SECRET = 'sk-live-do-not-print-0123456789';

export const TOKEN = 'a-run-token-0123456789';

export const MANAGER_TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

export const request = (overrides: Record<string, unknown> = {}) => ({
  key: 'tools-1',
  manifest: {
    tools: [
      {
        name: 'get_order',
        description: 'Looks up an order.',
        inputSchema: { type: 'object' },
        timeoutMs: 5_000,
        digest: 'a'.repeat(64),
        bundleBase64: Buffer.from('export default () => 1;').toString('base64'),
      },
    ],
    env: { ORDERS_API_KEY: SECRET },
  },
  allowedDomains: ['api.example.com'],
  run: { runId: 'run_1', token: TOKEN },
  ...overrides,
});

export function hostedHandle(): RuntimeHandle {
  return {
    id: 'sealed-id',
    driver: 'external',
    externalId: 'sbx1',
    workspacePath: '/w',
    createdAt: new Date(),
  };
}

export function parsedRequest(overrides: Record<string, unknown> = {}) {
  return parseToolSandboxRequest(request(overrides));
}

export function localSandboxes(driver: ToolSandboxDriver) {
  return createToolSandboxes({ driver, origin, fetch: serving() });
}

export function fakeDriver(options: { live?: boolean | (() => boolean) } = {}) {
  const files: { id: string; name: string; content: string }[] = [];
  const created: RuntimeConfig[] = [];
  const destroyed: string[] = [];
  let count = 0;
  const driver: ToolSandboxDriver = {
    create: (config) => {
      created.push(config);
      count += 1;
      const handle: RuntimeHandle = {
        id: `tool-${String(count)}`,
        driver: 'docker',
        externalId: `container-${String(count)}`,
        workspacePath: config.workspacePath,
        createdAt: new Date(),
      };
      return Promise.resolve(handle);
    },
    destroy: (handle) => {
      destroyed.push(handle.id);
      return Promise.resolve();
    },
    isLive: () =>
      Promise.resolve(typeof options.live === 'function' ? options.live() : (options.live ?? true)),
    writeFile: (handle, name, content) => {
      files.push({ id: handle.id, name, content });
      return Promise.resolve();
    },
  };
  return { driver, files, created, destroyed };
}

export const serving = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 401 })));

export const session = {
  key: 'profile-one:session-one',
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  workspacesRoot: '/srv/runtimes',
};

export const origin = (handle: RuntimeHandle) => `http://sandbox-${handle.id}:8788`;
