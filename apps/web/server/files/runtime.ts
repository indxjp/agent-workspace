/**
 * The seam between the files routes and the two things this task does not own: who the caller is
 * (`apps/web/server/auth/**`, W1-CP-06) and, later, an authorisation decision beyond "is there a
 * session" (W2-CP-06's RBAC layer).
 *
 * The composition root's `installFilesApi` builds it, and the root installs it as
 * `ApplicationContext.files` when `AW_STORAGE_URL` names where files are kept.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * Until it is `serving` — no context installed, or `unavailable` — every route answers `503`. It
 * does not answer `401` (nothing checked a session) and it does not answer `200` with an empty tree
 * (an unconfigured store reading as "no files" is a green screen hiding a capability nobody
 * verified). `unavailable` is what `installFilesApi` leaves behind when the storage root is unset,
 * or its bucket was refused or could not be reached; the root logs which.
 */
import type { FileTextStoreProvider, WorkspaceObjectStoreProvider } from './store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import type { StorageService } from '../storage/service';

/** Who the caller is, as far as the files routes need to know. Mirrors `agents/runtime.ts`'s. */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the files routes need from the rest of the application. */
export interface FilesRuntime {
  /**
   * Decide which workspace this request acts in (spec §25). Implementations must derive the
   * workspace from the authenticated session, never from a request header, query parameter, path
   * segment or body field the caller controls.
   */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Object storage, keyed by workspace id. */
  store: WorkspaceObjectStoreProvider;
  catalog?: ResourceCatalogStoreProvider;
  /** The cache of extracted text behind `GET /api/files/search`; absent answers that route 503. */
  texts?: FileTextStoreProvider;
  /** `AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES`; absent means the contract's hard maximum. */
  signedUploadMaxBytes?: number;
  /** The catalog service (the storage design, §04); every files route reads and writes through it; a runtime without it answers `503 files_runtime_not_configured`. */
  storage?: StorageService;
}

/** The files routes as the application context holds them. */
export type Files =
  { readonly kind: 'serving'; readonly runtime: FilesRuntime } | { readonly kind: 'unavailable' };
