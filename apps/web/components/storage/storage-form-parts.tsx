'use client';

import { CREDENTIAL_INPUT_PROPS } from '../shell/credential-input';

import { storageStrings, type StorageStrings } from './storage-messages';
import type { CredentialFields, StorageProvider } from './storage-model';

export const STORAGE_CARD = 'rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
export const STORAGE_BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50';
export const STORAGE_CONTROL =
  'w-full rounded-(--radius-sm) border border-border-strong bg-surface px-2.5 py-[7px] text-[13.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
export const STORAGE_LABEL = 'block text-[13px] font-semibold';
export const STORAGE_HELP = 'mt-1 text-[11.5px] text-muted';

/** The write-only credential inputs of one provider; a `file` connection has none. */
export function CredentialInputs({
  provider,
  credentials,
  onChange,
  strings = storageStrings('en'),
}: Readonly<{
  provider: StorageProvider;
  credentials: CredentialFields;
  onChange: (patch: Partial<CredentialFields>) => void;
  /** The reader's words (UX-15 in #2086); English by default. */
  strings?: StorageStrings;
}>) {
  return (
    <>
      {provider === 's3' ? (
        <>
          <label className={STORAGE_LABEL} htmlFor="storage-access-key-id">
            {strings.accessKeyId}
            <input
              id="storage-access-key-id"
              type="password"
              {...CREDENTIAL_INPUT_PROPS}
              className={`${STORAGE_CONTROL} mt-1 font-mono`}
              value={credentials.accessKeyId}
              required={credentials.secretAccessKey !== ''}
              onChange={(event) => onChange({ accessKeyId: event.target.value })}
            />
          </label>
          <label className={STORAGE_LABEL} htmlFor="storage-secret-access-key">
            {strings.secretAccessKey}
            <input
              id="storage-secret-access-key"
              type="password"
              {...CREDENTIAL_INPUT_PROPS}
              className={`${STORAGE_CONTROL} mt-1 font-mono`}
              value={credentials.secretAccessKey}
              required={credentials.accessKeyId !== ''}
              onChange={(event) => onChange({ secretAccessKey: event.target.value })}
            />
          </label>
        </>
      ) : null}
      {provider === 'gcs' ? (
        <label className={STORAGE_LABEL} htmlFor="storage-service-account">
          {strings.serviceAccountJson}
          <input
            id="storage-service-account"
            type="password"
            {...CREDENTIAL_INPUT_PROPS}
            className={`${STORAGE_CONTROL} mt-1 font-mono`}
            value={credentials.serviceAccountJson}
            onChange={(event) => onChange({ serviceAccountJson: event.target.value })}
          />
        </label>
      ) : null}
      {provider === 'azblob' ? (
        <>
          <label className={STORAGE_LABEL} htmlFor="storage-azure-kind">
            {strings.credentialType}
            <select
              id="storage-azure-kind"
              className={`${STORAGE_CONTROL} mt-1`}
              value={credentials.azureKind}
              onChange={(event) =>
                onChange({
                  azureKind: event.target.value === 'sasToken' ? 'sasToken' : 'accountKey',
                  azureSecret: '',
                })
              }
            >
              <option value="accountKey">{strings.accountKey}</option>
              <option value="sasToken">{strings.sasToken}</option>
            </select>
          </label>
          <label className={STORAGE_LABEL} htmlFor="storage-azure-secret">
            {credentials.azureKind === 'accountKey' ? strings.accountKey : strings.sasToken}
            <input
              id="storage-azure-secret"
              type="password"
              {...CREDENTIAL_INPUT_PROPS}
              className={`${STORAGE_CONTROL} mt-1 font-mono`}
              value={credentials.azureSecret}
              onChange={(event) => onChange({ azureSecret: event.target.value })}
            />
          </label>
        </>
      ) : null}
    </>
  );
}
