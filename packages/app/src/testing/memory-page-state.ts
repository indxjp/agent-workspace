/**
 * The state behind `memoryPageStoreOf` and the rules that read and change it: pages per workspace,
 * their search text, their kept revisions and the audit rows. The store's operations call into it.
 */
import type { Person } from '../person.js';
import type { FieldMap } from '../resource.js';
import { AppStoreError } from '../db/errors.js';
import { isRevision, pageSearchText, type PageResource } from '../db/page-policy.js';
import type { PageRecord, PageRevision } from '../db/page-port.js';
import {
  isVisible,
  notifyCommitted,
  pageOf,
  readScopeOf,
  recordIdOf,
  type FieldValues,
  type PageRequest,
} from '../db/policy.js';
import type { AuditAction, AuditEvent, CommittedEvent, Page } from '../db/port.js';
import type { RichTextBlock } from '../fields/rich-text.js';
import {
  copyOf,
  isAfter,
  newestFirst,
  type KeyedRow,
  type MemoryStoreOptions,
  type StoreOperation,
} from './memory-store.js';

export type Row = KeyedRow & { readonly revision_id: string };

/** A kept revision, keyed by `(at, id)` for the shared paging. */
export interface RevisionRow {
  readonly id: string;
  readonly created_at: string;
  readonly revision: PageRevision;
}

/** What an audit row says about one record. */
export interface AuditEntry {
  readonly recordId: string;
  readonly action: AuditAction;
  readonly fields: readonly string[];
  readonly at: string;
}

/** The change `save` applies to an existing page. */
export interface PageChange {
  readonly values: FieldValues;
  readonly fields: readonly string[];
  /** Keep a revision even when the title and body are unchanged. */
  readonly revise: boolean;
}

