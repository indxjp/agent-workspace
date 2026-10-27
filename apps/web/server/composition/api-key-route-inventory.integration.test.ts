/**
 * Issue #388: every catalogue route a workspace API key may be presented on, driven through the
 * real edge (`apps/web/proxy.ts`) and the real route handler, with identity resolved by the real
 * production composition (`register()` → `installRbacApi`'s `resolveActor`) against PostgreSQL.
 *
 * `proxy.ts` admits a bearer on these routes by its **shape** alone (`ak_live_…`); it verifies
 * nothing. So every one of these handlers is the only thing between a forged or under-privileged
 * key and the operation. Two defects of exactly that kind shipped with the first version of #388:
 * `POST /api/runtimes/test` had no authentication call at all (it had relied on the proxy's
 * session gate, and would start a sandbox for `Bearer ak_live_x`), and the secrets, runtime and
 * connector collections asked only "which workspace", never "may this role". This suite is the
 * inventory that makes the next one fail:
 *
 *   * **An unknown key is `401` on every route**, answered by the handler after the edge passed it.
 *   * **A Viewer key is `403` on every route §21 denies a Viewer even for its own row**, with the
 *     expectation read from `decide()`'s table and the answer read from the handler — so a handler
 *     that never consults the table fails here. Item routes are driven at rows that exist (seeded
 *     through the routes by an Owner key), so a `404` for a missing row cannot stand in for the
 *     refusal.
 *   * **An Owner key is never `401`**, so the edge and the composition do admit a real key.
 *
 * The route set is `API_ROUTES` filtered by `acceptsApiKey` — the same derivation the edge uses —
 * and the handler for each is loaded from `app/api/**\/route.ts` by `import.meta.glob`, so a route
 * added to the catalogue is swept here with no edit.
 */
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_ROUTES, type ApiRoute } from '@indx-workspace/contracts/routes';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apiKeys,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  endpointClientAgents,
  endpointClients,
  mcpServers,
  runs as runRows,
  sessions as sessionRows,
  triggers,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { proxy } from '../../proxy';
import { acceptsApiKey } from '../auth/api-key-routes';
import { encodeFileId } from '../files/file-id';
import { mintApiKey } from '../rbac/api-key';
import { decide } from '../rbac/decide';
import type { Role } from '../rbac/roles';
import { clearWebRuntimeRegistry, configureWebRuntimeRegistry } from '../runtimes/registry';

import type { RegisteredComposition } from './register';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

if (!hasDatabase) {
  console.warn(
    '[composition/api-key-route-inventory.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so no API-key-accessible route was driven through the edge and its handler.',
  );
}

const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

const ORIGIN = 'http://127.0.0.1:3000';
const PASSED_THROUGH = 'x-middleware-next';
const UNSEEDED_ID = '00000000-0000-4000-8000-000000000000';
/** Shaped exactly like a minted key, so it is refused by the lookup and not by the parser. */
const UNKNOWN_KEY = `ak_live_${'A'.repeat(22)}_${'B'.repeat(43)}`;

type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

/** Every route module in the tree, keyed `../../app/api/<…>/route.ts`. */
const ROUTE_MODULES = import.meta.glob('../../app/api/**/route.ts');

function moduleKey(pattern: string): string {
  return `../../app${pattern.replace(/:([A-Za-z]+)/gu, '[$1]')}/route.ts`;
}

function label(route: ApiRoute): string {
  return `${route.method} ${route.path}`;
}

const KEY_ROUTES = API_ROUTES.filter(acceptsApiKey);

/** A run of the seeded agent, owned by the Owner key's principal, for `POST /api/tokens`. */
const SEEDED_RUN_ID = crypto.randomUUID();

/** The file the Owner key uploads, and the id its item routes address it by. */
const SEEDED_FILE_PATH = 'inventory.txt';

/**
 * A well-formed body for the routes that parse theirs before the role decision, so a probe reaches
 * the decision rather than a `400` about its body. Every other unsafe probe sends `{}`.
 */
const PROBE_BODIES: Readonly<Record<string, unknown>> = {
  // Ownership is derived from the scope named in the body, so it is read first (issue #236).
  // The run the Owner key's principal owns is seeded below, and read back when the probe runs.
  'POST /api/tokens': { scope: { kind: 'run', id: SEEDED_RUN_ID } },
  'PATCH /api/projects/:id': { name: 'Renamed by the inventory' },
};

