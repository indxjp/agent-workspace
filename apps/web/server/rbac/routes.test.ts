/**
 * The wiring: that this task's route files actually call `authorise`, and that what they answer is
 * what `decide` said.
 *
 * R-12 §2.2 names the trap this file exists for: *"a matrix asserted against `decide()` proves the
 * table, not the wiring. A handler that never calls `requirePermission` passes such a test with
 * every cell green."* `authorisation-matrix.test.ts` proves the table over every declared route in
 * the repository; this file proves the wiring over the routes this task owns, by driving the real
 * route modules with real `Request` objects and comparing the status against the prediction.
 *
 * The prediction is computed, not written down. For each route and role, `decide` is asked for
 * **every** ownership answer; if it denies for all of them the response must be `403`, if it allows
 * for all of them the response must not be `403`, and if it is mixed this test says it cannot
 * predict and **fails** rather than guessing — which is the ADR-0031 shape and which is also a
 * standing invitation to split this file if a route of this task ever becomes ownership-dependent.
 *
 * The set of routes exercised is checked against `tests/route-declarations/W2-CP-06.ts`: a route
 * this task declares but does not drive here fails, so the wiring proof cannot go quietly short.
 *
 * ## The `allow` branch asserts two positive facts, not two absences
 *
 * Round 1 asserted the allowed case as `not.toBe(403)` and `not.toContain(...)`. A handler that
 * never called `authorise` and answered `200` satisfies both, so half of this file proved nothing
 * (the `deny` branch's `toBe(403)` was carrying it alone). What is asserted now:
 *
 *   1. `authorise` scoped a directory to the caller's workspace for this request — it is the only
 *      caller of `forWorkspace` in the program and it calls it only on the `allow` branch, so
 *      `harness.scopedWorkspaces` is a positive record that the gate ran and allowed. A handler
 *      that skipped the gate records nothing;
 *   2. the status is **equal** to the one the pure handler in `handlers.ts` returns for the same
 *      fixture — computed here by calling it against an identically seeded directory rather than
 *      written down (ADR-0016), so `500 authorisation_undecidable` and a stray `403` both fail by
 *      inequality rather than by a list of things that must not happen.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DELETE as REVOKE_API_KEY } from '../../app/api/api-keys/[id]/route';
import { GET as LIST_API_KEYS, POST as CREATE_API_KEY } from '../../app/api/api-keys/route';
import {
  DELETE as DELETE_MEMBERSHIP,
  PATCH as PATCH_MEMBERSHIP,
} from '../../app/api/memberships/[id]/route';
import {
  GET as LIST_MEMBERSHIPS,
  POST as CREATE_MEMBERSHIP,
} from '../../app/api/memberships/route';
import { GET as LIST_USERS, POST as CREATE_USER } from '../../app/api/users/route';
import { MembershipListResponseSchema } from '../../contracts/team';

import {
  readDeclarationFiles,
  requireString,
  REPO_ROOT,
} from '../../../../tests/inventory-support';

import { decide, OWNERSHIPS } from './decide';
import type { WorkspaceDirectory } from './directory';
import {
  changeMembershipRole,
  createApiKey,
  createMembership,
  createUser,
  deleteMembership,
  listApiKeys,
  listMemberships,
  listUsers,
  revokeApiKey,
} from './handlers';
import type { ApiResult } from '../http/result';
import { createMemoryDirectory } from './memory-directory';
import { ROLES, type Role } from './roles';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';
import { clearApplicationContext } from '../application-context';

type Handler = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** One route of this task, and the module-level function Next.js would call for it. */
interface WiredRoute {
  readonly method: string;
  /** The specification-notation path, as the declaration file writes it. */
  readonly declared: string;
  /** A concrete path, as a request would carry it. */
  readonly concrete: string;
  readonly handler: Handler;
  readonly body?: unknown;
  /**
   * The same work the route file asks of `handlers.ts`, with the same arguments the route passes
   * — including the caller's own role, which is what the conferral check in `conferral.ts`
   * measures a role in the body against. Driving it against an identically seeded directory gives
   * this file a status to compare against instead of a list of statuses to forbid.
   */
  readonly direct: (directory: WorkspaceDirectory, callerRole: Role) => Promise<ApiResult>;
}

