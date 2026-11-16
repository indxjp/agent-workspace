import { describe, expect, it } from 'vitest';
import { appendTranscript } from './api';
import {
  DEFAULTING_PRINCIPALS,
  errorCode,
  install,
  OTHER_WORKSPACE,
  post,
  SESSION,
  TRANSCRIPT,
  WORKSPACE,
} from './session-api.test-support';

export function registerAppendTests() {
  describe('POST …/transcript — append', () => {
    it(
      'stores a batch under the caller’s own tenant key and answers 204',
      storesBatchUnderCallerSOwnTenantKey,
    );

    it('stores a subagent transcript separately', storesSubagentTranscriptSeparately);

    it(
      'refuses a projectKey that is not the caller’s, and stores nothing',
      refusesProjectKeyThatIsNotCallerSStores,
    );

    it(
      'refuses a cwd-derived projectKey, which is what a silent SDK fallback produces',
      refusesCwdDerivedProjectKeyWhichIsWhatSilent,
    );

    it.each(DEFAULTING_PRINCIPALS)(
      'defaults to the caller’s own projectKey when the field is omitted, for %s (issue #235, S-21)',
      async (_name, principal) => {
        const { store } = install({ principal });
        const response = await appendTranscript(
          post(TRANSCRIPT, { entries: [{ type: 'user' }] }),
          SESSION,
        );
        expect(response.status).toBe(204);
        await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual([
          { type: 'user' },
        ]);
      },
    );

    it(
      'still parses and compares a projectKey that is stated, even though it is no longer required',
      stillParsesComparesProjectKeyThatIsStatedEven,
    );

    it.each([
      ['a non-UUID session id', SESSION.replace('1', 'z'), 'invalid_session_id'],
      ['a session id that is a path', '../../etc', 'invalid_session_id'],
    ])('refuses %s', async (_name, id, code) => {
      install();
      const response = await appendTranscript(
        post(TRANSCRIPT, { projectKey: WORKSPACE, entries: [] }),
        id,
      );
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe(code);
    });

    it('refuses a traversing subpath', refusesTraversingSubpath);

    it('refuses an entry with no type, naming the index', refusesEntryNoTypeNamingIndex);

    it('refuses a body that is not a JSON object', refusesBodyThatIsNotJSONObject);

    it('is idempotent under an SDK retry of the same batch', isIdempotentUnderSDKRetrySameBatch);
  });
}

async function storesBatchUnderCallerSOwnTenantKey() {
  const { store } = install();
  const response = await appendTranscript(
    post(TRANSCRIPT, {
      projectKey: WORKSPACE,
      entries: [{ type: 'user', uuid: 'a', text: 'ORCHID' }],
    }),
    SESSION,
  );
  expect(response.status).toBe(204);
  await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual([
    { type: 'user', uuid: 'a', text: 'ORCHID' },
  ]);
}

async function storesSubagentTranscriptSeparately() {
  const { store } = install();
  await appendTranscript(
    post(TRANSCRIPT, {
      projectKey: WORKSPACE,
      subpath: 'subagents/agent-7',
      entries: [{ type: 'user' }],
    }),
    SESSION,
  );
  await expect(store.listSubkeys({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toEqual([
    'subagents/agent-7',
  ]);
}

async function refusesProjectKeyThatIsNotCallerSStores() {
  const { store } = install();
  const response = await appendTranscript(
    post(TRANSCRIPT, { projectKey: OTHER_WORKSPACE, entries: [{ type: 'user' }] }),
    SESSION,
  );
  // The §25 lever. R-01 §7: the SDK substitutes a cwd-derived key silently when it refuses the
  // one the runner asked for, so a mismatch is a misconfigured runtime and not a routing detail.
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe('project_key_mismatch');
  await expect(store.load({ projectKey: OTHER_WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
  await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toBeNull();
}

async function refusesCwdDerivedProjectKeyWhichIsWhatSilent() {
  install();
  const response = await appendTranscript(
    post(TRANSCRIPT, { projectKey: 'C--app-workspaces-tenant', entries: [{ type: 'user' }] }),
    SESSION,
  );
  expect(response.status).toBe(403);
}

async function stillParsesComparesProjectKeyThatIsStatedEven() {
  install();
  const response = await appendTranscript(
    post(TRANSCRIPT, { projectKey: 123, entries: [] }),
    SESSION,
  );
  expect(response.status).toBe(400);
  expect(await errorCode(response)).toBe('invalid_project_key');
}

async function refusesTraversingSubpath() {
  install();
  const response = await appendTranscript(
    post(TRANSCRIPT, { projectKey: WORKSPACE, subpath: '../../escape', entries: [] }),
    SESSION,
  );
  expect(response.status).toBe(400);
  expect(await errorCode(response)).toBe('invalid_subpath');
}

async function refusesEntryNoTypeNamingIndex() {
  install();
  const response = await appendTranscript(
    post(TRANSCRIPT, { projectKey: WORKSPACE, entries: [{ type: 'user' }, { uuid: 'b' }] }),
    SESSION,
  );
  expect(response.status).toBe(400);
  expect(await errorCode(response)).toBe('invalid_entries');
}

async function refusesBodyThatIsNotJSONObject() {
  install();
  const response = await appendTranscript(post(TRANSCRIPT, [1, 2, 3]), SESSION);
  expect(response.status).toBe(400);
  expect(await errorCode(response)).toBe('invalid_body');
}

async function isIdempotentUnderSDKRetrySameBatch() {
  const { store } = install();
  const batch = { projectKey: WORKSPACE, entries: [{ type: 'user', uuid: 'a' }] };
  await appendTranscript(post(TRANSCRIPT, batch), SESSION);
  await appendTranscript(post(TRANSCRIPT, batch), SESSION);
  await expect(store.load({ projectKey: WORKSPACE, sessionId: SESSION })).resolves.toHaveLength(1);
}
