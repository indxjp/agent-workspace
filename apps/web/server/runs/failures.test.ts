import { describe, expect, it, vi } from 'vitest';

import { DomainError, InfrastructureError } from '../errors';
import { RuntimeManagerError } from '../compose/runtime-manager-client';
import { redacted } from '../redact';
import {
  atStep,
  PreparationStepError,
  publicPreparationFailure,
  publicRunFailure,
  resolvedSecretValues,
} from './failures';

describe('resolvedSecretValues', () => {
  it('drops a secret that could not be resolved, so the log line is redacted, not withheld (issue #827)', async () => {
    const resolved = 'resolvedsecret1';
    const secrets = await resolvedSecretValues([
      Promise.resolve(resolved),
      Promise.reject(new Error('decryption failed')),
      Promise.resolve(null),
    ]);
    expect(secrets).toEqual([resolved]);

    const log = vi.fn();
    publicPreparationFailure(
      new PreparationStepError('runtime_profile', new Error(`refused ${resolved}`)),
      secrets,
      log,
    );
    expect(String(log.mock.calls[0]?.[0])).toBe(
      '[runs] run preparation failed at the runtime_profile step (Error): refused [redacted]',
    );
  });
});

describe('publicPreparationFailure', () => {
  const SECRET = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  it('names the step and error and keeps the message out of the public text', () => {
    const log = vi.fn();
    const cause = new Error(`provider rejected ${SECRET} at https://x.example/v1?key=${SECRET}`);

    const message = publicPreparationFailure(cause, [], log);

    expect(message).toBe(
      'run_preparation_failed: The run request could not be prepared at the prepare step (Error).',
    );
    const logged = String(log.mock.calls[0]?.[0]);
    expect(logged).toContain('prepare step (Error): provider rejected [redacted] at [url]');
    expect(logged).not.toContain('sk-ant');
  });

  it("redacts the run's known secret values from the log, however short (issue #827)", () => {
    const log = vi.fn();
    const declared = 'shortsecret1';
    const message = publicPreparationFailure(
      new Error(`tool host refused ${declared}`),
      [declared],
      log,
    );

    expect(message).not.toContain(declared);
    expect(String(log.mock.calls[0]?.[0])).toBe(
      '[runs] run preparation failed at the prepare step (Error): tool host refused [redacted]',
    );
    publicPreparationFailure(new Error(`tool host refused ${declared}`), null, log);
    expect(String(log.mock.calls[1]?.[0])).toBe(
      '[runs] run preparation failed at the prepare step (Error): [withheld]',
    );
  });

  it('reports the innermost step and keeps a coded refusal as it is', async () => {
    const log = vi.fn();
    const inner = await atStep('secrets', () =>
      atStep('tools', () => Promise.reject(new TypeError('boom'))),
    ).catch((error: unknown) => error);
    expect(publicPreparationFailure(inner, [], log)).toBe(
      'run_preparation_failed: The run request could not be prepared at the tools step (TypeError).',
    );

    const refusal = new DomainError({
      category: 'validation',
      code: 'code_tool_secret_missing',
      publicMessage: 'code_tool_secret_missing: set it.',
    });
    const kept = await atStep('tools', () => Promise.reject(refusal)).catch(
      (error: unknown) => error,
    );
    expect(publicPreparationFailure(kept, [], log)).toBe('code_tool_secret_missing: set it.');
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('adds only the vetted safe cause of a runner-manager answer', () => {
    const cause = new RuntimeManagerError(
      `body said ${SECRET}`,
      503,
      'tool_sandbox_unavailable',
      undefined,
    );
    const message = publicPreparationFailure(cause, [], vi.fn());
    expect(message).toBe(
      'run_preparation_failed: The run request could not be prepared at the prepare step (RuntimeManagerError: runner manager answered HTTP 503 tool_sandbox_unavailable).',
    );
  });

  it("names the manager's tool_sandbox_unavailable reason, redacted of the run's secrets (issue #827)", () => {
    const declared = 'shortsecret1';
    const cause = new RuntimeManagerError('body', 503, 'tool_sandbox_unavailable', undefined, {
      detail: `the tool sandbox did not become ready in time ${declared}\nsee https://x.example/v1?key=${SECRET}`,
    });

    const message = publicPreparationFailure(cause, [declared], vi.fn());
    expect(message).toBe(
      'run_preparation_failed: The run request could not be prepared at the prepare step (RuntimeManagerError: runner manager answered HTTP 503 tool_sandbox_unavailable: the tool sandbox did not become ready in time [redacted] see [url]).',
    );
    expect(message).not.toContain('sk-ant');

    expect(publicPreparationFailure(cause, null, vi.fn())).toBe(
      'run_preparation_failed: The run request could not be prepared at the prepare step (RuntimeManagerError: runner manager answered HTTP 503 tool_sandbox_unavailable).',
    );
  });

  it('finds the safe cause of a runner-manager answer tagged with a step', async () => {
    const log = vi.fn();
    const tagged = await atStep('allocation', () =>
      Promise.reject(
        new RuntimeManagerError(`body said ${SECRET}`, 503, 'tool_sandbox_unavailable', undefined),
      ),
    ).catch((error: unknown) => error);

    expect(publicPreparationFailure(tagged, [], log)).toBe(
      'run_preparation_failed: The run request could not be prepared at the allocation step (RuntimeManagerError: runner manager answered HTTP 503 tool_sandbox_unavailable).',
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain('sk-ant');
  });
});

describe('redacted', () => {
  it('keeps a UUID and masks another long token', () => {
    const id = '3f2a9c1e-1b2c-4d5e-8f90-123456789abc';
    const key = 'abcdefghijABCDEFGHIJ0123456789abcdefghij';

    expect(redacted(`agent ${id} rejected ${key}`, [])).toBe(`agent ${id} rejected [redacted]`);
  });
});

describe('publicRunFailure', () => {
  it('retains an expected domain failure without treating it as infrastructure', () => {
    const log = vi.fn();
    const failure = new DomainError({
      category: 'validation',
      code: 'invalid_run',
      publicMessage: 'The run configuration is invalid.',
    });

    expect(
      publicRunFailure(failure, {
        operation: 'prepare-request',
        publicMessage: 'The run request could not be prepared.',
        log,
      }),
    ).toBe('The run configuration is invalid.');
    expect(log).not.toHaveBeenCalled();
  });

  it('wraps an unknown cause for diagnostics and returns only fixed public text', () => {
    const log = vi.fn();
    const cause = new Error('DATABASE_PASSWORD=SECRET_SENTINEL');

    const message = publicRunFailure(cause, {
      operation: 'append-runtime-event',
      publicMessage: 'Run output could not be saved.',
      log,
    });

    expect(message).toBe('Run output could not be saved.');
    expect(message).not.toContain('SECRET_SENTINEL');
    expect(log).toHaveBeenCalledOnce();
    const failure = log.mock.calls[0]?.[1] as unknown;
    expect(failure).toBeInstanceOf(InfrastructureError);
    expect((failure as InfrastructureError).cause).toBe(cause);
  });
});
