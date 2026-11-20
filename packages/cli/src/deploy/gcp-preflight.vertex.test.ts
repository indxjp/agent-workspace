import { describe, expect, it } from 'vitest';

import { renderPreflightReport } from './gcp-preflight.js';
import {
  ONLY_RUN_ENABLED,
  PROJECT,
  SERVICES_ENABLE_COMMAND,
  SERVICES_LIST_COMMAND,
  TOKEN,
  ok,
  setup,
  status,
} from './gcp-preflight.test-support.js';

const MODEL = 'claude-sonnet-5-5';
const GARDEN = `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${MODEL}?project=${PROJECT}`;

describe('vertex-model request', () => {
  it('sends one 1-token rawPredict with the bearer token and says where Claude answers', async () => {
    const { run, requests } = setup();
    const report = await run();
    const sent = requests[1];
    expect(sent?.url).toBe(
      `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/anthropic/models/${MODEL}:rawPredict`,
    );
    expect(sent?.init?.method).toBe('POST');
    expect(JSON.stringify(sent?.init?.headers)).toContain(`Bearer ${TOKEN}`);
    expect(JSON.parse(sent?.init?.body as string)).toEqual({
      anthropic_version: 'vertex-2023-10-16',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
    expect(status(report, 'vertex-model')).toEqual({
      id: 'vertex-model',
      title: `Claude (${MODEL}) answers in global`,
      status: 'ok',
    });
  });

  it('uses the regional host for us and eu', async () => {
    const us = setup({ modelLocation: 'us' });
    await us.run();
    expect(us.requests[1]?.url).toBe(
      `https://aiplatform.us.rep.googleapis.com/v1/projects/${PROJECT}/locations/us/publishers/anthropic/models/${MODEL}:rawPredict`,
    );
    const eu = setup({ modelLocation: 'eu' });
    const report = await eu.run();
    expect(eu.requests[1]?.url).toContain('https://aiplatform.eu.rep.googleapis.com/');
    expect(status(report, 'vertex-model')?.title).toBe(`Claude (${MODEL}) answers in eu`);
  });
});

describe('vertex-model warnings', () => {
  it.each([
    [404, 'secret detail'],
    [403, 'Publisher Model `claude-sonnet-5-5` is not enabled'],
  ])(
    'warns on %i with the Model Garden page as the fix, and still passes',
    async (code, message) => {
      const report = await setup({ vertex: code, vertexMessage: message }).run();
      expect(status(report, 'vertex-model')).toMatchObject({
        status: 'warn',
        title: expect.stringContaining(
          `Claude ${MODEL} is not enabled for your Google Cloud project`,
        ) as unknown,
        fix: GARDEN,
      });
      expect(report.passed).toBe(true);
    },
  );

  it('warns, naming the cause, when the deployer lacks aiplatform.endpoints.predict', async () => {
    const report = await setup({
      vertex: 403,
      vertexMessage: "Permission 'aiplatform.endpoints.predict' denied on resource",
      vertexReason: 'PERMISSION_DENIED',
    }).run();
    expect(status(report, 'vertex-model')?.status).toBe('warn');
    expect(status(report, 'vertex-model')?.title).toContain('aiplatform.endpoints.predict');
    expect(report.passed).toBe(true);
  });

  it('warns to retry in a minute when the API was only just enabled', async () => {
    const report = await setup({
      vertex: 403,
      vertexMessage: 'Vertex AI API has not been used in project 1 before or it is disabled.',
      vertexReason: 'PERMISSION_DENIED',
    }).run();
    expect(status(report, 'vertex-model')?.status).toBe('warn');
    expect(status(report, 'vertex-model')?.title).toContain('again in a minute');
    expect(report.passed).toBe(true);
  });

  it('warns on 429 with the quotas page, and still passes', async () => {
    const report = await setup({ vertex: 429, modelLocation: 'eu' }).run();
    const entry = status(report, 'vertex-model');
    expect(entry?.status).toBe('warn');
    expect(entry?.title).toBe('The quota for Claude in eu is exhausted');
    expect(entry?.fix).toContain(
      `https://console.cloud.google.com/iam-admin/quotas?project=${PROJECT}`,
    );
    expect(entry?.fix).toContain('anthropic-claude-sonnet');
    expect(report.passed).toBe(true);
  });

  it.each([500, 400])('warns that it could not check on %i', async (code) => {
    const report = await setup({ vertex: code }).run();
    expect(status(report, 'vertex-model')?.status).toBe('warn');
    expect(status(report, 'vertex-model')?.title).toContain('Could not check');
    expect(report.passed).toBe(true);
  });

  it('warns that it could not check on a network error, without the error text', async () => {
    const report = await setup({ vertex: new Error(`connect ECONNREFUSED ${TOKEN}`) }).run();
    expect(status(report, 'vertex-model')?.status).toBe('warn');
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
  });
});

describe('vertex-model and the Vertex AI API', () => {
  const apiNotEnabled = { [SERVICES_LIST_COMMAND]: ONLY_RUN_ENABLED };

  it('waits for the API when it is not enabled and sends nothing', async () => {
    const { run, requests } = setup({ overrides: apiNotEnabled });
    const report = await run();
    expect(requests.some(({ url }) => url.includes('rawPredict'))).toBe(false);
    expect(status(report, 'vertex-model')).toMatchObject({
      status: 'warn',
      title: 'Claude is checked once the Vertex AI API is enabled',
    });
  });

  it('checks after the API was enabled by --yes', async () => {
    const { run, requests } = setup({
      overrides: { ...apiNotEnabled, [SERVICES_ENABLE_COMMAND]: ok() },
    });
    const report = await run(true);
    expect(requests.some(({ url }) => url.includes('rawPredict'))).toBe(true);
    expect(status(report, 'vertex-model')?.status).toBe('ok');
  });

  it('never puts the token in the report', async () => {
    const report = await setup({ vertex: 403 }).run();
    expect(JSON.stringify(report) + renderPreflightReport(report)).not.toContain(TOKEN);
  });
});
