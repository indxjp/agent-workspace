'use client';
/**
 * `PageTree`: the pages of a `definePages` resource as a WAI-ARIA tree (issue #1521). Each level
 * loads when it is opened, through the resource's `children` route. The keyboard map is the APG
 * tree view pattern's (`page-tree-model.ts`): Up, Down, Left, Right, Home and End move and open,
 * Enter and Space select.
 *
 * "New page" creates an untitled page under the selected one (at the top when none is selected),
 * and "Move to…" moves the selected page through a dialog that offers only the places it may go:
 * there is no drag and drop. The server stays the authority on a move (`409 page_cycle`).
 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { PageRecord } from '../db/page-port.js';
import type { DefinedPages } from '../pages/define-pages.js';
import type { FieldMap } from '../resource.js';
import { ResourceProblemError } from './client.js';
import { useAppLocale } from './locale-context.js';
import { appStrings, problemMessage, type AppLocale, type PageStrings } from './locale.js';
import { pageClient, type PageClient } from './page-client.js';
import {
  isMoveIntoItself,
  moveTargets,
  positionAfter,
  treeKeyAction,
  visibleRows,
  withLevel,
  type PageTreeLevels,
  type PageTreeNode,
  type PageTreeRow,
} from './page-tree-model.js';

/** The props of {@link PageTree}. */
export interface PageTreeProps<F extends FieldMap = FieldMap> {
  readonly pages: DefinedPages<F>;
  /** For pages kept in spaces: the space whose pages show, and new pages go in. */
  readonly spaceId?: string | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** Called with the page after it moved. */
  readonly onMove?: ((page: PageRecord<F>) => void) | undefined;
  /** Called with a page "New page" created; it is selected too. */
  readonly onCreate?: ((page: PageRecord<F>) => void) | undefined;
  /** Change it to load the opened levels again, as after a page's title was saved. */
  readonly version?: number | undefined;
  /** The language of the tree's words; the `AppTheme`'s when not given, `en` outside one. */
  readonly locale?: AppLocale | undefined;
  /** The client of the pages' routes; one for the page's own origin when not given. */
  readonly client?: PageClient<F> | undefined;
}

function codeOf(error: unknown): string {
  return error instanceof ResourceProblemError ? error.code : 'other';
}

function nodeOf(page: PageRecord): PageTreeNode {
  return {
    id: page.id,
    title: String(page['title']),
    parent: (page['parent'] as string | null) ?? null,
  };
}

/** The rows of the tree, drawn with a roving tab stop. Exported for the tree's tests. */
export function PageTreeView({
  rows,
  label,
  selectedId,
  focusedId,
  strings,
  itemRef,
  onKeyDown,
  onActivate,
}: {
  readonly rows: readonly PageTreeRow[];
  readonly label: string;
  readonly selectedId: string | null;
  readonly focusedId: string | null;
  readonly strings: PageStrings;
  readonly itemRef?: (id: string, element: HTMLLIElement | null) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLUListElement>) => void;
  /** A click on a row: it selects the page, and opens it when it is closed. */
  readonly onActivate?: (row: PageTreeRow) => void;
}): ReactNode {
  if (rows.length === 0) return <p className="aw-app-empty">{strings.noPages}</p>;
  const tabStop = rows.some((row) => row.node.id === focusedId) ? focusedId : rows[0]?.node.id;
  return (
    <ul role="tree" aria-label={label} className="aw-app-page-tree" onKeyDown={onKeyDown}>
      {rows.map((row) => (
        <li
          key={row.node.id}
          ref={(element) => itemRef?.(row.node.id, element)}
          role="treeitem"
          className="aw-app-page-tree-item"
          aria-level={row.level}
          aria-setsize={row.siblings}
          aria-posinset={row.position}
          aria-expanded={row.expanded ?? undefined}
          aria-selected={row.node.id === selectedId}
          tabIndex={row.node.id === tabStop ? 0 : -1}
          style={{ paddingInlineStart: `${String(row.level - 1)}rem` }}
          onClick={(event) => {
            event.stopPropagation();
            onActivate?.(row);
          }}
        >
          <span className="aw-app-page-tree-toggle" aria-hidden="true">
            {row.expanded === null ? '·' : row.expanded ? '▾' : '▸'}
          </span>
          <span className="aw-app-page-tree-title">{row.node.title || strings.untitled}</span>
        </li>
      ))}
    </ul>
  );
}

