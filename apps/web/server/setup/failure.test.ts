import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupStepFailure } from './failure';

const SECRET = 'sk-secret-provider-key';

describe('setupStepFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the errno of a filesystem error beside its name', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = Object.assign(new Error('boom'), { code });

      expect(setupStepFailure('runtime test', error, []).message).toBe(
        'Setup failed at the runtime test step (Error). See the server log, then retry.',
      );
    },
  );

  it('keeps a secret in the error message out of the response and the log', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = new Error(`rejected ${SECRET} at https://host/path?key=${SECRET}`);

    const failure = setupStepFailure('runtime test', error, [SECRET]);

    expect(failure.message).not.toContain(SECRET);
    expect(String(logged.mock.calls[0]?.[0])).not.toContain(SECRET);
  });
});
