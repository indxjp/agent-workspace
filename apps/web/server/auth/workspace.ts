/**
 * Workspace scoping — spec §25 ("Do not allow Claude configuration from one workspace to leak
 * into another"), §21.
 *
 * The database side of this rule is already mechanical: `packages/core/src/db/schema/tenancy.test.ts`
 * fails the build if a new table carries no `workspace_id`, and names the only two exemptions
 * (`workspaces`, `users`). What that test cannot do is force a *query* to filter on it. This
 * module is the application-side half: the tenant a request is allowed to see is derived from
 * the verified session and from nothing else — never from a query parameter, a path segment, a
 * request body or a header, all of which the caller controls.
 *
 * That sentence used to be a comment over a structural interface, which made it false. These
 * three lines all compiled under `--strict`:
 *
 * ```ts
 * workspaceScopeFrom({ sub: body.email, ws: body.workspace, role: 'owner', iat: 0, exp: 9e9 });
 * const scope: WorkspaceScope = { workspaceSlug: q.ws, actorEmail: q.who, role: 'owner' };
 * const wrong = { ...realScope, workspaceSlug: q.ws };
 * ```
 *
 * They are now three compile errors, because `WorkspaceScope` is a class carrying `#private`
 * fields: it cannot be written as an object literal, it cannot be constructed from outside this
 * module, and — unlike a phantom `unique symbol` brand, which was the first attempt — the fields
 * are dropped by an object spread, so a real scope cannot be *copied* with its tenant replaced.
 * `tests/auth.test.ts` compiles a fixture holding each forgery and fails unless each one is
 * rejected on its own line.
 *
 * ## Copying is not the only way to change a tenant, and the compiler does not see the other one
 *
 * Verification round 2 found the hole the paragraph above walks straight past. `readonly` is
 * erased before anything runs, so this line compiled with no diagnostic at all — no cast, no
 * `any` — and at runtime replaced a genuine scope's tenant in place while `isWorkspaceScope`
 * went on answering `true`:
 *
 * ```ts
 * Object.assign(realScope, { workspaceSlug: body.workspace });
 * ```
 *
 * `Object.assign` cannot be made a compile error: its signature is `assign<T, U>(target: T,
 * source: U): T & U`, which consults no `readonly` modifier on `T`. So the property is enforced
 * where it is enforceable — at runtime. The constructor below calls `Object.freeze(this)`, which
 * makes every own property non-writable and non-configurable and the object non-extensible.
 * `Object.assign`, `Object.defineProperty` and `Object.setPrototypeOf` raise `TypeError` on such
 * a target in strict mode and in sloppy mode alike. `scope.workspaceSlug = x` and
 * `delete scope.workspaceSlug` throw in strict mode — which is every module in this repository —
 * and fail silently in sloppy mode. The tenant is not written under any of them: immutable in
 * fact, not merely in the type.
 *
 * The guard was widened to match: it no longer asks "does this object have the private field",
 * which is a question about shape, but "is this object still the one this class froze", which is
 * the invariant. See `isWorkspaceScope` below.
 *
 * ## What is honestly not enforced here
 *
 * A deliberate `as WorkspaceScope` cast, or `Object.create(WorkspaceScope.prototype)`, still
 * produces a value the compiler accepts — the first because casts defeat every type in the
 * program, the second because it produces an object with no `#` field. `isWorkspaceScope`
 * rejects both at runtime; the compiler rejects neither.
 *
 * Neither does anything stop a caller who mints a token with a secret of their own choosing and
 * then verifies it with the same secret: that yields genuine `VerifiedSessionClaims` naming
 * whatever tenant the caller asked for, and it compiles clean. Both escapes are carried in the
 * `tests/auth.test.ts` fixture as `DECLARED` lines, asserted to produce *no* diagnostic, so each
 * declared gap is checked by the compiler rather than described in prose — and so that closing
 * one later fails a test instead of quietly leaving this comment stale.
 *
 * Nothing in this file *prevents* a route handler from querying without a scope at all. It
 * cannot: W1-CP-06 owns no query code — the §34 route handlers belong to W1-CP-04 and W1-CP-05
 * and do not exist on this branch. A mechanical "every handler filters on the scope" gate is
 * declared unbuilt in this task's PR rather than written as a check that would pass because it
 * had nothing to judge (ADR-0015). The full reasoning, including the gate that was written and
 * then deleted, is in docs/adr/W1-CP-06-session-carries-the-workspace-slug.md.
 *
 * The type-only import below is erased by TypeScript and by SWC before any resolver sees it, so
 * it is not the runtime sibling import that
 * docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md rules out. The live-server test
 * compiles this whole module graph through Turbopack and proves it.
 */
import type { VerifiedSessionClaims } from './session.js';

