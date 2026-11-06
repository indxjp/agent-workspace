/**
 * A minimal line diff for the plan-first commands that show a file change before writing it
 * (`aw eval add-case`, `aw blueprint diff`): the lines between the common head and tail of the two
 * texts, as `-` and `+` lines. An empty text has no lines.
 */
export function lineDiff(label: string, before: string, after: string): string {
  const a = before === '' ? [] : before.trimEnd().split('\n');
  const b = after === '' ? [] : after.trimEnd().split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  return [
    `--- ${label}`,
    `+++ ${label}`,
    ...a.slice(head, a.length - tail).map((line) => `-${line}`),
    ...b.slice(head, b.length - tail).map((line) => `+${line}`),
  ].join('\n');
}
