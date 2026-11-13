'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StorageConnectionBrowseEntry, StorageConnectionResource } from '@indx-workspace/sdk';

import type { AgentResourceAssignments } from '../../contracts/agents';
import { browserClient } from '../../lib/browser-client';

import {
  grantFocusedAfterRemoval,
  grantKey,
  removeStorageGrant,
  saveStorageGrant,
  storageGrantPath,
  type GrantAccess,
} from './storage-grants-model';
import type { VersionsLocale } from '../agents/versions-messages';
import { connectedStorageWords, type ConnectedStorageWords } from './connected-storage-messages';
import { storageStrings } from './storage-messages';
import { storageProblemMessage } from './storage-model';

const CONTROL =
  'rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-1 text-[12.5px] text-text focus:border-accent focus:outline-2 focus:-outline-offset-1 focus:outline-accent';
const BTN_SM =
  'rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-1 text-[12px] font-medium text-text disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45';
const ROW =
  'flex flex-wrap items-center gap-2 border-b border-border py-2 text-[13px] last:border-b-0';

type StorageGrants = AgentResourceAssignments['storageGrants'];

export type StorageConnectionsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly connections: readonly StorageConnectionResource[] }
  | { readonly kind: 'failed'; readonly reason: string };

/** The connections the caller may read; a refusal (a Viewer, an unconfigured deployment) is a `failed` state. */
export function useStorageConnections(
  enabled: boolean,
  locale: VersionsLocale = 'en',
): StorageConnectionsState {
  const [state, setState] = useState<StorageConnectionsState>({ kind: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void browserClient()
      .storage.connections.list()
      .then(
        (connections) => {
          if (active) setState({ kind: 'ready', connections });
        },
        (error: unknown) => {
          if (active) {
            setState({
              kind: 'failed',
              reason: storageProblemMessage(
                error,
                connectedStorageWords(locale).loadFailed,
                storageStrings(locale),
              ),
            });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [enabled, locale]);
  return state;
}

/** How a grant reads: an id is "unresolved" only once the list loaded without it. */
function grantLabel(
  state: StorageConnectionsState,
  connectionId: string,
  prefix: string,
  words: ConnectedStorageWords,
): string {
  if (state.kind !== 'ready') return words.loadingGrant(prefix);
  const name = state.connections.find((connection) => connection.id === connectionId)?.name;
  return name === undefined ? words.unresolvedConnection(prefix) : `${name}/${prefix}/`;
}

/** The folders of storage connections this agent is granted, one row each. */
export function StorageGrantList({
  agentId,
  grants,
  connections,
  listRef,
  focusWhenEmpty,
  onChanged,
  locale = 'en',
}: Readonly<{
  agentId: string;
  grants: StorageGrants;
  connections: StorageConnectionsState;
  listRef?: RefObject<HTMLUListElement | null>;
  /** Takes focus when the removed grant was the last one, so focus never falls to the page. */
  focusWhenEmpty: RefObject<HTMLElement | null>;
  /** The agent's assignments after a grant was removed. */
  onChanged: (next: AgentResourceAssignments) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = connectedStorageWords(locale);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // After a removal: the key of the grant to focus, `null` for "none is left", `undefined` for idle.
  const [focusAfter, setFocusAfter] = useState<string | null | undefined>(undefined);
  const ownListRef = useRef<HTMLUListElement>(null);
  const list = listRef ?? ownListRef;

  // Runs once the list shows the saved grants: the removed row's button is gone by then, and
  // focus would otherwise fall to the page.
  useEffect(() => {
    if (focusAfter === undefined) return;
    setFocusAfter(undefined);
    const row = Array.from(list.current?.children ?? []).find(
      (candidate) =>
        candidate instanceof HTMLElement && candidate.dataset['grantPath'] === focusAfter,
    );
    const target = row?.querySelector('button') ?? row;
    if (target instanceof HTMLElement) target.focus();
    else focusWhenEmpty.current?.focus();
  }, [focusAfter, list, focusWhenEmpty]);

  if (grants.length === 0) return null;

  async function remove(connection: StorageConnectionResource, key: string, prefix: string) {
    if (removing !== null) return;
    setRemoving(key);
    setProblem(null);
    try {
      const next = await removeStorageGrant(
        browserClient(),
        agentId,
        storageGrantPath(connection.name, prefix),
      );
      onChanged(next);
      setFocusAfter(grantFocusedAfterRemoval(grants, key, next.storageGrants));
    } catch (error) {
      setProblem(storageProblemMessage(error, words.removeFailed, storageStrings(locale)));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      {connections.kind === 'failed' ? (
        <p className="text-[12.5px] text-danger">{connections.reason}</p>
      ) : null}
      <ul aria-label={words.grantsLabel} ref={list}>
        {grants.map((grant) => {
          const path = grantKey(grant);
          const label = grantLabel(connections, grant.connectionId, grant.prefix, words);
          const connection =
            connections.kind === 'ready'
              ? connections.connections.find((candidate) => candidate.id === grant.connectionId)
              : undefined;
          return (
            <li className={ROW} key={path} tabIndex={-1} data-grant-path={path}>
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="text-[12px] text-muted">
                {grant.access === 'read-write' ? words.readWrite : words.read}
              </span>
              {connection === undefined ? null : (
                <button
                  type="button"
                  className={BTN_SM}
                  aria-label={words.removeGrant(label)}
                  // Not `disabled`: the pressed button keeps focus while the removal is in flight,
                  // and keeps it if the removal is refused.
                  aria-disabled={removing !== null}
                  onClick={() => {
                    void remove(connection, path, grant.prefix);
                  }}
                >
                  {words.remove}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {problem === null ? null : (
        <p role="alert" className="text-[12.5px] text-danger">
          {problem}
        </p>
      )}
    </>
  );
}

const lastSegment = (path: string) => path.replace(/\/+$/u, '').split('/').pop() ?? path;
const parentOf = (prefix: string) => prefix.split('/').slice(0, -1).join('/');

function readWriteGap(
  connection: StorageConnectionResource,
  writeFilesAllowed: boolean,
  words: ConnectedStorageWords,
) {
  const gaps = [
    ...(connection.writeAllowed ? [] : [words.connectionReadOnly]),
    ...(writeFilesAllowed ? [] : [words.writeFilesOff]),
  ];
  return gaps.length === 0 ? null : words.readWriteGap(...gaps);
}

/** Browses one connection folder by folder and grants the open folder to the agent. */
export function ConnectedStorage({
  agentId,
  connections,
  writeFilesAllowed,
  grantsRef,
  onGranted,
  locale = 'en',
}: Readonly<{
  agentId: string;
  connections: StorageConnectionsState;
  writeFilesAllowed: boolean;
  grantsRef: RefObject<HTMLUListElement | null>;
  onGranted: (next: AgentResourceAssignments) => void;
  /** The reader's language; English when absent. */
  locale?: VersionsLocale;
}>) {
  const words = connectedStorageWords(locale);
  const [connectionId, setConnectionId] = useState('');
  const [prefix, setPrefix] = useState('');
  const [entries, setEntries] = useState<readonly StorageConnectionBrowseEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [access, setAccess] = useState<GrantAccess>('read');
  const [granting, setGranting] = useState(false);
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const known = connections.kind === 'ready' ? connections.connections : [];
  const connection = known.find((candidate) => candidate.id === connectionId);

  useEffect(() => {
    if (connectionId === '') return undefined;
    const controller = new AbortController();
    setEntries(null);
    setProblem(null);
    void (async () => {
      const found: StorageConnectionBrowseEntry[] = [];
      const options =
        prefix === '' ? { signal: controller.signal } : { prefix, signal: controller.signal };
      for await (const entry of browserClient().storage.connections.browse(connectionId, options)) {
        found.push(entry);
      }
      if (!controller.signal.aborted) setEntries(found);
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setProblem(storageProblemMessage(error, words.listFailed, storageStrings(locale)));
      }
    });
    return () => controller.abort();
  }, [connectionId, prefix, words, locale]);

  useEffect(() => {
    if (focusPath === null) return;
    const rows = Array.from(grantsRef.current?.children ?? []);
    const row = rows.find(
      (candidate) =>
        candidate instanceof HTMLElement && candidate.dataset['grantPath'] === focusPath,
    );
    if (row instanceof HTMLElement) row.focus();
    setFocusPath(null);
  }, [focusPath, grantsRef]);

  if (connections.kind === 'loading') {
    return <p className="text-[12.5px] text-muted">{words.loading}</p>;
  }
  if (connections.kind === 'failed') {
    return (
      <p role="alert" className="text-[12.5px] text-danger">
        {connections.reason}
      </p>
    );
  }
  if (known.length === 0) {
    return <p className="text-[12.5px] text-muted">{words.noConnections}</p>;
  }

  const gap = connection === undefined ? null : readWriteGap(connection, writeFilesAllowed, words);
  const effectiveAccess: GrantAccess = gap === null ? access : 'read';
  const folders = (entries ?? []).filter((entry) => entry.kind === 'folder');
  const files = (entries ?? []).filter((entry) => entry.kind === 'file');

  async function grant() {
    if (connection === undefined || prefix === '' || granting) return;
    setGranting(true);
    setProblem(null);
    try {
      const next = await saveStorageGrant(
        browserClient(),
        agentId,
        storageGrantPath(connection.name, prefix),
        effectiveAccess,
      );
      onGranted(next);
      const saved = next.storageGrants.find(
        (candidate) => candidate.connectionId === connection.id && candidate.prefix === prefix,
      );
      setFocusPath(saved === undefined ? null : `${saved.connectionId}/${saved.prefix}`);
    } catch (error) {
      setProblem(storageProblemMessage(error, words.saveFailed, storageStrings(locale)));
    } finally {
      setGranting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-[12.5px] font-semibold" htmlFor="storage-connection-select">
          {words.connection}
        </label>
        <select
          id="storage-connection-select"
          className={`${CONTROL} mt-1`}
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
            setPrefix('');
            setEntries(null);
          }}
        >
          <option value="">{words.chooseOne}</option>
          {known.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>

      {connection === undefined ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span>{words.currentFolder(prefix === '' ? words.allowedFolders : `${prefix}/`)}</span>
            <button
              type="button"
              className={BTN_SM}
              disabled={prefix === ''}
              onClick={() => setPrefix(parentOf(prefix))}
            >
              {words.upOneFolder}
            </button>
          </div>
          {entries === null && problem === null ? (
            <p className="text-[12.5px] text-muted">{words.loadingFolder}</p>
          ) : (
            <ul className="text-[12.5px]">
              {folders.map((entry) => (
                <li key={entry.path} className="py-0.5">
                  <button
                    type="button"
                    className={BTN_SM}
                    onClick={() => setPrefix(entry.path.replace(/\/+$/u, ''))}
                  >
                    {words.openFolder(lastSegment(entry.path))}
                  </button>
                </li>
              ))}
              {files.map((entry) => (
                <li key={entry.path} className="py-0.5 text-muted">
                  {lastSegment(entry.path)}
                </li>
              ))}
              {folders.length === 0 && files.length === 0 ? (
                <li className="text-muted">{words.emptyFolder}</li>
              ) : null}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[12.5px] font-semibold" htmlFor="storage-grant-access">
              {words.accessForFolder}
            </label>
            <select
              id="storage-grant-access"
              className={CONTROL}
              value={effectiveAccess}
              aria-describedby={gap === null ? undefined : 'storage-grant-access-gap'}
              onChange={(event) =>
                setAccess(event.target.value === 'read-write' ? 'read-write' : 'read')
              }
            >
              <option value="read">{words.read}</option>
              <option value="read-write" disabled={gap !== null}>
                {words.readWrite}
              </option>
            </select>
            <button
              type="button"
              className={BTN_SM}
              disabled={prefix === '' || granting}
              onClick={() => {
                void grant();
              }}
            >
              {words.grantFolder}
            </button>
          </div>
          {gap === null ? null : (
            <p id="storage-grant-access-gap" className="text-[12px] text-muted">
              {gap}
            </p>
          )}
          {prefix === '' ? <p className="text-[12px] text-muted">{words.openToGrant}</p> : null}
        </>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-[12.5px] text-danger">
          {problem}
        </p>
      )}
    </div>
  );
}
