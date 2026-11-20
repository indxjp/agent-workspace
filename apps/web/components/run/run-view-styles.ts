/**
 * Class strings the run view transcribes from `ui/assets/app.css`, shared by its parts. See
 * `run-view.tsx` for how the mockup's pixel values map onto them.
 */
import type { BadgeTone } from '@indx-workspace/react/run-model';

/**
 * `.badge`. `StatusBadge` is exported so issue #136's Runs list and detail panel render the
 * same badge rather than a second translation that could drift from this one.
 */
export const BADGE =
  'inline-flex items-center gap-[5px] rounded-[999px] px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap';
/** `.badge.ok`, `.badge.warn`, … Same map as the composer's, because it is the same CSS. */
export const BADGE_TONE: Readonly<Record<BadgeTone, string>> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  muted: 'bg-surface-3 text-muted',
};
/**
 * `.btn`, split into the parts the mockup composes.
 *
 * Size and colour are separate constants because Tailwind resolves two utilities of the same
 * property by their order **in the generated stylesheet**, not by the order they appear in a
 * `className`. A base that carried `bg-surface` and a variant that carried `bg-accent` would not
 * reliably produce a blue button — the first draft of this file produced a white one with white
 * text on it. Every call site therefore picks exactly one size and exactly one colour.
 */
export const BTN =
  'inline-flex items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border font-medium';
/** `.btn.sm`. */
export const BTN_SM = 'h-[27px] px-[9px] text-[12.5px]';
/** `.btn.primary`. The dark-mode foreground is `ui/assets/app.css`'s own `@media` override. */
export const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';
/** `.btn.ghost`. */
export const BTN_GHOST = 'border-transparent bg-transparent text-text-2';
/** `.btn[disabled]`. The design system's own answer for an action that cannot be taken. */
export const BTN_DISABLED = 'pointer-events-none opacity-[.45]';
/** `.card`. */
export const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
/** `.kv`. */
export const KV =
  'm-0 grid grid-cols-1 gap-x-4 gap-y-[11px] text-[13.5px] sm:grid-cols-[150px_minmax(0,1fr)] [&>dd]:min-w-0 [&>dd]:[overflow-wrap:anywhere]';