/** The "Move to…" dialog's form: where the page may go. Exported for the tree's tests. */
export function PageMoveForm({
  id,
  title,
  levels,
  target,
  problem,
  pending,
  strings,
  cancel,
  onTarget,
  onSubmit,
  onCancel,
}: {
  readonly id: string;
  readonly title: string;
  readonly levels: PageTreeLevels;
  readonly target: string;
  readonly problem: string | null;
  readonly pending: boolean;
  readonly strings: PageStrings;
  readonly cancel: string;
  readonly onTarget: (target: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const formId = useId();
  return (
    <form className="aw-app-page-move" onSubmit={onSubmit} aria-labelledby={`${formId}-heading`}>
      <h2 id={`${formId}-heading`}>{strings.moveHeading(title || strings.untitled)}</h2>
      <div className="aw-app-field">
        <label htmlFor={`${formId}-target`} className="aw-app-label">
          {strings.moveUnder}
        </label>
        <select
          id={`${formId}-target`}
          value={target}
          onChange={(event) => onTarget(event.target.value)}
        >
          {moveTargets(levels, id, strings.topLevel).map((option) => (
            <option key={option.id ?? ''} value={option.id ?? ''}>
              {`${'— '.repeat(option.level)}${option.title || strings.untitled}`}
            </option>
          ))}
        </select>
      </div>
      {problem === null ? null : (
        <p className="aw-app-alert" role="alert">
          {problem}
        </p>
      )}
      <div className="aw-app-actions">
        <button type="submit" className="aw-app-button aw-app-primary" disabled={pending}>
          {strings.move}
        </button>
        <button type="button" className="aw-app-button" onClick={onCancel}>
          {cancel}
        </button>
      </div>
    </form>
  );
}

/** The pages of a page resource, as a tree. */
export function PageTree<F extends FieldMap>(props: PageTreeProps<F>): ReactNode {
  const { pages, spaceId, selectedId, onSelect, onMove, onCreate, version } = props;
  const locale = useAppLocale(props.locale);
  const appText = appStrings(locale);
  const strings = appText.pages;
  const client = useMemo(() => props.client ?? pageClient(pages), [props.client, pages]);
  const [levels, setLevels] = useState<PageTreeLevels>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ readonly id: string; readonly target: string } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  const items = useRef(new Map<string, HTMLLIElement>());
  const dialog = useRef<HTMLDialogElement | null>(null);
  const focusNext = useRef<string | null>(null);

  const load = useCallback(
    async (parent: string | null): Promise<void> => {
      const found = await client.children(parent);
      const nodes = found
        .filter((page) => parent !== null || spaceId === undefined || page['space'] === spaceId)
        .map((page) => nodeOf(page));
      setLevels((current) => withLevel(current, parent, nodes));
    },
    [client, spaceId],
  );
  const fail = useCallback(
    (error: unknown) => setProblem(problemMessage(appText, codeOf(error))),
    [appText],
  );

  // The top on first draw, and every opened level again when `version` changes.
  const opened = useRef<readonly (string | null)[]>([]);
  useEffect(() => {
    opened.current = [...levels.keys()];
  }, [levels]);
  useEffect(() => {
    for (const parent of new Set([null, ...opened.current])) load(parent).catch(fail);
  }, [load, fail, version]);

  useEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    items.current.get(id)?.focus();
  });

  useEffect(() => {
    const element = dialog.current;
    if (element === null) return;
    if (moving !== null && !element.open) element.showModal();
    if (moving === null && element.open) element.close();
  }, [moving]);

  const rows = visibleRows(levels, expanded);
  const focus = (id: string): void => {
    focusNext.current = id;
    setFocusedId(id);
  };
  const toggle = (row: PageTreeRow, open = row.expanded !== true): void => {
    if (row.expanded === null) return;
    setExpanded((current) => {
      const next = new Set(current);
      if (open) next.add(row.node.id);
      else next.delete(row.node.id);
      return next;
    });
    if (open && !levels.has(row.node.id)) load(row.node.id).catch(fail);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const action = treeKeyAction(rows, focusedId ?? rows[0]?.node.id ?? null, event.key);
    if (action.type === 'none') return;
    event.preventDefault();
    const row = rows.find((candidate) => candidate.node.id === action.id);
    if (action.type === 'focus') focus(action.id);
    else if (action.type === 'select') onSelect(action.id);
    else if (row !== undefined) toggle(row, action.type === 'expand');
  };

  const onNewPage = (): void => {
    setProblem(null);
    const parent = selectedId;
    client
      .create({
        title: strings.untitled,
        blocks: [],
        parent,
        ...(spaceId === undefined ? {} : { space: spaceId }),
      })
      .then(async (created) => {
        await load(parent);
        if (parent !== null) setExpanded((current) => new Set([...current, parent]));
        onCreate?.(created);
        onSelect(created.id);
        focus(created.id);
      })
      .catch(fail);
  };

  const onMoveSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (moving === null) return;
    const parent = moving.target === '' ? null : moving.target;
    if (isMoveIntoItself(levels, moving.id, parent)) {
      setProblem(strings.moveIntoItself);
      return;
    }
    const from = rows.find((row) => row.node.id === moving.id)?.node.parent ?? null;
    setPending(true);
    setProblem(null);
    client
      .children(parent)
      .then((siblings) =>
        client.move(moving.id, {
          parent,
          position: positionAfter(
            siblings
              .filter((page) => page.id !== moving.id)
              .map((page) => Number(page['position'])),
          ),
        }),
      )
      .then(async (moved) => {
        await Promise.all([load(from), load(parent)]);
        if (parent !== null) setExpanded((current) => new Set([...current, parent]));
        setMoving(null);
        onMove?.(moved);
        focus(moved.id);
      })
      .catch(fail)
      .finally(() => setPending(false));
  };

  const selected = rows.find((row) => row.node.id === selectedId)?.node;
  const mayCreate = !pages.space || spaceId !== undefined;
  return (
    <nav className="aw-app-page-tree-nav" aria-label={strings.treeLabel}>
      <div className="aw-app-actions">
        <button type="button" className="aw-app-button" onClick={onNewPage} disabled={!mayCreate}>
          {strings.newPage}
        </button>
        <button
          type="button"
          className="aw-app-button"
          disabled={selected === undefined}
          onClick={() => {
            if (selected === undefined) return;
            setProblem(null);
            setMoving({ id: selected.id, target: selected.parent ?? '' });
          }}
        >
          {strings.moveTo}
        </button>
      </div>
      {problem === null || moving !== null ? null : (
        <p className="aw-app-alert" role="alert">
          {problem}
        </p>
      )}
      <PageTreeView
        rows={rows}
        label={strings.treeLabel}
        selectedId={selectedId}
        focusedId={focusedId}
        strings={strings}
        itemRef={(id, element) => {
          if (element === null) items.current.delete(id);
          else items.current.set(id, element);
        }}
        onKeyDown={onKeyDown}
        onActivate={(row) => {
          setFocusedId(row.node.id);
          onSelect(row.node.id);
          if (row.expanded === false) toggle(row, true);
        }}
      />
      <dialog ref={dialog} className="aw-app-dialog" onClose={() => setMoving(null)}>
        {moving === null ? null : (
          <PageMoveForm
            id={moving.id}
            title={rows.find((row) => row.node.id === moving.id)?.node.title ?? ''}
            levels={levels}
            target={moving.target}
            problem={problem}
            pending={pending}
            strings={strings}
            cancel={appText.cancel}
            onTarget={(target) => setMoving({ ...moving, target })}
            onSubmit={onMoveSubmit}
            onCancel={() => setMoving(null)}
          />
        )}
      </dialog>
    </nav>
  );
}