function byPosition(a: Row, b: Row): number {
  const order = Number(a['position']) - Number(b['position']);
  return order !== 0 ? order : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The mutable state of one in-memory page store, with the lookups and writes on it. */
export class MemoryPageState<F extends FieldMap> {
  readonly calls: Record<StoreOperation, number> = {
    list: 0,
    get: 0,
    search: 0,
    create: 0,
    update: 0,
    delete: 0,
  };
  readonly appName: string;
  readonly revisionRows: RevisionRow[] = [];
  readonly searchTexts = new Map<string, string>();
  readonly audit: AuditEvent[] = [];
  private readonly workspaces = new Map<string, Map<string, Row>>();
  private readonly clock: () => Date;

  constructor(
    readonly resource: PageResource,
    private readonly options: MemoryStoreOptions,
  ) {
    this.appName = options.appName ?? 'app';
    this.clock = options.now ?? (() => new Date());
  }

  timestamp(): string {
    return this.clock().toISOString();
  }

  rowsOf(workspaceId: string): Map<string, Row> {
    let rows = this.workspaces.get(workspaceId);
    if (rows === undefined) {
      rows = new Map();
      this.workspaces.set(workspaceId, rows);
    }
    return rows;
  }

  /** The page `id` of the person's workspace, if they may read it. */
  findVisible(person: Person, id: string): Row | undefined {
    const scope = readScopeOf(this.resource, person);
    const key = recordIdOf(id);
    const row = key === undefined ? undefined : this.workspaces.get(person.workspaceId)?.get(key);
    return row !== undefined && isVisible(scope, person, row) ? row : undefined;
  }

  visibleRow(person: Person, id: string): Row {
    const row = this.findVisible(person, id);
    if (row === undefined) throw new AppStoreError('resource_not_found');
    return row;
  }

  /** The parent a write names, which must be a page the person may read. */
  parentRow(person: Person, parent: unknown): Row | null {
    if (typeof parent !== 'string') return null;
    const row = this.findVisible(person, parent);
    if (row === undefined) throw new AppStoreError('invalid_body', { details: ['parent'] });
    return row;
  }

  childrenOf(workspaceId: string, parent: string | null): Row[] {
    return [...this.rowsOf(workspaceId).values()]
      .filter((row) => (row['parent'] ?? null) === parent)
      .sort(byPosition);
  }

  /** `row` and every page above it, nearest first. */
  chainOf(workspaceId: string, row: Row | null): string[] {
    const chain: string[] = [];
    for (let at = row; at !== null && !chain.includes(at.id);) {
      chain.push(at.id);
      const up = at['parent'];
      at = typeof up === 'string' ? (this.rowsOf(workspaceId).get(up) ?? null) : null;
    }
    return chain;
  }

  subtreeOf(workspaceId: string, root: Row): Row[] {
    const found: Row[] = [root];
    for (let index = 0; index < found.length; index += 1) {
      found.push(...this.childrenOf(workspaceId, found[index]?.id ?? ''));
    }
    return found;
  }

  record(row: Row): PageRecord<F> {
    return copyOf(row) as unknown as PageRecord<F>;
  }

  writeAudit(person: Person, entry: AuditEntry): void {
    if (!this.resource.audit) return;
    this.audit.push({
      id: crypto.randomUUID(),
      workspace_id: person.workspaceId,
      actor: person.principalId,
      via: person.via,
      run_id: person.runId ?? null,
      resource: this.resource.name,
      record_id: entry.recordId,
      action: entry.action,
      fields: [...entry.fields],
      at: entry.at,
    });
  }

  /** Records `row`'s title and body as a revision, and indexes them; the revision's id. */
  writeRevision(person: Person, row: KeyedRow, at: string): string {
    const id = crypto.randomUUID();
    const title = String(row['title']);
    const blocks = row['blocks'] as RichTextBlock[];
    const revision: PageRevision = {
      id,
      workspace_id: person.workspaceId,
      page_id: row.id,
      title,
      blocks: copyOf(blocks),
      author_principal_id: person.principalId,
      run_id: person.via === 'agent' ? (person.runId ?? null) : null,
      at,
    };
    this.revisionRows.push({ id, created_at: at, revision });
    this.searchTexts.set(row.id, pageSearchText(title, blocks));
    return id;
  }

  /** The revisions kept of page `pageId` in the person's workspace, as rows. */
  revisionRowsOf(person: Person, pageId: string): RevisionRow[] {
    return this.revisionRows.filter(
      (row) => row.revision.workspace_id === person.workspaceId && row.revision.page_id === pageId,
    );
  }

  async committed(event: CommittedEvent, row: Row, person: Person): Promise<PageRecord<F>> {
    await notifyCommitted(this.options.onCommitted, this.resource.name, event, row, person);
    return this.record(row);
  }

  /** Saves `change` over `existing`: a new revision when the title or body changed, or `revise`. */
  save(person: Person, existing: Row, change: PageChange): Promise<PageRecord<F>> {
    const at = this.timestamp();
    const next: KeyedRow = {
      ...existing,
      ...copyOf(change.values),
      updated_by: person.principalId,
      updated_at: at,
    };
    const revisionId =
      change.revise || isRevision(existing, change.values)
        ? this.writeRevision(person, next, at)
        : existing.revision_id;
    const row: Row = { ...next, revision_id: revisionId };
    this.rowsOf(person.workspaceId).set(row.id, row);
    this.writeAudit(person, { recordId: row.id, action: 'update', fields: change.fields, at });
    return this.committed('updated', row, person);
  }

  /** One page of the visible pages that `keep` accepts, newest first. */
  page(
    person: Person,
    request: PageRequest,
    key: string,
    keep: (row: Row) => boolean,
  ): Page<PageRecord<F>> {
    const scope = readScopeOf(this.resource, person);
    const rows = [...(this.workspaces.get(person.workspaceId)?.values() ?? [])]
      .filter((row) => isVisible(scope, person, row) && keep(row) && isAfter(row, request))
      .sort(newestFirst)
      .slice(0, request.limit + 1);
    const result = pageOf(rows, request, key, person.workspaceId);
    return { items: result.items.map((row) => this.record(row)), nextCursor: result.nextCursor };
  }
}
