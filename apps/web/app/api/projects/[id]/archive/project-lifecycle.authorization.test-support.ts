/**
 * `POST /api/projects/:id/archive` and `POST /api/projects/:id/restore` against a real PostgreSQL —
 * issue #183's role matrix, its concealment rule, its idempotence-with-audit rule and its
 * history-attribution criterion, driven with real `Request` objects through the route handlers
 * exactly as Next.js calls them.
 *
 * Shape borrowed from `../default-model.test.ts` (`createIsolatedTestDatabase` + `openDatabaseRoot`
 * + `describe.skipIf(!hasDatabase)`), with one difference that matters: the actor header carries a
 * real `users.id`, not an email, because `projects.created_by` and `audit_events.actor_user_id` are
 * both `uuid` foreign keys and the own/other split this file is about is a comparison against the
 * former.
 */
import crypto from 'node:crypto';

import { expect, it } from 'vitest';

import {
  adminA,
  asProblem,
  createScopedFixture,
  creator,
  otherBuilder,
  ownerA,
  ownerB,
  STRANGER,
  viewerA,
  workspaceB,
} from './project-lifecycle.test-support';

export function registerAuthorizationTests(fixture: ReturnType<typeof createScopedFixture>) {
  it('lets the workspace Owner archive and restore, publishing archivedAt both ways', () =>
    letsWorkspaceOwnerArchiveRestorePublishingArchivedAtBoth(fixture));

  it('lets the Builder who created the project archive and restore it', () =>
    letsBuilderWhoCreatedProjectArchiveRestoreIt(fixture));

  it('lets a workspace Admin archive and restore any project (ADR-0152)', () =>
    letsWorkspaceAdminArchiveRestoreAnyProjectADR(fixture));

  /**
   * The concealment criterion, asserted as an equality rather than as "some 4xx": every refused
   * caller receives the byte-identical response an id that names nothing at all produces. A 403
   * here — the answer `GET`/`PATCH /api/projects/:id` give — fails this test by name.
   */
  it('conceals a refused Builder, Viewer and foreign-workspace caller exactly like a nonexistent id', () =>
    concealsRefusedBuilderViewerForeignWorkspaceCallerExactly(fixture));

  /**
   * A malformed `:id` is an id that names nothing at all, so it gets that one answer too —
   * issue #200. `projects.id` is a `uuid` column, so a segment that is not a UUID cannot match
   * a row; handing it to the repository instead makes PostgreSQL raise `22P02 invalid input
   * syntax for type uuid`, which `errorResponse` classifies as an unclassified persistence
   * failure and reports as `500 internal_error`.
   *
   * Asserted as an equality against the absent-id control rather than as "some 4xx", for the
   * same reason the concealment case above is: the contract is that *one* response answers
   * every id that names nothing, so a caller must not be able to tell a malformed id from an
   * absent one by its status, its code or its message.
   */
  it('answers a malformed id exactly like an absent one, on both archive and restore', () =>
    answersMalformedIdExactlyLikeAbsentOneBoth(fixture));

  /**
   * Concealment applies to the **refusal**, never to the absence of a credential: answering an
   * unauthenticated caller "no such project" would make a missing credential indistinguishable
   * from a wrong one and would answer a question they never got far enough to ask.
   */
  it('keeps a 401 a 401 — an unauthenticated caller is not concealed as a missing project', () =>
    keeps401401UnauthenticatedCallerIsNotConcealed(fixture));
}

async function letsWorkspaceOwnerArchiveRestorePublishingArchivedAtBoth(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  const archived = await fixture.archive(ownerA.id);
  expect(archived.status, await archived.clone().text()).toBe(200);
  const archivedBody = (await archived.json()) as { id: string; archivedAt: string | null };
  expect(archivedBody.id).toBe(fixture.projectId);
  expect(archivedBody.archivedAt).not.toBeNull();
  expect(await fixture.storedArchivedAt()).not.toBeNull();

  const restored = await fixture.restore(ownerA.id);
  expect(restored.status, await restored.clone().text()).toBe(200);
  const restoredBody = (await restored.json()) as { archivedAt: string | null };
  expect(restoredBody.archivedAt).toBeNull();
  expect(await fixture.storedArchivedAt()).toBeNull();
}

