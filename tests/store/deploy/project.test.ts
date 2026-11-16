import { describe, expect, it } from 'vitest';

import { parseProjectFile } from '@indx-workspace/sdk/project';

import { readFileSync } from 'node:fs';

import { renderProject, RenderRefusal, TEMPLATE_PATH } from './render.ts';

const template = readFileSync(TEMPLATE_PATH, 'utf8');
const digest = (letter: string): string => `sha256:${letter.repeat(64)}`;

/** Placeholder values only: a made-up project id, an `.example` domain and an `.invalid` address. */
const env = {
  STORE_GCP_PROJECT: 'example-store-test',
  STORE_DOMAIN: 'agents.indx.example',
  STORE_ALERTS_EMAIL: 'alerts@indx.example',
  STORE_OWNER_EMAIL: 'owner@indx.example',
  STORE_IMAGE_STORE: `registry.example/store@${digest('a')}`,
  STORE_IMAGE_CRM: `registry.example/crm@${digest('b')}`,
  STORE_IMAGE_SERVICE_DESK: `registry.example/service-desk@${digest('c')}`,
  STORE_IMAGE_WIKI: `registry.example/wiki@${digest('d')}`,
  STORE_IMAGE_TEAM_CHAT: `registry.example/team-chat@${digest('e')}`,
};

function project(values: Record<string, string | undefined>) {
  const read = parseProjectFile(renderProject(template, values));
  if (read.lifted) throw new Error('a v2 project is not lifted');
  return read.project;
}

function production(values: Record<string, string | undefined>) {
  const result = project(values).environments.production;
  if (result === undefined) throw new Error('no production environment');
  return result;
}

