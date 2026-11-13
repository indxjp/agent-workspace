import { describe, expect, it } from 'vitest';

import { runCompatibilitySuite } from '../../../../tests/providers/harness.js';
import { buildAzureOpenAIUrl, createAzureOpenAIProvider } from './azure-openai.js';
import {
  AZURE_CONTEXT_KEY,
  azureContext,
  FIXTURE_DEPLOYMENT,
  fixtureServerStarter,
  MISNAMED_MODEL_REQUEST,
  responseBody,
} from './azure-openai.test-support.js';

const RESOURCE = 'https://example-resource.openai.azure.com';
const DATED_PREVIEW_VERSION = '2025-04-01-preview';

const startFixtureServer = fixtureServerStarter();

/** A provider whose upstream always answers with `upstream`. */
function providerAnswering(upstream: () => Response) {
  return createAzureOpenAIProvider({
    endpoint: 'http://localhost',
    deployment: FIXTURE_DEPLOYMENT,
    fetch: () => Promise.resolve(upstream()),
  });
}

describe('Azure OpenAI provider compatibility', () => {
  it('passes the ten required scenarios and publishes every optional matrix cell', async () => {
    const fixture = await startFixtureServer();
    const report = await runCompatibilitySuite(
      createAzureOpenAIProvider({ endpoint: fixture.endpoint, deployment: FIXTURE_DEPLOYMENT }),
    );
    expect(report.ok).toBe(true);
    expect(report.outcomes).toHaveLength(14);
    expect(report.outcomes.slice(0, 10).every((outcome) => outcome.verdict === 'native')).toBe(
      true,
    );
    expect(report.outcomes.slice(10).map((outcome) => outcome.verdict)).toEqual([
      'unsupported',
      'unsupported',
      'native',
      'unsupported',
    ]);
  });
});

describe('Azure OpenAI URLs', () => {
  it('builds R-05 legacy and v1 URLs without substituting a model name for deployment', () => {
    expect(buildAzureOpenAIUrl(RESOURCE, 'my-deployment', '2024-10-21', 'chat/completions')).toBe(
      `${RESOURCE}/openai/deployments/my-deployment/chat/completions?api-version=2024-10-21`,
    );
    expect(buildAzureOpenAIUrl(RESOURCE, 'my-deployment', undefined, 'responses')).toBe(
      `${RESOURCE}/openai/v1/responses`,
    );
  });

  it('keeps the input_tokens suffix on the dated surface so counting is never a generation', () => {
    expect(
      buildAzureOpenAIUrl(
        RESOURCE,
        'my-deployment',
        DATED_PREVIEW_VERSION,
        'responses/input_tokens',
      ),
    ).toBe(`${RESOURCE}/openai/responses/input_tokens?api-version=${DATED_PREVIEW_VERSION}`);
    expect(buildAzureOpenAIUrl(RESOURCE, 'd', DATED_PREVIEW_VERSION, 'responses')).toBe(
      `${RESOURCE}/openai/responses?api-version=${DATED_PREVIEW_VERSION}`,
    );
  });
});

describe('Azure OpenAI upstream answers', () => {
  it('absorbs Azure content filtering into an Anthropic refusal response', async () => {
    const provider = providerAnswering(() =>
      Response.json(
        { error: { code: 'content_filter', message: 'The prompt was filtered by Azure.' } },
        { status: 400 },
      ),
    );
    const response = await provider.createMessage(MISNAMED_MODEL_REQUEST, azureContext());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stop_reason: 'refusal',
      content: [],
      stop_details: { type: 'refusal', category: null },
    });
  });

  it('normalizes a 429 and does not leak Azure rate-limit headers', async () => {
    const provider = providerAnswering(() =>
      Response.json(
        { error: { message: 'Rate limit exceeded' } },
        {
          status: 429,
          headers: { 'retry-after-ms': '2000', 'x-ratelimit-limit-tokens': '1000' },
        },
      ),
    );
    const response = await provider.createMessage(MISNAMED_MODEL_REQUEST, azureContext());
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after-ms')).toBeNull();
    expect(response.headers.get('x-ratelimit-limit-tokens')).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    });
  });
});

describe('Azure OpenAI outgoing request', () => {
  it('refuses redirects and sources the key only from RequestContext', async () => {
    let init: RequestInit | undefined;
    const provider = createAzureOpenAIProvider({
      endpoint: 'http://localhost',
      deployment: FIXTURE_DEPLOYMENT,
      fetch: (_input, received) => {
        init = received;
        return Promise.resolve(Response.json(responseBody([])));
      },
    });
    await provider.createMessage(MISNAMED_MODEL_REQUEST, azureContext());
    // W9-PROV-127's shared egress guard requests with `redirect: 'error'` at every provider
    // call site, superseding this adapter's own former `redirect: 'manual'`.
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('api-key')).toBe(AZURE_CONTEXT_KEY);
    expect(typeof init?.body).toBe('string');
    const sent: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    expect(sent).toMatchObject({ model: FIXTURE_DEPLOYMENT });
  });
});
