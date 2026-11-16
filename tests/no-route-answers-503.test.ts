import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRouteProbe,
  PROBE_TIMEOUT_MS,
  GAP_OWNERS,
  GAP_RECORDS,
  SESSION_REFUSED_BY_HANDLER,
  CLOSED_DEFECT_RECORD,
} from './no-route-probe.js';

const { start, stop, answers, routes } = createRouteProbe();
beforeAll(start, PROBE_TIMEOUT_MS);
afterAll(stop, 120_000);
describe('declared routes reach installed handlers', () => {
  it('drove every declared route and got a status for each', () => {
    expect(routes.length).toBeGreaterThan(0);
    const missing = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => !answers.has(key));
    expect(missing, 'a route the declaration union contains was never driven').toEqual([]);
  });

  it('answers 503 on exactly the routes the declared gap accounts for', () => {
    const unavailable = routes
      .filter((route) => answers.get(`${route.method} ${route.path}`) === 503)
      .map((route) => `${route.method} ${route.path} (${route.owner})`)
      .sort();
    const expected = routes
      .filter((route) => GAP_OWNERS.includes(route.owner))
      .map((route) => `${route.method} ${route.path} (${route.owner})`)
      .sort();
    const owners = GAP_OWNERS.map((owner) => `${owner} (${GAP_RECORDS[owner] ?? ''})`).join(', ');
    expect(
      unavailable,
      `The routes answering 503 must be exactly the declared gap owners' — ${owners}. A route of ` +
        `another task here means its runtime is not installed in apps/web/instrumentation.ts — ` +
        `the whole failure ADR-0038 exists to close. Fewer than a declared owner's own routes ` +
        `means that gap was closed and the record and this expectation have to say so.`,
    ).toEqual(expected);
  });

  it('answers no 5xx other than the 503 a named gap accounts for', () => {
    // The property that was false when this file was written and is true now. A 5xx that is not a
    // 503 means a route module threw rather than declining — the class of defect only a running
    // server can witness, because a route handler driven from inside Vitest has the test runner's
    // whole devDependency tree on its resolution path and a deployment does not.
    //
    // `GET /api/auth/login` (issue #118, W9-AUTH-118) is a documented exception on a different
    // axis than the one above: it is fully wired (`SESSION_SECRET` and every `OIDC_*` variable are
    // present, unlike the composition-root gap this file otherwise probes), and it answers 502 —
    // not 503, not a crash — because this probe's `OIDC_ISSUER_URL` points at a port nothing
    // listens on, so `beginOidcLogin`'s real network discovery genuinely cannot reach it. That is
    // the intended behaviour of a reachable, correctly-installed route whose one external
    // dependency did not answer, proved directly (not just tolerated here) in
    // `apps/web/app/api/auth/login/login.test.ts`'s "answers 502, not a crash" case, which breaks
    // if the `try`/`catch` around `beginOidcLogin` is removed.
    const KNOWN_UPSTREAM_FAILURES = new Set(['GET /api/auth/login → 502']);
    const broken = routes
      .filter((route) => {
        const status = answers.get(`${route.method} ${route.path}`) ?? 0;
        return status >= 500 && status !== 503;
      })
      .map(
        (route) =>
          `${route.method} ${route.path} → ${String(answers.get(`${route.method} ${route.path}`))}`,
      )
      .filter((entry) => !KNOWN_UPSTREAM_FAILURES.has(entry))
      .sort();
    expect(
      broken,
      `A declared route threw instead of answering. The last time this list was non-empty it held ` +
        `all five /api/files* routes, because a runtime barrel re-exported a module that imports ` +
        `vitest — ${CLOSED_DEFECT_RECORD}, closed by W2-CP-03 at 6a3ac24. Read the server's own ` +
        `stack before assuming this one is the same.`,
    ).toEqual([]);
  });
});

describe('route probes authenticate at the handler boundary', () => {
  it('is a real probe — every route produced a concrete non-503 handler response', () => {
    const statuses = [...answers.values()];
    expect(statuses.every((status) => status !== 503)).toBe(true);
    expect(statuses.every((status) => status >= 200 && status < 600)).toBe(true);
  });

  it('reached a handler rather than stopping at the middleware', () => {
    // 401 is `middleware.ts` refusing the cookie and 403 `cross_origin` is it refusing the write.
    // Either on every route would mean this probe measured the middleware, not the subsystems.
    const unauthenticated = routes
      .map((route) => `${route.method} ${route.path}`)
      .filter((key) => answers.get(key) === 401)
      .filter((key) => SESSION_REFUSED_BY_HANDLER[key] === undefined);
    expect(
      unauthenticated,
      'the probe’s session cookie was refused, so these requests never reached a handler and ' +
        'their status says nothing about whether a runtime is installed',
    ).toEqual([]);
  });

  it('answers the probe’s session 401 on exactly the routes that act on a presented credential', () => {
    const declared = Object.keys(SESSION_REFUSED_BY_HANDLER).sort();
    expect(
      declared.filter((key) => answers.get(key) !== 401),
      'a route declared as refusing a session in its handler answered something else — remove it ' +
        'from SESSION_REFUSED_BY_HANDLER and say so in its record',
    ).toEqual([]);
  });
});
