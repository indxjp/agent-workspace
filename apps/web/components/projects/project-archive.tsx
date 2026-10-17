'use client';

/**
 * The project lifecycle control and its confirmation — issue #184.
 *
 * Everything here is presentational: the section renders what its props say and calls back, and it
 * holds no fetch, no capability decision and no async state of its own. That is not a style
 * preference. `apps/web/vitest.config.mjs` enables JSX and nothing else — this repository has no
 * jsdom and no Testing Library, so a component test is `renderToStaticMarkup` over one render, and
 * **an async state is only assertable if it is a prop**. `ArchiveDialogState` (`./model.ts`) is
 * therefore the whole of the dialog's state machine, and `project-archive.test.tsx` renders each of
 * its members directly.
 *
 * ## Why not `window.confirm`
 *
 * `./project-form.tsx`'s `confirmDiscard` is the existing confirmation in these screens and is
 * right for what it does — a yes/no over a fact the person can already see. This one has to carry
 * an impact summary that is still loading when the dialog opens, so it cannot be a string argument
 * to a blocking browser primitive, and a browser primitive cannot be asserted by any test this
 * repository can run.
 *
 * ## Why the focus handling is written out by hand
 *
 * There is no dialog primitive here. `../shares/share-dialog.tsx` established `role="dialog"` +
 * `aria-modal="true"` and this follows it, but it does not trap focus or restore it, and issue
 * #184 requires keyboard operation. So this one moves focus to Cancel on open, takes it back when a
 * submission ends with the panel still open, restores it to the trigger on close, closes on Escape,
 * and cycles Tab within the panel. `tests/browser/` holds the accessibility assertions that keep
 * those honest; a static-markup test cannot see focus.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';

import {
  canArchiveProject,
  isProjectArchived,
  summariseArchiveImpact,
  type ArchiveDialogState,
  type ProjectArchiveCapability,
  type ProjectResource,
} from './model';
import { BTN, BTN_DEFAULT, BTN_DISABLED, BTN_PRIMARY, ProjectProblem } from './project-form';

const DANGER_BTN = 'border-danger bg-surface text-danger';

/** Which transition a confirmation is for. Restore is not destructive and needs no impact count. */
type LifecycleTransition = 'archive' | 'restore';

