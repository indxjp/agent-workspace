/** A run's id comes from the environment's IdGenerator (refactoring plan part 09, step 5). */
import { describe, expect, it } from 'vitest';

import { counterIds } from '../ids';
import { startRunOnSession } from './service';
import { AGENT, PRINCIPAL, START, harness } from './service.test-support';

describe('startRunOnSession: the run id', () => {
  it('is the next id of the environment’s IdGenerator', async () => {
    const { env, store } = harness();
    const started = await startRunOnSession({ ...env, ids: counterIds() }, PRINCIPAL, AGENT, START);
    expect(started).toMatchObject({ kind: 'started' });
    const id = '00000000-0000-4000-8000-000000000001';
    if (started.kind === 'started') expect(started.run.id).toBe(id);
    expect((await store.get(id))?.status).toBe('queued');
  });
});
