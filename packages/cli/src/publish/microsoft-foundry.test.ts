import { mkdir, mkdtemp, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { publishPlatform } from './index.ts';
import { PublishRefusedError, PublishSettingsError } from './kit.ts';
import { fakeFetch, fakeRunner, jsonResponse, type FetchCall } from './test-support.ts';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const TOKEN = 'eyJ.secret-az-token';
const ENDPOINT = 'https://acme.services.ai.azure.com/api/projects/support';
const QUERY = '?api-version=v1';
const BILLING = `${ENDPOINT}/agents/billing-specialist`;
const TRIAGE = `${ENDPOINT}/agents/support-triage`;

const EXPORTED = [
  ['foundry-project.plan.json', 'project.plan.json'],
  ['foundry-billing-specialist.version.json', 'agents/billing-specialist.version.json'],
  ['foundry-billing-specialist.endpoint.json', 'agents/billing-specialist.endpoint.json'],
  ['foundry-support-triage.version.json', 'agents/support-triage.version.json'],
] as const;

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')) as T;
}

async function exportDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'foundry-publish-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'agents'));
  for (const [source, target] of EXPORTED) {
    await copyFile(new URL(source, FIXTURES), path.join(directory, target));
  }
  return directory;
}

interface Version {
  readonly definition: unknown;
}
interface Endpoint {
  readonly agent_card: unknown;
  readonly agent_endpoint: unknown;
}

/** What the vendor answers for an agent that already has exactly the exported definition. */
async function currentBilling(): Promise<unknown> {
  const version = await fixture<Version>('foundry-billing-specialist.version.json');
  const endpoint = await fixture<Endpoint>('foundry-billing-specialist.endpoint.json');
  return { versions: { latest: { definition: version.definition } }, ...endpoint };
}

async function currentTriage(): Promise<unknown> {
  const version = await fixture<Version>('foundry-support-triage.version.json');
  return { versions: { latest: { definition: version.definition } } };
}

interface Setup {
  readonly answer?: (call: FetchCall) => Response;
  readonly apply?: boolean;
  readonly directory?: string;
  readonly settings?: unknown;
  readonly tokenAnswer?: { readonly status: number; readonly stderr: string };
}

