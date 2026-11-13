import { describe, expect, it } from 'vitest';

import {
  isMoveIntoItself,
  moveTargets,
  treeKeyAction,
  visibleRows,
  withLevel,
  type PageTreeLevels,
  type PageTreeNode,
} from './page-tree-model.js';

function node(id: string, parent: string | null = null): PageTreeNode {
  return { id, title: id.toUpperCase(), parent };
}

// handbook ─┬─ printers ── jams
//           └─ scanners        (not loaded)
// policies                     (not loaded)
const levels: PageTreeLevels = new Map<string | null, readonly PageTreeNode[]>([
  [null, [node('handbook'), node('policies')]],
  ['handbook', [node('printers', 'handbook'), node('scanners', 'handbook')]],
  ['printers', [node('jams', 'printers')]],
  ['jams', []],
]);

const open = new Set(['handbook', 'printers']);

describe('visibleRows', () => {
  it('flattens the open levels depth first, with levels, places and states', () => {
    expect(
      visibleRows(levels, open).map((row) => [
        row.node.id,
        row.level,
        row.position,
        row.siblings,
        row.expanded,
      ]),
    ).toEqual([
      ['handbook', 1, 1, 2, true],
      ['printers', 2, 1, 2, true],
      ['jams', 3, 1, 1, null],
      ['scanners', 2, 2, 2, false],
      ['policies', 1, 2, 2, false],
    ]);
  });

  it('hides what is under a closed page', () => {
    expect(visibleRows(levels, new Set()).map((row) => row.node.id)).toEqual([
      'handbook',
      'policies',
    ]);
  });
});

describe('treeKeyAction (the APG tree view keyboard map)', () => {
  const rows = visibleRows(levels, open);
  const press = (focused: string | null, key: string): unknown => treeKeyAction(rows, focused, key);

  it('moves down and up through the visible rows, and stops at either end', () => {
    expect(press('handbook', 'ArrowDown')).toEqual({ type: 'focus', id: 'printers' });
    expect(press('jams', 'ArrowDown')).toEqual({ type: 'focus', id: 'scanners' });
    expect(press('policies', 'ArrowDown')).toEqual({ type: 'none' });
    expect(press('scanners', 'ArrowUp')).toEqual({ type: 'focus', id: 'jams' });
    expect(press('handbook', 'ArrowUp')).toEqual({ type: 'none' });
  });

  it('Right opens a closed page, moves into an open one, and does nothing on a leaf', () => {
    expect(press('scanners', 'ArrowRight')).toEqual({ type: 'expand', id: 'scanners' });
    expect(press('handbook', 'ArrowRight')).toEqual({ type: 'focus', id: 'printers' });
    expect(press('jams', 'ArrowRight')).toEqual({ type: 'none' });
  });

  it('Left closes an open page, moves to the parent of a closed one, and stops at the top', () => {
    expect(press('printers', 'ArrowLeft')).toEqual({ type: 'collapse', id: 'printers' });
    expect(press('jams', 'ArrowLeft')).toEqual({ type: 'focus', id: 'printers' });
    expect(press('policies', 'ArrowLeft')).toEqual({ type: 'none' });
  });

  it('Home and End move to the first and last row; Enter and Space select', () => {
    expect(press('jams', 'Home')).toEqual({ type: 'focus', id: 'handbook' });
    expect(press('jams', 'End')).toEqual({ type: 'focus', id: 'policies' });
    expect(press('jams', 'Enter')).toEqual({ type: 'select', id: 'jams' });
    expect(press('jams', ' ')).toEqual({ type: 'select', id: 'jams' });
    expect(press('jams', 'a')).toEqual({ type: 'none' });
  });

  it('brings a navigation key to the first row when no row has the focus, and nothing else', () => {
    expect(press(null, 'ArrowDown')).toEqual({ type: 'focus', id: 'handbook' });
    expect(press('gone', 'End')).toEqual({ type: 'focus', id: 'handbook' });
    expect(press(null, 'Tab')).toEqual({ type: 'none' });
    expect(treeKeyAction([], null, 'ArrowDown')).toEqual({ type: 'none' });
  });
});

describe('moves', () => {
  it('refuses a move onto the page itself or any page below it', () => {
    expect(isMoveIntoItself(levels, 'handbook', 'handbook')).toBe(true);
    expect(isMoveIntoItself(levels, 'handbook', 'printers')).toBe(true);
    expect(isMoveIntoItself(levels, 'handbook', 'jams')).toBe(true);
    expect(isMoveIntoItself(levels, 'printers', 'scanners')).toBe(false);
    expect(isMoveIntoItself(levels, 'jams', null)).toBe(false);
    expect(isMoveIntoItself(levels, 'jams', 'policies')).toBe(false);
  });

  it('offers the top and every loaded page outside the moving one', () => {
    expect(moveTargets(levels, 'printers', 'Top').map((target) => target.id)).toEqual([
      null,
      'handbook',
      'scanners',
      'policies',
    ]);
    expect(moveTargets(levels, 'handbook', 'Top')).toEqual([
      { id: null, title: 'Top', level: 0 },
      { id: 'policies', title: 'POLICIES', level: 1 },
    ]);
  });

  it('replaces one level and leaves the rest', () => {
    const next = withLevel(levels, 'scanners', [node('feeds', 'scanners')]);
    expect(next.get('scanners')?.map((found) => found.id)).toEqual(['feeds']);
    expect(levels.has('scanners')).toBe(false);
    expect(next.get(null)).toBe(levels.get(null));
  });
});
