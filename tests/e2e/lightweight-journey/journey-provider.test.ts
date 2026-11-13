import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createAnthropicToolsHandler } from '../../journey/fake-anthropic-tools.mjs';
import fakeProvider from './fake-provider-worker.mjs';
import { wranglerConfig } from './fake-provider.mjs';
import { resourceNames } from './lanes.mjs';
import { cloudflareLane } from './journey-test-fixtures.js';

describe('the fake provider Worker (issue #831)', () => {
  const key = 'fake-key-for-the-test';

  const worker = (request: Request, env: { FAKE_PROVIDER_KEY?: string }) =>
    fakeProvider.fetch(request, env);

  const authorised = { 'x-api-key': key };

  it('answers 401 to a wrong or missing key and to a Worker with no secret', async () => {
    const url = 'https://provider.example/v1/models';
    expect((await worker(new Request(url), { FAKE_PROVIDER_KEY: key })).status).toBe(401);
    const wrong = new Request(url, { headers: { 'x-api-key': 'wrong' } });
    expect((await worker(wrong, { FAKE_PROVIDER_KEY: key })).status).toBe(401);
    const unset = new Request(url, { headers: authorised });
    expect((await worker(unset, {})).status).toBe(401);
  });

  it('lists models for the key, which is what setup’s probe asks', async () => {
    const response = await worker(
      new Request('https://provider.example/v1/models', { headers: authorised }),
      { FAKE_PROVIDER_KEY: key },
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('claude');
  });

  it('answers a message exactly as the node handler does', async () => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hello' }],
    });
    const viaWorker = await worker(
      new Request('https://provider.example/v1/messages', {
        method: 'POST',
        headers: { ...authorised, 'content-type': 'application/json' },
        body,
      }),
      { FAKE_PROVIDER_KEY: key },
    );
    const direct = createServer((request, response) => {
      void createAnthropicToolsHandler([], [])(request, response);
    });
    await new Promise<void>((resolve) => direct.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = direct.address() as AddressInfo;
      const reference = await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(viaWorker.status).toBe(reference.status);
      expect(await viaWorker.text()).toBe(await reference.text());
    } finally {
      direct.close();
    }
  });

  it('is deployed under the run’s derived name with node compatibility and no secret in its config', () => {
    const config = wranglerConfig(resourceNames(cloudflareLane, '42').fakeProvider);
    expect(JSON.parse(config)).toMatchObject({
      name: resourceNames(cloudflareLane, '42').fakeProvider,
      compatibility_flags: ['nodejs_compat'],
      workers_dev: true,
    });
    expect(config).not.toContain('FAKE_PROVIDER_KEY');
  });
});
