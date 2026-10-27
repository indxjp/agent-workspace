'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ModelConnectionConfigField } from '@indx-workspace/contracts/models';
import { useState, type FormEvent } from 'react';

import { browserClient } from '../../lib/browser-client';
import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';

import { createConnection } from './connections-model';
import {
  PROVIDER_CHOICES,
  editableConfigFields,
  isProviderFormComplete,
  requiredConfigFields,
  type ProviderFormValues,
  type ProviderId,
} from './model';

const CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50';
const CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';

const initialValues = (provider: ProviderId): ProviderFormValues => ({
  name: '',
  provider,
  apiKey: '',
  baseUrl: '',
  deployment: '',
  apiVersion: '',
});

export function AddProviderScreen({
  initialProvider = 'anthropic',
}: {
  initialProvider?: ProviderId;
}) {
  const router = useRouter();
  const [values, setValues] = useState<ProviderFormValues>(() => initialValues(initialProvider));
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const canSubmit = isProviderFormComplete(values) && !submitting;

  function set(field: keyof ProviderFormValues, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function chooseProvider(provider: ProviderId) {
    setValues((current) => ({ ...current, provider }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setProblem(null);
    void createConnection(browserClient(), values)
      .then(() => {
        setValues((current) => ({ ...current, apiKey: '' }));
        router.push('/admin/models');
      })
      .catch((error: unknown) => {
        setSubmitting(false);
        setProblem(error instanceof Error ? error.message : String(error));
      });
  }

  const fields = editableConfigFields(values.provider);
  const required = requiredConfigFields(values.provider);
  const optional = (field: ModelConnectionConfigField) =>
    required.includes(field) ? '' : ' (optional)';

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">Add Provider</h1>
        <p className="mt-[3px] text-[13px] text-muted">
          Choose a provider, then answer only the questions that provider actually needs.
        </p>
      </div>

      <form onSubmit={submit}>
        <h2 className="mb-3 text-[15px] font-semibold">Choose provider</h2>
        <div className={CARD}>
          {PROVIDER_CHOICES.map((provider) => (
            <button
              key={provider.id}
              type="button"
              aria-pressed={values.provider === provider.id}
              onClick={() => chooseProvider(provider.id)}
              className={`flex w-full items-start gap-3 border-b border-border p-[14px] text-left last:border-b-0 ${
                values.provider === provider.id ? 'bg-accent-soft' : 'bg-surface'
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-1 size-3.5 flex-none rounded-full border ${
                  values.provider === provider.id
                    ? 'border-[4px] border-accent'
                    : 'border-border-strong'
                }`}
              />
              <span>
                <span className="block text-[13.5px] font-semibold">
                  {provider.label}
                  {provider.id === 'anthropic' ? (
                    <span className="ml-2 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[12px] text-muted">{provider.description}</span>
              </span>
            </button>
          ))}
        </div>

        <h2 className="mt-6 mb-3 text-[15px] font-semibold">
          {PROVIDER_CHOICES.find((provider) => provider.id === values.provider)?.label}
        </h2>
        <div className={`${CARD} space-y-4 p-4`}>
          {fields.includes('baseUrl') ? (
            <label className="block text-[13px] font-semibold">
              {values.provider === 'azure-openai' ? 'Endpoint' : 'Base URL'}
              {optional('baseUrl')}
              <input
                className={`${CONTROL} mt-1 font-mono`}
                type="url"
                value={values.baseUrl}
                onChange={(event) => set('baseUrl', event.target.value)}
                placeholder={
                  values.provider === 'azure-openai'
                    ? 'https://company.openai.azure.com'
                    : 'https://models.example.com/v1'
                }
              />
            </label>
          ) : null}
          <label className="block text-[13px] font-semibold">
            API Key
            <input
              className={`${CONTROL} mt-1 font-mono`}
              type="password"
              {...CREDENTIAL_INPUT_PROPS}
              value={values.apiKey}
              onChange={(event) => set('apiKey', event.target.value)}
            />
            <span className="mt-1 block text-[11.5px] font-normal text-muted">
              Stored encrypted. After saving, this secret is write-only and is never displayed
              again.
            </span>
          </label>
          {fields.includes('deployment') && fields.includes('apiVersion') ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-[13px] font-semibold">
                Deployment{optional('deployment')}
                <input
                  className={`${CONTROL} mt-1 font-mono`}
                  value={values.deployment}
                  onChange={(event) => set('deployment', event.target.value)}
                />
              </label>
              <label className="block text-[13px] font-semibold">
                API Version{optional('apiVersion')}
                <input
                  className={`${CONTROL} mt-1 font-mono`}
                  value={values.apiVersion}
                  onChange={(event) => set('apiVersion', event.target.value)}
                />
              </label>
            </div>
          ) : null}
          <label className="block text-[13px] font-semibold">
            Display name
            <input
              className={`${CONTROL} mt-1`}
              value={values.name}
              onChange={(event) => set('name', event.target.value)}
              placeholder="What people choose in the agent editor"
            />
          </label>
        </div>

        {values.provider === 'azure-openai' || values.provider === 'openai-compatible' ? (
          <div className="mt-4 rounded-(--radius) border border-warn bg-warn-soft p-4 text-[13px] text-warn">
            Compatibility varies by endpoint. The agent editor shows capability warnings before an
            agent is saved.
          </div>
        ) : null}
        {problem === null ? null : (
          <div
            role="alert"
            className="mt-4 rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
          >
            {problem}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Link href="/admin/models" className={`${BUTTON} bg-surface no-underline`}>
            Cancel
          </Link>
          <button
            type="submit"
            disabled={!canSubmit}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </main>
  );
}
