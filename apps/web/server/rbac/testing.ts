/**
 * The harness this task's tests drive the real route files with.
 *
 * It is not a mock of the routes. It installs a real {@link RbacRuntime} — a real in-memory
 * directory, and an `identify` that builds a real {@link Principal} out of claims that a real
 * `mintSessionToken` / `verifySessionToken` round trip produced — and then calls the exported
 * `GET`/`POST`/`PATCH`/`DELETE` of `apps/web/app/api/**` with real `Request` objects. Everything
 * between the request and the store is the code that ships.
 *
 * ## Why the role is an argument here
 *
 * `apps/web/server/auth/session.ts` mints and verifies `role: 'owner'` and rejects any other
 * value, and that file belongs to W1-CP-06, not to this task. Four roles therefore cannot travel
 * in a session cookie on this branch. They do not need to: `Principal.fromSession` takes the role
 * from the **directory**, not from the token — which is the shape this task would want anyway (a
 * role read per request stops working the moment an administrator takes it away, and a role in a
 * token does not). So the harness seeds a member with a role and the identity resolver reads it
 * back, which is exactly the production path minus the composition root nobody here owns.
 *
 * ## Every response is recorded
 *
 * {@link RecordedResponse} keeps the status and the body **text** of every response the suite
 * produced. R-12 §1.5 asks for exactly that: presentation-once is proved by scanning every
 * response body for the plaintext rather than by inspecting the one handler that returns it.
 *
 * ## Every workspace scoping is recorded, and that is how `allow` is asserted positively
 *
 * `authorise` is the only caller of `DirectoryRoot.forWorkspace` in the program: it calls it on
 * the `allow` branch and nowhere else, to hand the handler a directory fixed to the principal's
 * workspace. The route files receive their directory from that callback and have no other way to
 * obtain one. So the harness wraps the root and records every scoping, and
 * {@link RbacHarness.scopedWorkspaces} is a *positive* fact about a request: the gate ran, it
 * allowed, and it scoped the handler to this workspace. Round 1 asserted the `allow` case as
 * `not.toBe(403)` plus `not.toContain('authorisation_undecidable')` — two negatives a handler
 * that never called `authorise` at all would also satisfy.
 */
import {
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
  type VerifiedSessionClaims,
} from '../auth/session';

import type { DirectoryRoot } from './directory';
import {
  createMemoryDirectory,
  type MemoryDirectory,
  type SeedUser,
  type SeedWorkspace,
} from './memory-directory';
import { Principal } from './principal';
import { presentedKeyText, readBearerApiKeyAttempt } from './api-key';
import type { Role } from './roles';
import { clearRbacRuntime, configureRbacRuntime } from './runtime';

/** A secret this test process invents. Long enough for `MIN_SESSION_SECRET_LENGTH`. */
const TEST_SESSION_SECRET = 'a-test-session-secret-that-is-long-enough-32';

/** The workspace every seeded member belongs to unless a test says otherwise. */
export const TEST_WORKSPACE_ID = 'workspace-under-test';

/**
 * The same workspace's slug — what a session token carries, as against the id every row is scoped
 * by. They are deliberately different strings here, so that a `Principal.fromSession` that
 * compared an id against a slug, or one that compared nothing at all, would fail rather than pass
 * by the two happening to be spelled the same.
 */
export const TEST_WORKSPACE_SLUG = 'workspace-under-test-slug';

/** What one request produced. `text` is the raw body, which is what a plaintext scan needs. */
export interface RecordedResponse {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly text: string;
}

/** A signed-in caller, by email. The role comes from the seeded membership. */
export interface Caller {
  readonly email: string;
}

/** Optional real identifiers for service-backed route tests. Defaults preserve the unit harness. */
export interface RbacHarnessOptions {
  readonly workspaceId?: string;
  readonly workspaceSlug?: string;
  readonly workspaces?: readonly SeedWorkspace[];
  readonly newId?: () => string;
}

/** The harness. */
export interface RbacHarness {
  readonly directory: MemoryDirectory;
  /** Every response this harness has produced, in order. */
  readonly responses: RecordedResponse[];
  /**
   * Every workspace `authorise` scoped a directory to, in order — one entry per request it
   * allowed, and none for a request it denied, refused or could not identify. See this file's
   * header: this is what lets a test assert `allow` positively.
   */
  readonly scopedWorkspaces: string[];
  /** Call a route handler with a real Request, as the given caller. */
  call(
    handler: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>,
    options: {
      readonly method: string;
      readonly path: string;
      readonly as: Caller | null;
      readonly body?: unknown;
      readonly id?: string;
      readonly bearer?: string;
      readonly cookies?: Readonly<Record<string, string>>;
      readonly origin?: string | null;
    },
  ): Promise<{ status: number; body: unknown; text: string; headers: Headers }>;
  /** Remove the installed runtime, so a test can prove the unconfigured path fails. */
  teardown(): void;
}

/** Mint and verify, which is the only way to obtain `VerifiedSessionClaims`. */
async function verifiedClaims(
  email: string,
  workspaceSlug: string,
): Promise<VerifiedSessionClaims> {
  const token = await mintSessionToken(newSessionClaims(email, workspaceSlug), TEST_SESSION_SECRET);
  const result = await verifySessionToken(token, TEST_SESSION_SECRET);
  if (!result.ok) throw new Error(`the harness could not verify its own token: ${result.reason}`);
  return result.claims;
}

/**
 * The request headers that make `caller` the identity {@link installRbacHarness}'s resolver reads
 * (none for `null`). The one place outside the resolver that spells the test-only header, so a
 * test that builds its own `Request` (a raw, non-JSON body, say) never has to.
 */