const SAMPLE_ID = 'membership-or-key-id';

const CREATE_USER_BODY = { email: 'new@example.test', name: 'New Person', role: 'viewer' };
const CREATE_MEMBERSHIP_BODY = { email: 'someone@example.test', role: 'builder' };
const PATCH_MEMBERSHIP_BODY = { role: 'admin' };
const CREATE_API_KEY_BODY = { name: 'A key', role: 'viewer', expiresAt: null };

const WIRED: readonly WiredRoute[] = [
  {
    method: 'GET',
    declared: '/api/users',
    concrete: '/api/users',
    handler: LIST_USERS,
    direct: (directory) => listUsers(directory),
  },
  {
    method: 'POST',
    declared: '/api/users',
    concrete: '/api/users',
    handler: CREATE_USER,
    body: CREATE_USER_BODY,
    direct: (directory, callerRole) => createUser(directory, callerRole, CREATE_USER_BODY),
  },
  {
    method: 'GET',
    declared: '/api/memberships',
    concrete: '/api/memberships',
    handler: LIST_MEMBERSHIPS,
    direct: (directory) => listMemberships(directory),
  },
  {
    method: 'POST',
    declared: '/api/memberships',
    concrete: '/api/memberships',
    handler: CREATE_MEMBERSHIP,
    body: CREATE_MEMBERSHIP_BODY,
    direct: (directory, callerRole) =>
      createMembership(directory, callerRole, CREATE_MEMBERSHIP_BODY),
  },
  {
    method: 'PATCH',
    declared: '/api/memberships/:id',
    concrete: `/api/memberships/${SAMPLE_ID}`,
    handler: PATCH_MEMBERSHIP,
    body: PATCH_MEMBERSHIP_BODY,
    direct: (directory, callerRole) =>
      changeMembershipRole(directory, callerRole, SAMPLE_ID, PATCH_MEMBERSHIP_BODY),
  },
  {
    method: 'DELETE',
    declared: '/api/memberships/:id',
    concrete: `/api/memberships/${SAMPLE_ID}`,
    handler: DELETE_MEMBERSHIP,
    direct: (directory, callerRole) => deleteMembership(directory, callerRole, SAMPLE_ID),
  },
  {
    method: 'GET',
    declared: '/api/api-keys',
    concrete: '/api/api-keys',
    handler: LIST_API_KEYS,
    direct: (directory) => listApiKeys(directory),
  },
  {
    method: 'POST',
    declared: '/api/api-keys',
    concrete: '/api/api-keys',
    handler: CREATE_API_KEY,
    body: CREATE_API_KEY_BODY,
    direct: (directory, callerRole) => createApiKey(directory, callerRole, CREATE_API_KEY_BODY),
  },
  {
    method: 'DELETE',
    declared: '/api/api-keys/:id',
    concrete: `/api/api-keys/${SAMPLE_ID}`,
    handler: REVOKE_API_KEY,
    direct: (directory) => revokeApiKey(directory, SAMPLE_ID),
  },
];

function key(route: { method: string; declared?: string; path?: string }): string {
  return `${route.method} ${route.declared ?? route.path ?? ''}`;
}

/** What §21 says about this route and role, once, for every ownership answer a handler can give. */
function prediction(route: WiredRoute, role: Role): 'allow' | 'deny' | 'unpredictable' {
  const effects = new Set(
    OWNERSHIPS.map(
      (ownership) =>
        decide({ role, method: route.method, path: route.concrete, ownership, scope: null }).effect,
    ),
  );
  if (effects.size === 1 && effects.has('allow')) return 'allow';
  if (effects.size === 1 && effects.has('deny')) return 'deny';
  return 'unpredictable';
}

/** A member of every role, so a caller of each can be signed in. */
const MEMBERS = ROLES.map((role) => ({
  email: `${role}@example.test`,
  name: `The ${role}`,
  workspaceId: TEST_WORKSPACE_ID,
  role,
}));

