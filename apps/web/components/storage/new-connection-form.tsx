'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { StorageConnectionResource } from '@indx-workspace/contracts/storage-connections';

import { browserClient } from '../../lib/browser-client';
import type { VersionsLocale } from '../agents/versions-messages';
import {
  CredentialInputs,
  STORAGE_BUTTON as BUTTON,
  STORAGE_CARD as CARD,
  STORAGE_CONTROL as CONTROL,
  STORAGE_HELP as HELP,
  STORAGE_LABEL as LABEL,
} from './storage-form-parts';
import { storageStrings, type StorageStrings } from './storage-messages';
import {
  createConnectionInput,
  connectionNameProblem,
  credentialProblem,
  EMPTY_CREDENTIALS,
  PROVIDER_OPTIONS,
  savedTestFailure,
  savedTestResult,
  storageProblemMessage,
  URL_HINTS,
  type CredentialFields,
  type SavedTestResult,
  type StorageProvider,
} from './storage-model';

/** A saved connection and its first test: `null` while the test runs (UX-07 in #2086). */
interface SavedConnection {
  readonly connection: StorageConnectionResource;
  readonly result: SavedTestResult | null;
}

export function NewConnectionForm({
  locale = 'en',
}: {
  /** The reader's language (UX-15 in #2086); English by default. */
  readonly locale?: VersionsLocale;
}) {
  const strings = storageStrings(locale);
  const alertRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<StorageProvider>('s3');
  const [url, setUrl] = useState('');
  const [folders, setFolders] = useState('');
  const [writeAllowed, setWriteAllowed] = useState(false);
  const [credentials, setCredentials] = useState<CredentialFields>(EMPTY_CREDENTIALS);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedConnection | null>(null);

  useEffect(() => {
    if (problem !== null) alertRef.current?.focus();
  }, [problem]);

  const setCredential = (patch: Partial<CredentialFields>) =>
    setCredentials((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const refused =
      connectionNameProblem(name, strings) ?? credentialProblem(provider, credentials, strings);
    if (refused !== null) {
      setProblem(refused);
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const client = browserClient();
      const connection = await client.storage.connections.create(
        createConnectionInput({ name, provider, url, folders, writeAllowed, credentials }),
      );
      // Saved: test it now with the stored key, the same call as Storage's Test button, so the
      // person learns at once whether it works. It stays saved whatever the test says.
      setSaved({ connection, result: null });
      void client.storage.connections.test(connection.id).then(
        (outcome) => setSaved({ connection, result: savedTestResult(outcome, strings) }),
        (error: unknown) => setSaved({ connection, result: savedTestFailure(error, strings) }),
      );
    } catch (error) {
      setProblem(storageProblemMessage(error, strings.couldNotSave, strings));
    } finally {
      // A credential is write-only: it leaves the page state whatever the outcome.
      setCredentials(EMPTY_CREDENTIALS);
      setSaving(false);
    }
  }

  if (saved !== null)
    return <SavedConnectionResult saved={saved} strings={strings} locale={locale} />;

  return (
    <main lang={locale} className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">{strings.newTitle}</h1>
        <p className="mt-[3px] text-[13px] text-muted">{strings.newIntro}</p>
      </div>
      <form
        method="post"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <div className={`${CARD} space-y-4 p-4`}>
          <div>
            <label className={LABEL} htmlFor="storage-name">
              {strings.name}
            </label>
            <input
              id="storage-name"
              className={`${CONTROL} mt-1`}
              value={name}
              required
              aria-describedby="storage-name-help"
              onChange={(event) => setName(event.target.value)}
            />
            <p id="storage-name-help" className={HELP}>
              {strings.nameHelp}
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-provider">
              {strings.provider}
            </label>
            <select
              id="storage-provider"
              className={`${CONTROL} mt-1`}
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as StorageProvider);
                setCredentials(EMPTY_CREDENTIALS);
              }}
            >
              {PROVIDER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {strings.providerLabel[option.value]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-url">
              {strings.url}
            </label>
            <input
              id="storage-url"
              className={`${CONTROL} mt-1 font-mono`}
              value={url}
              required
              aria-describedby="storage-url-help"
              onChange={(event) => setUrl(event.target.value)}
            />
            <p id="storage-url-help" className={HELP}>
              {strings.urlExample(URL_HINTS[provider])} {strings.noKeysInUrl}
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
              value={folders}
              required
              aria-describedby="storage-folders-help"
              onChange={(event) => setFolders(event.target.value)}
            />
            <p id="storage-folders-help" className={HELP}>
              {strings.foldersHelp}
            </p>
          </div>
          <label
            className="flex items-center gap-2 text-[13px] font-semibold"
            htmlFor="storage-write"
          >
            <input
              id="storage-write"
              type="checkbox"
              checked={writeAllowed}
              onChange={(event) => setWriteAllowed(event.target.checked)}
            />
            {strings.allowWriting}
          </label>
          <p className="-mt-2 text-[11.5px] text-muted">{strings.allowWritingHelp}</p>
        </div>

        {provider === 'file' ? null : (
          <div className={`${CARD} mt-4 space-y-4 p-4`}>
            <h2 className="text-[15px] font-semibold">{strings.credential}</h2>
            <CredentialInputs
              provider={provider}
              credentials={credentials}
              onChange={setCredential}
              strings={strings}
            />
            <p className="text-[11.5px] text-muted">{strings.credentialNewHelp}</p>
          </div>
        )}

        {problem === null ? null : (
          <div
            ref={alertRef}
            tabIndex={-1}
            role="alert"
            className="mt-4 rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
          >
            {problem}
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Link href="/admin/storage" className={`${BUTTON} bg-surface no-underline`}>
            {strings.cancel}
          </Link>
          <button
            type="submit"
            disabled={saving}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            {strings.saveAndTest}
          </button>
        </div>
      </form>
    </main>
  );
}

const MESSAGE_TONE: Record<SavedTestResult['level'], string | undefined> = {
  ok: undefined,
  warn: 'text-warn',
  fail: 'text-danger',
};

function SavedConnectionResult({
  saved,
  strings,
  locale,
}: {
  readonly saved: SavedConnection;
  readonly strings: StorageStrings;
  readonly locale: VersionsLocale;
}) {
  const { connection, result } = saved;
  const headingRef = useRef<HTMLHeadingElement>(null);
  // The form this replaces held focus; move it here so keyboard and screen-reader users land on
  // the result instead of the top of the page.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  const primary = `${BUTTON} border-accent bg-accent text-white no-underline`;
  return (
    <main lang={locale} className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">{strings.newTitle}</h1>
      </div>
      <div className={`${CARD} space-y-3 p-4`}>
        <h2 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold break-words">
          {strings.saved(connection.name)}
        </h2>
        <div role="status" className="text-[13px] break-words">
          {result === null ? (
            <p>{strings.testingConnection}</p>
          ) : (
            <>
              <p className={MESSAGE_TONE[result.level]}>{result.message}</p>
              {result.next === null ? null : <p className="mt-1 text-muted">{result.next}</p>}
            </>
          )}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {result !== null && result.level !== 'ok' ? (
          <Link href={`/admin/storage/${connection.id}`} className={primary}>
            {strings.editConnection}
          </Link>
        ) : null}
        <Link
          href="/admin/storage"
          className={result?.level === 'ok' ? primary : `${BUTTON} bg-surface no-underline`}
        >
          {result?.level === 'ok' ? strings.done : strings.backToStorageList}
        </Link>
      </div>
    </main>
  );
}
