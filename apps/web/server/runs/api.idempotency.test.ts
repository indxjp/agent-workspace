import { afterEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { startRun } from './api';
import { AGENT, errorCode, install, post, WORKSPACE } from './api.test-support';
import { InMemoryRunStore } from './memory-store';

afterEach(() => {
  resetTestRunApi();
});

const keyed = (body: unknown, key: string): Request => {
  const request = post(AGENT, body);
  request.headers.set('Idempotency-Key', key);
  return request;
};
const runIdOf = async (response: Response): Promise<string> =>
  String(((await response.json()) as { run: { id: string } }).run.id);

// ADR-0151, #250: an `Idempotency-Key` makes a start safe to retry.
describe('POST /api/agents/:id/runs > Idempotency-Key on run start', () => {
  it('answers a replay with the original run, and launches once', async () => {
    const harness = install();
    const first = await startRun(keyed({ prompt: 'hi' }, 'k-1'), AGENT);
    const replay = await startRun(keyed({ prompt: 'hi' }, 'k-1'), AGENT);

    expect([first.status, replay.status]).toEqual([202, 202]);
    const id = await runIdOf(first);
    expect(await runIdOf(replay)).toBe(id);
    expect(replay.headers.get('location')).toBe(`/api/runs/${id}/events`);
    expect(harness.launched).toHaveLength(1);
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(1);
  });

  it('keeps answering with the original run after it has finished', async () => {
    const harness = install();
    const id = await runIdOf(await startRun(keyed({ prompt: 'hi' }, 'k-2'), AGENT));
    await harness.store.finish(id, 'completed', null);

    const replay = await startRun(keyed({ prompt: 'hi' }, 'k-2'), AGENT);

    expect(replay.status).toBe(202);
    expect(await runIdOf(replay)).toBe(id);
    expect(harness.launched).toHaveLength(1);
  });

  it('refuses the key with a different request, and creates nothing', async () => {
    const harness = install();
    await startRun(keyed({ prompt: 'hi' }, 'k-3'), AGENT);

    const other = await startRun(keyed({ prompt: 'something else' }, 'k-3'), AGENT);

    expect(other.status).toBe(409);
    expect(await errorCode(other)).toBe('run_idempotency_conflict');
    expect((await harness.store.listRuns(WORKSPACE, { limit: 10 })).items).toHaveLength(1);
    expect(harness.launched).toHaveLength(1);
  });

  it('replays a retry whose JSON lists the same members in another order', async () => {
    const harness = install();
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const reordered = { required: ['a'], properties: { a: { type: 'string' } }, type: 'object' };
    const first = await startRun(keyed({ prompt: 'hi', outputSchema: schema }, 'k-4'), AGENT);

    const replay = await startRun(keyed({ outputSchema: reordered, prompt: 'hi' }, 'k-4'), AGENT);

    expect(replay.status).toBe(202);
    expect(await runIdOf(replay)).toBe(await runIdOf(first));
    expect(harness.launched).toHaveLength(1);
  });
});

describe('POST /api/agents/:id/runs > Idempotency-Key on run start', () => {
  it('still refuses a retry whose array members come in another order', async () => {
    install();
    const body = (required: string[]): unknown => ({
      prompt: 'hi',
      outputSchema: {
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'string' } },
        required,
      },
    });
    await startRun(keyed(body(['a', 'b']), 'k-5'), AGENT);

    const other = await startRun(keyed(body(['b', 'a']), 'k-5'), AGENT);

    expect(other.status).toBe(409);
    expect(await errorCode(other)).toBe('run_idempotency_conflict');
  });

  it.each([
    ['empty', '   '],
    ['longer than 255 characters', 'k'.repeat(256)],
  ])('refuses a key that is %s', async (_label, key) => {
    const harness = install();
    const response = await startRun(keyed({ prompt: 'hi' }, key), AGENT);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_idempotency_key');
    expect(harness.launched).toHaveLength(0);
  });

  it('answers the race loser with the run the winner created', async () => {
    const store = new InMemoryRunStore();
    const harness = install({}, store);
    const winner = await startRun(keyed({ prompt: 'hi' }, 'k-4'), AGENT);
    // The loser's lookup ran before the winner committed: it misses once, then hits the key.
    const find = store.findByIdempotencyKey.bind(store);
    let misses = 1;
    store.findByIdempotencyKey = (...args) =>
      misses-- > 0 ? Promise.resolve(null) : find(...args);

    const loser = await startRun(keyed({ prompt: 'hi' }, 'k-4'), AGENT);

    expect(loser.status).toBe(202);
    expect(await runIdOf(loser)).toBe(await runIdOf(winner));
    expect(harness.launched).toHaveLength(1);
  });
});
