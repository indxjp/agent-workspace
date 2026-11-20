'use client';

import Link from 'next/link';
import { useRef } from 'react';

import type { VersionsLocale } from '../agents/versions-messages';

import { CredentialSection, DeleteSection, SettingsCard } from './edit-connection-sections';
import { STORAGE_BUTTON as BUTTON } from './storage-form-parts';
import { storageStrings, type StorageStrings } from './storage-messages';
import type { StorageConnectionResource } from './storage-model';
import { DeleteDialog } from './storage-delete-dialog';
import { Problem } from './storage-problem';
import { useEditConnection } from './use-edit-connection';

const MAIN_CLASS = 'w-full max-w-[760px] px-8 pt-[26px] pb-[90px]';

function Heading({
  connection,
  strings,
}: Readonly<{ connection: StorageConnectionResource | null; strings: StorageStrings }>) {
  return (
    <div className="mb-[22px]">
      <h1 className="text-[21px]">{strings.editTitle}</h1>
      {connection === null ? null : (
        <p className="mt-[3px] text-[13px] text-muted">
          {connection.name} · {connection.provider}
        </p>
      )}
    </div>
  );
}

export function EditConnectionScreen({
  id,
  locale = 'en',
}: Readonly<{
  id: string;
  /** The reader's language (UX-15 in #2086); English by default. */
  locale?: VersionsLocale;
}>) {
  const strings = storageStrings(locale);
  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const state = useEditConnection(id, strings);
  const { connection, values, busy } = state;

  if (connection === null || values === null) {
    return (
      <main lang={locale} className={MAIN_CLASS}>
        <Heading connection={connection} strings={strings} />
        {state.loadProblem === null ? (
          <p className="text-[13px] text-muted">{strings.loadingConnection}</p>
        ) : (
          <>
            <Problem message={state.loadProblem} />
            <p className="mt-4 text-[13px]">
              <Link href="/admin/storage">{strings.backToStorage}</Link>
            </p>
          </>
        )}
      </main>
    );
  }

  return (
    <main lang={locale} className={MAIN_CLASS}>
      <Heading connection={connection} strings={strings} />
      <form
        method="post"
        onSubmit={(event) => {
          void state.save(event);
        }}
      >
        <SettingsCard
          connection={connection}
          values={values}
          onChange={state.setValue}
          strings={strings}
        />
        {connection.provider === 'file' ? null : (
          <CredentialSection
            connection={connection}
            credentials={state.credentials}
            busy={busy}
            problem={state.credentialProblemText}
            onChange={state.setCredential}
            onRotate={() => {
              void state.rotate();
            }}
            strings={strings}
          />
        )}
        {state.settingsProblem === null ? null : <Problem message={state.settingsProblem} />}
        {state.notice === null ? null : (
          <div role="status" className="mt-4 text-[13px]">
            {state.notice}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Link href="/admin/storage" className={`${BUTTON} bg-surface no-underline`}>
            {strings.backToStorage}
          </Link>
          <button
            type="submit"
            disabled={busy}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {strings.saveChanges}
          </button>
        </div>
      </form>

      <DeleteSection
        triggerRef={deleteTriggerRef}
        busy={busy}
        problem={state.deleteProblem}
        onStart={state.startDelete}
        strings={strings}
      />

      {state.confirmingDelete ? (
        <DeleteDialog
          name={connection.name}
          busy={busy}
          returnFocusTo={deleteTriggerRef}
          onCancel={state.cancelDelete}
          onConfirm={() => {
            void state.remove();
          }}
          strings={strings}
        />
      ) : null}
    </main>
  );
}
