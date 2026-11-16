import { describe, expect, it } from 'vitest';

import { jsonResponse as json } from '../testing.js';
import { runFailure } from './runs.js';
import { RUN, run, detail, client } from './runs.fixture.test-support.js';

describe('runFailure', () => {
  it('reads the code a queued run was refused with back out of its error', async () => {
    const { runs } = client(() =>
      json(200, {
        run: detail({
          ...run('failed'),
          error: 'model_connection_unresolved: no workspace default is configured.',
        }),
      }),
    );
    expect(runFailure(await runs.get(RUN))).toEqual({
      code: 'model_connection_unresolved',
      message: 'no workspace default is configured.',
    });
  });

  it('reads run_budget_reached, and the ceiling from the run, not the message (ADR-0162)', async () => {
    const { runs } = client(() =>
      json(200, {
        run: detail({
          ...run('failed'),
          spendCeilingUsd: '0.500000',
          error: 'run_budget_reached: The run stopped at its spend ceiling of 0.5 USD.',
        }),
      }),
    );
    const stopped = await runs.get(RUN);
    expect(runFailure(stopped)?.code).toBe('run_budget_reached');
    expect(stopped.spendCeilingUsd).toBe('0.500000');
  });

  it('answers null for a run that did not fail, and no code for an uncoded failure', async () => {
    const { runs } = client(() => json(200, { run: detail(run('completed')) }));
    expect(runFailure(await runs.get(RUN))).toBeNull();
    const failed = client(() =>
      json(200, {
        run: detail({ ...run('failed'), error: 'The workspace could not be prepared.' }),
      }),
    );
    expect(runFailure(await failed.runs.get(RUN))).toEqual({
      code: null,
      message: 'The workspace could not be prepared.',
    });
  });
});