async function setup(options: Setup = {}) {
  const directory = options.directory ?? (await exportDirectory());
  const toolCalls = fakeRunner({
    'az version': { stdout: '{"azure-cli": "2.70.0"}\n' },
    'az account': options.tokenAnswer ?? { stdout: `${TOKEN}\n` },
  });
  const http = fakeFetch(
    (call) =>
      options.answer?.(call) ??
      (call.method === 'GET'
        ? jsonResponse({ error: { code: 'NotFound', message: 'gone' } }, 404)
        : jsonResponse({ ok: true })),
  );
  const output: string[] = [];
  const outcome = () =>
    publishPlatform({
      platform: 'microsoft-foundry',
      directory,
      agent: 'support-triage',
      settings: (options.settings ?? { projectEndpoint: ENDPOINT }) as Record<string, unknown>,
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

describe('microsoft-foundry executor', () => {
  it('asks az for the token with the Foundry audience and never prints it', async () => {
    const { outcome, tools, http, output } = await setup();

    await outcome();

    expect(tools.map((call) => [call.tool, ...call.args])).toEqual([
      ['az', 'version'],
      [
        'az',
        'account',
        'get-access-token',
        '--resource',
        'https://ai.azure.com',
        '--query',
        'accessToken',
        '--output',
        'tsv',
      ],
    ]);
    expect(http.every((call) => call.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
    expect(output.join('')).not.toContain(TOKEN);
  });

  it('plans a create for an unknown agent and writes nothing without apply', async () => {
    const { outcome, http, output } = await setup();

    const result = await outcome();

    expect(http.map((call) => [call.method, call.url])).toEqual([
      ['GET', `${BILLING}${QUERY}`],
      ['GET', `${TRIAGE}${QUERY}`],
    ]);
    expect(
      output
        .join('')
        .split('\n')
        .filter((line) => /^(POST|PATCH) /u.test(line)),
    ).toEqual([
      `POST ${BILLING}/versions${QUERY}`,
      `PATCH ${BILLING}${QUERY}`,
      `POST ${TRIAGE}/versions${QUERY}`,
    ]);
    expect(result).toMatchObject({ changes: true, applied: false });
    expect(result.nextSteps).toEqual([
      'create project connection aw-zendesk (mcp) in the Foundry portal before publishing',
      'create project connection aw-tools (mcp) in the Foundry portal before publishing',
      'create project connection aw-agent-billing-specialist (a2a) in the Foundry portal before publishing',
      're-run with --yes to send the calls above',
    ]);
  });

  it('applies in plan order with the exported bodies', async () => {
    const { outcome, http } = await setup({ apply: true });

    await expect(outcome()).resolves.toMatchObject({ changes: true, applied: true });

    const writes = http.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => [call.method, call.url])).toEqual([
      ['POST', `${BILLING}/versions${QUERY}`],
      ['PATCH', `${BILLING}${QUERY}`],
      ['POST', `${TRIAGE}/versions${QUERY}`],
    ]);
    expect(writes.map((call) => JSON.parse(call.body ?? '') as unknown)).toEqual([
      await fixture('foundry-billing-specialist.version.json'),
      await fixture('foundry-billing-specialist.endpoint.json'),
      await fixture('foundry-support-triage.version.json'),
    ]);
  });

  it('reports no changes and never writes when the definitions are equal, even with apply', async () => {
    const billing = await currentBilling();
    const triage = await currentTriage();
    const { outcome, http } = await setup({
      apply: true,
      answer: (call) => jsonResponse(call.url.startsWith(BILLING) ? billing : triage),
    });

    await expect(outcome()).resolves.toEqual({ changes: false, applied: false, nextSteps: [] });

    expect(http.every((call) => call.method === 'GET')).toBe(true);
  });

  it('versions only the agent whose instructions differ', async () => {
    const billing = await currentBilling();
    const older = await fixture('foundry-get-agent.json');
    const { outcome, http } = await setup({
      apply: true,
      answer: (call) => jsonResponse(call.url.startsWith(BILLING) ? billing : older),
    });

    await outcome();

    expect(
      http.filter((call) => call.method !== 'GET').map((call) => [call.method, call.url]),
    ).toEqual([['POST', `${TRIAGE}/versions${QUERY}`]]);
  });

  it('patches the endpoint when the vendor does not echo it', async () => {
    const billing = (await currentBilling()) as { versions: unknown };
    const triage = await currentTriage();
    const { outcome, http } = await setup({
      apply: true,
      answer: (call) =>
        jsonResponse(call.url.startsWith(BILLING) ? { versions: billing.versions } : triage),
    });

    await outcome();

    expect(
      http.filter((call) => call.method !== 'GET').map((call) => [call.method, call.url]),
    ).toEqual([['PATCH', `${BILLING}${QUERY}`]]);
  });

  it('treats an answer it cannot read as changed', async () => {
    const { outcome } = await setup({ answer: () => jsonResponse({ unexpected: true }) });

    await expect(outcome()).resolves.toMatchObject({ changes: true });
  });

  it('refuses a missing or an http project endpoint, and strips compile keys', async () => {
    const missing = await setup({ settings: { modelDeployment: 'claude-sonnet-4-6' } });
    await expect(missing.outcome()).rejects.toBeInstanceOf(PublishSettingsError);
    await expect(missing.outcome()).rejects.toThrow(
      'platforms.microsoft-foundry.options.projectEndpoint',
    );

    const insecure = await setup({ settings: { projectEndpoint: 'http://acme.example/api' } });
    await expect(insecure.outcome()).rejects.toBeInstanceOf(PublishSettingsError);
    expect(insecure.tools).toEqual([]);

    const compileKeys = await setup({
      settings: { projectEndpoint: ENDPOINT, modelDeployment: 'claude-sonnet-4-6' },
    });
    await expect(compileKeys.outcome()).resolves.toMatchObject({ changes: true });
  });

  it('refuses a $ref OpenAPI spec before any tool runs', async () => {
    const directory = await exportDirectory();
    const file = path.join(directory, 'project.plan.json');
    const plan = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    plan['openapiSpecs'] = [{ agent: 'support-triage', tool: 'orders', specRef: 'specs/o.yaml' }];
    await writeFile(file, JSON.stringify(plan));
    const { outcome, tools, http } = await setup({ directory });

    await expect(outcome()).rejects.toMatchObject({
      message: 'Foundry needs OpenAPI specs inline; support-triage/orders is still a $ref',
      fix: 'set allow on the tool so aw platforms export inlines the spec',
    });
    expect(tools).toEqual([]);
    expect(http).toEqual([]);
  });

  it('refuses a missing plan and a plan that points outside the export', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'foundry-publish-'));
    directories.push(empty);
    await expect((await setup({ directory: empty })).outcome()).rejects.toMatchObject({
      fix: 'aw platforms export --platform microsoft-foundry',
    });

    const directory = await exportDirectory();
    const file = path.join(directory, 'project.plan.json');
    const plan = JSON.parse(await readFile(file, 'utf8')) as {
      agents: { version: string }[];
    };
    const [first] = plan.agents;
    if (first === undefined) throw new Error('fixture has no agent');
    first.version = '../outside.json';
    await writeFile(file, JSON.stringify(plan));
    await expect((await setup({ directory })).outcome()).rejects.toBeInstanceOf(
      PublishRefusedError,
    );
  });

  it('turns a failed az call into a refusal that names az login', async () => {
    const { outcome, http } = await setup({ tokenAnswer: { status: 1, stderr: 'AADSTS70043' } });

    const publishing = outcome();

    await expect(publishing).rejects.toBeInstanceOf(PublishRefusedError);
    await expect(publishing).rejects.toMatchObject({ fix: 'az login' });
    expect(http).toEqual([]);
  });

  it('keeps the token and the response body out of the errors it raises', async () => {
    const { outcome, output } = await setup({
      answer: () =>
        jsonResponse({ error: { code: 'Forbidden', message: `rejected ${TOKEN}` } }, 403),
    });

    const failing = outcome();

    await expect(failing).rejects.toThrow(`GET ${BILLING} answered 403 Forbidden`);
    await expect(failing).rejects.not.toThrow(TOKEN);
    expect(output.join('')).not.toContain(TOKEN);
  });
});
