/**
 * One contract suite, run against **every** {@link TranscriptStore} implementation.
 *
 * The shape is `apps/web/server/agents/store.test.ts`'s, and the reason is the one W2-DB-02 gave
 * for it: two implementations tested by two suites are two contracts, and the durable one is the
 * one nobody runs locally. Here it matters more than usual, because the rules being checked are
 * not this repository's inventions — they are R-01 §7's report of what the Agent SDK *requires* of
 * a `SessionStore`, and a store that breaks one of them produces a resume that silently loses a
 * turn rather than an error anybody sees.
 *
 * Each `it` below names the rule it is enforcing and where the rule comes from.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { FileTranscriptStore } from './file-store';
import { InMemoryTranscriptStore } from './memory-store';
import {
  mergeTranscriptEntries,
  parseProjectKey,
  parseSessionId,
  parseSubpath,
  parseTranscriptEntries,
  parseTranscriptEntry,
  parseTranscriptKey,
  type TranscriptEntry,
  type TranscriptKey,
  type TranscriptStore,
} from './transcript';

const PROJECT = 'workspace-0000-0001';
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '99999999-8888-4777-8666-555555555555';
const MAIN: TranscriptKey = { projectKey: PROJECT, sessionId: SESSION };

function entry(type: string, extra: Record<string, unknown> = {}): TranscriptEntry {
  return { type, ...extra };
}

const temporaryRoots: string[] = [];

function newFileStore(): FileTranscriptStore {
  const root = mkdtempSync(path.join(tmpdir(), 'aw-transcript-'));
  temporaryRoots.push(root);
  return new FileTranscriptStore(root);
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const implementations: ReadonlyArray<{ name: string; open: () => TranscriptStore }> = [
  { name: 'InMemoryTranscriptStore', open: (): TranscriptStore => new InMemoryTranscriptStore() },
  { name: 'FileTranscriptStore', open: (): TranscriptStore => newFileStore() },
];

describe.each(implementations)('$name — the SessionStore contract (R-01 §7)', ({ open }) => {
  it('load() answers null for a key nothing was ever appended under', async () => {
    const store = open();
    await expect(store.load(MAIN)).resolves.toBeNull();
  });

  it('distinguishes an unknown session (null) from an empty one ([])', async () => {
    const store = open();
    await store.append(MAIN, []);
    // The SDK resumes the second and not the first, so collapsing them would turn "no turns yet"
    // into "no such session".
    await expect(store.load(MAIN)).resolves.toEqual([]);
    await expect(store.load({ projectKey: PROJECT, sessionId: OTHER_SESSION })).resolves.toBeNull();
  });

  it('load() returns entries deep-equal to what was appended, in append order', async () => {
    const store = open();
    const batch = [
      entry('user', { uuid: 'a', message: { role: 'user', content: 'hello' } }),
      entry('assistant', {
        uuid: 'b',
        message: { role: 'assistant', content: [{ type: 'text' }] },
      }),
      entry('ai-title'),
    ];
    await store.append(MAIN, batch);
    // R-01 §7: "load() must return entries deep-equal to what was appended; byte equality is not
    // required". Nested objects included — an adapter that stringified them would pass a shallow
    // check and lose the conversation's content.
    await expect(store.load(MAIN)).resolves.toEqual(batch);
  });

  it('upserts on entry.uuid, in place, so an SDK retry cannot duplicate or reorder a turn', async () => {
    const store = open();
    await store.append(MAIN, [
      entry('user', { uuid: 'a', text: 'first' }),
      entry('assistant', { uuid: 'b' }),
    ]);
    await store.append(MAIN, [entry('user', { uuid: 'a', text: 'corrected' })]);
    const loaded = await store.load(MAIN);
    // R-01 §7: "Retries can redeliver, so append() must upsert on entry.uuid." In place, because
    // the transcript is a chain: moving the redelivered entry to the end would reorder the turn.
    expect(loaded).toEqual([
      entry('user', { uuid: 'a', text: 'corrected' }),
      entry('assistant', { uuid: 'b' }),
    ]);
  });

  it('appends uuid-less entries without dedup', async () => {
    const store = open();
    await store.append(MAIN, [entry('ai-title'), entry('ai-title')]);
    await store.append(MAIN, [entry('ai-title')]);
    // R-01 §7: "Entries without a uuid (titles, tags, mode markers) are appended without dedup."
    await expect(store.load(MAIN)).resolves.toHaveLength(3);
  });

  it('keeps concurrent appends for one key from overwriting each other', async () => {
    const store = open();
    const batches = Array.from({ length: 12 }, (_, index) => [
      entry('user', { uuid: `u${String(index)}` }),
    ]);
    await Promise.all(batches.map((batch) => store.append(MAIN, batch)));
    const loaded = await store.load(MAIN);
    // Both backends are read-modify-write, so without the per-key serialiser this is a lost
    // update and the length is smaller than 12. The ORDER is not asserted: the SDK's rule is
    // "within a single process, persist entries in append-call order", and Promise.all makes no
    // call order to preserve.
    expect(loaded).toHaveLength(12);
    expect(new Set(loaded?.map((one) => one.uuid))).toEqual(
      new Set(batches.map((_, index) => `u${String(index)}`)),
    );
  });

  it('keys a subpath separately from the main transcript', async () => {
    const store = open();
    const subagent: TranscriptKey = { ...MAIN, subpath: 'subagents/agent-7' };
    await store.append(MAIN, [entry('user', { uuid: 'main' })]);
    await store.append(subagent, [entry('user', { uuid: 'sub' })]);
    await expect(store.load(MAIN)).resolves.toEqual([entry('user', { uuid: 'main' })]);
    await expect(store.load(subagent)).resolves.toEqual([entry('user', { uuid: 'sub' })]);
  });

  it('listSubkeys() reports every subpath under a session, and no main transcript', async () => {
    const store = open();
    await store.append(MAIN, [entry('user')]);
    await store.append({ ...MAIN, subpath: 'subagents/agent-7' }, [entry('user')]);
    await store.append({ ...MAIN, subpath: 'subagents/agent-8' }, [entry('user')]);
    await expect(store.listSubkeys(MAIN)).resolves.toEqual([
      'subagents/agent-7',
      'subagents/agent-8',
    ]);
  });

  it('listSubkeys() answers [] for a session nothing was written under', async () => {
    const store = open();
    await expect(store.listSubkeys(MAIN)).resolves.toEqual([]);
  });

  it('delete() on a main key cascades to every subkey', async () => {
    const store = open();
    const subagent: TranscriptKey = { ...MAIN, subpath: 'subagents/agent-7' };
    await store.append(MAIN, [entry('user')]);
    await store.append(subagent, [entry('user')]);
    await store.delete(MAIN);
    // R-01 §7: "delete(mainKey) must cascade to all subkeys".
    await expect(store.load(MAIN)).resolves.toBeNull();
    await expect(store.load(subagent)).resolves.toBeNull();
    await expect(store.listSubkeys(MAIN)).resolves.toEqual([]);
  });

  it('delete() on a subkey leaves the main transcript alone', async () => {
    const store = open();
    const subagent: TranscriptKey = { ...MAIN, subpath: 'subagents/agent-7' };
    await store.append(MAIN, [entry('user', { uuid: 'main' })]);
    await store.append(subagent, [entry('user')]);
    await store.delete(subagent);
    await expect(store.load(MAIN)).resolves.toEqual([entry('user', { uuid: 'main' })]);
    await expect(store.load(subagent)).resolves.toBeNull();
  });

  it('delete() is idempotent', async () => {
    const store = open();
    await expect(store.delete(MAIN)).resolves.toBeUndefined();
    await expect(store.delete(MAIN)).resolves.toBeUndefined();
  });

  it('listSessions() reports main transcripts under the tenant key and nothing else', async () => {
    const store = open();
    await store.append(MAIN, [entry('user')]);
    await store.append({ projectKey: PROJECT, sessionId: OTHER_SESSION }, [entry('user')]);
    await store.append({ ...MAIN, subpath: 'subagents/agent-7' }, [entry('user')]);
    const listing = await store.listSessions(PROJECT);
    expect(new Set(listing.map((one) => one.sessionId))).toEqual(new Set([SESSION, OTHER_SESSION]));
    for (const one of listing) {
      // R-01 §7: "mtime = integer epoch ms".
      expect(Number.isInteger(one.mtime)).toBe(true);
      expect(one.mtime).toBeGreaterThan(0);
    }
  });

  it('listSessions() never reports another tenant’s session (spec §25)', async () => {
    const store = open();
    await store.append(MAIN, [entry('user')]);
    await store.append({ projectKey: 'workspace-0000-0002', sessionId: OTHER_SESSION }, [
      entry('user'),
    ]);
    await expect(store.listSessions(PROJECT)).resolves.toEqual([
      expect.objectContaining({ sessionId: SESSION }),
    ]);
  });

  it('a session id is scoped by its projectKey, so one tenant cannot read another’s', async () => {
    const store = open();
    await store.append(MAIN, [entry('user', { uuid: 'ours' })]);
    // The SAME session id under a different tenant key is a different transcript, not the same one.
    await expect(
      store.load({ projectKey: 'workspace-0000-0002', sessionId: SESSION }),
    ).resolves.toBeNull();
  });

  it('listSessions() answers [] for a tenant that has written nothing', async () => {
    const store = open();
    await expect(store.listSessions('workspace-0000-0009')).resolves.toEqual([]);
  });
});

describe('FileTranscriptStore — what only a durable backend can be asked', () => {
  it('a second store over the same root reads what the first one wrote', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-transcript-'));
    temporaryRoots.push(root);
    const batch = [entry('user', { uuid: 'a', text: 'the passphrase is ORCHID' })];
    await new FileTranscriptStore(root).append(MAIN, batch);
    // This is the property the acceptance criterion turns into a process kill: the store, not the
    // process, is what holds the conversation.
    await expect(new FileTranscriptStore(root).load(MAIN)).resolves.toEqual(batch);
  });

  it('refuses a root that is an empty string rather than defaulting to the cwd', () => {
    expect(() => new FileTranscriptStore('   ')).toThrow(/needs a root directory/);
  });

  // The API parses every key before it reaches a store. This is the second lock: a caller that
  // skipped the parse gets a refusal, not a transcript written outside its session directory.
  //
  // Every member is driven, not `load()` alone, and each one is driven **twice** — once for a
  // `projectKey` that is not a segment and once for a `sessionId` that is not. `append()` used to
  // be the counter-example to this suite's own claim: it called `#fileFor()` outside the promise
  // it returned, so the refusal left it as a synchronous `throw` and
  // `store.append(key, batch).catch(…)` — the shape `load()`'s JSDoc says a caller writes — never
  // observed it. `refusalOf()` below is written so that a member which throws synchronously fails
  // here rather than being caught by `rejects.toThrow` (which accepts either).
  const unparsed: ReadonlyArray<readonly [string, TranscriptKey]> = [
    ['a projectKey that is not a segment', { projectKey: '../escape', sessionId: SESSION }],
    ['a sessionId that is not a segment', { projectKey: PROJECT, sessionId: '../../escape' }],
  ];

  /**
   * Call `invoke`, insisting that whatever it returns is a promise and that nothing escaped
   * before that promise existed. Returns the rejection.
   */
  async function refusalOf(invoke: () => Promise<unknown>): Promise<unknown> {
    let promise: Promise<unknown>;
    try {
      promise = invoke();
    } catch (error) {
      throw new Error(
        `this member threw synchronously instead of returning a rejected promise, so a caller ` +
          `that wrote .catch(…) would miss the refusal entirely: ${String(error)}`,
        { cause: error },
      );
    }
    expect(promise).toBeInstanceOf(Promise);
    return promise.then(
      (value) => {
        throw new Error(`this member resolved with ${JSON.stringify(value)} instead of refusing`);
      },
      (error: unknown) => error,
    );
  }

  const members: ReadonlyArray<
    readonly [string, (store: FileTranscriptStore, key: TranscriptKey) => Promise<unknown>]
  > = [
    ['append', (store, key): Promise<unknown> => store.append(key, [entry('user', { uuid: 'a' })])],
    ['load', (store, key): Promise<unknown> => store.load(key)],
    ['delete', (store, key): Promise<unknown> => store.delete(key)],
    [
      'listSubkeys',
      (store, key): Promise<unknown> =>
        store.listSubkeys({ projectKey: key.projectKey, sessionId: key.sessionId }),
    ],
    ['listSessions', (store, key): Promise<unknown> => store.listSessions(key.projectKey)],
  ];

  for (const [member, call] of members) {
    for (const [label, key] of unparsed) {
      // `listSessions` takes only a projectKey, so the sessionId row is not a case for it.
      if (member === 'listSessions' && key.projectKey === PROJECT) continue;
      it(`${member}() refuses ${label} as a rejected promise, never a synchronous throw`, async () => {
        const store = newFileStore();
        const error = await refusalOf(() => call(store, key));
        expect(String(error)).toMatch(/refusing to build a storage path/);
      });
    }
  }

  it('reports a corrupted transcript instead of returning a shorter one', async () => {
    const store = newFileStore();
    await store.append(MAIN, [entry('user', { uuid: 'a' })]);
    const file = path.join(store.root, PROJECT, SESSION, 'main.jsonl');
    writeFileSync(file, '{"type":"user","uuid":"a"}\nthis is not json\n', 'utf8');
    // ADR-0015: a load that cannot read every line fails. Skipping the bad line would hand the
    // SDK a transcript that is missing a turn, with nothing anywhere saying so.
    await expect(store.load(MAIN)).rejects.toThrow(/is not JSON/);
  });

  it('leaves no temporary file behind after a successful append', async () => {
    const store = newFileStore();
    await store.append(MAIN, [entry('user', { uuid: 'a' })]);
    await store.append(MAIN, [entry('user', { uuid: 'b' })]);
    const files = readdirSync(path.join(store.root, PROJECT, SESSION));
    expect(files).toEqual(['main.jsonl']);
  });

  it('encodes a subpath reversibly, so listSubkeys() recovers exactly what was stored', async () => {
    const store = newFileStore();
    await store.append({ ...MAIN, subpath: 'subagents/agent-abc_123' }, [entry('user')]);
    const files = readdirSync(path.join(store.root, PROJECT, SESSION));
    // The stored filename contains no separator from the subpath, which is what makes a traversal
    // impossible by construction rather than by validation alone.
    expect(files).toEqual([
      `sub-${Buffer.from('subagents/agent-abc_123', 'utf8').toString('hex')}.jsonl`,
    ]);
    await expect(store.listSubkeys(MAIN)).resolves.toEqual(['subagents/agent-abc_123']);
  });
});

