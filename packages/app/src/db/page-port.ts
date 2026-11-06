/**
 * The `PageStore` port (issue #1520): a `ResourceStore` of a `definePages` resource, with the tree
 * and the revisions. `pageStoreOf` implements it over PostgreSQL and `memoryPageStoreOf`
 * (`@indx-workspace/app/testing`) in memory; one conformance suite holds both to it. Types only.
 */
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import type { RecordOf } from '../schemas.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import type { Page, ResourceStore, SearchOptions } from './port.js';

/** A page as the page store returns it: the record and the id of its newest revision. */
export type PageRecord<F extends FieldMap = FieldMap> = RecordOf<F> & {
  /** What an update passes back as `expectedRevisionId` to refuse a stale write. */
  readonly revision_id: string;
};

/** One saved state of a page's title and body. */
export interface PageRevision {
  readonly id: string;
  readonly workspace_id: string;
  readonly page_id: string;
  readonly title: string;
  readonly blocks: readonly RichTextBlock[];
  /** Who saved it: the person, also when an agent saved it for them. */
  readonly author_principal_id: string;
  /** The run an agent saved it in; `null` for a save in person. */
  readonly run_id: string | null;
  readonly at: string;
}

/** Where a page moves: under `parent` (`null` for the top), at `position` among its siblings. */
export interface PageMove {
  readonly parent: string | null;
  readonly position: number;
}

/** What a page delete may ask for. */
export interface PageDeleteOptions {
  /** Delete the pages below it too; their revisions are kept. */
  readonly cascade?: boolean;
}

/** What a restore may ask for. */
export interface PageRestoreOptions {
  /** The revision the caller last read; `page_conflict` when the page has moved on. */
  readonly expectedRevisionId?: string;
}

/**
 * The pages of one `definePages` resource. Beyond the `ResourceStore` port:
 *
 * - every create, and every update that changes `title` or `blocks`, writes a revision in the
 *   same transaction, with the person and the agent's run; an update may carry
 *   `expectedRevisionId` in its patch, and is refused `page_conflict` when it is stale;
 * - `parent` and `position` change through {@link PageStore.move}, refused `page_cycle` under the
 *   page itself or below it and `page_space_mismatch` across spaces;
 * - a delete of a page with children is refused `page_has_children` unless `cascade`;
 * - `search` finds the words of the title and the text of the blocks, Japanese ones included.
 */
export interface PageStore<F extends FieldMap = FieldMap> extends ResourceStore<F> {
  get(person: Person, id: string): Promise<PageRecord<F>>;
  create(person: Person, input: unknown): Promise<PageRecord<F>>;
  update(person: Person, id: string, patch: unknown): Promise<PageRecord<F>>;
  delete(person: Person, id: string, options?: PageDeleteOptions): Promise<void>;
  /**
   * The pages directly under `parentId` (`null`: the top), lowest `position` first.
   *
   * shortcut: one answer of at most 500 pages, not cursor-paged; upgrade to a `(position, id)`
   * cursor when a page has more children than that.
   */
  children(person: Person, parentId: string | null): Promise<readonly PageRecord<F>[]>;
  move(person: Person, id: string, move: unknown): Promise<PageRecord<F>>;
  /** The revisions of a page, newest first, cursor-paged. */
  revisions(person: Person, id: string, options?: SearchOptions): Promise<Page<PageRevision>>;
  /** Writes `revisionId`'s title and blocks as the page's newest state and a new revision. */
  restore(
    person: Person,
    id: string,
    revisionId: string,
    options?: PageRestoreOptions,
  ): Promise<PageRecord<F>>;
}
