/**
 * `WorkspaceScope` — the tenant every repository query is filtered by, made a *constructor
 * argument* rather than a rule reviewers are asked to remember.
 *
 * ## What Wave 1 built, and the half it declared unbuilt
 *
 * `apps/web/server/auth/workspace.ts` made **possession** of a scope compiler-checked: its
 * `WorkspaceScope` is a class with `#private` fields, so a handler cannot write one out of a
 * request body. Its own sibling `apps/web/server/auth/index.ts` then says, in its doc comment,
 * that the other half is not built:
 *
 * > Every query in a handler is expected to filter on the scope (spec §25) — that second half is
 * > a contract, not a gate, and is declared unbuilt.
 *
 * This module is that second half. The scope here is a *different* value from the auth one, and
 * deliberately so: the auth scope carries `workspaces.slug`, because that is what a session token
 * can carry without doing I/O, while a `where` clause needs `workspaces.id`. The two are joined by
 * {@link WorkspaceScopeResolver}, whose only job is to turn the thing a request carries into the
 * thing a query needs — and to answer `null` when no such workspace exists.
 *
 * ## How "every query filters on the tenant" stops being a contract
 *
 * A repository is obtained *for a scope*, and no method on a repository takes a workspace id. So
 * there is no call site at which the filter can be forgotten, because there is no parameter to
 * forget, and the `where` clause is built inside the repository from `scope.workspaceId`.
 * `scope-forgery.test.ts` runs `tsc` over a fixture of deliberate forgeries and requires each one
 * to be a compile error on its own line — the same shape `tests/auth.test.ts` uses, for the same
 * reason: a property that is a compile error cannot be tested by code that compiles.
 *
 * ## Why the class shape is what it is
 *
 * Copied, with its reasoning, from `apps/web/server/auth/workspace.ts`, which arrived at it after
 * two verification rounds:
 *
 *   * `#private` fields make the type **nominal**. An object literal will not satisfy it, and —
 *     unlike a phantom brand — an object *spread* drops the private fields, so a real scope cannot
 *     be copied with its tenant replaced.
 *   * `Object.freeze(this)` closes the hole a type cannot: `readonly` is erased before anything
 *     runs and `Object.assign`'s signature consults no modifier, so `Object.assign(scope, { … })`
 *     compiles. On a frozen target it throws `TypeError` instead.
 *   * {@link WorkspaceScope.isWorkspaceScope} asks whether this is still the object this class
 *     froze, not whether the shape matches, so a tampered instance fails it.
 *
 * The two resolvers are **static methods** rather than free functions for a reason that is not
 * style: TypeScript's `private constructor` is reachable from inside the class body and from
 * nowhere else, so putting them here is what keeps the constructor genuinely closed while still
 * letting this module mint a scope after a lookup succeeds.
 *
 * ## What is honestly not enforced *by the compiler*, and what refuses it instead
 *
 * A deliberate `as WorkspaceScope` cast, and `Object.create(WorkspaceScope.prototype)`, still
 * type-check — casts defeat every type in the program. Both are carried in the forgery fixture as
 * `DECLARED` lines asserted to compile clean, so the gap is on the compiler's record rather than
 * in this paragraph, and closing one later fails a test instead of leaving this comment stale.
 *
 * Verification round 1 found that this file previously claimed both were "refused at run time by
 * `WorkspaceScope.isWorkspaceScope`" while that predicate had **no call site outside its own unit
 * test**, and the verifier used both forgeries to read another workspace's rows out of a real
 * PostgreSQL. {@link requireWorkspaceScope} is the call site that claim needed: every `forScope`
 * in this directory runs it before it builds a `where` clause, so a forged scope is a thrown
 * {@link ForgedWorkspaceScopeError} rather than a cross-tenant read. `scope-forgery.test.ts`
 * asserts the refusal against both forgeries and against every provider in this directory,
 * derived from the tracked tree rather than listed.
 *
 * And a caller holding the `Database` handle can resolve a scope for any workspace id it likes.
 * That escape is smaller than it was: the handle is no longer obtainable from
 * `@agent-workspace/core/db` at all — `openDatabaseRoot()` returns scope-bound providers and no
 * `db` — and the raw half sits behind `@agent-workspace/core/db/unscoped`, which refuses to load
 * outside a test process. See `./root.ts` and `./unscoped.ts`.
 *
 * What this module removes is the ability to *write a query that forgets the tenant* through the
 * repository layer. It does not, on its own, remove the ability to skip the layer; that is
 * `./root.ts`'s and `./unscoped.ts`'s half, and `database-reachability.test.ts` is the gate over
 * both.
 */
