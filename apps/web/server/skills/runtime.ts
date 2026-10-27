/**
 * The seam between the skills routes and the two things this task does not own: who the caller is
 * (`apps/web/server/auth/**`, W1-CP-06) and an authorisation decision beyond "is there a session"
 * (W2-CP-06's RBAC layer).
 *
 * The composition root installs it as `ApplicationContext.skills` when `AW_STORAGE_URL` names where
 * the deployment keeps its data. Skills get their own area beneath it, apart from files: the files
 * API accepts caller-chosen paths, so sharing one would make the platform-owned `skills/` and
 * `skill-meta/` prefixes caller-addressable. The composition root ADR records that separation.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until it is `serving` — no context installed, or `unavailable` — every route answers `503`. It
 * does not answer `401` (nothing checked a session) and it does not answer `200` with an empty list
 * (an unconfigured store reading as "no skills" is a green screen hiding a capability nobody
 * verified). `unavailable` is what `installSkillsApi` leaves behind when the storage root is unset,
 * overlaps the files root, or its bucket was refused or could not be reached; the root logs which.
 */
import type { WorkspaceSkillsStoreProvider } from '../storage/store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import type { StorageService } from '../storage/service';

/** Who the caller is, as far as the skills routes need to know. Mirrors `files/runtime.ts`'s. */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the skills routes need from the rest of the application. */
export interface SkillsRuntime {
  /**
   * Decide which workspace this request acts in (spec §25). Implementations must derive the
   * workspace from the authenticated session, never from a request header, query parameter, path
   * segment or body field the caller controls.
   */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Object storage for skills, keyed by workspace id. */
  store: WorkspaceSkillsStoreProvider;
  catalog?: ResourceCatalogStoreProvider;
  /** The files catalog service; a skill saved as rows is read and deleted through it. */
  storage?: Pick<StorageService, 'list' | 'open' | 'remove' | 'save'>;
}

/** The skills routes as the application context holds them. */
export type Skills =
  { readonly kind: 'serving'; readonly runtime: SkillsRuntime } | { readonly kind: 'unavailable' };
