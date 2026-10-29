/**
 * Issue #1494 (U2.4a), ADR-0160 D7: **every route that belongs to a feature answers
 * `404 feature_disabled` when that feature is off**, proved by driving each route, never by reading
 * the handlers and believing them. The route list is the contracts' catalogue (`API_ROUTES` and
 * `API_ROUTE_EXCLUSIONS`, each tagged with its feature), so a route added tomorrow is driven
 * tomorrow with no edit here, and a guard line removed from a handler turns this file red.
 *
 * ## The two levels
 *
 *   * **The edge (a)** — `apps/web/proxy.ts` with `AW_DEPLOYMENT_FEATURES` leaving the route's
 *     feature (and whatever needs it) out. No credential is sent: the refusal comes before
 *     authentication.
 *   * **The workspace (b)** — the route module itself, called with the credential its door takes
 *     (a member for the console routes, a trigger secret for `fire`, an API key for
 *     `/mcp/projects/:name`, an OAuth token for `/mcp/builder`, a run token for `/api/builder/mcp`)
 *     while the workspace has only that feature switched off. A control pass with every feature on
 *     must not answer `feature_disabled`.
 *
 * ## What is not driven, and where it is held instead
 *
 * Three groups, each asserted **equal** to the routes it names, each entry naming the test that
 * holds it and the title that test must carry:
 *
 *   * the anonymous `/p/**` pages, which conceal as their own not-found rather than refuse;
 *   * the cron sweep, which is never refused and skips a workspace with triggers off;
 *   * the `.well-known` discovery documents, which are anonymous, read no workspace and so are
 *     refused at the edge only (part (a) drives them).
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import type { TriggerRecord, TriggerRepository } from '@agent-workspace/core/db';
import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import {
  FEATURE_IDS,
  featuresMissingDependencies,
  type FeatureId,
} from '@indx-workspace/contracts/features';
import { API_ROUTES, API_ROUTE_EXCLUSIONS } from '@indx-workspace/contracts/routes';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT } from '../../../../tests/inventory-support';
import { proxy } from '../../proxy';
import { applicationContext } from '../application-context';
import { installTestDomains, installTestRunApi } from '../application-context-fixtures';
import { createBuilderCallerVerifier } from '../builder/transport/mcp';
import type { EndpointClientsRuntime } from '../endpoint-clients/runtime';
import { installEmptyDeployment } from '../empty-deployment-fixture';
import { encodeFileId } from '../files/file-id';
import type { RunTokenDatabase } from '../gateway/run-token-verifier';
import { mintClientSecret } from '../oauth/tokens';
import { Principal } from '../rbac/principal';
import { callerHeaders, installRbacHarness, TEST_WORKSPACE_ID } from '../rbac/testing';
import type { RunPrincipal } from '../runs/environment';
import { InMemoryRunStore } from '../runs/memory-store';
import type { ToolEndpointEnvironment } from '../tool-endpoint/env';
import type { TriggersRuntime } from '../triggers/runtime';
import { routeFeatureOf } from './route-feature';
import { clearFeatureSwitches, configureFeatureSwitches } from './runtime';

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const ROUTE_MODULES = import.meta.glob(['../../app/api/**/route.ts', '../../app/mcp/**/route.ts']);

const ORIGIN = 'https://control-plane.test';
const OWNER = { email: 'owner@features.test' };
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = '00000000-0000-4000-8000-000000000000';
const CLIENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const RUN_TOKEN_SECRET = 'inventory-run-token-signing-secret-at-least-thirty-two-bytes';
const RUN = 'run-1';
const SESSION = 'session-1';
const AGENT = 'agent-1';

const FIRE = 'POST /api/triggers/:id/fire/:secret';
const TOOL_ENDPOINT = 'POST /mcp/projects/:name';
const BUILDER_EXTERNAL = 'POST /mcp/builder';
const BUILDER_RUN = 'POST /api/builder/mcp';

interface Held {
  readonly file: string;
  readonly title: string;
}

