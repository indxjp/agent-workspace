'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { browserClient } from '../../lib/browser-client';
import {
  CredentialInputs,
  STORAGE_BUTTON as BUTTON,
  STORAGE_CARD as CARD,
  STORAGE_CONTROL as CONTROL,
  STORAGE_HELP as HELP,
  STORAGE_LABEL as LABEL,
} from './storage-form-parts';
import {
  createConnectionInput,
  credentialProblem,
  EMPTY_CREDENTIALS,
  PROVIDER_OPTIONS,
  storageProblemMessage,
  URL_HINTS,
  type CredentialFields,
  type StorageProvider,
} from './storage-model';

export function NewConnectionForm() {
  const router = useRouter();
  const alertRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<StorageProvider>('s3');
  const [url, setUrl] = useState('');
  const [folders, setFolders] = useState('');
  const [writeAllowed, setWriteAllowed] = useState(false);
  const [credentials, setCredentials] = useState<CredentialFields>(EMPTY_CREDENTIALS);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (problem !== null) alertRef.current?.focus();
  }, [problem]);

  const setCredential = (patch: Partial<CredentialFields>) =>
    setCredentials((current) => ({ ...current, ...patch }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const refused = credentialProblem(provider, credentials);
    if (refused !== null) {
      setProblem(refused);
      setCredentials(EMPTY_CREDENTIALS);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await browserClient().storage.connections.create(
        createConnectionInput({ name, provider, url, folders, writeAllowed, credentials }),
      );
      router.push('/admin/storage');
    } catch (error) {
      setProblem(storageProblemMessage(error, 'The storage connection could not be saved.'));
    } finally {
      // A credential is write-only: it leaves the page state whatever the outcome.
      setCredentials(EMPTY_CREDENTIALS);
      setSaving(false);
    }
  }

  return (
    <main className="w-full max-w-[760px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px]">
        <h1 className="text-[21px]">Connect storage</h1>
        <p className="mt-[3px] text-[13px] text-muted">
          Name a bucket or folder and the folders agents may be granted. Access is read-only unless
          you allow writing.
        </p>
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
              Name
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
              Lowercase letters, digits and hyphens. Grants use this name.
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-provider">
              Provider
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
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-url">
              URL
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
              For example {URL_HINTS[provider]}. No keys in the URL.
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="storage-folders">
              Allowed folders
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
              One folder per line, such as reports. Agents see only these.
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
            Allow writing
          </label>
          <p className="-mt-2 text-[11.5px] text-muted">
            Off by default. With a read/write grant, a run&apos;s new and changed files are written
            back; nothing is deleted.
          </p>
        </div>

        {provider === 'file' ? null : (
          <div className={`${CARD} mt-4 space-y-4 p-4`}>
            <h2 className="text-[15px] font-semibold">Credential</h2>
            <CredentialInputs
              provider={provider}
              credentials={credentials}
              onChange={setCredential}
            />
            <p className="text-[11.5px] text-muted">
              Stored encrypted and never shown again. Leave empty to use the deployment’s own
              identity.
            </p>
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
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className={`${BUTTON} border-accent bg-accent text-white`}
          >
            Save connection
          </button>
        </div>
      </form>
    </main>
  );
}
