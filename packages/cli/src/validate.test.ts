import { describe, expect, it } from 'vitest';

import { ProbeRefusedError, describeProbeResults, runProfileProbes } from './validate.js';

import {
  GCS_STORAGE,
  MANAGED_DATABASE_URL,
  MANAGED_STORE_ENVIRONMENT,
  azureProfile,
  gcpProfile,
  outcomes,
  recordingProbes,
} from './validate.test-support.ts';

describe('store credential availability', () => {
  it('probes a store whose credential is present', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(gcpProfile, {
      probes,
      environment: {
        ...MANAGED_STORE_ENVIRONMENT,
        GCP_PROJECT: 'acme-project',
      },
    });

    expect(calls).toEqual([`relational:${MANAGED_DATABASE_URL}`, 'objects:acme-ai-files']);
    expect(outcomes(results)).toEqual({
      relational: 'passed',
      objects: 'passed',
      identity: 'skipped',
    });
  });

  /**
   * `validate` never writes, so the object probe heads the bucket and stops there. Its three
   * answers are pinned together, because the distinction between them is the whole point: a
   * bucket that is not there yet is the ordinary first-run case and must not be a refusal, while
   * a store that cannot be reached at all still has to be one.
   */
  it('skips a store with no credential rather than failing it', async () => {
    const { calls, probes } = recordingProbes();
    // A managed relational store's URL is held by the cloud's secret service. Native GCS uses
    // ADC, so it can still be probed without an HMAC credential in the profile or environment.
    const results = await runProfileProbes(gcpProfile, { probes, environment: GCS_STORAGE });

    expect(calls).toEqual(['objects:acme-ai-files']);
    expect(outcomes(results)).toEqual({
      relational: 'skipped',
      objects: 'passed',
      identity: 'skipped',
    });
    expect(describeProbeResults(results)).toContain('skipped  relational: cloud-sql');
  });

  it('names managed identity, not a missing credential, when this host cannot probe Azure Blob', async () => {
    const { calls, probes } = recordingProbes();
    const results = await runProfileProbes(azureProfile, {
      probes,
      environment: { AW_STORAGE_URL: 'azblob://acme/acme-ai-files' },
    });

    expect(calls).toEqual([]);
    expect(describeProbeResults(results)).toContain(
      'skipped  objects: azblob://acme-ai-files is reached through managed identity, which this host cannot assume',
    );
    expect(describeProbeResults(results)).not.toContain('has no credential to probe with');
  });
});

describe('configured store and issuer addresses', () => {
  it('takes the managed store connection string from the environment when it is there', async () => {
    const { calls, probes } = recordingProbes();
    await runProfileProbes(gcpProfile, { probes, environment: MANAGED_STORE_ENVIRONMENT });
    expect(calls).toEqual([`relational:${MANAGED_DATABASE_URL}`, 'objects:acme-ai-files']);
  });

  it('probes the issuer whenever the profile names one', async () => {
    const { calls, probes } = recordingProbes();
    await runProfileProbes(
      { ...gcpProfile, identity: { ...gcpProfile.identity, oidc: 'https://id.example' } },
      { probes, environment: MANAGED_STORE_ENVIRONMENT },
    );
    // No credential is needed to read a discovery document, so the issuer is always probed;
    // the connection string the environment carries is one, so the store is probed too.
    expect(calls).toEqual([
      `relational:${MANAGED_DATABASE_URL}`,
      'objects:acme-ai-files',
      'identity:https://id.example',
    ]);
  });
});

it('turns a failed probe into a typed refusal that leaks no provider text', async () => {
  const leak =
    'error: password authentication failed for user "agent_workspace" ' +
    'postgres://agent_workspace:s3cr3t@10.0.0.2:5432/agent_workspace';
  const { probes } = recordingProbes({
    relational: () => Promise.reject(new Error(leak)),
  });

  const refusal = await runProfileProbes(gcpProfile, {
    probes,
    environment: MANAGED_STORE_ENVIRONMENT,
  }).catch((thrown: unknown) => thrown);

  expect(refusal).toBeInstanceOf(ProbeRefusedError);
  const error = refusal as ProbeRefusedError;
  expect(error.store).toBe('relational');
  expect(error.message).not.toContain('s3cr3t');
  expect(error.message).not.toContain('password authentication failed');
  expect(error.message).toMatch(/the relational store did not answer/u);
  // The driver's own message is kept for an operator reading a stack trace, never printed.
  expect(error.cause).toBeInstanceOf(Error);
  expect((error.cause as Error).message).toBe(leak);
});

describe('probe cancellation', () => {
  it('honours the caller abort signal and the per-run timeout', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const { probes } = recordingProbes({
      relational: (_url, signal) => {
        seen.push(signal);
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    await runProfileProbes(gcpProfile, {
      probes,
      environment: MANAGED_STORE_ENVIRONMENT,
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(false);
    controller.abort(new Error('caller gave up'));
    expect(seen[0]?.aborted).toBe(true);
  });

  it('aborts a probe that never answers, without waiting for the caller', async () => {
    const { probes } = recordingProbes({
      relational: (_url, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    });
    await expect(
      runProfileProbes(gcpProfile, {
        probes,
        environment: MANAGED_STORE_ENVIRONMENT,
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(ProbeRefusedError);
  });
});
