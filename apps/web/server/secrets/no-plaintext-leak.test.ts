/**
 * Acceptance criterion 1 (the Wave 2 plan): "a secret value appears in no API response,
 * no log line and no audit row" — asserted by scanning, not by inspection.
 *
 * ## Why this reads `tests/route-declarations/W2-CP-02.ts` instead of hand-listing the routes
 *
 * This file imports the same declaration array `tests/route-inventory.test.ts` unions into the
 * repository-wide surface, drives **every** entry in it generically by `METHOD path`, and fails by
 * name if a route this task ships is not in the dispatch table below — see
 * `assertEveryDeclaredRouteIsCovered`. Adding a fourth route to `tests/route-declarations/W2-CP-02.ts`
 * without adding it here is therefore a red test, not a silently unscanned route.
 *
 * ## What this file cannot see, and the trip-wire it carries instead (verification round 2, F3)
 *
 * The claim above is honest only about **this task's own** routes. It is not "nobody has to
 * remember every route on this resource" — the first version of this file's header said exactly
 * that, and it was false: a *sibling* task can declare and ship a route under `/api/secrets/**`
 * (`tests/route-declarations/<OTHER-TASK-ID>.ts`) that this file's dispatch table has never heard
 * of, and it would pass every gate here, because `declaredSecretsRoutePaths` below — like
 * `route-inventory.test.ts` itself — only reads *declaration files*, and a file this task does not
 * own can declare anything.
 *
 * What this task can honestly do, and does: `assertOnlyThisTaskDeclaresTheSecretsResource` reads
 * **every** tracked `tests/route-declarations/*.ts` file (not only its own), extracts every string
 * that looks like a path under `/api/secrets`, and fails — naming the file — the moment one is
 * declared by anything other than `W2-CP-02.ts`. It cannot drive a route it does not own (there is
 * no static import to call, and dynamically importing a computed path is the construct
 * `packages/core/src/db/repositories/database-reachability.test.ts` and `tests/no-sdk-import.test.ts`
 * both refuse to paper over), so it cannot scan that route's response for a leak the way it scans
 * its own three. What it can do, and what ADR-0031 asks for when a case is genuinely undecidable,
 * is refuse to be silently green about it: the moment a second file declares a path on this
 * resource, this suite goes red and a person has to look, rather than the situation
 * `tests/route-declarations/W2-CP-99.ts` demonstrated — a leaking route on this resource, declared
 * by a task that is not this one, with 54 files and 1085 tests all green.
 *
 * This is a path-string match over declaration files, not a compiler resolution — declaration
 * files are prose-shaped source `route-inventory.test.ts` itself reads as text for the same reason
 * (`tests/inventory-support.ts`'s header: a dynamic import of a computed path is undecidable). A
 * declared path that does not literally contain the substring `/api/secrets` (a typo, an alias, a
 * rewrite rule) would not be found by this scan; that is this scan's own declared limit, on top of
 * the one above.
 *
 * ## What "scans every response body" means concretely, for the routes this task does drive
 *
 * Every route this task declared is exercised at least once with a request whose JSON body carries
 * {@link PLAINTEXT_MARKER} as the secret's value (`POST`) or its replacement value (`PUT`), and
 * every response this exercise produces — success and error alike — has its raw text checked for
 * the marker.
 *
 * ## Why this file no longer says in prose which statuses that covers (verification round 4, B3)
 *
 * Three rounds running, this paragraph was wrong in a new way each time. Round 1's test was
 * *named* for a 404/409/400 case it never drove (F4). Round 2's fix hand-wrote a completeness claim
 * — "every status these routes can answer with (`201`, `400`, `404`, `409`)" — and that claim
 * omitted `200`, `401` and `503` (B3, round 3). Round 3's correction hand-wrote a *second* list —
 * "`401` and `503` are two more" — and that one omitted `403` and `500` (`http.ts`'s
 * `'forbidden'` case and its own `unhandled_workspace_resolution` default). Each fix was a person
 * re-counting a list by eye and getting it wrong again.
 *
 * So there is no list here to get wrong a fourth time. {@link statusLiteralsIn}, applied to
 * `apps/web/server/secrets/handlers.ts` — the one file in this task that ever sees a *parsed*
 * request body, as opposed to raw bytes — collects every HTTP status number that file can produce
 * into {@link HANDLER_STATUSES},
 * the same way {@link declaredSecretsRoutePaths} above derives routes instead of hand-listing them.
 * `assertEveryHandlerStatusIsCovered` asserts the statuses this suite actually drove, across every
 * test in the describe block below, equal that derived set exactly (ADR-0015: the check runs
 * because the derived set is non-empty and the driven set matches it, never because nobody
 * compared). A status `handlers.ts` gains has to be driven here or this suite goes red by name;
 * there is no sentence left that describes the set instead of asserting it.
 *
 * `http.ts` — the workspace-resolution gate and the raw-body reader every route runs through before
 * a `{ name, value }` is ever parsed — has its own statuses, and this file deliberately does not
 * enumerate them: naming them here would be exactly the hand-written list this section exists to
 * stop writing. What matters structurally is *which file* they come from, not which numbers they
 * are: `withWorkspaceStore` and `readJsonBody` both answer before `handlers.ts` is ever reached, so
 * none of `http.ts`'s statuses can carry a caller-supplied value, and none of them are
 * `HANDLER_STATUSES`'s to derive or this file's to drive. Coverage of `http.ts`'s own statuses
 * belongs to `routes.test.ts`, which drives some of them; whether it drives all of them is that
 * file's own claim to keep honest, not a fact repeated here in prose. `GET` is exercised after a
 * `POST` seeded one, so the list response has something to leak if anything were going to leak it.
 *
 * ## The other two halves of the criterion
 *
 *   * **No log line.** `console.log`, `console.warn` and `console.error` are spied on for the
 *     duration of the whole exercise, and every captured argument is scanned for the marker.
 *   * **No audit row.** This subsystem writes to exactly one table (`secrets`) and never to
 *     `audit_events` — there is no code path in `packages/core/src/secrets/**` that touches it.
 *     `no-audit-row.test.ts` in this directory proves that against a real PostgreSQL, gated on
 *     `TEST_DATABASE_URL` like every other database suite in this repository.
 */