describe('mergeTranscriptEntries — the rule both backends share', () => {
  it('is the identity on an empty batch', () => {
    const existing = [entry('user', { uuid: 'a' })];
    expect(mergeTranscriptEntries(existing, [])).toEqual(existing);
  });

  it('upserts the last redelivery of a uuid within one batch', () => {
    const merged = mergeTranscriptEntries(
      [],
      [entry('user', { uuid: 'a', text: 'one' }), entry('user', { uuid: 'a', text: 'two' })],
    );
    expect(merged).toEqual([entry('user', { uuid: 'a', text: 'two' })]);
  });
});

describe('parsing — every rejection is by name, and the last arm rejects (ADR-0015)', () => {
  it('accepts a workspace id as a projectKey', () => {
    expect(parseProjectKey('c8b1f0de-6a2e-4a1f-9d3b-000000000001')).toEqual({
      ok: true,
      value: 'c8b1f0de-6a2e-4a1f-9d3b-000000000001',
    });
  });

  it.each([
    ['a value the SDK would silently replace', 'tenant a'],
    ['an empty key', ''],
    ['a 65-character key', 'x'.repeat(65)],
    ['a path separator', 'a/b'],
    ['a traversal', '..'],
  ])('refuses %s', (_name, value) => {
    expect(parseProjectKey(value).ok).toBe(false);
  });

  it('refuses a Windows device name, which the SDK ignores silently (R-01 §7 rule 2)', () => {
    expect(parseProjectKey('con').ok).toBe(false);
    expect(parseProjectKey('COM1').ok).toBe(false);
  });

  it('refuses a non-string projectKey rather than coercing it', () => {
    expect(parseProjectKey(42).ok).toBe(false);
    expect(parseProjectKey(null).ok).toBe(false);
    expect(parseProjectKey(undefined).ok).toBe(false);
  });

  it('requires a UUID session id, which is what `resume` takes', () => {
    expect(parseSessionId(SESSION).ok).toBe(true);
    expect(parseSessionId('not-a-uuid').ok).toBe(false);
    expect(parseSessionId(7).ok).toBe(false);
  });

  it('treats an absent subpath as the main transcript and an empty one as invalid', () => {
    expect(parseSubpath(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseSubpath(null)).toEqual({ ok: true, value: undefined });
    // R-01 §7: "EMPTY STRING IS INVALID — omit the field for the main transcript."
    expect(parseSubpath('').ok).toBe(false);
  });

  it.each([
    ['a parent segment', 'subagents/../../etc'],
    ['a leading slash', '/etc/passwd'],
    ['an absolute Windows path', 'C:/Windows'],
    ['a backslash', 'subagents\\agent-1'],
    ['a percent-encoded separator', 'subagents%2f..%2fetc'],
    ['a trailing separator', 'subagents/'],
    ['a bare dot segment', './x'],
  ])('refuses a subpath carrying %s', (_name, value) => {
    expect(parseSubpath(value).ok).toBe(false);
  });

  it('accepts the shape the SDK actually writes', () => {
    expect(parseSubpath('subagents/agent-11111111-2222-4333-8444-555555555555')).toEqual({
      ok: true,
      value: 'subagents/agent-11111111-2222-4333-8444-555555555555',
    });
  });

  it('parses a whole key and names the field that was wrong', () => {
    expect(parseTranscriptKey({ projectKey: PROJECT, sessionId: SESSION })).toEqual({
      ok: true,
      value: { projectKey: PROJECT, sessionId: SESSION },
    });
    const rejected = parseTranscriptKey({ projectKey: PROJECT, sessionId: 'nope' });
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? '' : rejected.reason).toMatch(/sessionId/);
    expect(parseTranscriptKey('a string').ok).toBe(false);
    expect(parseTranscriptKey(null).ok).toBe(false);
  });

  it('stores an entry verbatim, including fields the SDK does not declare', () => {
    const parsed = parseTranscriptEntry({ type: 'user', uuid: 'a', somethingNew: { deep: 1 } });
    // R-01 §4 records that the SDK emits fields its own .d.ts does not declare. A validator that
    // dropped them would corrupt a resume, so the parser checks and keeps.
    expect(parsed).toEqual({
      ok: true,
      value: { type: 'user', uuid: 'a', somethingNew: { deep: 1 } },
    });
  });

  it('refuses an entry with no string type, and says which index in a batch', () => {
    expect(parseTranscriptEntry({ uuid: 'a' }).ok).toBe(false);
    expect(parseTranscriptEntry(['user']).ok).toBe(false);
    const rejected = parseTranscriptEntries([{ type: 'user' }, { uuid: 'b' }]);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? '' : rejected.reason).toMatch(/entries\[1\]/);
  });

  it('refuses a non-array batch and an over-long one', () => {
    expect(parseTranscriptEntries({ 0: { type: 'user' } }).ok).toBe(false);
    expect(parseTranscriptEntries(Array.from({ length: 5_001 }, () => ({ type: 'user' }))).ok).toBe(
      false,
    );
  });

  it('accepts an empty batch', () => {
    expect(parseTranscriptEntries([])).toEqual({ ok: true, value: [] });
  });
});
