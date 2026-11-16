'use client';

/**
 * The agent screen's Schedules tab (UX-18 in #2086): the schedule triggers that start this agent,
 * when each runs next, pause, resume and delete, and a form that adds one. A view over the trigger
 * routes of ADR-0144 through the SDK client; the server decides who may change what, and a refusal
 * is shown in plain words. A list, not a table, so a phone shows every action without scrolling
 * sideways.
 */
import type { TriggerResource } from '@indx-workspace/contracts/triggers';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { browserClient } from '../../lib/browser-client';

import { BTN, BTN_DEFAULT, BTN_PRIMARY, CONTROL, FIELD, HELP, LABEL } from './agent-form-styles';
import { scheduleRefusalText, schedulesStrings, type SchedulesStrings } from './schedules-messages';
import {
  SCHEDULE_PRESETS,
  agentSchedules,
  browserTimeZone,
  formatRunTime,
  nextRun,
  presetCron,
  presetOf,
  problemCode,
  scheduleProblem,
  type SchedulePresetId,
} from './schedules-model';
import type { VersionsLocale } from './versions-messages';

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'not-allowed' }
  | { readonly kind: 'ready'; readonly schedules: readonly TriggerResource[] };

/** The words for how often `cron` repeats: a preset's label, else the expression itself. */
function repeatsText(cron: string | null, strings: SchedulesStrings): string {
  const preset = SCHEDULE_PRESETS.find((choice) => choice.cron === cron);
  return preset === undefined ? (cron ?? '') : strings.presets[preset.id];
}

/** How often and in which zone: the repeat choice, a custom cron expression and the time zone. */
function ScheduleTimeFields({
  idPrefix,
  strings,
  preset,
  custom,
  timezone,
  invalid,
  onPreset,
  onCustom,
  onTimezone,
}: Readonly<{
  idPrefix: string;
  strings: SchedulesStrings;
  preset: SchedulePresetId;
  custom: string;
  timezone: string;
  invalid: boolean;
  onPreset: (preset: SchedulePresetId) => void;
  onCustom: (cron: string) => void;
  onTimezone: (timezone: string) => void;
}>) {
  return (
    <>
      <div className={FIELD}>
        <label htmlFor={`${idPrefix}-repeat`} className={LABEL}>
          {strings.repeatLabel}
        </label>
        <select
          id={`${idPrefix}-repeat`}
          className={CONTROL}
          value={preset}
          onChange={(event) => {
            onPreset(event.target.value as SchedulePresetId);
          }}
        >
          {SCHEDULE_PRESETS.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {strings.presets[choice.id]}
            </option>
          ))}
          <option value="custom">{strings.presets.custom}</option>
        </select>
      </div>
      {preset === 'custom' ? (
        <div className={FIELD}>
          <label htmlFor={`${idPrefix}-cron`} className={LABEL}>
            {strings.cronLabel}
          </label>
          <input
            id={`${idPrefix}-cron`}
            className={`${CONTROL} font-mono`}
            value={custom}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${idPrefix}-cron-help`}
            aria-invalid={invalid}
            onChange={(event) => {
              onCustom(event.target.value);
            }}
          />
          <p id={`${idPrefix}-cron-help`} className={HELP}>
            {strings.cronHint}
          </p>
        </div>
      ) : null}
      <div className={FIELD}>
        <label htmlFor={`${idPrefix}-zone`} className={LABEL}>
          {strings.timezoneLabel}
        </label>
        <input
          id={`${idPrefix}-zone`}
          className={CONTROL}
          value={timezone}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${idPrefix}-zone-help`}
          onChange={(event) => {
            onTimezone(event.target.value);
          }}
        />
        <p id={`${idPrefix}-zone-help`} className={HELP}>
          {strings.timezoneHint}
        </p>
      </div>
    </>
  );
}

