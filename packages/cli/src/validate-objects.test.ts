import { describe, expect, it, vi } from 'vitest';

import {
  ProbeRefusedError,
  describeProbeResults,
  liveProfileProbes,
  runProfileProbes,
  type ProfileProbes,
} from './validate.js';

import { localProfile, recordingProbes } from './validate.test-support.ts';

const composeEnvironment = {
  OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
  AW_STORAGE_URL: 's3://agent-workspace?endpoint=https://s3.example&pathStyle=true',
  AW_STORAGE_CREATE_BUCKET: 'true',
};

const objectsResult = async (objects: ProfileProbes['objects'], timeoutMs = 10_000) =>
  (
    await runProfileProbes(localProfile, {
      probes: recordingProbes({ objects }).probes,
      environment: composeEnvironment,
      timeoutMs,
    })
  ).find((result) => result.store === 'objects');
// @story US-STO-10
describe('object bucket existence policy', () => {
  it('passes a bucket that answers', async () => {
    const result = await objectsResult(() => Promise.resolve('present'));
    expect(result?.outcome).toBe('passed');
    expect(describeProbeResults(result === undefined ? [] : [result])).toBe(
      'passed  objects: bucket agent-workspace answered\n',
    );
  });

  it('reports a bucket that is not there yet without creating it, and without refusing', async () => {
    const result = await objectsResult(() => Promise.resolve('absent'));
    expect(result?.outcome).toBe('missing');
    expect(describeProbeResults(result === undefined ? [] : [result])).toBe(
      'missing  objects: bucket agent-workspace does not exist yet — the platform creates it ' +
        'on first boot\n',
    );
  });

  it('refuses a missing bucket the platform does not create', async () => {
    const refusal = await runProfileProbes(localProfile, {
      probes: recordingProbes({ objects: () => Promise.resolve('absent') }).probes,
      environment: { ...composeEnvironment, AW_STORAGE_CREATE_BUCKET: 'false' },
    }).catch((thrown: unknown) => thrown);
    expect(refusal).toBeInstanceOf(ProbeRefusedError);
    expect((refusal as ProbeRefusedError).message).toContain('operator-owned bucket');
  });
});

it('maps an absent native GCS bucket to missing instead of refusing the first run', async () => {
  vi.doMock('@google-cloud/storage', () => ({
    Storage: class {
      bucket() {
        return { exists: () => Promise.resolve([false]) };
      }
    },
  }));
  try {
    const result = await liveProfileProbes(10_000).objects(
      { backend: 'gcs', bucket: 'missing-gcs', projectId: 'test-project' },
      AbortSignal.timeout(10_000),
    );
    expect(result).toBe('absent');
  } finally {
    vi.doUnmock('@google-cloud/storage');
  }
});
describe('object-store probe failures', () => {
  it('refuses a store that could not be reached at all', async () => {
    const leak = 'AccessDenied: arn:aws:iam::123456789012:user/ops https://s3.example';
    const refusal = await objectsResult(() => Promise.reject(new Error(leak))).catch(
      (thrown: unknown) => thrown,
    );

    expect(refusal).toBeInstanceOf(ProbeRefusedError);
    const error = refusal as ProbeRefusedError;
    expect(error.store).toBe('objects');
    expect(error.message).toBe(
      'agent-workspace.yaml: the objects store did not answer — the bucket could not be reached',
    );
    expect((error.cause as Error).message).toBe(leak);
  });

  it('refuses a probe the run deadline ended', async () => {
    const refusal = await objectsResult(
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      10,
    ).catch((thrown: unknown) => thrown);
    expect(refusal).toBeInstanceOf(ProbeRefusedError);
    expect((refusal as ProbeRefusedError).store).toBe('objects');
  });
});
