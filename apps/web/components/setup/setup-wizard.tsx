'use client';

import { useEffect, useMemo, useState } from 'react';

import { SETUP_PROVIDERS, type SetupProvider } from '@indx-workspace/contracts/setup';

import { CREDENTIAL_INPUT_PROPS, ONE_TIME_CODE_INPUT_PROPS } from '../shell/credential-input';
import { DriverBanner } from '../shell/driver-banner';
import {
  detectionOf,
  SETUP_REQUEST_HEADERS,
  setupOutcomeOf,
  setupUnanswered,
  type RuntimeDetection,
} from './setup-requests-model';

const SETUP_PROVIDER_LABELS: Readonly<Record<SetupProvider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'azure-openai': 'Azure OpenAI',
  'openai-compatible': 'OpenAI-compatible',
};

const STEPS = ['Provider', 'Credentials', 'Runtime', 'Administrator', 'First agent'] as const;

export function SetupWizard() {
  const [step, setStep] = useState(0);
  const [detection, setDetection] = useState<RuntimeDetection | null>(null);
  const [detectionFailed, setDetectionFailed] = useState(false);
  const [runtime, setRuntime] = useState('local');
  const [provider, setProvider] = useState('anthropic');
  const [providerApiKey, setProviderApiKey] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [agentName, setAgentName] = useState('');
  const [agentInstructions, setAgentInstructions] = useState('');
  const [submission, setSubmission] = useState<'idle' | 'saving'>('idle');
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  const finish = async (): Promise<void> => {
    setSubmission('saving');
    setSubmissionError(null);
    const outcome = await fetch('/api/setup', {
      method: 'POST',
      headers: { ...SETUP_REQUEST_HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({
        provider,
        providerApiKey,
        runtime,
        adminEmail,
        adminPassword,
        agentName,
        agentInstructions,
      }),
    }).then(setupOutcomeOf, setupUnanswered);
    if (outcome.ok) {
      window.location.assign(`/agents/${encodeURIComponent(outcome.agentId)}`);
      return;
    }
    setSubmissionError(outcome.message);
    setSubmission('idle');
  };

  useEffect(() => {
    void fetch('/api/setup/runtime-detect', { cache: 'no-store', headers: SETUP_REQUEST_HEADERS })
      .then(detectionOf, () => null)
      .then((result) => {
        if (result === null) {
          setDetectionFailed(true);
          return;
        }
        setDetection(result);
        setRuntime(result.defaultDriver);
      });
  }, []);

  const selected = useMemo(
    () => detection?.drivers.find(({ id }) => id === runtime) ?? null,
    [detection, runtime],
  );

  return (
    <main className="min-h-screen bg-bg">
      <DriverBanner
        driver={runtime}
        reason={
          selected?.reason ??
          (detectionFailed ? DETECTION_FAILED_MESSAGE : 'Detecting host capabilities…')
        }
        warning={runtime === 'local'}
      />
      <div className="mx-auto max-w-3xl px-6 py-12">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-accent">
          First run
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-text">Set up Agent Workspace</h1>
        <ol className="mt-8 grid grid-cols-5 gap-2" aria-label="Setup progress">
          {STEPS.map((name, index) => (
            <li
              className={`rounded border px-2 py-2 text-center text-[11px] ${index === step ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted'}`}
              key={name}
            >
              {index + 1}. {name}
            </li>
          ))}
        </ol>

        <section
          className="mt-8 rounded-xl border border-border bg-surface p-6 shadow-sm"
          key={STEPS[step]}
        >
          <h2 className="text-xl font-semibold text-text">{STEPS[step]}</h2>
          <div className="mt-5">
            {stepContent({
              step,
              detection,
              detectionFailed,
              runtime,
              setRuntime,
              provider,
              setProvider,
              providerApiKey,
              setProviderApiKey,
              adminEmail,
              setAdminEmail,
              adminPassword,
              setAdminPassword,
              agentName,
              setAgentName,
              agentInstructions,
              setAgentInstructions,
            })}
          </div>
          {submissionError === null ? null : (
            <p className="mt-4 text-sm text-danger" role="alert">
              {submissionError}
            </p>
          )}
          <div className="mt-8 flex justify-between border-t border-border pt-5">
            <button
              className="rounded border border-border px-4 py-2 text-sm disabled:opacity-40"
              disabled={step === 0}
              onClick={() => setStep((value) => Math.max(0, value - 1))}
              type="button"
            >
              Back
            </button>
            {step === STEPS.length - 1 ? (
              <button
                className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white"
                disabled={submission === 'saving'}
                onClick={() => void finish()}
                type="button"
              >
                {submission === 'saving' ? 'Finishing…' : 'Finish setup'}
              </button>
            ) : (
              <button
                className="rounded bg-accent px-4 py-2 text-sm font-semibold text-white"
                onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}
                type="button"
              >
                Continue
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

interface StepContentProps {
  step: number;
  detection: RuntimeDetection | null;
  detectionFailed: boolean;
  runtime: string;
  setRuntime: (value: string) => void;
  provider: string;
  setProvider: (value: string) => void;
  providerApiKey: string;
  setProviderApiKey: (value: string) => void;
  adminEmail: string;
  setAdminEmail: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
  agentName: string;
  setAgentName: (value: string) => void;
  agentInstructions: string;
  setAgentInstructions: (value: string) => void;
}

function credentialProps(credential: 'stored' | 'one-time-code' | undefined) {
  if (credential === 'stored') return CREDENTIAL_INPUT_PROPS;
  if (credential === 'one-time-code') return ONE_TIME_CODE_INPUT_PROPS;
  return {};
}

function controlledInput(
  label: string,
  value: string,
  setValue: (value: string) => void,
  options: {
    type?: string;
    autoComplete?: string;
    name: string;
    hint?: string;
    /**
     * `stored`: an API key to keep (`CREDENTIAL_INPUT_PROPS`); `one-time-code`: the generator's
     * one-time password, which Chrome must not autofill (`ONE_TIME_CODE_INPUT_PROPS`).
     */
    credential?: 'stored' | 'one-time-code';
  },
) {
  const inputId = `setup-${options.name}`;
  const hintId = options.hint === undefined ? undefined : `${inputId}-hint`;
  // The hint sits outside the label and is tied to the input by `aria-describedby`, so a screen
  // reader announces the label once and the hint once as the description.
  return (
    <div>
      <label className="block text-sm text-text-2" htmlFor={inputId}>
        {label}
      </label>
      <input
        aria-describedby={hintId}
        autoComplete={options.autoComplete}
        {...credentialProps(options.credential)}
        className="mt-2 w-full rounded border border-border bg-bg px-3 py-2 text-text"
        id={inputId}
        name={options.name}
        onChange={(event) => setValue(event.currentTarget.value)}
        type={options.type ?? 'text'}
        value={value}
      />
      {options.hint === undefined ? null : (
        <p className="mt-1 text-xs text-muted" id={hintId}>
          {options.hint}
        </p>
      )}
    </div>
  );
}

/*
 * Issue #416: the administrator step needs the one-time setup password the generator printed
 * (`BOOTSTRAP_ADMIN_PASSWORD` in `.env`) and the administrator email it names (`BOOTSTRAP_ADMIN`),
 * not a new password. A "Password" field marked as a new password made browsers offer a
 * generated or saved password, which the server then refused. The email is not prefilled: this
 * page runs before anyone has signed in, so nothing it fetches may carry the administrator email.
 */
export const ADMIN_EMAIL_HINT =
  'The administrator email the generator printed (BOOTSTRAP_ADMIN in .env).';
export const ADMIN_PASSWORD_HINT =
  'The one-time setup password: BOOTSTRAP_ADMIN_PASSWORD in the project .env file. Not a new password.';
/** Shown when the host could not be asked which runtimes it can run; setup keeps `local`. */
export const DETECTION_FAILED_MESSAGE =
  'Could not detect which runtimes this host can run, so setup uses the local driver.';

export function AdministratorFields(props: {
  adminEmail: string;
  setAdminEmail: (value: string) => void;
  adminPassword: string;
  setAdminPassword: (value: string) => void;
}) {
  return (
    <div className="space-y-4">
      {controlledInput('Administrator email', props.adminEmail, props.setAdminEmail, {
        type: 'email',
        autoComplete: 'off',
        name: 'adminEmail',
        hint: ADMIN_EMAIL_HINT,
      })}
      {controlledInput('One-time setup password', props.adminPassword, props.setAdminPassword, {
        type: 'password',
        credential: 'one-time-code',
        name: 'adminPassword',
        hint: ADMIN_PASSWORD_HINT,
      })}
    </div>
  );
}

/** Step 2: the provider key is a credential to store, never a password to generate (PR #418). */
export function ProviderKeyField(props: {
  providerApiKey: string;
  setProviderApiKey: (value: string) => void;
}) {
  return controlledInput('Provider API key', props.providerApiKey, props.setProviderApiKey, {
    type: 'password',
    credential: 'stored',
    name: 'providerApiKey',
  });
}

/** Step 3: the drivers the host offers, or why there are none to choose from. */
export function RuntimeChoices(props: {
  detection: RuntimeDetection | null;
  detectionFailed: boolean;
  runtime: string;
  setRuntime: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 text-sm text-text-2">Runtime driver</legend>
      {(props.detection?.drivers ?? []).map((driver) => (
        <label className="flex gap-3 rounded border border-border p-3" key={driver.id}>
          <input
            checked={props.runtime === driver.id}
            disabled={!driver.available}
            name="runtime"
            onChange={() => props.setRuntime(driver.id)}
            type="radio"
          />
          <span>
            <b className="block text-sm text-text">{driver.id}</b>
            <span className="text-xs text-muted">{driver.reason}</span>
          </span>
        </label>
      ))}
      {props.detection === null ? (
        <p className="text-sm text-muted">
          {props.detectionFailed ? DETECTION_FAILED_MESSAGE : 'Detecting this host…'}
        </p>
      ) : null}
    </fieldset>
  );
}

function stepContent(props: StepContentProps) {
  const { step } = props;
  switch (step) {
    case 0:
      return (
        <label className="block text-sm text-text-2">
          Model provider
          <select
            className="mt-2 w-full rounded border border-border bg-bg px-3 py-2 text-text"
            name="provider"
            onChange={(event) => props.setProvider(event.currentTarget.value)}
            value={props.provider}
          >
            {SETUP_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {SETUP_PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </label>
      );
    case 1:
      return (
        <ProviderKeyField
          providerApiKey={props.providerApiKey}
          setProviderApiKey={props.setProviderApiKey}
        />
      );
    case 2:
      return (
        <RuntimeChoices
          detection={props.detection}
          detectionFailed={props.detectionFailed}
          runtime={props.runtime}
          setRuntime={props.setRuntime}
        />
      );
    case 3:
      return (
        <AdministratorFields
          adminEmail={props.adminEmail}
          adminPassword={props.adminPassword}
          setAdminEmail={props.setAdminEmail}
          setAdminPassword={props.setAdminPassword}
        />
      );
    case 4:
      return (
        <div className="space-y-4">
          {controlledInput('Agent name', props.agentName, props.setAgentName, {
            autoComplete: 'off',
            name: 'agentName',
          })}
          {controlledInput('System prompt', props.agentInstructions, props.setAgentInstructions, {
            autoComplete: 'off',
            name: 'agentInstructions',
          })}
        </div>
      );
    default:
      throw new Error(`unknown setup step ${String(step)}`);
  }
}
