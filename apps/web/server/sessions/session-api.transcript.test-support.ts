import { describe, expect, it } from 'vitest';
import { installTestDomains } from '../application-context-fixtures';
import { deleteTranscript, listTranscriptSubkeys, loadTranscript } from './api';
import { InMemoryTranscriptStore } from './memory-store';
import {
  DEFAULTING_PRINCIPALS,
  del,
  errorCode,
  get,
  install,
  OTHER_WORKSPACE,
  PRINCIPAL,
  SESSION,
  TRANSCRIPT,
  WORKSPACE,
} from './session-api.test-support';

export function registerTranscriptTests() {
  describe('GET …/transcript — load', registerTranscriptLoads);

  describe('DELETE …/transcript', registerTranscriptDeletes);

  describe('GET …/subkeys', registerTranscriptSubkeys);
}

async function returnsWhatWasAppended() {
  const { store } = install();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'user', uuid: 'a' }]);
  const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ entries: [{ type: 'user', uuid: 'a' }] });
}

async function answers404SessionNothingWasWrittenUnder() {
  install();
  const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe('transcript_not_found');
}

async function answers200SessionThatExistsIsEmpty() {
  const { store } = install();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, []);
  const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
  // The SDK resumes this one and not the 404 above, so the two must not be one status.
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ entries: [] });
}

async function cannotReadAnotherTenantSTranscriptNamingKey() {
  const { store } = install();
  await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
  const response = await loadTranscript(
    get(`${TRANSCRIPT}?projectKey=${OTHER_WORKSPACE}`),
    SESSION,
  );
  expect(response.status).toBe(403);
}

async function cannotReadAnotherTenantSTranscriptOmittingKey() {
  const { store } = install();
  await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
  const response = await loadTranscript(get(TRANSCRIPT), SESSION);
  // Not 403 (nothing was declared to disagree with the caller) and not the other tenant's
  // entries: the omitted key resolves to the caller's own workspace, under which nothing was
  // ever written for this session.
  expect(response.status).toBe(404);
  expect(await errorCode(response)).toBe('transcript_not_found');
}

async function refusesSameWorkspaceSessionThatAuthenticatedUserDoes() {
  const store = new InMemoryTranscriptStore();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(PRINCIPAL),
      canAccessSession: () => Promise.resolve(false),
      store,
    },
  });

  const response = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);

  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe('session_forbidden');
}

async function readsSubagentTranscriptWhenSubpathIsNamed() {
  const { store } = install();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
    { type: 'user', uuid: 'sub' },
  ]);
  const response = await loadTranscript(
    get(`${TRANSCRIPT}?projectKey=${WORKSPACE}&subpath=subagents%2Fa-1`),
    SESSION,
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ entries: [{ type: 'user', uuid: 'sub' }] });
}

async function removesTranscriptEverySubkeyIsIdempotent() {
  const { store } = install();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
    { type: 'user' },
  ]);
  const first = await deleteTranscript(del(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
  expect(first.status).toBe(204);
  await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
  await expect(
    store.load({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }),
  ).resolves.toBeNull();
  const second = await deleteTranscript(del(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
  expect(second.status).toBe(204);
}

async function refusesDeleteUnderAnotherTenantSKey() {
  const { store } = install();
  await store.append({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }, [{ type: 'user' }]);
  const response = await deleteTranscript(
    del(`${TRANSCRIPT}?projectKey=${OTHER_WORKSPACE}`),
    SESSION,
  );
  expect(response.status).toBe(403);
  await expect(
    store.load({ projectKey: OTHER_WORKSPACE, sessionId: SESSION }),
  ).resolves.not.toBeNull();
}

async function listsSubagentTranscriptsOneSession() {
  const { store } = install();
  await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
    { type: 'user' },
  ]);
  const response = await listTranscriptSubkeys(
    get(`/api/sessions/${SESSION}/subkeys?projectKey=${WORKSPACE}`),
    SESSION,
  );
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ subkeys: ['subagents/a-1'] });
}

async function refusesAnotherTenantSKey() {
  install();
  const response = await listTranscriptSubkeys(
    get(`/api/sessions/${SESSION}/subkeys?projectKey=${OTHER_WORKSPACE}`),
    SESSION,
  );
  expect(response.status).toBe(403);
}

function registerTranscriptLoads() {
  it('returns what was appended', returnsWhatWasAppended);

  it(
    'answers 404 for a session nothing was written under',
    answers404SessionNothingWasWrittenUnder,
  );

  it(
    'answers 200 with [] for a session that exists and is empty',
    answers200SessionThatExistsIsEmpty,
  );

  it(
    'cannot read another tenant’s transcript by naming its key',
    cannotReadAnotherTenantSTranscriptNamingKey,
  );

  it(
    'cannot read another tenant’s transcript by omitting the key either — an omitted key defaults to the caller’s own (issue #235, S-21)',
    cannotReadAnotherTenantSTranscriptOmittingKey,
  );

  it.each(DEFAULTING_PRINCIPALS)(
    'with no projectKey returns the same body as with the principal’s own workspace key, for %s (issue #235, S-21)',
    async (_name, principal) => {
      const { store } = install({ principal });
      await store.append({ projectKey: WORKSPACE, sessionId: SESSION }, [
        { type: 'user', uuid: 'a' },
      ]);
      const withKey = await loadTranscript(get(`${TRANSCRIPT}?projectKey=${WORKSPACE}`), SESSION);
      const withoutKey = await loadTranscript(get(TRANSCRIPT), SESSION);
      expect(withoutKey.status).toBe(withKey.status);
      await expect(withoutKey.json()).resolves.toEqual(await withKey.json());
    },
  );

  it(
    'refuses a same-workspace session that the authenticated user does not own',
    refusesSameWorkspaceSessionThatAuthenticatedUserDoes,
  );

  it(
    'reads a subagent transcript when the subpath is named',
    readsSubagentTranscriptWhenSubpathIsNamed,
  );
}

function registerTranscriptDeletes() {
  it(
    'removes the transcript and every subkey, and is idempotent',
    removesTranscriptEverySubkeyIsIdempotent,
  );

  it('refuses to delete under another tenant’s key', refusesDeleteUnderAnotherTenantSKey);
}

function registerTranscriptSubkeys() {
  it('lists the subagent transcripts of one session', listsSubagentTranscriptsOneSession);

  it('refuses another tenant’s key', refusesAnotherTenantSKey);

  it.each(DEFAULTING_PRINCIPALS)(
    'with no projectKey returns the same body as with the principal’s own workspace key, for %s (issue #235, S-21)',
    async (_name, principal) => {
      const { store } = install({ principal });
      await store.append({ projectKey: WORKSPACE, sessionId: SESSION, subpath: 'subagents/a-1' }, [
        { type: 'user' },
      ]);
      const withKey = await listTranscriptSubkeys(
        get(`/api/sessions/${SESSION}/subkeys?projectKey=${WORKSPACE}`),
        SESSION,
      );
      const withoutKey = await listTranscriptSubkeys(
        get(`/api/sessions/${SESSION}/subkeys`),
        SESSION,
      );
      expect(withoutKey.status).toBe(withKey.status);
      await expect(withoutKey.json()).resolves.toEqual(await withKey.json());
    },
  );
}