describe('every route this task declares is exercised here', () => {
  it('enumerates every membership route across all four roles', () => {
    const membershipRoutes = WIRED.filter((route) => route.declared.includes('/memberships'));
    expect(membershipRoutes).toHaveLength(4);
    expect(membershipRoutes.length * ROLES.length).toBe(16);
  });

  it('drives exactly the routes tests/route-declarations/W2-CP-06.ts declares', () => {
    const file = readDeclarationFiles('tests/route-declarations', 'routes').find(
      (candidate) => candidate.owner === 'W2-CP-06',
    );
    expect(file, 'this task declares no routes, so this whole file proves nothing').toBeDefined();
    if (file === undefined) throw new Error('unreachable');
    const declared = file.entries
      .map((entry, index) => {
        const where = `${file.repoPath} entry ${String(index)}`;
        return `${requireString(entry, 'method', where)} ${requireString(entry, 'path', where)}`;
      })
      .sort();
    expect(
      WIRED.map(key).sort(),
      'the routes driven by this file and the routes this task declares must be the same set: a ' +
        'declared route missing from here is a route whose wiring nothing proves.',
    ).toEqual(declared);
  });
});

describe('each route answers what §21 said, and the answer came from the gate', () => {
  for (const route of WIRED) {
    for (const role of ROLES) {
      it(`${key(route)} · ${role}`, async () => {
        const harness: RbacHarness = installRbacHarness(MEMBERS);
        try {
          const response = await harness.call(route.handler, {
            method: route.method,
            path: route.concrete,
            as: { email: `${role}@example.test` },
            id: SAMPLE_ID,
            ...(route.body === undefined ? {} : { body: route.body }),
          });
          const expected = prediction(route, role);
          switch (expected) {
            case 'deny':
              expect(response.status, response.text).toBe(403);
              // The body says which sentence of §21 refused it, rather than the bare word.
              expect(response.text).toContain('§21');
              break;
            case 'allow': {
              // Positive fact 1: the gate ran, allowed, and scoped a directory to this caller's
              // workspace. `authorise` is the only caller of `forWorkspace` and it calls it only
              // on the allow branch, so a handler that skipped the gate records nothing here.
              expect(
                harness.scopedWorkspaces,
                'the route answered without authorise ever scoping a directory to the caller’s ' +
                  'workspace, so nothing proves the gate ran',
              ).toEqual([TEST_WORKSPACE_ID]);
              // Positive fact 2: the status is the one `handlers.ts` produces for this fixture —
              // computed, not written down. Several of these routes legitimately answer 404, 409
              // or (since the conferral check) 403 for the fixture they are handed; what the
              // route may not do is answer something its own handler would not.
              const fresh = createMemoryDirectory({ users: MEMBERS }).forWorkspace(
                TEST_WORKSPACE_ID,
              );
              const expectedResult = await route.direct(fresh, role);
              expect(response.status, response.text).toBe(expectedResult.status);
              break;
            }
            case 'unpredictable':
              throw new Error(
                `§21's split gives ${key(route)} different answers for different ownership ` +
                  `answers, so this file cannot predict a status for role ${role}. Split the ` +
                  `assertion rather than guessing which ownership the handler passes.`,
              );
            default: {
              const unreachable: never = expected;
              throw new Error(`unhandled prediction ${JSON.stringify(unreachable)}`);
            }
          }
        } finally {
          harness.teardown();
        }
      });
    }
  }
});

describe('a result with nothing to say reaches the caller as a real 204', () => {
  it('answers DELETE /api/memberships/:id with 204, an empty body and no content-type', async () => {
    // `newId` is supplied — as `invitations/routes.test.ts` already does — because this test
    // removes a membership by the id the fixture minted, and issue #203 made the handler refuse an
    // id that is not shaped like the `uuid` column `memberships.id` is. The fixture's default
    // counter (`id-8`) is not one, so a seeded id standing in for a real one has to be.
    const harness: RbacHarness = installRbacHarness(MEMBERS, { newId: crypto.randomUUID });
    try {
      const listed = await harness.call(LIST_MEMBERSHIPS, {
        method: 'GET',
        path: '/api/memberships',
        as: { email: 'owner@example.test' },
      });
      expect(listed.status, listed.text).toBe(200);
      const removable = MembershipListResponseSchema.parse(listed.body).memberships.find(
        (member) => member.role === 'viewer',
      );
      expect(
        removable,
        'the fixture needs a member the last-Owner rule does not protect, or this proves nothing',
      ).toBeDefined();
      if (removable === undefined) throw new Error('unreachable');

      const response = await harness.call(DELETE_MEMBERSHIP, {
        method: 'DELETE',
        path: `/api/memberships/${removable.id}`,
        as: { email: 'owner@example.test' },
        id: removable.id,
      });

      // `deleteMembership` answers `{ status: 204, body: null }`. `JSON.stringify(null)` is the
      // string `"null"`, and the `Response` constructor rejects any body on a 204 — so serialising
      // the empty arm threw inside the route and every successful removal answered 500 instead.
      expect(response.status, response.text).toBe(204);
      expect(response.text).toBe('');
      expect(
        response.headers.get('content-type'),
        'a 204 carries no body, so nothing may describe one',
      ).toBeNull();
      // The empty arm is as caller-specific as a body: it says this membership is now gone.
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      harness.teardown();
    }
  });
});

