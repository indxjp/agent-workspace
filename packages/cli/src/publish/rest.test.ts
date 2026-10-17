import { describe, expect, it } from 'vitest';

import type { PublishTool } from './kit.ts';
import { createPublishRedactor, PublishRefusedError } from './kit.ts';
import { accessToken, callVendorJson } from './rest.ts';
import { fakeFetch, fakeRunner, jsonResponse, missingTool, testContext } from './test-support.ts';

const TOKEN = 'ya29.secret-token-value';
const GCLOUD: PublishTool = {
  name: 'gcloud',
  versionArgs: ['--version'],
  install: 'https://cloud.google.com/sdk/docs/install',
  docsUrl: 'https://cloud.google.com/sdk/docs',
};

describe('callVendorJson', () => {
  it('sends the bearer token, a JSON body and the run signal', async () => {
    const { fetch, calls } = fakeFetch(() => jsonResponse({ ok: true }));
    const { context } = testContext(fakeRunner({}).runner, { fetch });

    const response = await callVendorJson(context, {
      method: 'POST',
      url: 'https://host.example/v1/agents?x=1',
      token: TOKEN,
      body: { name: 'a' },
    });

    expect(response).toEqual({ status: 200, json: { ok: true } });
    expect(calls).toEqual([
      {
        url: 'https://host.example/v1/agents?x=1',
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: '{"name":"a"}',
        signal: context.signal,
      },
    ]);
  });

  it('parses JSON only when the response says it is JSON', async () => {
    const { fetch } = fakeFetch(() => new Response('{"a":1}', { status: 200 }));
    const { context } = testContext(fakeRunner({}).runner, { fetch });

    const response = await callVendorJson(context, {
      method: 'GET',
      url: 'https://host.example/x',
      token: TOKEN,
    });

    expect(response.json).toBeUndefined();
  });

  it('fails with the status and vendor code, never the body, the query or the token', async () => {
    const { fetch } = fakeFetch(() =>
      jsonResponse({ error: { status: 'PERMISSION_DENIED', message: 'secret detail' } }, 403),
    );
    const { context } = testContext(fakeRunner({}).runner, { fetch });

    const failing = callVendorJson(context, {
      method: 'GET',
      url: 'https://host.example/path?pageToken=abc',
      token: TOKEN,
    });

    await expect(failing).rejects.toThrow(
      'GET https://host.example/path answered 403 PERMISSION_DENIED',
    );
    await expect(failing).rejects.not.toThrow(/secret detail|pageToken|ya29/u);
  });

  it('returns an accepted non-2xx status instead of throwing, and still throws on others', async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith('/missing')
        ? jsonResponse({ error: { code: 'NotFound' } }, 404)
        : jsonResponse({}, 403),
    );
    const { context } = testContext(fakeRunner({}).runner, { fetch });
    const get = (path: string) =>
      callVendorJson(context, {
        method: 'GET',
        url: `https://host.example/${path}`,
        token: TOKEN,
        accept: [404],
      });

    await expect(get('missing')).resolves.toMatchObject({ status: 404 });
    await expect(get('denied')).rejects.toThrow('GET https://host.example/denied answered 403');
  });

  it('falls back to the status alone when the body has no vendor code', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>nope</html>', { status: 502 }));
    const { context } = testContext(fakeRunner({}).runner, { fetch });

    await expect(
      callVendorJson(context, { method: 'GET', url: 'https://host.example/x', token: TOKEN }),
    ).rejects.toThrow(/^GET https:\/\/host\.example\/x answered 502$/u);
  });
});

describe('accessToken', () => {
  it('conceals the trimmed token and never prints it', async () => {
    const { runner } = fakeRunner({ 'gcloud auth': { stdout: `${TOKEN}\n` } });
    const printed: string[] = [];
    const redactor = createPublishRedactor({});
    const { context } = testContext(runner, {
      conceal: redactor.conceal,
      out: (text) => printed.push(redactor.redact(text)),
      err: (text) => printed.push(redactor.redact(text)),
    });

    const token = await accessToken(
      context,
      GCLOUD,
      ['auth', 'print-access-token'],
      'gcloud auth login',
    );

    expect(token).toBe(TOKEN);
    expect(printed.join('')).toContain('$ gcloud auth print-access-token');
    expect(redactor.redact(`Bearer ${TOKEN}`)).not.toContain(TOKEN);
    expect(printed.join('')).not.toContain(TOKEN);
  });

  it('refuses an empty answer with the login hint', async () => {
    const { runner } = fakeRunner({ 'gcloud auth': { stdout: '\n' } });
    const { context } = testContext(runner);

    const empty = accessToken(context, GCLOUD, ['auth', 'print-access-token'], 'gcloud auth login');

    await expect(empty).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(empty).rejects.toMatchObject({
      message: 'gcloud printed no access token',
      fix: 'gcloud auth login',
    });
  });

  it('turns a failed call into a refusal that names the login command', async () => {
    const { runner } = fakeRunner({ 'gcloud auth': { status: 1, stderr: 'not logged in' } });
    const { context } = testContext(runner);

    const failing = accessToken(
      context,
      GCLOUD,
      ['auth', 'print-access-token'],
      'gcloud auth login',
    );

    await expect(failing).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(failing).rejects.toMatchObject({ fix: 'gcloud auth login' });
  });

  it('keeps the install message when the tool is missing', async () => {
    const { runner } = fakeRunner({ 'gcloud auth': missingTool() });
    const { context } = testContext(runner);

    await expect(
      accessToken(context, GCLOUD, ['auth', 'print-access-token'], 'gcloud auth login'),
    ).rejects.toThrow('gcloud is not installed or not on PATH');
  });
});
