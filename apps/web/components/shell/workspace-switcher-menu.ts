/**
 * The pure roving-tabindex arithmetic behind the sidebar's workspace switcher menu
 * (`workspace-switcher.tsx`) — issue #120's "operate the whole switcher with the keyboard only
 * and assert focus never leaves the menu unannounced" (the card's verifier attack, item 3).
 *
 * Kept out of the component on purpose, in the idiom this codebase already uses for the same
 * reason `apps/web/components/agents/model.ts` keeps `filterAgentsByName` out of
 * `agents-list.tsx`: this repository's component tests render with `react-dom/server`'s
 * `renderToStaticMarkup`, which never fires a DOM event, so a keyboard rule that lived only inside
 * an `onKeyDown` closure would ship with no test that could fail if it were wrong. A pure function
 * from "current index, key, item count" to "next index" can be driven directly.
 */

/** The keys this menu answers. Anything else is not this function's concern — the caller ignores
 * its own default case and lets the browser do whatever it already does with the key. */
export type MenuKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * The next focused item index for a roving-tabindex menu, or `null` for a key this menu does not
 * move focus for. Wraps at both ends — `ArrowDown` from the last item goes to the first, and
 * `ArrowUp` from the first goes to the last — the same behaviour the WAI-ARIA Menu Button pattern
 * describes, so a screen reader user who over-shoots never lands outside the menu.
 *
 * `count === 0` answers `null` for every key: there is nothing to move focus to, and returning `0`
 * would claim an item exists that does not.
 */
export function nextMenuIndex(current: number, key: MenuKey, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default: {
      const unreachable: never = key;
      throw new Error(`nextMenuIndex: unhandled key ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Positive parse of a keyboard event's `key` into {@link MenuKey}, or `null` — ADR-0015: the
 * four keys this menu moves focus for are named explicitly, everything else is refused by name
 * rather than falling through a comparison that happens to be false. */
export function parseMenuKey(key: string): MenuKey | null {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End' ? key : null;
}

/** Clamp a focus index into `[0, count)`, or `null` when there is nothing to focus. Used once a
 * fetch resolves and the item count changes under an already-open menu, so a stale index from a
 * longer previous list never points past the end of a shorter new one. */
export function clampMenuIndex(index: number, count: number): number | null {
  if (count <= 0) return null;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}
