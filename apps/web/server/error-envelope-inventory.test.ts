/**
 * Issue #238, acceptance criterion 1 (SDK-06c): **every `4xx`/`5xx` any public API route answers
 * is the one standard problem envelope**, `{ error: { code, message, details?, detail? } }`
 * (`ApiProblemSchema`, ADR-0075) — proved by driving every declared route's refusal paths, never
 * by reading the handlers and believing them.
 *
 * ## Where the routes come from
 *
 * The route list is `tests/route-declarations/**`, read through the same reader
 * `tests/route-inventory.test.ts` and `apps/web/server/rbac/authorisation-matrix.test.ts` use
 * ([ADR-0025](../../../docs/adr/0025-the-route-inventory-is-partitioned-by-owner.md)). The
 * inventory gate asserts that union **equals** the route handlers the tracked tree serves, so a
 * route cannot hide from this sweep by being undeclared, and a route added tomorrow is probed
 * tomorrow with no edit here. The route *modules* come from `import.meta.glob` over
 * `app/api/**\/route.ts` — the one construct that loads every handler without a hand-written list
 * — and that set is derived a second time from `git ls-files`, so a glob that went narrow fails
 * rather than probing nothing. The glob hands the `no-sdk-import` gate no specifier it could
 * resolve, and it does not need to: every file it reaches is a tracked route file that gate scans
 * in its own right.
 *
 * ## The two layers a refusal can come from
 *
 *   * **The edge** — `apps/web/proxy.ts`, which answers `401` for a caller with no session, `403`
 *     for a cross-origin write, and `426` for a contracts version it no longer serves (ADR-0078),
 *     before any handler runs. Each declared route is driven through `proxy()` with and without the
 *     `X-Agent-Workspace-Contracts` header: the SDK sends it, a raw `fetch` may not, and both must
 *     be refused in the same envelope.
 *   * **The handler** — each declared method of each route module, called with a real
 *     `NextRequest` under `apps/web/server/rbac/testing.ts`'s harness (a real `RbacRuntime` over an
 *     in-memory directory), as three callers: nobody (`401`), a Viewer (`403` on every write), and
 *     an Owner addressing an id that does not exist (`404`, or the `503` of a subsystem this
 *     process has not installed). Every write is sent twice: a body that is not JSON (`400`) and an
 *     empty object (`400` from the validator, where the handler gets that far). A handler that
 *     throws instead of answering is a failure here too — Next would render that as a bodiless
 *     `500`, which is not the envelope either.
 *
 * How deep the handler pass reaches is stated rather than implied (ADR-0031). This process installs
 * the RBAC runtime and the rest of the application context as a deployment with an empty database
 * has it ({@link installEmptyDeployment}): a subsystem with an absent state (storage, secrets,
 * models, runtimes, the run runtime's surfaces) is in it, so its handlers answer their own
 * `503 <subsystem>_runtime_not_configured` before they read the caller, the id or the body; the
 * domains production always builds from the database read empty in-memory rows, so their routes go
 * on to their `401`, `403`, `404` and `400`. The deeper refusals of the other subsystems are held by a
 * third, static pass: no tracked handler or server module outside the excluded routes' own files
 * may spell the bare-code body `{ error: '<code>' }` at all, so a refusal this process cannot reach
 * still cannot be written in the old shape — neither as a string literal nor as a code read from a
 * variable (`{ error: result.code }`). The integration-level probe
 * (`tests/no-route-answers-503.test.ts`) drives the same routes against a real deployment, but it
 * asserts only that no route answers `503`; it does not parse the body, so it is not an envelope
 * check and this file does not lean on it as one.
 *
 * `405` is Next's own answer for a method a route module does not export, rendered by the
 * framework with no body before any code of this repository runs, so there is nothing in-process
 * to drive; this sweep probes exactly the declared methods.
 *
 * ## The exclusions are an equality
 *
 * {@link EXCLUDED} names every route this sweep does not hold to the envelope, each with its
 * reason, and it is asserted **equal** to the routes it names in the declaration union — so a
 * route cannot be excluded by a typo, an excluded route that is deleted or fixed turns this file
 * red until the entry goes, and the list is also asserted to stay small.
 */