/** Re-time one schedule in place (ADR-0144 D5): its counting restarts, so nothing is owed for the old time. */
function ChangeTimeForm({
  schedule,
  strings,
  locale,
  onDone,
  onCancel,
}: Readonly<{
  schedule: TriggerResource & { readonly cron: string; readonly timezone: string };
  strings: SchedulesStrings;
  locale: VersionsLocale;
  onDone: (message: string) => void;
  onCancel: () => void;
}>) {
  const id = useId();
  const [preset, setPreset] = useState<SchedulePresetId>(() => presetOf(schedule.cron));
  const [custom, setCustom] = useState(schedule.cron);
  const [timezone, setTimezone] = useState(schedule.timezone);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  // Opened inline under the schedule, so on a phone it may start below the screen: its first field
  // takes the focus, which also brings it into view.
  useEffect(() => {
    form.current?.querySelector('select')?.focus();
  }, []);

  const cron = presetCron(preset, custom);
  const zone = timezone.trim();
  const problem = cron === '' ? null : scheduleProblem(cron, zone);
  const next = problem === null && cron !== '' ? nextRun(cron, zone, new Date()) : null;
  const nextLabel = next === null ? null : formatRunTime(next, zone, locale);
  const changed = cron !== schedule.cron || zone !== schedule.timezone;
  const ready = cron !== '' && problem === null && changed;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setFailure(null);
    try {
      await browserClient().triggers.update(schedule.id, { cron, timezone: zone });
      onDone(strings.timeChanged(schedule.name));
    } catch (error) {
      setFailure(scheduleRefusalText(problemCode(error), strings));
      setSaving(false);
    }
  }

  return (
    <form
      ref={form}
      aria-label={strings.changeTime(schedule.name)}
      className="max-w-[620px] rounded-(--radius) border border-border bg-surface-2 p-3"
      onSubmit={(event) => {
        void submit(event);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
    >
      <ScheduleTimeFields
        idPrefix={id}
        strings={strings}
        preset={preset}
        custom={custom}
        timezone={timezone}
        invalid={problem !== null}
        onPreset={setPreset}
        onCustom={setCustom}
        onTimezone={setTimezone}
      />
      <p aria-live="polite" className="mb-3 text-[13px]">
        {problem !== null ? (
          <span className="text-danger">{strings.problems[problem]}</span>
        ) : nextLabel !== null && changed ? (
          strings.nextAfterChange(nextLabel)
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={`${BTN} ${BTN_PRIMARY}`} disabled={!ready || saving}>
          {saving ? strings.working : strings.saveTime}
        </button>
        <button
          type="button"
          className={`${BTN} ${BTN_DEFAULT}`}
          disabled={saving}
          onClick={onCancel}
        >
          {strings.cancel}
        </button>
      </div>
      {failure === null ? null : (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {failure}
        </p>
      )}
    </form>
  );
}

function ScheduleRow({
  schedule,
  strings,
  locale,
  onChanged,
}: Readonly<{
  schedule: TriggerResource;
  strings: SchedulesStrings;
  locale: VersionsLocale;
  onChanged: (message: string | null) => void;
}>) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const changeButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  // Closing the inline form or the delete question unmounts what had the focus; it goes back to
  // the button that opened it, so a keyboard user keeps their place.
  const [refocus, setRefocus] = useState<'change' | 'remove' | null>(null);
  useEffect(() => {
    if (editing || confirming || refocus === null) return;
    (refocus === 'change' ? changeButton : removeButton).current?.focus();
    setRefocus(null);
  }, [editing, confirming, refocus]);

  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);

  const next =
    schedule.enabled && schedule.cron !== null && schedule.timezone !== null
      ? nextRun(schedule.cron, schedule.timezone, new Date())
      : null;
  const nextText = !schedule.enabled
    ? strings.paused
    : next === null || schedule.timezone === null
      ? strings.never
      : (formatRunTime(next, schedule.timezone, locale) ?? next.toISOString());

  async function act(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      onChanged(null);
    } catch (error) {
      setFailure(scheduleRefusalText(problemCode(error), strings));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="space-y-2 border-b border-border px-1 py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-[13px] font-semibold">{schedule.name}</span>
        <span
          className={
            schedule.enabled
              ? 'rounded-full bg-accent-soft px-2 text-[12px]'
              : 'rounded-full bg-surface-2 px-2 text-[12px] text-muted'
          }
        >
          {schedule.enabled ? strings.on : strings.off}
        </span>
      </div>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[13px]">
        <dt className="text-muted">{strings.columnRepeats}</dt>
        <dd className="min-w-0 break-words">{repeatsText(schedule.cron, strings)}</dd>
        <dt className="text-muted">{strings.columnNext}</dt>
        <dd className="min-w-0 break-words">{nextText}</dd>
        <dt className="text-muted">{strings.promptLabel}</dt>
        <dd className="min-w-0 break-words whitespace-pre-wrap">{schedule.prompt}</dd>
      </dl>
      {editing && schedule.cron !== null && schedule.timezone !== null ? (
        <ChangeTimeForm
          schedule={{ ...schedule, cron: schedule.cron, timezone: schedule.timezone }}
          strings={strings}
          locale={locale}
          onDone={(message) => {
            setEditing(false);
            setRefocus('change');
            onChanged(message);
          }}
          onCancel={() => {
            setEditing(false);
            setRefocus('change');
          }}
        />
      ) : confirming ? (
        <div
          key="confirm"
          role="group"
          aria-label={strings.remove(schedule.name)}
          className="flex flex-wrap items-center gap-2 text-[13px]"
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            setConfirming(false);
            setRefocus('remove');
          }}
        >
          <span>{strings.confirmRemove(schedule.name)}</span>
          <button
            type="button"
            className={`${BTN} border-danger bg-danger text-white`}
            disabled={busy}
            onClick={() => {
              void act(() => browserClient().triggers.remove(schedule.id));
            }}
          >
            {strings.confirmYes}
          </button>
          <button
            ref={keepButton}
            type="button"
            className={`${BTN} ${BTN_DEFAULT}`}
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setRefocus('remove');
            }}
          >
            {strings.confirmNo}
          </button>
        </div>
      ) : (
        // Keyed apart from the question above, so React never turns one of its buttons into one of
        // these and the focus lands where `refocus` says, not where a reused node happens to be.
        <div key="actions" className="flex flex-wrap gap-2">
          <button
            type="button"
            className={`${BTN} ${BTN_DEFAULT}`}
            disabled={busy}
            aria-label={
              schedule.enabled ? strings.pause(schedule.name) : strings.resume(schedule.name)
            }
            onClick={() => {
              void act(() =>
                browserClient().triggers.update(schedule.id, { enabled: !schedule.enabled }),
              );
            }}
          >
            {busy ? strings.working : schedule.enabled ? strings.pauseButton : strings.resumeButton}
          </button>
          <button
            ref={changeButton}
            type="button"
            className={`${BTN} ${BTN_DEFAULT}`}
            disabled={busy}
            aria-label={strings.changeTime(schedule.name)}
            onClick={() => {
              setEditing(true);
            }}
          >
            {strings.changeTimeButton}
          </button>
          <button
            ref={removeButton}
            type="button"
            className={`${BTN} ${BTN_DEFAULT}`}
            disabled={busy}
            aria-label={strings.remove(schedule.name)}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {strings.confirmYes}
          </button>
        </div>
      )}
      {failure === null ? null : (
        <p role="alert" className="text-[13px] text-danger">
          {failure}
        </p>
      )}
    </li>
  );
}