import { eq } from 'drizzle-orm';

import type { Database } from '../client.js';
import { workspaces } from '../schema/workspaces.js';

/** One workspace, as an in-memory deployment knows it. */
export interface KnownWorkspace {
  readonly id: string;
  readonly slug: string;
}

/**
 * Turns what a request carries into what a query needs.
 *
 * Both methods answer `null` rather than throwing, and `null` means exactly one thing: **no such
 * workspace row**. That is the positive-assertion shape ADR-0015 asks for — a scope exists because
 * a workspace was found, never because nothing objected. A caller that treats `null` as "carry on
 * unscoped" is writing the bug this module exists to prevent, which is why no method here has a
 * fallback and why every repository takes the scope rather than the id.
 */
export interface WorkspaceScopeResolver {
  /** The scope for a `workspaces.id`, or `null` when no workspace has that id. */
  forWorkspaceId(workspaceId: string): Promise<WorkspaceScope | null>;
  /** The scope for a `workspaces.slug` — what a session token carries — or `null`. */
  forWorkspaceSlug(slug: string): Promise<WorkspaceScope | null>;
}

/**
 * The tenant a repository reads and writes, and nothing else.
 *
 * Deliberately does **not** carry the actor or the actor's role. Those are authorisation inputs
 * and belong to W2-CP-06's RBAC layer; a repository that took them would be deciding
 * authorisation in the same place it builds a `where` clause, and the two have different reasons
 * to change. What a repository needs from a request is exactly one value, and this is it.
 */
export class WorkspaceScope {
  /** `workspaces.id`. The value every repository's `where` clause is built from. */
  public readonly workspaceId: string;

  /**
   * The same value, kept where no other module can name it and no `Object.assign` can reach it.
   * Unnameable outside this file and dropped by an object spread — which is what makes the type
   * nominal — and it exists so {@link isWorkspaceScope} can check an invariant, not a shape.
   */
  readonly #workspaceIdFromLookup: string;