/**
 * The tenant a request may read and write, plus who is asking.
 *
 * `workspaceSlug` rather than `workspaces.id`. That choice used to be justified by a claim that
 * is false on this branch's base — that `apps/web` could not depend on `@agent-workspace/core`.
 * It can: `apps/web/package.json` has declared `"@agent-workspace/core": "workspace:*"` since
 * W1-DEP-01, and the id is reachable. The decision was re-taken on the grounds that survive, and
 * they are in docs/adr/W1-CP-06-session-carries-the-workspace-slug.md: putting the id in the
 * token means resolving the slug inside `signIn`, which is the one code path into the
 * application and which today performs no I/O at all. The cost of the slug is stated there too,
 * because it is real: one lookup on the `workspaces_slug_key` unique index in each handler that
 * needs `workspace_id`.
 *
 * The three public fields are plain, enumerable and frozen, so a handler reads them as it would
 * from any object and `JSON.stringify` produces exactly them, while nothing can write them. The
 * private fields are neither enumerable nor reachable from another module; they make the type
 * nominal and give the runtime guard something to compare against.
 */
export class WorkspaceScope {
  /** The tenant. `workspaces.slug`, not `workspaces.id`. Frozen at construction. */
  public readonly workspaceSlug: string;

  /** Who is asking. `users.email`, lower-cased, as the session carried it. */
  public readonly actorEmail: string;

  /** Spec §21's highest role, and the only one this wave mints or accepts. */
  public readonly role: 'owner';

  /**
   * The three values as the verified session gave them, kept where no other module can name them
   * and no `Object.assign` can reach them. Unnameable outside this file and dropped by an object
   * spread — which is what makes the type nominal — and they exist so that `isWorkspaceScope`
   * can check an invariant rather than a shape.
   */
  readonly #tenantFromVerifiedSession: string;
  readonly #actorFromVerifiedSession: string;
  readonly #roleFromVerifiedSession: 'owner';

  /**
   * Private, so the only way in is the static factory below, whose argument cannot be
   * fabricated. `new WorkspaceScope(…)` from another module is a compile error.
   *
   * The `Object.freeze` on the last line is the whole of the runtime half of this module's
   * promise, so it is worth being precise about what it buys. Freezing makes every own property
   * non-writable and non-configurable and the object non-extensible. `Object.assign` performs
   * `Set(target, key, value, true)` — the `true` is the throw flag — so it raises `TypeError`
   * whether or not the calling module is strict. `scope.workspaceSlug = x` throws in a module
   * (modules are always strict) and fails silently in sloppy mode; in neither case does the
   * value change. `Object.defineProperty` and `Object.setPrototypeOf` throw. The private fields
   * live in internal slots rather than in properties, so freezing does not cover them — nothing
   * outside this file can name them, and nothing inside it writes them after this line.
   */
  private constructor(claims: VerifiedSessionClaims) {
    this.workspaceSlug = claims.ws;
    this.actorEmail = claims.sub;
    this.role = claims.role;
    this.#tenantFromVerifiedSession = claims.ws;
    this.#actorFromVerifiedSession = claims.sub;
    this.#roleFromVerifiedSession = claims.role;
    Object.freeze(this);
  }

  /**
   * The only constructor there is. Its argument is what `verifySessionToken` returned — claims
   * assembled by hand, including those from `newSessionClaims`, do not type-check here — so this
   * being public costs nothing: there is no way to reach it with a tenant the caller chose that
   * does not go through minting and verifying a token, which is a declared escape rather than an
   * accident.
   */
  public static fromVerifiedSession(claims: VerifiedSessionClaims): WorkspaceScope {
    return new WorkspaceScope(claims);
  }

  /**
   * The runtime half of the same question, for a boundary the type system does not cross — a
   * value that arrived as `unknown`, one rebuilt by a serialiser, or one some other module has
   * had its hands on.
   *
   * This asks four questions, not one. The `#` check is the shape question and it alone is not
   * enough: it answered `true` for an object whose tenant had been overwritten in place, which
   * is exactly the hole verification round 2 found. So the guard also requires the object to be
   * frozen and requires each public field to still equal the value the constructor took from the
   * verified session. A cast, an object literal, a spread copy, a JSON round-trip and
   * `Object.create(WorkspaceScope.prototype)` all fail the first question; a tampered instance
   * fails one of the other three.
   *
   * Honestly: with the freeze in place, the last three questions are defence in depth and **no
   * test proves them**, because no code outside this file can produce the value that would
   * distinguish them — that is what the freeze is for. Measured rather than assumed, by running
   * both mutations: reverting this method to the bare `#` check leaves the whole suite green,
   * while removing `Object.freeze` turns every test in the runtime block of `tests/auth.test.ts`
   * red. The counts are in this task's PR rather than here, because a count in a comment goes
   * stale the next time a test is added (ADR-0016). They are kept because the freeze is one line
   * that a future edit can drop, and a guard that would then still answer `true` is worse than
   * one that would not.
   */
  public static isWorkspaceScope(value: unknown): value is WorkspaceScope {
    if (typeof value !== 'object' || value === null) return false;
    if (!(#tenantFromVerifiedSession in value)) return false;
    return (
      Object.isFrozen(value) &&
      value.workspaceSlug === value.#tenantFromVerifiedSession &&
      value.actorEmail === value.#actorFromVerifiedSession &&
      value.role === value.#roleFromVerifiedSession
    );
  }
}

/**
 * Derive the scope from verified claims. Kept as a function because that is the name the route
 * handlers in W1-CP-04 and W1-CP-05 are being handed; it is `WorkspaceScope.fromVerifiedSession`
 * and nothing else.
 */
export function workspaceScopeFrom(claims: VerifiedSessionClaims): WorkspaceScope {
  return WorkspaceScope.fromVerifiedSession(claims);
}
