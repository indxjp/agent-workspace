import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { publishPlatform } from './index.ts';
import { PublishRefusedError } from './kit.ts';
import { fakeFetch, fakeRunner, jsonResponse, type FetchCall } from './test-support.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const TOKEN = 'ya29.test-token';
const CARD_URL = 'https://aw.example.com/api/a2a/agents/support-triage/.well-known/agent-card.json';
const COLLECTION =
  'https://global-discoveryengine.googleapis.com/v1alpha/projects/acme-agents/locations/global/collections/default_collection/engines/acme-support-app/assistants/default_assistant/agents';
const AGENT_ID = '7071113322';

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as unknown;
}

async function exportDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'gemini-publish-'));
  directories.push(directory);
  await copyFile(
    new URL('gemini-register-agent.request.json', FIXTURES),
    path.join(directory, 'register-agent.request.json'),
  );
  return directory;
}

interface Setup {
  readonly list?: unknown;
  readonly pages?: (call: FetchCall) => unknown;
  readonly listResponse?: Response;
  readonly card?: () => Response;
  readonly apply?: boolean;
  readonly directory?: string;
}

async function setup(options: Setup = {}) {
  const directory = options.directory ?? (await exportDirectory());
  const toolCalls = fakeRunner({
    'gcloud --version': { stdout: 'Google Cloud SDK 540.0.0\n' },
    'gcloud auth': { stdout: `${TOKEN}\n` },
  });
  const http = fakeFetch((call) => {
    if (call.url === CARD_URL) return options.card?.() ?? jsonResponse({}, 200);
    if (call.method === 'GET') {
      if (options.listResponse !== undefined) return options.listResponse;
      return jsonResponse(options.pages?.(call) ?? options.list ?? { agents: [] });
    }
    return jsonResponse({ name: 'written' });
  });
  const output: string[] = [];
  const outcome = (settings: unknown = {}) =>
    publishPlatform({
      platform: 'gemini-enterprise',
      directory,
      agent: 'support-triage',
      settings: settings as Record<string, unknown>,
      apply: options.apply ?? false,
      experimental: false,
      runner: toolCalls.runner,
      fetch: http.fetch,
      env: {},
      out: (text) => output.push(text),
      err: (text) => output.push(text),
    });
  return { directory, outcome, tools: toolCalls.calls, http: http.calls, output };
}

