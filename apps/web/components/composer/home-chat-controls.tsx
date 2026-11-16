'use client';

import { useRef, type ReactNode } from 'react';
import { AttachmentChips } from '@indx-workspace/react';
import {
  offeredBy,
  selectedIn,
  type Badge,
  type ComposerAgent,
  type ComposerSession,
  type PickerKind,
  type PickerOption,
  type RecentSession,
} from './model';
import { composerStrings, type ComposerStrings } from './composer-messages';

export const BTN_SM =
  'inline-flex h-[27px] items-center justify-center gap-[7px] whitespace-nowrap rounded-(--radius-sm) border px-[9px] text-[12.5px] font-medium no-underline';

export const BTN_PRIMARY = 'border-accent bg-accent text-white dark:text-[#10131c]';

export const BTN_DISABLED = 'pointer-events-none opacity-[.45]';

export const BTN_GHOST = 'border-transparent bg-transparent text-text-2';

const SUMMARY =
  'inline-flex h-[27px] cursor-pointer list-none items-center gap-1.5 rounded-[999px] border border-border-strong bg-surface px-2.5 text-[12.5px] whitespace-nowrap text-text-2 [&::-webkit-details-marker]:hidden hover:bg-surface-2 hover:text-text group-open:border-accent group-open:text-accent group-open:hover:border-accent group-open:hover:text-accent';

// On a phone a 330px panel anchored at a picker further right runs off the screen (RF-502's
// journey found it at 390px), so there it spans the screen with a 16px gutter instead.
const PANEL =
  'absolute bottom-[calc(100%+8px)] left-0 z-40 max-h-[340px] w-[330px] overflow-auto rounded-[10px] border border-border bg-surface p-2 shadow-(--shadow-lg) max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:bottom-4 max-sm:w-auto';

export const PHEAD = 'px-2 py-1.5 text-[11.5px] tracking-[.05em] text-muted uppercase';

export const OPT =
  'flex w-full items-start gap-2.5 rounded-(--radius-sm) p-2 text-left text-[13px] hover:bg-surface-2';

export const PFOOT = 'mt-1.5 border-t border-border px-2 pt-2 pb-1 text-[12.5px] text-muted';

const BADGE =
  'inline-flex items-center gap-[5px] rounded-[999px] px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap';

export const SECTION_HEAD = 'mt-[30px] mb-3 flex items-center gap-3';

const ROW =
  'flex items-center gap-3.5 border-b border-border px-4 py-[13px] text-inherit no-underline last:border-b-0';

const BADGE_TONE: Readonly<Record<Badge['tone'], string>> = {
  ok: 'bg-ok-soft text-ok',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-accent-soft text-accent',
  muted: 'bg-surface-3 text-muted',
};

export type OpenPicker = 'agent' | PickerKind | null;

export const PLINK = 'text-accent underline-offset-2 hover:underline';

const CHIP_CLASSES = {
  chip: 'inline-flex h-6 items-center gap-1.5 rounded-[999px] bg-surface-3 px-[9px] text-[12px] text-text-2',
  remove: 'cursor-pointer opacity-55 hover:opacity-100',
} as const;

export function ComposerChips({
  chips,
  onRemove,
  strings = composerStrings('en'),
}: {
  readonly chips: readonly { readonly id: string; readonly name: string }[];
  readonly onRemove: (chipId: string) => void;
  /** The remove button's words; English when not given. */
  readonly strings?: Pick<ComposerStrings, 'remove' | 'removeChip'>;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AttachmentChips
        items={chips}
        removeLabel={strings.removeChip}
        onRemove={onRemove}
        classNames={CHIP_CLASSES}
        removeGlyph="✕"
        removeTitle={strings.remove}
      />
    </div>
  );
}

