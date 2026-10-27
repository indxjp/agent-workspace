'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { StorageConnectionResource } from '@indx-workspace/sdk';

import { browserClient } from '../../lib/browser-client';

import { storageProblemMessage, testOutcomeMessage } from './storage-model';

const CARD = 'overflow-hidden rounded-(--radius) border border-border bg-surface shadow-(--shadow)';
const BUTTON =
  'inline-flex h-8 items-center justify-center rounded-(--radius-sm) border border-border-strong px-[13px] text-[13px] font-medium';

export function StorageConnectionsScreen() {
  const [connections, setConnections] = useState<readonly StorageConnectionResource[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void browserClient()
      .storage.connections.list()
      .then((listed) => {
        if (active) setConnections(listed);
      })
      .catch((error: unknown) => {
        if (active) {
          setProblem(storageProblemMessage(error, 'Storage connections could not be loaded.'));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  function test(connection: StorageConnectionResource) {
    setTestMessage(`Testing ${connection.name}…`);
    void browserClient()
      .storage.connections.test(connection.id)
      .then((outcome) => setTestMessage(`${connection.name}: ${testOutcomeMessage(outcome)}`))
      .catch((error: unknown) =>
        setTestMessage(
          `${connection.name}: ${storageProblemMessage(error, 'The connection could not be tested.')}`,
        ),
      );
  }

  return (
    <main className="w-full max-w-[980px] px-8 pt-[26px] pb-[90px]">
      <div className="mb-[22px] flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[21px]">Storage</h1>
          <p className="mt-[3px] text-[13px] text-muted">
            Buckets and folders your agents may read. Credentials are write-only: they are stored
            encrypted and never shown again.
          </p>
        </div>
        <Link
          className={`${BUTTON} border-accent bg-accent text-white no-underline`}
          href="/admin/storage/new"
        >
          + Connect storage
        </Link>
      </div>

      {problem !== null ? (
        <div
          role="alert"
          className="rounded-(--radius) border border-danger bg-danger-soft p-4 text-[13px] text-danger"
        >
          {problem}
        </div>
      ) : connections === null ? (
        <div className="text-[13px] text-muted">Loading storage connections…</div>
      ) : connections.length === 0 ? (
        <div className={`${CARD} p-5 text-[13px] text-muted`}>
          No storage is connected yet. Connect a bucket or folder to grant it to an agent.
        </div>
      ) : (
        <div className={CARD}>
          {connections.map((connection) => (
            <div
              key={connection.id}
              className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-[14px] last:border-b-0"
            >
              <div className="min-w-[260px] flex-1">
                <div className="text-[13.5px] font-semibold">{connection.name}</div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {connection.provider} · {connection.url}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  Folders: {connection.allowedPrefixes.join(', ')} ·{' '}
                  {connection.writeAllowed ? 'Writes allowed' : 'Read-only'}
                </div>
                {connection.hasCredential ? (
                  <div className="mt-1 text-[11px] text-muted">
                    Credential stored securely · write-only
                  </div>
                ) : null}
              </div>
              <Link
                className={`${BUTTON} no-underline`}
                href={`/admin/storage/${connection.id}`}
                aria-label={`Edit ${connection.name}`}
              >
                Edit
              </Link>
              <button
                type="button"
                className={BUTTON}
                aria-label={`Test ${connection.name}`}
                onClick={() => test(connection)}
              >
                Test
              </button>
            </div>
          ))}
          {testMessage === null ? null : (
            <div
              role="status"
              className="border-t border-border bg-surface-2 px-4 py-2 text-[12px]"
            >
              {testMessage}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