import {
  ApiProblemSchema,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  readDeclarationFiles,
  requireString,
  trackedFiles,
} from '../../../tests/inventory-support';
import { proxy } from '../proxy';

import {
  MIN_SESSION_SECRET_LENGTH,
  sessionCookieName,
  mintSessionToken,
  newSessionClaims,
} from './auth/session';
import { installEmptyDeployment } from './empty-deployment-fixture';
import {
  callerHeaders,
  installRbacHarness,
  TEST_WORKSPACE_ID,
  type RbacHarness,
} from './rbac/testing';

/** What a route module exports, as far as this sweep calls it. */
type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;
type RouteModule = Readonly<Record<string, unknown>>;

/**
 * Every route module in the tree, keyed `../app/api/<…>/route.ts`. Lazy, so a module that fails to
 * load is reported against its route rather than failing the whole file at collection time.
 * `**` skips dot-directories, so the A2A card's `.well-known` segment (ADR-0135) is named outright.
 */
const ROUTE_MODULES = import.meta.glob([
  '../app/api/**/route.ts',
  '../app/api/**/.well-known/**/route.ts',
]);

function isRouteModule(value: unknown): value is RouteModule {
  return typeof value === 'object' && value !== null;
}

/**
 * The routes this sweep does not hold to the standard envelope, and why. Exact `METHOD /path`
 * keys; no prefix, so nothing is excluded by accident.
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  'GET /api/auth/workspace':
    'OIDC browser page (issue #118): the HTML workspace-selection page the callback redirects to. Its POST is probed on the JSON branch the SDK uses; the browser form branch keeps its bare body byte for byte for one release (spec 04 §3.2).',
  'GET /api/auth/login':
    'OIDC browser redirect (issue #118): a top-level navigation answered with a 302 or an HTML-facing redirect, never read by an API client.',
  'POST /api/auth/callback':
    "OIDC browser redirect (issue #118): the identity provider's form_post back to this application, answered with redirects to /signin.",
  'GET /p/:token':
    'Public share surface (/p/*, W5-CP-06): an unauthenticated page for anonymous readers, outside /api and outside the SDK.',
  'POST /p/:token/messages':
    'Public share surface (/p/*, W5-CP-06): an anonymous reader continuing a shared session, outside /api and outside the SDK.',
  'POST /api/runtimes/:id':
    'Server change S-4 (spec 04 §8), owned by SDK unit 9 (#241) and out of scope for #238: the runtime test route still answers the bare-code envelope, which the SDK reads through ApiProblemBareCodeSchema.',
};

/**
 * Routes with no refusal for this sweep to observe: every probe is answered `2xx`. Asserted equal to
 * what the run observed, so a route cannot land here by being probed badly.
 */
const NEVER_REFUSES: Readonly<Record<string, string>> = {
  'GET /api/readyz':
    'The readiness probe (issue #1562): it reads no caller and no body, and refuses only for a malformed MASTER_ENCRYPTION_KEY, which this process does not configure. That 503 is the standard envelope, pinned in server/readiness.test.ts.',
  'POST /api/auth/cli-device':
    'The first step of the CLI device sign-in (issue #242): it starts a sign-in for any caller, pre-authentication, and reads no body. Its one refusal in a wired deployment is 429 over the rate limit, whose envelope cli-auth/handlers.test.ts asserts.',
  'GET /api/setup/runtime-detect':
    'A read-only, pre-authentication probe of the local container runtime that answers 200 with what it found to every caller; it has no refusal path.',
};

/**
 * The bare-code body, `{ error: '<code>' }`: an `error` key whose value is a string literal, or a
 * code read from a variable (`{ error: code }`, `{ error: result.code }`). The standard envelope's
 * `error` is always an object.
 */