function AddScheduleForm({
  agentId,
  strings,
  locale,
  onAdded,
}: Readonly<{
  agentId: string;
  strings: SchedulesStrings;
  locale: VersionsLocale;
  onAdded: (message: string) => void;
}>) {
  const id = useId();
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [preset, setPreset] = useState<SchedulePresetId>('daily');
  const [custom, setCustom] = useState('');
  const [timezone, setTimezone] = useState(browserTimeZone);
  const [adding, setAdding] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const cron = presetCron(preset, custom);
  const problem = cron === '' ? null : scheduleProblem(cron, timezone.trim());
  const first = problem === null && cron !== '' ? nextRun(cron, timezone.trim(), new Date()) : null;
  const firstLabel = first === null ? null : formatRunTime(first, timezone.trim(), locale);
  const ready = name.trim() !== '' && prompt.trim() !== '' && cron !== '' && problem === null;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!ready || adding) return;
    setAdding(true);
    setFailure(null);
    try {
      await browserClient().triggers.create({
        kind: 'schedule',
        name: name.trim(),
        agentId,
        prompt,
        cron,
        timezone: timezone.trim(),
      });
      onAdded(strings.added(name.trim()));
      setName('');
      setPrompt('');
    } catch (error) {
      setFailure(scheduleRefusalText(problemCode(error), strings));
    } finally {
      setAdding(false);
    }
  }

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className="max-w-[620px] rounded-(--radius) border border-border bg-surface p-4"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <h2 id={`${id}-heading`} className="mb-3 text-[15px] font-semibold">
        {strings.addHeading}
      </h2>
      <div className={FIELD}>
        <label htmlFor={`${id}-name`} className={LABEL}>
          {strings.nameLabel}
        </label>
        <input
          id={`${id}-name`}
          className={CONTROL}
          value={name}
          autoComplete="off"
          aria-describedby={`${id}-name-help`}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <p id={`${id}-name-help`} className={HELP}>
          {strings.nameHint}
        </p>
      </div>
      <div className={FIELD}>
        <label htmlFor={`${id}-prompt`} className={LABEL}>
          {strings.promptLabel}
        </label>
        <textarea
          id={`${id}-prompt`}
          className={CONTROL}
          rows={3}
          value={prompt}
          aria-describedby={`${id}-prompt-help`}
          onChange={(event) => {
            setPrompt(event.target.value);
          }}
        />
        <p id={`${id}-prompt-help`} className={HELP}>
          {strings.promptHint}
        </p>
      </div>
      <ScheduleTimeFields
        idPrefix={id}
        strings={strings}
        preset={preset}
        custom={custom}
        timezone={timezone}
        invalid={problem !== null}
        onPreset={setPreset}
        onCustom={setCustom}
        onTimezone={setTimezone}
      />
      <p aria-live="polite" className="mb-3 text-[13px]">
        {problem !== null ? (
          <span className="text-danger">{strings.problems[problem]}</span>
        ) : firstLabel !== null ? (
          strings.nextPreview(firstLabel)
        ) : null}
      </p>
      <button type="submit" className={`${BTN} ${BTN_PRIMARY}`} disabled={!ready || adding}>
        {adding ? strings.adding : strings.add}
      </button>
      {failure === null ? null : (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {failure}
        </p>
      )}
    </form>
  );
}

