import { randomUUID } from 'node:crypto';
import { IGNORED_STORAGE_VARIABLES } from '@indx-workspace/contracts/storage-settings';
import { describe, expect, it } from 'vitest';

import { runDeployCommand } from './command.js';
import {
  captured,
  capturedFailure,
  oldStorageLines,
  setStorage,
  stubRunner,
} from './deploy.test-support.js';
import {
  changesOf,
  controlPlaneAdds,
  setEnv,
  vercelEnvironment,
  vercelProject,
  vercelResponder,
} from './deploy.vercel.test-support.js';

function storageKeyCases(): void {
  it.each(['OBJECT_STORAGE_ACCESS_KEY_ID', 'OBJECT_STORAGE_SECRET_ACCESS_KEY'])(
    'refuses an apply whose .env has no %s, by name, before any tool runs',
    async (name) => {
      const target = await vercelProject();
      await setEnv(target, name, '');
      const { runner, calls } = stubRunner(vercelResponder(false));

      const { message, output } = await capturedFailure(() =>
        runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
      );

      expect(message).toContain(`${name} is empty in .env`);
      expect(message).toContain('Nothing was run');
      expect(`${message}${output}`).not.toContain('object-secret');
      expect(calls).toEqual([]);
    },
  );

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to vercel refuses a .env with only old storage names, and warns without their values', async () => {
    const target = await vercelProject();
    const secret = `bucket-${randomUUID()}`;
    await setStorage(target, oldStorageLines(secret));
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('AW_STORAGE_URL is empty in .env');
    expect(output).toContain(
      'storage_setting_ignored: ignoring OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_BACKEND, OBJECT_STORAGE_ENDPOINT; AW_STORAGE_URL',
    );
    expect(`${message}${output}`).not.toContain(secret);
    expect(calls).toEqual([]);
  });
}

function storageUrlPushCases(): void {
  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to vercel pushes AW_STORAGE_URL', async () => {
    const target = await vercelProject();
    await setStorage(target, ['AW_STORAGE_URL=s3://acme-ai-files']);
    const { runner, calls } = stubRunner(vercelResponder(false));

    await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    const added = controlPlaneAdds(calls);
    expect(added).toContain('AW_STORAGE_URL');
    expect(added).not.toContain('OBJECT_STORAGE_BUCKET');
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to vercel warns once about an old storage variable next to AW_STORAGE_URL, pushes none, and goes on', async () => {
    const target = await vercelProject();
    const secret = `bucket-${randomUUID()}`;
    await setStorage(target, [
      'AW_STORAGE_URL=s3://acme-ai-files',
      ...IGNORED_STORAGE_VARIABLES.map((name) => `${name}=${secret}`),
    ]);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { output } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(output.match(/storage_setting_ignored/gu)).toHaveLength(1);
    expect(output).toContain(
      `storage_setting_ignored: ignoring ${IGNORED_STORAGE_VARIABLES.join(', ')};`,
    );
    expect(output).not.toContain(secret);
    const added = changesOf(calls).map(({ args }) => args[2]);
    expect(controlPlaneAdds(calls)).toContain('AW_STORAGE_URL');
    for (const name of IGNORED_STORAGE_VARIABLES) expect(added).not.toContain(name);
    expect(JSON.stringify(calls)).not.toContain(secret);
  });
}

function storageUrlRefusalCases(): void {
  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy refuses an invalid AW_STORAGE_URL without echoing it', async () => {
    const target = await vercelProject();
    const secret = 'pw-not-for-logs';
    await setStorage(target, [`AW_STORAGE_URL=s3://user:${secret}@acme-ai-files`]);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message, output } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('AW_STORAGE_URL in .env is not valid');
    expect(`${message}${output}`).not.toContain(secret);
    expect(calls).toEqual([]);
  });

  // @story US-STO-10
  it('[US-STO-10][api][cli] deploy to vercel refuses a file: AW_STORAGE_URL, which a function cannot keep', async () => {
    const target = await vercelProject();
    await setStorage(target, ['AW_STORAGE_URL=file:///var/lib/agent-workspace']);
    const { runner, calls } = stubRunner(vercelResponder(false));

    const { message } = await capturedFailure(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(message).toContain('a Vercel function keeps nothing on disk');
    expect(calls).toEqual([]);
  });

  it('does not ask a non-S3 object store for an S3 key pair', async () => {
    const target = await vercelProject();
    await setStorage(target, ['AW_STORAGE_URL=gcs://acme-ai-files']);
    await setEnv(target, 'OBJECT_STORAGE_ACCESS_KEY_ID', '');
    await setEnv(target, 'OBJECT_STORAGE_SECRET_ACCESS_KEY', '');
    const { runner } = stubRunner(vercelResponder(false));

    const { result } = await captured(() =>
      runDeployCommand([target, '--yes'], { runner, environment: vercelEnvironment }),
    );

    expect(result).toEqual({ changes: true, applied: true });
  });
}

describe('agent-workspace deploy to Vercel', () => {
  storageKeyCases();
  storageUrlPushCases();
  storageUrlRefusalCases();
});
