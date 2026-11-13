'use client';

/**
 * The Features card on the existing Settings screen (06 J4, ADR-0160 D8, issue #1497): one row per
 * feature with its switch, what it needs and what needs it. An Owner switches a feature off after a
 * confirmation naming what disappears, or back on at once; anyone else sees the card read-only.
 *
 * It reads and writes through the SDK (`aw.workspaces.features.list/set`), never raw `fetch`, and
 * on a saved change asks the router to refresh, so the server-rendered sidebar shows the new set.
 * A refusal is shown as a localised banner chosen by its problem code, never the server's message.
 *
 * Text is `text-text-2` rather than `text-muted`: `muted` on `surface` is 4.29:1 in the light
 * theme, under WCAG AA for text this small, and `text-2` holds above 9:1 in both themes.
 *
 * `FeaturesList` is the stateless part, rendered alone by the component test (this repository has
 * no jsdom, so effects never run there).
 */
import type { FeatureId, WorkspaceFeatures } from '@indx-workspace/contracts/features';
import { ApiProblemError } from '@indx-workspace/sdk';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { browserClient } from '../../lib/browser-client';
import { FeaturesConfirmDialog } from './features-confirm-dialog';
import {
  featureLabelList,
  featuresRefusalText,
  featuresStrings,
  type FeaturesLocale,
  type FeaturesStrings,
} from './features-messages';
import { disabledAfter, rowsFor, type FeatureRow, type FeatureRowReason } from './features-model';

const CARD = 'rounded-(--radius) border border-border bg-surface p-4';

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly features: WorkspaceFeatures };

function reasonText(reason: FeatureRowReason, strings: FeaturesStrings): string {
  switch (reason.kind) {
    case 'not_installed':
      return strings.notInstalled;
    case 'needed_by':
      return strings.blockedNeededBy(featureLabelList(reason.features, strings));
    case 'needs':
      return strings.blockedNeeds(featureLabelList(reason.features, strings));
    default: {
      const unreachable: never = reason;
      throw new Error(`unhandled feature row reason ${JSON.stringify(unreachable)}`);
    }
  }
}

