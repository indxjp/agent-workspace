import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { openConnectionStore } from '@agent-workspace/core/storage';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { type Backend, localEgress } from './run-storage-writeback.fixture.test-support';
import { describe } from 'vitest';
import { fileBackend } from './run-storage-writeback.fixture.test-support';
import { runWriteback } from './run-storage-writeback.execution.test-support';
import { registerWritebackSavingTests } from './run-storage-writeback.saving.test-support';
import { registerWritebackGrantsTests } from './run-storage-writeback.grants.test-support';
import { registerWritebackConfinementTests } from './run-storage-writeback.confinement.test-support';
import { registerWritebackChangesTests } from './run-storage-writeback.changes.test-support';
describe.each([
  ['file://', fileBackend],
  ['S3', () => s3Backend(process.env)],
] as const)('a completed run granted a %s connection folder', (_name, makeBackend) => {
  const run: (options: Parameters<typeof runWriteback>[1]) => ReturnType<typeof runWriteback> = (
    options,
  ) => runWriteback(makeBackend, options);
  registerWritebackSavingTests(run);
  registerWritebackGrantsTests(run);
  registerWritebackConfinementTests(run);
  registerWritebackChangesTests(run);
});

async function s3Backend(env: Readonly<Record<string, string | undefined>>): Promise<Backend> {
  const endpoint = env['TEST_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint.trim() === '') {
    throw new Error('TEST_S3_ENDPOINT is required (the repository test launcher supplies it)');
  }
  const accessKeyId = env['TEST_S3_ACCESS_KEY_ID'] ?? 'agent_workspace';
  const secretAccessKey = env['TEST_S3_SECRET_ACCESS_KEY'] ?? 'agent_workspace';
  const region = env['TEST_S3_REGION'] ?? 'us-east-1';
  const bucket = `aw-writeback-${randomBytes(6).toString('hex')}`;
  await new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  }).send(new CreateBucketCommand({ Bucket: bucket }));
  const url = formatStorageUrl({
    kind: 's3',
    bucket,
    prefix: '',
    endpoint,
    region,
    forcePathStyle: true,
  });
  return {
    open: (writable) =>
      openConnectionStore(
        url,
        { provider: 's3', accessKeyId, secretAccessKey },
        {
          writable,
          fileRoots: [],
          egress: localEgress,
        },
      ),
    teardown: () => Promise.resolve(),
  };
}