interface LifecycleSectionProps {
  readonly project: ProjectResource;
  readonly capability: ProjectArchiveCapability;
  /** `null` while the confirmation is closed — the dialog is not mounted at all. */
  readonly dialog: ArchiveDialogState | null;
  readonly onOpen: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * The archive/restore control, or **nothing at all** for a caller who may not use it.
 *
 * "Refused users see no actionable control" is an acceptance criterion of #184, and the honest
 * rendering of a refusal this UI cannot explain is absence: `POST /api/projects/:id/archive`
 * conceals its own 403 as a 404 (issue #183), so a disabled button with a tooltip would have to
 * invent a reason the server deliberately does not give.
 */
export function ProjectLifecycleSection({
  project,
  capability,
  dialog,
  onOpen,
  onCancel,
  onConfirm,
}: Readonly<LifecycleSectionProps>) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  if (!canArchiveProject(capability, project)) return null;

  const archived = isProjectArchived(project);
  const transition: LifecycleTransition = archived ? 'restore' : 'archive';

  return (
    <section
      className="mt-4 rounded-(--radius) border border-border bg-surface p-4"
      aria-labelledby="project-lifecycle-heading"
    >
      <h2 id="project-lifecycle-heading" className="mb-1 text-[15px] font-semibold">
        Project lifecycle
      </h2>
      <p className="mb-3 text-[12.5px] text-muted">
        {archived
          ? 'This project is archived. Restoring it lets new sessions and runs start in it again.'
          : 'Archiving keeps every completed session and run readable, and stops new ones from starting in this project.'}
      </p>
      <button
        ref={triggerRef}
        type="button"
        className={`${BTN} ${archived ? BTN_DEFAULT : DANGER_BTN}`}
        onClick={onOpen}
      >
        {archived ? 'Restore project' : 'Archive project'}
      </button>
      {dialog === null ? null : (
        <ProjectArchiveDialog
          project={project}
          transition={transition}
          state={dialog}
          returnFocusTo={triggerRef}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </section>
  );
}

interface DialogProps {
  readonly project: ProjectResource;
  readonly transition: LifecycleTransition;
  readonly state: ArchiveDialogState;
  /** Focus goes back here when the dialog closes. Absent in a test that renders the dialog alone. */
  readonly returnFocusTo?: { current: HTMLButtonElement | null };
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/**
 * The confirmation panel. Exported so a test can render one state at a time; the screen itself
 * reaches it through {@link ProjectLifecycleSection}.
 */
export function ProjectArchiveDialog({
  project,
  transition,
  state,
  returnFocusTo,
  onCancel,
  onConfirm,
}: Readonly<DialogProps>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Cancel is the initially focused control, not Confirm: the safe answer is the one a stray Enter
  // should land on.
  useEffect(() => {
    cancelRef.current?.focus();
    const trigger = returnFocusTo?.current ?? null;
    return () => trigger?.focus();
  }, [returnFocusTo]);

  // A control the browser disables is also blurred, so `submitting` leaves focus on <body> —
  // outside the element `onKeyDown` is bound to. The success path hides that (the dialog unmounts
  // and the effect above restores focus to the trigger), but the `failed` path keeps the panel open
  // with Escape and the Tab cycle dead, so focus is claimed back the moment the transition stops
  // being in flight. Only on that transition: refocusing on every state change would yank focus off
  // Confirm while the counts are still arriving.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (wasSubmitting.current && state.kind !== 'submitting') cancelRef.current?.focus();
    wasSubmitting.current = state.kind === 'submitting';
  }, [state.kind]);

  const busy = state.kind === 'submitting';
  const archiving = transition === 'archive';
  const titleId = 'project-lifecycle-dialog-title';

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable =
      panelRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    if (focusable === undefined || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) return;
    // Tab must not leave the panel while it is modal; the page behind it is inert to the mouse
    // already, and a keyboard that walked off it would be the same bug one input later.
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div
        ref={panelRef}
        className="w-full max-w-[520px] rounded-(--radius) border border-border bg-surface p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-[18px]">
          {archiving ? 'Archive' : 'Restore'} “{project.name}”?
        </h2>
        {archiving ? (
          <ArchiveImpact state={state} />
        ) : (
          <p className="mt-3 text-[13px] text-text-2">
            New sessions and runs will be able to start in this project again. Nothing that already
            ran changes.
          </p>
        )}
        {state.kind === 'failed' ? <ProjectProblem problem={state.problem} /> : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            className={`${BTN} ${BTN_DEFAULT} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${BTN} ${archiving ? DANGER_BTN : BTN_PRIMARY} ${busy ? BTN_DISABLED : ''}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy
              ? archiving
                ? 'Archiving…'
                : 'Restoring…'
              : archiving
                ? 'Archive project'
                : 'Restore project'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The impact summary, in each of the states the two count reads can be in.
 *
 * `count-unavailable` still allows the archive. Refusing would make an unrelated list endpoint's
 * failure block a lifecycle transition the server would accept; saying "0 sessions and 0 runs"
 * would be a number nothing established. Saying so is the third option and the honest one.
 */
function ArchiveImpact({ state }: Readonly<{ state: ArchiveDialogState }>) {
  switch (state.kind) {
    case 'counting':
      return (
        <p className="mt-3 text-[13px] text-muted" role="status">
          Counting the sessions and runs this affects…
        </p>
      );
    case 'counted':
      return <p className="mt-3 text-[13px] text-text-2">{summariseArchiveImpact(state.impact)}</p>;
    case 'count-unavailable':
      return (
        <p className="mt-3 text-[13px] text-text-2">
          The sessions and runs this affects could not be counted, so this summary is incomplete.
          Archiving still keeps completed work readable and stops new work from starting.
        </p>
      );
    case 'confirming':
    case 'submitting':
    case 'failed':
      return (
        <p className="mt-3 text-[13px] text-text-2">
          Completed sessions and runs stay readable. No new sessions or runs can start in this
          project.
        </p>
      );
    default: {
      const unreachable: never = state;
      throw new Error(`unhandled archive dialog state ${JSON.stringify(unreachable)}`);
    }
  }
}