function FeatureSwitch({
  row,
  strings,
  readOnly,
  busy,
  onToggle,
}: {
  readonly row: FeatureRow;
  readonly strings: FeaturesStrings;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onToggle: (row: FeatureRow, opener: HTMLButtonElement) => void;
}) {
  const inert = readOnly || busy || !row.canToggle;
  const reasonId = `feature-${row.id}-reason`;
  // A native button, so Space and Enter activate it. A disabled toggle stays focusable
  // (`aria-disabled`, not `disabled`), so a keyboard or screen reader user reaches it and hears why
  // it cannot change.
  return (
    <button
      type="button"
      role="switch"
      aria-checked={row.enabled}
      aria-disabled={inert ? true : undefined}
      aria-labelledby={`feature-${row.id}-label`}
      aria-describedby={row.reason === null ? undefined : reasonId}
      data-feature={row.id}
      onClick={(event) => {
        if (!inert) onToggle(row, event.currentTarget);
      }}
      className={`inline-flex h-7 min-w-[64px] flex-none items-center justify-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        row.enabled
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-border-strong bg-surface-2 text-text-2'
      } ${inert ? 'cursor-not-allowed opacity-[.6]' : 'cursor-pointer'}`}
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${row.enabled ? 'bg-accent' : 'bg-muted'}`}
      />
      {row.enabled ? strings.on : strings.off}
    </button>
  );
}

/** The rows, the read-only note and the refusal banner. Stateless. */
export function FeaturesList({
  features,
  strings,
  readOnly,
  busy = null,
  banner = null,
  onToggle = () => undefined,
}: {
  readonly features: WorkspaceFeatures;
  readonly strings: FeaturesStrings;
  readonly readOnly: boolean;
  /** The feature a save is in flight for; every toggle is inert meanwhile. */
  readonly busy?: FeatureId | null;
  readonly banner?: string | null;
  readonly onToggle?: (row: FeatureRow, opener: HTMLButtonElement) => void;
}) {
  return (
    <>
      {readOnly ? <p className="mb-3 text-[12.5px] text-text-2">{strings.readOnly}</p> : null}
      <div role="alert" className="empty:hidden">
        {banner === null ? null : (
          <p className="mb-3 rounded-(--radius-sm) border border-danger bg-danger-soft px-3 py-2 text-[13px] text-danger">
            {banner}
          </p>
        )}
      </div>
      <ul aria-label={strings.listLabel} className="divide-y divide-border">
        {rowsFor(features).map((row) => (
          <li key={row.id} data-feature-row={row.id} className="flex items-start gap-3 py-3">
            <div className="min-w-0 flex-1">
              <span id={`feature-${row.id}-label`} className="block text-[13px] font-semibold">
                {strings.labels[row.id]}
              </span>
              {row.needs.length > 0 ? (
                <span className="block text-[12px] text-text-2">
                  {strings.needs(featureLabelList(row.needs, strings))}
                </span>
              ) : null}
              {row.neededBy.length > 0 ? (
                <span className="block text-[12px] text-text-2">
                  {strings.neededBy(featureLabelList(row.neededBy, strings))}
                </span>
              ) : null}
              {row.reason === null ? null : (
                <span id={`feature-${row.id}-reason`} className="block text-[12px] text-text-2">
                  {reasonText(row.reason, strings)}
                </span>
              )}
            </div>
            <FeatureSwitch
              row={row}
              strings={strings}
              readOnly={readOnly}
              busy={busy !== null}
              onToggle={onToggle}
            />
          </li>
        ))}
      </ul>
    </>
  );
}

function problemCode(error: unknown): string {
  return error instanceof ApiProblemError ? error.code : 'request_failed';
}

export function FeaturesCard({
  workspaceId,
  isOwner,
  locale,
}: {
  readonly workspaceId: string;
  readonly isOwner: boolean;
  readonly locale: FeaturesLocale;
}) {
  const strings = featuresStrings(locale);
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [busy, setBusy] = useState<FeatureId | null>(null);
  const [confirming, setConfirming] = useState<FeatureId | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    browserClient()
      .workspaces.features.list(workspaceId, { signal: controller.signal })
      .then(
        (features) => setState({ kind: 'ready', features }),
        () => {
          if (!controller.signal.aborted) setState({ kind: 'failed' });
        },
      );
    return () => controller.abort();
  }, [workspaceId]);

  async function save(id: FeatureId, on: boolean) {
    if (state.kind !== 'ready') return;
    setBusy(id);
    setBanner(null);
    try {
      const features = await browserClient().workspaces.features.set(workspaceId, {
        disabled: disabledAfter(state.features, id, on),
      });
      setState({ kind: 'ready', features });
      setConfirming(null);
      router.refresh();
    } catch (error) {
      setBanner(featuresRefusalText(problemCode(error), strings));
    } finally {
      setBusy(null);
    }
  }

  function onToggle(row: FeatureRow, button: HTMLButtonElement) {
    opener.current = button;
    if (row.enabled) {
      setBanner(null);
      setConfirming(row.id);
    } else {
      void save(row.id, true);
    }
  }

  return (
    <section id="features" className={CARD} aria-labelledby="workspace-features-heading">
      <h2 id="workspace-features-heading" className="mb-1 text-[15px] font-semibold">
        {strings.heading}
      </h2>
      <p className="mb-3 text-[13px] text-text-2">{strings.intro}</p>
      {state.kind === 'loading' ? (
        <p className="text-[13px] text-text-2" role="status">
          {strings.loading}
        </p>
      ) : null}
      {state.kind === 'failed' ? (
        <p className="text-[13px] text-danger" role="alert">
          {strings.loadFailed}
        </p>
      ) : null}
      {state.kind === 'ready' ? (
        <FeaturesList
          features={state.features}
          strings={strings}
          readOnly={!isOwner}
          busy={busy}
          banner={confirming === null ? banner : null}
          onToggle={onToggle}
        />
      ) : null}
      {confirming === null ? null : (
        <FeaturesConfirmDialog
          feature={confirming}
          strings={strings}
          busy={busy !== null}
          failure={banner}
          returnFocusTo={opener}
          onCancel={() => {
            setConfirming(null);
            setBanner(null);
          }}
          onConfirm={() => void save(confirming, false)}
        />
      )}
    </section>
  );
}
