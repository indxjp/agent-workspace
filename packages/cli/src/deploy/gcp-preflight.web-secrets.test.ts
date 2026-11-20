import { describe, expect, it } from 'vitest';

import { PROJECT, requestUrl, setup, status } from './gcp-preflight.test-support.js';

type SecretStatuses = Record<string, number | Error>;

/** Answers each secret's `versions/latest` lookup with its status, or fails it. */
function secretFetch(answers: SecretStatuses): typeof fetch {
  return (url) => {
    const secret = /secrets\/([^/]+)\/versions\/latest$/u.exec(requestUrl(url))?.[1] ?? '';
    const answer = answers[secret];
    if (answer === undefined) return Promise.resolve(Response.json({ permissions: [] }));
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(Response.json({ state: 'ENABLED' }, { status: answer }));
  };
}

describe('web-secrets', () => {
  it('is absent when the project names no secret', async () => {
    const report = await setup().run();
    expect(status(report, 'web-secrets')).toBeUndefined();
  });

  it('reads only version metadata, never the payload, and passes when every secret has one', async () => {
    const { run, requests } = setup();
    const report = await run(false, {
      webSecrets: ['store-key'],
      fetch: (url, init) => {
        requests.push({ url: requestUrl(url), init });
        return Promise.resolve(Response.json({ state: 'ENABLED' }, { status: 200 }));
      },
    });
    expect(status(report, 'web-secrets')?.status).toBe('ok');
    const urls = requests.map((request) => request.url);
    expect(urls).toContain(
      `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/store-key/versions/latest`,
    );
    expect(urls.some((url) => url.includes(':access'))).toBe(false);
  });

  it('fails a missing secret with the commands a person runs, naming no value', async () => {
    const report = await setup().run(false, {
      webSecrets: ['store-key', 'store-token'],
      fetch: secretFetch({ 'store-key': 200, 'store-token': 404 }),
    });
    const entry = status(report, 'web-secrets');
    expect(entry?.status).toBe('fail');
    expect(entry?.title).toContain('store-token');
    expect(entry?.title).not.toContain('store-key are');
    expect(entry?.fix).toContain(`gcloud secrets versions add store-token --project ${PROJECT}`);
    expect(report.passed).toBe(false);
  });

  it.each([
    ['DISABLED', { state: 'DISABLED' }],
    ['DESTROYED', { state: 'DESTROYED' }],
    ['a body without a state', {}],
  ])('fails a latest version that is not enabled: %s', async (_label, body) => {
    const report = await setup().run(false, {
      webSecrets: ['store-key'],
      fetch: () => Promise.resolve(Response.json(body, { status: 200 })),
    });
    const entry = status(report, 'web-secrets');
    expect(entry?.status).toBe('fail');
    expect(entry?.fix).toContain(`gcloud secrets versions add store-key --project ${PROJECT}`);
    expect(entry?.fix).not.toContain('&&');
    expect(entry?.fix).toContain('if it does not exist, create it');
  });

  it('only warns when the deployer cannot tell', async () => {
    const refused = await setup().run(false, {
      webSecrets: ['store-key'],
      fetch: secretFetch({ 'store-key': 403 }),
    });
    expect(status(refused, 'web-secrets')?.status).toBe('warn');
    const down = await setup().run(false, {
      webSecrets: ['store-key'],
      fetch: secretFetch({ 'store-key': new Error('offline') }),
    });
    expect(status(down, 'web-secrets')?.status).toBe('warn');
  });
});