/**
 * Issue #203: a `:id` that is not a UUID must be answered exactly as a UUID naming no row of this
 * workspace is answered, rather than reaching a `uuid` column — `memberships.id`, `api_keys.id` —
 * as an invalid literal.
 *
 * **This describe is a contract pin, not the regression.** `installRbacHarness` is backed by
 * `createMemoryDirectory`, whose membership and key lookups are `Map.get` over a string key
 * (`memory-directory.ts`): it answers `no-such-membership` / `no-such-key` for `'not-a-uuid'`
 * whether or not the guard exists, so it cannot raise `22P02` and a case here cannot fail for the
 * old behaviour. What it does prove is the contract through the real route modules — that the two
 * answers are equal field by field, and that the guard did not move *above* the checks that run
 * before the row read. The describe below it is the database-free regression that fails when a
 * guard is *deleted*; `memberships-isuuid-guard.test.ts` is the one that proves it against the
 * real driver.
 */
describe('a malformed :id is answered as an absent one, through the real routes', () => {
  /** A well-formed UUID that names no row of the test workspace: the control. */
  const ABSENT_UUID = '3f1c0b4e-9a2d-4c77-8b61-0e5d2a7c4f90';
  const NOT_A_UUID = 'not-a-uuid';

  /**
   * Drive one `:id` verb and return the three things "identical response" means here. The id is
   * substituted out of the body text because the detail legitimately echoes the id the caller sent
   * — see `membershipNotFound` / `apiKeyNotFound` in `handlers.ts` — so it is the one substring the
   * two answers may differ in, and substituting it is what makes the rest checkable.
   */
  async function answerFor(
    harness: RbacHarness,
    route: { readonly method: string; readonly collection: string; readonly handler: Handler },
    options: { readonly id: string; readonly as: string; readonly body?: unknown },
  ): Promise<{ status: number; body: string; cacheControl: string | null }> {
    const response = await harness.call(route.handler, {
      method: route.method,
      path: `${route.collection}/${options.id}`,
      as: { email: options.as },
      id: options.id,
      ...(options.body === undefined ? {} : { body: options.body }),
    });
    return {
      status: response.status,
      body: response.text.replaceAll(options.id, '<id>'),
      cacheControl: response.headers.get('cache-control'),
    };
  }

  const MEMBERSHIPS = '/api/memberships';
  const PATCH_ROUTE = {
    method: 'PATCH',
    collection: MEMBERSHIPS,
    handler: PATCH_MEMBERSHIP,
  } as const;
  const DELETE_ROUTE = {
    method: 'DELETE',
    collection: MEMBERSHIPS,
    handler: DELETE_MEMBERSHIP,
  } as const;
  const REVOKE_KEY_ROUTE = {
    method: 'DELETE',
    collection: '/api/api-keys',
    handler: REVOKE_API_KEY,
  } as const;

  it('PATCH answers a non-UUID id with the 404 an absent UUID gets', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      const options = { as: 'owner@example.test', body: PATCH_MEMBERSHIP_BODY };
      const absent = await answerFor(harness, PATCH_ROUTE, { ...options, id: ABSENT_UUID });
      const malformed = await answerFor(harness, PATCH_ROUTE, { ...options, id: NOT_A_UUID });
      // Asserted positively first: two responses that agreed on 500 would satisfy equality alone.
      expect(absent.status, absent.body).toBe(404);
      expect(absent.body).toContain('no_such_membership');
      expect(malformed).toEqual(absent);
    } finally {
      harness.teardown();
    }
  });

  it('DELETE answers a non-UUID id with the 404 an absent UUID gets', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      const options = { as: 'owner@example.test' };
      const absent = await answerFor(harness, DELETE_ROUTE, { ...options, id: ABSENT_UUID });
      const malformed = await answerFor(harness, DELETE_ROUTE, { ...options, id: NOT_A_UUID });
      expect(absent.status, absent.body).toBe(404);
      expect(absent.body).toContain('no_such_membership');
      expect(malformed).toEqual(absent);
    } finally {
      harness.teardown();
    }
  });

  it('DELETE /api/api-keys/:id answers a non-UUID id with the 404 an absent UUID gets', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      const options = { as: 'owner@example.test' };
      const absent = await answerFor(harness, REVOKE_KEY_ROUTE, { ...options, id: ABSENT_UUID });
      const malformed = await answerFor(harness, REVOKE_KEY_ROUTE, { ...options, id: NOT_A_UUID });
      expect(absent.status, absent.body).toBe(404);
      expect(absent.body).toContain('no_such_api_key');
      expect(malformed).toEqual(absent);
    } finally {
      harness.teardown();
    }
  });

  // The two cases that hold the guard's POSITION. `changeMembershipRole` validates the body and the
  // role conferral before it reads the row, so an absent UUID with a bad body answers 400 and an
  // absent UUID with an unconferrable role answers 403. A guard at the top of the handler would
  // answer 404 to both — failing the very "identical response" criterion it was added for. Move it
  // there and these two fail; the two above stay green.
  it('PATCH does not let the guard pre-empt the body check', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      // An array is valid JSON and not an object, which is what `asObject` refuses.
      const options = { as: 'owner@example.test', body: [PATCH_MEMBERSHIP_BODY] };
      const absent = await answerFor(harness, PATCH_ROUTE, { ...options, id: ABSENT_UUID });
      const malformed = await answerFor(harness, PATCH_ROUTE, { ...options, id: NOT_A_UUID });
      expect(absent.status, absent.body).toBe(400);
      expect(absent.body).toContain('malformed_body');
      expect(malformed).toEqual(absent);
    } finally {
      harness.teardown();
    }
  });

  it('PATCH does not let the guard pre-empt the role conferral check', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      // An Admin may PATCH this route, and may not confer `owner` — `conferral.ts`'s own rule.
      const options = { as: 'admin@example.test', body: { role: 'owner' } };
      const absent = await answerFor(harness, PATCH_ROUTE, { ...options, id: ABSENT_UUID });
      const malformed = await answerFor(harness, PATCH_ROUTE, { ...options, id: NOT_A_UUID });
      expect(absent.status, absent.body).toBe(403);
      expect(absent.body).toContain('forbidden_role_conferral');
      expect(malformed).toEqual(absent);
    } finally {
      harness.teardown();
    }
  });
});