/** The anonymous pages: they conceal as the not-found an unknown link or name answers. */
const CONCEALED: Readonly<Record<string, Held>> = {
  'GET /p/:token': {
    file: 'apps/web/server/shares/core/public-share-feature.test.ts',
    title: 'answers the unknown-link 404 from the public routes, never feature_disabled',
  },
  'POST /p/:token/messages': {
    file: 'apps/web/server/shares/core/public-share-feature.test.ts',
    title: 'answers the unknown-link 404 from the public routes, never feature_disabled',
  },
  'GET /p/s/:name': {
    file: 'apps/web/server/surfaces/public/feature-concealment.test.ts',
    title: 'answers the page its unknown-name 404',
  },
  'GET /p/s/:name/try': {
    file: 'apps/web/server/surfaces/public/feature-concealment.test.ts',
    title: 'answers the page its unknown-name 404',
  },
  'GET /p/s/:name/widget.js': {
    file: 'apps/web/server/surfaces/public/feature-concealment.test.ts',
    title: 'answers the widget loader its unknown-name 404',
  },
  'POST /p/s/:name/sessions': {
    file: 'apps/web/server/surfaces/public/feature-concealment.test.ts',
    title: 'answers the session bootstrap surface_not_found and opens nothing',
  },
};

/** The cron sweep: never refused, it skips the workspaces that have triggers off. */
const CRON: Readonly<Record<string, Held>> = {
  'GET /api/cron/triggers': {
    file: 'apps/web/server/triggers/schedule-pass.test.ts',
    title: 'skips the workspace without reading its triggers, and is not refused',
  },
};

/** Anonymous discovery documents: no workspace to read, so the edge is the only level. */
const EDGE_ONLY: readonly string[] = [
  'GET /.well-known/oauth-protected-resource/mcp/builder',
  'GET /.well-known/oauth-protected-resource/mcp/projects/:name',
];

interface Route {
  readonly method: string;
  readonly path: string;
  readonly feature: FeatureId | 'core';
}

const key = (route: { readonly method: string; readonly path: string }): string =>
  `${route.method} ${route.path}`;

const catalogued: readonly Route[] = [...API_ROUTES, ...API_ROUTE_EXCLUSIONS];
const featureRoutes = catalogued.filter((route) => route.feature !== 'core');
const coreRoutes = catalogued.filter((route) => route.feature === 'core');
const driven = featureRoutes.filter(
  (route) => !(key(route) in CONCEALED) && !(key(route) in CRON) && !EDGE_ONLY.includes(key(route)),
);

function moduleKey(pattern: string): string {
  return `../../app${pattern.replace(/:([A-Za-z]+)/gu, '[$1]')}/route.ts`;
}

function paramsFor(route: Route): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of route.path.matchAll(/:([A-Za-z]+)/gu)) {
    const name = match[1] as string;
    params[name] = name === 'name' ? 'no-such-skill' : UUID;
  }
  if (route.path.startsWith('/api/files/')) params['id'] = encodeFileId('inventory.txt');
  if (key(route) === FIRE) params['secret'] = triggerSecret;
  if (key(route) === TOOL_ENDPOINT) params['name'] = 'support';
  return params;
}

function concretePath(route: Route, params: Record<string, string>): string {
  return route.path.replace(/:([A-Za-z]+)/gu, (_, name: string) => params[name] ?? '');
}

/** The fire URL's secret: a placeholder for the edge, the minted one once (b) has set up. */
let triggerSecret = 'awcs_live_placeholder';

const RPC = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

describe('the route inventory covers every feature-tagged route', () => {
  it('holds each undriven route in a named test that exists', () => {
    for (const [route, held] of [...Object.entries(CONCEALED), ...Object.entries(CRON)]) {
      const source = readFileSync(path.join(REPO_ROOT, held.file), 'utf8');
      expect(source, `${route}: ${held.file} has no test titled "${held.title}"`).toContain(
        `it('${held.title}'`,
      );
    }
  });

  it('skips exactly the /p/** pages, the cron and the discovery documents', () => {
    const all = featureRoutes.map(key);
    expect(Object.keys(CONCEALED).sort()).toEqual(
      all.filter((route) => route.split(' ')[1]?.startsWith('/p/') === true).sort(),
    );
    expect(Object.keys(CRON).sort()).toEqual(
      all.filter((route) => route.split(' ')[1]?.startsWith('/api/cron/') === true).sort(),
    );
    expect([...EDGE_ONLY].sort()).toEqual(
      all.filter((route) => route.split(' ')[1]?.startsWith('/.well-known/') === true).sort(),
    );
    expect(driven.length + Object.keys(CONCEALED).length + Object.keys(CRON).length).toBe(
      all.length - EDGE_ONLY.length,
    );
  });

  it('finds a route module for every driven route', () => {
    expect(driven.filter((route) => ROUTE_MODULES[moduleKey(route.path)] === undefined)).toEqual(
      [],
    );
  });
});