async function letsBuilderWhoCreatedProjectArchiveRestoreIt(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  const archived = await fixture.archive(creator.id);
  expect(archived.status, await archived.clone().text()).toBe(200);
  expect(await fixture.storedArchivedAt()).not.toBeNull();

  const restored = await fixture.restore(creator.id);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await fixture.storedArchivedAt()).toBeNull();
}

async function letsWorkspaceAdminArchiveRestoreAnyProjectADR(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  const archived = await fixture.archive(adminA.id);
  expect(archived.status, await archived.clone().text()).toBe(200);
  expect(await fixture.storedArchivedAt()).not.toBeNull();

  const restored = await fixture.restore(adminA.id);
  expect(restored.status, await restored.clone().text()).toBe(200);
  expect(await fixture.storedArchivedAt()).toBeNull();
}

async function concealsRefusedBuilderViewerForeignWorkspaceCallerExactly(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  const nonexistent = await asProblem(await fixture.archive(ownerA.id, crypto.randomUUID()));
  expect(nonexistent.status).toBe(404);

  const refusals = [
    ['non-creator Builder', await asProblem(await fixture.archive(otherBuilder.id))],
    ['Viewer', await asProblem(await fixture.archive(viewerA.id))],
    [
      'foreign-workspace Owner',
      await asProblem(await fixture.archive(ownerB.id, fixture.projectId, workspaceB.id)),
    ],
  ] as const;

  for (const [who, problem] of refusals) {
    expect(problem, `${who} must be answered exactly like a nonexistent id`).toEqual(nonexistent);
  }
  // None of them changed anything, which is the other half of "refused".
  expect(await fixture.storedArchivedAt()).toBeNull();
  expect(await fixture.auditRows()).toEqual([]);

  // Restore refuses identically, so a caller cannot learn the project exists from one route
  // while being concealed by the other.
  expect(await asProblem(await fixture.restore(otherBuilder.id))).toEqual(nonexistent);
}

async function answersMalformedIdExactlyLikeAbsentOneBoth(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  // A malformed id must not outrank the credential check: the guard lives inside the
  // `withProjects` callback, so 401 still precedes it. Moving the guard into the two
  // `route.ts` files would turn these into 404s and conceal a missing credential. The "keeps a
  // 401 a 401" case below cannot catch that — its id is a well-formed UUID the guard accepts.
  expect((await fixture.archive(null, 'not-a-uuid')).status).toBe(401);
  expect((await fixture.restore(null, 'not-a-uuid')).status).toBe(401);

  const nonexistent = await asProblem(await fixture.archive(ownerA.id, crypto.randomUUID()));
  expect(nonexistent.status).toBe(404);

  const auditsBefore = await fixture.auditCount();
  const malformed = [
    ['a segment that is not a UUID at all', 'not-a-uuid'],
    ['a near-miss one character short', '11111111-1111-4111-8111-11111111111'],
    ['a well-formed UUID with a trailing suffix', '11111111-1111-4111-8111-111111111111x'],
  ] as const;

  for (const [shape, id] of malformed) {
    expect(
      await asProblem(await fixture.archive(ownerA.id, id)),
      `archive with ${shape} must be answered exactly like an absent id`,
    ).toEqual(nonexistent);
    // Restore answers identically, so one route cannot leak what the other conceals.
    expect(
      await asProblem(await fixture.restore(ownerA.id, id)),
      `restore with ${shape} must be answered exactly like an absent id`,
    ).toEqual(nonexistent);
  }

  // Refused before anything was touched — a later "fix" that answers 404 only after writing
  // fails here rather than passing on the status alone. The audit check is a count taken around
  // the requests, and unfiltered: `auditRows()` is scoped to `projectId`, which none of these
  // ids can ever name, so an equality against it would stay green whatever was written.
  expect(await fixture.storedArchivedAt()).toBeNull();
  expect(await fixture.auditCount()).toBe(auditsBefore);
}

async function keeps401401UnauthenticatedCallerIsNotConcealed(
  fixture: ReturnType<typeof createScopedFixture>,
) {
  const noHeaders = await fixture.archive(null);
  expect(noHeaders.status).toBe(401);

  // Past the projects runtime, refused by the RBAC identity layer: still 401, not 404.
  const unknownIdentity = await fixture.archive(STRANGER);
  expect(unknownIdentity.status, await unknownIdentity.clone().text()).toBe(401);
  expect(await fixture.storedArchivedAt()).toBeNull();
}