import { captureLog } from '../telemetry/capture-log';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as createRoute } from '../../app/api/secrets/route';
import { DELETE as deleteRoute, PUT as replaceRoute } from '../../app/api/secrets/[id]/route';
import { routes as declaredRoutes } from '../../../../tests/route-declarations/W2-CP-02.js';
import { createInMemorySecretsStoreProvider } from './memory-store';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { WorkspaceResolution } from './runtime';
import type {
  CreateSecretOutcome,
  ReplaceSecretOutcome,
  SecretsStoreProvider,
  WorkspaceSecretsStore,
} from './store';
import { installTestDomains } from '../application-context-fixtures';
import { clearApplicationContext } from '../application-context';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const THIS_TASKS_DECLARATION_FILE = 'W2-CP-02.ts';

/**
 * Every string shaped like a `/api/secrets` path, found across **every** tracked
 * `tests/route-declarations/*.ts` file, with which file it was found in. A text scan over
 * declaration files, matching `route-inventory.test.ts`'s own reason for reading them as text
 * rather than importing them dynamically (see this file's header).
 */
function declaredSecretsRoutePaths(): { readonly file: string; readonly match: string }[] {
  const stdout = execFileSync('git', ['ls-files', '-z', '--', 'tests/route-declarations'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = stdout
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => line.split(path.sep).join('/'));
  expect(files.length).toBeGreaterThan(0);

  const pattern = /\/api\/secrets(?:\/[A-Za-z0-9:_-]*)*/g;
  const found: { file: string; match: string }[] = [];
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const match of text.matchAll(pattern)) {
      found.push({ file, match: match[0] });
    }
  }
  return found;
}

/**
 * The trip-wire this file's header describes: fails, naming the offending file, the moment any
 * declaration file other than this task's own mentions a path on the `secrets` resource.
 */
function assertOnlyThisTaskDeclaresTheSecretsResource(): void {
  const foreign = declaredSecretsRoutePaths().filter(
    (entry) => !entry.file.endsWith(`/${THIS_TASKS_DECLARATION_FILE}`),
  );
  expect(
    foreign,
    'a route on the secrets resource is declared by a file this task does not own — see this ' +
      "file's header for why that route cannot be driven here and must be looked at by hand: " +
      JSON.stringify(foreign),
  ).toEqual([]);
}