const BARE_CODE_BODY = /\berror:\s*(?:['"`]|(?:[A-Za-z_$][\w$]*\.)?code\b)/u;

/** The most exclusions this sweep tolerates. Raising it is a decision, not a convenience. */
const MAX_EXCLUSIONS = 6;

const ORIGIN = 'https://control-plane.test';
const SESSION_SECRET = 's'.repeat(MIN_SESSION_SECRET_LENGTH);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const OWNER = { email: 'owner@envelope.test' };
const VIEWER = { email: 'viewer@envelope.test' };

interface DeclaredRoute {
  readonly method: string;
  readonly path: string;
  readonly owner: string;
}

function key(route: { readonly method: string; readonly path: string }): string {
  return `${route.method} ${route.path}`;
}

function declaredRoutes(): DeclaredRoute[] {
  return readDeclarationFiles('tests/route-declarations', 'routes').flatMap((file) =>
    file.entries.map((entry, index) => {
      const where = `${file.repoPath} entry ${String(index)}`;
      return {
        method: requireString(entry, 'method', where),
        path: requireString(entry, 'path', where),
        owner: requireString(entry, 'owner', where),
      };
    }),
  );
}

/** `/api/agents/:id` → `../app/api/agents/[id]/route.ts`, the glob's key for its module. */
function moduleKey(pattern: string): string {
  return `../app${pattern.replace(/:([A-Za-z]+)/gu, '[$1]')}/route.ts`;
}

/**
 * A value for each path parameter that names nothing: a UUID for an id, so a handler that checks
 * the shape of an id gets past that check and answers from its lookup instead.
 */
function paramsFor(pattern: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const match of pattern.matchAll(/:([A-Za-z]+)/gu)) {
    const name = match[1] as string;
    params[name] = name === 'name' ? 'no-such-skill' : '00000000-0000-4000-8000-000000000000';
  }
  return params;
}

function concretePath(pattern: string): string {
  const params = paramsFor(pattern);
  return pattern.replace(/:([A-Za-z]+)/gu, (_, name: string) => params[name] ?? '');
}

/** One answer this sweep observed, and where it came from. */
interface Observation {
  readonly route: string;
  readonly probe: string;
  readonly status: number;
  readonly text: string;
}

/** `null` when the answer is not a refusal or is a well-formed envelope; otherwise the reason. */
function envelopeViolation(observation: Observation): string | null {
  if (observation.status < 400) return null;
  let body: unknown;
  try {
    body = JSON.parse(observation.text) as unknown;
  } catch {
    return `a ${String(observation.status)} whose body is not JSON: ${JSON.stringify(observation.text.slice(0, 120))}`;
  }
  const parsed = ApiProblemSchema.safeParse(body);
  if (parsed.success) return null;
  return `a ${String(observation.status)} that is not the standard envelope: ${observation.text.slice(0, 200)}`;
}

const allRoutes = declaredRoutes();
const probedRoutes = allRoutes.filter((route) => !(key(route) in EXCLUDED));
const apiRoutes = probedRoutes.filter((route) => route.path.startsWith('/api/'));

describe('the sweep covers the whole declared API surface', () => {
  it('loads a route module for every declared /api route, derived twice from the tracked tree', () => {
    const tracked = trackedFiles('apps/web/app/api')
      .filter((file) => file.endsWith('/route.ts'))
      .map((file) => `../${file.slice('apps/web/'.length)}`)
      .sort();
    expect(tracked.length, 'git listed no tracked route files').toBeGreaterThan(0);
    // The glob walks the working directory, so it may also see a route another test writes for
    // the length of its run (`tests/auth.test.ts` plants one under `app/api/w1cp06-unregistered/`)
    // and never commits. The committed tree is the route surface (the rule
    // `tests/route-inventory.test.ts` states), so the glob must reach every tracked route file
    // and an untracked extra is not part of the surface this sweep holds to anything.
    const globbed = new Set(Object.keys(ROUTE_MODULES));
    expect(
      tracked.filter((file) => !globbed.has(file)),
      'the glob missed tracked route files that `git ls-files` lists',
    ).toEqual([]);
    const trackedSet = new Set(tracked);
    const unmatched = allRoutes
      .filter((route) => route.path.startsWith('/api/'))
      .map((route) => moduleKey(route.path))
      .filter((file) => !trackedSet.has(file));
    expect(unmatched, 'a declared route has no tracked route module at the path it names').toEqual(
      [],
    );
    expect(apiRoutes.length).toBeGreaterThan(0);
  });

  it('excludes exactly the routes it names, each with a reason, and no more than a handful', () => {
    const declared = new Set(allRoutes.map(key));
    const stale = Object.keys(EXCLUDED).filter((entry) => !declared.has(entry));
    expect(stale, 'an exclusion names a route that is not declared: remove it').toEqual([]);
    for (const [route, reason] of Object.entries(EXCLUDED)) {
      expect(reason.trim().length, `${route} is excluded without a reason`).toBeGreaterThan(20);
    }
    expect(Object.keys(EXCLUDED).length).toBeLessThanOrEqual(MAX_EXCLUSIONS);
  });

  it('finds the bare-code body in no handler source but the excluded routes’ own files', () => {
    // The static half of the sweep (see the header): what the handler pass cannot reach in this
    // process must at least not be *written* in the old shape. The expected set is derived from
    // `EXCLUDED`, so fixing an excluded route turns this red until its entry goes.
    const sources = [
      ...trackedFiles('apps/web/app/api'),
      ...trackedFiles('apps/web/server'),
    ].filter((file) => /\.(ts|tsx|mts)$/u.test(file) && !/\.test\.tsx?$/u.test(file));
    const spelled = sources
      .filter((file) => BARE_CODE_BODY.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
      .sort();
    const excludedSources = [
      ...new Set(
        Object.keys(EXCLUDED)
          .map((route) => route.split(' ')[1] ?? '')
          .filter((routePath) => routePath.startsWith('/api/'))
          .map((routePath) => `apps/web/${moduleKey(routePath).slice('../'.length)}`),
      ),
    ].sort();
    expect(spelled).toEqual(excludedSources);
  });
});

describe('the edge (apps/web/proxy.ts) refuses in the standard envelope', () => {
  const previousSecret = process.env['SESSION_SECRET'];
  const observations: Observation[] = [];

  beforeAll(async () => {
    process.env['SESSION_SECRET'] = SESSION_SECRET;
    const token = await mintSessionToken(
      newSessionClaims(OWNER.email, 'envelope-sweep'),
      SESSION_SECRET,
    );
    for (const route of apiRoutes) {
      const url = new URL(concretePath(route.path), ORIGIN);
      const unsafe = !SAFE_METHODS.has(route.method);
      const probes: [string, Record<string, string>][] = [
        ['no session, no contracts header', {}],
        ['no session, the SDK contracts header', { [CONTRACTS_VERSION_HEADER]: CONTRACTS_VERSION }],
        ['an unsupported contracts version', { [CONTRACTS_VERSION_HEADER]: '999.0.0' }],
      ];
      if (unsafe) {
        probes.push([
          'a session, a cross-origin write',
          { cookie: `${sessionCookieName()}=${token}`, origin: 'https://elsewhere.test' },
        ]);
      }
      for (const [probe, headers] of probes) {
        const response = await proxy(new NextRequest(url, { method: route.method, headers }));
        if (response.headers.get('x-middleware-next') !== null) continue;
        observations.push({
          route: key(route),
          probe,
          status: response.status,
          text: await response.text(),
        });
      }
    }
  });

  afterAll(() => {
    if (previousSecret === undefined) delete process.env['SESSION_SECRET'];
    else process.env['SESSION_SECRET'] = previousSecret;
  });

  it('refused every route an unsupported contracts version, so the probe measured the edge', () => {
    const statuses = new Set(observations.map((observation) => observation.status));
    expect([...statuses].sort()).toEqual(expect.arrayContaining([401, 403, 426]));
    const refusedVersion = new Set(
      observations
        .filter(
          (observation) =>
            observation.probe === 'an unsupported contracts version' && observation.status === 426,
        )
        .map((observation) => observation.route),
    );
    expect(
      apiRoutes.map(key).filter((route) => !refusedVersion.has(route)),
      'a route the edge let through with a contracts version it does not serve',
    ).toEqual([]);
  });

  it('answers every edge refusal in the standard envelope', () => {
    const violations = observations
      .map((observation) => ({ observation, violation: envelopeViolation(observation) }))
      .filter((entry) => entry.violation !== null)
      .map(
        (entry) =>
          `${entry.observation.route} (${entry.observation.probe}): ${entry.violation ?? ''}`,
      );
    expect(violations).toEqual([]);
  });
});

describe('every route handler refuses in the standard envelope', () => {
  const observations: Observation[] = [];
  const threw: string[] = [];
  let harness: RbacHarness | null = null;

  beforeAll(async () => {
    harness = installRbacHarness([
      { email: OWNER.email, name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
      { email: VIEWER.email, name: 'Viewer', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
    ]);
    installEmptyDeployment();
    for (const route of apiRoutes) {
      const load = ROUTE_MODULES[moduleKey(route.path)];
      if (load === undefined) continue;
      let loaded: unknown;
      try {
        loaded = await load();
      } catch (error) {
        threw.push(`${key(route)}: the module failed to load: ${String(error)}`);
        continue;
      }
      if (!isRouteModule(loaded)) {
        threw.push(`${key(route)}: the module is not an object`);
        continue;
      }
      const handler = loaded[route.method];
      if (typeof handler !== 'function') {
        threw.push(`${key(route)}: the module does not export ${route.method}`);
        continue;
      }
      const unsafe = !SAFE_METHODS.has(route.method);
      const bodies: [string, string | undefined][] = unsafe
        ? [
            ['a body that is not JSON', '{"unterminated'],
            ['an empty JSON object', '{}'],
          ]
        : [['no body', undefined]];
      const callers: [string, string | null][] = [
        ['nobody', null],
        ['a Viewer', VIEWER.email],
        ['an Owner, an id that does not exist', OWNER.email],
      ];
      for (const [who, email] of callers) {
        for (const [what, body] of bodies) {
          const headers: Record<string, string> = {
            accept: 'application/json',
            ...callerHeaders(email === null ? null : { email }),
          };
          if (unsafe) headers['origin'] = ORIGIN;
          if (body !== undefined) headers['content-type'] = 'application/json';
          const request = new NextRequest(new URL(concretePath(route.path), ORIGIN), {
            method: route.method,
            headers,
            ...(body === undefined ? {} : { body }),
          });
          const probe = `${who}, ${what}`;
          try {
            const response = await (handler as RouteHandler)(request, {
              params: Promise.resolve(paramsFor(route.path)),
            });
            observations.push({
              route: key(route),
              probe,
              status: response.status,
              text: await response.text(),
            });
          } catch (error) {
            threw.push(`${key(route)} (${probe}): threw ${String(error)}`);
          }
        }
      }
    }
  }, 120_000);

  afterAll(() => {
    harness?.teardown();
  });

  it('answered every probe rather than throwing', () => {
    expect(threw).toEqual([]);
  });

  it('refused at least once on every route, so each one was really probed', () => {
    const refused = new Set(
      observations
        .filter((observation) => observation.status >= 400)
        .map((observation) => observation.route),
    );
    expect(apiRoutes.map(key).filter((route) => !refused.has(route))).toEqual(
      Object.keys(NEVER_REFUSES),
    );
  });

  it('answers every handler refusal in the standard envelope', () => {
    const violations = observations
      .map((observation) => ({ observation, violation: envelopeViolation(observation) }))
      .filter((entry) => entry.violation !== null)
      .map(
        (entry) =>
          `${entry.observation.route} (${entry.observation.probe}): ${entry.violation ?? ''}`,
      );
    expect(violations).toEqual([]);
  });
});