/**
 * The same issue #203 guard, proved without a database — cases in this file that fail when a guard
 * is **deleted** rather than only when it moves.
 *
 * The describe above cannot do that: its fixture answers `no-such-membership` / `no-such-key` for
 * `'not-a-uuid'` with the guard and without it. The one fact `createMemoryDirectory` does not model
 * is that `memberships.id` and `api_keys.id` are `uuid` columns, so a non-UUID literal reaching one
 * is a driver rejection and not a missing row. The double here models that fact and nothing else,
 * and drives the three handlers directly: remove any one of the three
 * `if (!isUuid(id)) return …NotFound(id);` lines and a case below fails by an unhandled rejection,
 * in `test:unit`, with no `TEST_DATABASE_URL` set.
 *
 * `memberships-isuuid-guard.test.ts` stays the proof against the real driver over real PostgreSQL.
 * This only closes the gap where a guard could be deleted and every local run stay green.
 */
describe('a malformed :id never reaches the uuid column, with no database', () => {
  const ABSENT_UUID = '3f1c0b4e-9a2d-4c77-8b61-0e5d2a7c4f90';
  const NOT_A_UUID = 'not-a-uuid';
  /** The shape those columns accept. A literal outside it is `22P02`, never zero rows. */
  const UUID_COLUMN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

  /**
   * `createMemoryDirectory` scoped to the test workspace, with the `uuid` column's contract put
   * back on the three methods the `:id` handlers read by: reject a non-UUID id the way the driver
   * does, and otherwise answer exactly as the fixture already does.
   */
  function uuidColumnDirectory(): WorkspaceDirectory {
    // `newId` is supplied for the same reason the 204 case above supplies it: the fixture's default
    // counter (`id-4`) is not a UUID, so without it this double would refuse the rows it seeded and
    // the cases below would pass for the wrong reason.
    const base = createMemoryDirectory({
      users: MEMBERS,
      newId: crypto.randomUUID,
    }).forWorkspace(TEST_WORKSPACE_ID);
    const rejectNonUuid = (id: string): void => {
      if (!UUID_COLUMN.test(id)) throw new Error(`invalid input syntax for type uuid: "${id}"`);
    };
    return {
      ...base,
      changeMembershipRole: async (id, role) => {
        rejectNonUuid(id);
        return base.changeMembershipRole(id, role);
      },
      deleteMembership: async (id) => {
        rejectNonUuid(id);
        return base.deleteMembership(id);
      },
      revokeApiKey: async (id) => {
        rejectNonUuid(id);
        return base.revokeApiKey(id);
      },
    };
  }

  /** The id is substituted out because the not-found detail legitimately echoes it. */
  function withoutId(result: ApiResult, id: string): { status: number; body: string } {
    return { status: result.status, body: JSON.stringify(result.body).replaceAll(id, '<id>') };
  }

  it('PATCH answers a non-UUID id without ever calling the directory', async () => {
    const directory = uuidColumnDirectory();
    const body = PATCH_MEMBERSHIP_BODY;
    const absent = await changeMembershipRole(directory, 'owner', ABSENT_UUID, body);
    // Positively first: two responses agreeing on 500 would satisfy equality on their own.
    expect(absent.status, JSON.stringify(absent.body)).toBe(404);
    expect(JSON.stringify(absent.body)).toContain('no_such_membership');

    const malformed = await changeMembershipRole(directory, 'owner', NOT_A_UUID, body);
    expect(withoutId(malformed, NOT_A_UUID)).toEqual(withoutId(absent, ABSENT_UUID));
  });

  it('DELETE answers a non-UUID id without ever calling the directory', async () => {
    const directory = uuidColumnDirectory();
    const absent = await deleteMembership(directory, 'owner', ABSENT_UUID);
    expect(absent.status, JSON.stringify(absent.body)).toBe(404);
    expect(JSON.stringify(absent.body)).toContain('no_such_membership');

    const malformed = await deleteMembership(directory, 'owner', NOT_A_UUID);
    expect(withoutId(malformed, NOT_A_UUID)).toEqual(withoutId(absent, ABSENT_UUID));
  });

  it('DELETE /api/api-keys/:id answers a non-UUID id without calling the directory', async () => {
    const directory = uuidColumnDirectory();
    const absent = await revokeApiKey(directory, ABSENT_UUID);
    expect(absent.status, JSON.stringify(absent.body)).toBe(404);
    expect(JSON.stringify(absent.body)).toContain('no_such_api_key');

    const malformed = await revokeApiKey(directory, NOT_A_UUID);
    expect(withoutId(malformed, NOT_A_UUID)).toEqual(withoutId(absent, ABSENT_UUID));
  });

  it('sanity: a seeded api key id still reaches the fixture through the double', async () => {
    const directory = uuidColumnDirectory();
    const created = await createApiKey(directory, 'owner', CREATE_API_KEY_BODY);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const seeded = (await directory.listApiKeys())[0];
    expect(seeded, 'the fixture needs a key to revoke, or this proves nothing').toBeDefined();
    if (seeded === undefined) throw new Error('unreachable');

    const revoked = await revokeApiKey(directory, seeded.id);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });

  it('sanity: a seeded membership id still reaches the fixture through the double', async () => {
    const directory = uuidColumnDirectory();
    const removable = (await directory.listMemberships()).find(
      (member) => member.role === 'viewer',
    );
    expect(
      removable,
      'the fixture needs a member the last-Owner rule does not protect, or this proves nothing',
    ).toBeDefined();
    if (removable === undefined) throw new Error('unreachable');

    const removed = await deleteMembership(directory, 'owner', removable.id);
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
  });
});

