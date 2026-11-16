import { log as webLogger } from '../telemetry/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRuntimeManagerClient, RuntimeManagerError } from '../compose/runtime-manager-client';
import { setupStepFailure } from './failure';

const SECRET = 'sk-secret-provider-key';

describe('setupStepFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the errno of a filesystem error beside its name', () => {
    vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('EACCES: permission denied, open /var/lib/x'), {
      code: 'EACCES',
    });

    expect(setupStepFailure('runtime test', error, []).message).toBe(
      'Setup failed at the runtime test step (Error EACCES). See the server log, then retry.',
    );
  });

  it.each(['access denied', 'E', 'EACCES/../secret', 42, undefined])(
    'ignores a code that is not an errno (%s)',
    (code) => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      const error = Object.assign(new Error('boom'), { code });

      expect(setupStepFailure('runtime test', error, []).message).toBe(
        'Setup failed at the runtime test step (Error). See the server log, then retry.',
      );
    },
  );

  it('keeps a secret in the error message out of the response and the log', () => {
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const error = new Error(`rejected ${SECRET} at https://host/path?key=${SECRET}`);

    const failure = setupStepFailure('runtime test', error, [SECRET]);

    expect(failure.message).not.toContain(SECRET);
    expect(String(logged.mock.calls[0]?.[0])).not.toContain(SECRET);
  });

  it('logs why an unreachable runner manager failed: the vetted hop and the socket errno', async () => {
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.10.0.9:443'), {
      code: 'ECONNREFUSED',
    });
    const client = createRuntimeManagerClient(
      'https://runner-manager.example.invalid',
      'manager-token-of-at-least-thirty-two-characters',
      () => Promise.reject(new TypeError('fetch failed', { cause: refused })),
    );
    const error: unknown = await client
      .verify({ sessionId: 's', workspacePath: '/w', engine: 'claude-code' }, 'cloud-run-service')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RuntimeManagerError);

    const failure = setupStepFailure(
      'runtime test',
      error,
      [],
      (error as RuntimeManagerError).safeCause,
    );

    expect(failure.message).toBe(
      'Setup failed at the runtime test step (RuntimeManagerError: runner manager did not answer unreachable). See the server log, then retry.',
    );
    expect(logged).toHaveBeenCalledWith('[setup] the runtime test step failed', {
      errorName: 'RuntimeManagerError',
      message: 'runtime manager verification did not answer: TypeError: fetch failed',
      safeCause: 'runner manager did not answer unreachable',
      causeName: 'TypeError',
      causeCode: 'ECONNREFUSED',
    });
  });

  it('logs no cause name or code that is not a plain identifier', () => {
    const logged = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    const cause = Object.assign(new Error('x'), { name: 'Bad name/../', code: 'not a code' });

    setupStepFailure('runtime test', new Error('boom', { cause }), []);

    expect(logged).toHaveBeenCalledWith('[setup] the runtime test step failed', {
      errorName: 'Error',
      message: 'boom',
    });
  });
});