describe('(a) the edge refuses a feature the deployment does not install, before authentication', () => {
  const previous = process.env['AW_DEPLOYMENT_FEATURES'];
  afterAll(() => {
    if (previous === undefined) delete process.env['AW_DEPLOYMENT_FEATURES'];
    else process.env['AW_DEPLOYMENT_FEATURES'] = previous;
  });

  function installedWithout(feature: FeatureId): readonly FeatureId[] {
    let installed = FEATURE_IDS.filter((id) => id !== feature);
    for (;;) {
      const stranded = featuresMissingDependencies(installed).map((missing) => missing.feature);
      if (stranded.length === 0) return installed;
      installed = installed.filter((id) => !stranded.includes(id));
    }
  }

  it('answers 404 feature_disabled with the feature on every route outside /p/**', async () => {
    const wrong: string[] = [];
    const edgeRoutes = featureRoutes.filter((route) => !route.path.startsWith('/p/'));
    for (const route of edgeRoutes) {
      const feature = route.feature as FeatureId;
      process.env['AW_DEPLOYMENT_FEATURES'] = installedWithout(feature).join(',');
      const params = paramsFor(route);
      const response = await proxy(
        new NextRequest(new URL(concretePath(route, params), ORIGIN), { method: route.method }),
      );
      const body = (await response.json()) as { error?: { code?: string; details?: unknown } };
      if (
        response.status !== 404 ||
        body.error?.code !== 'feature_disabled' ||
        JSON.stringify(body.error.details) !== JSON.stringify([feature])
      ) {
        wrong.push(
          `${key(route)}: ${String(response.status)} ${JSON.stringify(body).slice(0, 120)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
    expect(edgeRoutes.length).toBeGreaterThan(0);
  });

  it('tags every core route core, and never refuses one under the narrowest deployment', async () => {
    const wrong: string[] = [];
    // The narrowest valid `AW_DEPLOYMENT_FEATURES`: one feature that needs no other.
    const narrowest = FEATURE_IDS.filter((id) => featuresMissingDependencies([id]).length === 0);
    for (const route of coreRoutes) {
      const pathname = concretePath(route, paramsFor(route));
      const tagged = routeFeatureOf(route.method, pathname);
      if (tagged !== 'core') wrong.push(`${key(route)}: ${pathname} is tagged ${String(tagged)}`);
      for (const only of narrowest) {
        process.env['AW_DEPLOYMENT_FEATURES'] = only;
        const response = await proxy(
          new NextRequest(new URL(pathname, ORIGIN), { method: route.method }),
        );
        const text = await response.text();
        if (text.includes('feature_disabled')) {
          wrong.push(`${key(route)} [${only}]: ${String(response.status)} ${text.slice(0, 120)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(coreRoutes.length).toBeGreaterThan(0);
    expect(narrowest.length).toBeGreaterThan(0);
  });
});

describe('(b) a route answers 404 feature_disabled once its credential verifies and its feature is off', () => {
  let teardown = (): void => {};
  let runToken = '';
  let secretHash = '';

  beforeAll(async () => {
    vi.stubEnv('AW_PUBLIC_URL', ORIGIN);
    const harness = installRbacHarness([
      { email: OWNER.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    ]);
    teardown = () => harness.teardown();
    installEmptyDeployment();
    const minted = await mintClientSecret();
    secretHash = minted.secretHash;
    triggerSecret = minted.presented;

    const principal: RunPrincipal = {
      principalId: 'principal-owner',
      ownerPrincipalId: 'principal-owner',
      userId: null,
      workspaceId: TEST_WORKSPACE_ID,
      role: 'owner',
      scope: null,
    };
    installTestRunApi({
      authenticate: () => Promise.resolve(principal),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(false),
      store: new InMemoryRunStore(),
      launch: () => undefined,
      recordRunFeedback: () => Promise.resolve(),
      listAgentFeedback: () => Promise.resolve([]),
    });

    const trigger: TriggerRecord = {
      id: UUID,
      workspaceId: TEST_WORKSPACE_ID,
      agentId: UUID,
      name: 'inbox',
      kind: 'webhook',
      promptTemplate: 'Handle this: {{body}}',
      cron: null,
      timezone: null,
      enabled: true,
      outputSchema: null,
      subject: null,
      ownerPrincipalId: 'principal-owner',
      hasSecret: true,
      lastFiredAt: null,
      scheduleFrom: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    const emptyRepository: TriggerRepository = {
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      create: () => Promise.resolve({ kind: 'agent-not-found' }),
      update: () => Promise.resolve({ kind: 'not-found' }),
      setSecretHash: () => Promise.resolve({ kind: 'not-found' }),
      countDeliveriesSince: () => Promise.resolve(0),
      countUnfinishedRuns: () => Promise.resolve(0),
      markFired: () => Promise.resolve(false),
      remove: () => Promise.resolve(false),
      claimDelivery: () => Promise.resolve({ kind: 'claimed' }),
      recordDeliveryRun: () => Promise.resolve(false),
      releaseDelivery: () => Promise.resolve(false),
      pruneDeliveries: () => Promise.resolve(0),
    };
    const triggers: TriggersRuntime = {
      repository: () => Promise.resolve(emptyRepository),
      findForIngress: () => Promise.resolve({ trigger, secretHash }),
      owner: () => Promise.resolve(null),
      agentOwnership: () => Promise.resolve('unknown'),
      zoomTokens: null,
      now: () => new Date(0),
    };
    installTestDomains({ triggers: { kind: 'serving', runtime: triggers } });

    const toolEndpoint: ToolEndpointEnvironment = {
      identify: () =>
        Promise.resolve({
          principal: { ...principal, role: 'builder', scope: { kind: 'mcp-project', id: CLIENT } },
          via: 'api-key',
          apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          label: 'inventory key',
          oauth: null,
        }),
      agentOwnership: () => Promise.resolve('unknown'),
      productionToolBundles: () => Promise.resolve([]),
      route: () => Promise.reject(new Error('no sandbox is opened')),
      closeSandbox: () => Promise.resolve(),
      fetch: () => Promise.reject(new Error('nothing is fetched')),
      now: () => Date.now(),
    };
    const endpointClients: Partial<EndpointClientsRuntime> = { get: () => Promise.resolve(null) };
    installTestDomains({
      toolEndpoint: { kind: 'serving', environment: toolEndpoint },
      endpointClients: endpointClients as EndpointClientsRuntime,
    });

    const context = applicationContext();
    if (context === null) throw new Error('the application context is not installed');
    const memberRbac = context.rbac;
    installTestDomains({
      rbac: {
        directory: memberRbac.directory,
        identify: async (request) => {
          const member = await memberRbac.identify(request);
          if (member === null || new URL(request.url).pathname !== '/mcp/builder') return member;
          return Principal.fromOAuthToken(
            member,
            { kind: 'builder', id: CLIENT },
            { clientId: CLIENT, audience: `${ORIGIN}/mcp/builder` },
          );
        },
      },
    });

    const tokens = createRunTokenCodec({ secret: RUN_TOKEN_SECRET, now: () => 1_000 });
    runToken = await tokens.issue({
      runId: RUN,
      sessionId: SESSION,
      workspaceId: TEST_WORKSPACE_ID,
      agentId: AGENT,
      modelConnectionId: 'connection-1',
    });
    const verified = await tokens.verify(runToken);
    if (!verified.ok) throw new Error('the fixture run token did not verify');
    const hash = createHash('sha256').update(runToken).digest('hex');
    const database: RunTokenDatabase<WorkspaceScope> = {
      scopes: createInMemoryWorkspaceScopeResolver([{ id: TEST_WORKSPACE_ID, slug: 'inventory' }]),
      runTokens: {
        forScope: () => ({
          isActive: (id, runId, tokenHash) =>
            Promise.resolve(id === verified.claims.tokenId && runId === RUN && tokenHash === hash),
        }),
      },
      runs: {
        forScope: () => ({
          get: () =>
            Promise.resolve({
              sessionId: SESSION,
              workspaceId: TEST_WORKSPACE_ID,
              agentId: AGENT,
              status: 'running' as const,
            }),
        }),
      },
    };
    installTestDomains({
      builder: {
        verifyCaller: createBuilderCallerVerifier({
          tokens,
          database,
          directory: harness.directory,
          agents: {
            forWorkspace: () => ({
              get: () =>
                Promise.resolve({
                  name: 'Builder',
                  ownerPrincipalId: 'principal-owner',
                  builtin: 'builder',
                }),
            }),
          },
          ceiling: null,
        }),
        ports: null,
        readRun: () => Promise.resolve(null),
      },
    });
  }, 120_000);

  afterAll(() => {
    clearFeatureSwitches();
    vi.unstubAllEnvs();
    teardown();
  });

  function requestFor(route: Route, params: Record<string, string>): NextRequest {
    const url = new URL(concretePath(route, params), ORIGIN);
    const door = key(route);
    if (door === FIRE) {
      return new NextRequest(url, { method: 'POST', body: 'hello' });
    }
    if (door === TOOL_ENDPOINT || door === BUILDER_EXTERNAL || door === BUILDER_RUN) {
      // The harness reads any bearer as an API key, so the member reaches /mcp/builder by cookie.
      const credential: Record<string, string> =
        door === BUILDER_EXTERNAL
          ? { cookie: 'session=member', ...callerHeaders(OWNER) }
          : {
              authorization: door === BUILDER_RUN ? `Bearer ${runToken}` : 'Bearer door-credential',
            };
      return new NextRequest(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...credential },
        body: RPC,
      });
    }
    const unsafe = !SAFE_METHODS.has(route.method);
    return new NextRequest(url, {
      method: route.method,
      headers: {
        accept: 'application/json',
        ...callerHeaders(OWNER),
        ...(unsafe ? { origin: ORIGIN, 'content-type': 'application/json' } : {}),
      },
      ...(unsafe ? { body: '{}' } : {}),
    });
  }

  async function drive(route: Route): Promise<{ status: number; text: string }> {
    const load = ROUTE_MODULES[moduleKey(route.path)];
    if (load === undefined) throw new Error(`no route module for ${key(route)}`);
    const loaded = (await load()) as Record<string, unknown>;
    const handler = loaded[route.method] as RouteHandler;
    const params = paramsFor(route);
    const response = await handler(requestFor(route, params), {
      params: Promise.resolve(params),
    });
    return { status: response.status, text: await response.text() };
  }

  it('answers 404 feature_disabled, naming the feature, on every driven route', async () => {
    expect(driven.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const route of driven) {
      const feature = route.feature as FeatureId;
      configureFeatureSwitches({
        enabledFor: () => Promise.resolve(FEATURE_IDS.filter((id) => id !== feature)),
      });
      try {
        const { status, text } = await drive(route);
        const error = (JSON.parse(text) as { error?: { code?: string; details?: unknown } }).error;
        if (
          status !== 404 ||
          error?.code !== 'feature_disabled' ||
          JSON.stringify(error.details) !== JSON.stringify([feature])
        ) {
          wrong.push(`${key(route)} [${feature}]: ${String(status)} ${text.slice(0, 100)}`);
        }
      } catch (error) {
        wrong.push(`${key(route)} [${feature}]: threw ${String(error)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it('does not answer feature_disabled on any driven route while every feature is on', async () => {
    const wrong: string[] = [];
    configureFeatureSwitches({ enabledFor: () => Promise.resolve(FEATURE_IDS) });
    for (const route of driven) {
      try {
        const { text } = await drive(route);
        if (text.includes('feature_disabled')) wrong.push(`${key(route)}: ${text.slice(0, 100)}`);
      } catch (error) {
        wrong.push(`${key(route)}: threw ${String(error)}`);
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);
});
