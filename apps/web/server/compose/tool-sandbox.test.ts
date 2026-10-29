import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import type { AgentVersionToolBundle } from '@indx-workspace/contracts/agent-versions';

import { DomainError } from '../errors';
import { buildToolSandboxRequest, type ToolSandboxSources } from './tool-sandbox';

const SOURCE = new TextEncoder().encode('export default () => 1;\n');
const DIGEST = createHash('sha256').update(SOURCE).digest('hex');
const OTHER_DIGEST = 'b'.repeat(64);

function bundle(overrides: Partial<AgentVersionToolBundle> = {}): AgentVersionToolBundle {
  return {
    tool: 'get_order',
    digest: DIGEST,
    description: 'Look up an order',
    inputSchema: { type: 'object' },
    timeoutMs: 5_000,
    ...overrides,
  };
}

function sources(secrets: Record<string, string> = {}): ToolSandboxSources {
  return {
    bundle: (digest) => Promise.resolve(digest === DIGEST ? SOURCE : null),
    secret: (name) => Promise.resolve(secrets[name] ?? null),
    runToken: (runId) => Promise.resolve(`token-for-${runId}-0123456789`),
  };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error instanceof DomainError ? error.publicMessage : '';
}

describe('buildToolSandboxRequest', () => {
  it('serves the pinned bundle with the declared secrets and the union of the domains', async () => {
    const request = await buildToolSandboxRequest(
      'run-1',
      [
        bundle({ secrets: ['STRIPE_KEY'], allowedDomains: ['api.stripe.com'] }),
        bundle({
          tool: 'list_orders',
          secrets: ['STRIPE_KEY', 'CRM_TOKEN'],
          allowedDomains: ['api.stripe.com', '*.crm.test'],
        }),
      ],
      sources({ STRIPE_KEY: 'sk_1', CRM_TOKEN: 'crm_1' }),
    );

    expect(request.manifest.tools.map((tool) => tool.name)).toEqual(['get_order', 'list_orders']);
    expect(request.manifest.tools[0]).toMatchObject({
      digest: DIGEST,
      timeoutMs: 5_000,
      bundleBase64: Buffer.from(SOURCE).toString('base64'),
    });
    expect(request.manifest.env).toEqual({ CRM_TOKEN: 'crm_1', STRIPE_KEY: 'sk_1' });
    expect(request.allowedDomains).toEqual(['*.crm.test', 'api.stripe.com']);
    expect(request.run).toEqual({ runId: 'run-1', token: 'token-for-run-1-0123456789' });
  });

  it('asks for no domain when no tool declares network, so the sandbox gets no policy to enforce', async () => {
    const request = await buildToolSandboxRequest(
      'run-1',
      [bundle({ secrets: ['STRIPE_KEY'] }), bundle({ tool: 'list_orders' })],
      sources({ STRIPE_KEY: 'sk_1' }),
    );

    expect(request.allowedDomains).toEqual([]);
  });

  it('keys the sandbox by the tool set and the secret values, not by the run', async () => {
    const declared = [bundle({ secrets: ['STRIPE_KEY'] })];
    const first = await buildToolSandboxRequest('run-1', declared, sources({ STRIPE_KEY: 'a' }));
    const again = await buildToolSandboxRequest('run-2', declared, sources({ STRIPE_KEY: 'a' }));
    const rotated = await buildToolSandboxRequest('run-3', declared, sources({ STRIPE_KEY: 'b' }));

    expect(again.key).toBe(first.key);
    expect(rotated.key).not.toBe(first.key);
  });

  it('fails the run naming the secret that is not set', async () => {
    const message = await refusal(
      buildToolSandboxRequest('run-1', [bundle({ secrets: ['STRIPE_KEY'] })], sources()),
    );
    expect(message).toContain('code_tool_secret_missing');
    expect(message).toContain('STRIPE_KEY');
  });

  // @story US-STO-12
  it('[US-STO-12][unit][run] never reads a storage connection credential a stored version declares, and fails as missing', async () => {
    const name = 'STORAGE_CONNECTION_77777777777747778777777777777777';
    const reads: string[] = [];
    const message = await refusal(
      buildToolSandboxRequest('run-1', [bundle({ secrets: [name] })], {
        ...sources(),
        // The secret exists: a version stored before the contracts refused the name reaches here.
        secret: (secret) => {
          reads.push(secret);
          return Promise.resolve('{"target":"x","credential":{}}');
        },
      }),
    );
    expect(message).toContain('code_tool_secret_missing');
    expect(reads).toEqual([]);
  });

  it('fails the run naming a tool whose bundle is gone', async () => {
    const message = await refusal(
      buildToolSandboxRequest('run-1', [bundle({ digest: OTHER_DIGEST })], sources()),
    );
    expect(message).toContain('code_tool_bundle_missing');
    expect(message).toContain('get_order');
  });

  it('fails the run naming a tool a pre-sandbox push left without a declaration', async () => {
    const message = await refusal(
      buildToolSandboxRequest('run-1', [bundle({ description: undefined })], sources()),
    );
    expect(message).toContain('code_tool_unbundled');
    expect(message).toContain('get_order');
  });
});