/**
 * Routes §21 denies a Viewer outright that nevertheless answer a Viewer by design, each with the
 * record that declares it. Exact `METHOD /path` keys; a stale entry fails the suite.
 */
const VIEWER_EXCEPTIONS: Readonly<Record<string, string>> = {
  'GET /api/model-connections':
    'Declared gap G-12 (the Wave 9 plan, ADR W9-SEC-149): model-connection reads stay membership-scoped; only writes reach decide().',
  'GET /api/model-connections/:id': 'Declared gap G-12, as above.',
  'GET /api/models': 'Declared gap G-12, as above: the model catalogue is a model-connection read.',
};

/**
 * Routes that answer a refused caller `404` rather than `403`, by design, so as not to confirm that
 * a row outside the caller's reach exists. Exact keys; the refusal is still asserted, and the row
 * is checked to be unchanged afterwards.
 */
const CONCEALS_REFUSAL_AS_404: Readonly<Record<string, string>> = {
  'POST /api/projects/:id/archive':
    'server/projects/lifecycle.ts maps the gate’s 403 to project_not_found: "is there such a project" gets one answer.',
  'POST /api/projects/:id/restore': 'The same transition path as archive, above.',
};

/**
 * Whether §21 refuses a Viewer this route even when the row is its own — the routes an Owner or
 * Admin (or a Builder) must hold. Read from the table itself rather than restated, so a change to
 * §21 moves the expectation with it.
 */
function deniedToViewerOutright(route: ApiRoute, concrete: string): boolean {
  const verdict = decide({
    role: 'viewer',
    method: route.method,
    path: concrete,
    ownership: 'own',
    scope: null,
  });
  return verdict.effect === 'deny';
}

