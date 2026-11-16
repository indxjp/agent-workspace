/**
 * The template operator routes (`GET /api/demo/templates`, `PUT /api/demo/templates/{entry}`)
 * through the application context a deployment installs: nothing without the operator token, `401`
 * for a wrong one, and a seed that is filled, refused or reported with typed problems only.
 */
import { DemoTemplateSeedSchema } from '@indx-workspace/contracts/demo-operator';
import { afterEach, describe, expect, it } from 'vitest';

import { clearApplicationContext } from '../../../../server/application-context';
import { installTestDomains } from '../../../../server/application-context-fixtures';
import type { DemoOperatorRuntime } from '../../../../server/demo/operator';
import { createMemoryTemplatesWorld } from '../../../../server/demo/provision/templates.world.test-support';
import { GET } from './route';
import { PUT } from './[entry]/route';

const TOKEN = 'operator-token-'.padEnd(40, 'x');
const URL_BASE = 'https://platform.example.test/api/demo/templates';

afterEach(() => {
  clearApplicationContext();
});

const seedBody = () => ({
  definition: {
    apiVersion: 'agentworkspace.dev/v1',
    kind: 'AgentDefinition',
    agent: {
      name: 'helper',
      instructions: 'Use the sample data.',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      model: null,
      modelConnectionName: null,
      runtimeProfileName: null,
    },
    policy: {
      engine: 'claude-agent-sdk',
      tools: { base: 'claude_code_preset', permissionMode: 'default', autoApprove: [], deny: [] },
      skills: { mode: 'allowlist', names: [] },
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policySource: 'stored',
    resources: { files: [], skills: [], connectors: [] as string[] },
  },
  connectors: [],
  skills: [],
  files: [],
  records: [],
});

function install(token: string | null, world = createMemoryTemplatesWorld()): void {
  const runtime: DemoOperatorRuntime = {
    token,
    templates: world.operations,
    verification: null,
    maintenance: null,
    readiness: null,
  };
  installTestDomains({ demoOperator: runtime });
}

const put = (entry: string, init: RequestInit = {}) =>
  PUT(new Request(`${URL_BASE}/${entry}`, { method: 'PUT', ...init }), {
    params: Promise.resolve({ entry }),
  });
const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', ...headers },
});
const authorised = { authorization: `Bearer ${TOKEN}` };

describe('GET /api/demo/templates', () => {
  it('does not exist while the operator token is unset', async () => {
    install(null);
    const response = await GET(new Request(URL_BASE, { headers: authorised }));
    expect(response.status).toBe(404);
  });

  it('answers 401 to a missing or wrong token', async () => {
    install(TOKEN);
    expect((await GET(new Request(URL_BASE))).status).toBe(401);
    expect(
      (await GET(new Request(URL_BASE, { headers: { authorization: 'Bearer wrong' } }))).status,
    ).toBe(401);
  });

  it('reports the templates the deployment made', async () => {
    const world = createMemoryTemplatesWorld();
    install(TOKEN, world);
    const entry = 'wiki';
    await world.operations.seed({
      entry,
      seed: DemoTemplateSeedSchema.parse(seedBody()),
      now: new Date('2026-11-16T09:00:00.000Z'),
    });
    const response = await GET(new Request(URL_BASE, { headers: authorised }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      templates: [{ entry, agent: 'helper', files: 0, recordSets: 0 }],
    });
  });
});

describe('PUT /api/demo/templates/{entry}', () => {
  it('does not exist while the operator token is unset, and answers 401 to a wrong one', async () => {
    install(null);
    expect((await put('wiki', json(seedBody(), authorised))).status).toBe(404);
    install(TOKEN);
    expect((await put('wiki', json(seedBody()))).status).toBe(401);
    expect((await put('wiki', json(seedBody(), { authorization: 'Bearer wrong' }))).status).toBe(
      401,
    );
  });

  it('fills the template and says it changed, then says it changed nothing', async () => {
    const world = createMemoryTemplatesWorld();
    install(TOKEN, world);
    const first = await put('wiki', json(seedBody(), authorised));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ entry: 'wiki', changed: true });
    expect(await world.templates.exists('wiki')).toBe(true);
    const second = await put('wiki', json(seedBody(), authorised));
    expect(await second.json()).toEqual({ entry: 'wiki', changed: false });
  });

  it('answers 400 to a slug that is not an entry, and 400 with the field to a body that is not a seed', async () => {
    install(TOKEN);
    expect((await put('Not_An_Entry', json(seedBody(), authorised))).status).toBe(400);
    const response = await put(
      'wiki',
      json({ definition: {}, secret: 'sk-do-not-echo' }, authorised),
    );
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'invalid_demo_seed' } });
    expect(text).not.toContain('sk-do-not-echo');
  });

  it('answers 415 to a body that is not JSON, 400 to one that is not parseable, and 413 to one over the limit', async () => {
    install(TOKEN);
    expect((await put('wiki', { body: '{}', headers: authorised })).status).toBe(415);
    expect(
      (
        await put('wiki', {
          body: '{not json',
          headers: { ...authorised, 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(400);
    const tooLarge = await put('wiki', {
      body: '{}',
      headers: {
        ...authorised,
        'content-type': 'application/json',
        'content-length': String(64 * 1_048_576),
      },
    });
    expect(tooLarge.status).toBe(413);
  });

  it('answers 400 with a typed problem to a seed that does not hold together, and writes nothing', async () => {
    const world = createMemoryTemplatesWorld();
    install(TOKEN, world);
    const body = seedBody();
    body.definition.resources.connectors = ['crm'];
    const response = await put('wiki', json(body, authorised));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'demo_seed_invalid' } });
    expect(await world.templateId('wiki')).toBeNull();
  });

  it("answers 409 for a slug that is not the deployment's own", async () => {
    const world = createMemoryTemplatesWorld();
    install(TOKEN, world);
    await world.seedTemplate(
      'wiki',
      {
        agent: { name: 'x', instructions: 'x', maxTurns: null, maxBudgetUsd: null },
        files: [],
        assign: [],
      },
      'person',
    );
    const response = await put('wiki', json(seedBody(), authorised));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'demo_template_not_deployment_owned' },
    });
  });

  it('answers 503 where the deployment cannot hold a template', async () => {
    installTestDomains({
      demoOperator: {
        token: TOKEN,
        templates: null,
        verification: null,
        maintenance: null,
        readiness: null,
      },
    });
    expect((await put('wiki', json(seedBody(), authorised))).status).toBe(503);
    expect((await GET(new Request(URL_BASE, { headers: authorised }))).status).toBe(503);
  });
});
