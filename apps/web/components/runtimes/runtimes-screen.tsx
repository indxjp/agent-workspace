'use client';

import { useMemo, useState } from 'react';

import type { RuntimeNetworkPolicy } from '../../contracts/runtimes';
import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';
import {
  RUNTIME_OPTIONS,
  runtimeProfileDraftFor,
  saveRuntimeProfile,
  testSelectedRuntime,
} from './model';
import { runtimesStrings } from './runtimes-messages';

export type RuntimeScreenEntry = Readonly<{
  id: string;
  label: string;
  connectionExists: boolean;
  imageReachable: boolean;
  testPassed: boolean;
  state: 'enabled' | 'disabled';
  reason: string | null;
  /** The policies the registry reports this runtime can enforce here, or `null` when unrestricted. */
  networkPolicies: readonly RuntimeNetworkPolicy[] | null;
  /** Why the runtime refuses every run here (ADR-0131), when it declares no network policy. */
  refusal?: string;
}>;

type TestState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'running' }>
  | Readonly<{ kind: 'done'; driverId: string; lines: readonly string[] }>
  | Readonly<{ kind: 'error'; message: string }>;

type SaveState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'saving' }>
  | Readonly<{ kind: 'done'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50';

export function RuntimesScreen({
  entries,
  locale = 'en',
}: Readonly<{
  entries: readonly RuntimeScreenEntry[];
  /** The reader's language (UX-15 in #2086); English by default. */
  locale?: VersionsLocale;
}>) {
  const strings = runtimesStrings(locale);
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const visible = RUNTIME_OPTIONS.map((option) => {
    const registered = byId.get(option.id);
    return {
      option,
      entry:
        registered ??
        ({
          id: option.id,
          label: strings.option[option.id].label,
          connectionExists: false,
          imageReachable: false,
          testPassed: false,
          state: 'disabled',
          reason: strings.option[option.id].defaultReason ?? strings.notRegistered,
          networkPolicies: null,
        } satisfies RuntimeScreenEntry),
    };
  });
  const [selected, setSelected] = useState(
    () =>
      visible.find(({ entry }) => entry.connectionExists === true && entry.imageReachable === true)
        ?.option.id ?? 'local',
  );
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const selectedEntry = visible.find(({ option }) => option.id === selected)?.entry;

  const renderChoice = ({ option, entry }: (typeof visible)[number]) => {
    const words = strings.option[option.id];
    return (
      <button
        key={option.id}
        type="button"
        disabled={entry.state === 'disabled'}
        aria-pressed={selected === option.id}
        onClick={() => {
          setSelected(option.id);
          setTestState({ kind: 'idle' });
          setSaveState({ kind: 'idle' });
        }}
        className={`flex w-full items-start gap-3 border-b border-border px-[14px] py-3 text-left last:border-b-0 ${
          selected === option.id ? 'bg-accent-soft' : 'bg-surface'
        } disabled:bg-surface-2`}
      >
        <span
          aria-hidden="true"
          className={`mt-1 size-3.5 flex-none rounded-full border ${
            selected === option.id ? 'border-[4px] border-accent' : 'border-border-strong'
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
            {words.label}
            {!entry.testPassed ? (
              <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn">
                {strings.unverified}
              </span>
            ) : null}
            {entry.refusal === undefined ? null : (
              <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] text-danger">
                {strings.refusesEveryRun}
              </span>
            )}
            {option.id === 'local' ? (
              <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[10px] text-danger">
                {strings.noIsolation}
              </span>
            ) : null}
            {option.id === 'docker' ? (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
                {strings.recommended}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block text-[12px] leading-5 text-muted">
            {entry.state === 'disabled' ? entry.reason : (entry.refusal ?? words.description)}
          </span>
        </span>
        {words.side === undefined ? null : (
          <span className="pt-0.5 text-[11px] whitespace-nowrap text-muted">{words.side}</span>
        )}
      </button>
    );
  };

  return (
    <main lang={locale} className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">{strings.title}</h1>
        <p className="mt-[3px] text-[13px] text-muted">{strings.intro}</p>
      </div>

      <section>
        <div className="mb-3 flex items-end gap-4">
          <h2 className="text-[15px] font-semibold">{strings.runtime}</h2>
          <p className="ml-auto max-w-[560px] text-right text-[12px] text-muted">
            {strings.selectableRule}
          </p>
        </div>
        <div className={CARD}>
          {visible
            .filter(({ option }) => !option.managed && option.id !== 'external')
            .map(renderChoice)}
          <div className="border-b border-border bg-surface px-[14px] py-3">
            <div className="mb-2 text-[13.5px] font-semibold">{strings.managedSandbox}</div>
            <div className="overflow-hidden rounded-(--radius-sm) border border-border">
              {visible.filter(({ option }) => option.managed).map(renderChoice)}
            </div>
          </div>
          {visible.filter(({ option }) => option.id === 'external').map(renderChoice)}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            className={BUTTON}
            disabled={
              selectedEntry?.connectionExists !== true ||
              selectedEntry.imageReachable !== true ||
              testState.kind === 'running'
            }
            onClick={() => {
              setTestState({ kind: 'running' });
              void testSelectedRuntime(browserClient(), fetch, selected)
                .then((result) =>
                  setTestState({
                    kind: 'done',
                    driverId: result.driverId,
                    lines: result.transcript,
                  }),
                )
                .catch((error: unknown) =>
                  setTestState({
                    kind: 'error',
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
            }}
          >
            {testState.kind === 'running' ? strings.testing : strings.testRuntime}
          </button>
          <button
            type="button"
            className={`${BUTTON} border-accent bg-accent text-white`}
            disabled={
              testState.kind !== 'done' ||
              testState.driverId !== selected ||
              saveState.kind === 'saving'
            }
            onClick={() => {
              setSaveState({ kind: 'saving' });
              void saveRuntimeProfile(
                browserClient(),
                runtimeProfileDraftFor(selectedEntry ?? { id: selected, networkPolicies: null }),
              )
                .then((profile) =>
                  setSaveState({ kind: 'done', message: strings.readyToUse(profile.name) }),
                )
                .catch((error: unknown) =>
                  setSaveState({
                    kind: 'error',
                    message: error instanceof Error ? error.message : String(error),
                  }),
                );
            }}
          >
            {saveState.kind === 'saving' ? strings.saving : strings.save}
          </button>
        </div>
        {testState.kind === 'done' ? (
          <pre className="mt-3 overflow-auto rounded-(--radius-sm) bg-surface-2 p-3 text-[12px]">
            {testState.lines.join('\n')}
          </pre>
        ) : null}
        {testState.kind === 'error' ? (
          <p className="mt-3 text-[12px] text-danger">{testState.message}</p>
        ) : null}
        {saveState.kind === 'done' ? (
          <p className="mt-3 text-[12px] text-success">{saveState.message}</p>
        ) : null}
        {saveState.kind === 'error' ? (
          <p className="mt-3 text-[12px] text-danger">{saveState.message}</p>
        ) : null}

        <div className="mt-4 rounded-(--radius) border border-border bg-surface-2 p-[14px] text-[12.5px] text-muted">
          {strings.disabledNoteBefore}
          <b>{strings.disabledNoteBold}</b>
          {strings.disabledNoteAfter}
        </div>
      </section>

      <section className="mt-7">
        <h2 className="mb-3 text-[15px] font-semibold">{strings.switchComparisonHeading}</h2>
        <div className={CARD}>
          <div className="border-b border-border px-4 py-3 text-[13px] font-semibold">
            {strings.switchComparison.heading}
          </div>
          <div className="space-y-1 border-b border-border bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
            {strings.switchComparison.warnings.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
          <div className="space-y-1 bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
            {strings.switchComparison.blockers.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
