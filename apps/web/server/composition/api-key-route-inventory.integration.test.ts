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

import { describe, expect, it } from 'vitest';
import { auditEvents } from '@agent-workspace/core/db/unscoped';
import {
  CONCEALS_REFUSAL_AS_404,
  deniedToViewerOutright,
  hasDatabase,
  KEY_ROUTES,
  label,
  moduleKey,
  ROUTE_MODULES,
  UNKNOWN_KEY,
  useRouteInventory,
  VIEWER_EXCEPTIONS,
} from './api-key-route-inventory.test-support';
if (!hasDatabase) {
  console.warn(
    '[composition/api-key-route-inventory.integration.test.ts] SKIPPED — TEST_DATABASE_URL is not ' +
      'set, so no API-key-accessible route was driven through the edge and its handler.',
  );
}

describe.skipIf(!hasDatabase)(
  'every API-key-accessible route, through the edge and its handler',
  () => {
    const { serve, concretePath, keys, registryCalls, database } = useRouteInventory();

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
      const transitions = (await database()?.db.select().from(auditEvents))?.filter(
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