export function callerHeaders(caller: Caller | null): Record<string, string> {
  return caller === null ? {} : { 'x-test-caller': caller.email };
}

/**
 * Install a runtime over an in-memory directory seeded with `members`, and return the harness.
 *
 * The identity resolver reads the caller from an `x-test-caller` request header — this harness
 * writes that header and nothing else does, and it is never read by any module that ships. Every
 * other part of the path is production code: the claims are verified, the role comes from the
 * directory's `resolveRole`, and the `Principal` is built by its own factory.
 */
export function installRbacHarness(
  members: readonly SeedUser[],
  options: RbacHarnessOptions = {},
): RbacHarness {
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE_ID;
  const workspaceSlug = options.workspaceSlug ?? TEST_WORKSPACE_SLUG;
  const directory = createMemoryDirectory({
    users: members,
    ...(options.workspaces === undefined ? {} : { workspaces: options.workspaces }),
    ...(options.newId === undefined ? {} : { newId: options.newId }),
  });
  const responses: RecordedResponse[] = [];
  const scopedWorkspaces: string[] = [];

  // The root the runtime sees. Only `forWorkspace` is wrapped, and only to record it; the other
  // two methods are the directory's own, so nothing about identification changes.
  const recordingRoot: DirectoryRoot = {
    forWorkspace: (workspaceId: string) => {
      scopedWorkspaces.push(workspaceId);
      return directory.forWorkspace(workspaceId);
    },
    authenticateApiKey: (presented: string, now: Date) =>
      directory.authenticateApiKey(presented, now),
    resolveRole: (email: string, workspaceId: string) => directory.resolveRole(email, workspaceId),
    findUserByEmail: (email: string) => directory.findUserByEmail(email),
    findIdentity: (issuer: string, subject: string) => directory.findIdentity(issuer, subject),
    linkIdentity: (issuer: string, subject: string, userId: string) =>
      directory.linkIdentity(issuer, subject, userId),
    membershipsForUser: (userId: string) => directory.membershipsForUser(userId),
    acceptInvitation: (id, token, identity) => directory.acceptInvitation(id, token, identity),
  };

  configureRbacRuntime({
    directory: recordingRoot,
    identify: async (request: Request): Promise<Principal | null> => {
      // An API key first, because a request carrying one carries no cookie (R-12 §2.3).
      const bearer = readBearerApiKeyAttempt(request.headers.get('authorization'));
      if (bearer.kind === 'invalid') return null;
      if (bearer.kind === 'presented') {
        const identity = await directory.authenticateApiKey(
          presentedKeyText(bearer.key),
          new Date(),
        );
        // The explicit else: an unusable key is no identity at all, never a downgraded one.
        if (identity === null) return null;
        return Principal.fromApiKey(identity);
      }
      const email = request.headers.get('x-test-caller');
      if (email === null) return null;
      const claims = await verifiedClaims(email, workspaceSlug);
      const role: Role | null = await directory.resolveRole(email, workspaceId);
      // The explicit else: no membership row means no identity, never a default role.
      if (role === null) return null;
      const membership = (await directory.forWorkspace(workspaceId).listMemberships()).find(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
      );
      if (membership === undefined) return null;
      const built = Principal.fromSession(claims, { id: workspaceId, slug: workspaceSlug }, role, {
        principalId: membership.principalId,
        userId: membership.userId,
        label: membership.name,
      });
      // And the explicit else for the workspace correspondence: a session whose tenant is not the
      // one the role was read in produces no identity either.
      if (!built.ok) return null;
      return built.principal;
    },
  });

  return {
    directory,
    responses,
    scopedWorkspaces,
    call: async (handler, options) => {
      const url = `https://control-plane.test${options.path}`;
      const headers: Record<string, string> = callerHeaders(options.as);
      if (options.bearer !== undefined) headers['authorization'] = `Bearer ${options.bearer}`;
      if (options.cookies !== undefined) {
        headers['cookie'] = Object.entries(options.cookies)
          .map(([name, value]) => `${name}=${value}`)
          .join('; ');
      }
      if (options.origin !== undefined && options.origin !== null)
        headers['origin'] = options.origin;
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const request = new Request(url, {
        method: options.method,
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      const response = await handler(request, {
        params: Promise.resolve({ id: options.id ?? '' }),
      });
      const text = await response.text();
      responses.push({ method: options.method, url, status: response.status, text });
      let body: unknown = null;
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          body = text;
        }
      }
      return { status: response.status, body, text, headers: response.headers };
    },
    teardown: clearRbacRuntime,
  };
}

/** The request header {@link installWorkspaceHeaderRbac}'s resolver reads the caller's role from. */
export const TEST_ROLE_HEADER = 'x-test-role';

/**
 * Install a runtime whose identity is an API key of the workspace a test-only header names, with
 * the role {@link TEST_ROLE_HEADER} names (an Owner when absent), for the suites whose store is
 * resolved from the same header rather than seeded in a directory — the secrets and runtime
 * families. No header, no identity. Everything after identification — `decide()`, §21's table,
 * the `403` — is production code, so a suite using this proves the role gate, not a stand-in.
 */
export function installWorkspaceHeaderRbac(workspaceHeader: string): void {
  configureRbacRuntime({
    directory: createMemoryDirectory(),
    identify: (request: Request): Promise<Principal | null> => {
      const workspaceId = request.headers.get(workspaceHeader);
      const raw = request.headers.get(TEST_ROLE_HEADER);
      const role: Role = raw === 'admin' || raw === 'builder' || raw === 'viewer' ? raw : 'owner';
      return Promise.resolve(
        workspaceId === null
          ? null
          : Principal.fromApiKey({
              principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              workspaceId,
              role,
              label: 'Header-identified test key',
              actsForPrincipalId: null,
            }),
      );
    },
  });
}