describe('gemini-enterprise executor', () => {
  it('plans a POST when nothing is registered, and writes nothing without apply', async () => {
    const { outcome, tools, http, output } = await setup({
      list: await fixture('gemini-list-empty.json'),
    });

    await expect(outcome()).resolves.toMatchObject({ changes: true, applied: false });

    expect(tools.map((call) => [call.tool, ...call.args])).toEqual([
      ['gcloud', '--version'],
      ['gcloud', 'auth', 'print-access-token'],
    ]);
    expect(http.map((call) => [call.method, call.url])).toEqual([
      ['GET', CARD_URL],
      ['GET', COLLECTION],
    ]);
    expect(http[0]?.headers['authorization']).toBeUndefined();
    expect(http[1]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(output.join('')).toContain(`POST ${COLLECTION}`);
  });

  it('applies by POSTing the exported body, with the card as a string and the authorization', async () => {
    const { outcome, http } = await setup({
      apply: true,
      list: await fixture('gemini-list-empty.json'),
    });

    await expect(outcome()).resolves.toMatchObject({ changes: true, applied: true });

    const post = http.at(-1);
    expect(post).toMatchObject({ method: 'POST', url: COLLECTION });
    const body = JSON.parse(post?.body ?? '') as {
      a2aAgentDefinition: { jsonAgentCard: unknown };
      authorizationConfig: unknown;
    };
    expect(typeof body.a2aAgentDefinition.jsonAgentCard).toBe('string');
    expect(body.authorizationConfig).toEqual({
      agentAuthorization: 'projects/acme-agents/locations/global/authorizations/aw-oauth',
    });
    expect(body).toEqual(
      ((await fixture('gemini-register-agent.request.json')) as { body: unknown }).body,
    );
  });

  it('plans a PATCH to the listed agent when its card differs', async () => {
    const { outcome, http, output } = await setup({
      apply: true,
      list: await fixture('gemini-list-existing.json'),
    });

    await expect(outcome()).resolves.toMatchObject({ changes: true, applied: true });

    expect(http.at(-1)).toMatchObject({ method: 'PATCH', url: `${COLLECTION}/${AGENT_ID}` });
    expect(output.join('')).toContain(`PATCH ${COLLECTION}/${AGENT_ID}`);
  });

  it('reports no changes and never writes when the card and description are equal', async () => {
    const existing = (await fixture('gemini-list-existing.json')) as {
      agents: { a2aAgentDefinition: { jsonAgentCard: string } }[];
    };
    const request = (await fixture('gemini-register-agent.request.json')) as {
      body: { a2aAgentDefinition: { jsonAgentCard: string } };
    };
    const [agent] = existing.agents;
    if (agent === undefined) throw new Error('fixture has no agent');
    agent.a2aAgentDefinition.jsonAgentCard = request.body.a2aAgentDefinition.jsonAgentCard;
    const { outcome, http } = await setup({ apply: true, list: existing });

    await expect(outcome()).resolves.toEqual({ changes: false, applied: false, nextSteps: [] });

    expect(http.every((call) => call.method === 'GET')).toBe(true);
  });

  it('follows nextPageToken before deciding nothing is registered', async () => {
    const existing = await fixture('gemini-list-existing.json');
    const { outcome, http } = await setup({
      apply: true,
      pages: (call: FetchCall) =>
        new URL(call.url).searchParams.get('pageToken') === 'page-2'
          ? existing
          : { agents: [], nextPageToken: 'page-2' },
    });

    await outcome();

    expect(http.map((call) => call.url)).toEqual([
      CARD_URL,
      COLLECTION,
      `${COLLECTION}?pageToken=page-2`,
      `${COLLECTION}/${AGENT_ID}`,
    ]);
  });

  it('stops when the list repeats a page token', async () => {
    const { outcome } = await setup({
      apply: true,
      pages: () => ({ agents: [], nextPageToken: 'same' }),
    });

    await expect(outcome()).rejects.toThrow(`GET ${COLLECTION} repeated a page token`);
  });

  it('refuses an unreachable card before asking gcloud for anything', async () => {
    const { outcome, tools } = await setup({ card: () => new Response('gone', { status: 404 }) });

    const publishing = outcome();

    await expect(publishing).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(publishing).rejects.toMatchObject({
      message: `the A2A agent card is not reachable at ${CARD_URL}`,
      fix: 'deploy and promote the agent, then publish again',
    });
    expect(tools).toEqual([]);
  });

  it('refuses a card that declares another A2A version before any call', async () => {
    const directory = await exportDirectory();
    const file = path.join(directory, 'register-agent.request.json');
    const request = JSON.parse(await readFile(file, 'utf8')) as {
      body: { a2aAgentDefinition: { jsonAgentCard: string } };
    };
    request.body.a2aAgentDefinition.jsonAgentCard =
      request.body.a2aAgentDefinition.jsonAgentCard.replace('"0.3.0"', '"0.3"');
    await writeFile(file, JSON.stringify(request));
    const { outcome, tools, http } = await setup({ directory });

    await expect(outcome()).rejects.toThrow(
      'Gemini Enterprise registers A2A v0.3 agents; the card declares 0.3',
    );

    expect(tools).toEqual([]);
    expect(http).toEqual([]);
  });

  it('refuses a missing request file with the export command', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'gemini-publish-'));
    directories.push(directory);
    const { outcome } = await setup({ directory });

    await expect(outcome()).rejects.toMatchObject({
      fix: 'aw platforms export --platform gemini-enterprise',
    });
  });

  it('strips the compile options the export already validated', async () => {
    const { outcome } = await setup();

    await expect(outcome({ projectId: 'x', engineId: 'y' })).resolves.toMatchObject({
      changes: true,
    });
  });

  it('keeps the token out of what it prints and out of the errors it raises', async () => {
    const printed = await setup({ apply: true });
    await printed.outcome();
    expect(printed.output.join('')).not.toContain(TOKEN);

    const denied = await setup({
      listResponse: jsonResponse(
        { error: { status: 'PERMISSION_DENIED', message: `rejected ${TOKEN}` } },
        403,
      ),
    });
    const failing = denied.outcome();
    await expect(failing).rejects.toThrow(`GET ${COLLECTION} answered 403 PERMISSION_DENIED`);
    await expect(failing).rejects.not.toThrow(TOKEN);
    expect(denied.output.join('')).not.toContain(TOKEN);
  });
});
