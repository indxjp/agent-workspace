import { describe, expect, it } from 'vitest';

import { ApiProblemError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { ToolBundlesClient } from './toolBundles.js';

const DIGEST = 'a'.repeat(64);
const bundle = { digest: DIGEST, sizeBytes: 12 };

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly toolBundles: ToolBundlesClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { toolBundles: new ToolBundlesClient(http), calls: api.calls };
}

describe('ToolBundlesClient.upload', () => {
  it.each([201, 200])('posts only contentBase64 and reads the %i answer', async (status) => {
    const { toolBundles, calls } = client(() => json(status, { bundle, created: status === 201 }));
    const stored = await toolBundles.upload({ contentBase64: 'aGVsbG8=' });
    expect(stored).toEqual({ bundle, created: status === 201 });
    const [call] = calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.href).toBe('https://aw.example.com/api/tool-bundles');
    expect(call?.json).toEqual({ contentBase64: 'aGVsbG8=' });
  });

  it('surfaces the unconfigured deployment by code', async () => {
    const { toolBundles } = client(() =>
      json(503, { error: { code: 'tool_bundles_not_configured', message: 'No store.' } }),
    );
    const failure = await toolBundles
      .upload({ contentBase64: 'aGVsbG8=' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('tool_bundles_not_configured');
  });
});

describe('ToolBundlesClient.get', () => {
  it('unwraps the bundle', async () => {
    const { toolBundles, calls } = client(() => json(200, { bundle }));
    expect(await toolBundles.get(DIGEST)).toEqual(bundle);
    expect(calls[0]?.url.href).toBe(`https://aw.example.com/api/tool-bundles/${DIGEST}`);
  });

  it('surfaces a missing bundle by code', async () => {
    const { toolBundles } = client(() =>
      json(404, { error: { code: 'tool_bundle_not_found', message: 'No bundle.' } }),
    );
    const failure = await toolBundles.get(DIGEST).catch((e: unknown) => e);
    expect((failure as ApiProblemError).status).toBe(404);
    expect((failure as ApiProblemError).code).toBe('tool_bundle_not_found');
  });
});
