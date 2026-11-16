import { ApiProblemSchema } from '@indx-workspace/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { text } from '../fields/index.js';
import { defineResource } from '../resource.js';
import { resourceItemRoutes, resourceRoutes } from './routes.js';
import { agentToolsFromEnvironment, appRuntime, replaceAppRuntime } from './runtime.js';

const notes = defineResource({
  name: 'note',
  fields: { title: text() },
  access: { read: 'member', create: 'member', update: 'member', delete: 'member' },
});

const SECRET_URL = 'postgres://app:s3cret-pass@db.internal:5432/app';

const SERVED_WORKSPACE = '00000000-0000-4000-8000-0000000000CD';

type AppVariable = 'AW_URL' | 'AW_APP_NAME' | 'DATABASE_URL' | 'AW_WORKSPACE_ID';

/** Stubs the four variables; `AW_WORKSPACE_ID` is a valid one unless `values` says otherwise. */
function environment(values: Partial<Record<AppVariable, string>>) {
  const withWorkspace = { AW_WORKSPACE_ID: SERVED_WORKSPACE, ...values };
  for (const name of ['AW_URL', 'AW_APP_NAME', 'DATABASE_URL', 'AW_WORKSPACE_ID'] as const) {
    vi.stubEnv(name, withWorkspace[name] ?? '');
  }
}

afterEach(() => {
  replaceAppRuntime(undefined);
  vi.unstubAllEnvs();
});

describe('appRuntime', () => {
  it('builds once from a valid environment and returns the same runtime and stores', () => {
    environment({
      AW_URL: 'https://aw.example.com',
      AW_APP_NAME: 'service-desk',
      DATABASE_URL: SECRET_URL,
    });
    const runtime = appRuntime();
    expect(runtime).toMatchObject({
      awUrl: 'https://aw.example.com',
      appName: 'service-desk',
      workspaceId: SERVED_WORKSPACE.toLowerCase(),
    });
    expect(appRuntime()).toBe(runtime);
    expect(runtime.storeOf(notes)).toBe(runtime.storeOf(notes));
  });

  it.each([
    ['AW_URL is missing', { AW_APP_NAME: 'desk', DATABASE_URL: SECRET_URL }],
    [
      'AW_URL is not http(s)',
      { AW_URL: 'ftp://aw', AW_APP_NAME: 'desk', DATABASE_URL: SECRET_URL },
    ],
    [
      'AW_APP_NAME is not a name key',
      { AW_URL: 'https://aw', AW_APP_NAME: 'Desk!', DATABASE_URL: SECRET_URL },
    ],
    ['DATABASE_URL is missing', { AW_URL: 'https://aw', AW_APP_NAME: 'desk' }],
    [
      'AW_WORKSPACE_ID is missing',
      { AW_URL: 'https://aw', AW_APP_NAME: 'desk', DATABASE_URL: SECRET_URL, AW_WORKSPACE_ID: '' },
    ],
    [
      'AW_WORKSPACE_ID is not a UUID',
      {
        AW_URL: 'https://aw',
        AW_APP_NAME: 'desk',
        DATABASE_URL: SECRET_URL,
        AW_WORKSPACE_ID: 'desk',
      },
    ],
    [
      'DATABASE_URL is not postgres',
      { AW_URL: 'https://aw', AW_APP_NAME: 'desk', DATABASE_URL: 'mysql://u:s3cret-pass@h/d' },
    ],
  ] as const)('throws app_misconfigured when %s', (_name, values) => {
    environment(values);
    expect(() => appRuntime()).toThrow(expect.objectContaining({ code: 'app_misconfigured' }));
  });

  it('a missing env answers 500 app_misconfigured on every handler with no echoed value', async () => {
    environment({ AW_URL: 'not a url', AW_APP_NAME: 'desk', DATABASE_URL: SECRET_URL });
    const collection = resourceRoutes(notes);
    const item = resourceItemRoutes(notes);
    const id = crypto.randomUUID();
    const context = { params: Promise.resolve({ id }) };
    const url = 'https://app.test/api/notes';
    const responses = [
      await collection.GET(new Request(url)),
      await collection.POST(new Request(url, { method: 'POST', body: '{}' })),
      await item.GET(new Request(`${url}/${id}`), context),
      await item.PATCH(new Request(`${url}/${id}`, { method: 'PATCH', body: '{}' }), context),
      await item.DELETE(new Request(`${url}/${id}`, { method: 'DELETE' }), context),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
      const text = await response.text();
      const parsed = ApiProblemSchema.parse(JSON.parse(text));
      expect(parsed.error.code).toBe('app_misconfigured');
      expect(text).not.toContain('s3cret');
      expect(text).not.toContain('not a url');
    }
  });

  it('reads the environment again after a failure, once it is corrected', () => {
    environment({ AW_WORKSPACE_ID: '' });
    expect(() => appRuntime()).toThrow();
    environment({ AW_URL: 'http://localhost:3000', AW_APP_NAME: 'desk', DATABASE_URL: SECRET_URL });
    expect(appRuntime().appName).toBe('desk');
  });
});

describe('agentToolsFromEnvironment', () => {
  const WORKSPACE = '00000000-0000-4000-8000-0000000000AB';
  const complete = {
    AW_APP_CONNECTOR_ID: 'conn_desk',
    AW_WORKSPACE_ID: WORKSPACE,
    AW_APP_IDENTITY_SECRET: 'current-secret, previous-secret',
    AW_APP_API_KEY: 'ak_live_machine_key',
  };

  it('reads the four variables, the secrets comma-separated for rotation', () => {
    expect(agentToolsFromEnvironment(complete)).toEqual({
      connectorId: 'conn_desk',
      workspaceId: WORKSPACE.toLowerCase(),
      identitySecrets: ['current-secret', 'previous-secret'],
      apiKey: 'ak_live_machine_key',
    });
  });

  it.each([
    ['AW_APP_CONNECTOR_ID', ''],
    ['AW_WORKSPACE_ID', 'not-a-uuid'],
    ['AW_APP_IDENTITY_SECRET', 'one,,two'],
    ['AW_APP_IDENTITY_SECRET', 'a,b,c,d,e'],
    ['AW_APP_API_KEY', 'awu_live_a_person_token'],
    ['AW_APP_API_KEY', undefined],
  ] as const)('is undefined when %s is %j', (name, value) => {
    expect(agentToolsFromEnvironment({ ...complete, [name]: value })).toBeUndefined();
  });

  it('leaves the resource routes working when the agent tools are not configured', () => {
    environment({
      AW_URL: 'https://aw.example.com',
      AW_APP_NAME: 'desk',
      DATABASE_URL: SECRET_URL,
    });
    expect(appRuntime().agentTools).toBeUndefined();
  });
});