describe.skipIf(!hasDatabase)(
  'every API-key-accessible route, through the edge and its handler',
  () => {
    let isolated: IsolatedTestDatabase | undefined;
    let composition: RegisteredComposition | undefined;
    let storageRoot: string | undefined;
    const previousEnv = new Map<string, string | undefined>();
    const keys = new Map<Role, string>();
    /** Ids of rows the Owner key created, by the catalogue path prefix that addresses them. */
    const seeded = new Map<string, string>();
    const registryCalls: unknown[][] = [];

    async function serve(route: ApiRoute, concrete: string, apiKey: string): Promise<Response> {
      const unsafe = route.method !== 'GET';
      const request = new NextRequest(new URL(concrete, ORIGIN), {
        method: route.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(unsafe ? { 'content-type': 'application/json' } : {}),
        },
        ...(unsafe ? { body: JSON.stringify(PROBE_BODIES[label(route)] ?? {}) } : {}),
      });
      const gated = await proxy(request);
      if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
      const load = ROUTE_MODULES[moduleKey(route.path)];
      if (load === undefined) throw new Error(`no route module for ${label(route)}`);
      const module = (await load()) as Record<string, unknown>;
      const handler = module[route.method];
      if (typeof handler !== 'function') throw new Error(`${label(route)} exports no handler`);
      const params: Record<string, string> = {};
      const patternSegments = route.path.split('/');
      const concreteSegments = new URL(concrete, ORIGIN).pathname.split('/');
      patternSegments.forEach((segment, index) => {
        if (segment.startsWith(':')) params[segment.slice(1)] = concreteSegments[index] ?? '';
      });
      return (handler as RouteHandler)(request, { params: Promise.resolve(params) });
    }

    /** The concrete path a probe addresses: a seeded row where one exists, else an unseeded id. */
    function concretePath(route: ApiRoute): string {
      return route.path.replace(/:([A-Za-z]+)/gu, (_match, name: string, offset: number) => {
        if (route.path.startsWith('/api/runtimes/')) return 'test';
        if (route.path.startsWith('/api/files/')) return encodeFileId(SEEDED_FILE_PATH);
        const prefix = route.path.slice(0, offset - 1);
        const row = seeded.get(prefix);
        if (row !== undefined) return row;
        return name === 'name' ? 'no-such-skill' : UNSEEDED_ID;
      });
    }

    async function ownerCreates(collection: string, body: unknown): Promise<string> {
      const route = KEY_ROUTES.find((each) => each.method === 'POST' && each.path === collection);
      if (route === undefined) throw new Error(`${collection} has no key-accessible POST`);
      const request = new NextRequest(new URL(collection, ORIGIN), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${keys.get('owner') ?? ''}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const load = ROUTE_MODULES[moduleKey(collection)];
      if (load === undefined) throw new Error(`no route module for POST ${collection}`);
      const handler = ((await load()) as Record<string, RouteHandler>)['POST'];
      if (handler === undefined) throw new Error(`POST ${collection} has no handler`);
      const response = await handler(request, { params: Promise.resolve({}) });
      const text = await response.text();
      if (response.status !== 201) {
        throw new Error(`seeding ${collection} answered ${String(response.status)}: ${text}`);
      }
      const created = JSON.parse(text) as Record<string, unknown>;
      const resource = Object.values(created).find(
        (value): value is { id: string } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { id?: unknown }).id === 'string',
      );
      const id = typeof created['id'] === 'string' ? created['id'] : resource?.id;
      if (id === undefined) throw new Error(`seeding ${collection} returned no id: ${text}`);
      return id;
    }

    beforeAll(async () => {
      for (const name of CONTROLLED_ENV) previousEnv.set(name, process.env[name]);
      isolated = await createIsolatedTestDatabase('aw_api_key_route_inventory');
      const workspaceId = crypto.randomUUID();
      await isolated.db.insert(workspaces).values({
        id: workspaceId,
        slug: 'api-key-route-inventory',
        name: 'API-key route inventory',
      });
      let ownerKeyId = '';
      for (const role of ['owner', 'admin', 'builder', 'viewer'] as const) {
        const minted = await mintApiKey();
        const apiKeyId = crypto.randomUUID();
        if (role === 'owner') ownerKeyId = apiKeyId;
        await isolated.db.insert(apiKeys).values({
          id: apiKeyId,
          workspaceId,
          name: `inventory-${role}`,
          role,
          keyPrefix: minted.keyPrefix,
          keyHash: minted.keyHash,
        });
        keys.set(role, minted.presented);
      }

      storageRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-key-inventory-'));
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'api-key-route-inventory-secret-at-least-32-characters';
      process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
      process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
      process.env['AW_STORAGE_URL'] = pathToFileURL(storageRoot).href;
      for (const name of [
        'AW_RUNTIME_VERIFICATION_FILE',
        'GATEWAY_TOKEN_SECRET',
        'NEXT_RUNTIME',
        'RUNNER_MANAGER_TOKEN',
        'RUNNER_MANAGER_URL',
      ] as const) {
        delete process.env[name];
      }
      const { register } = await import('./register');
      composition = await register();
      if (composition === undefined) throw new Error('composition registration was skipped');

      // `POST /api/runtimes/test` starts a sandbox through this registry; recording it proves that
      // no refused request ever reaches it, rather than inferring it from a status code.
      configureWebRuntimeRegistry({
        list: () => Promise.resolve([]),
        test(driverId, echo) {
          registryCalls.push([driverId, echo]);
          return Promise.resolve({ driverId, transcript: [echo], destroyed: true });
        },
      });

      // Rows the Viewer probes address, created through the routes by the Owner key: a refusal on
      // an item route must be a refusal, not a `404` for a row that was never there.
      seeded.set(
        '/api/secrets',
        await ownerCreates('/api/secrets', { name: 'INVENTORY_KEY', value: 'v' }),
      );
      seeded.set(
        '/api/runtime-profiles',
        await ownerCreates('/api/runtime-profiles', {
          name: 'Inventory',
          driver: 'docker',
          networkPolicy: 'restricted',
          allowedDomains: ['api.anthropic.com'],
          filesystem: 'read-write',
          cpu: 1,
          memoryMb: 1024,
        }),
      );
      seeded.set(
        '/api/agents',
        await ownerCreates('/api/agents', {
          name: 'Inventory agent',
          instructions: 'Seeded by the API-key route inventory.',
          modelConnectionId: null,
          model: 'claude-sonnet-4-5',
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        }),
      );
      seeded.set(
        '/api/projects',
        await ownerCreates('/api/projects', {
          name: 'Inventory project',
          instructions: null,
          defaultAgentId: null,
          visibility: 'private',
          fileIds: [],
          mcpServerIds: [],
        }),
      );
      const uploadModule = (await ROUTE_MODULES[moduleKey('/api/files')]?.()) as
        Record<string, RouteHandler> | undefined;
      const upload = await uploadModule?.['POST']?.(
        new NextRequest(new URL('/api/files', ORIGIN), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${keys.get('owner') ?? ''}`,
            'content-type': 'text/plain',
            'x-file-path': SEEDED_FILE_PATH,
          },
          body: 'seeded by the API-key route inventory',
        }),
        { params: Promise.resolve({}) },
      );
      if (upload?.status !== 201) {
        throw new Error(
          `seeding a file answered ${String(upload?.status)}: ${await upload?.text()}`,
        );
      }
      // An API key cannot create a connector through the route (a connector is attributed to a
      // member, and a key has none), so the Owner key's principal owns one inserted directly.
      const ownerKeyPrincipal = (await isolated.db.select().from(workspacePrincipals)).find(
        (principal) => principal.workspaceId === workspaceId && principal.apiKeyId === ownerKeyId,
      );
      if (ownerKeyPrincipal === undefined) throw new Error('the Owner key has no principal');
      const connectorId = crypto.randomUUID();
      await isolated.db.insert(mcpServers).values({
        id: connectorId,
        workspaceId,
        name: 'Inventory connector',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        ownerPrincipalId: ownerKeyPrincipal.id,
      });
      seeded.set('/api/connectors', connectorId);
      const agentId = seeded.get('/api/agents');
      if (agentId === undefined) throw new Error('the agent was not seeded');
      // A key cannot create an endpoint client (it acts for no member), so the row the Viewer
      // probes address is inserted directly, as the connector above is.
      const endpointClientId = crypto.randomUUID();
      await isolated.db.insert(endpointClients).values({
        id: endpointClientId,
        workspaceId,
        name: 'inventory-client',
        kind: 'a2a-agent',
        actsForPrincipalId: ownerKeyPrincipal.id,
        createdByPrincipalId: ownerKeyPrincipal.id,
      });
      await isolated.db
        .insert(endpointClientAgents)
        .values({ clientId: endpointClientId, workspaceId, agentId });
      seeded.set('/api/endpoint-clients', endpointClientId);
      // A key cannot create a trigger either (it is owned by a member), so the row is inserted
      // directly for the Viewer probes to address.
      const triggerId = crypto.randomUUID();
      await isolated.db.insert(triggers).values({
        id: triggerId,
        workspaceId,
        agentId,
        name: 'inventory-trigger',
        kind: 'webhook',
        promptTemplate: 'Handle {{body}}',
        ownerPrincipalId: ownerKeyPrincipal.id,
        secretHash: '0'.repeat(64),
      });
      seeded.set('/api/triggers', triggerId);
      const sessionId = crypto.randomUUID();
      await isolated.db.insert(sessionRows).values({
        id: sessionId,
        workspaceId,
        userId: null,
        ownerPrincipalId: ownerKeyPrincipal.id,
        agentId,
      });
      await isolated.db.insert(runRows).values({ id: SEEDED_RUN_ID, workspaceId, sessionId });
    }, 180_000);

    afterAll(async () => {
      clearWebRuntimeRegistry();
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (isolated !== undefined) {
        await closeIsolatedTestResources(
          isolated,
          ...(composition === undefined ? [] : [composition]),
        );
      }
      if (storageRoot !== undefined) await rm(storageRoot, { recursive: true, force: true });
    });

    it('has a route module and handler for every key-accessible catalogue route', () => {
      expect(KEY_ROUTES.length).toBeGreaterThan(0);
      const missing = KEY_ROUTES.filter(
        (route) => ROUTE_MODULES[moduleKey(route.path)] === undefined,
      );
      expect(missing.map(label)).toEqual([]);
    });

    it('answers 401 to an unknown key on every route, from the handler after the edge passed it', async () => {
      const wrong: string[] = [];
      for (const route of KEY_ROUTES) {
        const response = await serve(route, concretePath(route), UNKNOWN_KEY);
        if (response.status !== 401) {
          wrong.push(`${label(route)} → ${String(response.status)} ${await response.text()}`);
        }
      }
      expect(wrong).toEqual([]);
      expect(registryCalls).toEqual([]);
    }, 180_000);

    it('answers 403 to a Viewer key on every route §21 denies a Viewer outright', async () => {
      const probed: string[] = [];
      const wrong: string[] = [];
      const excepted: string[] = [];
      for (const route of KEY_ROUTES) {
        const concrete = concretePath(route);
        if (!deniedToViewerOutright(route, concrete)) continue;
        if (label(route) in VIEWER_EXCEPTIONS) {
          excepted.push(label(route));
          continue;
        }
        probed.push(label(route));
        const response = await serve(route, concrete, keys.get('viewer') ?? '');
        const expected = label(route) in CONCEALS_REFUSAL_AS_404 ? 404 : 403;
        if (response.status !== expected) {
          wrong.push(`${label(route)} → ${String(response.status)} ${await response.text()}`);
        }
      }
      // The routes that motivated this suite are in the probed set, so it cannot pass by probing
      // nothing (a `decide()` change that stopped denying them would fail here, not silently).
      expect(probed).toEqual(
        expect.arrayContaining([
          'POST /api/runtimes/:id',
          'GET /api/secrets',
          'POST /api/secrets',
          'PUT /api/secrets/:id',
          'GET /api/runtime-profiles',
          'PATCH /api/runtime-profiles/:id',
          'GET /api/runtime-connections',
          'POST /api/runtime-connections',
          'GET /api/connectors',
          'PATCH /api/agents/:id',
          'DELETE /api/connectors/:id',
          'GET /api/files/:id',
        ]),
      );
      expect(excepted.sort(), 'a Viewer exception names a route §21 no longer denies').toEqual(
        Object.keys(VIEWER_EXCEPTIONS).sort(),
      );
      expect(probed).toEqual(expect.arrayContaining(Object.keys(CONCEALS_REFUSAL_AS_404)));
      // A concealed refusal is still a refusal: neither transition happened, so neither was audited.
      const transitions = (await isolated?.db.select().from(auditEvents))?.filter(
        (event) => event.action === 'project-archived' || event.action === 'project-restored',
      );
      expect(transitions).toEqual([]);
      expect(wrong).toEqual([]);
      expect(registryCalls).toEqual([]);
    }, 180_000);

    // Issue #388, round 3: the gate must not over-refuse either. Creating and editing an agent is
    // a Builder's core §21 capability, and the agent editor (and the SDK's agent-definition export
    // and import) read these lists to fill the agent's runtime profile, connectors, files and
    // skills; a 403 on any of them leaves a Builder unable to create an agent at all.
    it('lets a Builder key read what the agent editor lists', async () => {
      const editorReads = [
        'GET /api/runtime-profiles',
        'GET /api/runtime-profiles/:id',
        'GET /api/connectors',
        'GET /api/files',
        'GET /api/skills',
      ];
      const wrong: string[] = [];
      for (const wanted of editorReads) {
        const route = KEY_ROUTES.find((candidate) => label(candidate) === wanted);
        if (route === undefined) {
          wrong.push(`${wanted} is not an API-key-accessible catalogue route`);
          continue;
        }
        const response = await serve(route, concretePath(route), keys.get('builder') ?? '');
        if (response.status !== 200) {
          wrong.push(`${wanted} → ${String(response.status)} ${await response.text()}`);
        }
      }
      expect(wrong).toEqual([]);
    }, 180_000);

    // Secrets are Owner-only (§21). The Viewer sweep above cannot tell an Owner-only gate from an
    // Admin-or-Builder one, so the two roles between them are probed here on every secrets route.
    it('refuses an Admin key and a Builder key on every secrets route with 403', async () => {
      const secretsRoutes = KEY_ROUTES.filter((route) => route.path.startsWith('/api/secrets'));
      expect(secretsRoutes.map(label).sort()).toEqual([
        'DELETE /api/secrets/:id',
        'GET /api/secrets',
        'POST /api/secrets',
        'PUT /api/secrets/:id',
      ]);
      const wrong: string[] = [];
      for (const role of ['admin', 'builder'] as const) {
        for (const route of secretsRoutes) {
          const response = await serve(route, concretePath(route), keys.get(role) ?? '');
          if (response.status !== 403) {
            wrong.push(
              `${role} ${label(route)} → ${String(response.status)} ${await response.text()}`,
            );
          }
        }
      }
      expect(wrong).toEqual([]);
    }, 180_000);

    it('never answers 401 to the Owner key, so the edge and the composition admit a real one', async () => {
      const wrong: string[] = [];
      for (const route of KEY_ROUTES) {
        const response = await serve(route, concretePath(route), keys.get('owner') ?? '');
        if (response.status === 401) wrong.push(`${label(route)} → ${await response.text()}`);
      }
      expect(wrong).toEqual([]);
    }, 180_000);
  },
);
