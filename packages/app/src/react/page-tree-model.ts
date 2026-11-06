/**
 * The page tree's decisions (issue #1521), pure: the rows a tree of lazily loaded levels shows,
 * the keyboard map of the WAI-ARIA tree view pattern, and where a page may move. `PageTree` draws
 * what these decide; the server stays the authority on a move (`409 page_cycle`).
 */

/** What the tree knows of one page. */
export interface PageTreeNode {
  readonly id: string;
  readonly title: string;
  readonly parent: string | null;
}

/**
 * The levels loaded so far: the pages under each parent id (`null` for the top), in order. A
 * parent with no entry has not been loaded yet.
 */
export type PageTreeLevels = ReadonlyMap<string | null, readonly PageTreeNode[]>;

/** One visible row of the tree. */
export interface PageTreeRow {
  readonly node: PageTreeNode;
  /** 1 at the top, as `aria-level`. */
  readonly level: number;
  /** Its place among its siblings from 1, and how many they are: `aria-posinset`, `aria-setsize`. */
  readonly position: number;
  readonly siblings: number;
  /**
   * `true` open, `false` closed, `null` a leaf: a page whose children were loaded and are none. A
   * page not loaded yet may have children, so it reads as closed.
   */
  readonly expanded: boolean | null;
}

/** The rows the tree shows: every loaded page whose ancestors are all open, depth first. */
export function visibleRows(
  levels: PageTreeLevels,
  expanded: ReadonlySet<string>,
): readonly PageTreeRow[] {
  const rows: PageTreeRow[] = [];
  const walk = (parent: string | null, level: number): void => {
    const nodes = levels.get(parent) ?? [];
    nodes.forEach((node, index) => {
      const loaded = levels.get(node.id);
      const leaf = loaded !== undefined && loaded.length === 0;
      const open = !leaf && expanded.has(node.id);
      rows.push({
        node,
        level,
        position: index + 1,
        siblings: nodes.length,
        expanded: leaf ? null : open,
      });
      if (open) walk(node.id, level + 1);
    });
  };
  walk(null, 1);
  return rows;
}

/** What a key on the focused row does. */
export type PageTreeKeyAction =
  | { readonly type: 'focus'; readonly id: string }
  | { readonly type: 'expand'; readonly id: string }
  | { readonly type: 'collapse'; readonly id: string }
  | { readonly type: 'select'; readonly id: string }
  | { readonly type: 'none' };

const NONE: PageTreeKeyAction = { type: 'none' };

/** The keys that move the focus, which bring it to the first row when no row has it. */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']);

function focusAt(rows: readonly PageTreeRow[], index: number): PageTreeKeyAction {
  const row = rows[index];
  return row === undefined ? NONE : { type: 'focus', id: row.node.id };
}

function rightOf(rows: readonly PageTreeRow[], index: number): PageTreeKeyAction {
  const row = rows[index];
  if (row === undefined || row.expanded === null) return NONE;
  if (!row.expanded) return { type: 'expand', id: row.node.id };
  const child = rows[index + 1];
  return child !== undefined && child.level > row.level ? focusAt(rows, index + 1) : NONE;
}

function leftOf(rows: readonly PageTreeRow[], index: number): PageTreeKeyAction {
  const row = rows[index];
  if (row === undefined) return NONE;
  if (row.expanded === true) return { type: 'collapse', id: row.node.id };
  const parent = row.node.parent;
  return parent === null ? NONE : { type: 'focus', id: parent };
}

/**
 * What `key` does on the row of `focusedId`, by the APG tree view pattern: Down and Up move to the
 * next and previous visible row; Right opens a closed page, or moves into an open one; Left
 * closes an open page, or moves to its parent; Home and End move to the first and last row; Enter
 * and Space select the page.
 */
export function treeKeyAction(
  rows: readonly PageTreeRow[],
  focusedId: string | null,
  key: string,
): PageTreeKeyAction {
  const index = rows.findIndex((row) => row.node.id === focusedId);
  const focused = rows[index];
  if (focused === undefined) return NAVIGATION_KEYS.has(key) ? focusAt(rows, 0) : NONE;
  switch (key) {
    case 'ArrowDown':
      return focusAt(rows, index + 1);
    case 'ArrowUp':
      return focusAt(rows, index - 1);
    case 'ArrowRight':
      return rightOf(rows, index);
    case 'ArrowLeft':
      return leftOf(rows, index);
    case 'Home':
      return focusAt(rows, 0);
    case 'End':
      return focusAt(rows, rows.length - 1);
    case 'Enter':
    case ' ':
      return { type: 'select', id: focused.node.id };
    default:
      return NONE;
  }
}

/** Every loaded page by id. */
function nodesById(levels: PageTreeLevels): ReadonlyMap<string, PageTreeNode> {
  return new Map([...levels.values()].flat().map((node) => [node.id, node]));
}

/**
 * Whether moving `id` under `parent` would put it under itself: `parent` is the page or one of the
 * pages below it, as far as the loaded levels tell. The server refuses it `page_cycle` either way.
 */
export function isMoveIntoItself(
  levels: PageTreeLevels,
  id: string,
  parent: string | null,
): boolean {
  const byId = nodesById(levels);
  const seen = new Set<string>();
  for (let at = parent; at !== null && !seen.has(at); at = byId.get(at)?.parent ?? null) {
    if (at === id) return true;
    seen.add(at);
  }
  return false;
}

/** A place a page may move to: under `id` (`null`: the top), drawn `level` deep. */
export interface PageMoveTarget {
  readonly id: string | null;
  readonly title: string;
  readonly level: number;
}

/**
 * Where `id` may move among the loaded pages: the top, then every loaded page depth first, less
 * the page itself and the pages below it.
 */
export function moveTargets(
  levels: PageTreeLevels,
  id: string,
  topTitle: string,
): readonly PageMoveTarget[] {
  const targets: PageMoveTarget[] = [{ id: null, title: topTitle, level: 0 }];
  const walk = (parent: string | null, level: number): void => {
    for (const node of levels.get(parent) ?? []) {
      if (node.id === id) continue;
      targets.push({ id: node.id, title: node.title, level });
      walk(node.id, level + 1);
    }
  };
  walk(null, 1);
  return targets;
}

/** The levels with the pages under `parent` replaced by `nodes`. */
export function withLevel(
  levels: PageTreeLevels,
  parent: string | null,
  nodes: readonly PageTreeNode[],
): PageTreeLevels {
  const next = new Map(levels);
  next.set(parent, nodes);
  return next;
}

/** The position after `positions`: one more than the highest, `0` for the first child. */
export function positionAfter(positions: readonly number[]): number {
  return positions.length === 0 ? 0 : Math.floor(Math.max(...positions)) + 1;
}