describe('a caller cannot change or remove a member who outranks it', () => {
  it('an Admin can neither demote nor remove an Owner, even when another Owner remains', async () => {
    const directory = createMemoryDirectory({
      newId: crypto.randomUUID,
      users: [
        ...MEMBERS,
        {
          email: 'owner-2@example.test',
          name: 'Second owner',
          workspaceId: TEST_WORKSPACE_ID,
          role: 'owner',
        },
      ],
    }).forWorkspace(TEST_WORKSPACE_ID);
    const owner = (await directory.listMemberships()).find((m) => m.email === 'owner@example.test');
    if (owner === undefined) throw new Error('seed did not create the owner');

    const demoted = await changeMembershipRole(directory, 'admin', owner.id, { role: 'viewer' });
    expect(demoted.status, JSON.stringify(demoted.body)).toBe(403);
    expect(JSON.stringify(demoted.body)).toContain('forbidden_role_conferral');
    const removed = await deleteMembership(directory, 'admin', owner.id);
    expect(removed.status, JSON.stringify(removed.body)).toBe(403);

    // The other Owner may: the refusal is about the caller's rank, not the last-Owner rule.
    expect((await deleteMembership(directory, 'owner', owner.id)).status).toBe(204);
  });
});

describe('the gate is reached before anything else the handler does', () => {
  it('answers 503 when no runtime is configured, on every route', async () => {
    clearApplicationContext();
    for (const route of WIRED) {
      const request = new Request(`https://control-plane.test${route.concrete}`, {
        method: route.method,
        ...(route.body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) }),
      });
      const response = await route.handler(request, {
        params: Promise.resolve({ id: SAMPLE_ID }),
      });
      const text = await response.text();
      expect(response.status, `${key(route)}: ${text}`).toBe(503);
      expect(text).toContain('rbac_runtime_not_configured');
    }
  });

  it('answers 401 to a caller it cannot identify, and never 400 about the body first', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      for (const route of WIRED) {
        // No caller header, and — for the routes that take one — a body that is not even JSON.
        const request = new Request(`https://control-plane.test${route.concrete}`, {
          method: route.method,
          headers: { 'content-type': 'text/plain' },
          ...(route.method === 'GET' || route.method === 'DELETE' ? {} : { body: 'not json' }),
        });
        const response = await route.handler(request, {
          params: Promise.resolve({ id: SAMPLE_ID }),
        });
        const text = await response.text();
        expect(response.status, `${key(route)}: ${text}`).toBe(401);
      }
    } finally {
      harness.teardown();
    }
  });

  it('answers 401 to a member of no workspace, rather than a default role', async () => {
    const harness = installRbacHarness(MEMBERS);
    try {
      const response = await harness.call(LIST_USERS, {
        method: 'GET',
        path: '/api/users',
        as: { email: 'stranger@example.test' },
      });
      expect(response.status).toBe(401);
    } finally {
      harness.teardown();
    }
  });
});

describe('the test-only identity header is not readable by anything that ships', () => {
  it('appears in tests/testing code and in no other tracked file', () => {
    // A string search, not an import-graph question, so ADR-0030 does not apply: what is being
    // asserted is that the literal `x-test-caller` occurs nowhere a request could reach it.
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'tests'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((file) => file !== '');
    expect(
      tracked.length,
      'git listed no tracked files, so this scan proved nothing',
    ).toBeGreaterThan(0);
    const mentions = tracked.filter((file) => {
      try {
        return readFileSync(`${REPO_ROOT}/${file}`, 'utf8').includes('x-test-caller');
      } catch {
        // A tracked file that cannot be read is reported rather than skipped.
        return true;
      }
    });
    expect(mentions.sort()).toEqual(
      ['apps/web/server/rbac/routes.test.ts', 'apps/web/server/rbac/testing.ts'].sort(),
    );
  });
});