// ── The derived status set (verification round 4, B3) ──────────────────────────────────────────

/**
 * Every HTTP status number `file` can produce, read out of its source rather than hand-counted:
 * the first argument to every call to an identifier named `problem` (`handlers.ts`'s own
 * `ApiResult` builder), and the value of every `status:` property in an object literal. This is
 * the same shape as `declaredSecretsRoutePaths` above — derive the set from the tracked source,
 * so there is no separately-maintained list of numbers to drift out of sync with it (ADR-0016).
 */
function statusLiteralsIn(file: string): ReadonlySet<number> {
  const absolute = path.join(REPO_ROOT, file);
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(
    absolute,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const statuses = new Set<number>();
  const addIfNumeric = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isNumericLiteral(node)) statuses.add(Number(node.text));
  };
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'problem'
    ) {
      addIfNumeric(node.arguments[0]);
    } else if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'status'
    ) {
      addIfNumeric(node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  if (statuses.size === 0) {
    throw new Error(
      `derived no HTTP status literal from ${file}; this gate has nothing to assert coverage ` +
        'against, which is indistinguishable from every status being covered (ADR-0015).',
    );
  }
  return statuses;
}

/**
 * The complete set of statuses `apps/web/server/secrets/handlers.ts` can answer with — the only
 * file in this task that ever sees a *parsed* `{ name, value }` body, as opposed to raw bytes, and
 * therefore the only file whose statuses this suite is responsible for driving. See this file's
 * header for why `http.ts`'s own statuses are a different, out-of-scope set rather than numbers
 * that belong in this list.
 */
const HANDLER_STATUSES = statusLiteralsIn('apps/web/server/secrets/handlers.ts');

/** Every status this suite has driven, across every test — reset by nothing, unlike `responses`,
 * so the final coverage assertion sees the union of the whole file's exercise, not one test's. */
const allStatusesDriven = new Set<number>();

/**
 * Positive assertion (ADR-0015, and the fix for B3): the derived {@link HANDLER_STATUSES} equals
 * what this suite actually drove, element for element. A status `handlers.ts` gains has to be
 * driven by some test below or this fails by name; there is no prose list to under-count again.
 */
function assertEveryHandlerStatusIsCovered(): void {
  expect([...allStatusesDriven].sort((a, b) => a - b)).toEqual(
    [...HANDLER_STATUSES].sort((a, b) => a - b),
  );
}

const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_HEADER = 'x-test-workspace';

/** A value distinctive enough that it could not appear in this file's code by accident. */
const PLAINTEXT_MARKER = 'sk-ant-ACCEPTANCE-CRITERION-1-MARKER-do-not-leak-8f2c19';
const ROTATED_MARKER = 'sk-ant-ACCEPTANCE-CRITERION-1-ROTATED-MARKER-9a3d27';

function useMemoryRuntime(): void {
  const secrets = createInMemorySecretsStoreProvider();
  installTestDomains({
    secrets: {
      kind: 'serving',
      runtime: {
        secrets,
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
  useOwnerRbac();
}

/**
 * Every secrets route is gated by the shared decision table (`DELETE` since #240, the rest since
 * #388), and secrets are Owner-only; an Owner key reaches all of them.
 */
function useOwnerRbac(): void {
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory(),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                workspaceId,
                role: 'owner',
                label: 'Secrets leak scan',
              }),
        );
      },
    },
  });
}

