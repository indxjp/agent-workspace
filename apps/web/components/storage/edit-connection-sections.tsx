'use client';

import type { RefObject } from 'react';

import {
  CredentialInputs,
  STORAGE_BUTTON as BUTTON,
  STORAGE_CARD as CARD,
  STORAGE_CONTROL as CONTROL,
  STORAGE_HELP as HELP,
  STORAGE_LABEL as LABEL,
} from './storage-form-parts';
import type { StorageStrings } from './storage-messages';
import {
  URL_HINTS,
  type CredentialFields,
  type EditFormValues,
  type StorageConnectionResource,
} from './storage-model';
import { Problem } from './storage-problem';

/** The URL, allowed folders and write switch of a connection. */
export function SettingsCard({
  connection,
  values,
  onChange,
  strings,
}: Readonly<{
  connection: StorageConnectionResource;
  values: EditFormValues;
  onChange: (patch: Partial<EditFormValues>) => void;
  strings: StorageStrings;
}>) {
  return (
    <div className={`${CARD} space-y-4 p-4`}>
      <div>
        <label className={LABEL} htmlFor="storage-url">
          {strings.url}
        </label>
        <input
          id="storage-url"
          className={`${CONTROL} mt-1 font-mono`}
          value={values.url}
          required
          aria-describedby="storage-url-help"
          onChange={(event) => onChange({ url: event.target.value })}
        />
        <p id="storage-url-help" className={HELP}>
          {strings.urlExample(URL_HINTS[connection.provider])} {strings.urlMoveNeedsCredential}
        </p>
      </div>
      <div>
        <label className={LABEL} htmlFor="storage-folders">
          {strings.allowedFolders}
        </label>
        <textarea
          id="storage-folders"
          className={`${CONTROL} mt-1 font-mono`}
          rows={3}
          value={values.folders}
          required
          aria-describedby="storage-folders-help"
          onChange={(event) => onChange({ folders: event.target.value })}
        />
        <p id="storage-folders-help" className={HELP}>
          {strings.foldersHelp}
        </p>
      </div>
      <label className="flex items-center gap-2 text-[13px] font-semibold" htmlFor="storage-write">
        <input
          id="storage-write"
          type="checkbox"
          checked={values.writeAllowed}
          onChange={(event) => onChange({ writeAllowed: event.target.checked })}
        />
        {strings.allowWriting}
      </label>
      <p className="-mt-2 text-[11.5px] text-muted">{strings.allowWritingHelp}</p>
    </div>
  );
}

/** The write-only credential inputs and the rotate button. */
export function CredentialSection({
  connection,
  credentials,
  busy,
  problem,
  onChange,
  onRotate,
  strings,
}: Readonly<{
  connection: StorageConnectionResource;
  credentials: CredentialFields;
  busy: boolean;
  problem: string | null;
  onChange: (patch: Partial<CredentialFields>) => void;
  onRotate: () => void;
  strings: StorageStrings;
}>) {
  return (
    <section className={`${CARD} mt-4 space-y-4 p-4`} aria-labelledby="storage-credential-heading">
      <h2 id="storage-credential-heading" className="text-[15px] font-semibold">
        {strings.credential}
      </h2>
      <p className="text-[12.5px] text-muted">
        {connection.hasCredential ? strings.credentialStoredHelp : strings.credentialNoneHelp}{' '}
        {strings.enterNewToReplace}
      </p>
      <CredentialInputs
        provider={connection.provider}
        credentials={credentials}
        onChange={onChange}
        strings={strings}
      />
      <div>
        <button type="button" className={BUTTON} disabled={busy} onClick={onRotate}>
          {strings.rotateCredential}
        </button>
      </div>
      {problem === null ? null : <Problem message={problem} />}
    </section>
  );
}

/** The danger zone: the button that opens the delete dialog, and why a delete failed. */
export function DeleteSection({
  triggerRef,
  busy,
  problem,
  onStart,
  strings,
}: Readonly<{
  triggerRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  problem: string | null;
  onStart: () => void;
  strings: StorageStrings;
}>) {
  return (
    <section className={`${CARD} mt-8 p-4`} aria-labelledby="storage-delete-heading">
      <h2 id="storage-delete-heading" className="text-[15px] font-semibold">
        {strings.deleteHeading}
      </h2>
      <p className="mt-1 text-[12.5px] text-muted">{strings.deleteHelp}</p>
      <button
        ref={triggerRef}
        type="button"
        className={`${BUTTON} mt-3 border-danger bg-surface text-danger`}
        disabled={busy}
        onClick={onStart}
      >
        {strings.deleteThis}
      </button>
      {problem === null ? null : <Problem message={problem} />}
    </section>
  );
}
