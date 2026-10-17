/** One difference between two JSON values, at a dotted path (`definition.agent.instructions`). */
export interface Change {
  /** `+` only in the new value, `-` only in the old one, `~` in both with another value. */
  readonly op: '+' | '-' | '~';
  readonly path: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether two JSON values are the same: objects whatever the order of their keys, arrays in
 * order, everything else by `Object.is`.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const rightItems: readonly unknown[] = right;
    return left.every((item: unknown, index) => deepEqual(item, rightItems[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return Object.is(left, right);
}

function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/**
 * The changes that turn `before` into `after`, deepest first where both sides are objects or
 * arrays, in key order (sorted) and index order. A value that is absent on one side is `undefined`
 * there. Equal values give no change.
 */
export function diff(before: unknown, after: unknown, path = ''): readonly Change[] {
  if (deepEqual(before, after)) return [];
  if (before === undefined) return [{ op: '+', path: path === '' ? '(root)' : path }];
  if (after === undefined) return [{ op: '-', path: path === '' ? '(root)' : path }];
  if (Array.isArray(before) && Array.isArray(after)) {
    const left: readonly unknown[] = before;
    const right: readonly unknown[] = after;
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) =>
      diff(left[index], right[index], join(path, String(index))),
    ).flat();
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diff(before[key], after[key], join(path, key)));
  }
  return [{ op: '~', path: path === '' ? '(root)' : path }];
}