  /**
   * Private, so the only way in is a resolver below, and every resolver below mints a scope only
   * after something positively answered "yes, that workspace exists".
   */
  private constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.#workspaceIdFromLookup = workspaceId;
    Object.freeze(this);
  }

  /**
   * The runtime half of the same question, for a boundary the type system does not cross — a
   * value that arrived as `unknown`, or one some other module has had its hands on.
   *
   * Two questions, not one. The `#` check is the shape question; a cast and
   * `Object.create(WorkspaceScope.prototype)` fail it. The frozen-and-unchanged check is the
   * invariant; an instance whose public field was overwritten in place fails that. Written as a
   * positive assertion with no negative arm: it returns `true` because every question was
   * answered, never because none of them said no (ADR-0015).
   */
  public static isWorkspaceScope(value: unknown): value is WorkspaceScope {
    if (typeof value !== 'object' || value === null) return false;
    if (!(#workspaceIdFromLookup in value)) return false;
    return Object.isFrozen(value) && value.workspaceId === value.#workspaceIdFromLookup;
  }

  /**
   * The PostgreSQL resolver: one indexed lookup, and a scope only if it returned a row.
   *
   * `workspaces_slug_key` and the primary key make both lookups index scans, which is what makes
   * it acceptable for this to run per request — the cost
   * `docs/adr/W1-CP-06-session-carries-the-workspace-slug.md` named when it chose to put the slug
   * rather than the id into the session token.
   */
  public static databaseResolver(db: Database): WorkspaceScopeResolver {
    const lookup = async (column: 'id' | 'slug', value: string): Promise<WorkspaceScope | null> => {
      const rows = await db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(column === 'id' ? eq(workspaces.id, value) : eq(workspaces.slug, value))
        .limit(1);
      const row = rows[0];
      // The explicit else. A row was returned, or there is no scope — there is no third arm in
      // which a scope is produced from the value the caller supplied.
      return row === undefined ? null : new WorkspaceScope(row.id);
    };
    return {
      forWorkspaceId: (workspaceId: string): Promise<WorkspaceScope | null> =>
        lookup('id', workspaceId),
      forWorkspaceSlug: (slug: string): Promise<WorkspaceScope | null> => lookup('slug', slug),
    };
  }

  /**
   * The in-memory resolver, for the deployment that has no database and for tests.
   *
   * `known` is the whole set of workspaces this deployment has, and a lookup that misses answers
   * `null` — the same contract the PostgreSQL resolver has, so a caller cannot tell the two apart
   * by behaviour. That is what makes it usable as the second implementation of everything built on
   * top: the two agree because a suite asserts it, not because one was written by reading the
   * other.
   *
   * It copies the argument into a `Map` once rather than keeping a live view of it: a resolver
   * whose answers changed under a request would make "this scope names a workspace that exists"
   * true at different times for different queries in the same handler.
   */
  public static inMemoryResolver(known: Iterable<KnownWorkspace>): WorkspaceScopeResolver {
    const byId = new Map<string, string>();
    const bySlug = new Map<string, string>();
    for (const row of known) {
      byId.set(row.id, row.id);
      bySlug.set(row.slug, row.id);
    }
    const lookup = (index: Map<string, string>, key: string): Promise<WorkspaceScope | null> => {
      const id = index.get(key);
      return Promise.resolve(id === undefined ? null : new WorkspaceScope(id));
    };
    return {
      forWorkspaceId: (workspaceId: string): Promise<WorkspaceScope | null> =>
        lookup(byId, workspaceId),
      forWorkspaceSlug: (slug: string): Promise<WorkspaceScope | null> => lookup(bySlug, slug),
    };
  }
}

/**
 * Thrown when a value that is typed as a {@link WorkspaceScope} is not one this class minted.
 *
 * Named rather than generic, because the two ways to produce such a value are both deliberate —
 * an `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)` — and an operator
 * reading this in a log is looking at an attempt to read across a tenant boundary, not at a typo.
 */
export class ForgedWorkspaceScopeError extends Error {
  /** The provider that refused, so the log names the query that did not run. */
  public readonly repository: string;

  public constructor(repository: string) {
    super(
      `${repository}.forScope was given a value that WorkspaceScope did not mint. A scope is ` +
        'obtained from a WorkspaceScopeResolver after a workspace row was found; a cast or ' +
        'Object.create(WorkspaceScope.prototype) type-checks and is refused here.',
    );
    this.name = 'ForgedWorkspaceScopeError';
    this.repository = repository;
  }
}

/**
 * The run-time half of the scope gate, called by every `forScope` in this directory.
 *
 * A positive assertion with an explicit else (ADR-0015): the value is returned because
 * {@link WorkspaceScope.isWorkspaceScope} answered `true` about it, and every other value —
 * including the two the compiler admits — throws by name. It runs before any `where` clause is
 * built, so a refused scope issues no query at all.
 *
 * The parameter is `unknown` rather than `WorkspaceScope` on purpose. Typed as the class, the two
 * declared forgeries would arrive already believed, and `noUnnecessaryCondition`-style reasoning
 * would call the check dead. It is exactly the values the type system cannot tell apart that this
 * exists for.
 */
export function requireWorkspaceScope(value: unknown, repository: string): WorkspaceScope {
  if (WorkspaceScope.isWorkspaceScope(value)) return value;
  throw new ForgedWorkspaceScopeError(repository);
}

/** The PostgreSQL {@link WorkspaceScopeResolver}. See {@link WorkspaceScope.databaseResolver}. */
export function createDatabaseWorkspaceScopeResolver(db: Database): WorkspaceScopeResolver {
  return WorkspaceScope.databaseResolver(db);
}

/** The in-memory {@link WorkspaceScopeResolver}. See {@link WorkspaceScope.inMemoryResolver}. */
export function createInMemoryWorkspaceScopeResolver(
  known: Iterable<KnownWorkspace>,
): WorkspaceScopeResolver {
  return WorkspaceScope.inMemoryResolver(known);
}

/**
 * Thrown when a caller asks for a repository bound to a workspace that no longer exists.
 *
 * A named error rather than a silent empty result, because the two are different facts and only
 * one of them is survivable: "this workspace has no agents" and "this workspace was deleted while
 * you held a session for it" must not render the same. ADR-0015 — a check that cannot run fails,
 * it does not fall through to the answer that looks like success.
 */
export class UnknownWorkspaceError extends Error {
  public readonly workspaceId: string;

  public constructor(workspaceId: string) {
    super(
      `no workspace has id ${workspaceId}; a repository cannot be scoped to a workspace that ` +
        'does not exist',
    );
    this.name = 'UnknownWorkspaceError';
    this.workspaceId = workspaceId;
  }
}