export function AgentSchedulesScreen({
  agentId,
  locale,
}: Readonly<{ agentId: string; locale: VersionsLocale }>) {
  const strings = schedulesStrings(locale);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [status, setStatus] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    browserClient()
      .triggers.list({ signal: controller.signal })
      .then(
        (triggers) => {
          if (!controller.signal.aborted) {
            setState({ kind: 'ready', schedules: agentSchedules(triggers, agentId) });
          }
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setState({ kind: problemCode(error) === 'forbidden' ? 'not-allowed' : 'failed' });
        },
      );
    return () => {
      controller.abort();
    };
  }, [agentId, reloads]);

  const reload = useCallback((message: string | null) => {
    setStatus(message);
    setReloads((count) => count + 1);
  }, []);

  return (
    <main
      lang={locale}
      className="w-full max-w-[1100px] space-y-5 px-4 pt-[26px] pb-[90px] sm:px-8"
    >
      <div className="space-y-1">
        <h1 className="text-[21px]">{strings.heading}</h1>
        <p className="text-[13px] text-muted">{strings.intro}</p>
      </div>
      <p role="status" className="text-[13px]">
        {status}
      </p>
      {state.kind === 'loading' ? <p className="text-muted">{strings.loading}</p> : null}
      {state.kind === 'failed' ? (
        <p role="alert" className="text-danger">
          {strings.loadFailed}
        </p>
      ) : null}
      {state.kind === 'not-allowed' ? <p className="text-muted">{strings.notAllowed}</p> : null}
      {state.kind === 'ready' ? (
        <>
          {state.schedules.length === 0 ? (
            <p className="text-[13px] text-muted">{strings.empty}</p>
          ) : (
            <ul
              aria-label={strings.listLabel}
              className="max-w-[760px] rounded-(--radius) border border-border bg-surface px-3"
            >
              {state.schedules.map((schedule) => (
                <ScheduleRow
                  key={`${schedule.id}:${schedule.updatedAt}`}
                  schedule={schedule}
                  strings={strings}
                  locale={locale}
                  onChanged={reload}
                />
              ))}
            </ul>
          )}
          <AddScheduleForm agentId={agentId} strings={strings} locale={locale} onAdded={reload} />
        </>
      ) : null}
    </main>
  );
}