export function Picker({
  id,
  testId,
  label,
  open,
  setOpen,
  disabled,
  children,
}: {
  readonly id: 'agent' | PickerKind;
  readonly testId?: string;
  readonly label: string;
  readonly open: OpenPicker;
  readonly setOpen: (next: OpenPicker) => void;
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const isOpen = open === id && !disabled;
  const summaryRef = useRef<HTMLElement>(null);
  return (
    <details
      className="group relative inline-block"
      data-picker={id}
      data-testid={testId}
      open={isOpen}
      onKeyDown={(event) => {
        // Esc closes the panel from anywhere inside it and puts focus back on its toggle.
        if (event.key !== 'Escape' || !isOpen) return;
        event.preventDefault();
        setOpen(null);
        summaryRef.current?.focus();
      }}
    >
      <summary
        ref={summaryRef}
        aria-disabled={disabled ? 'true' : undefined}
        className={`${SUMMARY} ${disabled ? 'cursor-not-allowed opacity-[.62]' : ''}`}
        onClick={(event) => {
          event.preventDefault();
          if (disabled) return;
          setOpen(isOpen ? null : id);
        }}
      >
        {label} <span className="text-[9px] opacity-60">▾</span>
      </summary>
      <div className={PANEL}>{children}</div>
    </details>
  );
}

export function NarrowingPicker({
  kind,
  label,
  agent,
  session,
  open,
  setOpen,
  onToggle,
  empty,
  listedNote,
  footer,
  availableHeading,
}: {
  readonly kind: PickerKind;
  readonly label: string;
  readonly agent: ComposerAgent | null;
  readonly session: ComposerSession | null;
  readonly open: OpenPicker;
  readonly setOpen: (next: OpenPicker) => void;
  readonly onToggle: (kind: PickerKind, optionId: string) => void;
  readonly empty: string;
  /** Only shown when options are listed; the empty state explains their absence. */
  readonly listedNote?: string;
  readonly footer: ReactNode;
  readonly availableHeading: string;
}) {
  const options: readonly PickerOption[] = agent === null ? [] : offeredBy(agent, kind);
  const selected = session === null ? [] : selectedIn(session, kind);

  return (
    <Picker id={kind} label={label} open={open} setOpen={setOpen} disabled={agent === null}>
      <div className={PHEAD}>{availableHeading}</div>
      {options.length === 0 ? (
        <p className="px-2 py-1.5 text-[12.5px] text-muted">{empty}</p>
      ) : null}
      {options.map((option) => {
        const on = selected.includes(option.id);
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={on}
            className={`${OPT} ${on ? 'bg-accent-soft' : ''}`}
            onClick={() => onToggle(kind, option.id)}
          >
            <span
              className={`mt-0.5 grid size-4 flex-none place-items-center rounded-[4px] border-[1.5px] text-[11px] leading-none ${
                on
                  ? 'border-accent bg-accent font-bold text-white dark:text-[#10131c]'
                  : 'border-border-strong bg-surface'
              }`}
            >
              {on ? '✓' : ''}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">{option.name}</span>
              <span className="block text-[12px] text-muted">{option.detail}</span>
            </span>
          </button>
        );
      })}
      <div className={PFOOT}>
        {options.length > 0 && listedNote !== undefined ? `${listedNote} ` : null}
        {footer}
      </div>
    </Picker>
  );
}

export function RecentRow({ run }: { readonly run: RecentSession }) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          {run.title}
          {run.titleBadges.map((badge) => (
            <span key={badge.label} className={`${BADGE} ${BADGE_TONE[badge.tone]}`}>
              {badge.label}
            </span>
          ))}
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">{run.meta}</div>
      </div>
      <div className="flex items-center gap-3.5 text-[12.5px] whitespace-nowrap text-muted">
        <span className={`${BADGE} ${BADGE_TONE[run.status.tone]}`}>{run.status.label}</span>
        {run.cost === null ? null : <span>{run.cost}</span>}
      </div>
    </>
  );

  if (run.href === null) return <div className={ROW}>{body}</div>;
  return (
    <a className={`${ROW} hover:bg-surface-2 hover:no-underline`} href={run.href}>
      {body}
    </a>
  );
}