function request(method: string, url: string, body?: string): Request {
  const headers = new Headers({ [WORKSPACE_HEADER]: WORKSPACE });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function idContext(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** Every response this exercise produced, kept for the scan at the end. */
const responses: { readonly route: string; readonly status: number; readonly text: string }[] = [];

async function record(route: string, response: Response): Promise<Response> {
  responses.push({ route, status: response.status, text: await response.clone().text() });
  allStatusesDriven.add(response.status);
  return response;
}

/**
 * Drive one declared route generically. `id` is filled in for `:id` segments; `body` is the JSON
 * body to send, when the route accepts one.
 */
async function drive(
  entry: { readonly method: string; readonly path: string },
  options: { readonly id?: string; readonly body?: string } = {},
): Promise<Response> {
  const label = `${entry.method} ${entry.path}`;
  if (entry.method === 'POST' && entry.path === '/api/secrets') {
    return record(label, await createRoute(request('POST', '/api/secrets', options.body)));
  }
  if (entry.method === 'GET' && entry.path === '/api/secrets') {
    return record(label, await listRoute(request('GET', '/api/secrets')));
  }
  if (entry.method === 'PUT' && entry.path === '/api/secrets/:id') {
    if (options.id === undefined) throw new Error(`${label} needs an id to substitute for :id`);
    return record(
      label,
      await replaceRoute(
        request('PUT', `/api/secrets/${options.id}`, options.body),
        idContext(options.id),
      ),
    );
  }
  if (entry.method === 'DELETE' && entry.path === '/api/secrets/:id') {
    if (options.id === undefined) throw new Error(`${label} needs an id to substitute for :id`);
    return record(
      label,
      await deleteRoute(request('DELETE', `/api/secrets/${options.id}`), idContext(options.id)),
    );
  }
  throw new Error(
    `${label} is declared in tests/route-declarations/W2-CP-02.ts but this test's dispatch table ` +
      `does not know how to drive it. A route this task ships must be added here, not skipped.`,
  );
}

/**
 * Positive assertion (ADR-0015): every entry this task declared was actually driven above. A
 * route added to the declaration file without a matching dispatch arm in `drive` would otherwise
 * leave this suite silently not scanning it.
 */
function assertEveryDeclaredRouteIsCovered(driven: readonly string[]): void {
  const expected = declaredRoutes.map((entry) => `${entry.method} ${entry.path}`).sort();
  // "Covered" means "driven at least once," not "driven exactly once" — a route may legitimately
  // be exercised more than once in one test (this suite calls GET twice, to scan a response that
  // could contain either value). Deduplicated before comparing.
  expect([...new Set(driven)].sort()).toEqual(expected);
}

describe('acceptance criterion 1 — the trip-wire for what this task cannot scan itself', () => {
  it('is the only task that declares a route on the secrets resource', () => {
    assertOnlyThisTaskDeclaresTheSecretsResource();
  });
});

describe('acceptance criterion 1 — no secret value in any API response or log line', () => {
  let capture: ReturnType<typeof captureLog>;

  beforeEach(() => {
    responses.length = 0;
    capture = captureLog();
  });

  afterEach(() => {
    capture.restore();
    clearApplicationContext();
  });

  it("scans every declared route's response, and every log line, for the plaintext", async () => {
    useMemoryRuntime();

    const created = await drive(
      { method: 'POST', path: '/api/secrets' },
      { body: JSON.stringify({ name: 'ACCEPTANCE_TEST_SECRET', value: PLAINTEXT_MARKER }) },
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const secret = (await created.clone().json()) as { id: string };

    await drive({ method: 'GET', path: '/api/secrets' });

    const replaced = await drive(
      { method: 'PUT', path: '/api/secrets/:id' },
      { id: secret.id, body: JSON.stringify({ value: ROTATED_MARKER }) },
    );
    expect(replaced.status, await replaced.clone().text()).toBe(200);

    // A second GET, so the response scanned for "no leak" is one that could contain the ROTATED
    // value too, not only the original.
    await drive({ method: 'GET', path: '/api/secrets' });

    const deleted = await drive({ method: 'DELETE', path: '/api/secrets/:id' }, { id: secret.id });
    expect(deleted.status, await deleted.clone().text()).toBe(204);

    assertEveryDeclaredRouteIsCovered(responses.map((r) => r.route));
    expect(responses.length).toBeGreaterThanOrEqual(declaredRoutes.length);

    for (const response of responses) {
      expect(response.text, `${response.route} (status ${String(response.status)})`).not.toContain(
        PLAINTEXT_MARKER,
      );
      expect(response.text, `${response.route} (status ${String(response.status)})`).not.toContain(
        ROTATED_MARKER,
      );
    }

    const logged = capture.text();
    expect(logged).not.toContain(PLAINTEXT_MARKER);
    expect(logged).not.toContain(ROTATED_MARKER);
  });

  it('also does not leak the value through a 404, a 409 or a 400 for these routes', async () => {
    useMemoryRuntime();

    const created = await drive(
      { method: 'POST', path: '/api/secrets' },
      { body: JSON.stringify({ name: 'DUP_NAME_TEST', value: PLAINTEXT_MARKER }) },
    );
    expect(created.status).toBe(201);

    // 409: same name again.
    const conflict = await drive(
      { method: 'POST', path: '/api/secrets' },
      { body: JSON.stringify({ name: 'DUP_NAME_TEST', value: PLAINTEXT_MARKER }) },
    );
    expect(conflict.status).toBe(409);

    // 404: replacing an id that does not exist, still carrying the marker in the body.
    const notFound = await drive(
      { method: 'PUT', path: '/api/secrets/:id' },
      {
        id: '99999999-9999-4999-8999-999999999999',
        body: JSON.stringify({ value: PLAINTEXT_MARKER }),
      },
    );
    expect(notFound.status).toBe(404);

    // 400: a body that fails validation (an invalid name shape) while still carrying the marker
    // in the field validation does not reject — verification round 2's F4 found that no test in
    // this file actually drove a 400 despite this test's own name and the PR body both claiming
    // one was covered.
    const invalid = await drive(
      { method: 'POST', path: '/api/secrets' },
      { body: JSON.stringify({ name: 'not-a-valid-name', value: PLAINTEXT_MARKER }) },
    );
    expect(invalid.status).toBe(400);

    const driven = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(driven, 'the statuses this test actually drove').toEqual([201, 400, 404, 409]);

    for (const response of responses) {
      expect(response.text).not.toContain(PLAINTEXT_MARKER);
    }
  });

  /**
   * `handlers.ts`'s `default:` arm — reached only when a store returns an outcome `kind` neither
   * `createSecret` nor `replaceSecret`'s exhaustive `switch` recognises, which no real
   * implementation of {@link WorkspaceSecretsStore} can produce, only a broken one. Driven anyway,
   * because {@link statusLiteralsIn} derives its `500` from this exact arm and {@link
   * assertEveryHandlerStatusIsCovered} requires every derived status to be driven by something —
   * see this file's header on why that set is derived rather than hand-typed. The bogus outcome
   * carries no `value` field at all, so this is not a claim that a broken store *cannot* leak
   * (nothing can stop that), only that the fallback branch itself does not manufacture a leak out
   * of a request whose real, legitimate outcome it never sees.
   */
  it('also does not leak the value through the outcome kind the store double is never given', async () => {
    const malformed: SecretsStoreProvider = {
      forWorkspace: (): WorkspaceSecretsStore => ({
        list: () => Promise.resolve([]),
        create: () =>
          Promise.resolve({ kind: 'not-a-real-outcome' } as unknown as CreateSecretOutcome),
        replace: () =>
          Promise.resolve({ kind: 'not-a-real-outcome' } as unknown as ReplaceSecretOutcome),
        remove: () => Promise.resolve({ kind: 'not-found' }),
      }),
    };
    installTestDomains({
      secrets: {
        kind: 'serving',
        runtime: {
          secrets: malformed,
          resolveWorkspace(req: Request): Promise<WorkspaceResolution> {
            const workspaceId = req.headers.get(WORKSPACE_HEADER);
            if (workspaceId === null) {
              return Promise.resolve({
                kind: 'unauthenticated',
                reason: 'no test workspace header',
              });
            }
            return Promise.resolve({ kind: 'workspace', workspaceId });
          },
        },
      },
    });
    useOwnerRbac();

    const response = await drive(
      { method: 'POST', path: '/api/secrets' },
      { body: JSON.stringify({ name: 'DEFENSIVE_FALLBACK_TEST', value: PLAINTEXT_MARKER }) },
    );
    expect(response.status).toBe(500);
    expect(await response.clone().text()).not.toContain(PLAINTEXT_MARKER);
  });

  // Runs once, after every test in this block regardless of their relative order — unlike a
  // trailing `it()`, `afterAll` does not depend on definition order being execution order. See
  // this file's header (verification round 4, B3) for why the set it checks against is derived
  // rather than hand-typed.
  afterAll(() => {
    assertEveryHandlerStatusIsCovered();
  });
});
