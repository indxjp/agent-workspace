/** Small pieces the run view's sections share: the status badge, unbuilt actions, inline runs. */
import type { Paragraph, RunBadge, UnbuiltAction } from '@indx-workspace/react/run-model';
import type { VersionsLocale } from '../agents/versions-messages';
import { runStatusLabel } from './run-view-messages';
import {
  BADGE,
  BADGE_TONE,
  BTN,
  BTN_DISABLED,
  BTN_GHOST,
  BTN_PRIMARY,
  BTN_SM,
} from './run-view-styles';

/** `.btn`'s own geometry. */
const BTN_MD = 'h-8 px-[13px] text-[13px]';
/** `.btn`'s own colours. */
const BTN_DEFAULT = 'border-border-strong bg-surface text-text';

/** `.badge`, with the mockup's leading `.dot` where the mockup puts one. */
export function StatusBadge({
  badge,
  locale = 'en',
}: {
  readonly badge: RunBadge;
  /** The reader's language; the run view, the Runs list and the detail panel all pass it. */
  readonly locale?: VersionsLocale;
}) {
  return (
    <span lang={locale} className={`${BADGE} ${BADGE_TONE[badge.tone]}`}>
      {badge.dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {runStatusLabel(badge.label, locale)}
    </span>
  );
}

/** The class of an unbuilt action: one size and one colour (see `BTN` in `run-view-styles.ts`). */
function unbuiltButtonClass(action: UnbuiltAction, ghost: boolean, small: boolean): string {
  const size = small ? BTN_SM : BTN_MD;
  const colour = action.primary ? BTN_PRIMARY : ghost ? BTN_GHOST : BTN_DEFAULT;
  return `${BTN} ${size} ${colour} ${BTN_DISABLED}`;
}

/**
 * A control the mockup draws for capability this wave does not ship.
 *
 * The shell answers "the destination is absent" with a disabled navigation entry
 * ([W1-UI-01]) and the composer answers it the same way for its three in-panel links
 * ([W1-UI-02]). An *action* has its own answer already in the design system —
 * `.btn[disabled]` — so that is the one used here: the mockup's label, unchanged, on a button that
 * says plainly it cannot be pressed. See W1-UI-03-an-unbuilt-action-is-a-disabled-button.md.
 */
export function UnbuiltButton({
  action,
  ghost = false,
  small = false,
}: {
  readonly action: UnbuiltAction;
  readonly ghost?: boolean;
  readonly small?: boolean;
}) {
  return (
    <button type="button" disabled className={unbuiltButtonClass(action, ghost, small)}>
      {action.label}
    </button>
  );
}

/**
 * The inline runs of one paragraph.
 *
 * `.mono` is a font change and `<b>` is emphasis; the mockup applies them independently, so the
 * element and the class are chosen independently rather than in one three-way branch.
 */
export function Runs({ paragraph }: { readonly paragraph: Paragraph }) {
  return (
    <>
      {paragraph.map((run, index) => {
        const className = run.mono ? 'font-mono text-[12.5px]' : undefined;
        return run.strong ? (
          <b key={index} className={className}>
            {run.text}
          </b>
        ) : (
          <span key={index} className={className}>
            {run.text}
          </span>
        );
      })}
    </>
  );
}