describe('the store project file', () => {
  it('renders into a valid gcp-cloudrun project with the store and its four demo apps', () => {
    const result = production(env);
    expect(result.target).toBe('gcp-cloudrun');
    expect(result.url).toBe('https://app.agents.indx.example');
    expect(result.gcp).toMatchObject({
      project: 'example-store-test',
      region: 'asia-northeast1',
      domain: 'app.agents.indx.example',
      armor: true,
      alertsEmail: 'alerts@indx.example',
    });
    expect(
      Object.fromEntries(Object.entries(result.apps ?? {}).map(([k, v]) => [k, v.url])),
    ).toEqual({
      store: 'https://agents.indx.example',
      crm: 'https://crm.agents.indx.example',
      'service-desk': 'https://desk.agents.indx.example',
      wiki: 'https://wiki.agents.indx.example',
      'team-chat': 'https://chat.agents.indx.example',
    });
    expect(project(env).environments.local).toMatchObject({
      identity: { bootstrapAdmin: 'owner@indx.example' },
    });
    expect(result.apps?.['crm']?.image).toBe(env.STORE_IMAGE_CRM);
  });

  it('names Secret Manager secrets for the two secrets and holds no value', () => {
    const result = production(env);
    expect(result.gcp?.secretSettings).toEqual({
      AW_DEMO_OPERATOR_TOKEN: 'store-demo-operator-token',
      AW_DEMO_ANTHROPIC_API_KEY: 'store-anthropic-api-key',
    });
  });

  it('sets the sign-in link base and leaves out every cap that is not configured', () => {
    expect(production(env).gcp?.settings).toEqual({
      AW_EMAIL_LINK_BASE_URL: 'https://agents.indx.example',
    });
  });

  it('adds the configured caps and default models after the sign-in link base', () => {
    const settings = production({
      ...env,
      STORE_SETTINGS_JSON: JSON.stringify({
        AW_DEMO_MAX_TURNS_PER_RUN: '8',
        AW_DEMO_SITE_MAX_COST_PER_DAY_USD: '25',
        AW_DEPLOYMENT_DEFAULT_MODELS: '{"default":"model-a"}',
      }),
    }).gcp?.settings;
    expect(settings).toEqual({
      AW_EMAIL_LINK_BASE_URL: 'https://agents.indx.example',
      AW_DEMO_MAX_TURNS_PER_RUN: '8',
      AW_DEMO_SITE_MAX_COST_PER_DAY_USD: '25',
      AW_DEPLOYMENT_DEFAULT_MODELS: '{"default":"model-a"}',
    });
  });

  it.each(Object.keys(env))('refuses a missing %s and names it', (name) => {
    const rest: Record<string, string | undefined> = { ...env, [name]: undefined };
    expect(() => renderProject(template, rest)).toThrow(new RenderRefusal(`${name} is not set`));
    expect(() => renderProject(template, { ...rest, [name]: '  ' })).toThrow(`${name} is not set`);
  });

  it('refuses a setting the project file may not set, and a setting that is not a string', () => {
    expect(() =>
      renderProject(template, { ...env, STORE_SETTINGS_JSON: '{"AW_DATABASE_URL":"x"}' }),
    ).toThrow('AW_DATABASE_URL, which is not a web setting');
    expect(() =>
      renderProject(template, { ...env, STORE_SETTINGS_JSON: '{"AW_DEMO_MAX_TURNS_PER_RUN":8}' }),
    ).toThrow('AW_DEMO_MAX_TURNS_PER_RUN must be a string');
    expect(() => renderProject(template, { ...env, STORE_SETTINGS_JSON: '[' })).toThrow(
      'STORE_SETTINGS_JSON is not valid JSON',
    );
  });

  describe('the apps workspace and API key secrets (optional)', () => {
    const workspaceId = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    const apps = (values: Record<string, string | undefined>) =>
      Object.entries(production(values).apps ?? {});

    it('leaves workspaceId and apiKeySecret out of every app when no variable is set', () => {
      for (const [, app] of apps(env)) {
        expect(app).not.toHaveProperty('workspaceId');
        expect(app).not.toHaveProperty('apiKeySecret');
      }
      const empty = { ...env, STORE_APPS_WORKSPACE_ID: '  ', STORE_API_KEY_SECRET_CRM: '' };
      for (const [, app] of apps(empty)) {
        expect(app).not.toHaveProperty('workspaceId');
        expect(app).not.toHaveProperty('apiKeySecret');
      }
    });

    it('gives all five apps the workspace id', () => {
      const result = apps({ ...env, STORE_APPS_WORKSPACE_ID: workspaceId });
      expect(result.map(([name]) => name)).toEqual([
        'store',
        'crm',
        'service-desk',
        'wiki',
        'team-chat',
      ]);
      for (const [, app] of result) expect(app.workspaceId).toBe(workspaceId);
    });

    it('puts a secret id on its own app only', () => {
      const result = production({ ...env, STORE_API_KEY_SECRET_SERVICE_DESK: 'store-desk-key' });
      expect(result.apps?.['service-desk']?.apiKeySecret).toBe('store-desk-key');
      for (const name of ['store', 'crm', 'wiki', 'team-chat']) {
        expect(result.apps?.[name]).not.toHaveProperty('apiKeySecret');
      }
    });

    it('refuses a workspace id that is not a UUID, naming the variable and not the value', () => {
      const attempt = () =>
        renderProject(template, { ...env, STORE_APPS_WORKSPACE_ID: 'not-a-uuid-9' });
      expect(attempt).toThrow(/STORE_APPS_WORKSPACE_ID must be a workspace id/u);
      expect(attempt).not.toThrow(/not-a-uuid-9/u);
    });

    it('refuses an API key given where its secret id belongs, without printing it', () => {
      const key = `ak_live_${'x'.repeat(20)}`;
      const attempt = () => renderProject(template, { ...env, STORE_API_KEY_SECRET_WIKI: key });
      expect(attempt).toThrow(/STORE_API_KEY_SECRET_WIKI must be a Secret Manager secret id/u);
      expect(attempt).not.toThrow(key);
    });
  });

  describe('the sign-in issuer and the apps sign-in (optional)', () => {
    const issuer = {
      STORE_OIDC_ISSUER: 'https://login.indx.example',
      STORE_OIDC_CLIENT_ID: 'store-platform',
    };
    const wiki = {
      STORE_APP_OIDC_CLIENT_ID_WIKI: 'store-wiki',
      STORE_APP_CLIENT_ID_WIKI: 'b6e5f0c2-7d4e-4f1b-9a0c-3e2d1c0b9a87',
    };

    it('leaves gcp.oidc and every app signIn out when no variable is set', () => {
      const result = production(env);
      expect(result.gcp).not.toHaveProperty('oidc');
      for (const app of Object.values(result.apps ?? {})) expect(app).not.toHaveProperty('signIn');
    });

    it('sets the issuer, and a sign-in on its own app only, with the fixed secret ids', () => {
      const result = production({ ...env, ...issuer, ...wiki });
      expect(result.gcp?.oidc).toEqual({
        issuer: 'https://login.indx.example',
        clientId: 'store-platform',
      });
      expect(result.apps?.['wiki']?.signIn).toEqual({
        oidcClientId: 'store-wiki',
        oidcClientSecret: 'store-app-wiki-oidc-client-secret',
        appClientId: 'b6e5f0c2-7d4e-4f1b-9a0c-3e2d1c0b9a87',
        appClientSecret: 'store-app-wiki-app-client-secret',
      });
      for (const name of ['store', 'crm', 'service-desk', 'team-chat']) {
        expect(result.apps?.[name]).not.toHaveProperty('signIn');
      }
    });

    it('refuses a sign-in line with only some of its variables, naming the missing one', () => {
      const attempt = () =>
        renderProject(template, { ...env, ...issuer, STORE_APP_CLIENT_ID_WIKI: 'b6e5f0c2' });
      expect(attempt).toThrow(/STORE_APP_OIDC_CLIENT_ID_WIKI must be set together/u);
      expect(() =>
        renderProject(template, { ...env, STORE_OIDC_ISSUER: issuer.STORE_OIDC_ISSUER }),
      ).toThrow(/STORE_OIDC_CLIENT_ID must be set together/u);
    });

    it('refuses an app sign-in without the issuer', () => {
      expect(() => renderProject(template, { ...env, ...wiki })).toThrow(
        /environments\.production\.gcp\.oidc/u,
      );
    });

    it('refuses a secret given where a client id belongs, without printing it', () => {
      const secret = `awcs_live_${'x'.repeat(43)}`;
      const attempt = () =>
        renderProject(template, { ...env, ...issuer, ...wiki, STORE_APP_CLIENT_ID_WIKI: secret });
      expect(attempt).toThrow(/STORE_APP_CLIENT_ID_WIKI must be a client id, never a secret/u);
      expect(attempt).not.toThrow(secret);
    });
  });

  it('refuses an image that is a tag, not a digest', () => {
    expect(() =>
      renderProject(template, { ...env, STORE_IMAGE_WIKI: 'registry.example/wiki:latest' }),
    ).toThrow(/rendered project file is refused/u);
  });

  it('cannot be made to add a key by a value with a newline or a quote', () => {
    const hostile = 'ops@indx.example"\n      armor: false\n      x: "y';
    expect(() => renderProject(template, { ...env, STORE_ALERTS_EMAIL: hostile })).toThrow(
      /STORE_ALERTS_EMAIL holds a control character/u,
    );
    const result = production({
      ...env,
      STORE_SETTINGS_JSON: JSON.stringify({ AW_DEMO_MAX_TURNS_PER_RUN: 'a"\nb: c' }),
    });
    expect(result.gcp?.armor).toBe(true);
    expect(result.gcp?.settings?.AW_DEMO_MAX_TURNS_PER_RUN).toBe('a"\nb: c');
  });

  it('keeps a single quote inside its own value and refuses a control character', () => {
    const result = production({ ...env, STORE_OWNER_EMAIL: "o'brien@indx.example" });
    expect(result.gcp?.armor).toBe(true);
    const owner = project({ ...env, STORE_OWNER_EMAIL: "o'brien@indx.example" });
    expect(owner.environments.local?.identity?.bootstrapAdmin).toBe("o'brien@indx.example");
    // A quote that tries to end the scalar is doubled, so the value stays one (refused) email.
    expect(() =>
      renderProject(template, {
        ...env,
        STORE_ALERTS_EMAIL: "x@indx.example' \n      armor: false",
      }),
    ).toThrow(/STORE_ALERTS_EMAIL holds a control character/u);
    expect(() =>
      renderProject(template, { ...env, STORE_ALERTS_EMAIL: "x@indx.example', armor: 'false" }),
    ).toThrow(/alertsEmail Invalid email/u);
  });

  it('keeps the shipped template free of real project ids, addresses and internal paths', () => {
    expect(template).not.toMatch(/agent-store-staging|agent-store-prod|internal\//u);
    expect(template).not.toMatch(/@(?!localhost\.test)[a-z0-9.-]+\.[a-z]{2,}/u);
  });
});
